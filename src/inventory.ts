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
import { spawnSync } from 'node:child_process'

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
  /** Latest version string available from the source. */
  latest?: string
  /** True when `latest` is strictly newer than `current`. */
  outdated: boolean
  /** Absolute package directory when resolved. */
  dir?: string
  /** Git facts for git-clone / pnpm-git rows. */
  git?: GitInfo
  /** Human-readable per-row failure (probe failed, not found...). */
  error?: string
}

/** Full scan result served to the browser half. */
export interface UpdaterStatus {
  profiles: string[]
  records: PluginRecord[]
  checkedAt: string
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
  return /^(?:github:|git\+|git:|git\+ssh:|git\+https?:)|\.git(?:#|$)/.test(spec)
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

/** Run a quick synchronous command and return trimmed stdout (empty on failure). */
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

/** Probe the latest commit of a git remote+branch (short hash, undefined on failure). */
export function fetchLatestCommit(remote: string, branch: string): string | undefined {
  const result = spawnSync('git', ['ls-remote', remote, `refs/heads/${branch}`], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) return undefined
  const first = result.stdout.trim().split(/\s+/)[0]
  return first === undefined || first === '' ? undefined : first.slice(0, 7)
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
    const git = readGitInfo(dir)
    return {
      ...base,
      kind: 'pnpm-git',
      dir,
      current: git?.commit ?? readPackageVersion(dir),
      git,
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

/** Scan all profiles and classify every dependency. */
export function scanProfiles(home: string = dshHome()): UpdaterStatus {
  const records: PluginRecord[] = []
  const profiles: string[] = []
  for (const { name, dir } of listProfileDirs(home)) {
    profiles.push(name)
    const manifest = readManifest(join(dir, 'package.json'))
    const dependencies = manifest?.dependencies
    if (typeof dependencies !== 'object' || dependencies === null) continue
    for (const [packageName, specRaw] of Object.entries(dependencies)) {
      if (typeof specRaw !== 'string') continue
      records.push(inspectDependency(name, dir, packageName, specRaw))
    }
  }
  return { profiles, records, checkedAt: new Date().toISOString() }
}
