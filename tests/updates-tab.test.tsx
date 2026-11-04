// @vitest-environment jsdom
/** Browser half render smoke: the tab renders a status, groups by profile, and maps HTTP failures to copy. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdatesTab, type UpdatesTabProps } from '../src/client/UpdatesTab.tsx'
import type { UpdaterStatus } from '../src/inventory.ts'

const status: UpdaterStatus = {
  profiles: ['web', 'tui'],
  checkedAt: '2026-11-04T10:00:00.000Z',
  dshVersion: '0.2.2-rc.1',
  busy: false,
  records: [
    { profile: 'web', name: '@deepseek-ai/dsh-base', spec: '(profile bundle)', kind: 'installation-owned', current: '0.2.2-rc.1', outdated: false },
    { profile: 'web', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', current: '1.0.0', latest: '1.2.0', incompatibleLatest: '2.0.0', outdated: true },
    { profile: 'web', name: 'dsh-clone', spec: 'link:/x', kind: 'git-clone', current: 'abc1234', latest: 'abc1234', outdated: false, git: { root: '/x', branch: 'main', dirty: true } },
    { profile: 'tui', name: 'dsh-git', spec: 'github:a/b', kind: 'pnpm-git', current: 'def5678', outdated: false },
  ],
}

const t = ((key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key} ${JSON.stringify(params)}`) as UpdatesTabProps['t']
const props = { t } as unknown as UpdatesTabProps

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): ReturnType<typeof vi.fn> {
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const { status: code, body } = handler(url, init)
    return { ok: code >= 200 && code < 300, status: code, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', impl)
  return impl
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('UpdatesTab', () => {
  it('renders profile groups, versions, and the DSH runtime version', async () => {
    mockFetch(() => ({ status: 200, body: status }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    expect(screen.getByText(/dshVersion .*0\.2\.2-rc\.1/)).toBeTruthy()
    expect(screen.getAllByText(/^profile: /).map(node => node.textContent)).toEqual(['profile: web3', 'profile: tui1'])
    expect(screen.getByText('1.2.0')).toBeTruthy()
    expect(screen.getByText(/incompatibleLatest .*2\.0\.0/)).toBeTruthy()
    expect(screen.getByText(/main · dirty/)).toBeTruthy()
    // installation-owned rows show the DSH version as their latest and have no update button.
    expect(screen.getAllByText('0.2.2-rc.1').length).toBeGreaterThanOrEqual(2)
    const updateButtons = screen.getAllByRole('button', { name: 'update' })
    // installation-owned rows get no button; npm (enabled), git-clone (disabled: up to date), pnpm-git (enabled: latest unknown)
    expect(updateButtons.map(button => (button as HTMLButtonElement).disabled)).toEqual([false, true, false])
    expect((screen.getByRole('button', { name: 'updateAll' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('posts a single-package run and rechecks afterwards', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    mockFetch((url, init) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
      if (url.endsWith('/run')) return { status: 200, body: { ok: true, exitCode: 0, output: 'dsh-foo@1.2.0' } }
      return { status: 200, body: status }
    })
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'update' })[0]) })
    await waitFor(() => { expect(screen.getByText('done')).toBeTruthy() })
    const run = calls.find(call => call.url.endsWith('/run'))
    expect(run?.body).toBe(JSON.stringify({ profile: 'web', name: 'dsh-foo', autostash: false }))
    expect(calls.filter(call => call.url.endsWith('/status')).length).toBeGreaterThanOrEqual(2)
  })

  it('shows the loopback-only notice on 403 and the busy notice on 409', async () => {
    mockFetch(() => ({ status: 403, body: { ok: false, code: 'forbidden' } }))
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('forbidden')).toBeTruthy() })
    cleanup()
    mockFetch((url) => url.endsWith('/run') ? { status: 409, body: { ok: false, code: 'busy' } } : { status: 200, body: status })
    render(<UpdatesTab {...props} />)
    await waitFor(() => { expect(screen.getByText('dsh-foo')).toBeTruthy() })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'updateAll' })) })
    await waitFor(() => { expect(screen.getByText('errorCode.busy')).toBeTruthy() })
  })
})
