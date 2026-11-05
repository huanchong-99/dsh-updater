/** Plugin manager bridge: planning rules, execution, rollback — against a fake manager. */

import { describe, expect, it } from 'vitest'
import {
  annotateRecords,
  catalogDrift,
  managedKind,
  officialCandidate,
  planOfficialUpdates,
  runOfficialItem,
  type OfficialBundle,
  type OfficialChangeResult,
  type OfficialPluginManager,
  type OfficialUpdateResult,
  type OfficialVersion,
  type OfficialVersionList,
} from '../src/official.ts'
import type { PluginRecord } from '../src/inventory.ts'

function bundle(overrides: Partial<OfficialBundle>): OfficialBundle {
  return {
    name: 'dsh-foo', official: false, availability: 'profile', enabled: true, installed: true,
    removable: true, updatable: false, version: '1.0.0', source: 'dsh-foo@1.0.0', ...overrides,
  }
}

const applied = (target: string, overrides: Partial<OfficialChangeResult> = {}): OfficialChangeResult =>
  ({ changed: true, application: 'applied', stage: 'install', target, ...overrides })
const failed = (target: string, overrides: Partial<OfficialChangeResult> = {}): OfficialChangeResult =>
  ({ changed: false, application: 'failed', stage: 'install', target, error: { code: 'operation-error', diagnostic: 'boom' }, ...overrides })

interface Call { method: string; args: unknown[] }

function fakeManager(options: {
  bundles: OfficialBundle[]
  versions?: Record<string, OfficialVersionList>
  update?: (name: string, version: string) => OfficialUpdateResult
  install?: (spec: string) => OfficialChangeResult
  remove?: (name: string) => OfficialChangeResult
}): { manager: OfficialPluginManager; calls: Call[] } {
  const calls: Call[] = []
  const manager: OfficialPluginManager = {
    listBundles: async () => { calls.push({ method: 'listBundles', args: [] }); return options.bundles },
    listVersions: async (name) => {
      calls.push({ method: 'listVersions', args: [name] })
      const list = options.versions?.[name]
      if (list === undefined) throw new Error('registry down')
      return list
    },
    updateBundle: async (name, version, opts) => {
      calls.push({ method: 'updateBundle', args: [name, version, opts] })
      return options.update?.(name, version) ?? { from: '1.0.0', to: version, step: 'install', result: applied(`${name}@${version}`) }
    },
    installBundle: async (spec, opts) => {
      calls.push({ method: 'installBundle', args: [spec, opts] })
      return options.install?.(spec) ?? applied(spec)
    },
    removeBundle: async (name) => {
      calls.push({ method: 'removeBundle', args: [name] })
      return options.remove?.(name) ?? applied(name, { stage: 'remove' })
    },
  }
  return { manager, calls }
}

const listed = (versions: readonly OfficialVersion[]): OfficialVersionList =>
  ({ status: 'listed', installed: '1.0.0', registry: null, versions })

describe('officialCandidate (the built-in page rule)', () => {
  it('picks the newest installable, non-deprecated, stable version', () => {
    expect(officialCandidate(listed([
      { version: '3.0.0', prerelease: false, bundle: true, incompatible: { name: 'x' } },
      { version: '2.1.0-rc.1', prerelease: true, bundle: true },
      { version: '2.0.0', prerelease: false, bundle: true, deprecated: 'no' },
      { version: '1.9.0', prerelease: false, bundle: false },
      { version: '1.5.0', prerelease: false, bundle: true },
    ]))?.version).toBe('1.5.0')
    expect(officialCandidate({ status: 'refused', problem: 'network', reason: 'x' })).toBeUndefined()
  })
})

describe('catalogDrift / managedKind', () => {
  const target = { spec: '@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1', version: '0.2.2-rc.1' }
  it('flags an installed official bundle whose version differs from the running DSH copy', () => {
    expect(catalogDrift(bundle({ official: true, installTarget: target, version: '0.2.1-rc.5' }))).toBe(true)
    expect(catalogDrift(bundle({ official: true, installTarget: target, version: '0.2.2-rc.1', source: target.spec }))).toBe(false)
    expect(catalogDrift(bundle({ official: true, installTarget: target, version: '0.2.1-rc.5', removable: false }))).toBe(false)
    expect(catalogDrift(bundle({ official: true, installTarget: target, version: '0.2.1-rc.5', availability: 'installation' }))).toBe(false)
  })

  it('flags a link: target or link: source that does not match', () => {
    const link = { spec: 'link:/src/dsh/packages/x', version: '0.2.2-rc.1' }
    expect(catalogDrift(bundle({ official: true, installTarget: link, version: '0.2.2-rc.1', source: '@x@0.2.2-rc.1' }))).toBe(true)
    expect(catalogDrift(bundle({ official: true, installTarget: link, version: '0.2.2-rc.1', source: 'link:/src/dsh/packages/x' }))).toBe(false)
  })

  it('classifies what the manager owns', () => {
    expect(managedKind(bundle({ updatable: true }))).toBe('registry')
    expect(managedKind(bundle({ official: true, installTarget: target }))).toBe('catalog')
    expect(managedKind(bundle({ official: true, availability: 'installation', installTarget: target }))).toBeUndefined()
    expect(managedKind(bundle({}))).toBeUndefined()
  })
})

