/**
 * dsh-updater — Node (host) half.
 *
 * Standalone plugin-update surface for DSH. Scans every profile dependency,
 * classifies its source (installation-owned / npm / git-clone / pnpm-git /
 * local-only), and exposes two loopback-only routes:
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
import {
  fetchLatestVersion,
  latestGitCommit,
  runTargetUpdate,
  verifyNpmUpdate,
  type UpdateRunResult,
  type UpdateTarget,
} from './update.ts'
import { isTrustedUpdaterRequest, makeUpdaterRoutes, UPDATE_PATHS } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-updater'

/** Required host service: the web server route registry. */
export const inject = ['webServer']

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
 * Full status: local scan + network probes. Network failures degrade to
 * per-row `latest: undefined` rather than failing the whole status call.
 */
async function readStatus(): Promise<UpdaterStatus> {
  const status = scanProfiles()
  const records = await Promise.all(status.records.map(async (record): Promise<PluginRecord> => {
    if (record.kind === 'npm') {
      const latest = await fetchLatestVersion(record.name, fetch)
      const outdated = latest !== undefined
        && record.current !== undefined
        && compareVersions(latest, record.current) > 0
      return { ...record, latest, outdated }
    }
    if (record.kind === 'git-clone') {
      const target = resolveTarget(record)
      const latest = target === undefined ? undefined : latestGitCommit(target)
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
      const latest = target === undefined ? undefined : latestGitCommit(target, remote, ref)
      const outdated = latest !== undefined && record.current !== undefined && latest !== record.current
      return { ...record, latest, outdated }
    }
    return record
  }))
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
      run: async (target: UpdateTarget): Promise<UpdateRunResult> => {
        if (target.kind === 'npm') {
          const profile = listProfileDirs().find(entry => entry.name === target.profile)
          const before = target.dir === undefined ? undefined : readPackageVersion(target.dir)
          const result = await runTargetUpdate(target)
          if (!result.ok) return result
          if (profile === undefined) return result
          return verifyNpmUpdate(profile.dir, target.name, before, fetch)
        }
        return runTargetUpdate(target)
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

