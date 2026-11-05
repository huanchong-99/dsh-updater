/**
 * dsh-updater host inventory: scan every dsh profile's dependencies,
 * classify each one into an update source kind, and read its current
 * version plus (where possible) the newest version available.
 *
 * The module is self-contained: it reads the filesystem and runs git
 * probes directly. It does not import anything from third-party plugin
 * packages — only Node builtins and the official DSH type surface.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where an installed plugin comes from and therefore how it updates. */
export type SourceKind =
  /** Owned by the DSH installation itself; updates with the harness. */
  | 'installation-owned'
  /** Plain npm registry dependency (bare name, semver range, tag...). */
  | 'npm'
  /** A local directory install whose directory is inside a git clone. */
  | 'git-clone'
  /** pnpm git-hosted dependency (`github:`, `git+...`, `.git#...`). */
  | 'pnpm-git'
  /** A local directory install with no git metadata; manual only. */
  | 'local-only'

/** Git facts for one git-clone / pnpm-git source. */
export interface GitInfo {
  /** Absolute git work-tree root (when resolvable). */
  root?: string
  /** `origin` remote URL, when configured. */
  remote?: string
  /** Current branch, when not detached. */
  branch?: string
  /** Short current commit, when resolvable. */
  commit?: string
  /** Whether the work tree has uncommitted changes. */
  dirty?: boolean
}

/** One scanned plugin row shown in the update panel. */
export interface PluginRecord {
  /** Profile name the dependency belongs to (e.g. `web`). */
  profile: string
  /** Package name from the dependency map. */
  name: string
  /** The raw dependency spec in profile package.json. */
  spec: string
  /** Classified source kind. */
  kind: SourceKind
  /** Local version string (package.json version or short commit). */
  current?: string
  /** Latest version string available from the source (and admitted by the running DSH). */
  latest?: string
  /** True when `latest` is strictly newer than `current`. */
  outdated: boolean
  /**
   * Newest npm version that exists but is NOT admitted by the running DSH
   * (its `engines.dsh` / peers reject it). Informational: the panel never
   * installs it because the launcher would refuse it at boot.
   */
  incompatibleLatest?: string
  /** Absolute package directory when resolved. */
  dir?: string
  /** Git facts for git-clone / pnpm-git rows. */
  git?: GitInfo
  /** Human-readable per-row failure (probe failed, not found...). */
  error?: string
  /**
   * Set on rows of the running profile that DSH's own plugin manager
   * installed and updates (registry bundles it marks updatable, and official
   * on-demand bundles); their updates run through the manager.
   */
  managedBy?: 'plugin-manager'
  /** How the manager updates the row: a registry version, or the running DSH's catalog copy. */
  officialKind?: 'registry' | 'catalog'
}

/** The plugin manager facts served with the scan, when the running profile has one. */
export interface PluginManagerSummary {
  /** Scanned profile name the manager owns (the profile this DSH process runs). */
  profile: string
  /** Rows the manager updates. */
  managed: number
  /** Of those, rows with an update according to the scan. */
  outdated: number
}

