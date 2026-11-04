/**
 * The "Updates" tab of the Plugins settings section. Renders the scan result
 * grouped by profile, with per-row source badges, version comparison, and
 * manual update actions. Component-local state per the client stack rules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginRecord, UpdaterStatus } from '../inventory.ts'
import type { UpdateRunResult } from '../update.ts'
import { fetchUpdaterStatus, runPluginUpdate, UpdaterHttpError } from './updater-api.ts'
import css from './updates.module.css'

/** Composed props of the settings.plugins.tab entry. */
export type UpdatesTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'updater'>

/** Per-row update state. */
interface RowState {
  running: boolean
  result?: UpdateRunResult
}

/** Aggregate state keyed by `${profile}\0${name}`. */
type RowStateMap = Record<string, RowState>

/** Toolbar-level message after a bulk run or a failed probe. */
type NoticeKey = 'forbidden' | 'busyHint' | 'offline' | 'error'

const rowKey = (record: PluginRecord): string => `${record.profile}\0${record.name}`

/** Map a thrown transport error onto the notice copy the user should read. */
function noticeFor(error: unknown): NoticeKey {
  if (error instanceof UpdaterHttpError) {
    if (error.status === 403) return 'forbidden'
    if (error.status === 409) return 'busyHint'
    if (error.status === 0) return 'offline'
  }
  return 'error'
}

/** Transport failure rendered as a run result row. */
function failedResult(error: unknown): UpdateRunResult {
  if (error instanceof UpdaterHttpError && error.status === 409) {
    return { ok: false, exitCode: null, output: '', errorCode: 'busy', error: error.message }
  }
  return { ok: false, exitCode: null, output: '', error: error instanceof Error ? error.message : String(error) }
}

/**
 * Render the plugin update tab.
 * @param props - runtime + locale seats.
 * @returns the tab element tree.
 */
