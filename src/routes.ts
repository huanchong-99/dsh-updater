/**
 * The /api/plugin-updater route family: the status probe and the update run.
 * Both are loopback-only control surfaces — the run endpoint triggers a real
 * git pull / pnpm install on this machine, so it must never be reachable
 * from a LAN or phone origin, even though DSH 0.2.x can serve the Web UI on a
 * network address or behind a trusted reverse proxy.
 *
 * The trust fence is self-contained (the documented Host/Origin semantics of
 * DSH's own /api fence, plus a loopback *socket* requirement on top); this
 * package does not depend on any third-party plugin package.
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
  /** Read the current scan (local disk + network probes). */
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

/** Parse a bare `host[:port]` authority under a scheme; undefined when unparsable. */
function parseAuthority(authority: string, scheme: 'http:' | 'https:'): URL | undefined {
  try {
    return new URL(`${scheme}//${authority}`)
  } catch {
    return undefined
  }
}

/** Minimal request facts the fence reads (test seam). */
export interface TrustRequestLike {
  socket?: { remoteAddress?: string }
  headers: Record<string, string | string[] | undefined>
}

/**
 * Browser-trust fence for the /api/plugin-updater routes: a loopback socket
 * address AND a loopback Host header, plus browser same-origin markers.
 * X-Forwarded-For is never trusted, so a reverse proxy in front of DSH does
 * not open these routes to its clients. The Origin, when present, is compared
 * under its own scheme so default ports (`:80`, `:443`) normalize the same
 * way on both sides whether the listener speaks HTTP or TLS.
 */
export function isTrustedUpdaterRequest(request: TrustRequestLike): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host, 'http:')
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  const scheme = originUrl.protocol === 'https:' ? 'https:' : originUrl.protocol === 'http:' ? 'http:' : undefined
  if (scheme === undefined) return false
  const hostUnderScheme = parseAuthority(host, scheme)
  return hostUnderScheme !== undefined && originUrl.host === hostUnderScheme.host
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
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
 * Build the /api/plugin-updater route family. One update run at a time: a
 * second POST while a run is in flight answers 409 instead of starting a
 * concurrent pnpm/git process in the same profile.
 * @param deps - fence + status/resolve/run seams.
 * @returns the exact routes to register on webServer.
 */
export function makeUpdaterRoutes(deps: UpdaterRoutesDeps): WebRoute[] {
  let running = false

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
    try {
      const status = await deps.status()
      writeJson(res, 200, { ...status, busy: running })
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'internal-error', error: error instanceof Error ? error.message : String(error) })
    }
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
    if (running) {
      writeJson(res, 409, { ok: false, code: 'busy' })
      return
    }
    running = true
    try {
      const result = await runRequested(deps, body as RunRequestBody)
      writeJson(res, 200, result)
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'internal-error', error: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
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
export async function runRequested(deps: UpdaterRoutesDeps, request: RunRequestBody): Promise<UpdateRunResult> {
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
      combined += `== ${record.profile} / ${record.name}\n${result.output}\n`
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
