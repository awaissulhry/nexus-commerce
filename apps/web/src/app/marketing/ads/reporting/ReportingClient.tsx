'use client'

/**
 * RPT.1/RPT.2 · R1 — the Reporting landing page: one grid of every report.
 *
 * This was thirteen documentation cards in a four-column grid. Measured on prod it stood
 * 2,736px tall — three viewports to choose one report — with 104–124px of blank inside the
 * top-row cards and 1,840px of empty grid cells below, because a group of one or two cards
 * still claims a row of four. Every card also carried Source and Grain: the Amazon job name
 * and the SQL row grain, which describe how a report is BUILT and answer nothing an operator
 * asks when picking one.
 *
 * So the library is now a list, rendered through `AdsDataGrid` — the same grid the other
 * fifty-four grids in this console use, grouped by the same five headings the catalogue
 * already had. Change that grid once and this page follows.
 *
 * Nothing measured was dropped, only moved out of the way:
 *   • the state badge and its reason are still derived live (catalogue.ts → deriveState), so
 *     the page still cannot drift from the database, and "idle" still reads differently from
 *     "broken" — that distinction is the whole reason `state` exists;
 *   • per-market freshness is still per-market, because a single overall "as of" is exactly
 *     what hid Italy running a week behind Germany;
 *   • Source, Grain, cadence and the standing caveats moved into the row's ⓘ hover, which is
 *     the console's own HoverCard, so they cost no vertical space until asked for.
 *
 * What did NOT move into that hover is the one line saying what each report answers. A
 * chooser whose every entry has to be hovered before you know what it is has not been
 * simplified, only emptied — so that line kept a column of its own.
 *
 * Business context and incrementality left this page for the campaign report: they are
 * analysis, and they were pushing the list they sat above off the first screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { RefreshCw, AlertTriangle, Info } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../campaigns/_grid/AdsDataGrid'
import { HoverCard } from '../campaigns/FilterDropdown'
import { Pill } from '@/design-system/primitives/Pill'
import { Button } from '@/design-system/primitives/Button'
import {
  REPORT_CATALOGUE,
  REPORT_GROUPS,
  STATE_META,
  deriveState,
  type ReportEntry,
  type ReportState,
} from './catalogue'
import { RUNNABLE_REPORT_IDS } from './runnable'
import { TodayBand } from './TodayBand'
import { DeliveriesModal } from './DeliveriesModal'
import { listSchedules, type Schedule } from './schedules-api'
import {
  fetchReportingCoverage,
  fmtInt,
  fmtWindow,
  type ReportingCoverage,
} from './coverage'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

/** States meaning "you cannot rely on this report today". */
const UNAVAILABLE = new Set<ReportState>(['not-ingested', 'blocked'])

/** Sort order for the Status column: worst first, so a click surfaces what needs attention. */
const STATE_RANK: Record<ReportState, number> = {
  blocked: 0, 'not-ingested': 1, sparse: 2, idle: 3, ready: 4, unknown: 5,
}

/** "1d" · "today" · "—". The long form ("8 days old") does not fit four markets in one cell. */
function lagShort(lagDays: number | null): string {
  if (lagDays == null) return '—'
  return lagDays <= 0 ? 'today' : `${lagDays}d`
}

/** One row of the library: the catalogue entry plus everything derived from live coverage. */
interface Row {
  entry: ReportEntry
  state: ReportState
  reason: string | null
  staleAfterDays: number
  runnable: boolean
  href: string | null
  rows: number | null
  unit: string
  periods: number | null
  window: string | null
  markets: Array<{ marketplace: string; lagDays: number | null; rows: number; lagging: boolean }>
}

