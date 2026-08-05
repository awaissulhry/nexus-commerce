'use client'

/**
 * ACR.6 (R2) — what the fleet actually did, above the fleet.
 *
 * The rules grid answers "what is configured". It cannot answer "and did any of it do anything",
 * which is the question an operator asks before trusting the next run. That answer existed on the
 * legacy `/marketing/advertising/automation/analytics` page — runs, terms negated, bids adjusted,
 * campaigns guarded, per rule, over a window — and nowhere in this console. Stage 6 would have
 * redirected the page away and taken the number with it.
 *
 * A strip rather than a page, and deliberately small: it belongs beside the rules it describes, and
 * the per-rule detail already exists one click away in each row's execution-history drawer.
 *
 * `totalRuns` counts evaluations, which is almost always far larger than the number of changes —
 * most ticks match nothing. That gap is the honest headline, so both numbers are shown rather than
 * the flattering one alone.
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface RuleAnalytics {
  name: string; runs: number; termsNegated: number; bidsAdjusted: number
  campaignsGuarded: number; lastRun: string
}
interface AnalyticsData { windowDays: number; totalRuns: number; rules: RuleAnalytics[] }

const WINDOWS = [7, 30, 90]
const intl = (n: number) => n.toLocaleString('en-IE')

export function RuleImpactStrip() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setFailed(false)
    fetch(`${getBackendUrl()}/api/advertising/automation-analytics?windowDays=${days}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setData(j && Array.isArray(j.rules) ? j : null) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [days])

  // A strip that cannot load its numbers should disappear, not sit there claiming zero — the grid
  // below is the page, and a broken banner above it would read as "the fleet did nothing".
  if (failed || !data) return null

  const t = data.rules.reduce(
    (a, r) => ({
      negated: a.negated + (r.termsNegated || 0),
      bids: a.bids + (r.bidsAdjusted || 0),
      guarded: a.guarded + (r.campaignsGuarded || 0),
    }),
    { negated: 0, bids: 0, guarded: 0 },
  )
  const changes = t.negated + t.bids + t.guarded
  const active = data.rules.filter((r) => (r.termsNegated || 0) + (r.bidsAdjusted || 0) + (r.campaignsGuarded || 0) > 0)
  const top = [...active]
    .sort((a, b) => (b.termsNegated + b.bidsAdjusted + b.campaignsGuarded) - (a.termsNegated + a.bidsAdjusted + a.campaignsGuarded))
    .slice(0, 3)

  return (
    <section className="h10-imp" aria-label="Automation impact">
      <div className="h10-imp-l">
        <span className="h10-imp-k">Fleet impact</span>
        <span className="h10-imp-seg" role="radiogroup" aria-label="Window">
          {WINDOWS.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </span>
      </div>

      <div className="h10-imp-n">
        <span className="h10-imp-s"><b>{intl(changes)}</b><i>change{changes === 1 ? '' : 's'} made</i></span>
        <span className="h10-imp-s"><b>{intl(data.totalRuns)}</b><i>evaluations run</i></span>
        <span className="h10-imp-s"><b>{intl(t.bids)}</b><i>bids adjusted</i></span>
        <span className="h10-imp-s"><b>{intl(t.negated)}</b><i>terms negated</i></span>
        <span className="h10-imp-s"><b>{intl(t.guarded)}</b><i>campaigns guarded</i></span>
        <span className="h10-imp-s"><b>{intl(active.length)}<em> / {intl(data.rules.length)}</em></b><i>rules that did something</i></span>
      </div>

      {top.length > 0 && (
        <div className="h10-imp-top">
          <span className="lbl">Most active</span>
          {top.map((r) => (
            <span className="h10-imp-r" key={r.name} title={`${intl(r.runs)} evaluations · last run ${r.lastRun ? new Date(r.lastRun).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : 'never'}`}>
              {r.name}<em>{intl(r.termsNegated + r.bidsAdjusted + r.campaignsGuarded)}</em>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
