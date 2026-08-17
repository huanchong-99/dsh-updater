import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { updateGitClone } from '../src/update.ts'

const base = mkdtempSync(join(tmpdir(), 'dsh-updater-conflict-'))
const origin = join(base, 'origin.git')
const seed = join(base, 'seed')
const local = join(base, 'local')
const peer = join(base, 'peer')
const run = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
try {
  run(base, ['init', '--bare', origin])
  run(base, ['clone', origin, seed])
  run(seed, ['config', 'user.email', 't@t'])
  run(seed, ['config', 'user.name', 't'])
  writeFileSync(join(seed, 'a.txt'), 'base')
  run(seed, ['add', 'a.txt'])
  run(seed, ['commit', '-m', 'init'])
  run(seed, ['push', 'origin', 'master'])

  run(base, ['clone', origin, local])
  run(local, ['config', 'user.email', 't@t'])
  run(local, ['config', 'user.name', 't'])

  run(base, ['clone', origin, peer])
  run(peer, ['config', 'user.email', 't@t'])
  run(peer, ['config', 'user.name', 't'])
  writeFileSync(join(peer, 'a.txt'), 'remote')
  run(peer, ['commit', '-am', 'remote'])
  run(peer, ['push', 'origin', 'master'])

  writeFileSync(join(local, 'a.txt'), 'local')

  const result = await updateGitClone({ profile: 'x', profileDir: local, name: 'x', kind: 'git-clone', spec: 'link:', dir: local, gitRoot: local, autostash: true })
  console.log('conflict result:', result.ok, result.errorCode)
  console.log('stash list:', run(local, ['stash', 'list']) || '(empty)')
  console.log('status:', run(local, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).join(' | '))
} finally {
  rmSync(base, { recursive: true, force: true })
}
