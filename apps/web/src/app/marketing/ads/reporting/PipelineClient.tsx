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
import { ArrowLeft, AlertTriangle, CheckCircle2, Clock, XCircle } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'
import { fetchPipelineHealth, type FeedStatus, type PipelineHealth } from './pipeline-api'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

const STATUS: Record<FeedStatus, { label: string; tone: Tone; Icon: typeof CheckCircle2 }> = {
  ok: { label: 'OK', tone: 'success', Icon: CheckCircle2 },
  late: { label: 'Late', tone: 'warning', Icon: Clock },
  failing: { label: 'Failing', tone: 'danger', Icon: XCircle },
  idle: { label: 'Idle', tone: 'neutral', Icon: Clock },
  never: { label: 'No data ever', tone: 'danger', Icon: XCircle },
}

const ago = (iso: string | null) => {
  if (!iso) return '—'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

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
        showLearn={false} showDateRange={false}
        showDataSync syncing={loading} onDataSync={reload}
      />

      <Link href="/marketing/ads/reporting" className="rpt-back">
        <ArrowLeft size={14} aria-hidden /> All reports
      </Link>

      {err && <div className="rpt-lede is-error"><AlertTriangle size={16} aria-hidden /><span>{err}</span></div>}

      {h && h.alerts.length > 0 && (
        <div className="rpt-lede is-warn">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>{h.alerts.length} feed{h.alerts.length === 1 ? '' : 's'} need attention.</b>
            <ul className="rpt-alerts">{h.alerts.map((a) => <li key={a}>{a}</li>)}</ul>
          </span>
        </div>
      )}
      {h && h.alerts.length === 0 && (
        <div className="rpt-lede"><CheckCircle2 size={16} aria-hidden /><span>Every feed is landing within its expected cadence.</span></div>
      )}

      <div className="h10-am-card">
        <div className="h10-am-toolbar">
          <span className="cnt">{h ? <><b>{h.feeds.length}</b> feeds</> : 'Loading…'}</span>
          {h && <span className="rpt-meta-note">checked {ago(h.asOf)} · {h.elapsedMs} ms</span>}
        </div>
        <div className="h10-am-grid">
          <table>
            <thead>
              <tr>
                <th>Feed</th><th>Status</th><th>Last data</th><th className="num">Lag</th>
                <th className="num">Rows</th><th>Cadence</th><th>Last run</th><th>Cron</th>
              </tr>
            </thead>
            <tbody>
              {(h?.feeds ?? []).map((f) => {
                const s = STATUS[f.status]
                return (
                  <tr key={f.id}>
                    {/* Deliberately NOT td.nm — that is the campaigns grid's flex
                        name-cell, whose inline badge does not shrink and was
                        overflowing across the Status pill. Two stacked lines
                        instead, which also reads better at this density. */}
                    <td className="rpt-feed">
                      <span className="t">{f.label}</span>
                      <span className="s">{f.source}</span>
                    </td>
                    <td><Pill tone={s.tone}>{s.label}</Pill></td>
                    <td>{f.lastDataDay ?? '—'}</td>
                    <td className="num">{f.lagDays == null ? '—' : `${f.lagDays}d`}</td>
                    <td className="num">{f.rows.toLocaleString('en-GB')}</td>
                    <td>{f.cadence}</td>
                    <td>{ago(f.lastRunAt)}{f.recentFailures > 0 && <> · <b>{f.recentFailures} failed</b></>}</td>
                    <td>{f.cronJob ?? '—'}</td>
                  </tr>
                )
              })}
              {h?.feeds.some((f) => f.note) && null}
            </tbody>
          </table>
        </div>
      </div>

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
