// @vitest-environment jsdom
/** Browser half: render, one-click Plugin Manager run, job polling, and HTTP failure copy. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdatesTab, type UpdatesTabProps } from '../src/client/UpdatesTab.tsx'
import { zh } from '../src/client/locales.ts'
import type { UpdaterStatus } from '../src/inventory.ts'
import type { JobView } from '../src/jobs.ts'

const status: UpdaterStatus = {
  profiles: ['web', 'tui'],
  checkedAt: '2026-11-05T10:00:00.000Z',
  dshVersion: '0.2.2-rc.1',
  busy: false,
  pluginManager: { profile: 'web', managed: 2, outdated: 2 },
  records: [
    { profile: 'web', name: '@deepseek-ai/dsh-base', spec: '(profile bundle)', kind: 'installation-owned', current: '0.2.2-rc.1', outdated: false },
    { profile: 'web', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', current: '1.0.0', latest: '1.2.0', incompatibleLatest: '2.0.0', outdated: true, managedBy: 'plugin-manager', officialKind: 'registry' },
    { profile: 'web', name: '@deepseek-ai/dsh-subagent-codex', spec: '0.2.1-rc.5', kind: 'npm', current: '0.2.1-rc.5', latest: '0.2.2-rc.1', outdated: true, managedBy: 'plugin-manager', officialKind: 'catalog' },
    { profile: 'web', name: 'dsh-clone', spec: 'link:/x', kind: 'git-clone', current: 'abc1234', latest: 'abc1234', outdated: false, git: { root: '/x', branch: 'main', dirty: true } },
    { profile: 'tui', name: 'dsh-git', spec: 'github:a/b', kind: 'pnpm-git', current: 'def5678', outdated: false },
  ],
}

/** Translate with real zh keys rendered as `key` (params appended) so assertions stay stable. */
const t = ((key: string, params?: Record<string, unknown>) => {
  if (!(key in zh)) return `MISSING:${key}`
  return params === undefined ? key : `${key} ${JSON.stringify(params)}`
}) as UpdatesTabProps['t']
const props = { t } as unknown as UpdatesTabProps

