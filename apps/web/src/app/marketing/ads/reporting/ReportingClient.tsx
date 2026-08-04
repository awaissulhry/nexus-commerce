'use client'

/**
 * RPT.1/RPT.2 — the Reporting landing page.
 *
 * Reporting owns the DATA layer of the ads console: which reports exist, what
 * each is made of, how to get it out, and whether the pipeline feeding it is
 * healthy. Interpretation — coverage, funnel, n-grams, momentum — belongs to
 * Analytics next door. (Operator decision, 2026-08-04.)
 *
 * RPT.2 made the library live. Every card now shows measured rows, the window it
 * spans, and freshness PER MARKET — because RPT.0 found Italy, the primary market
 * and 52% of all rows, running six to seven days behind Germany and France while
 * the single overall "as of" read two days and hid it completely.
 *
 * The state badge is derived (catalogue.ts → deriveState), never hard-coded, so
 * this page cannot drift from the database.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Info, RefreshCw, AlertTriangle, ArrowRight } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { Pill } from '@/design-system/primitives/Pill'
import {
  REPORT_CATALOGUE,
  REPORT_GROUPS,
  STATE_META,
  deriveState,
  type ReportEntry,
} from './catalogue'
import { RUNNABLE_REPORT_IDS } from './runnable'
import { SchedulesPanel } from './SchedulesPanel'
import { BusinessContextPanel } from './BusinessContextPanel'
import {
  fetchReportingCoverage,
  fmtInt,
  fmtLag,
  fmtWindow,
  type ReportingCoverage,
} from './coverage'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './reporting.css'

/** States meaning "you cannot rely on this report today". */
const UNAVAILABLE = new Set(['not-ingested', 'blocked'])

function ReportCard({
  entry,
  coverage,
}: {
  entry: ReportEntry
  coverage: ReportingCoverage | null
}) {
  const derived = deriveState(entry, coverage)
  const meta = STATE_META[derived.state]
  // A report opens only when the engine has a spec for it AND there is something
  // to show: "Not ingested" and "Blocked" cards would open an empty grid.
  const runnable = RUNNABLE_REPORT_IDS.includes(entry.id) && !UNAVAILABLE.has(derived.state)
  const cov = entry.coverageKey && coverage ? coverage.reports[entry.coverageKey] : undefined
  const window = cov ? fmtWindow(cov.firstDay, cov.lastDay) : null

  return (
    <article className={`rpt-card${UNAVAILABLE.has(derived.state) ? ' is-unavailable' : ''}`}>
      <div className="rpt-card-hd">
        {/* Only reports the runner can actually execute are links. A dead link on
            a "Not ingested" card would promise data that does not exist. */}
        {runnable ? (
          <h3>
            <Link href={`/marketing/ads/reporting/${entry.id}`} className="rpt-open">
              {entry.title}
              <ArrowRight size={13} aria-hidden />
            </Link>
          </h3>
        ) : (
          <h3>{entry.title}</h3>
        )}
        <Pill tone={meta.tone}>{meta.label}</Pill>
      </div>
      <p className="rpt-answers">{entry.answers}</p>

      {/* Measured facts. Absent entirely rather than shown as zeros while loading. */}
      {cov && cov.rows > 0 && (
        <div className="rpt-stats">
          <span className="rpt-stat">
            <b>{fmtInt(cov.rows)}</b> rows
          </span>
          {window && (
            <span className="rpt-stat">
              <b>{cov.days}</b> {entry.cadence === 'weekly' ? 'weeks' : 'days'} · {window}
            </span>
          )}
        </div>
      )}

      {/* Per-market freshness — the whole point of RPT.2. Ordered by row count so
          the market that matters most is read first. */}
      {cov && cov.byMarket.length > 0 && (
        <div className="rpt-markets">
          {cov.byMarket.map((m) => (
            <span
              key={m.marketplace}
              className={`rpt-mkt${
                // Amber means "this market is genuinely behind for its cadence",
                // not "this market is the worst of the four". Placement is sparse
                // on density while every market is 2 days old — painting Italy
                // amber there would invent a freshness problem that isn't real.
                derived.state === 'sparse' &&
                m.lagDays != null &&
                m.lagDays > derived.staleAfterDays
                  ? ' is-lagging'
                  : ''
              }`}
              title={`${m.marketplace}: ${fmtInt(m.rows)} rows, newest ${fmtLag(m.lagDays)}`}
            >
              <span className="code">{m.marketplace}</span>
              <span className="lag">{fmtLag(m.lagDays)}</span>
            </span>
          ))}
        </div>
      )}

      <dl className="rpt-meta">
        <div>
          <dt>Source</dt>
          <dd>{entry.source}</dd>
        </div>
        <div>
          <dt>Grain</dt>
          <dd>{entry.grain}</dd>
        </div>
      </dl>

      {(derived.reason || entry.note) && (
        <p className="rpt-note">
          {derived.reason && <span className="rpt-reason">{derived.reason}</span>}
          {derived.reason && entry.note ? ' ' : null}
          {entry.note}
        </p>
      )}
    </article>
  )
}

