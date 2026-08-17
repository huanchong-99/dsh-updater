/**
 * The plugin-updater settings section. Renders the scan result grouped by
 * profile, with per-row source badges, version comparison, and manual update
 * actions. Component-local state per the client stack rules.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginRecord, UpdaterStatus } from '../inventory.ts'
import type { UpdateRunResult } from '../update.ts'
import { fetchUpdaterStatus, runPluginUpdate } from './updater-api.ts'
import css from './updater.module.css'

/** Composed props of the settings.section entry. */
export type UpdaterSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'updater'>

/** Per-row update state. */
interface RowState {
  running: boolean
  result?: UpdateRunResult
}

/** Aggregate state keyed by `${profile}\0${name}`. */
type RowStateMap = Record<string, RowState>

/**
 * Render the plugin update panel.
 * @param props - runtime + locale seats.
 * @returns the section element tree.
 */
export function UpdaterSection(props: UpdaterSectionProps): React.ReactNode {
  const { t } = props
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<RowStateMap>({})
  const [updatingAll, setUpdatingAll] = useState(false)
  const token = useRef(0)

  const check = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      setStatus(await fetchUpdaterStatus())
    } catch {
      setLoadError(t('error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void check()
    return () => { token.current++ }
  }, [check])

  const runOne = useCallback(async (record: PluginRecord, autostash = false): Promise<void> => {
    const key = `${record.profile}\0${record.name}`
    setRows(prev => ({ ...prev, [key]: { running: true } }))
    try {
      const result = await runPluginUpdate({ profile: record.profile, name: record.name, autostash })
      setRows(prev => ({ ...prev, [key]: { running: false, result } }))
    } catch (error) {
      setRows(prev => ({ ...prev, [key]: { running: false, result: { ok: false, exitCode: null, output: '', error: error instanceof Error ? error.message : String(error) } } }))
    }
    void check()
  }, [check])

  const runAll = useCallback(async (): Promise<void> => {
    setUpdatingAll(true)
    try {
      await runPluginUpdate({ all: true })
    } catch {
      // The row-level result cannot be shown for all:true; the recheck below
      // reflects what actually moved.
    } finally {
      setUpdatingAll(false)
    }
    void check()
  }, [check])

  const outdatedCount = status?.records.filter(record => record.outdated).length ?? 0

  /** A row is actionable only when the status probe found an update, or when
   *  the probe could not confirm a latest version (network failure). Once a
   *  row is confirmed up-to-date the buttons stay disabled. */
  const canUpdate = useCallback((record: PluginRecord): boolean => {
    if (record.kind === 'installation-owned' || record.kind === 'local-only') return false
    if (record.outdated) return true
    return record.latest === undefined
  }, [])

  return (
    <div className={css.section}>
      <h2 className={css.heading} title={t('title')}>{t('title')}</h2>
      <p className={css.lede} title={t('description')}>{t('description')}</p>

      <div className={css.toolbar}>
        <button type="button" className={css.button} onClick={() => { void check() }} disabled={loading}>
          {loading ? t('checking') : t('recheck')}
        </button>
        <button type="button" className={css.button} onClick={() => { void runAll() }} disabled={loading || updatingAll || outdatedCount === 0}>
          {updatingAll ? t('running') : t('updateAll')}
        </button>
      </div>

      {loadError !== null && <p className={css.error}>{loadError}</p>}
      {loading && status === null && <p className={css.muted}>{t('checking')}</p>}
      {status !== null && status.records.length === 0 && <p className={css.muted}>{t('empty')}</p>}

      {status !== null && status.records.length > 0 && (
        <table className={css.table}>
          <thead>
            <tr>
              <th>{t('plugin')}</th>
              <th>{t('profile')}</th>
              <th>{t('source')}</th>
              <th>{t('current')}</th>
              <th>{t('latest')}</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {status.records.map(record => {
              const key = `${record.profile}\0${record.name}`
              const row = rows[key]
              return (
                <tr key={key} data-outdated={record.outdated ? 'true' : 'false'}>
                  <td className={css.name} title={record.name}>{record.name}</td>
                  <td className={css.profile} title={t('profileHint')}>{record.profile}</td>
                  <td>
                    <span className={css.badge} data-kind={record.kind} title={t(`sourceLabel.${record.kind}`)}>
                      {t(`kind.${record.kind}`)}
                    </span>
                  </td>
                  <td className={css.mono}>{record.current ?? '-'}</td>
                  <td className={css.mono}>{record.latest ?? '-'}</td>
                  <td>
                    <div className={css.actions}>
                      <button
                        type="button"
                        className={css.button}
                        disabled={row?.running === true || !canUpdate(record)}
                        title={!canUpdate(record) && !row?.running ? t('updateDisabled') : undefined}
                        onClick={() => { void runOne(record) }}
                      >
                        {row?.running === true ? t('running') : t('update')}
                      </button>
                      {record.kind === 'git-clone' && (
                        <button
                          type="button"
                          className={css.button}
                          disabled={row?.running === true || !canUpdate(record)}
                          title={!canUpdate(record) && !row?.running ? t('updateDisabled') : t('updateStashHint')}
                          onClick={() => { void runOne(record, true) }}
                        >
                          {row?.running === true ? t('running') : t('updateStash')}
                        </button>
                      )}
                      <span className={record.outdated ? css.outdated : css.uptodate}>
                        {record.outdated ? t('outdated') : t('uptodate')}
                      </span>
                    </div>
                    {row?.result !== undefined && (
                      <pre className={css.log}>{row.result.error ?? row.result.output ?? (row.result.ok ? t('done') : t('error'))}</pre>
                    )}
                    {record.error !== undefined && <div className={css.error} title={record.error}>{record.error}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className={css.muted}>{t('profileHint')}</p>
      <p className={css.muted}>{t('restartHint')}</p>
    </div>
  )
}
