/**
 * dsh-updater — Node (host) half.
 *
 * Plugin-update surface for DSH 0.2.x. Scans every profile dependency,
 * classifies its source (installation-owned / npm / git-clone / pnpm-git /
 * local-only), and runs updates as background jobs. In the profile this DSH
 * process runs, everything DSH's own plugin manager installed is updated
 * through that manager (`ctx.pluginManager`), so a one-click run does exactly
 * what the built-in Plugins page's per-plugin Update does — compatibility
 * check, live apply with HMR, rollback on failure — for all of them at once.
 *
 * Routes (DSH browser authentication + loopback only):
 *   GET  /api/plugin-updater/status
 *   POST /api/plugin-updater/run
 *   GET  /api/plugin-updater/job
 *
 * The package is fully independent: no third-party plugin packages are
 * imported at runtime — only Node builtins and the official DSH type surface.
 */

import { realpathSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  scanProfiles,
  listProfileDirs,
  readPackageVersion,
  compareVersions,
  type PluginRecord,
  type UpdaterStatus,
} from './inventory.ts'
import { jobs } from './jobs.ts'
import { annotateRecords, managedKind, type OfficialBundle, type OfficialPluginManager } from './official.ts'
import { planRun, scopeOf } from './planner.ts'
import { probeNpmCandidate } from './registry.ts'
import {
  latestGitCommit,
  runTargetUpdate,
  verifyNpmUpdate,
  type UpdateRunResult,
  type UpdateTarget,
} from './update.ts'
import { isTrustedUpdaterRequest, makeUpdaterRoutes, UPDATE_PATHS } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    // Subset of @deepseek-ai/dsh-plugin-manager's Events merge (method
    // declarations merge as overloads, so the real merge can coexist).
    'plugin-manager/update-state'(progress: { readonly requestId: string; readonly step: string }): void
    'plugin-manager/install-state'(progress: { readonly requestId: string; readonly phase: string }): void
    'plugin-manager/install-log'(chunk: { readonly requestId?: string; readonly text: string }): void
  }
}

/** Stable cordis plugin name. */
export const name = 'dsh-updater'

/**
 * Required host services: the web server route registry, and the connection
 * service whose browser authentication gates every route.
 */
export const inject = ['webServer', 'connection']

