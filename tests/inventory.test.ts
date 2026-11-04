/**
 * Unit tests for the self-contained inventory logic. No network, no real dsh
 * profiles, no third-party plugin packages. Paths derive from this checkout
 * so the suite runs on every platform.
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareVersions,
  fetchLatestCommit,
  findGitRoot,
  inspectDependency,
  isGitSpec,
  isLocalSpec,
  listProfileDirs,
  localSpecPath,
  parseGitSpec,
  parseSemver,
  readDshRuntimeVersion,
  readPnpmGitResolution,
} from '../src/inventory.ts'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

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
    expect(isGitSpec('gitlab:org/repo')).toBe(true)
    expect(isGitSpec('git+https://github.com/org/repo.git#v1.0.0')).toBe(true)
    expect(isGitSpec('git@github.com:org/repo.git')).toBe(true)
    expect(isGitSpec('@linxin666/dsh-web-ui-all')).toBe(false)
    expect(isGitSpec('1.2.3')).toBe(false)
  })
})

describe('localSpecPath', () => {
  it('keeps absolute link targets verbatim', () => {
    expect(localSpecPath(`link:${REPO_ROOT}`, '/some/profile')).toBe(REPO_ROOT)
  })

  it('anchors relative specs to the profile directory', () => {
    const result = localSpecPath('link:../plugin', '/home/u/.dsh/profiles/web')
    expect(result).toBe(join('/home/u/.dsh/profiles', 'plugin'))
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

describe('parseGitSpec', () => {
  it('expands github: shorthand with a ref', () => {
    expect(parseGitSpec('github:huanchong-99/dsh-updater#main')).toEqual({ remote: 'https://github.com/huanchong-99/dsh-updater.git', ref: 'main' })
  })

  it('expands gitlab: shorthand without a ref', () => {
    expect(parseGitSpec('gitlab:team/plugins')).toEqual({ remote: 'https://gitlab.com/team/plugins.git', ref: undefined })
  })

  it('keeps full git+https URLs and strips the plugin-market path suffix from the ref', () => {
    expect(parseGitSpec('git+https://gitlab.example.com/team/dsh-plugins.git#3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4&path:/packages/bar'))
      .toEqual({ remote: 'https://gitlab.example.com/team/dsh-plugins.git', ref: '3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4' })
  })

  it('returns undefined for non-git specs', () => {
    expect(parseGitSpec('1.2.3')).toBeUndefined()
  })
})

describe('readPnpmGitResolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-updater-lock-'))

  it('reads the GitHub tarball form and the generic git+ form', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), [
      'packages:',
      "  'dsh-foo@https://codeload.github.com/you/dsh-foo/tar.gz/0123456789abcdef0123456789abcdef01234567':",
      '    resolution: {tarball: x}',
      "  'dsh-bar@git+https://gitlab.example.com/team/dsh-bar.git#89abcdef0123456789abcdef0123456789abcdef':",
      '    resolution: {commit: y}',
      '',
    ].join('\n'))
    expect(readPnpmGitResolution(dir, 'dsh-foo')).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(readPnpmGitResolution(dir, 'dsh-bar')).toBe('89abcdef0123456789abcdef0123456789abcdef')
    expect(readPnpmGitResolution(dir, 'dsh-missing')).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined without a lockfile', () => {
    expect(readPnpmGitResolution('/definitely/not/a/profile', 'x')).toBeUndefined()
  })
})

describe('listProfileDirs', () => {
  it('returns an empty list for a nonexistent home', () => {
    expect(listProfileDirs('/definitely/not/a/dsh/home')).toEqual([])
  })
})

describe('readDshRuntimeVersion', () => {
  it('walks up from the launcher script to the @deepseek-ai/dsh manifest', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-updater-rt-'))
    try {
      const pkg = join(base, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }))
      writeFileSync(join(pkg, 'lib', 'bin.js'), '')
      expect(readDshRuntimeVersion([], join(pkg, 'lib', 'bin.js'))).toBe('0.2.2-rc.1')
      expect(readDshRuntimeVersion([], join(base, 'elsewhere.js'))).toBeUndefined()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('fetchLatestCommit', () => {
  it('does not probe pinned 40-hex commit refs', async () => {
    const remote = 'https://github.com/huanchong-99/dsh-updater.git'
    await expect(fetchLatestCommit(remote, 'c0c26d7e2402b8c05663709c17c6fa09cbd1d045')).resolves.toBeUndefined()
  })

  it('returns undefined for an empty remote', async () => {
    await expect(fetchLatestCommit('', 'main')).resolves.toBeUndefined()
  })
})

describe('inspectDependency classification', () => {
  const profileDir = join(REPO_ROOT, 'tests', 'fixtures', 'profile-web')

  it('classifies a missing local path as local-only with an error', () => {
    const record = inspectDependency('web', profileDir, 'dsh-x', 'link:/definitely/missing/path')
    expect(record.kind).toBe('local-only')
    expect(record.error).toBeDefined()
  })

  it('classifies this checkout as a real git clone', () => {
    const root = findGitRoot(REPO_ROOT)
    expect(root).toBeDefined()
    const record = inspectDependency('web', profileDir, 'dsh-updater', `link:${root ?? '/missing'}`)
    expect(record.kind).toBe('git-clone')
    expect(record.git?.root).toBe(root)
    expect(record.current).toMatch(/^[0-9a-f]{7,}$/)
  })

  it('classifies an unresolvable registry name as npm with an error', () => {
    const record = inspectDependency('web', profileDir, 'dsh-definitely-not-installed', '1.0.0')
    expect(record.kind).toBe('npm')
    expect(record.error).toBeDefined()
  })
})
