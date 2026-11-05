/**
 * dsh-updater update executors. Each source kind has exactly one executor:
 *  - git-clone:  git pull --ff-only + package-manager install + build
 *  - npm:        pnpm add <name>@<candidate> --save-exact (the same shape
 *                `dsh plugin` and the built-in Plugins page write, so the
 *                profile keeps exact pins), with the pnpm 11
 *                minimumReleaseAge gate overridden, under the profile lock
 *  - pnpm-git:   re-add the original git spec so pnpm re-resolves the ref
 *  - installation-owned / local-only: refused with a structured error code
 *
 * All spawns are child_process.spawn with bounded output, a hard timeout, and
 * Windows shell:true routing (pnpm/corepack/npx are .cmd shims there).
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fetchLatestCommit,
  readGitInfo,
  readPackageVersion,
  resolveInstalledDir,
} from './inventory.ts'
import { ProfileLockError, withProfileLock } from './lock.ts'

export { NPM_REGISTRY } from './registry.ts'

// ---------------------------------------------------------------------------
// Async command runner
// ---------------------------------------------------------------------------

/** Structured failure codes the browser half translates. */
export type UpdateErrorCode =
  | 'unsupported'
  | 'git-dirty'
  | 'git-failed'
  | 'git-conflict'
  | 'manager-missing'
  | 'manager-failed'
  | 'build-failed'
  | 'build-blocked'
  | 'timeout'
  | 'pnpm-missing'
  | 'pnpm-failed'
  | 'profile-locked'
  | 'busy'
  | 'stale'
  | 'verify-failed'
  | 'not-found'

export interface UpdateRunResult {
  ok: boolean
  /** Process exit code (null when it never started or was killed). */
  exitCode: number | null
  /** Captured output tail (diagnostics for the panel). */
  output: string
  /** Structured failure code, translated by the browser half. */
  errorCode?: UpdateErrorCode
  /** Human-readable fallback description. */
  error?: string
}

/** Hard cap on captured output. */
const OUTPUT_CAP = 16 * 1024

/** Hard cap on an update run (git + install + build can be slow). */
const DEFAULT_TIMEOUT_MS = 15 * 60_000

/** Cap an output string to its tail so error payloads stay bounded. */
export function capOutput(value: string): string {
  return value.length > OUTPUT_CAP ? value.slice(value.length - OUTPUT_CAP) : value
}

