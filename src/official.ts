/**
 * Bridge to DSH's own plugin manager (`ctx.pluginManager`, provided by the
 * `plugin-manager` row of `@deepseek-ai/dsh-base`). The built-in Plugins page
 * can update each plugin it installed, but only one at a time; this module
 * plans and runs the same operations for every one of them in one go:
 *
 *  - registry bundles the manager marks `updatable` → `listVersions` and the
 *    page's own candidate rule (newest version that declares a bundle,
 *    accepts the running DSH, and is neither deprecated nor a prerelease) →
 *    `updateBundle(name, version)`. The manager checks the target again,
 *    removes the old version, installs the new one, applies it live with HMR,
 *    and reinstalls the old version when the new one fails.
 *  - official on-demand bundles (shipped by DSH, installed into the profile at
 *    `<name>@<DSH version>`) whose installed copy no longer matches the
 *    running DSH → `removeBundle` + `installBundle(installTarget.spec)`, the
 *    page's own "Update" sequence, plus a reinstall of the removed version
 *    when the new one fails (the page leaves that to the user).
 *
 * Only the profile this DSH process runs is managed here — that is the only
 * profile the manager owns. The types below are a structural subset of
 * `@deepseek-ai/dsh-plugin-manager` 0.2.2 (`src/types.ts`), kept local so the
 * plugin carries no dependency on that package.
 */

import type { PluginRecord } from './inventory.ts'

/** Registry URL, or null for pnpm's own configured registry. */
export type Registry = string | null

/** `BundleInfo` subset. */
export interface OfficialBundle {
  name: string
  official: boolean
  availability: 'installation' | 'profile' | 'missing'
  installTarget?: { spec: string; version: string }
  version?: string
  enabled: boolean
  installed: boolean
  source?: string
  removable: boolean
  updatable: boolean
  readOnlyReason?: string
}

/** `PluginVersion` subset. */
export interface OfficialVersion {
  readonly version: string
  readonly prerelease: boolean
  readonly deprecated?: string
  readonly bundle: boolean
  readonly incompatible?: unknown
}

/** `PluginVersionList` subset. */
export type OfficialVersionList =
  | { readonly status: 'listed'; readonly installed: string; readonly registry: Registry; readonly versions: readonly OfficialVersion[] }
  | { readonly status: 'refused'; readonly problem: string; readonly reason: string }

/** `ManagementError` subset. */
export interface OfficialError {
  code: string
  diagnostic?: string
}

/** `ChangeResult` subset. */
export interface OfficialChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  restartReason?: string
  stage: 'install' | 'enable' | 'remove'
  target: string
  error?: OfficialError
  packageResult?: { output: string }
  version?: string
}

/** `PluginUpdateResult` subset. */
export interface OfficialUpdateResult {
  readonly from: string
  readonly to: string
  readonly step: 'check' | 'remove' | 'install'
  readonly result: OfficialChangeResult
  readonly restore?: OfficialChangeResult
}

/** The `PluginManager` methods this plugin calls (in-process, plain results). */
export interface OfficialPluginManager {
  listBundles(): Promise<OfficialBundle[]>
  listVersions(name: string, options?: { registry?: Registry }): Promise<OfficialVersionList>
  updateBundle(name: string, version: string, options?: { registry?: Registry; requestId?: string }): Promise<OfficialUpdateResult>
  installBundle(spec: string, options?: { enabled?: boolean; saveExact?: boolean; requestId?: string; registry?: Registry }): Promise<OfficialChangeResult>
  removeBundle(name: string): Promise<OfficialChangeResult>
}

/** How the manager updates one bundle. */
export type OfficialKind = 'registry' | 'catalog'

/** One update the manager will run. */
export type OfficialPlanItem =
  | { name: string; kind: 'registry'; from: string; to: string; registry: Registry }
  | { name: string; kind: 'catalog'; from?: string; to: string; spec: string; enabled: boolean; restoreSpec?: string }

/** Why a managed bundle gets no update in this run. */
export type OfficialSkipReason = 'up-to-date' | 'needs-newer-dsh' | 'prerelease-only' | 'check-failed'

/** One managed bundle the plan leaves alone, with the reason. */
export interface OfficialSkip {
  name: string
  kind: OfficialKind
  from?: string
  reason: OfficialSkipReason
  detail?: string
}

/** A full plan: what runs, and what is left alone. */
export interface OfficialPlan {
  items: OfficialPlanItem[]
  skipped: OfficialSkip[]
}

/**
 * Whether an installed official on-demand bundle no longer matches the copy
 * the running DSH offers — the built-in page's own `updateAvailable` rule.
 */