describe('planOfficialUpdates', () => {
  const target = { spec: '@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1', version: '0.2.2-rc.1' }
  const bundles = [
    bundle({ name: 'a', updatable: true }),
    bundle({ name: 'b', updatable: true }),
    bundle({ name: 'c', updatable: true }),
    bundle({ name: 'd', updatable: true }),
    bundle({ name: 'e', updatable: true }),
    bundle({ name: '@deepseek-ai/dsh-subagent-codex', official: true, installTarget: target, version: '0.2.1-rc.5', source: '@deepseek-ai/dsh-subagent-codex@0.2.1-rc.5', enabled: false }),
    bundle({ name: '@deepseek-ai/dsh-subagent-claude-code', official: true, installTarget: { spec: 'y', version: '0.2.2-rc.1' }, version: '0.2.2-rc.1', source: 'y' }),
    bundle({ name: 'not-managed' }),
  ]
  const versions: Record<string, OfficialVersionList> = {
    a: listed([{ version: '1.2.0', prerelease: false, bundle: true }]),
    b: listed([]),
    c: listed([{ version: '2.0.0', prerelease: false, bundle: true, incompatible: {} }]),
    d: listed([{ version: '1.1.0-rc.1', prerelease: true, bundle: true }]),
    // e: listVersions throws → check-failed
  }

  it('plans registry and catalog updates and explains every skip', async () => {
    const { manager } = fakeManager({ bundles, versions })
    const plan = await planOfficialUpdates(manager)
    expect(plan.items).toEqual([
      { name: 'a', kind: 'registry', from: '1.0.0', to: '1.2.0', registry: null },
      {
        name: '@deepseek-ai/dsh-subagent-codex', kind: 'catalog', from: '0.2.1-rc.5', to: '0.2.2-rc.1',
        spec: target.spec, enabled: false, restoreSpec: '@deepseek-ai/dsh-subagent-codex@0.2.1-rc.5',
      },
    ])
    expect(plan.skipped.map(skip => [skip.name, skip.reason])).toEqual([
      ['b', 'up-to-date'],
      ['c', 'needs-newer-dsh'],
      ['d', 'prerelease-only'],
      ['e', 'check-failed'],
      ['@deepseek-ai/dsh-subagent-claude-code', 'up-to-date'],
    ])
    expect(plan.skipped.find(skip => skip.name === 'e')?.detail).toBe('registry down')
  })

  it('restricts the plan to the names asked for', async () => {
    const { manager, calls } = fakeManager({ bundles, versions })
    const plan = await planOfficialUpdates(manager, new Set(['a']))
    expect(plan.items.map(item => item.name)).toEqual(['a'])
    expect(plan.skipped).toEqual([])
    expect(calls.filter(call => call.method === 'listVersions').map(call => call.args[0])).toEqual(['a'])
  })
})

describe('runOfficialItem — registry', () => {
  const item = { name: 'a', kind: 'registry' as const, from: '1.0.0', to: '1.2.0', registry: 'https://registry.npmmirror.com/' }

  it('calls updateBundle with the listing registry and the request id', async () => {
    const { manager, calls } = fakeManager({ bundles: [] })
    const outcome = await runOfficialItem(manager, item, 'req-1')
    expect(outcome).toEqual({ ok: true, application: 'applied' })
    expect(calls.at(-1)).toEqual({ method: 'updateBundle', args: ['a', '1.2.0', { registry: 'https://registry.npmmirror.com/', requestId: 'req-1' }] })
  })

  it('reports restart-required with its reason', async () => {
    const { manager } = fakeManager({ bundles: [], update: () => ({ from: '1.0.0', to: '1.2.0', step: 'install', result: applied('a@1.2.0', { application: 'restart-required', restartReason: 'host-module' }) }) })
    expect(await runOfficialItem(manager, item, 'r')).toEqual({ ok: true, application: 'restart-required', restartReason: 'host-module' })
  })

  it('reports a failure, its pnpm output, and whether the manager put the old version back', async () => {
    const { manager } = fakeManager({ bundles: [], update: () => ({
      from: '1.0.0', to: '1.2.0', step: 'install',
      result: failed('a@1.2.0', { packageResult: { output: 'ERR_PNPM_FETCH_404' } }),
      restore: applied('a@1.0.0'),
    }) })
    expect(await runOfficialItem(manager, item, 'r')).toEqual({
      ok: false, application: 'failed', errorCode: 'operation-error', error: 'boom', output: 'ERR_PNPM_FETCH_404', restored: 'yes',
    })
  })

  it('folds a rejected call into a failure', async () => {
    const { manager } = fakeManager({ bundles: [], update: () => { throw new Error('lock timeout') } })
    expect(await runOfficialItem(manager, item, 'r')).toEqual({ ok: false, errorCode: 'operation-error', error: 'lock timeout' })
  })
})