function job(phase: JobView['phase'], items: JobView['items']): JobView {
  return { id: 'job-1', scope: { type: 'plugin-manager' }, phase, startedAt: 'now', items }
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): Array<{ url: string; body?: string }> {
  const calls: Array<{ url: string; body?: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    const { status: code, body } = handler(url, init)
    return { ok: code >= 200 && code < 300, status: code, json: async () => body } as Response
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UpdatesTab', () => {
  it('renders the Plugin Manager card, profile groups, badges, and versions', async () => {
    mockFetch(() => ({ status: 200, body: status }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    expect(screen.queryByText(/MISSING:/)).toBeNull()
    expect(screen.getByText(/pm\.summary .*"managed":"2".*"outdated":"2"/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /pm\.updateAll/ })).toBeTruthy()
    expect(screen.getAllByText('pm.badge')).toHaveLength(2)
    expect(screen.getAllByText(/^profile: /).map(node => node.textContent)).toEqual(['profile: web4', 'profile: tui1'])
    expect(screen.getByText(/incompatibleLatest .*2\.0\.0/)).toBeTruthy()
    expect(screen.getByText(/main · dirty/)).toBeTruthy()
    // installation-owned rows get no button; managed npm ×2 (enabled), git-clone (up to date), pnpm-git (latest unknown)
    const updateButtons = screen.getAllByRole('button', { name: 'update' })
    expect(updateButtons.map(button => (button as HTMLButtonElement).disabled)).toEqual([false, false, true, false])
  })

  it('one click starts a plugin-manager job, polls it, shows per-item outcomes, then rechecks', async () => {
    let polls = 0
    const calls = mockFetch((url) => {
      if (url.endsWith('/run')) return { status: 202, body: { ok: true, job: job('planning', []) } }
      if (url.endsWith('/job')) {
        polls++
        if (polls === 1) {
          return { status: 200, body: { busy: true, job: job('running', [
            { key: 'web\0dsh-foo', profile: 'web', name: 'dsh-foo', via: 'plugin-manager', kind: 'registry', from: '1.0.0', to: '1.2.0', state: 'running', step: 'installing' },
            { key: 'web\0@deepseek-ai/dsh-subagent-codex', profile: 'web', name: '@deepseek-ai/dsh-subagent-codex', via: 'plugin-manager', kind: 'catalog', from: '0.2.1-rc.5', to: '0.2.2-rc.1', state: 'pending' },
          ]) } }
        }
        return { status: 200, body: { busy: false, job: job('finished', [
          { key: 'web\0dsh-foo', profile: 'web', name: 'dsh-foo', via: 'plugin-manager', kind: 'registry', from: '1.0.0', to: '1.2.0', state: 'done', application: 'applied' },
          { key: 'web\0@deepseek-ai/dsh-subagent-codex', profile: 'web', name: '@deepseek-ai/dsh-subagent-codex', via: 'plugin-manager', kind: 'catalog', from: '0.2.1-rc.5', to: '0.2.2-rc.1', state: 'failed', errorCode: 'operation-error', restored: 'yes', output: 'ERR_PNPM' },
        ]) } }
      }
      return { status: 200, body: status }
    })
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /pm\.updateAll/ })) })
    expect(calls.find(call => call.url.endsWith('/run'))?.body).toBe(JSON.stringify({ pluginManager: true }))
    await waitFor(() => { expect(screen.getAllByText(/state\.running · step\.installing/).length).toBeGreaterThan(0) }, { timeout: 4000 })
    await waitFor(() => { expect(screen.getByText(/job\.summary .*"done":"1".*"failed":"1"/)).toBeTruthy() }, { timeout: 4000 })
    expect(screen.getAllByText('app.applied').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/state\.failed: pmError\.operation-error · restored\.yes/).length).toBeGreaterThan(0)
    expect(screen.getByText('ERR_PNPM')).toBeTruthy()
    await waitFor(() => { expect(calls.filter(call => call.url.endsWith('/status')).length).toBeGreaterThanOrEqual(2) })
    fireEvent.click(screen.getByRole('button', { name: 'job.dismiss' }))
    expect(screen.queryByText(/job\.summary/)).toBeNull()
  })

  it('posts a single-row run with its profile', async () => {
    const calls = mockFetch(url => url.endsWith('/run')
      ? { status: 202, body: { ok: true, job: { ...job('finished', []), scope: { type: 'one', name: 'dsh-git' } } } }
      : { status: 200, body: status })
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-git')).toBeTruthy() })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'update' })[3]) })
    expect(calls.find(call => call.url.endsWith('/run'))?.body).toBe(JSON.stringify({ profile: 'tui', name: 'dsh-git' }))
    await waitFor(() => { expect(screen.getByText('job.empty')).toBeTruthy() })
  })

  it('shows the auth notice on 401, the loopback-only notice on 403, and the busy notice on 409', async () => {
    mockFetch(() => ({ status: 401, body: { ok: false, code: 'unauthorized' } }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('unauthorized')).toBeTruthy() })
    cleanup()
    mockFetch(() => ({ status: 403, body: { ok: false, code: 'forbidden' } }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('forbidden')).toBeTruthy() })
    cleanup()
    mockFetch(url => (url.endsWith('/run') ? { status: 409, body: { ok: false, code: 'busy' } } : { status: 200, body: status }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'updateAll' })) })
    await waitFor(() => { expect(screen.getByText('busyHint')).toBeTruthy() })
  })

  it('disables one-click when nothing is pending, and keeps it when the preview could not tell', async () => {
    const settled = { ...status, pluginManager: { profile: 'web', managed: 2, outdated: 0 }, records: status.records.map(record => (record.managedBy === undefined ? record : { ...record, outdated: false, latest: record.current })) }
    mockFetch(() => ({ status: 200, body: settled }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    expect((screen.getByRole('button', { name: /pm\.updateAll/ }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const unknown = { ...settled, records: settled.records.map(record => (record.name === 'dsh-foo' ? { ...record, latest: undefined } : record)) }
    mockFetch(() => ({ status: 200, body: unknown }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    expect((screen.getByRole('button', { name: /pm\.updateAll/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a failure log once when the error repeats the streamed output', async () => {
    const log = 'Progress: resolved 1\n ERR_PNPM_FETCH_404 GET missing.tgz'
    mockFetch(() => ({ status: 200, body: { ...status, job: job('finished', [
      { key: 'web\0dsh-foo', profile: 'web', name: 'dsh-foo', via: 'plugin-manager', kind: 'registry', from: '1.0.0', to: '1.2.0', state: 'failed', application: 'failed', restored: 'yes', errorCode: 'operation-error', error: log, output: log },
    ]) } }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText(/job\.summary/)).toBeTruthy() })
    const pre = screen.getByText(/ERR_PNPM_FETCH_404/)
    expect(pre.textContent?.match(/ERR_PNPM_FETCH_404/g)).toHaveLength(1)
  })

  it('says so when the running profile has no plugin manager', async () => {
    const { pluginManager: _omit, ...withoutManager } = status
    mockFetch(() => ({ status: 200, body: withoutManager }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('pm.unavailable')).toBeTruthy() })
    expect(screen.queryByRole('button', { name: /pm\.updateAll/ })).toBeNull()
  })
})