/** The Pipeline card is about jobs, not rows, so it reads different numbers. */
function PipelineExtras({ coverage }: { coverage: ReportingCoverage | null }) {
  if (!coverage) return null
  const { pipeline } = coverage
  const totalJobs = pipeline.reportJobs.reduce((s, j) => s + j.jobs, 0)
  const failed = pipeline.reportJobs
    .filter((j) => j.status !== 'COMPLETED')
    .reduce((s, j) => s + j.jobs, 0)
  const zeroRowTypes = pipeline.reportTypes.filter((t) => t.rowsIngested === 0)

  return (
    <div className="rpt-stats">
      <span className="rpt-stat"><b>{fmtInt(totalJobs)}</b> report jobs</span>
      <span className="rpt-stat"><b>{fmtInt(failed)}</b> not completed</span>
      <span className="rpt-stat"><b>{fmtInt(pipeline.exportJobFailures)}</b> export download failures</span>
      {zeroRowTypes.length > 0 && (
        <span className="rpt-stat">
          <b>{zeroRowTypes.length}</b> report {zeroRowTypes.length === 1 ? 'type' : 'types'} returning nothing
        </span>
      )}
    </div>
  )
}

export function ReportingClient() {
  const [coverage, setCoverage] = useState<ReportingCoverage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    fetchReportingCoverage(ac.signal)
      .then((c) => {
        setCoverage(c)
        setError(null)
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return
        // Never blank the catalogue on a failed fetch — the structural half of
        // the page is still true and useful without live numbers.
        setError((e as Error).message)
      })
      .finally(() => setLoading(false))
    return () => ac.abort()
  }, [nonce])

  return (
    <div className="rpt">
      <AdsPageHeader
        title="Reporting"
        subtitle="Every ads number this console can produce — where it comes from, how fresh it is, and how to get it out."
        markets={[]}
        market="all"
        onMarketChange={() => {}}
        showLearn={false}
        showDataSync
        syncing={loading}
        onDataSync={reload}
        showDateRange={false}
      />

      <div className="rpt-lede">
        <Info size={16} aria-hidden />
        <span>
          <b>An empty report is not automatically a broken one.</b> Where a report has no
          rows because nothing of that type is running, it is marked idle rather than
          failed — and where it is genuinely unavailable, the card says why.
        </span>
      </div>

      {error && (
        <div className="rpt-lede is-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Live coverage unavailable.</b> {error}. The catalogue below is still
            accurate, but the row counts and freshness are missing.{' '}
            <button type="button" className="rpt-retry" onClick={reload}>
              <RefreshCw size={12} aria-hidden /> Retry
            </button>
          </span>
        </div>
      )}

      {coverage?.warnings.length ? (
        <div className="rpt-lede is-warn" role="status">
          <AlertTriangle size={16} aria-hidden />
          <span>
            <b>Some coverage could not be measured.</b> {coverage.warnings.join(' · ')}
          </span>
        </div>
      ) : null}

      <BusinessContextPanel />

      {REPORT_GROUPS.map((group) => {
        const entries = REPORT_CATALOGUE.filter((r) => r.group === group)
        if (!entries.length) return null
        return (
          <section key={group} className="rpt-group">
            <h2 className="rpt-group-hd">
              {group} <span className="count">{entries.length}</span>
            </h2>
            <div className="rpt-grid">
              {entries.map((entry) =>
                entry.id === 'pipeline' ? (
                  <article key={entry.id} className="rpt-card">
                    <div className="rpt-card-hd">
                      <h3>
                        <Link href="/marketing/ads/reporting/pipeline" className="rpt-open">
                          {entry.title}
                          <ArrowRight size={13} aria-hidden />
                        </Link>
                      </h3>
                      <Pill tone={STATE_META.ready.tone}>{STATE_META.ready.label}</Pill>
                    </div>
                    <p className="rpt-answers">{entry.answers}</p>
                    <PipelineExtras coverage={coverage} />
                    <dl className="rpt-meta">
                      <div>
                        <dt>Source</dt>
                        <dd>{entry.source}</dd>
                      </div>
                      <div>
                        <dt>Grain</dt>
                        <dd>{entry.grain}</dd>
                      </div>
                    </dl>
                    <p className="rpt-note">
                      Two known defects to fix at the source: report runs never record a
                      row count, and signed-URL downloads keep failing.
                    </p>
                  </article>
                ) : (
                  <ReportCard key={entry.id} entry={entry} coverage={coverage} />
                ),
              )}
            </div>
          </section>
        )
      })}

      <SchedulesPanel />

      <div className="rpt-next">
        <h3>What lands here next</h3>
        <ol>
          <li>
            <b>A live Google Sheet</b> — bound to a saved report and refreshed on a schedule.
          </li>
          <li>
            <b>Custom metrics and a dashboard canvas</b> — define your own formulas and
            arrange saved reports as tiles.
          </li>
          <li>
            <b>Bring data in</b> — import the Amazon console reports the API will not give,
            with a row-by-row preview before anything is written.
          </li>
        </ol>
      </div>
    </div>
  )
}