export function catalogDrift(bundle: OfficialBundle): boolean {
  const target = bundle.installTarget
  if (!bundle.installed || !bundle.removable || bundle.availability === 'installation' || target === undefined) return false
  return bundle.version !== target.version
    || ((target.spec.startsWith('link:') || bundle.source?.startsWith('link:') === true) && bundle.source !== target.spec)
}

/** Whether the manager owns updates for this bundle at all (drifted or not). */
export function managedKind(bundle: OfficialBundle): OfficialKind | undefined {
  if (bundle.updatable) return 'registry'
  if (bundle.official && bundle.installed && bundle.availability === 'profile' && bundle.installTarget !== undefined) return 'catalog'
  return undefined
}

/**
 * The built-in page's update candidate: the newest listed version that
 * declares a bundle, accepts the running DSH, and is neither deprecated nor a
 * prerelease. The list is newest first.
 */
export function officialCandidate(list: OfficialVersionList): OfficialVersion | undefined {
  if (list.status !== 'listed') return undefined
  return list.versions.find(version => version.bundle && version.incompatible === undefined
    && version.deprecated === undefined && !version.prerelease)
}

/** Why a listed set of newer versions offers no candidate. */
function skipReason(list: OfficialVersionList): OfficialSkipReason {
  if (list.status !== 'listed') return 'check-failed'
  if (list.versions.length === 0) return 'up-to-date'
  if (list.versions.some(version => version.bundle && version.incompatible !== undefined)) return 'needs-newer-dsh'
  if (list.versions.some(version => version.bundle && version.incompatible === undefined && version.prerelease)) return 'prerelease-only'
  return 'up-to-date'
}

/** Map with at most `limit` calls in flight, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  }))
  return results
}

/**
 * Plan the manager's updates for its profile.
 * @param manager - the in-process plugin manager.
 * @param only - restrict the plan to these bundle names (a single-row update).
 */
export async function planOfficialUpdates(manager: OfficialPluginManager, only?: ReadonlySet<string>): Promise<OfficialPlan> {
  const bundles = (await manager.listBundles()).filter(bundle => only === undefined || only.has(bundle.name))
  const items: OfficialPlanItem[] = []
  const skipped: OfficialSkip[] = []

  const registry = bundles.filter(bundle => bundle.updatable)
  const listed = await mapLimit(registry, 4, async (bundle) => {
    try {
      return await manager.listVersions(bundle.name)
    } catch (error) {
      return { status: 'refused', problem: 'unknown', reason: error instanceof Error ? error.message : String(error) } as const
    }
  })
  registry.forEach((bundle, index) => {
    const list = listed[index]
    const candidate = officialCandidate(list)
    if (candidate !== undefined && list.status === 'listed') {
      items.push({ name: bundle.name, kind: 'registry', from: list.installed, to: candidate.version, registry: list.registry })
    } else {
      skipped.push({
        name: bundle.name,
        kind: 'registry',
        from: bundle.version,
        reason: skipReason(list),
        ...(list.status === 'refused' ? { detail: list.reason } : {}),
      })
    }
  })

  for (const bundle of bundles) {
    if (managedKind(bundle) !== 'catalog' || bundle.installTarget === undefined) continue
    if (!catalogDrift(bundle)) {
      skipped.push({ name: bundle.name, kind: 'catalog', from: bundle.version, reason: 'up-to-date' })
      continue
    }
    items.push({
      name: bundle.name,
      kind: 'catalog',
      from: bundle.version,
      to: bundle.installTarget.version,
      spec: bundle.installTarget.spec,
      enabled: bundle.enabled,
      ...(bundle.source !== undefined ? { restoreSpec: bundle.source } : {}),
    })
  }
  return { items, skipped }
}

/** Outcome of one manager-run update, in the shape the job store records. */
export interface OfficialOutcome {
  ok: boolean
  application?: OfficialChangeResult['application']
  restartReason?: string
  /** Present when the new version failed and the old one was reinstalled (or that failed too). */
  restored?: 'yes' | 'failed'
  errorCode?: string
  error?: string
  output?: string
}

/** Applications that leave the target in place. */
function landed(result: OfficialChangeResult): boolean {
  return result.application === 'applied' || result.application === 'restart-required' || result.application === 'overridden'
}

function describe(result: OfficialChangeResult): Pick<OfficialOutcome, 'errorCode' | 'error' | 'output'> {
  return {
    ...(result.error !== undefined ? { errorCode: result.error.code, ...(result.error.diagnostic !== undefined ? { error: result.error.diagnostic } : {}) } : {}),
    ...(result.packageResult?.output !== undefined && result.packageResult.output !== '' ? { output: result.packageResult.output } : {}),
  }
}

