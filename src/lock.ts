/**
 * Cross-process profile writer lock, wire-compatible with DSH's own
 * `@deepseek-ai/dsh-atomic-write` `withFileLock(<profile>/package.json)`:
 * the built-in Plugins page and `dsh plugin` take `<profile>/package.json.lock`
 * around every pnpm run, so taking the same lock here keeps two installers
 * from rewriting one profile at the same time. Re-implemented (not imported)
 * so the plugin stays free of DSH runtime package dependencies.
 *
 * Protocol: the lock is a `wx`-created sibling holding `<pid>\n`. `EEXIST` is
 * contention; a lock whose recorded PID no longer exists is taken over through
 * a claim file so two contenders cannot both remove it. Contention backs off
 * exponentially until the deadline.
 */

import { createHash } from 'node:crypto'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

/** Matches the DSH plugin manager's default `lockWaitMs`. */
export const DEFAULT_PROFILE_LOCK_WAIT_MS = 120_000
const RETRY_INITIAL_MS = 20
const RETRY_MAX_MS = 200

/** Thrown when the lock cannot be acquired before the deadline. */
export class ProfileLockError extends Error {
  readonly lockPath: string
  constructor(lockPath: string) {
    super(`profile is locked by another plugin operation (${lockPath})`)
    this.name = 'ProfileLockError'
    this.lockPath = lockPath
  }
}

/** The lock path DSH and this plugin share for one profile directory. */
export function profileLockPath(profileDir: string): string {
  return join(profileDir, 'package.json.lock')
}

async function isContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    return false
  }
}

/** Whether a `<pid>\n` record names a process that provably no longer exists. */
export function holderExited(record: string, selfPid: number = process.pid): boolean {
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  if (pid === 0 || pid > 0x7fffffff || pid === selfPid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function readRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch {
    return undefined
  }
}

async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readRecord(lockPath)
  if (record === undefined || !holderExited(record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    if (await readRecord(lockPath) !== record || !holderExited(record)) return false
    try {
      await rm(lockPath, { force: true })
    } catch {
      return false
    }
    return true
  } finally {
    await rm(claim, { force: true }).catch(() => undefined)
  }
}

/**
 * Run `operation` while holding the profile writer lock.
 * @param profileDir - the profile directory whose package.json pnpm will rewrite.
 * @param operation - the pnpm run (and its follow-up) to serialize.
 * @param waitMs - how long to wait for a busy lock before giving up.
 * @throws {ProfileLockError} when the lock stays busy past the deadline.
 */
export async function withProfileLock<T>(
  profileDir: string,
  operation: () => Promise<T>,
  waitMs: number = DEFAULT_PROFILE_LOCK_WAIT_MS,
): Promise<T> {
  const lockPath = profileLockPath(profileDir)
  const deadline = Date.now() + waitMs
  let delay = RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) throw new ProfileLockError(lockPath)
    await wait(delay)
    delay = Math.min(delay * 2, RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}
