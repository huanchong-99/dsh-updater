/** Planner: scope parsing, routing between the plugin manager and the updater, ordering. */

import { describe, expect, it } from 'vitest'
import { planRun, scopeOf, type PlannerDeps } from '../src/planner.ts'
import type { PluginRecord, UpdaterStatus } from '../src/inventory.ts'
import type { OfficialBundle, OfficialPluginManager } from '../src/official.ts'
import type { UpdateRunResult, UpdateTarget } from '../src/update.ts'

function record(overrides: Partial<PluginRecord>): PluginRecord {
  return { profile: 'web', name: 'dsh-foo', spec: '1.0.0', kind: 'npm', outdated: true, current: '1.0.0', latest: '1.1.0', ...overrides }
}

function manager(bundles: OfficialBundle[], calls: string[] = []): OfficialPluginManager {
  return {
    listBundles: async () => bundles,
    listVersions: async name => ({ status: 'listed', installed: '1.0.0', registry: null, versions: name === 'pm-old' ? [{ version: '2.0.0', prerelease: false, bundle: true }] : [] }),
    updateBundle: async (name, version) => { calls.push(`update ${name}@${version}`); return { from: '1.0.0', to: version, step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: name } } },
    installBundle: async (spec) => { calls.push(`install ${spec}`); return { changed: true, application: 'applied', stage: 'install', target: spec } },
    removeBundle: async (name) => { calls.push(`remove ${name}`); return { changed: true, application: 'applied', stage: 'remove', target: name } },
  }
}

const pmBundle = (name: string): OfficialBundle => ({ name, official: false, availability: 'profile', enabled: true, installed: true, removable: true, updatable: true, version: '1.0.0', source: `${name}@1.0.0` })

function deps(records: PluginRecord[], options: { manager?: OfficialPluginManager; current?: string; ran?: string[] } = {}): PlannerDeps {
  const status: UpdaterStatus = { profiles: ['web', 'tui'], records, checkedAt: 'now', busy: false }
  return {
    status: async () => status,
    resolveTarget: (entry): UpdateTarget | undefined => entry.kind === 'installation-owned' || entry.kind === 'local-only'
      ? undefined
      : { profile: entry.profile, profileDir: `/p/${entry.profile}`, name: entry.name, kind: entry.kind, spec: entry.spec, gitRoot: entry.git?.root },
    runUpdater: async (target, options): Promise<UpdateRunResult> => {
      return { ok: true, exitCode: 0, output: `ran ${target.profile}/${target.name}${options.autostash ? ' (stash)' : ''}` }
    },
    manager: () => options.manager,
    currentProfile: () => options.current,
    selfName: 'dsh-updater',
  }
}

describe('scopeOf', () => {
  it('reads every accepted shape and rejects the rest', () => {
    expect(scopeOf({ pluginManager: true })).toEqual({ type: 'plugin-manager' })
    expect(scopeOf({ name: 'x' })).toEqual({ type: 'one', name: 'x' })
    expect(scopeOf({ profile: 'web', name: 'x' })).toEqual({ type: 'one', profile: 'web', name: 'x' })
    expect(scopeOf({ all: true })).toEqual({ type: 'all' })
    expect(scopeOf({ all: true, profile: 'web' })).toEqual({ type: 'profile', profile: 'web' })
    expect(scopeOf({})).toBeUndefined()
    expect(scopeOf({ name: '' })).toBeUndefined()
  })
})