/** Options accepted by runCommand. */
export interface RunCommandOptions {
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** Outcome of one spawned command. */
export interface CommandOutcome {
  code: number | null
  output: string
  /** False when the process never started (ENOENT, EACCES...). */
  started: boolean
  /** True when the hard timeout killed a running process. */
  timedOut: boolean
}

/**
 * Run one command to completion and collect bounded stdout+stderr.
 * @returns exit code, captured output, whether the process ever started, and
 *   whether the timeout killed it.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let output = ''
    let settled = false
    let timedOut = false
    const finish = (code: number | null, started: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output: capOutput(output), started, timedOut })
    }
    const spawnOptions: Record<string, unknown> = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { shell: true } : {}),
    }
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      if (process.platform === 'win32') {
        const pid = (child as { pid?: number } | undefined)?.pid
        if (pid !== undefined && pid > 0) {
          try {
            spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
          } catch {
            // Best-effort kill; fall through to the timeout result.
          }
        }
      } else {
        child?.kill('SIGTERM')
      }
      finish(null, true)
    }, timeoutMs)
    const child = spawn(command, args, spawnOptions)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => {
      finish(null, false)
    })
    child.on('close', (code: number | null) => {
      finish(code, true)
    })
  })
}

/** Windows cmd command-not-found stderr. */
const WIN_CMD_MISSING_RE = /not recognized as an internal or external command/i

/** pnpm ≥10 refusing a dependency's lifecycle script until it is allow-listed. */
const BUILD_BLOCKED_RE = /allowBuilds|approve-builds|Ignored build scripts|ERR_PNPM_IGNORED_BUILDS|ERR_PNPM_GIT_PREPARE/i

/** Whether pnpm output says a build script was blocked by the allowBuilds policy. */
export function detectBuildBlocked(output: string): boolean {
  return BUILD_BLOCKED_RE.test(output)
}

/**
 * Run a command with an ordered fallback chain for package managers. Each
 * candidate is tried only when the previous one is missing on PATH (ENOENT,
 * or Windows' exit-1 "not recognized" stderr). A timeout ends the chain at
 * once — re-running the same slow command through the next manager would only
 * multiply the wait. Output accumulates across candidates.
 */
export async function runWithManagerFallback(
  candidates: ReadonlyArray<{ command: string; args: string[] }>,
  options: RunCommandOptions,
): Promise<UpdateRunResult> {
  let output = ''
  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, options)
    output += result.output
    if (result.timedOut) {
      return {
        ok: false,
        exitCode: null,
        output: capOutput(output),
        error: candidate.command + ' timed out after ' + String(Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)) + 's',
        errorCode: 'timeout',
      }
    }
    if (!result.started) {
      // Missing command on POSIX or a non-spawnable child; try the next one.
      continue
    }
    if (process.platform === 'win32' && result.code !== 0 && WIN_CMD_MISSING_RE.test(result.output)) {
      // Missing .cmd shim on Windows; try the next candidate.
      continue
    }
    if (result.code === 0) {
      return { ok: true, exitCode: 0, output: capOutput(output) }
    }
    return {
      ok: false,
      exitCode: result.code,
      output: capOutput(output),
      error: candidate.command + ' exited with code ' + String(result.code),
      errorCode: detectBuildBlocked(result.output) ? 'build-blocked' : 'manager-failed',
    }
  }
  return {
    ok: false,
    exitCode: null,
    output: capOutput(output),
    error: 'no package manager found on PATH (tried ' + candidates.map(candidate => candidate.command).join(', ') + ')',
    errorCode: 'pnpm-missing',
  }
}

// ---------------------------------------------------------------------------
// Update target + executors
// ---------------------------------------------------------------------------

/** One resolved update target the run endpoint accepts. */
export interface UpdateTarget {
  profile: string
  profileDir: string
  name: string
  kind: 'npm' | 'git-clone' | 'pnpm-git'
  spec: string
  dir?: string
  gitRoot?: string
  /**
   * For `npm`: the exact version to install (the admitted candidate the
   * status probe selected). Absent when the probe could not reach the
   * registry; the executor then falls back to `pnpm update --latest`.
   */
  version?: string
  /**
   * How a dirty git-clone work tree is handled. `false` (the default)
   * refuses the update; `true` runs `git pull --ff-only --autostash` so
   * local edits are stashed before the pull and re-applied afterwards.
   */
  autostash?: boolean
}

/** Progress callback: the step an executor moved to (`pulling`, `installing`, `building`, `waiting-lock`). */
export type StepReporter = (step: string) => void

const noStep: StepReporter = () => {}

/** The pnpm 11 supply-chain gate override: a user-initiated update must not be silently skipped. */
const MIN_RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/** pnpm fallback chain shared by npm and pnpm-git executors. */
function pnpmCandidates(args: string[]): ReadonlyArray<{ command: string; args: string[] }> {
  return [
    { command: 'pnpm', args: [...args] },
    { command: 'corepack', args: ['pnpm', ...args] },
    { command: 'npx', args: ['--yes', 'pnpm', ...args] },
  ]
}

/**
 * Characters that must never reach a package-manager argument. On Windows the
 * .cmd shims force `shell: true`, where these would be interpreted by cmd.exe;
 * valid npm names, semver versions, and git specs never contain them.
 */