export function UpdatesTab(props: UpdatesTabProps): React.ReactNode {
  const { t } = props
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<NoticeKey | null>(null)
  const [rows, setRows] = useState<RowStateMap>({})
  const [bulk, setBulk] = useState<{ scope: string; result?: UpdateRunResult } | null>(null)
  // Monotonic request token: a stale status response never overwrites a newer one.
  const probe = useRef(0)
  const mounted = useRef(true)

  const check = useCallback(async (): Promise<void> => {
    const token = ++probe.current
    setLoading(true)
    setNotice(null)
    try {
      const next = await fetchUpdaterStatus()
      if (mounted.current && token === probe.current) setStatus(next)
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

  const runOne = useCallback(async (record: PluginRecord, autostash = false): Promise<void> => {
    const key = rowKey(record)
    setRows(prev => ({ ...prev, [key]: { running: true } }))
    let result: UpdateRunResult
    try {
      result = await runPluginUpdate({ profile: record.profile, name: record.name, autostash })
    } catch (error) {
      result = failedResult(error)
    }
    if (!mounted.current) return
    setRows(prev => ({ ...prev, [key]: { running: false, result } }))
    void check()
  }, [check])

  const runBulk = useCallback(async (profile?: string): Promise<void> => {
    const scope = profile ?? '*'
    setBulk({ scope })
    let result: UpdateRunResult
    try {
      result = await runPluginUpdate(profile === undefined ? { all: true } : { profile, all: true })
    } catch (error) {
      result = failedResult(error)
    }
    if (!mounted.current) return
    setBulk({ scope, result })
    void check()
  }, [check])

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

  const outdatedCount = status?.records.filter(record => record.outdated).length ?? 0
  const bulkRunning = bulk !== null && bulk.result === undefined
  const anyRowRunning = Object.values(rows).some(row => row.running)
  const busy = bulkRunning || anyRowRunning || status?.busy === true

  /** A row is actionable only when the status probe found an update, or when
   *  the probe could not confirm a latest version (network failure). Once a
   *  row is confirmed up-to-date the buttons stay disabled. */
  const canUpdate = (record: PluginRecord): boolean => {
    if (record.kind === 'installation-owned' || record.kind === 'local-only') return false
    if (record.outdated) return true
    return record.latest === undefined
  }

  const describe = (result: UpdateRunResult): string => {
    if (result.ok) return t('done')
    if (result.errorCode !== undefined) return t(`errorCode.${result.errorCode}`)
    return result.error ?? t('error')
  }

  const logOf = (result: UpdateRunResult): string =>
    [result.ok ? undefined : result.error, result.output].filter((part): part is string => part !== undefined && part !== '').join('\n')

  return (
    <div className={css.section}>
      <p className={css.lede}>{t('description')}</p>

      <div className={css.toolbar}>
        <button type="button" className={css.button} onClick={() => { void check() }} disabled={loading}>
          {loading ? t('checking') : t('recheck')}
        </button>
        <button type="button" className={css.button} onClick={() => { void runBulk() }} disabled={loading || busy || outdatedCount === 0}>
          {bulkRunning && bulk.scope === '*' ? t('running') : t('updateAll')}
        </button>
        {status !== null && (
          <span className={css.meta}>
            {status.dshVersion !== undefined && <span>{t('dshVersion', { version: status.dshVersion })}</span>}
            <span>{t('checkedAt', { time: new Date(status.checkedAt).toLocaleTimeString() })}</span>
          </span>
        )}
      </div>

      {notice !== null && <p className={notice === 'error' || notice === 'offline' ? css.error : css.muted}>{t(notice)}</p>}
      {status?.busy === true && !bulkRunning && !anyRowRunning && <p className={css.muted}>{t('busyHint')}</p>}
      {bulk?.result !== undefined && (
        <div className={bulk.result.ok ? css.ok : css.error}>
          <span>{describe(bulk.result)}</span>
          {logOf(bulk.result) !== '' && (
            <details className={css.details}>
              <summary>{t('log')}</summary>
              <pre className={css.log}>{logOf(bulk.result)}</pre>
            </details>
          )}
        </div>
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
                    onClick={() => { void runBulk(group.profile) }}
                  >
                    {bulkRunning && bulk.scope === group.profile ? t('running') : `${t('updateProfile')} (${String(group.outdated)})`}
                  </button>
                </th>
              </tr>
              {group.records.map((record) => {
                const key = rowKey(record)
                const row = rows[key]
                const running = row?.running === true
                const updatable = record.kind !== 'installation-owned' && record.kind !== 'local-only'
                const actionable = canUpdate(record)
                return (
                  <tr key={key} data-outdated={record.outdated ? 'true' : 'false'}>
                    <td className={css.name} title={record.spec}>{record.name}</td>
                    <td>
                      <span className={css.badge} data-kind={record.kind} title={t(`sourceLabel.${record.kind}`)}>
                        {t(`kind.${record.kind}`)}
                      </span>
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
                            disabled={running || busy || !actionable}
                            title={!actionable && !running ? t('updateDisabled') : undefined}
                            onClick={() => { void runOne(record) }}
                          >
                            {running ? t('running') : t('update')}
                          </button>
                        )}
                        {record.kind === 'git-clone' && (
                          <button
                            type="button"
                            className={css.button}
                            disabled={running || busy || !actionable}
                            title={!actionable && !running ? t('updateDisabled') : t('updateStashHint')}
                            onClick={() => { void runOne(record, true) }}
                          >
                            {running ? t('running') : t('updateStash')}
                          </button>
                        )}
                        {updatable && (
                          <span className={record.outdated ? css.outdated : record.latest === undefined ? css.muted : css.uptodate}>
                            {record.outdated ? t('outdated') : record.latest === undefined ? t('unknown') : t('uptodate')}
                          </span>
                        )}
                      </div>
                      {row?.result !== undefined && (
                        <div className={row.result.ok ? css.ok : css.error}>
                          <span>{describe(row.result)}</span>
                          {logOf(row.result) !== '' && (
                            <details className={css.details}>
                              <summary>{t('log')}</summary>
                              <pre className={css.log}>{logOf(row.result)}</pre>
                            </details>
                          )}
                        </div>
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
