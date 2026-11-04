/** Executor plumbing: timeout vs missing command, argument guards, verification, lock. */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectBuildBlocked,
  isSafeArgument,
  runCommand,
  runWithManagerFallback,
  verifyNpmUpdate,
} from '../src/update.ts'
import { holderExited, profileLockPath, ProfileLockError, withProfileLock } from '../src/lock.ts'

const node = process.execPath

describe('runCommand', () => {
  it('reports a missing command as not started', async () => {
    const result = await runCommand('definitely-not-a-command-xyz', [], { cwd: process.cwd(), timeoutMs: 5_000 })
    expect(result.started).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('marks a killed run as timed out, not as missing', async () => {
    const result = await runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { cwd: process.cwd(), timeoutMs: 200 })
    expect(result.started).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
  })
})

describe('runWithManagerFallback', () => {
  it('skips missing managers and uses the first one that exists', async () => {
    const result = await runWithManagerFallback([
      { command: 'definitely-not-a-command-xyz', args: [] },
      { command: node, args: ['-e', 'process.stdout.write("hi")'] },
    ], { cwd: process.cwd(), timeoutMs: 5_000 })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('hi')
  })

  it('stops the chain on a timeout instead of retrying through the next manager', async () => {
    let secondRan = false
    const marker = join(mkdtempSync(join(tmpdir(), 'dsh-updater-fb-')), 'ran')
    const result = await runWithManagerFallback([
      { command: node, args: ['-e', 'setTimeout(() => {}, 10000)'] },
      { command: node, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] },
    ], { cwd: process.cwd(), timeoutMs: 200 })
    secondRan = existsSync(marker)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('timeout')
    expect(secondRan).toBe(false)
  })

  it('classifies a non-zero exit as manager-failed, or build-blocked when pnpm named allowBuilds', async () => {
    const failed = await runWithManagerFallback([{ command: node, args: ['-e', 'process.exit(3)'] }], { cwd: process.cwd(), timeoutMs: 5_000 })
    expect(failed.errorCode).toBe('manager-failed')
    expect(failed.exitCode).toBe(3)
    const blocked = await runWithManagerFallback([{ command: node, args: ['-e', 'console.error("add dsh-foo: true to allowBuilds"); process.exit(1)'] }], { cwd: process.cwd(), timeoutMs: 5_000 })
    expect(blocked.errorCode).toBe('build-blocked')
  })

  it('reports pnpm-missing when no candidate starts', async () => {
    const result = await runWithManagerFallback([{ command: 'definitely-not-a-command-xyz', args: [] }], { cwd: process.cwd(), timeoutMs: 5_000 })
    expect(result.errorCode).toBe('pnpm-missing')
  })
})

describe('detectBuildBlocked / isSafeArgument', () => {
  it('recognizes the pnpm allowBuilds refusal', () => {
    expect(detectBuildBlocked('Ignored build scripts: dsh-foo. Run "pnpm approve-builds"')).toBe(true)
    expect(detectBuildBlocked('ERR_PNPM_FETCH_404')).toBe(false)
  })

  it('accepts names, versions, and git specs but refuses shell metacharacters', () => {
    expect(isSafeArgument('@scope/dsh-foo')).toBe(true)
    expect(isSafeArgument('1.2.3-rc.1+build.5')).toBe(true)
    expect(isSafeArgument('github:you/repo#v1.0.0')).toBe(true)
    expect(isSafeArgument('git+https://gitlab.example.com/t/r.git#abc&path:/packages/bar')).toBe(false)
    expect(isSafeArgument('foo; rm -rf /')).toBe(false)
    expect(isSafeArgument('foo && echo x')).toBe(false)
    expect(isSafeArgument('--config.x=y')).toBe(false)
    expect(isSafeArgument('')).toBe(false)
  })
})

describe('verifyNpmUpdate', () => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-updater-verify-'))
  const pkg = join(profile, 'node_modules', 'dsh-foo')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-x', dependencies: { 'dsh-foo': '1.1.0' } }))
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-foo', version: '1.1.0' }))

  it('accepts the exact expected version and flags anything else as stale', () => {
    expect(verifyNpmUpdate(profile, 'dsh-foo', '1.0.0', '1.1.0').ok).toBe(true)
    const stale = verifyNpmUpdate(profile, 'dsh-foo', '1.0.0', '1.2.0')
    expect(stale.ok).toBe(false)
    expect(stale.errorCode).toBe('stale')
  })

  it('without an expected version, movement or a no-op both pass and an unresolvable package fails', () => {
    expect(verifyNpmUpdate(profile, 'dsh-foo', '1.0.0', undefined).ok).toBe(true)
    const unchanged = verifyNpmUpdate(profile, 'dsh-foo', '1.1.0', undefined)
    expect(unchanged.ok).toBe(true)
    expect(unchanged.output).toContain('unchanged')
    const missing = verifyNpmUpdate(profile, 'dsh-missing', undefined, undefined)
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('verify-failed')
    rmSync(profile, { recursive: true, force: true })
  })
})

describe('withProfileLock', () => {
  it('creates and removes <profile>/package.json.lock around the operation', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dsh-updater-lock-'))
    try {
      const lockPath = profileLockPath(profile)
      const seen = await withProfileLock(profile, async () => existsSync(lockPath))
      expect(seen).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('waits for a live holder and gives up with ProfileLockError', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dsh-updater-lock-'))
    try {
      // This very process holds the lock (its PID is alive), so no takeover happens.
      writeFileSync(profileLockPath(profile), `${process.pid}\n`)
      await expect(withProfileLock(profile, async () => 'never', 150)).rejects.toBeInstanceOf(ProfileLockError)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('takes over a lock whose holder exited', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dsh-updater-lock-'))
    try {
      // PID 2147483646 is the largest int32 below the cap; practically never alive.
      writeFileSync(profileLockPath(profile), '2147483646\n')
      expect(holderExited('2147483646\n')).toBe(true)
      expect(holderExited(`${process.pid}\n`)).toBe(false)
      expect(holderExited('garbage')).toBe(false)
      const value = await withProfileLock(profile, async () => 'ran', 2_000)
      expect(value).toBe('ran')
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })
})
