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
 * WHAT THE ENDPOINT ACTUALLY RETURNS — read before relabelling anything here. All three of these
 * were wrong in the first cut of this component, and every one of them would have rendered a
 * plausible number under a false caption:
 *
 *   · `totalRuns` is NOT evaluations. The query filters `status IN ('SUCCESS','PARTIAL')`, so ticks
 *     that matched nothing (`NO_MATCH`) are absent. It is "runs that did something", which makes
 *     "evaluations run" an overstatement of engine activity, not an understatement.
 *   · `rules[]` is built by grouping those executions, so its length is "rules that RAN in the
 *     window", not the size of the fleet. The tab bar above renders counts from
 *     `/automation-rules` — every rule that EXISTS — so captioning this denominator as the fleet
 *     puts two disagreeing totals on one screen.
 *   · The query does not filter `dryRun`, and a dry-run execution can carry status SUCCESS (that is
 *     exactly what RuleListTab renders as "Proposed"). So these counts mix things that were written
 *     with things that were only proposed. ACR keeps finding this same collapse of intent and
 *     delivery, so the caption says so rather than implying every count reached Amazon.
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

  /**
   * A FAILURE AND A ZERO ARE DIFFERENT, AND THIS USED TO CONFLATE THEM.
   *
   * The first cut returned `null` whenever the fetch failed OR the payload was unusable, reasoning
   * that a zeroed banner reads as "the fleet did nothing". The zero half of that is right. The
   * failure half hid a real defect: `/automation-analytics` was throwing on every single call
   * (`domain` filtered on the execution instead of the rule), and because this component rendered
   * nothing, prod looked merely empty rather than broken. It took a schema read to find it.
   *
   * So: a failure now says it failed, quietly and in one line. Silence is not success.
   */
  if (failed || !data) {
    return (
      <div className="h10-imp h10-imp-off" role="status">
        Fleet impact unavailable — the automation-analytics endpoint did not return usable data.
        The rules below are unaffected.
      </div>
    )
  }

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
        <span className="h10-imp-s" title="Bids, negatives and guards the rule engine recorded. Includes dry-run proposals — a rule on dry-run still reports what it would have done.">
          <b>{intl(changes)}</b><i>actions recorded</i>
        </span>
        <span className="h10-imp-s" title="Executions that finished SUCCESS or PARTIAL. Ticks that matched nothing are not counted here.">
          <b>{intl(data.totalRuns)}</b><i>runs that acted</i>
        </span>
        <span className="h10-imp-s"><b>{intl(t.bids)}</b><i>bids adjusted</i></span>
        <span className="h10-imp-s"><b>{intl(t.negated)}</b><i>terms negated</i></span>
        <span className="h10-imp-s"><b>{intl(t.guarded)}</b><i>campaigns guarded</i></span>
        <span className="h10-imp-s" title="Of the rules that ran in this window — not of every rule you have. The tab counts above are the full fleet.">
          <b>{intl(active.length)}<em> / {intl(data.rules.length)}</em></b><i>of the rules that ran</i>
        </span>
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