/** Full scan result served to the browser half. */
export interface UpdaterStatus {
  profiles: string[]
  records: PluginRecord[]
  checkedAt: string
  /** Running DSH version resolved from the installation, when known. */
  dshVersion?: string
  /** Whether an update job is in flight on the host right now. */
  busy: boolean
  /** Present when DSH's plugin manager runs in this profile. */
  pluginManager?: PluginManagerSummary
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** DSH home: explicit env wins, then the platform default. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Directory holding all dsh profiles. */
export function profilesRoot(home: string = dshHome()): string {
  return join(home, 'profiles')
}

/** Whether a dependency spec is a local filesystem install. */
export function isLocalSpec(spec: string): boolean {
  return /^(?:link|file):|^\.{1,2}(?:[/\\]|$)/.test(spec)
}

/** Whether a dependency spec is a pnpm git-hosted dependency. */
export function isGitSpec(spec: string): boolean {
  return /^(?:github:|gitlab:|bitbucket:|git\+|git:|git\+ssh:|git\+https?:)|\.git(?:#|$)/.test(spec)
}

/**
 * Parse a local spec into an absolute path.
 * @param spec - `link:...`, `file:...`, or a relative path.
 * @param baseDir - the directory pnpm ran in (the profile dir).
 */
export function localSpecPath(spec: string, baseDir: string): string {
  const raw = spec.replace(/^(?:link|file):/, '')
  return isAbsolute(raw) ? raw : resolve(baseDir, raw)
}

/**
 * Parse semantic versions (leading `v` tolerated, build metadata ignored).
 * Returns undefined for unparseable input.
 */
export function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two semantic versions per semver precedence rules. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (pa === undefined && pb === undefined) return 0
  if (pa === undefined) return -1
  if (pb === undefined) return 1
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(pa.prerelease.length, pb.prerelease.length); index++) {
    const ra = pa.prerelease[index]
    const rb = pb.prerelease[index]
    if (ra === undefined) return -1
    if (rb === undefined) return 1
    if (ra === rb) continue
    const numericA = /^\d+$/.test(ra)
    const numericB = /^\d+$/.test(rb)
    if (numericA && numericB) return Number(ra) < Number(rb) ? -1 : 1
    if (numericA) return -1
    if (numericB) return 1
    return ra < rb ? -1 : 1
  }
  return 0
}

