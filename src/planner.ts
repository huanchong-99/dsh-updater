/**
 * Turns a run request into a job plan: which rows the DSH plugin manager
 * updates (the profile this process runs, for everything it installed) and
 * which ones this plugin's own executors update (git clones, git-hosted
 * installs, and npm packages of the other profiles).
 */

import type { PluginRecord, UpdaterStatus } from './inventory.ts'
import type { ItemPatch, JobItem, JobPlan, JobScope, PlannedStep } from './jobs.ts'
import {
  planOfficialUpdates,
  runOfficialItem,
  type OfficialPluginManager,
} from './official.ts'
import type { StepReporter, UpdateRunResult, UpdateTarget } from './update.ts'

/** One update-request body accepted by the run endpoint. */
export interface RunRequestBody {
  /** Update every outdated record (in `profile` when given). */
  all?: boolean
  profile?: string
  /** Update a single package by name (within `profile` when given). */
  name?: string
  /** Update everything the DSH plugin manager installed in the running profile. */
  pluginManager?: boolean
  /**
   * Allow dirty git-clone work trees to update via `git pull --ff-only
   * --autostash`. Defaults to false: dirty clones are refused.
   */
  autostash?: boolean
}

/** Read the scope a run request names; undefined for a malformed body. */
export function scopeOf(request: RunRequestBody): JobScope | undefined {
  const profile = typeof request.profile === 'string' && request.profile !== '' ? request.profile : undefined
  if (request.pluginManager === true) return { type: 'plugin-manager' }
  if (typeof request.name === 'string' && request.name !== '') {
    return profile === undefined ? { type: 'one', name: request.name } : { type: 'one', profile, name: request.name }
  }
  if (request.all === true) return profile === undefined ? { type: 'all' } : { type: 'profile', profile }
  return undefined
}

/** Planner dependencies (test seam). */
export interface PlannerDeps {
  /** The current scan, with plugin-manager annotations. */
  status(): Promise<UpdaterStatus>
  /** Resolve a concrete target for this plugin's own executors. */
  resolveTarget(record: PluginRecord): UpdateTarget | undefined
  /** Run one target through this plugin's own executors. */
  runUpdater(target: UpdateTarget, options: { autostash: boolean }, onStep: StepReporter): Promise<UpdateRunResult>
  /** The in-process plugin manager, when this profile has one. */
  manager(): OfficialPluginManager | undefined
  /** The scanned profile name the manager owns. */
  currentProfile(): string | undefined
  /** This plugin's own package name: it is always updated last. */
  selfName: string
}

const rowKey = (profile: string, name: string): string => `${profile}\0${name}`

/** Map an executor result onto the item's final patch. */
function finalPatch(result: UpdateRunResult): ItemPatch {
  return {
    state: result.ok ? 'done' : 'failed',
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.error !== undefined && !result.ok ? { error: result.error } : {}),
    ...(result.output !== '' ? { output: result.output } : {}),
  }
}

/**
 * Build the plan for one request.
 * @throws when the request names nothing that exists, or asks for the plugin
 *   manager where there is none.
 */
