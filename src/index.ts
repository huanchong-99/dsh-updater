/**
 * dsh-updater — Node (host) half.
 *
 * Standalone plugin-update surface for DSH 0.2.x. Scans every profile
 * dependency, classifies its source (installation-owned / npm / git-clone /
 * pnpm-git / local-only), and exposes two loopback-only routes:
 *   GET  /api/plugin-updater/status
 *   POST /api/plugin-updater/run
 *
 * The package is fully independent: no third-party plugin packages are
 * imported at runtime — only Node builtins and the official DSH type surface.
 */

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
import { probeNpmCandidate } from './registry.ts'
import {
  latestGitCommit,
  runTargetUpdate,
  verifyNpmUpdate,
  type UpdateRunResult,
  type UpdateTarget,
} from './update.ts'
import { isTrustedUpdaterRequest, makeUpdaterRoutes, UPDATE_PATHS, type UpdateRunOptions } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-updater'

/** Required host service: the web server route registry. */
export const inject = ['webServer']

/** How many registry / git probes run at once during one status read. */
const PROBE_CONCURRENCY = 6

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

/**
 * Resolve one scanned record into a concrete update target, or undefined
 * when the record cannot be updated from the panel.
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

/**
 * Full status: local scan + network probes (bounded concurrency). Network
 * failures degrade to per-row `latest: undefined` rather than failing the
 * whole status call.
 */
async function readStatus(): Promise<UpdaterStatus> {
  const status = scanProfiles()
  const profileDirs = new Map(listProfileDirs().map(entry => [entry.name, entry.dir]))
  const records = await mapLimit(status.records, PROBE_CONCURRENCY, async (record): Promise<PluginRecord> => {
    if (record.kind === 'npm') {
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
  return { ...status, records }
}

/**
 * Activate the host fiber: register the /api/plugin-updater route family.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const routes = makeUpdaterRoutes({
      fence: request => isTrustedUpdaterRequest(request),
      status: () => readStatus(),
      resolveTarget,
      run: async (target: UpdateTarget, options?: UpdateRunOptions): Promise<UpdateRunResult> => {
        const effectiveTarget = options?.autostash === true ? { ...target, autostash: true } : target
        if (effectiveTarget.kind === 'npm') {
          const before = effectiveTarget.dir === undefined ? undefined : readPackageVersion(effectiveTarget.dir)
          const result = await runTargetUpdate(effectiveTarget)
          if (!result.ok) return result
          const verified = verifyNpmUpdate(effectiveTarget.profileDir, effectiveTarget.name, before, effectiveTarget.version)
          return { ...verified, output: [result.output, verified.output].filter(part => part !== '').join('\n') }
        }
        return runTargetUpdate(effectiveTarget)
      },
    })
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-updater: routes')
}

// Re-export the route path constants for diagnostics and tests.
export { UPDATE_PATHS }
