/** Registry candidate selection: DSH admission rule, prerelease policy, deprecations, mirrors. */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchPackument,
  isCompatibleWithDsh,
  NPM_REGISTRY,
  probeNpmCandidate,
  resolveNpmRegistry,
  selectNpmCandidate,
  type Packument,
} from '../src/registry.ts'

const packument: Packument = {
  'dist-tags': { latest: '1.2.0' },
  versions: {
    '1.0.0': { version: '1.0.0' },
    '1.1.0': { version: '1.1.0', deprecated: 'broken' },
    '1.2.0': { version: '1.2.0', engines: { dsh: '>=0.2.0-rc.1 <0.3.0' } },
    '1.3.0-rc.1': { version: '1.3.0-rc.1', engines: { dsh: '>=0.2.0-rc.1 <0.3.0' } },
    '2.0.0': { version: '2.0.0', engines: { dsh: '>=0.3.0' } },
    '2.1.0': { version: '2.1.0', peerDependencies: { '@deepseek-ai/dsh-base': '^0.3.0' } },
  },
}

describe('isCompatibleWithDsh', () => {
  it('lets engines.dsh decide alone, with prereleases participating', () => {
    expect(isCompatibleWithDsh({ version: 'x', engines: { dsh: '>=0.2.0-rc.1 <0.3.0' } }, '0.2.2-rc.1')).toBe(true)
    expect(isCompatibleWithDsh({ version: 'x', engines: { dsh: '>=0.2.0-rc.1 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-base': '^9.0.0' } }, '0.2.2-rc.1')).toBe(true)
    expect(isCompatibleWithDsh({ version: 'x', engines: { dsh: '>=0.3.0' } }, '0.2.2-rc.1')).toBe(false)
    expect(isCompatibleWithDsh({ version: 'x', engines: { dsh: ' ' } }, '0.2.2-rc.1')).toBe(false)
  })

  it('falls back to @deepseek-ai/dsh* peers and treats workspace: as the runtime', () => {
    expect(isCompatibleWithDsh({ version: 'x', peerDependencies: { '@deepseek-ai/dsh-base': 'workspace:~', react: '^99' } }, '0.2.2-rc.1')).toBe(true)
    expect(isCompatibleWithDsh({ version: 'x', peerDependencies: { '@deepseek-ai/dsh-base': '^0.3.0' } }, '0.2.2-rc.1')).toBe(false)
    expect(isCompatibleWithDsh({ version: 'x', peerDependencies: { '@deepseek-ai/dsh-client-ui-slots': '>=0.2.0-rc.1' } }, '0.2.2-rc.1')).toBe(true)
  })

  it('admits everything when the runtime version is unknown', () => {
    expect(isCompatibleWithDsh({ version: 'x', engines: { dsh: '>=9' } }, undefined)).toBe(true)
  })
})

describe('selectNpmCandidate', () => {
  it('picks the newest admitted stable version and reports the newer incompatible one', () => {
    expect(selectNpmCandidate(packument, '1.0.0', '0.2.2-rc.1')).toEqual({ latest: '1.2.0', incompatibleLatest: '2.1.0' })
  })

  it('ignores prereleases while the installed version is stable', () => {
    const only = { versions: { '1.0.0': { version: '1.0.0' }, '1.1.0-rc.1': { version: '1.1.0-rc.1' } } }
    expect(selectNpmCandidate(only, '1.0.0', undefined)).toEqual({ latest: undefined, incompatibleLatest: undefined })
  })

  it('admits prereleases while the installed version is a prerelease', () => {
    expect(selectNpmCandidate(packument, '1.2.0-rc.1', '0.2.2-rc.1').latest).toBe('1.3.0-rc.1')
  })

  it('returns nothing when the installed version is already the newest admitted one', () => {
    expect(selectNpmCandidate(packument, '1.2.0', '0.2.2-rc.1')).toEqual({ latest: undefined, incompatibleLatest: '2.1.0' })
  })

  it('skips deprecated versions', () => {
    const only = { versions: { '1.0.0': { version: '1.0.0' }, '1.1.0': { version: '1.1.0', deprecated: 'no' } } }
    expect(selectNpmCandidate(only, '1.0.0', undefined).latest).toBeUndefined()
  })

  it('prefers the newest stable release when the installed version is unknown', () => {
    expect(selectNpmCandidate(packument, undefined, '0.2.2-rc.1').latest).toBe('1.2.0')
    const onlyPre = { versions: { '0.1.0-rc.1': { version: '0.1.0-rc.1' } } }
    expect(selectNpmCandidate(onlyPre, undefined, undefined).latest).toBe('0.1.0-rc.1')
  })

  it('does not treat the stale `latest` dist-tag as authoritative', () => {
    const stale: Packument = { 'dist-tags': { latest: '0.0.1' }, versions: { '0.0.1': { version: '0.0.1' }, '0.5.0': { version: '0.5.0' } } }
    expect(selectNpmCandidate(stale, '0.0.1', undefined).latest).toBe('0.5.0')
  })
})

describe('resolveNpmRegistry', () => {
  it('reads the profile .npmrc, scoped entries first, then falls back to npmjs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-updater-npmrc-'))
    try {
      writeFileSync(join(dir, '.npmrc'), '# mirror\nregistry=https://registry.npmmirror.com/\n@acme:registry=https://npm.acme.test/\n')
      expect(resolveNpmRegistry(dir, 'dsh-foo', {}, '/nonexistent-home')).toBe('https://registry.npmmirror.com')
      expect(resolveNpmRegistry(dir, '@acme/dsh-foo', {}, '/nonexistent-home')).toBe('https://npm.acme.test')
      expect(resolveNpmRegistry('/nonexistent-profile', 'dsh-foo', {}, '/nonexistent-home')).toBe(NPM_REGISTRY)
      expect(resolveNpmRegistry(dir, 'dsh-foo', { npm_config_registry: 'https://env.test/' }, '/nonexistent-home')).toBe('https://env.test')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fetchPackument / probeNpmCandidate', () => {
  it('asks for the abbreviated packument and tolerates failures', async () => {
    let seenUrl = ''
    let seenAccept = ''
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      seenUrl = url
      seenAccept = init?.headers?.accept ?? ''
      return { ok: true, status: 200, json: async () => packument }
    }
    const result = await fetchPackument('@scope/name', 'https://registry.example', fetchImpl)
    expect(seenUrl).toBe('https://registry.example/@scope%2Fname')
    expect(seenAccept).toContain('application/vnd.npm.install-v1+json')
    expect(result).toBe(packument)
    const failing = async () => ({ ok: false, status: 404, json: async () => ({}) })
    expect(await fetchPackument('x', 'https://registry.example', failing)).toBeUndefined()
    const throwing = async () => { throw new Error('offline') }
    expect(await fetchPackument('x', 'https://registry.example', throwing)).toBeUndefined()
  })

  it('returns undefined when the registry is unreachable, and a candidate otherwise', async () => {
    const throwing = async () => { throw new Error('offline') }
    expect(await probeNpmCandidate('x', '1.0.0', { profileDir: '/nonexistent', fetchImpl: throwing })).toBeUndefined()
    const serving = async () => ({ ok: true, status: 200, json: async () => packument })
    expect(await probeNpmCandidate('x', '1.0.0', { profileDir: '/nonexistent', dshVersion: '0.2.2-rc.1', fetchImpl: serving })).toEqual({ latest: '1.2.0', incompatibleLatest: '2.1.0' })
  })
})
