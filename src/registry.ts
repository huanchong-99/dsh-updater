/**
 * npm registry probe for the `npm` source kind: which registry to ask (the
 * profile's own pnpm/npm configuration, so mirrors such as npmmirror keep
 * working), the abbreviated packument fetch, and the candidate selection that
 * mirrors DSH's own rules — newest non-deprecated version above the installed
 * one, prereleases only when the installed version is itself a prerelease,
 * and only versions whose `engines.dsh` (or `@deepseek-ai/dsh*` peers) admit
 * the running DSH, because the launcher refuses the rest at boot anyway.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gt, lte, prerelease, satisfies, valid } from 'semver'

/** Default npm registry base used when no configuration names another. */
export const NPM_REGISTRY = 'https://registry.npmjs.org'

/** Minimal fetch shape (test seam). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** One version row of an abbreviated packument (`application/vnd.npm.install-v1+json`). */
export interface PackumentVersion {
  version: string
  deprecated?: string
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** The abbreviated packument subset this module reads. */
export interface Packument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, PackumentVersion>
}

/** Outcome of one registry probe for an installed package. */
export interface NpmCandidate {
  /** Newest version the running DSH admits; undefined when none is newer or the probe failed. */
  latest?: string
  /** Newest version overall when it is NOT admitted by the running DSH (informational). */
  incompatibleLatest?: string
}

/** Parse the `registry` / `@scope:registry` entries of one .npmrc file. */
function readNpmrc(path: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!existsSync(path)) return result
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return result
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'registry' || /^@[^:]+:registry$/.test(key)) result.set(key, value)
  }
  return result
}

/**
 * The registry pnpm would ask for `name` from `profileDir`: `npm_config_registry`
 * in the environment, then the profile's `.npmrc`, then the user's `.npmrc`
 * (scoped `@scope:registry` entries win for scoped packages), else npmjs.
 */
export function resolveNpmRegistry(
  profileDir: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
  const files = [join(profileDir, '.npmrc'), join(home, '.npmrc')].map(readNpmrc)
  if (scope !== undefined) {
    const scopedEnv = env[`npm_config_${scope}:registry`]
    if (typeof scopedEnv === 'string' && scopedEnv !== '') return scopedEnv.replace(/\/+$/, '')
    for (const file of files) {
      const scoped = file.get(`${scope}:registry`)
      if (scoped !== undefined && scoped !== '') return scoped.replace(/\/+$/, '')
    }
  }
  const fromEnv = env.npm_config_registry
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv.replace(/\/+$/, '')
  for (const file of files) {
    const plain = file.get('registry')
    if (plain !== undefined && plain !== '') return plain.replace(/\/+$/, '')
  }
  return NPM_REGISTRY
}

/**
 * Fetch the abbreviated packument for one package; undefined on any failure.
 * @param name - package name (scoped names are percent-encoded as npm expects).
 */
export async function fetchPackument(
  name: string,
  registry: string,
  fetchImpl: FetchLike,
  timeoutMs = 10_000,
): Promise<Packument | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(`${registry}/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    return body as Packument
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * DSH's admission rule for one published version: an `engines.dsh` range
 * decides alone; otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * peer range must admit the runtime (workspace: specs mean "the runtime").
 * Unknown runtime version → admitted (nothing to check against).
 */
export function isCompatibleWithDsh(meta: PackumentVersion, dshVersion: string | undefined): boolean {
  if (dshVersion === undefined || valid(dshVersion) === null) return true
  const engine = meta.engines?.dsh
  if (typeof engine === 'string') {
    return engine.trim() !== '' && satisfies(dshVersion, engine, { includePrerelease: true })
  }
  for (const [peer, range] of Object.entries(meta.peerDependencies ?? {})) {
    if (peer !== '@deepseek-ai/dsh' && !peer.startsWith('@deepseek-ai/dsh-')) continue
    if (['workspace:^', 'workspace:~', 'workspace:*'].includes(range)) continue
    if (range.trim() === '' || !satisfies(dshVersion, range, { includePrerelease: true })) return false
  }
  return true
}

/**
 * Pick the update candidate from a packument.
 * @param packument - abbreviated packument.
 * @param current - installed version (unparseable/undefined → every version is a candidate).
 * @param dshVersion - running DSH version for the admission filter.
 */
export function selectNpmCandidate(
  packument: Packument,
  current: string | undefined,
  dshVersion: string | undefined,
): NpmCandidate {
  const floor = current === undefined ? null : valid(current)
  const allowPrerelease = floor !== null && prerelease(floor) !== null
  let best: string | undefined
  let bestAny: string | undefined
  let bestStable: string | undefined
  for (const meta of Object.values(packument.versions ?? {})) {
    const version = typeof meta.version === 'string' ? valid(meta.version) : null
    if (version === null) continue
    if (typeof meta.deprecated === 'string') continue
    if (floor !== null && lte(version, floor)) continue
    const isPrerelease = prerelease(version) !== null
    if (floor !== null && isPrerelease && !allowPrerelease) continue
    const compatible = isCompatibleWithDsh(meta, dshVersion)
    if (bestAny === undefined || gt(version, bestAny)) bestAny = version
    if (!compatible) continue
    if (!isPrerelease && (bestStable === undefined || gt(version, bestStable))) bestStable = version
    if (best === undefined || gt(version, best)) best = version
  }
  // Without an installed floor (fresh/unknown install) prefer the newest
  // stable release and fall back to a prerelease only when none exists —
  // the same rule the DSH plugin market applies to its recommended version.
  const chosen = floor === null ? (bestStable ?? best) : best
  return {
    latest: chosen,
    incompatibleLatest: bestAny !== undefined && bestAny !== chosen && (chosen === undefined || gt(bestAny, chosen)) ? bestAny : undefined,
  }
}

/**
 * Probe the registry for one installed package and select its candidate.
 * @returns the candidate (`latest` undefined when nothing newer is admitted),
 *   or undefined when the registry could not be read at all — the two differ
 *   in the panel: "up to date" versus "unknown, update still allowed".
 */
export async function probeNpmCandidate(
  name: string,
  current: string | undefined,
  options: { profileDir: string; dshVersion?: string; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<NpmCandidate | undefined> {
  const registry = resolveNpmRegistry(options.profileDir, name)
  const packument = await fetchPackument(name, registry, options.fetchImpl, options.timeoutMs)
  if (packument === undefined) return undefined
  return selectNpmCandidate(packument, current, options.dshVersion)
}
