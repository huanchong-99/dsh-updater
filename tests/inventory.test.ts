/**
 * Unit tests for the self-contained inventory and update logic. No network,
 * no real dsh profiles, no third-party plugin packages.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  compareVersions,
  fetchLatestCommit,
  findGitRoot,
  inspectDependency,
  isGitSpec,
  isLocalSpec,
  listProfileDirs,
  localSpecPath,
  parseSemver,
} from '../src/inventory.ts'

describe('spec classification', () => {
  it('recognizes local filesystem specs', () => {
    expect(isLocalSpec('link:E:/DSH插件/dsh-web-ui/packages/dsh-web-ui-all')).toBe(true)
    expect(isLocalSpec('file:../plugin')).toBe(true)
    expect(isLocalSpec('./packages/dsh-ssh')).toBe(true)
    expect(isLocalSpec('..')).toBe(true)
    expect(isLocalSpec('dsh-noletme')).toBe(false)
    expect(isLocalSpec('github:org/repo#main')).toBe(false)
  })

  it('recognizes pnpm git specs', () => {
    expect(isGitSpec('github:org/repo#main')).toBe(true)
    expect(isGitSpec('git+https://github.com/org/repo.git#v1.0.0')).toBe(true)
    expect(isGitSpec('git@github.com:org/repo.git')).toBe(true)
    expect(isGitSpec('@linxin666/dsh-web-ui-all')).toBe(false)
  })
})

describe('localSpecPath', () => {
  it('keeps absolute link targets verbatim', () => {
    expect(localSpecPath('link:E:/DSH插件/dsh-web-ui/packages/dsh-web-ui-all', 'C:/Users/u/.dsh/profiles/web')).toBe('E:/DSH插件/dsh-web-ui/packages/dsh-web-ui-all')
  })

  it('anchors relative specs to the profile directory', () => {
    const result = localSpecPath('link:../plugin', 'C:/Users/u/.dsh/profiles/web')
    expect(result).toBe(join('C:/Users/u/.dsh/profiles', 'plugin'))
  })
})

describe('semver', () => {
  it('parses plain versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('compares prereleases below releases', () => {
    expect(compareVersions('1.0.0-rc.6', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })

  it('orders numeric prerelease identifiers numerically', () => {
    expect(compareVersions('1.0.0-2', '1.0.0-10')).toBeLessThan(0)
  })

  it('treats unparseable versions as below parseable ones', () => {
    expect(compareVersions('unknown', '0.0.1')).toBeLessThan(0)
  })
})

describe('listProfileDirs', () => {
  it('returns an empty list for a nonexistent home', () => {
    expect(listProfileDirs('E:/definitely/not/a/dsh/home')).toEqual([])
  })
})

describe('fetchLatestCommit', () => {
  it('does not probe pinned 40-hex commit refs', () => {
    const remote = 'https://github.com/huanchong-99/dsh-updater.git'
    expect(fetchLatestCommit(remote, 'c0c26d7e2402b8c05663709c17c6fa09cbd1d045')).toBeUndefined()
  })
})

describe('inspectDependency classification', () => {
  const profileDir = 'E:/DSH插件/dsh-updater/tests/fixtures/profile-web'

  it('classifies a missing local path as local-only with an error', () => {
    const record = inspectDependency('web', profileDir, 'dsh-x', 'link:E:/missing/path')
    expect(record.kind).toBe('local-only')
    expect(record.error).toBeDefined()
  })

  it('classifies a real git clone', () => {
    const root = findGitRoot('E:/DSH插件/dsh-updater')
    expect(root).toBeDefined()
    const record = inspectDependency('web', profileDir, 'dsh-updater', `link:${root ?? 'E:/missing'}`)
    expect(record.kind).toBe('git-clone')
    expect(record.git?.root).toBe(root)
  })
})
