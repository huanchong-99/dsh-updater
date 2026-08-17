/**
 * dsh-updater update executors. Each source kind has exactly one executor:
 *  - git-clone:  git pull --ff-only + package-manager install + build
 *  - npm:        pnpm update --latest (with the pnpm 11 minimumReleaseAge
 *                gate overridden) + post-run version-movement verification
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
  compareVersions,
  fetchLatestCommit,
  readGitInfo,
  readPackageVersion,
  resolveInstalledDir,
} from './inventory.ts'

// ---------------------------------------------------------------------------
// Async command runner
// ---------------------------------------------------------------------------

/** npm registry base used for version probes. */
export const NPM_REGISTRY = 'https://registry.npmjs.org'

/** Structured failure codes the browser half translates. */
export type UpdateErrorCode =
  | 'unsupported'
  | 'git-dirty'
  | 'git-failed'
  | 'git-conflict'
  | 'manager-missing'
  | 'manager-failed'
  | 'build-failed'
  | 'timeout'
  | 'pnpm-missing'
  | 'pnpm-failed'
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

/**
 * Run one command to completion and collect bounded stdout+stderr.
 * @returns exit code, captured output, and whether the process ever started.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<{ code: number | null; output: string; started: boolean }> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let output = ''
    let settled = false
    const finish = (code: number | null, started: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, output: capOutput(output), started })
    }
    const spawnOptions: Record<string, unknown> = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { shell: true } : {}),
    }
    const timer = setTimeout(() => {
      if (settled) return
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
      finish(null, false)
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

/**
 * Run a command with an ordered fallback chain for package managers. Each
 * candidate is tried only when the previous one is missing on PATH (ENOENT,
 * or Windows' exit-1 "not recognized" stderr). Output accumulates across
 * candidates; one hard timeout covers the whole chain.
 */
export async function runWithManagerFallback(
  candidates: ReadonlyArray<{ command: string; args: string[] }>,
  options: RunCommandOptions,
): Promise<UpdateRunResult> {
  let output = ''
  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, candidate.args, options)
    output += result.output
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
      errorCode: 'manager-failed',
    }
  }
  return {
    ok: false,
    exitCode: null,
    output: capOutput(output),
    error: 'no package manager found on PATH (tried pnpm, corepack, npx)',
    errorCode: 'pnpm-missing',
  }
}

// ---------------------------------------------------------------------------
// npm registry probe
// ---------------------------------------------------------------------------

/** Fetch the latest npm version for one package; undefined on any failure. */
export async function fetchLatestVersion(
  name: string,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const response = await fetchImpl(NPM_REGISTRY + '/' + name.replace('/', '%2F') + '/latest')
      if (!response.ok) return undefined
      const body = await response.json()
      if (typeof body !== 'object' || body === null) return undefined
      const version = (body as Record<string, unknown>).version
      return typeof version === 'string' ? version : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
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
   * How a dirty git-clone work tree is handled. `false` (the default)
   * refuses the update; `true` runs `git pull --ff-only --autostash` so
   * local edits are stashed before the pull and re-applied afterwards.
   */
  autostash?: boolean
}

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
      const wasDependency = dependencySet.has(name) || plugins.includes(name)
      const dir = resolveInstalledDir(profileDir, name)
      const stillBundle = declaresBundle(dir === undefined ? undefined : readManifestObject(join(dir, 'package.json')))
      if (wasDependency && !stillBundle) {
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
export async function updateGitClone(target: UpdateTarget): Promise<UpdateRunResult> {
  const root = target.gitRoot ?? target.dir
  if (root === undefined) return notFoundResult('git root missing')

  // Dirty check: never overwrite local edits with an update. Only the
  // explicit per-row stash action may bypass this via --autostash.
  const dirtyProbe = await runCommand('git', ['-C', root, 'status', '--porcelain'], { cwd: root })
  if (!dirtyProbe.started || dirtyProbe.code !== 0) {
    return { ok: false, exitCode: dirtyProbe.code, output: dirtyProbe.output, error: 'git status failed', errorCode: 'git-failed' }
  }
  const isDirty = dirtyProbe.output.trim() !== ''

  let pull: { code: number | null; output: string; started: boolean }
  if (isDirty && target.autostash === true) {
    pull = await runCommand('git', ['-C', root, 'pull', '--ff-only', '--autostash'], { cwd: root })
    if (pull.code !== 0) {
      return { ok: false, exitCode: pull.code, output: pull.output, error: 'git pull --ff-only --autostash failed', errorCode: 'git-failed' }
    }
    // `git pull --autostash` exits 0 even when re-applying the stash hit a
    // conflict; the tree is left conflicted and the stash is kept. Never
    // install/build over that state.
    const unmerged = await runCommand('git', ['-C', root, 'diff', '--name-only', '--diff-filter=U'], { cwd: root })
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
    pull = await runCommand('git', ['-C', root, 'pull', '--ff-only'], { cwd: root })
    if (pull.code !== 0) {
      return { ok: false, exitCode: pull.code, output: pull.output, error: 'git pull --ff-only failed', errorCode: 'git-failed' }
    }
  }

  const rootManifest = readManifestObject(join(root, 'package.json'))
  const hasBuild = typeof (rootManifest?.scripts as { build?: string } | undefined)?.build === 'string'

  let install: UpdateRunResult
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    install = await runWithManagerFallback(pnpmCandidates(['install']), { cwd: root })
  } else if (existsSync(join(root, 'yarn.lock'))) {
    install = await runWithManagerFallback([{ command: 'yarn', args: ['install'] }], { cwd: root })
  } else {
    install = await runWithManagerFallback([{ command: 'npm', args: ['install'] }], { cwd: root })
  }
  if (!install.ok) return install

  if (!hasBuild) {
    return { ok: true, exitCode: 0, output: capOutput(install.output + '\n(no build script; install complete)') }
  }
  const buildCommand = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm'
  const build = await runCommand(buildCommand, ['run', 'build'], { cwd: root })
  if (build.code !== 0) {
    return { ok: false, exitCode: build.code, output: capOutput(install.output + '\n' + build.output), error: buildCommand + ' run build failed', errorCode: 'build-failed' }
  }
  return { ok: true, exitCode: 0, output: capOutput(install.output + '\n' + build.output) }
}

