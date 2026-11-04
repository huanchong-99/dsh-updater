/**
 * Browser-side wire helpers for the /api/plugin-updater surface. Plain fetch
 * over same-origin /api; the host half enforces the loopback-only fence.
 */

import type { UpdaterStatus } from '../inventory.ts'
import type { UpdateRunResult } from '../update.ts'

/** Error thrown when a plugin-updater call fails, carrying the HTTP status. */
export class UpdaterHttpError extends Error {
  /** HTTP status of the failed response (0 when the fetch never returned). */
  readonly status: number
  constructor(operation: 'status' | 'run', status: number) {
    super(`plugin updater ${operation} unavailable (HTTP ${String(status)})`)
    this.status = status
  }
}

/** Request body accepted by the run endpoint (mirrors the host RunRequestBody). */
export interface RunRequest {
  profile?: string
  name?: string
  all?: boolean
  /** Allow dirty git-clone work trees to update via `git pull --autostash`. */
  autostash?: boolean
}

/**
 * Probe the plugin-updater status.
 * @returns the scan snapshot.
 * @throws {UpdaterHttpError} 403 when the page is not a loopback origin, 0 on network failure.
 */
export async function fetchUpdaterStatus(): Promise<UpdaterStatus> {
  let response: Response
  try {
    response = await fetch('/api/plugin-updater/status', { cache: 'no-store' })
  } catch {
    throw new UpdaterHttpError('status', 0)
  }
  if (!response.ok) throw new UpdaterHttpError('status', response.status)
  return await response.json() as UpdaterStatus
}

/**
 * Run one update. Blocks until the host executor finishes — the panel shows
 * an in-flight state meanwhile.
 * @param body - `{ profile, name }`, `{ profile, all: true }`, or `{ all: true }`.
 * @returns the run outcome.
 * @throws {UpdaterHttpError} 409 when another run is already in flight, 403 off loopback.
 */
export async function runPluginUpdate(body: RunRequest): Promise<UpdateRunResult> {
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
  return await response.json() as UpdateRunResult
}
