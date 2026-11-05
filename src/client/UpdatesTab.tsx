/**
 * The "Updates" tab of the Plugins settings section. Renders the scan result
 * grouped by profile, the one-click Plugin Manager card for the running
 * profile, and the current update job with per-item progress. Updates run as
 * host-side jobs; the tab polls the cheap job endpoint while one runs and
 * reads the full status again when it ends.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginRecord } from '../inventory.ts'
import type { JobItem, JobView } from '../jobs.ts'
import { fetchUpdaterJob, fetchUpdaterStatus, runPluginUpdate, UpdaterHttpError, type RunRequest, type StatusAnswer } from './updater-api.ts'
import { zh } from './locales.ts'
import css from './updates.module.css'

/** Composed props of the settings.plugins.tab entry. */
export type UpdatesTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'updater'>

/** Toolbar-level message after a failed call. */
type NoticeKey = 'forbidden' | 'unauthorized' | 'busyHint' | 'offline' | 'error' | 'job.lost'

/** Poll interval while a job runs. */
const POLL_MS = 1200

/** Dictionary keys, for dynamic lookups (error codes, steps) with a raw fallback. */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(zh))

const rowKey = (record: PluginRecord): string => `${record.profile}\0${record.name}`

/** Map a thrown transport error onto the notice copy the user should read. */
function noticeFor(error: unknown): NoticeKey {
  if (error instanceof UpdaterHttpError) {
    if (error.status === 401) return 'unauthorized'
    if (error.status === 403) return 'forbidden'
    if (error.status === 409) return 'busyHint'
    if (error.status === 0) return 'offline'
  }
  return 'error'
}

const isRunning = (job: JobView | null | undefined): job is JobView => job !== null && job !== undefined && job.phase !== 'finished'

/**
 * Render the plugin update tab.
 * @param props - runtime + locale seats.
 * @returns the tab element tree.
 */