/**
 * Update an npm dependency: run `pnpm update --latest` (with the
 * minimumReleaseAge gate overridden) inside the owning profile, falling back
 * through corepack and npx. `--latest` is required because dsh plugin writes
 * exact-version specs, which plain `pnpm update` treats as pinned.
 */
export async function updateNpmPackage(target: UpdateTarget): Promise<UpdateRunResult> {
  const result = await runWithManagerFallback(
    pnpmCandidates(['update', '--latest', MIN_RELEASE_AGE_OVERRIDE, target.name]),
    { cwd: target.profileDir },
  )
  if (!result.ok) return result
  await reconcileProfileBundles(target.profileDir)
  return result
}

/**
 * Update a pnpm-git dependency: re-run `pnpm add <original spec>` so pnpm
 * re-resolves the git ref and rebuilds it. Fixed-commit specs are still
 * re-resolved (no-op when the commit did not change).
 */
export async function updatePnpmGitPackage(target: UpdateTarget): Promise<UpdateRunResult> {
  const result = await runWithManagerFallback(
    pnpmCandidates(['add', target.spec, MIN_RELEASE_AGE_OVERRIDE]),
    { cwd: target.profileDir },
  )
  if (!result.ok) return result
  await reconcileProfileBundles(target.profileDir)
  return result
}

/** Dispatch one update target to its executor. */
export async function runTargetUpdate(target: UpdateTarget): Promise<UpdateRunResult> {
  switch (target.kind) {
    case 'git-clone': return updateGitClone(target)
    case 'npm': return updateNpmPackage(target)
    case 'pnpm-git': return updatePnpmGitPackage(target)
    default: return {
      ok: false,
      exitCode: null,
      output: '',
      error: `kind ${target.kind} cannot be updated from the panel`,
      errorCode: 'unsupported',
    }
  }
}

/** Verify that an npm update actually moved the installed version. */
export async function verifyNpmUpdate(
  profileDir: string,
  name: string,
  before: string | undefined,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>,
): Promise<UpdateRunResult> {
  const dir = resolveInstalledDir(profileDir, name)
  const after = dir === undefined ? undefined : readPackageVersion(dir)
  const moved = before !== undefined && after !== undefined && after !== before
  if (moved) return { ok: true, exitCode: 0, output: '' }
  const latest = await fetchLatestVersion(name, fetchImpl)
  if (latest !== undefined && after !== undefined && compareVersions(latest, after) <= 0) {
    return { ok: true, exitCode: 0, output: '(already up to date)' }
  }
  if (latest !== undefined && after !== undefined && compareVersions(latest, after) > 0) {
    return {
      ok: false,
      exitCode: 0,
      output: '',
      error: 'pnpm exited 0 but the installed version did not change (minimumReleaseAge gate?)',
      errorCode: 'stale',
    }
  }
  return {
    ok: false,
    exitCode: 0,
    output: '',
    error: 'update finished but the post-run version check could not verify the install',
    errorCode: 'verify-failed',
  }
}

/** Shared not-found result. */
function notFoundResult(detail: string): UpdateRunResult {
  return { ok: false, exitCode: null, output: '', error: detail, errorCode: 'not-found' }
}

/** Read the latest git commit for an update target (network probe). */
export function latestGitCommit(target: UpdateTarget, remoteOverride?: string, refOverride?: string): string | undefined {
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
