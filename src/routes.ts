/**
 * The /api/plugin-updater route family: the status probe, the update run,
 * and the job progress. All are loopback-only control surfaces — the run endpoint triggers a real
 * git pull / pnpm install on this machine, so it must never be reachable
 * from a LAN or phone origin, even though DSH 0.2.x can serve the Web UI on a
 * network address or behind a trusted reverse proxy.
 *
 * Every request first passes DSH's own gate (`ctx.connection.requestRejection`:
 * the browser-session cookie minted from the `?token=` launch URL, plus the
 * Host/Origin fence), then this plugin's stricter loopback rule (socket
 * address, Host, Origin). The loopback rule is self-contained; this package
 * does not depend on any third-party plugin package.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { UpdaterStatus } from './inventory.ts'
import type { JobPlan, JobStore } from './jobs.ts'
import { scopeOf, type RunRequestBody } from './planner.ts'

export type { RunRequestBody } from './planner.ts'

/** Route paths (exact matches under /api). */
export const UPDATE_PATHS = {
  status: '/api/plugin-updater/status',
  run: '/api/plugin-updater/run',
  job: '/api/plugin-updater/job',
} as const

/** HTTP status refusing a request before dispatch, or undefined to proceed. */
export type FenceRejection = 401 | 403 | undefined

/** Route-family dependencies (test seam). */
export interface UpdaterRoutesDeps {
  /**
   * Request gate: DSH's own browser authentication (401) and Host/Origin
   * fence (403), plus this plugin's loopback-only rule (403).
   */
  fence(request: IncomingMessage): FenceRejection
  /** Read the current scan (local disk + network probes). */
  status(): Promise<UpdaterStatus>
  /** Plan one run request. */
  plan(request: RunRequestBody): Promise<JobPlan>
  /** The job store runs execute in. */
  jobs: JobStore
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

/** Answer a non-matching method. */
function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('method not allowed')
}

/** Answer a fenced request; true when it was refused. */
function refused(deps: UpdaterRoutesDeps, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = deps.fence(req)
  if (rejection === undefined) return false
  writeJson(res, rejection, { ok: false, code: rejection === 401 ? 'unauthorized' : 'forbidden' })
  return true
}

/**
 * Build the /api/plugin-updater route family. One job at a time: a run
 * request while a job is planning or running answers 409.
 *  - `GET  status` — full scan with network probes, plus the current job.
 *  - `POST run`    — plan and start a job; answers 202 with its snapshot.
 *  - `GET  job`    — the current (or last finished) job only; cheap to poll.
 * @param deps - fence + status/plan seams and the job store.
 * @returns the exact routes to register on webServer.
 */
export function makeUpdaterRoutes(deps: UpdaterRoutesDeps): WebRoute[] {
  const handleStatus = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') return methodNotAllowed(res)
    if (refused(deps, req, res)) return
    try {
      const status = await deps.status()
      const job = deps.jobs.view()
      writeJson(res, 200, { ...status, busy: deps.jobs.running, ...(job !== undefined ? { job } : {}) })
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'internal-error', error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleJob = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') return methodNotAllowed(res)
    if (refused(deps, req, res)) return
    writeJson(res, 200, { busy: deps.jobs.running, job: deps.jobs.view() ?? null })
  }

  const handleRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return methodNotAllowed(res)
    if (refused(deps, req, res)) return
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch {
      return writeJson(res, 400, { ok: false, code: 'bad-request' })
    }
    if (typeof body !== 'object' || body === null) return writeJson(res, 400, { ok: false, code: 'bad-request' })
    const request = body as RunRequestBody
    const scope = scopeOf(request)
    if (scope === undefined) return writeJson(res, 400, { ok: false, code: 'bad-request', error: 'name a package, or set all / pluginManager' })
    const started = deps.jobs.start(scope, () => deps.plan(request))
    if (started === undefined) return writeJson(res, 409, { ok: false, code: 'busy', job: deps.jobs.view() })
    writeJson(res, 202, { ok: true, job: started.view })
  }

  return [
    { kind: 'exact', path: UPDATE_PATHS.status, handler: handleStatus },
    { kind: 'exact', path: UPDATE_PATHS.run, handler: handleRun },
    { kind: 'exact', path: UPDATE_PATHS.job, handler: handleJob },
  ]
}