/** Read and parse a package.json, tolerating any failure. */
export function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Run a quick synchronous local command and return trimmed stdout (empty on failure). */
function runSyncTrimmed(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

/** Find the nearest git work-tree root above a directory, when any. */
export function findGitRoot(start: string): string | undefined {
  const root = runSyncTrimmed('git', ['-C', start, 'rev-parse', '--show-toplevel'], start)
  return root === '' ? undefined : root
}

/** Read git facts for a directory. */
export function readGitInfo(dir: string): GitInfo | undefined {
  const root = findGitRoot(dir)
  if (root === undefined) return undefined
  const remote = runSyncTrimmed('git', ['-C', root, 'remote', 'get-url', 'origin'], root) || undefined
  const branch = runSyncTrimmed('git', ['-C', root, 'branch', '--show-current'], root) || undefined
  const commit = runSyncTrimmed('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], root) || undefined
  const status = runSyncTrimmed('git', ['-C', root, 'status', '--porcelain'], root)
  return { root, remote, branch, commit, dirty: status !== '' }
}

/**
 * Run one git command without blocking the event loop (the network probes
 * fan out across every git-backed row). Resolves to trimmed stdout, or
 * undefined on a non-zero exit, a spawn failure, or the timeout.
 */
function runGitAsync(args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let settled = false
    const finish = (value: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      // Never block on a credential prompt from inside the host process.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(undefined)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.on('error', () => { finish(undefined) })
    child.on('close', (code) => { finish(code === 0 ? stdout.trim() : undefined) })
  })
}

/**
 * Probe the latest commit of a remote git ref (branch, tag, or HEAD; a full
 * commit hash is not probed because a pinned commit is fixed by definition).
 * Returns the short hash, or undefined on any failure.
 */
export async function fetchLatestCommit(remote: string, ref?: string, timeoutMs = 15_000): Promise<string | undefined> {
  if (remote === '') return undefined
  if (ref === undefined || ref === '') return fetchLatestCommit(remote, 'HEAD', timeoutMs)
  if (/^[0-9a-fA-F]{40}$/.test(ref)) return undefined
  const patterns = ref === 'HEAD'
    ? ['HEAD']
    : [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]
  const output = await runGitAsync(['ls-remote', remote, ...patterns], timeoutMs)
  if (output === undefined) return undefined
  const first = output.split(/\s+/)[0]
  return first === undefined || first === '' ? undefined : first.slice(0, 7)
}

/** Parsed git spec for `github:`, `git+...`, and scp-like remotes. */
export interface GitSpecRef {
  remote: string
  ref?: string
}

/**
 * Parse a pnpm git-hosted dependency spec into a remote URL + ref. Supports
 * `github:owner/repo#ref`, `git+https://...git#ref`, scp-like URLs, and the
 * `&path:/sub/dir` suffix the DSH plugin market appends for monorepos.
 */
export function parseGitSpec(spec: string): GitSpecRef | undefined {
  const hashIndex = spec.indexOf('#')
  const base = hashIndex >= 0 ? spec.slice(0, hashIndex) : spec
  const fragment = hashIndex >= 0 ? spec.slice(hashIndex + 1) : ''
  // `#<ref>&path:/dir` → ref only; a bare `#path:/dir` carries no ref.
  const refPart = fragment.split('&').find(part => part !== '' && !part.startsWith('path:'))
  const ref = refPart === undefined ? undefined : refPart.replace(/^(?:semver|tag|branch|commit):/, '') || undefined
  let remote: string | undefined
  const hostedMatch = /^(github|gitlab|bitbucket):([^/]+\/[A-Za-z0-9_.-]+)/.exec(base)
  if (hostedMatch !== null) {
    remote = `https://${hostedMatch[1]}.com/${hostedMatch[2].replace(/\.git$/, '')}.git`
  } else {
    const urlMatch = /^(?:git\+|git:)?(https?:\/\/\S+|ssh:\/\/\S+|git@\S+)$/.exec(base)
    if (urlMatch !== null) remote = urlMatch[1]
  }
  return remote === undefined ? undefined : { remote, ref }
}

/**
 * Read the full 40-hex commit pnpm resolved for one git-hosted dependency,
 * from the profile lockfile. Covers the GitHub tarball form
 * (`.../tar.gz/<sha>`) and the generic `git+<url>#<sha>` form pnpm writes
 * for other hosts.
 */
export function readPnpmGitResolution(profileDir: string, name: string): string | undefined {
  try {
    const lock = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`${escaped}@(?:git\\+)?[^\\s'"]*?(?:/tar\\.gz/|#)([0-9a-f]{40})`)
    const match = re.exec(lock)
    return match?.[1]
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Installed package.json path for a dependency, or undefined. */
export function resolveInstalledManifest(profileDir: string, name: string): string | undefined {
  const anchor = join(profileDir, 'package.json')
  try {
    const req = createRequire(anchor)
    return req.resolve(name + '/package.json')
  } catch {
    return undefined
  }
}

/** Absolute directory of an installed package, or undefined. */
export function resolveInstalledDir(profileDir: string, name: string): string | undefined {
  const manifest = resolveInstalledManifest(profileDir, name)
  return manifest === undefined ? undefined : dirname(manifest)
}

/** Installed version string from a package directory. */
export function readPackageVersion(dir: string): string | undefined {
  const version = readManifest(join(dir, 'package.json'))?.version
  return typeof version === 'string' ? version : undefined
}

/**
 * The running DSH version: the in-box `@deepseek-ai/dsh-base` bundle resolves
 * from the installation for every profile (all official packages ship in
 * lockstep), else the `@deepseek-ai/dsh` package above the running launcher
 * script. Used for the `engines.dsh` admission filter and shown in the panel.
 */
export function readDshRuntimeVersion(profileDirs: readonly string[], entryScript: string | undefined = process.argv[1]): string | undefined {
  for (const dir of profileDirs) {
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh']) {
      const installed = resolveInstalledDir(dir, name)
      const version = installed === undefined ? undefined : readPackageVersion(installed)
      if (version !== undefined) return version
    }
  }
  if (entryScript === undefined) return undefined
  let current = dirname(resolve(entryScript))
  for (let depth = 0; depth < 8; depth++) {
    const manifest = readManifest(join(current, 'package.json'))
    if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Profiles to scan: every `dsh-profile-*` directory under ~/.dsh/profiles. */
export function listProfileDirs(home: string = dshHome()): Array<{ name: string; dir: string }> {
  const root = profilesRoot(home)
  if (!existsSync(root)) return []
  const result: Array<{ name: string; dir: string }> = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    const manifest = readManifest(join(dir, 'package.json'))
    const name = manifest?.name
    if (typeof name !== 'string' || !name.startsWith('dsh-profile-')) continue
    result.push({ name: name.slice('dsh-profile-'.length), dir })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Classify one dependency and read its local state. Does not probe the
 * network; `latest` is filled later by the status route.
 */
export function inspectDependency(profile: string, profileDir: string, name: string, spec: string): PluginRecord {
  const base: PluginRecord = { profile, name, spec, kind: 'local-only', outdated: false }

  // Local filesystem installs are git-clone candidates.
  if (isLocalSpec(spec)) {
    const target = localSpecPath(spec, profileDir)
    if (!existsSync(target)) {
      return { ...base, error: `path not found: ${target}` }
    }
    const git = readGitInfo(target)
    if (git === undefined) {
      return {
        ...base,
        kind: 'local-only',
        dir: target,
        current: readPackageVersion(target),
        error: 'local directory has no git metadata; manual update only',
      }
    }
    return {
      ...base,
      kind: 'git-clone',
      dir: target,
      current: git.commit ?? readPackageVersion(target),
      git,
    }
  }

  // Git-hosted specs: pnpm manages the checkout under .pnpm.
  if (isGitSpec(spec)) {
    const dir = resolveInstalledDir(profileDir, name)
    if (dir === undefined) {
      return { ...base, kind: 'pnpm-git', error: 'installed checkout not resolvable' }
    }
    const installedGit = readGitInfo(dir)
    const specGit = parseGitSpec(spec)
    const resolvedCommit = readPnpmGitResolution(profileDir, name)
    const current = installedGit?.commit ?? (resolvedCommit === undefined ? readPackageVersion(dir) : resolvedCommit.slice(0, 7))
    return {
      ...base,
      kind: 'pnpm-git',
      dir,
      current,
      git: installedGit ?? (specGit === undefined ? undefined : { remote: specGit.remote, branch: specGit.ref }),
    }
  }

  // Plain npm dependency.
  const dir = resolveInstalledDir(profileDir, name)
  if (dir === undefined) {
    return { ...base, kind: 'npm', error: 'installed package not resolvable' }
  }
  const outsideProfile = !dir.startsWith(profileDir)
  const installationOwned = outsideProfile && name.startsWith('@deepseek-ai/')
  return {
    ...base,
    kind: installationOwned ? 'installation-owned' : 'npm',
    dir,
    current: readPackageVersion(dir),
  }
}

/** Scan all profiles and classify every dependency plus every profile bundle. */
export function scanProfiles(home: string = dshHome()): UpdaterStatus {
  const records: PluginRecord[] = []
  const profiles: string[] = []
  const profileDirs = listProfileDirs(home)
  for (const { name, dir } of profileDirs) {
    profiles.push(name)
    const manifest = readManifest(join(dir, 'package.json'))
    const dependencies = manifest?.dependencies
    const dependencyNames = new Set<string>()
    if (typeof dependencies === 'object' && dependencies !== null) {
      for (const [packageName, specRaw] of Object.entries(dependencies)) {
        if (typeof specRaw !== 'string') continue
        dependencyNames.add(packageName)
        records.push(inspectDependency(name, dir, packageName, specRaw))
      }
    }
    // Profile bundle entries that are not plain dependencies are still
    // installed plugins (the installation-owned bundles dsh-base and
    // dsh-web-app, for example). Include them so the panel shows the real
    // plugin count and their versions.
    const bundleSection = manifest?.dsh
    const bundles = typeof bundleSection === 'object' && bundleSection !== null
      ? (bundleSection as { profile?: { bundles?: unknown } }).profile?.bundles
      : undefined
    if (Array.isArray(bundles)) {
      for (const bundle of bundles) {
        if (typeof bundle !== 'string' || dependencyNames.has(bundle)) continue
        records.push(inspectProfileBundle(name, dir, bundle))
      }
    }
  }
  return {
    profiles,
    records,
    checkedAt: new Date().toISOString(),
    dshVersion: readDshRuntimeVersion(profileDirs.map(entry => entry.dir)),
    busy: false,
  }
}

/** Classify a profile bundle that has no matching dependency entry. */
export function inspectProfileBundle(profile: string, profileDir: string, name: string): PluginRecord {
  const base: PluginRecord = { profile, name, spec: '(profile bundle)', kind: 'installation-owned', outdated: false }
  const dir = resolveInstalledDir(profileDir, name)
  if (dir === undefined) {
    return { ...base, error: 'profile bundle not resolvable' }
  }
  return {
    ...base,
    kind: 'installation-owned',
    dir,
    current: readPackageVersion(dir),
  }
}