export function ReportingClient() {
  const [coverage, setCoverage] = useState<ReportingCoverage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  /**
   * R6 — the schedules panel left this page, and with it the only place a FAILING schedule
   * showed. A scheduled report that has quietly stopped is worse than no report, because it is
   * believed — so the signal stays, inverted: nothing at all while every delivery is healthy,
   * one line the moment one is not. Deliveries are otherwise managed from the report itself.
   */
  const [ailing, setAiling] = useState<Schedule[]>([])
  const [deliveriesOpen, setDeliveriesOpen] = useState(false)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchReportingCoverage(ac.signal)
      .then((c) => { setCoverage(c); setError(null) })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return
        // Never blank the catalogue on a failed fetch — the structural half of the
        // page is still true and useful without live numbers.
        setError((e as Error).message)
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [nonce])

  useEffect(() => {
    let dead = false
    listSchedules()
      .then((all) => {
        if (dead) return
        setAiling(all.filter((s) => s.isActive && s.lastDelivery
          && (s.lastDelivery.status === 'FAILED' || !!s.lastDelivery.staleNote)))
      })
      .catch(() => { /* a health hint must never break the page it sits on */ })
    return () => { dead = true }
  }, [nonce])

  const rows: Row[] = useMemo(() => REPORT_CATALOGUE.map((entry) => {
    const d = deriveState(entry, coverage)
    const cov = entry.coverageKey && coverage ? coverage.reports[entry.coverageKey] : undefined

    // The Pipeline row counts jobs, not report rows — so the cell names its own unit
    // rather than letting a job count read as a row count.
    const isPipeline = entry.id === 'pipeline'
    const jobs = coverage?.pipeline.reportJobs.reduce((s, j) => s + j.jobs, 0) ?? null

    return {
      entry,
      state: d.state,
      reason: d.reason,
      staleAfterDays: d.staleAfterDays,
      // A report opens only when the engine has a spec for it AND there is something to
      // show: "Not ingested" and "Blocked" would open an empty grid.
      // NAV.1 — a report that lives elsewhere is openable on its own terms: it has a
      // destination, so the "is there a spec and is there data" test does not apply.
      runnable: !!entry.externalHref || isPipeline
        || (RUNNABLE_REPORT_IDS.includes(entry.id) && !UNAVAILABLE.has(d.state)),
      href: entry.externalHref
        ?? (isPipeline
          ? '/marketing/ads/reporting/pipeline'
          : RUNNABLE_REPORT_IDS.includes(entry.id) && !UNAVAILABLE.has(d.state)
            ? `/marketing/ads/reporting/${entry.id}`
            : null),
      // A report we never request from Amazon has no measurement — not a measurement of
      // zero. The coverage row exists and reads `rows: 0`, but rendering that as "0 rows"
      // says we looked and found nothing, when nobody ever looked. Same rule the engine
      // holds to everywhere else: null is never 0. The "Not ingested" pill carries it.
      rows: isPipeline ? jobs : (entry.ingested === false ? null : (cov?.rows ?? null)),
      unit: isPipeline ? 'jobs' : 'rows',
      periods: isPipeline || entry.ingested === false ? null : (cov?.days ?? null),
      window: cov && entry.ingested !== false ? fmtWindow(cov.firstDay, cov.lastDay) : null,
      markets: (entry.ingested === false ? [] : cov?.byMarket ?? []).map((m) => ({
        marketplace: m.marketplace,
        lagDays: m.lagDays,
        rows: m.rows,
        // Amber means "this market is genuinely behind for its cadence", not "this market
        // is the worst of the four" — otherwise a healthy 2-day-old Italy is painted amber
        // on a report that is sparse for an entirely different reason.
        lagging: d.state === 'sparse' && m.lagDays != null && m.lagDays > d.staleAfterDays,
      })),
    }
  }), [coverage])

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'answers',
      label: 'Answers',
      metric: false,
      // The one line worth keeping from the old card. Source and Grain describe how a
      // report is built; THIS is the question it settles, and without it a list of
      // thirteen titles is a list you have to hover to read.
      sortValue: (r) => r.entry.answers,
      render: (r) => <span className="rpt-ans">{r.entry.answers}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      metric: false,
      tip: 'A report with no rows is not automatically a broken one. Where nothing of that type is running, it reads Idle rather than failed — and where it is genuinely unavailable, the row says why.',
      sortValue: (r) => STATE_RANK[r.state],
      render: (r) => {
        const meta = STATE_META[r.state]
        return <Pill tone={meta.tone}>{meta.label}</Pill>
      },
    },
    {
      key: 'volume',
      label: 'Volume',
      tip: 'How much data this report holds today. The pipeline row counts jobs; every other row counts data rows.',
      sortValue: (r) => r.rows,
      render: (r) => (r.rows == null
        ? <span className="rpt-dash">—</span>
        : <span className="rpt-vol"><b>{fmtInt(r.rows)}</b> <span className="u">{r.unit}</span></span>),
    },
    {
      key: 'period',
      label: 'Period covered',
      metric: false,
      sortValue: (r) => r.periods,
      render: (r) => (r.window == null
        ? <span className="rpt-dash">—</span>
        : (
          <span className="rpt-period">
            {r.periods != null && (
              <b>{r.periods} {r.entry.cadence === 'weekly' ? (r.periods === 1 ? 'week' : 'weeks') : (r.periods === 1 ? 'day' : 'days')}</b>
            )}
            <span className="w">{r.window}</span>
          </span>
        )),
    },
    {
      key: 'freshness',
      label: 'Freshness by market',
      metric: false,
      tip: 'How old the newest row is, per market. Judged against this report’s own cadence — a 16-day-old weekly feed is healthy, a 3-day-old daily one is not.',
      // The WORST market, not the overall figure: the single overall "as of" is what hid
      // Italy — 52% of all rows — running six days behind Germany.
      sortValue: (r) => r.markets.reduce<number | null>(
        (w, m) => (m.lagDays != null && (w == null || m.lagDays > w) ? m.lagDays : w), null),
      render: (r) => (r.markets.length === 0
        ? <span className="rpt-dash">—</span>
        : (
          <span className="rpt-markets">
            {r.markets.map((m) => (
              <span
                key={m.marketplace}
                className={`rpt-mkt${m.lagging ? ' is-lagging' : ''}`}
                title={`${m.marketplace}: ${fmtInt(m.rows)} rows`}
              >
                <span className="code">{m.marketplace}</span>
                <span className="lag">{lagShort(m.lagDays)}</span>
              </span>
            ))}
          </span>
        )),
    },
  ], [])

  return (
    <div className="rpt">
      <AdsPageHeader
        title="Reporting"
        subtitle="Every ads number this console can produce."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showDataSync
        syncing={loading}
        onDataSync={reload}
        showDateRange={false}
      />

      {error && (
        <div className="rpt-lede is-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Live coverage unavailable.</b> {error}. Every report is still listed, but the
            volumes and freshness are missing.{' '}
            <Button size="sm" onClick={reload}>
              <RefreshCw size={12} aria-hidden /> Retry
            </Button>
          </span>
        </div>
      )}

      {ailing.length > 0 && (
        <div className="rpt-lede is-warn" role="status">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>{ailing.length === 1 ? 'A scheduled report needs attention.' : `${ailing.length} scheduled reports need attention.`}</b>{' '}
            {ailing.map((s) => s.savedReportName).join(', ')} —{' '}
            {ailing[0].lastDelivery?.error ?? ailing[0].lastDelivery?.staleNote}{' '}
            <Button size="sm" onClick={() => setDeliveriesOpen(true)}>
              Manage deliveries
            </Button>
          </span>
        </div>
      )}

      <DeliveriesModal open={deliveriesOpen} onClose={() => setDeliveriesOpen(false)} />

      {coverage?.warnings.length ? (
        <div className="rpt-lede is-warn" role="status">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Some coverage could not be measured.</b> {coverage.warnings.join(' · ')}
          </span>
        </div>
      ) : null}

      {/* R5 — every report below runs a day behind; this one band does not. It reads the
          hourly stream, which is current to today in all four markets. */}
      <TodayBand />

      <AdsDataGrid<Row>
        rows={rows}
        loading={loading && !coverage}
        rowId={(r) => r.entry.id}
        noun="Report"
        firstColLabel="Report"
        firstSortValue={(r) => r.entry.title}
        renderFirst={(r) => (
          <span className="rpt-name">
            <span className="t">
              {r.href
                ? <Link href={r.href} className="rpt-open">{r.entry.title}</Link>
                : <span className="rpt-open is-off">{r.entry.title}</span>}
              {/* NAV.1 — say where it goes BEFORE the click, not after. A row that
                  silently navigates out of Reporting is the surprise this label exists
                  to remove. */}
              {r.entry.livesIn && <span className="rpt-elsewhere">↗ {r.entry.livesIn}</span>}
              {/* Source, grain, cadence and the standing caveat live here rather than on the
                  row: true, occasionally needed, and not worth the vertical space until asked. */}
              <HoverCard
                placement="below"
                delay={200}
                rows={[
                  ['Source', r.entry.source],
                  ['Grain', r.entry.grain],
                  ['Cadence', r.entry.cadence],
                  ...(r.entry.note ? [['Caveat', r.entry.note] as [string, string]] : []),
                ]}
              >
                <span className="rpt-i" aria-label={`About ${r.entry.title}`}><Info size={12} aria-hidden /></span>
              </HoverCard>
            </span>
            {/* Only where the state needs explaining — nine of thirteen rows stay one line. */}
            {r.reason && <span className="why">{r.reason}</span>}
          </span>
        )}
        columns={columns}
        groupBy={(r) => ({
          key: r.entry.group,
          label: r.entry.group,
          order: REPORT_GROUPS.indexOf(r.entry.group),
        })}
        selectable={false}
        showTotal={false}
        storageKey="rpt-library-cols"
        onRowClick={(r) => { if (r.href) window.location.assign(r.href) }}
        emptyLabel="No reports."
      />
    </div>
  )
}
