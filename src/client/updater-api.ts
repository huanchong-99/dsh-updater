/**
 * Browser-side wire helpers for the /api/plugin-updater surface. Plain fetch
 * over same-origin /api; the host half enforces the loopback-only fence.
 */

import type { UpdaterStatus } from '../inventory.ts'
import type { JobView } from '../jobs.ts'

/** Error thrown when a plugin-updater call fails, carrying the HTTP status. */
export class UpdaterHttpError extends Error {
  /** HTTP status of the failed response (0 when the fetch never returned). */
  readonly status: number
  constructor(operation: 'status' | 'run' | 'job', status: number) {
    super(`plugin updater ${operation} unavailable (HTTP ${String(status)})`)
    this.status = status
  }
}

/** Request body accepted by the run endpoint (mirrors the host RunRequestBody). */
export interface RunRequest {
  profile?: string
  name?: string
  all?: boolean
  /** Update everything DSH's plugin manager installed in the running profile. */
  pluginManager?: boolean
  /** Allow dirty git-clone work trees to update via `git pull --autostash`. */
  autostash?: boolean
}

/** The status answer: the scan plus the current job, when there is one. */
export type StatusAnswer = UpdaterStatus & { job?: JobView }

async function getJson<T>(operation: 'status' | 'job', url: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch {
    throw new UpdaterHttpError(operation, 0)
  }
  if (!response.ok) throw new UpdaterHttpError(operation, response.status)
  return await response.json() as T
}

/**
 * Probe the plugin-updater status (scan + network probes + current job).
 * @throws {UpdaterHttpError} 403 when the page is not a loopback origin, 0 on network failure.
 */
export function fetchUpdaterStatus(): Promise<StatusAnswer> {
  return getJson<StatusAnswer>('status', '/api/plugin-updater/status')
}

/** Read only the current job (cheap; polled while a job runs). */
export function fetchUpdaterJob(): Promise<{ busy: boolean; job: JobView | null }> {
  return getJson('job', '/api/plugin-updater/job')
}

/**
 * Start an update job. The host answers at once; progress comes from
 * {@link fetchUpdaterJob}.
 * @param body - `{ profile, name }`, `{ profile, all: true }`, `{ all: true }`, or `{ pluginManager: true }`.
 * @returns the started job's first snapshot.
 * @throws {UpdaterHttpError} 409 when another job is running, 403 off loopback, 400 for a malformed body.
 */
export async function runPluginUpdate(body: RunRequest): Promise<JobView> {
  let response: Response
  try {
    response = await fetch('/api/plugin-updater/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new UpdaterHttpError('run', 0)
  }
  if (!response.ok) throw new UpdaterHttpError('run', response.status)
  const answer = await response.json() as { job: JobView }
  return answer.job
}
