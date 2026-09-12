'use client'

/**
 * PES.7 — scheduled image publishes.
 *
 * 🔴 The controls are present and **disabled**, with the reason stated in visible text rather than
 * only in a tooltip. Two rules meet here: a placeholder surface is a roadmap and stays
 * (`feedback_keep_placeholder_controls`), and a disabled control cannot explain itself
 * (`reference_disabled_control_cannot_explain`). The moment
 * `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` is set on the deployment, this becomes a working form
 * with no code change — the state comes from the server, never from a constant here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Input, Pill, Select } from '@/design-system/primitives'

import { apiGet } from '../api'
import { executionNotice, readSchedule, summariseSchedules, type ScheduleRow } from './schedule'
import styles from '../channel/amazon/matrix.module.css'

export interface ScheduleSurfaceProps {
  productId: string
  /** The scope the tab is on, so a new schedule defaults to what the operator is looking at. */
  channel: string
  marketplace: string | null
}

interface ScheduleResponse { rows: ScheduleRow[]; executionEnabled?: boolean }

const STATE_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  fired: 'success', failed: 'danger', cancelled: 'neutral', pending: 'info', unknown: 'neutral',
}

export function ScheduleSurface({ productId, channel, marketplace }: ScheduleSurfaceProps) {
  const [rows, setRows] = useState<ScheduleRow[] | null>(null)
  /**
   * `undefined` until the server answers. Deliberately NOT defaulted to `true`: assuming the queue
   * works while we do not know is the one guess that produces a silently broken promise.
   */
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [when, setWhen] = useState('')
  const [target, setTarget] = useState(channel)

  const load = useCallback(async () => {
    const res = await apiGet<ScheduleResponse>(
      `/api/products/${productId}/scheduled-image-publishes?status=ALL`)
    if (!res.ok) { setError(res.message); return }
    setRows(res.data?.rows ?? [])
    setEnabled(res.data?.executionEnabled)
    setError(null)
  }, [productId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setTarget(channel) }, [channel])

  // Until the server has answered, nothing is claimed either way.
  const known = enabled !== undefined
  const summary = useMemo(
    () => (rows ? summariseSchedules(rows, enabled === true) : null),
    [rows, enabled],
  )
  const notice = known ? executionNotice(enabled === true, summary?.pending ?? 0) : null

  return (
    <section className={styles.truth}>
      <header className={styles.head}>
        <h3 className={styles.truthTitle}>Scheduled publishes</h3>
        {summary && summary.total > 0 && <span className={styles.count}>{summary.total}</span>}
        {summary && summary.stranded > 0 && (
          <Pill tone="danger">{summary.stranded} will never run</Pill>
        )}
        {summary && summary.overdue > 0 && enabled === true && (
          <Pill tone="warning">{summary.overdue} overdue</Pill>
        )}
      </header>

      {error && <p className={styles.warning} role="alert">{error}</p>}
      {!known && !error && <p className={styles.pickerState}>Checking whether scheduling is running…</p>}

      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {known && rows && rows.length > 0 && (
        <div className={styles.jobList}>
          {rows.map((r) => {
            const s = readSchedule(r, enabled === true)
            return (
              <div key={r.id} className={styles.jobRow} title={s.note ?? undefined}>
                <Pill tone={STATE_TONE[s.state] ?? 'neutral'}>{s.label}</Pill>
                <span className={styles.jobChannel}>
                  {r.channel}{r.marketplace ? ` · ${r.marketplace}` : ''}
                </span>
                <span className={styles.jobWhen}>{new Date(r.scheduledFor).toLocaleString()}</span>
                <span className={styles.jobRef}>{r.firedAt ? 'fired' : '—'}</span>
                <span className={r.fireError ? styles.jobErr : styles.auditLabel}>
                  {r.fireError ?? s.note ?? ''}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/*
        The form stays visible when execution is off. Hiding it would remove the only place the
        capability is described, and an operator would have no way to learn it exists at all.
      */}
      <div className={styles.scheduleForm}>
        <Select
          size="sm"
          aria-label="Channel to publish"
          value={target}
          disabled={enabled !== true}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="AMAZON">Amazon{marketplace ? ` · ${marketplace}` : ''}</option>
          <option value="EBAY">eBay</option>
          <option value="SHOPIFY">Shopify</option>
        </Select>
        <Input
          size="sm"
          type="datetime-local"
          aria-label="When to publish"
          value={when}
          disabled={enabled !== true}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Button size="sm" variant="secondary" disabled={enabled !== true || !when}>
          Schedule
        </Button>
        {enabled === false && (
          // Beside the control, not inside a tooltip on a disabled element that never fires one.
          <span className={styles.formReason}>
            Disabled because nothing on this deployment would fire the schedule.
          </span>
        )}
      </div>
    </section>
  )
}