export async function planRun(deps: PlannerDeps, request: RunRequestBody, scope: JobScope): Promise<JobPlan> {
  const status = await deps.status()
  const manager = deps.manager()
  const current = deps.currentProfile()
  const autostash = request.autostash === true

  let wantOfficial = false
  let officialOnly: Set<string> | undefined
  let ours: PluginRecord[] = []
  const failed: JobItem[] = []

  switch (scope.type) {
    case 'plugin-manager':
      if (manager === undefined) throw new Error('the DSH plugin manager is not running in this profile')
      wantOfficial = true
      break
    case 'one': {
      const matches = status.records.filter(record => record.name === scope.name
        && (scope.profile === undefined || record.profile === scope.profile))
      if (matches.length === 0) throw new Error(`no package named ${scope.name} was found`)
      for (const record of matches) {
        if (record.managedBy === 'plugin-manager' && manager !== undefined) {
          wantOfficial = true
          ;(officialOnly ??= new Set()).add(record.name)
        } else {
          ours.push(record)
        }
      }
      break
    }
    case 'profile':
      ours = status.records.filter(record => record.profile === scope.profile && record.outdated && record.managedBy === undefined)
      wantOfficial = manager !== undefined && scope.profile === current
      break
    case 'all':
      ours = status.records.filter(record => record.outdated && record.managedBy === undefined)
      wantOfficial = manager !== undefined
      break
  }

  const officialSteps: PlannedStep[] = []
  const skipped: JobItem[] = []
  if (wantOfficial && manager !== undefined) {
    const profile = current ?? '(running profile)'
    const plan = await planOfficialUpdates(manager, officialOnly)
    for (const item of plan.items) {
      officialSteps.push({
        item: {
          key: rowKey(profile, item.name),
          profile,
          name: item.name,
          via: 'plugin-manager',
          kind: item.kind,
          ...(item.from !== undefined ? { from: item.from } : {}),
          to: item.to,
          state: 'pending',
        },
        run: async (report, requestId) => {
          const outcome = await runOfficialItem(manager, item, requestId, step => report({ step }))
          return {
            state: outcome.ok ? 'done' : 'failed',
            ...(outcome.application !== undefined ? { application: outcome.application } : {}),
            ...(outcome.restartReason !== undefined ? { restartReason: outcome.restartReason } : {}),
            ...(outcome.restored !== undefined ? { restored: outcome.restored } : {}),
            ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
            ...(outcome.output !== undefined ? { output: outcome.output } : {}),
          }
        },
      })
    }
    // Bulk runs report only the skips worth reading; a targeted run reports all.
    const verbose = scope.type === 'one' || scope.type === 'plugin-manager'
    for (const skip of plan.skipped) {
      if (!verbose && skip.reason === 'up-to-date') continue
      skipped.push({
        key: rowKey(profile, skip.name),
        profile,
        name: skip.name,
        via: 'plugin-manager',
        kind: skip.kind,
        ...(skip.from !== undefined ? { from: skip.from } : {}),
        state: 'skipped',
        skipReason: skip.reason,
        ...(skip.detail !== undefined ? { error: skip.detail } : {}),
      })
    }
  }

  const ourSteps: PlannedStep[] = []
  const seenGitRoots = new Set<string>()
  for (const record of ours) {
    const key = rowKey(record.profile, record.name)
    const target = deps.resolveTarget(record)
    if (target === undefined) {
      if (scope.type === 'one') {
        failed.push({
          key, profile: record.profile, name: record.name, via: 'updater', kind: record.kind,
          ...(record.current !== undefined ? { from: record.current } : {}),
          state: 'failed', errorCode: 'unsupported', error: `${record.kind} packages cannot be updated from the panel`,
        })
      }
      continue
    }
    if (target.kind === 'git-clone' && target.gitRoot !== undefined) {
      if (seenGitRoots.has(target.gitRoot)) continue
      seenGitRoots.add(target.gitRoot)
    }
    ourSteps.push({
      item: {
        key,
        profile: record.profile,
        name: record.name,
        via: 'updater',
        kind: record.kind,
        ...(record.current !== undefined ? { from: record.current } : {}),
        ...(record.latest !== undefined ? { to: record.latest } : {}),
        state: 'pending',
      },
      run: async report => finalPatch(await deps.runUpdater(target, { autostash }, step => report({ step }))),
    })
  }

  // The manager first (live with HMR), then this plugin's own executors; the
  // updater itself always goes last so it never replaces itself mid-job.
  const isSelf = (step: PlannedStep): boolean => step.item.name === deps.selfName
  const ordered = [...officialSteps, ...ourSteps]
  return { steps: [...ordered.filter(step => !isSelf(step)), ...ordered.filter(isSelf)], settled: [...failed, ...skipped] }
}