describe('runOfficialItem — catalog', () => {
  const item = {
    name: '@deepseek-ai/dsh-subagent-codex', kind: 'catalog' as const, from: '0.2.1-rc.5', to: '0.2.2-rc.1',
    spec: '@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1', enabled: true, restoreSpec: '@deepseek-ai/dsh-subagent-codex@0.2.1-rc.5',
  }

  it('removes, then installs the running DSH copy exactly, keeping the selection', async () => {
    const { manager, calls } = fakeManager({ bundles: [] })
    const steps: string[] = []
    expect(await runOfficialItem(manager, item, 'req', step => steps.push(step))).toEqual({ ok: true, application: 'applied' })
    expect(steps).toEqual(['removing', 'installing'])
    expect(calls).toEqual([
      { method: 'removeBundle', args: [item.name] },
      { method: 'installBundle', args: [item.spec, { enabled: true, requestId: 'req', saveExact: true }] },
    ])
  })

  it('installs over a running bundle when the profile has no HMR (stop-profile)', async () => {
    const { manager, calls } = fakeManager({
      bundles: [],
      remove: name => failed(name, { stage: 'remove', error: { code: 'stop-profile' } }),
      install: spec => applied(spec, { application: 'restart-required', restartReason: 'no-hmr' }),
    })
    expect(await runOfficialItem(manager, item, 'r')).toEqual({ ok: true, application: 'restart-required', restartReason: 'no-hmr' })
    expect(calls.map(call => call.method)).toEqual(['removeBundle', 'installBundle'])
  })

  it('stops when the removal itself fails', async () => {
    const { manager, calls } = fakeManager({ bundles: [], remove: name => failed(name, { stage: 'remove', error: { code: 'bundle-in-use' } }) })
    const outcome = await runOfficialItem(manager, item, 'r')
    expect(outcome.ok).toBe(false)
    expect(outcome.errorCode).toBe('bundle-in-use')
    expect(calls.map(call => call.method)).toEqual(['removeBundle'])
  })

  it('reinstalls the removed version when the new one fails', async () => {
    const { manager, calls } = fakeManager({
      bundles: [],
      install: spec => (spec === item.spec ? failed(spec) : applied(spec)),
    })
    const steps: string[] = []
    const outcome = await runOfficialItem(manager, item, 'r', step => steps.push(step))
    expect(outcome).toMatchObject({ ok: false, restored: 'yes', errorCode: 'operation-error' })
    expect(steps).toEqual(['removing', 'installing', 'restoring'])
    expect(calls.at(-1)).toEqual({ method: 'installBundle', args: [item.restoreSpec, { enabled: true, saveExact: true }] })
  })

  it('removes a target that installed but could not start before restoring', async () => {
    const { manager, calls } = fakeManager({
      bundles: [],
      install: spec => (spec === item.spec ? failed(spec, { stage: 'enable' }) : applied(spec)),
    })
    await runOfficialItem(manager, item, 'r')
    expect(calls.map(call => call.method)).toEqual(['removeBundle', 'installBundle', 'removeBundle', 'installBundle'])
  })

  it('reports a failed restore', async () => {
    const { manager } = fakeManager({ bundles: [], install: spec => failed(spec) })
    expect((await runOfficialItem(manager, item, 'r')).restored).toBe('failed')
  })
})

describe('annotateRecords', () => {
  const rows: PluginRecord[] = [
    { profile: 'web', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', current: '1.0.0', latest: '1.1.0', outdated: true },
    { profile: 'web', name: '@deepseek-ai/dsh-subagent-codex', spec: '0.2.1-rc.5', kind: 'npm', current: '0.2.1-rc.5', outdated: false, incompatibleLatest: '9.9.9' },
    { profile: 'web', name: 'dsh-clone', spec: 'link:/x', kind: 'git-clone', outdated: false },
    { profile: 'tui', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', current: '1.0.0', latest: '1.1.0', outdated: true },
  ]
  const bundles = [
    bundle({ name: 'dsh-foo', updatable: true }),
    bundle({ name: '@deepseek-ai/dsh-subagent-codex', official: true, version: '0.2.1-rc.5', installTarget: { spec: 's', version: '0.2.2-rc.1' } }),
  ]

  it('marks only the running profile rows the manager owns, and aligns catalog rows to the running DSH', () => {
    const result = annotateRecords(rows, 'web', bundles)
    expect(result[0]).toMatchObject({ managedBy: 'plugin-manager', officialKind: 'registry', latest: '1.1.0', outdated: true })
    expect(result[1]).toMatchObject({ managedBy: 'plugin-manager', officialKind: 'catalog', latest: '0.2.2-rc.1', outdated: true })
    expect(result[1].incompatibleLatest).toBeUndefined()
    expect(result[2].managedBy).toBeUndefined()
    expect(result[3].managedBy).toBeUndefined()
  })
})