/** Fold a rejected manager call (lock timeout, disposal) into a failed result. */
async function settle(stage: OfficialChangeResult['stage'], target: string, call: () => Promise<OfficialChangeResult>): Promise<OfficialChangeResult> {
  try {
    return await call()
  } catch (error) {
    return {
      changed: false,
      application: 'failed',
      stage,
      target,
      error: { code: 'operation-error', diagnostic: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * Run one planned update through the manager.
 * @param manager - the in-process plugin manager.
 * @param item - the planned update.
 * @param requestId - names the manager's progress events and install logs.
 * @param onStep - progress the catalog sequence reports itself (registry
 *   updates report through the manager's own `update-state` events).
 */
export async function runOfficialItem(
  manager: OfficialPluginManager,
  item: OfficialPlanItem,
  requestId: string,
  onStep: (step: string) => void = () => {},
): Promise<OfficialOutcome> {
  if (item.kind === 'registry') {
    let update: OfficialUpdateResult
    try {
      update = await manager.updateBundle(item.name, item.to, { registry: item.registry, requestId })
    } catch (error) {
      return { ok: false, errorCode: 'operation-error', error: error instanceof Error ? error.message : String(error) }
    }
    const { result, restore } = update
    if (landed(result)) {
      return { ok: true, application: result.application, ...(result.restartReason !== undefined ? { restartReason: result.restartReason } : {}) }
    }
    return {
      ok: false,
      application: result.application,
      ...describe(result),
      ...(restore !== undefined ? { restored: landed(restore) ? 'yes' : 'failed' } : {}),
    }
  }

  // Catalog sequence: remove the installed copy, install the running DSH's
  // copy with the same selection, and put the old one back on failure.
  onStep('removing')
  const removed = await settle('remove', item.name, () => manager.removeBundle(item.name))
  // Without HMR a running startup bundle cannot be removed; the install goes
  // over it and waits for the restart, which is what the built-in page does.
  const keptRunning = removed.error?.code === 'stop-profile'
  if (removed.application === 'failed' && !keptRunning) return { ok: false, application: 'failed', ...describe(removed) }
  if (removed.application === 'cancelled') return { ok: false, application: 'cancelled', ...describe(removed) }
  onStep('installing')
  const local = item.spec.startsWith('link:')
  const installed = await settle('install', item.spec, () => manager.installBundle(item.spec, {
    enabled: item.enabled,
    requestId,
    ...(local ? {} : { saveExact: true }),
  }))
  if (landed(installed)) {
    return { ok: true, application: installed.application, ...(installed.restartReason !== undefined ? { restartReason: installed.restartReason } : {}) }
  }
  const failure: OfficialOutcome = { ok: false, application: installed.application, ...describe(installed) }
  if (!removed.changed || item.restoreSpec === undefined) return failure
  onStep('restoring')
  // A target that installed but could not start is still a dependency.
  if (installed.stage === 'enable') await settle('remove', item.name, () => manager.removeBundle(item.name))
  const restore = await settle('install', item.restoreSpec, () => manager.installBundle(item.restoreSpec as string, {
    enabled: item.enabled,
    ...(item.restoreSpec?.startsWith('link:') === true ? {} : { saveExact: true }),
  }))
  return { ...failure, restored: landed(restore) ? 'yes' : 'failed' }
}

/**
 * Mark the running profile's rows the manager owns. Catalog rows take their
 * latest version from the running DSH's install target instead of a registry
 * probe (the manager installs exactly that copy).
 * @param records - scanned rows (any profile).
 * @param profile - the scanned profile name the manager owns.
 * @param bundles - the manager's `listBundles()` answer.
 * @returns the rows, annotated; rows of other profiles are returned as-is.
 */
export function annotateRecords(records: readonly PluginRecord[], profile: string, bundles: readonly OfficialBundle[]): PluginRecord[] {
  const byName = new Map(bundles.map(bundle => [bundle.name, bundle]))
  return records.map((record) => {
    if (record.profile !== profile) return record
    const bundle = byName.get(record.name)
    if (bundle === undefined) return record
    const kind = managedKind(bundle)
    if (kind === undefined) return record
    if (kind === 'catalog' && bundle.installTarget !== undefined) {
      const { incompatibleLatest: _ignored, ...rest } = record
      return {
        ...rest,
        managedBy: 'plugin-manager',
        officialKind: kind,
        current: bundle.version ?? record.current,
        latest: bundle.installTarget.version,
        outdated: catalogDrift(bundle),
      }
    }
    return { ...record, managedBy: 'plugin-manager', officialKind: kind }
  })
}

/** Progress events the manager emits, by request id (subset of its Events merge). */
export interface OfficialProgressEvents {
  'plugin-manager/update-state': { requestId: string; step: string }
  'plugin-manager/install-state': { requestId: string; phase: string }
  'plugin-manager/install-log': { requestId?: string; text: string }
}
