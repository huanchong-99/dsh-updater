/** Route family: trust fence, busy guard, request routing — no real pnpm/git. */

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedUpdaterRequest, makeUpdaterRoutes, runRequested, UPDATE_PATHS, type UpdaterRoutesDeps } from '../src/routes.ts'
import type { PluginRecord, UpdaterStatus } from '../src/inventory.ts'
import type { UpdateRunResult, UpdateTarget } from '../src/update.ts'

const loopback = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers })

describe('isTrustedUpdaterRequest', () => {
  it('requires a loopback socket AND a loopback Host', () => {
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080' }))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: '127.0.0.1:3080' }, '::ffff:127.0.0.1'))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: '[::1]:3080' }, '::1'))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080' }, '192.168.1.5'))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({ host: 'app.example' }))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({}))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', 'x-forwarded-for': '127.0.0.1' }, '10.0.0.9'))).toBe(false)
  })

  it('refuses cross-site markers and foreign Origins, normalizing default ports per scheme', () => {
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', origin: 'http://evil.test' }))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:443', origin: 'https://localhost' }))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost', origin: 'http://localhost:80' }))).toBe(true)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', origin: 'null' }))).toBe(false)
    expect(isTrustedUpdaterRequest(loopback({ host: 'localhost:3080', origin: 'file:///x' }))).toBe(false)
  })
})

function record(overrides: Partial<PluginRecord>): PluginRecord {
  return { profile: 'web', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', outdated: true, current: '1.0.0', latest: '1.1.0', ...overrides }
}

function deps(records: PluginRecord[], run: UpdaterRoutesDeps['run'] = async () => ({ ok: true, exitCode: 0, output: 'ok' })): UpdaterRoutesDeps {
  const status: UpdaterStatus = { profiles: ['web', 'tui'], records, checkedAt: 'now', busy: false }
  return {
    fence: () => true,
    status: async () => status,
    resolveTarget: (entry): UpdateTarget | undefined => entry.kind === 'installation-owned' || entry.kind === 'local-only'
      ? undefined
      : { profile: entry.profile, profileDir: '/p/' + entry.profile, name: entry.name, kind: entry.kind, spec: entry.spec, gitRoot: entry.git?.root },
    run,
  }
}

describe('runRequested', () => {
  it('rejects a body that names nothing', async () => {
    const result = await runRequested(deps([record({})]), {})
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not-found')
  })

  it('updates one named package within a profile', async () => {
    const seen: string[] = []
    const result = await runRequested(deps([record({}), record({ profile: 'tui' })], async (target) => {
      seen.push(`${target.profile}/${target.name}`)
      return { ok: true, exitCode: 0, output: '' }
    }), { profile: 'tui', name: 'dsh-foo' })
    expect(result.ok).toBe(true)
    expect(seen).toEqual(['tui/dsh-foo'])
  })

  it('with all:true updates only outdated rows, dedupes git roots, and stops at the first failure', async () => {
    const seen: string[] = []
    const rows = [
      record({ name: 'a', kind: 'git-clone', git: { root: '/clone' } }),
      record({ name: 'b', kind: 'git-clone', git: { root: '/clone' } }),
      record({ name: 'c', outdated: false }),
      record({ name: 'd', kind: 'installation-owned' }),
      record({ name: 'e' }),
      record({ name: 'f' }),
    ]
    const result = await runRequested(deps(rows, async (target) => {
      seen.push(target.name)
      return target.name === 'e' ? { ok: false, exitCode: 1, output: 'boom', errorCode: 'pnpm-failed' } : { ok: true, exitCode: 0, output: '' }
    }), { all: true })
    expect(seen).toEqual(['a', 'e'])
    expect(result.ok).toBe(false)
    expect(result.output).toContain('web / e')
  })

  it('passes autostash through as a run option', async () => {
    let autostash: boolean | undefined
    await runRequested(deps([record({ kind: 'git-clone' })], async (_target, options) => {
      autostash = options?.autostash
      return { ok: true, exitCode: 0, output: '' }
    }), { profile: 'web', name: 'dsh-foo', autostash: true })
    expect(autostash).toBe(true)
  })
})

/** Minimal IncomingMessage/ServerResponse stand-ins for the handler tests. */
function fakeRequest(method: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { method: string; headers: Record<string, string>; socket: IncomingMessage['socket'] }
  req.method = method
  req.headers = { host: 'localhost:3080' }
  req.socket = { remoteAddress: '127.0.0.1' } as unknown as IncomingMessage['socket']
  ;(req as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(body)
  }
  return req
}

function fakeResponse(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let status = 0
  let resolve!: (value: { status: number; body: unknown }) => void
  const done = new Promise<{ status: number; body: unknown }>((r) => { resolve = r })
  const res = {
    writeHead(code: number) { status = code; return res },
    end(payload?: string) { resolve({ status, body: payload === undefined || payload === '' ? undefined : (() => { try { return JSON.parse(payload) } catch { return payload } })() }) },
  } as unknown as ServerResponse
  return { res, done }
}

describe('makeUpdaterRoutes', () => {
  it('registers the two exact routes and answers 405 / 403 / 200 on status', async () => {
    const routes = makeUpdaterRoutes(deps([]))
    expect(routes.map(route => [route.kind, route.path])).toEqual([['exact', UPDATE_PATHS.status], ['exact', UPDATE_PATHS.run]])
    const [status] = routes
    const wrong = fakeResponse()
    await status.handler(fakeRequest('POST'), wrong.res)
    expect((await wrong.done).status).toBe(405)
    const ok = fakeResponse()
    await status.handler(fakeRequest('GET'), ok.res)
    const answer = await ok.done
    expect(answer.status).toBe(200)
    expect((answer.body as UpdaterStatus).busy).toBe(false)
    const fenced = makeUpdaterRoutes({ ...deps([]), fence: () => false })
    const denied = fakeResponse()
    await fenced[0].handler(fakeRequest('GET'), denied.res)
    expect((await denied.done).status).toBe(403)
  })

  it('answers 409 to a second run while one is in flight and reports busy in status', async () => {
    let release!: (value: UpdateRunResult) => void
    const gate = new Promise<UpdateRunResult>((r) => { release = r })
    const routes = makeUpdaterRoutes(deps([record({})], () => gate))
    const [status, run] = routes
    const first = fakeResponse()
    const firstDone = run.handler(fakeRequest('POST', JSON.stringify({ profile: 'web', name: 'dsh-foo' })), first.res)
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = fakeResponse()
    await run.handler(fakeRequest('POST', JSON.stringify({ all: true })), second.res)
    expect((await second.done).status).toBe(409)
    const during = fakeResponse()
    await status.handler(fakeRequest('GET'), during.res)
    expect(((await during.done).body as UpdaterStatus).busy).toBe(true)
    release({ ok: true, exitCode: 0, output: 'done' })
    await firstDone
    expect((await first.done).status).toBe(200)
    const after = fakeResponse()
    await status.handler(fakeRequest('GET'), after.res)
    expect(((await after.done).body as UpdaterStatus).busy).toBe(false)
  })

  it('rejects malformed JSON with 400', async () => {
    const [, run] = makeUpdaterRoutes(deps([]))
    const bad = fakeResponse()
    await run.handler(fakeRequest('POST', '{not json'), bad.res)
    expect((await bad.done).status).toBe(400)
  })
})
