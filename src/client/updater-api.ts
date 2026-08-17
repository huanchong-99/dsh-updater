/**
 * Browser-side wire helpers for the /api/plugin-updater surface. Plain fetch
 * over same-origin /api; the host half enforces the loopback-only fence.
 */

import type { UpdaterStatus } from '../inventory.ts'
import type { UpdateRunResult } from '../update.ts'

/** Error thrown when the status probe fails, carrying the HTTP status. */
export class UpdaterStatusError extends Error {
  /** HTTP status of the failed response (0 when the fetch never returned). */
  readonly status: number
  constructor(status: number) {
    super('plugin updater status unavailable (HTTP ' + String(status) + ')')
    this.status = status
  }
}

/**
 * Probe the plugin-updater status.
 * @returns the scan snapshot.
 */
export async function fetchUpdaterStatus(): Promise<UpdaterStatus> {
  let response: Response
  try {
    response = await fetch('/api/plugin-updater/status')
  } catch {
    throw new UpdaterStatusError(0)
  }
  if (!response.ok) throw new UpdaterStatusError(response.status)
  return await response.json() as UpdaterStatus
}

/**
 * Run one update. Blocks until the host executor finishes — the panel shows
 * an in-flight state meanwhile.
 * @param body - `{ profile, name }`, `{ profile, all: true }`, or `{ all: true }`.
 * @returns the run outcome.
 */
export async function runPluginUpdate(body: { profile?: string; name?: string; all?: boolean }): Promise<UpdateRunResult> {
  const response = await fetch('/api/plugin-updater/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('plugin updater run unavailable')
  return await response.json() as UpdateRunResult
}
