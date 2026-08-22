'use client'

/**
 * RPT.9 — pipeline health.
 *
 * Every other reporting surface measures the DATA. This measures the machinery
 * that produces it, because they fail differently: a report can be perfectly
 * correct about a feed that stopped a month ago. That is not hypothetical — the
 * AMS hourly ingest was rejected at the door for a month while every table that
 * read from it looked healthy.
 *
 * Two columns that look redundant and are not: "last data" is the newest day
 * held, "last run" is the last time the job fired. A job can succeed and bring
 * back nothing, and only the gap between those two shows it.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { fetchPipelineHealth, type FeedHealth, type FeedStatus, type PipelineHealth } from './pipeline-api'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

// The `Icon` on each of these was never rendered — the table always drew a Pill. Dropped
// rather than carried, along with the two lucide imports that existed only to feed it.
const STATUS: Record<FeedStatus, { label: string; tone: Tone }> = {
  ok: { label: 'OK', tone: 'success' },
  late: { label: 'Late', tone: 'warning' },
  failing: { label: 'Failing', tone: 'danger' },
  idle: { label: 'Idle', tone: 'neutral' },
  never: { label: 'No data ever', tone: 'danger' },
}

const ago = (iso: string | null) => {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/**
 * R7 — the feed table's columns, for the shared grid.
 *
 * "Last data" and "Last run" look redundant and are not: the first is the newest day held,
 * the second is the last time the job fired. A job can succeed and bring back nothing, and
 * only the gap between the two shows it — which is how the AMS hourly ingest sat rejected at
 * the door for a month while every table reading from it looked healthy.
 */
const feedColumns: GridColumn<FeedHealth>[] = [
  {
    key: 'status', label: 'Status', metric: false,
    sortValue: (f) => ['failing', 'never', 'late', 'idle', 'ok'].indexOf(f.status),
    render: (f) => <Pill tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Pill>,
  },
  {
    key: 'lastData', label: 'Last data', metric: false,
    sortValue: (f) => f.lastDataDay,
    render: (f) => f.lastDataDay ?? '—',
  },
  {
    key: 'lag', label: 'Lag',
    tip: 'Days between the newest row held and today. Judged against this feed’s own cadence, not one global threshold.',
    sortValue: (f) => f.lagDays,
    render: (f) => (f.lagDays == null ? '—' : `${f.lagDays}d`),
  },
  {
    key: 'rows', label: 'Rows',
    sortValue: (f) => f.rows,
    render: (f) => f.rows.toLocaleString('en-GB'),
  },
  {
    key: 'cadence', label: 'Cadence', metric: false,
    sortValue: (f) => f.cadence,
    render: (f) => f.cadence,
  },
  {
    key: 'lastRun', label: 'Last run', metric: false,
    sortValue: (f) => f.lastRunAt,
    render: (f) => (
      <>{ago(f.lastRunAt)}{f.recentFailures > 0 && <> · <b>{f.recentFailures} failed</b></>}</>
    ),
  },
  {
    key: 'cron', label: 'Cron', metric: false,
    sortValue: (f) => f.cronJob,
    render: (f) => f.cronJob ?? '—',
  },
]