export function UpdatesTab(props: UpdatesTabProps): React.ReactNode {
  const { t } = props
  // Dynamic keys (codes from the host) go through this guard so an unknown
  // code shows its raw text instead of a missing-key marker.
  const tx = useCallback((key: string, fallback: string, params?: Record<string, unknown>): string =>
    KNOWN_KEYS.has(key) ? (t as (key: string, params?: Record<string, unknown>) => string)(key, params) : fallback, [t])

  const [status, setStatus] = useState<StatusAnswer | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<NoticeKey | null>(null)
  const [job, setJob] = useState<JobView | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  // Monotonic request token: a stale status response never overwrites a newer one.
  const probe = useRef(0)
  const mounted = useRef(true)

  const check = useCallback(async (): Promise<void> => {
    const token = ++probe.current
    setLoading(true)
    setNotice(previous => (previous === 'job.lost' ? previous : null))
    try {
      const next = await fetchUpdaterStatus()
      if (!mounted.current || token !== probe.current) return
      setStatus(next)
      if (next.job !== undefined) setJob(next.job)
    } catch (error) {
      if (mounted.current && token === probe.current) setNotice(noticeFor(error))
    } finally {
      if (mounted.current && token === probe.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void check()
    return () => { mounted.current = false }
  }, [check])

  // Poll the job while it runs; read the full status once it ends.
  const runningId = isRunning(job) ? job.id : null
  useEffect(() => {
    if (runningId === null) return
    let stopped = false
    const timer = setInterval(() => {
      void fetchUpdaterJob().then((answer) => {
        if (stopped || !mounted.current) return
        if (answer.job === null || answer.job.id !== runningId) {
          // The updater replaced itself (new module, fresh store): the old
          // job's record is gone. Treat it as finished and look again.
          setJob(previous => (previous === null ? null : { ...previous, phase: 'finished' }))
          setNotice('job.lost')
          void check()
          return
        }
        setJob(answer.job)
        if (answer.job.phase === 'finished') void check()
      }).catch(() => { /* transient: the next tick retries */ })
    }, POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [runningId, check])

  const start = useCallback(async (body: RunRequest): Promise<void> => {
    setNotice(null)
    try {
      const started = await runPluginUpdate(body)
      if (!mounted.current) return
      setDismissed(null)
      setJob(started)
    } catch (error) {
      if (mounted.current) setNotice(noticeFor(error))
    }
  }, [])

  const groups = useMemo(() => {
    if (status === null) return []
    const byProfile = new Map<string, PluginRecord[]>()
    for (const profile of status.profiles) byProfile.set(profile, [])
    for (const record of status.records) {
      const list = byProfile.get(record.profile)
      if (list === undefined) byProfile.set(record.profile, [record])
      else list.push(record)
    }
    return [...byProfile.entries()].map(([profile, records]) => ({
      profile,
      records,
      outdated: records.filter(record => record.outdated).length,
    }))
  }, [status])

  const jobItems = useMemo(() => new Map((job?.items ?? []).map(item => [item.key, item])), [job])
  const outdatedCount = status?.records.filter(record => record.outdated).length ?? 0
  const busy = isRunning(job) || status?.busy === true
  const pm = status?.pluginManager
  // Rows the preview could not confirm (registry unreachable) may still have an
  // update the manager finds; they keep the one-click button available.
  const pmUnknown = status?.records.filter(record => record.managedBy === 'plugin-manager' && record.latest === undefined).length ?? 0

  /** A row is actionable only when the status probe found an update, or when
   *  the probe could not confirm a latest version (network failure). Once a
   *  row is confirmed up-to-date the buttons stay disabled. */
  const canUpdate = (record: PluginRecord): boolean => {
    if (record.kind === 'installation-owned' || record.kind === 'local-only') return false
    if (record.outdated) return true
    return record.latest === undefined
  }

  /** One line describing an item's state and outcome. */
  const describeItem = (item: JobItem): string => {
    switch (item.state) {
      case 'pending': return t('state.pending')
      case 'running': {
        const step = item.step === undefined ? '' : ` · ${tx(`step.${item.step}`, item.step)}`
        return t('state.running') + step
      }
      case 'skipped': return tx(`skip.${item.skipReason ?? ''}`, t('state.skipped'))
      case 'done': {
        if (item.application === 'restart-required') {
          return t('app.restart-required', { reason: tx(`restart.${item.restartReason ?? ''}`, item.restartReason ?? '-') })
        }
        if (item.application !== undefined) return tx(`app.${item.application}`, t('state.done'))
        return t('state.done')
      }
      case 'failed': {
        const space = item.via === 'plugin-manager' ? 'pmError' : 'errorCode'
        const reason = item.errorCode !== undefined
          ? tx(`${space}.${item.errorCode}`, item.errorCode)
          : item.application === 'cancelled' ? t('app.cancelled') : t('error')
        const restored = item.restored === undefined ? '' : ` · ${t(`restored.${item.restored}`)}`
        return `${t('state.failed')}: ${reason}${restored}`
      }
    }
  }

  /** The item's diagnostics, once: the manager's error text often repeats the streamed pnpm log. */
  const itemLog = (item: JobItem): string => {
    const error = item.state === 'failed' || item.state === 'skipped' ? item.error?.trim() ?? '' : ''
    const output = item.output?.trim() ?? ''
    if (error === '') return output
    if (output === '') return error
    if (output.includes(error)) return output
    if (error.includes(output)) return error
    return `${error}\n${output}`
  }

  const jobTitle = (view: JobView): string => {
    switch (view.scope.type) {
      case 'one': return t('job.title.one', { name: view.scope.name })
      case 'profile': return t('job.title.profile', { profile: view.scope.profile })
      case 'all': return t('job.title.all')
      case 'plugin-manager': return t('job.title.plugin-manager')
    }
  }

  const jobHeadline = (view: JobView): string => {
    if (view.phase === 'planning') return t('job.planning')
    const settled = view.items.filter(item => item.state === 'done' || item.state === 'failed').length
    const total = view.items.filter(item => item.state !== 'skipped').length
    if (view.phase === 'running') return t('job.progress', { done: String(settled), total: String(total) })
    if (view.error !== undefined) return t('job.failedToPlan', { error: view.error })
    if (view.items.length === 0) return t('job.empty')
    return t('job.summary', {
      done: String(view.items.filter(item => item.state === 'done').length),
      failed: String(view.items.filter(item => item.state === 'failed').length),
      skipped: String(view.items.filter(item => item.state === 'skipped').length),
    })
  }

  const needsRestart = job !== null && job.phase === 'finished' && job.items.some(item => item.state === 'done'
    && (item.application === 'restart-required' || item.via === 'updater'))

  const stateClass = (item: JobItem): string | undefined =>
    item.state === 'done' ? css.ok : item.state === 'failed' ? css.error : css.muted

  return (
    <div className={css.section}>
      <p className={css.lede}>{t('description')}</p>

      {pm !== undefined && (
        <section className={css.card} aria-label={t('pm.title')}>
          <div className={css.cardHead}>
            <strong>{t('pm.title')}</strong>
            <span className={css.meta}>{t('pm.profile', { profile: pm.profile })}</span>
          </div>
          <p className={css.cardText}>{t('pm.summary', { managed: String(pm.managed), outdated: String(pm.outdated) })}</p>
          <p className={css.muted}>{t('pm.hint')}</p>
          <div>
            <button
              type="button"
              className={css.primary}
              disabled={loading || busy || pm.outdated + pmUnknown === 0}
              title={pm.outdated + pmUnknown === 0 ? t('updateDisabled') : undefined}
              onClick={() => { void start({ pluginManager: true }) }}
            >
              {isRunning(job) && job.scope.type === 'plugin-manager' ? t('running') : t('pm.updateAll', { count: String(pm.outdated) })}
            </button>
          </div>
        </section>
      )}
      {status !== null && pm === undefined && <p className={css.muted}>{t('pm.unavailable')}</p>}

      <div className={css.toolbar}>
        <button type="button" className={css.button} onClick={() => { void check() }} disabled={loading}>
          {loading ? t('checking') : t('recheck')}
        </button>
        <button type="button" className={css.button} onClick={() => { void start({ all: true }) }} disabled={loading || busy || outdatedCount === 0}>
          {isRunning(job) && job.scope.type === 'all' ? t('running') : t('updateAll')}
        </button>
        {status !== null && (
          <span className={css.meta}>
            {status.dshVersion !== undefined && <span>{t('dshVersion', { version: status.dshVersion })}</span>}
            <span>{t('checkedAt', { time: new Date(status.checkedAt).toLocaleTimeString() })}</span>
          </span>
        )}
      </div>

      {notice !== null && <p className={notice === 'error' || notice === 'offline' ? css.error : css.muted}>{t(notice)}</p>}

      {job !== null && job.id !== dismissed && (
        <section className={css.card} aria-live="polite">
          <div className={css.cardHead}>
            <strong>{jobTitle(job)}</strong>
            <span className={css.meta}>{jobHeadline(job)}</span>
            {job.phase === 'finished' && (
              <button type="button" className={css.button} onClick={() => { setDismissed(job.id) }}>{t('job.dismiss')}</button>
            )}
          </div>
          {needsRestart && <p className={css.muted}>{t('job.restartNeeded')}</p>}
          {job.items.length > 0 && (
            <ul className={css.jobList}>
              {job.items.map(item => (
                <li key={item.key} className={css.jobItem} data-state={item.state}>
                  <span className={css.jobName}>{item.name}</span>
                  <span className={css.via} data-via={item.via}>{t(`via.${item.via}`)}</span>
                  <span className={css.mono}>{item.profile}</span>
                  {item.to !== undefined
                    ? <span className={css.mono}>{item.from ?? '?'} → {item.to}</span>
                    : item.from !== undefined && <span className={css.mono}>{item.from}</span>}
                  <span className={stateClass(item)}>{describeItem(item)}</span>
                  {itemLog(item) !== '' && (
                    <details className={css.details}>
                      <summary>{t('log')}</summary>
                      <pre className={css.log}>{itemLog(item)}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {loading && status === null && <p className={css.muted}>{t('checking')}</p>}
      {status !== null && status.records.length === 0 && <p className={css.muted}>{t('empty')}</p>}

      {status !== null && status.records.length > 0 && (
        <table className={css.table}>
          <thead>
            <tr>
              <th>{t('plugin')}</th>
              <th>{t('source')}</th>
              <th>{t('current')}</th>
              <th>{t('latest')}</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          {groups.map(group => (
            <tbody key={group.profile}>
              <tr className={css.groupRow}>
                <th colSpan={4} scope="rowgroup" title={t('profileHint')}>
                  {t('profile')}: {group.profile}
                  <span className={css.groupCount}>{group.records.length}</span>
                </th>
                <th>
                  <button
                    type="button"
                    className={css.button}
                    disabled={loading || busy || group.outdated === 0}
                    onClick={() => { void start({ profile: group.profile, all: true }) }}
                  >
                    {isRunning(job) && job.scope.type === 'profile' && job.scope.profile === group.profile
                      ? t('running')
                      : `${t('updateProfile')} (${String(group.outdated)})`}
                  </button>
                </th>
              </tr>
              {group.records.map((record) => {
                const key = rowKey(record)
                const item = jobItems.get(key)
                const rowBusy = item !== undefined && (item.state === 'running' || item.state === 'pending')
                const updatable = record.kind !== 'installation-owned' && record.kind !== 'local-only'
                const actionable = canUpdate(record)
                return (
                  <tr key={key} data-outdated={record.outdated ? 'true' : 'false'}>
                    <td className={css.name} title={record.spec}>{record.name}</td>
                    <td>
                      <span className={css.badge} data-kind={record.kind} title={t(`sourceLabel.${record.kind}`)}>
                        {t(`kind.${record.kind}`)}
                      </span>
                      {record.managedBy === 'plugin-manager' && (
                        <span className={css.via} data-via="plugin-manager" title={t('pm.badgeHint')}>{t('pm.badge')}</span>
                      )}
                    </td>
                    <td className={css.mono}>
                      <span>{record.current ?? '-'}</span>
                      {record.git?.branch !== undefined && record.kind === 'git-clone' && (
                        <div className={css.sub}>{record.git.branch}{record.git.dirty === true ? ` · ${t('dirty')}` : ''}</div>
                      )}
                    </td>
                    <td className={css.mono}>
                      <span>{record.kind === 'installation-owned' ? (status.dshVersion ?? '-') : (record.latest ?? (record.kind === 'local-only' ? '-' : t('unknown')))}</span>
                      {record.incompatibleLatest !== undefined && (
                        <div className={css.sub} title={t('incompatibleLatest', { version: record.incompatibleLatest })}>
                          {t('incompatibleLatest', { version: record.incompatibleLatest })}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className={css.actions}>
                        {updatable && (
                          <button
                            type="button"
                            className={css.button}
                            disabled={rowBusy || busy || !actionable}
                            title={!actionable && !rowBusy ? t('updateDisabled') : undefined}
                            onClick={() => { void start({ profile: record.profile, name: record.name }) }}
                          >
                            {rowBusy ? t('running') : t('update')}
                          </button>
                        )}
                        {record.kind === 'git-clone' && (
                          <button
                            type="button"
                            className={css.button}
                            disabled={rowBusy || busy || !actionable}
                            title={!actionable && !rowBusy ? t('updateDisabled') : t('updateStashHint')}
                            onClick={() => { void start({ profile: record.profile, name: record.name, autostash: true }) }}
                          >
                            {rowBusy ? t('running') : t('updateStash')}
                          </button>
                        )}
                        {updatable && (
                          <span className={record.outdated ? css.outdated : record.latest === undefined ? css.muted : css.uptodate}>
                            {record.outdated ? t('outdated') : record.latest === undefined ? t('unknown') : t('uptodate')}
                          </span>
                        )}
                      </div>
                      {item !== undefined && !(item.state === 'skipped' && item.skipReason === 'up-to-date') && (
                        <div className={stateClass(item)}>{describeItem(item)}</div>
                      )}
                      {record.error !== undefined && <div className={css.error} title={record.error}>{record.error}</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      )}
      <p className={css.muted}>{t('restartHint')}</p>
    </div>
  )
}
