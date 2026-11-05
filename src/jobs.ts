/**
 * Background update jobs. A run request no longer blocks on the HTTP call:
 * it plans the work, answers 202 at once, and executes the items one by one
 * while the panel polls `GET /api/plugin-updater/job`. A bulk run keeps going
 * past a failed item — the plugin manager rolls a failed update back to the
 * old version and git / pnpm failures leave their own install untouched — so
 * one broken plugin no longer stops every other update.
 *
 * The store lives at module scope, not in the plugin fiber: a live HMR
 * recomposition can restart this plugin's fiber in the middle of a job (the
 * job itself may be what triggers it), and the panel must still find the job
 * when the routes come back.
 */

import { randomUUID } from 'node:crypto'

/** Where a job is in its life. */
export type JobPhase = 'planning' | 'running' | 'finished'

/** One item's state. */
export type JobItemState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** Which engine runs the item. */
export type JobVia = 'plugin-manager' | 'updater'

/** One plugin in a job. */
export interface JobItem {
  /** `${profile}\0${name}` — the same key the panel rows use. */
  key: string
  profile: string
  name: string
  via: JobVia
  /** Source kind (`npm`, `git-clone`, ...) or manager kind (`registry`, `catalog`). */
  kind: string
  from?: string
  to?: string
  state: JobItemState
  /** Current step while running (`checking`, `removing`, `installing`, `pulling`, ...). */
  step?: string
  /** Manager outcome: `applied`, `restart-required`, `overridden`, `failed`, `cancelled`. */
  application?: string
  restartReason?: string
  /** The new version failed and the old one was reinstalled (`yes`) or could not be (`failed`). */
  restored?: 'yes' | 'failed'
  errorCode?: string
  error?: string
  output?: string
  /** Why a skipped item was left alone. */
  skipReason?: string
}

/** What a run request asked for. */
export type JobScope =
  | { type: 'one'; profile?: string; name: string }
  | { type: 'profile'; profile: string }
  | { type: 'all' }
  | { type: 'plugin-manager' }

/** The job snapshot served to the panel. */
export interface JobView {
  id: string
  scope: JobScope
  phase: JobPhase
  startedAt: string
  finishedAt?: string
  items: JobItem[]
  /** Planning failure (nothing ran). */
  error?: string
}

/** Patch an executor reports while it runs. */
export type ItemPatch = Partial<Omit<JobItem, 'key' | 'profile' | 'name' | 'via'>>

/** One planned item with its executor. */
export interface PlannedStep {
  item: JobItem
  /**
   * Execute the item.
   * @param report - progress patches (step changes).
   * @param requestId - names the manager's progress events for this item.
   * @returns the final patch; it must set `state` to `done` or `failed`.
   */
  run(report: (patch: ItemPatch) => void, requestId: string): Promise<ItemPatch>
}

/** A plan: items to execute, plus items already settled (skipped, or refused before running). */
export interface JobPlan {
  steps: PlannedStep[]
  settled: JobItem[]
}

const OUTPUT_CAP = 16 * 1024

/** Keep the tail of an output string. */
function tail(value: string): string {
  return value.length > OUTPUT_CAP ? value.slice(value.length - OUTPUT_CAP) : value
}

/** In-memory store for the current (or last finished) job. */
export class JobStore {
  private job: JobView | undefined
  /** requestId → item key, for the manager's progress events. */
  private readonly requests = new Map<string, string>()

  /** Whether a job is planning or running. */
  get running(): boolean {
    return this.job !== undefined && this.job.phase !== 'finished'
  }

  /** A detached copy of the current job, or undefined. */
  view(): JobView | undefined {
    return this.job === undefined ? undefined : structuredClone(this.job)
  }

  /** Forget a finished job (the panel's dismiss). */
  clear(): boolean {
    if (this.running) return false
    this.job = undefined
    return true
  }

  /**
   * Start a job unless one is running.
   * @param scope - what was asked for.
   * @param plan - builds the plan (may probe the network).
   * @returns the started job's snapshot, or undefined when a job is running.
   */
  start(scope: JobScope, plan: () => Promise<JobPlan>): { view: JobView; done: Promise<void> } | undefined {
    if (this.running) return undefined
    const job: JobView = { id: randomUUID(), scope, phase: 'planning', startedAt: new Date().toISOString(), items: [] }
    this.job = job
    this.requests.clear()
    const done = this.execute(job, plan)
    return { view: structuredClone(job), done }
  }

  /** Apply a manager progress event to the item it names. */
  progress(requestId: string, patch: ItemPatch): void {
    const item = this.itemFor(requestId)
    if (item !== undefined && item.state === 'running') Object.assign(item, patch)
  }

  /** Append a chunk of install output to the item it names. */
  output(requestId: string | undefined, text: string): void {
    if (requestId === undefined || text === '') return
    const item = this.itemFor(requestId)
    if (item !== undefined) item.output = tail((item.output ?? '') + text)
  }

  private itemFor(requestId: string): JobItem | undefined {
    const key = this.requests.get(requestId)
    return key === undefined ? undefined : this.job?.items.find(item => item.key === key)
  }

  private async execute(job: JobView, plan: () => Promise<JobPlan>): Promise<void> {
    let planned: JobPlan
    try {
      planned = await plan()
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
      job.phase = 'finished'
      job.finishedAt = new Date().toISOString()
      return
    }
    job.items = [...planned.steps.map(step => step.item), ...planned.settled]
    job.phase = 'running'
    for (const step of planned.steps) {
      const item = step.item
      const requestId = randomUUID()
      this.requests.set(requestId, item.key)
      item.state = 'running'
      try {
        const final = await step.run(patch => { if (item.state === 'running') Object.assign(item, patch) }, requestId)
        const output = final.output === undefined ? item.output : tail([item.output, final.output].filter(Boolean).join('\n'))
        Object.assign(item, final, output === undefined ? {} : { output })
        if (item.state === 'running') item.state = 'failed'
      } catch (error) {
        item.state = 'failed'
        item.error = error instanceof Error ? error.message : String(error)
      }
      delete item.step
    }
    job.phase = 'finished'
    job.finishedAt = new Date().toISOString()
  }
}

/** The process-wide store (module scope; see the module comment). */
export const jobs = new JobStore()
