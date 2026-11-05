/** Route family: trust fence, job start / single-flight / polling — no real pnpm/git. */

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isTrustedUpdaterRequest, makeUpdaterRoutes, UPDATE_PATHS, type UpdaterRoutesDeps } from '../src/routes.ts'
import type { UpdaterStatus } from '../src/inventory.ts'
import { JobStore, type JobPlan, type JobView } from '../src/jobs.ts'

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

const STATUS: UpdaterStatus = { profiles: ['web'], records: [], checkedAt: 'now', busy: false }

function routesWith(plan: UpdaterRoutesDeps['plan'], rejection: 401 | 403 | undefined = undefined): { routes: ReturnType<typeof makeUpdaterRoutes>; jobs: JobStore } {
  const jobs = new JobStore()
  return { jobs, routes: makeUpdaterRoutes({ fence: () => rejection, status: async () => STATUS, plan, jobs }) }
}

async function call(route: ReturnType<typeof makeUpdaterRoutes>[number], method: string, body?: string): Promise<{ status: number; body: unknown }> {
  const response = fakeResponse()
  await route.handler(fakeRequest(method, body), response.res)
  return response.done
}

describe('makeUpdaterRoutes', () => {
  it('registers the three exact routes and enforces method and fence', async () => {
    const { routes } = routesWith(async () => ({ steps: [], settled: [] }))
    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', UPDATE_PATHS.status], ['exact', UPDATE_PATHS.run], ['exact', UPDATE_PATHS.job],
    ])
    const [status, run, job] = routes
    expect((await call(status, 'POST')).status).toBe(405)
    expect((await call(run, 'GET')).status).toBe(405)
    expect((await call(job, 'POST')).status).toBe(405)
    const answer = await call(status, 'GET')
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ busy: false })
    for (const rejection of [401, 403] as const) {
      const fenced = routesWith(async () => ({ steps: [], settled: [] }), rejection).routes
      for (const [route, method] of [[fenced[0], 'GET'], [fenced[1], 'POST'], [fenced[2], 'GET']] as const) {
        const answer = await call(route, method, '{}')
        expect(answer.status).toBe(rejection)
        expect(answer.body).toMatchObject({ code: rejection === 401 ? 'unauthorized' : 'forbidden' })
      }
    }
  })

  it('rejects malformed bodies and scopes with 400', async () => {
    const [, run] = routesWith(async () => ({ steps: [], settled: [] })).routes
    expect((await call(run, 'POST', '{not json')).status).toBe(400)
    expect((await call(run, 'POST', '"x"')).status).toBe(400)
    expect((await call(run, 'POST', '{}')).status).toBe(400)
  })

  it('starts a job with 202, answers 409 while it runs, and exposes progress on /job and /status', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let seenRequest: unknown
    const plan = async (request: unknown): Promise<JobPlan> => {
      seenRequest = request
      return {
        steps: [{
          item: { key: 'web\0dsh-foo', profile: 'web', name: 'dsh-foo', via: 'plugin-manager', kind: 'registry', from: '1.0.0', to: '1.1.0', state: 'pending' },
          run: async () => { await gate; return { state: 'done', application: 'applied' } },
        }],
        settled: [],
      }
    }
    const { routes, jobs } = routesWith(plan)
    const [status, run, job] = routes
    const started = await call(run, 'POST', JSON.stringify({ pluginManager: true }))
    expect(started.status).toBe(202)
    expect((started.body as { job: JobView }).job.scope).toEqual({ type: 'plugin-manager' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(seenRequest).toEqual({ pluginManager: true })
    const second = await call(run, 'POST', JSON.stringify({ all: true }))
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ code: 'busy' })
    const during = await call(job, 'GET')
    expect(during.body).toMatchObject({ busy: true, job: { phase: 'running', items: [{ name: 'dsh-foo', state: 'running' }] } })
    expect((await call(status, 'GET')).body).toMatchObject({ busy: true, job: { phase: 'running' } })
    release()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(jobs.running).toBe(false)
    expect((await call(job, 'GET')).body).toMatchObject({ busy: false, job: { phase: 'finished', items: [{ state: 'done', application: 'applied' }] } })
  })

  it('answers job:null before any job ran', async () => {
    const [, , job] = routesWith(async () => ({ steps: [], settled: [] })).routes
    expect((await call(job, 'GET')).body).toEqual({ busy: false, job: null })
  })
})