/** The connection surface used here (typed locally: its package is browser-side), as DSH's open-in-app does. */
interface ConnectionGate {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** How many registry / git probes run at once during one status read. */
const PROBE_CONCURRENCY = 6

/**
 * The plugin manager and the profile it owns, while both are available.
 * Module scope, like the job store: a job keeps its own reference, and a
 * fiber restart re-fills this when the services come back.
 */
const bridge: { manager?: OfficialPluginManager; profileDir?: string } = {}

/** Map with a concurrency cap, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** Canonical path for comparisons (symlinked homes, case on Windows). */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** The scanned profile name the plugin manager owns, when it is one of ours. */
function currentProfileName(): string | undefined {
  if (bridge.profileDir === undefined) return undefined
  const target = canonical(bridge.profileDir)
  return listProfileDirs().find(entry => canonical(entry.dir) === target)?.name
}

/**
 * Resolve one scanned record into a concrete update target for this plugin's
 * own executors, or undefined when the record cannot be updated from here.
 */
function resolveTarget(record: PluginRecord): UpdateTarget | undefined {
  const profile = listProfileDirs().find(entry => entry.name === record.profile)
  if (profile === undefined) return undefined
  switch (record.kind) {
    case 'git-clone':
      return {
        profile: record.profile,
        profileDir: profile.dir,
        name: record.name,
        kind: 'git-clone',
        spec: record.spec,
        dir: record.dir,
        gitRoot: record.git?.root,
      }
    case 'npm':
      return {
        profile: record.profile,
        profileDir: profile.dir,
        name: record.name,
        kind: 'npm',
        spec: record.spec,
        dir: record.dir,
        // The admitted candidate the probe selected; the executor pins it.
        version: record.outdated ? record.latest : undefined,
      }
    case 'pnpm-git':
      return {
        profile: record.profile,
        profileDir: profile.dir,
        name: record.name,
        kind: 'pnpm-git',
        spec: record.spec,
        dir: record.dir,
      }
    default:
      return undefined
  }
}

/** The manager's bundles, or undefined when it is absent or the read failed. */
async function readOfficialBundles(manager: OfficialPluginManager | undefined): Promise<OfficialBundle[] | undefined> {
  if (manager === undefined) return undefined
  try {
    return await manager.listBundles()
  } catch {
    return undefined
  }
}

/**
 * Full status: local scan + network probes (bounded concurrency) + the
 * plugin manager's view of the running profile. Network failures degrade to
 * per-row `latest: undefined` rather than failing the whole status call.
 */
async function readStatus(): Promise<UpdaterStatus> {
  const status = scanProfiles()
  const profileDirs = new Map(listProfileDirs().map(entry => [entry.name, entry.dir]))
  const current = currentProfileName()
  const bundles = current === undefined ? undefined : await readOfficialBundles(bridge.manager)
  // Catalog rows take their target from the running DSH, not a registry probe.
  const catalog = new Set((bundles ?? []).filter(bundle => managedKind(bundle) === 'catalog').map(bundle => bundle.name))
  const probed = await mapLimit(status.records, PROBE_CONCURRENCY, async (record): Promise<PluginRecord> => {
    if (record.kind === 'npm') {
      if (record.profile === current && catalog.has(record.name)) return record
      const profileDir = profileDirs.get(record.profile)
      if (profileDir === undefined) return record
      const candidate = await probeNpmCandidate(record.name, record.current, {
        profileDir,
        dshVersion: status.dshVersion,
        fetchImpl: fetch,
      })
      // Registry unreachable: leave `latest` unknown so the row stays actionable.
      if (candidate === undefined) return { ...record, latest: undefined, outdated: false }
      const outdated = candidate.latest !== undefined
        && (record.current === undefined || compareVersions(candidate.latest, record.current) > 0)
      return { ...record, latest: candidate.latest ?? record.current, incompatibleLatest: candidate.incompatibleLatest, outdated }
    }
    if (record.kind === 'git-clone') {
      const target = resolveTarget(record)
      const latest = target === undefined ? undefined : await latestGitCommit(target)
      const outdated = latest !== undefined && record.current !== undefined && latest !== record.current
      return { ...record, latest, outdated }
    }
    if (record.kind === 'pnpm-git') {
      // The installed checkout usually has no .git metadata, so use the spec
      // remote + ref when available; pnpm's lockfile gives the resolved
      // commit for the local side of the comparison.
      const target = resolveTarget(record)
      const remote = record.git?.remote
      const ref = record.git?.branch
      const latest = target === undefined ? undefined : await latestGitCommit(target, remote, ref)
      const outdated = latest !== undefined && record.current !== undefined && latest !== record.current
      return { ...record, latest, outdated }
    }
    return record
  })
  if (current === undefined || bundles === undefined) return { ...status, records: probed }
  const records = annotateRecords(probed, current, bundles)
  const managed = records.filter(record => record.managedBy === 'plugin-manager')
  return {
    ...status,
    records,
    pluginManager: { profile: current, managed: managed.length, outdated: managed.filter(record => record.outdated).length },
  }
}

/** Run one target through this plugin's own executors (npm rows verify the version landed). */
async function runUpdater(target: UpdateTarget, options: { autostash: boolean }, onStep: (step: string) => void): Promise<UpdateRunResult> {
  const effectiveTarget = options.autostash ? { ...target, autostash: true } : target
  if (effectiveTarget.kind === 'npm') {
    const before = effectiveTarget.dir === undefined ? undefined : readPackageVersion(effectiveTarget.dir)
    const result = await runTargetUpdate(effectiveTarget, onStep)
    if (!result.ok) return result
    const verified = verifyNpmUpdate(effectiveTarget.profileDir, effectiveTarget.name, before, effectiveTarget.version)
    return { ...verified, output: [result.output, verified.output].filter(part => part !== '').join('\n') }
  }
  return runTargetUpdate(effectiveTarget, onStep)
}

/**
 * Activate the host fiber: register the /api/plugin-updater route family and,
 * whenever DSH's plugin manager is available, bridge to it.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx: Context): void {
  // Optional: base-backed profiles mount the manager; others simply lack it.
  ctx.inject(['pluginManager', 'profileContext'], (sub) => {
    bridge.manager = sub.get('pluginManager') as OfficialPluginManager
    bridge.profileDir = (sub.get('profileContext') as { dir?: string } | undefined)?.dir
    sub.on('plugin-manager/update-state', ({ requestId, step }) => { jobs.progress(requestId, { step }) })
    sub.on('plugin-manager/install-state', ({ requestId, phase }) => { jobs.progress(requestId, { step: phase }) })
    sub.on('plugin-manager/install-log', ({ requestId, text }) => { jobs.output(requestId, text) })
    sub.effect(() => () => {
      bridge.manager = undefined
      bridge.profileDir = undefined
    }, 'dsh-updater: plugin manager bridge')
  })

  ctx.effect(() => {
    const connection = Reflect.get(ctx, 'connection') as ConnectionGate
    const routes = makeUpdaterRoutes({
      // DSH's own authentication first (401 / 403), then the loopback-only rule.
      fence: request => connection.requestRejection(request) ?? (isTrustedUpdaterRequest(request) ? undefined : 403),
      status: () => readStatus(),
      jobs,
      plan: request => planRun({
        status: () => readStatus(),
        resolveTarget,
        runUpdater,
        manager: () => bridge.manager,
        currentProfile: currentProfileName,
        selfName: name,
      }, request, scopeOrThrow(request)),
    })
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-updater: routes')
}

/** The routes validate the scope before planning; this only narrows the type. */
function scopeOrThrow(request: Parameters<typeof scopeOf>[0]): NonNullable<ReturnType<typeof scopeOf>> {
  const scope = scopeOf(request)
  if (scope === undefined) throw new Error('malformed run request')
  return scope
}


// Re-export the route path constants for diagnostics and tests.
export { UPDATE_PATHS }