export function PipelineClient() {
  const [h, setH] = useState<PipelineHealth | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchPipelineHealth(ac.signal)
      .then((x) => { setH(x); setErr(null) })
      .catch((e: unknown) => { if ((e as Error).name !== 'AbortError') setErr((e as Error).message) })
      .finally(() => { if (!ac.signal.aborted) setLoading(false) })
    return () => ac.abort()
  }, [nonce])

  return (
    <div className="rpt">
      <AdsPageHeader
        title="Ingest & job health"
        subtitle="Did every feed land, how late is it, and what failed. Lateness is judged against each feed's own cadence, not one global threshold."
        markets={[]} market="all" onMarketChange={() => {}}
        showDateRange={false}
        showDataSync syncing={loading} onDataSync={reload}
      />

      <Link href="/marketing/ads/reporting" className="rpt-back">
        <ArrowLeft size={14} aria-hidden /> All reports
      </Link>

      {err && <div className="rpt-lede is-error"><AlertTriangle size={16} aria-hidden /><span>{err}</span></div>}

      {/* Ranked above the feed alerts: a late feed is a delay, but two feeds
          disagreeing about whether money moved is a defect. This is the check
          that would have surfaced the Italy outage in a day rather than a month. */}
      {h && h.contradictions.length > 0 && (
        <div className="rpt-lede is-error">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>
              {h.contradictions.length} contradiction{h.contradictions.length === 1 ? '' : 's'} between feeds.
            </b>{' '}
            Two independent sources disagree — one of them is wrong.
            <ul className="rpt-alerts">
              {h.contradictions.map((c) => (
                <li key={`${c.kind}-${c.marketplace}-${c.date}`}>
                  <b>{c.marketplace} {c.date}</b> — {c.detail}
                </li>
              ))}
            </ul>
          </span>
        </div>
      )}

      {h && h.alerts.length > 0 && (
        <div className="rpt-lede is-warn">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>{h.alerts.length} feed{h.alerts.length === 1 ? '' : 's'} need attention.</b>
            <ul className="rpt-alerts">{h.alerts.map((a) => <li key={a}>{a}</li>)}</ul>
          </span>
        </div>
      )}
      {h && h.alerts.length === 0 && h.contradictions.length === 0 && (
        <div className="rpt-lede">
          <CheckCircle2 size={16} aria-hidden />
          <span>Every feed is landing within its expected cadence, and no two feeds disagree.</span>
        </div>
      )}

      <AdsDataGrid<FeedHealth>
        rows={h?.feeds ?? []}
        loading={loading && !h}
        rowId={(f) => f.id}
        noun="Feed"
        firstColLabel="Feed"
        firstSortValue={(f) => f.label}
        /* 🔴 `td.nm` is the campaigns grid's FLEX name cell, so two sibling spans would sit
           side by side and the source line would run into the Status pill — which is exactly
           what happened when this page first tried it. A flex-column wrapper capped at 100%
           stacks them; no width is guessed, because `td.nm`'s 360px belongs to ads.css. */
        renderFirst={(f) => (
          <span className="rpt-feed">
            <span className="fl">{f.label}</span>
            <span className="fs">{f.source}</span>
          </span>
        )}
        columns={feedColumns}
        selectable={false}
        showTotal={false}
        storageKey="rpt-pipeline-cols"
        emptyLabel="No feeds configured."
        toolbarLeft={h ? <span className="rpt-meta-note">checked {ago(h.asOf)} · {h.elapsedMs} ms</span> : undefined}
      />

      {h && (
        <div className="rpt-biz">
          <div className="rpt-biz-top">
            <div className="rpt-biz-kpi">
              <span className="lbl">Report jobs</span>
              <span className="val">{h.jobs.reportJobs.reduce((s, j) => s + j.n, 0).toLocaleString('en-GB')}</span>
              <span className="sub">{h.jobs.reportJobs.map((j) => `${j.n.toLocaleString('en-GB')} ${j.status.toLowerCase()}`).join(' · ')}</span>
            </div>
            <div className="rpt-biz-kpi">
              <span className="lbl">Export download failures</span>
              <span className="val">{h.jobs.exportFailures.total.toLocaleString('en-GB')}</span>
              <span className="sub">{h.jobs.exportFailures.recoverable} still recoverable</span>
            </div>
            <div className="rpt-biz-kpi">
              <span className="lbl">Runs without a row count</span>
              <span className="val">{h.jobs.reportRunsMissingRowCount.total.toLocaleString('en-GB')}</span>
              <span className="sub">historic only — new runs record one</span>
            </div>
          </div>
          <ul className="rpt-biz-caveats">
            <li>{h.jobs.exportFailures.note}</li>
            <li>{h.jobs.reportRunsMissingRowCount.note}</li>
            {(h.feeds.filter((f) => f.note)).map((f) => <li key={f.id}><b>{f.label}:</b> {f.note}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}
