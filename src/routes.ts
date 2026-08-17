/**
 * The /api/plugin-updater route family: the status probe and the update run.
 * Both are loopback-only control surfaces — the run endpoint triggers a real
 * git pull / pnpm install on this machine, so it must never be reachable
 * from a LAN or phone origin.
 *
 * The trust fence is self-contained (re-implemented from the documented
 * Host/Origin semantics); this package does not depend on any third-party
 * plugin package.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PluginRecord, UpdaterStatus } from './inventory.ts'
import type { UpdateRunResult, UpdateTarget } from './update.ts'

/** Route paths (exact matches under /api). */
export const UPDATE_PATHS = {
  status: '/api/plugin-updater/status',
  run: '/api/plugin-updater/run',
} as const

/** One update-request body accepted by the run endpoint. */
export interface RunRequestBody {
  /** Update every outdated record in this profile. */
  all?: boolean
  profile?: string
  /** Update a single package by name (within `profile` when given). */
  name?: string
  /**
   * Allow dirty git-clone work trees to update via `git pull --ff-only
   * --autostash`. Defaults to false: dirty clones are refused.
   */
  autostash?: boolean
}

/** Route-family dependencies (test seam). */
export interface UpdaterRoutesDeps {
  /** Loopback-only fence: control endpoints are host-surface only. */
  fence(request: IncomingMessage): boolean
  /** Read the current scan (local disk + git probes only). */
  status(): Promise<UpdaterStatus>
  /** Resolve a concrete update target for one record. */
  resolveTarget(record: PluginRecord): UpdateTarget | undefined
  /** Execute one update target and return the result. */
  run(target: UpdateTarget, options?: UpdateRunOptions): Promise<UpdateRunResult>
}

/** Optional modifiers for one update run. */
export interface UpdateRunOptions {
  autostash?: boolean
}

// ---------------------------------------------------------------------------
// Trust fence (self-contained loopback + same-origin check)
// ---------------------------------------------------------------------------

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4: string): boolean {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Browser-trust fence for the /api/plugin-updater routes: a loopback socket
 * address AND a loopback Host header, plus browser same-origin markers.
 * X-Forwarded-For is never trusted.
 */
export function isTrustedUpdaterRequest(request: IncomingMessage): boolean {
  const socket = request.socket as { remoteAddress?: string } | undefined
  if (!isLoopbackAddress(socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Build the /api/plugin-updater route family.
 * @param deps - fence + status/resolve/run seams.
 * @returns the exact routes to register on webServer.
 */
export function makeUpdaterRoutes(deps: UpdaterRoutesDeps): WebRoute[] {
  const handleStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!deps.fence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    writeJson(res, 200, await deps.status())
  }

  const handleRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    if (!deps.fence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      writeJson(res, 400, { ok: false, code: 'bad-request' })
      return
    }
    if (typeof body !== 'object' || body === null) {
      writeJson(res, 400, { ok: false, code: 'bad-request' })
      return
    }
    const request = body as RunRequestBody
    try {
      const result = await runRequested(deps, request)
      writeJson(res, 200, result)
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'internal-error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  return [
    { kind: 'exact', path: UPDATE_PATHS.status, handler: handleStatus },
    { kind: 'exact', path: UPDATE_PATHS.run, handler: handleRun },
  ]
}

/**
 * Execute one run request. Supports:
 *  - `{ profile, name }` — update one package
 *  - `{ profile, all: true }` — update every outdated package in a profile
 *  - `{ all: true }` — update every outdated package across profiles
 */
async function runRequested(deps: UpdaterRoutesDeps, request: RunRequestBody): Promise<UpdateRunResult> {
  const status = await deps.status()
  const options: UpdateRunOptions = { autostash: request.autostash === true }
  let records = status.records
  if (request.profile !== undefined) {
    records = records.filter(record => record.profile === request.profile)
  }
  if (request.name !== undefined) {
    records = records.filter(record => record.name === request.name)
  } else if (request.all === true) {
    records = records.filter(record => record.outdated)
  } else {
    return { ok: false, exitCode: null, output: '', error: 'run request must name a package or set all:true', errorCode: 'not-found' }
  }
  if (records.length === 0) {
    return { ok: false, exitCode: null, output: '', error: 'no matching package found', errorCode: 'not-found' }
  }
  if (records.length > 1) {
    // Multiple records (e.g. all:true): update sequentially, dedupe by git
    // root, and fail fast on the first error.
    const seenGitRoots = new Set<string>()
    let combined = ''
    for (const record of records) {
      const target = deps.resolveTarget(record)
      if (target === undefined) continue
      if (target.kind === 'git-clone' && target.gitRoot !== undefined) {
        if (seenGitRoots.has(target.gitRoot)) continue
        seenGitRoots.add(target.gitRoot)
      }
      const result = await deps.run(target, options)
      combined += result.output
      if (!result.ok) return { ...result, output: combined }
    }
    return { ok: true, exitCode: 0, output: combined }
  }
  const target = deps.resolveTarget(records[0])
  if (target === undefined) {
    return { ok: false, exitCode: null, output: '', error: `cannot update ${records[0].kind} package`, errorCode: 'unsupported' }
  }
  return deps.run(target, options)
}