const UNSAFE_ARGUMENT_RE = /[\s"'`&|<>^$;(){}\\]|^-/

/** Whether a value is safe to pass to pnpm/git as one argument. */
export function isSafeArgument(value: string): boolean {
  return value !== '' && !UNSAFE_ARGUMENT_RE.test(value)
}

/** Read a package.json as an object, or undefined on any failure. */
export function readManifestObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Whether a package manifest declares a dsh bundle patch. */
export function declaresBundle(pkg: Record<string, unknown> | undefined): boolean {
  if (pkg === undefined) return false
  return typeof pkg.dsh === 'object' && pkg.dsh !== null
    && (pkg.dsh as { bundle?: { patch?: unknown } }).bundle?.patch !== undefined
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state after an
 * update: a dependency that resolves to a `dsh.bundle` package joins the
 * layer stack; one that no longer resolves (or lost its bundle declaration)
 * leaves it. Mirrors `dsh plugin`'s reconcile step so the profile stays
 * consistent even when the updater is invoked directly.
 */
export async function reconcileProfileBundles(profileDir: string): Promise<void> {
  try {
    const manifestPath = join(profileDir, 'package.json')
    const manifest = readManifestObject(manifestPath)
    if (manifest === undefined) return
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
    const plugins: string[] = Array.isArray((manifest.dsh as { profile?: { bundles?: string[] } } | undefined)?.profile?.bundles)
      ? ((manifest.dsh as { profile?: { bundles?: string[] } }).profile?.bundles ?? [])
      : []
    const next: string[] = [...plugins]
    let changed = false
    for (const name of Object.keys(dependencies)) {
      if (next.includes(name)) continue
      const dir = resolveInstalledDir(profileDir, name)
      if (dir !== undefined && declaresBundle(readManifestObject(join(dir, 'package.json')))) {
        next.push(name)
        changed = true
      }
    }
    const dependencySet = new Set(Object.keys(dependencies))
    for (const name of [...next]) {
      // Only out-of-tree dependencies are reconciled: in-box bundles
      // (dsh-base, dsh-web-app...) resolve from the installation and stay.
      if (!dependencySet.has(name)) continue
      const dir = resolveInstalledDir(profileDir, name)
      const stillBundle = declaresBundle(dir === undefined ? undefined : readManifestObject(join(dir, 'package.json')))
      if (!stillBundle) {
        next.splice(next.indexOf(name), 1)
        changed = true
      }
    }
    if (!changed) return
    manifest.dsh = {
      ...(manifest.dsh as object ?? {}),
      profile: {
        ...((manifest.dsh as { profile?: object } | undefined)?.profile ?? {}),
        bundles: next,
      },
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch {
    // Reconciliation is best-effort: the next dsh boot validates the profile.
  }
}

/**
 * Update a git-clone: refuse dirty trees by default, or — when the target
 * asks for it — stash local edits with `git pull --ff-only --autostash`.
 * Then install and build at the git root. One git root is updated once even
 * when several packages point into the same clone (the run endpoint dedupes).
 */
export async function updateGitClone(target: UpdateTarget, onStep: StepReporter = noStep): Promise<UpdateRunResult> {
  const root = target.gitRoot ?? target.dir
  if (root === undefined) return notFoundResult('git root missing')
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

  // Dirty check: never overwrite local edits with an update. Only the
  // explicit per-row stash action may bypass this via --autostash.
  const dirtyProbe = await runCommand('git', ['-C', root, 'status', '--porcelain'], { cwd: root, env: gitEnv })
  if (!dirtyProbe.started || dirtyProbe.code !== 0) {
    return { ok: false, exitCode: dirtyProbe.code, output: dirtyProbe.output, error: 'git status failed', errorCode: 'git-failed' }
  }
  const isDirty = dirtyProbe.output.trim() !== ''

  let pull: CommandOutcome
  onStep('pulling')
  if (isDirty && target.autostash === true) {
    pull = await runCommand('git', ['-C', root, 'pull', '--ff-only', '--autostash'], { cwd: root, env: gitEnv })
    if (pull.timedOut) return timeoutResult('git pull', pull.output)
    if (pull.code !== 0) {
      return { ok: false, exitCode: pull.code, output: pull.output, error: 'git pull --ff-only --autostash failed', errorCode: 'git-failed' }
    }
    // `git pull --autostash` exits 0 even when re-applying the stash hit a
    // conflict; the tree is left conflicted and the stash is kept. Never
    // install/build over that state.
    const unmerged = await runCommand('git', ['-C', root, 'diff', '--name-only', '--diff-filter=U'], { cwd: root, env: gitEnv })
    if (unmerged.code !== 0) {
      return { ok: false, exitCode: unmerged.code, output: capOutput(pull.output + '\n' + unmerged.output), error: 'git autostash conflict probe failed', errorCode: 'git-failed' }
    }
    if (unmerged.output.trim() !== '') {
      return {
        ok: false,
        exitCode: null,
        output: capOutput(pull.output + '\n' + unmerged.output),
        error: 'stashed local changes conflict with the update; git kept the stash, resolve the conflicts and run git stash pop when ready',
        errorCode: 'git-conflict',
      }
    }
  } else if (isDirty) {
    return { ok: false, exitCode: null, output: dirtyProbe.output, error: 'git work tree has uncommitted changes; commit or stash them first', errorCode: 'git-dirty' }
  } else {
    pull = await runCommand('git', ['-C', root, 'pull', '--ff-only'], { cwd: root, env: gitEnv })
    if (pull.timedOut) return timeoutResult('git pull', pull.output)
    if (pull.code !== 0) {
      return { ok: false, exitCode: pull.code, output: pull.output, error: 'git pull --ff-only failed', errorCode: 'git-failed' }
    }
  }

  const rootManifest = readManifestObject(join(root, 'package.json'))
  const hasBuild = typeof (rootManifest?.scripts as { build?: string } | undefined)?.build === 'string'

  let install: UpdateRunResult
  onStep('installing')
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    install = await runWithManagerFallback(pnpmCandidates(['install']), { cwd: root })
  } else if (existsSync(join(root, 'yarn.lock'))) {
    install = await runWithManagerFallback([{ command: 'yarn', args: ['install'] }], { cwd: root })
  } else {
    install = await runWithManagerFallback([{ command: 'npm', args: ['install'] }], { cwd: root })
  }
  if (!install.ok) return { ...install, output: capOutput(pull.output + '\n' + install.output) }

  if (!hasBuild) {
    return { ok: true, exitCode: 0, output: capOutput(pull.output + '\n' + install.output + '\n(no build script; install complete)') }
  }
  const buildCommand = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm'
  onStep('building')
  const build = await runCommand(buildCommand, ['run', 'build'], { cwd: root })
  if (build.timedOut) return timeoutResult(buildCommand + ' run build', pull.output + '\n' + install.output + '\n' + build.output)
  if (build.code !== 0) {
    return { ok: false, exitCode: build.code, output: capOutput(pull.output + '\n' + install.output + '\n' + build.output), error: buildCommand + ' run build failed', errorCode: 'build-failed' }
  }
  return { ok: true, exitCode: 0, output: capOutput(pull.output + '\n' + install.output + '\n' + build.output) }
}

/** Run one pnpm operation inside the profile under the shared profile lock. */
async function runPnpmInProfile(target: UpdateTarget, args: string[], onStep: StepReporter): Promise<UpdateRunResult> {
  try {
    onStep('waiting-lock')
    return await withProfileLock(target.profileDir, async () => {
      onStep('installing')
      const result = await runWithManagerFallback(pnpmCandidates(args), { cwd: target.profileDir })
      if (result.ok) await reconcileProfileBundles(target.profileDir)
      return result
    })
  } catch (error) {
    if (error instanceof ProfileLockError) {
      return { ok: false, exitCode: null, output: '', error: error.message, errorCode: 'profile-locked' }
    }
    throw error
  }
}

/**
 * Update an npm dependency inside the owning profile. With a selected
 * candidate: `pnpm add <name>@<version> --save-exact` — the exact-pin shape
 * `dsh plugin add` and the built-in Plugins page write. Without one (registry
 * unreachable during the probe): `pnpm update --latest` with save-exact
 * configured, because dsh writes exact specs that plain `pnpm update` treats
 * as pinned. Both override the pnpm 11 minimumReleaseAge gate.
 */
export async function updateNpmPackage(target: UpdateTarget, onStep: StepReporter = noStep): Promise<UpdateRunResult> {
  if (!isSafeArgument(target.name) || (target.version !== undefined && !isSafeArgument(target.version))) {
    return { ok: false, exitCode: null, output: '', error: 'package name or version contains unsafe characters', errorCode: 'unsupported' }
  }
  const args = target.version === undefined
    ? ['update', '--latest', '--config.save-exact=true', MIN_RELEASE_AGE_OVERRIDE, target.name]
    : ['add', `${target.name}@${target.version}`, '--save-exact', MIN_RELEASE_AGE_OVERRIDE]
  return runPnpmInProfile(target, args, onStep)
}

/**
 * Update a pnpm-git dependency: re-run `pnpm add <original spec>` so pnpm
 * re-resolves the git ref and rebuilds it. Fixed-commit specs are still
 * re-resolved (no-op when the commit did not change).
 */
export async function updatePnpmGitPackage(target: UpdateTarget, onStep: StepReporter = noStep): Promise<UpdateRunResult> {
  if (!isSafeArgument(target.spec)) {
    return { ok: false, exitCode: null, output: '', error: 'dependency spec contains unsafe characters', errorCode: 'unsupported' }
  }
  return runPnpmInProfile(target, ['add', target.spec, MIN_RELEASE_AGE_OVERRIDE], onStep)
}

/** Dispatch one update target to its executor. */
export async function runTargetUpdate(target: UpdateTarget, onStep: StepReporter = noStep): Promise<UpdateRunResult> {
  switch (target.kind) {
    case 'git-clone': return updateGitClone(target, onStep)
    case 'npm': return updateNpmPackage(target, onStep)
    case 'pnpm-git': return updatePnpmGitPackage(target, onStep)
    default: return {
      ok: false,
      exitCode: null,
      output: '',
      error: `kind ${String((target as { kind: unknown }).kind)} cannot be updated from the panel`,
      errorCode: 'unsupported',
    }
  }
}

/**
 * Verify that an npm update landed. With a known target version the
 * installed manifest must now carry exactly that version; otherwise any
 * movement (or a first-time resolution) counts, and an unchanged version is
 * reported as a no-op rather than a failure.
 */
export function verifyNpmUpdate(
  profileDir: string,
  name: string,
  before: string | undefined,
  expected: string | undefined,
): UpdateRunResult {
  const dir = resolveInstalledDir(profileDir, name)
  const after = dir === undefined ? undefined : readPackageVersion(dir)
  if (expected !== undefined) {
    if (after === expected) return { ok: true, exitCode: 0, output: `${name}@${after}` }
    return {
      ok: false,
      exitCode: 0,
      output: '',
      error: `pnpm exited 0 but ${name} is ${after ?? 'unresolvable'} instead of ${expected} (minimumReleaseAge gate or registry mismatch?)`,
      errorCode: 'stale',
    }
  }
  if (after === undefined) {
    return {
      ok: false,
      exitCode: 0,
      output: '',
      error: 'update finished but the installed package is not resolvable',
      errorCode: 'verify-failed',
    }
  }
  if (before !== undefined && after === before) {
    return { ok: true, exitCode: 0, output: `(version unchanged: ${name}@${after})` }
  }
  return { ok: true, exitCode: 0, output: `${name}@${after}` }
}

/** Shared not-found result. */
function notFoundResult(detail: string): UpdateRunResult {
  return { ok: false, exitCode: null, output: '', error: detail, errorCode: 'not-found' }
}

/** Shared timeout result. */
function timeoutResult(what: string, output: string): UpdateRunResult {
  return { ok: false, exitCode: null, output: capOutput(output), error: what + ' timed out', errorCode: 'timeout' }
}

/** Read the latest git commit for an update target (network probe). */
export async function latestGitCommit(target: UpdateTarget, remoteOverride?: string, refOverride?: string): Promise<string | undefined> {
  if (remoteOverride !== undefined) {
    return fetchLatestCommit(remoteOverride, refOverride)
  }
  const root = target.gitRoot ?? target.dir
  if (root === undefined) return undefined
  const info = readGitInfo(root)
  if (info?.remote === undefined || info.branch === undefined) return undefined
  return fetchLatestCommit(info.remote, info.branch)
}

/** Read one repository root package.json build-script fact for tests. */
export async function readRootBuildScript(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return typeof parsed.scripts?.build === 'string'
  } catch {
    return false
  }
}
