/** Job store: lifecycle, single-flight, progress routing, continue-on-failure. */

import { describe, expect, it } from 'vitest'
import { JobStore, type JobItem, type PlannedStep } from '../src/jobs.ts'

const item = (name: string, overrides: Partial<JobItem> = {}): JobItem =>
  ({ key: `web\0${name}`, profile: 'web', name, via: 'updater', kind: 'npm', state: 'pending', ...overrides })

describe('JobStore', () => {
  it('plans, runs every item in order, keeps going past a failure, and finishes', async () => {
    const store = new JobStore()
    const order: string[] = []
    const steps: PlannedStep[] = ['a', 'b', 'c'].map(name => ({
      item: item(name),
      run: async (report) => {
        order.push(name)
        report({ step: 'installing' })
        if (name === 'b') throw new Error('b broke')
        return { state: 'done', output: `${name} ok` }
      },
    }))
    const started = store.start({ type: 'all' }, async () => ({ steps, settled: [item('d', { state: 'skipped', skipReason: 'up-to-date' })] }))
    expect(started).toBeDefined()
    expect(started?.view.phase).toBe('planning')
    expect(store.running).toBe(true)
    await started?.done
    const view = store.view()
    expect(order).toEqual(['a', 'b', 'c'])
    expect(view?.phase).toBe('finished')
    expect(view?.items.map(entry => [entry.name, entry.state])).toEqual([['a', 'done'], ['b', 'failed'], ['c', 'done'], ['d', 'skipped']])
    expect(view?.items[1].error).toBe('b broke')
    expect(view?.items[0].step).toBeUndefined()
    expect(store.running).toBe(false)
  })

  it('refuses a second job while one runs, and allows one after', async () => {
    const store = new JobStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = store.start({ type: 'all' }, async () => ({ steps: [{ item: item('a'), run: async () => { await gate; return { state: 'done' } } }], settled: [] }))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(store.start({ type: 'all' }, async () => ({ steps: [], settled: [] }))).toBeUndefined()
    expect(store.clear()).toBe(false)
    release()
    await first?.done
    expect(store.start({ type: 'plugin-manager' }, async () => ({ steps: [], settled: [] }))).toBeDefined()
  })

  it('routes manager progress and logs to the running item by request id', async () => {
    const store = new JobStore()
    let seenRequest = ''
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = store.start({ type: 'plugin-manager' }, async () => ({
      steps: [{ item: item('a', { via: 'plugin-manager' }), run: async (_report, requestId) => { seenRequest = requestId; await gate; return { state: 'done' } } }],
      settled: [],
    }))
    await new Promise(resolve => setTimeout(resolve, 5))
    store.progress(seenRequest, { step: 'removing' })
    store.output(seenRequest, 'line 1\n')
    store.output('someone-else', 'ignored')
    expect(store.view()?.items[0]).toMatchObject({ state: 'running', step: 'removing', output: 'line 1\n' })
    release()
    await started?.done
    expect(store.view()?.items[0].output).toBe('line 1\n')
  })

  it('records a planning failure and finishes without items', async () => {
    const store = new JobStore()
    const started = store.start({ type: 'one', name: 'x' }, async () => { throw new Error('no package named x was found') })
    await started?.done
    expect(store.view()).toMatchObject({ phase: 'finished', error: 'no package named x was found', items: [] })
  })

  it('marks an executor that forgot to settle as failed', async () => {
    const store = new JobStore()
    const started = store.start({ type: 'all' }, async () => ({ steps: [{ item: item('a'), run: async () => ({}) }], settled: [] }))
    await started?.done
    expect(store.view()?.items[0].state).toBe('failed')
  })

  it('serves detached snapshots', async () => {
    const store = new JobStore()
    const started = store.start({ type: 'all' }, async () => ({ steps: [], settled: [] }))
    await started?.done
    const snapshot = store.view()
    if (snapshot !== undefined) snapshot.phase = 'running'
    expect(store.view()?.phase).toBe('finished')
    expect(store.clear()).toBe(true)
    expect(store.view()).toBeUndefined()
  })
})