describe('planRun', () => {
  it('pluginManager scope runs only the manager, and needs one', async () => {
    const calls: string[] = []
    const rows = [record({ name: 'pm-old', managedBy: 'plugin-manager' }), record({ name: 'git-row', kind: 'git-clone' })]
    const plan = await planRun(deps(rows, { manager: manager([pmBundle('pm-old'), pmBundle('pm-new')], calls), current: 'web' }), { pluginManager: true }, { type: 'plugin-manager' })
    expect(plan.steps.map(step => [step.item.name, step.item.via, step.item.to])).toEqual([['pm-old', 'plugin-manager', '2.0.0']])
    expect(plan.settled.map(item => [item.name, item.state, item.skipReason])).toEqual([['pm-new', 'skipped', 'up-to-date']])
    expect(await plan.steps[0].run(() => {}, 'req')).toMatchObject({ state: 'done', application: 'applied' })
    expect(calls).toEqual(['update pm-old@2.0.0'])
    await expect(planRun(deps(rows), { pluginManager: true }, { type: 'plugin-manager' })).rejects.toThrow(/plugin manager/)
  })

  it('a single managed row goes through the manager; an unmanaged one through the updater', async () => {
    const rows = [record({ name: 'pm-old', managedBy: 'plugin-manager' }), record({ name: 'plain', profile: 'tui' })]
    const options = { manager: manager([pmBundle('pm-old')]), current: 'web' }
    const managed = await planRun(deps(rows, options), { name: 'pm-old' }, { type: 'one', name: 'pm-old' })
    expect(managed.steps.map(step => step.item.via)).toEqual(['plugin-manager'])
    const plain = await planRun(deps(rows, options), { profile: 'tui', name: 'plain', autostash: true }, { type: 'one', profile: 'tui', name: 'plain' })
    expect(plain.steps.map(step => step.item.via)).toEqual(['updater'])
    expect(await plain.steps[0].run(() => {}, 'req')).toMatchObject({ state: 'done', output: 'ran tui/plain (stash)' })
  })

  it('refuses unknown names and reports read-only kinds as failed items', async () => {
    await expect(planRun(deps([]), { name: 'nope' }, { type: 'one', name: 'nope' })).rejects.toThrow(/nope/)
    const plan = await planRun(deps([record({ name: 'base', kind: 'installation-owned' })]), { name: 'base' }, { type: 'one', name: 'base' })
    expect(plan.steps).toEqual([])
    expect(plan.settled[0]).toMatchObject({ state: 'failed', errorCode: 'unsupported' })
  })

  it('all scope: manager rows of the running profile + updater rows elsewhere, deduped clones, self last, quiet skips', async () => {
    const rows = [
      record({ name: 'dsh-updater', kind: 'git-clone', git: { root: '/self' } }),
      record({ name: 'pm-old', managedBy: 'plugin-manager' }),
      record({ name: 'pm-new', managedBy: 'plugin-manager', outdated: false }),
      record({ name: 'mono-a', kind: 'git-clone', git: { root: '/mono' } }),
      record({ name: 'mono-b', kind: 'git-clone', git: { root: '/mono' } }),
      record({ name: 'fresh', outdated: false }),
      record({ name: 'tui-npm', profile: 'tui' }),
    ]
    const plan = await planRun(deps(rows, { manager: manager([pmBundle('pm-old'), pmBundle('pm-new')]), current: 'web' }), { all: true }, { type: 'all' })
    expect(plan.steps.map(step => `${step.item.via}:${step.item.name}`)).toEqual([
      'plugin-manager:pm-old', 'updater:mono-a', 'updater:tui-npm', 'updater:dsh-updater',
    ])
    // Up-to-date manager rows are not listed in a bulk run.
    expect(plan.settled).toEqual([])
  })

  it('profile scope uses the manager only for the running profile', async () => {
    const rows = [record({ name: 'pm-old', managedBy: 'plugin-manager' }), record({ name: 'tui-npm', profile: 'tui' })]
    const options = { manager: manager([pmBundle('pm-old')]), current: 'web' }
    const web = await planRun(deps(rows, options), { all: true, profile: 'web' }, { type: 'profile', profile: 'web' })
    expect(web.steps.map(step => step.item.name)).toEqual(['pm-old'])
    const tui = await planRun(deps(rows, options), { all: true, profile: 'tui' }, { type: 'profile', profile: 'tui' })
    expect(tui.steps.map(step => step.item.name)).toEqual(['tui-npm'])
  })
})
