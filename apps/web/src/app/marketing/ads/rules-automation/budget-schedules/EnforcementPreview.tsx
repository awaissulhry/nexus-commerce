'use client'

/**
 * BSP.1 — what the live pacing engine would do right now, for this market.
 *
 * `GET /advertising/budget-manager/enforcement` runs the SAME pure function the cron runs every 30
 * minutes, so this is a forecast of the engine rather than a second opinion about it. The endpoint
 * exists, is deployed, and until now was rendered nowhere.
 *
 * ── 🔴 The empty state is the whole point ──────────────────────────────────────────────────────
 *
 * Getting this wrong makes a working engine look broken, and that is the defect this programme
 * exists to remove. There are four distinct nothings and they are four different sentences:
 *
 *   nothing armed   the plan has neither autoPacing nor stopOverSpend, so `computeBudgetEnforcement`
 *                   does not return it at all (`:71` filters on `OR: [autoPacing, stopOverSpend]`).
 *                   NOT "no data" — nobody has switched anything on.
 *   armed, idle     the plan is armed and `pacingNeeded` is false, because pacing is CORRECTIVE:
 *                   `:113` is `autoPacing && cap > 0 && projected > cap`. Under cap ⇒ nothing to do.
 *                   This is "ran and did nothing", and it must say WHY, with the numbers.
 *   would act       there are campaign deltas — show them.
 *   broke           the fetch failed.
 *
 * On 2026-08-11 every market was under its cap and `budgetChanges` was 0 on every recent tick. The
 * honest sentence for that is not an empty panel.
 */

import { ArrowRight, Info } from 'lucide-react'
import type { EnforcementPlan, EnforcementResult } from './slot-contract'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const eur0 = (c: number) => `€${Math.round(c / 100).toLocaleString('en-IE')}`

const CLAMP_WHY: Record<string, string> = {
  min: 'held at its minimum',
  max: 'held at its maximum',
  floor: 'held at Amazon’s €1.00 floor',
}

export function EnforcementPreview({
  data, loading, error, marketplace, autoPacing, stopOverSpend, capCents, forecastCents,
}: {
  data: EnforcementResult | null
  loading: boolean
  error: string | null
  marketplace: string
  /** From the PLAN, so "nothing armed" can be distinguished from "the endpoint returned nothing". */
  autoPacing: boolean
  stopOverSpend: boolean
  capCents: number
  forecastCents: number | null
}) {
  if (loading) return <p className="h10-bsp-encalm">Checking what pacing would do…</p>

  if (error) {
    return (
      <p className="h10-bsp-note bad">
        <span><b>The enforcement preview could not be loaded.</b> {error}</span>
      </p>
    )
  }

  // ── nothing armed ──────────────────────────────────────────────────────────────────────────
  if (!autoPacing && !stopOverSpend) {
    return (
      <p className="h10-bsp-encalm">
        <b>Nothing is armed for {marketplace}.</b> Auto Pacing and Stop Over Spend are both off, so
        the pacing engine skips this market entirely. It is not watching this cap.
      </p>
    )
  }

  const plan: EnforcementPlan | undefined = data?.plans.find((p) => p.marketplace === marketplace)

  // Armed, but the engine did not return the plan — it only returns armed plans, so this is a
  // month/plan mismatch rather than an empty result. Say which.
  if (!plan) {
    return (
      <p className="h10-bsp-encalm">
        <b>Armed, but the engine has no plan for {marketplace} this month.</b> It evaluates the
        current month only; a plan saved for another month is not enforced.
      </p>
    )
  }

  const acting = plan.campaigns.filter((c) => c.deltaCents !== 0 || c.suppress || c.restore)

  // ── armed, and it would do nothing — with the numbers that make it true ────────────────────
  if (acting.length === 0) {
    const projected = forecastCents
    return (
      <div className="h10-bsp-encalm">
        <b>Pacing would change nothing right now.</b>{' '}
        {plan.autoPacing && capCents > 0 && projected != null ? (
          <>
            {marketplace} is projected to finish at <b>{eur(projected)}</b> against a{' '}
            <b>{eur(capCents)}</b> cap, and pacing only acts when the projection goes over.
          </>
        ) : (
          <>Pacing only acts when the month is projected over its cap.</>
        )}
        {plan.stopOverSpend && (
          <> Stop Over Spend is armed and the cap is {plan.capReached ? 'reached' : 'not reached'}, so
            {plan.capReached ? ' bids are floored' : ' bids are untouched'}.</>
        )}
        <span className="h10-bsp-enfoot">
          {plan.remainingDays} {plan.remainingDays === 1 ? 'day' : 'days'} left ·{' '}
          {eur0(plan.remainingBudgetCents)} of budget remaining
          {plan.todayTargetCents != null && <> · today&rsquo;s target {eur(plan.todayTargetCents)}</>}
        </span>
      </div>
    )
  }

  // ── it would act ──────────────────────────────────────────────────────────────────────────
  return (
    <div className="h10-bsp-enf">
      <p className="h10-bsp-note">
        <Info size={12} />
        <span>
          <b>Pacing would change {acting.length} {acting.length === 1 ? 'campaign' : 'campaigns'} on
          its next run.</b> It runs every 30 minutes; this is the same calculation, run now.
        </span>
      </p>
      <ul className="h10-bsp-enlist">
        {acting.slice(0, 12).map((c) => (
          <li key={c.id}>
            <span className="n" title={c.name}>{c.name}</span>
            {c.suppress || c.restore ? (
              <span className={`act ${c.suppress ? 'down' : 'up'}`}>
                {c.suppress ? 'floor bids to €0.02' : 'restore bids'}
              </span>
            ) : (
              <span className="v">
                {eur(c.currentDailyCents)} <ArrowRight size={10} aria-hidden="true" />{' '}
                <b className={c.deltaCents < 0 ? 'down' : 'up'}>{eur(c.targetDailyCents ?? c.currentDailyCents)}</b>
                {c.clamp && <i> · {CLAMP_WHY[c.clamp]}</i>}
              </span>
            )}
          </li>
        ))}
      </ul>
      {acting.length > 12 && (
        <p className="h10-bsp-enfoot">…and {acting.length - 12} more. This list is capped at 12.</p>
      )}
    </div>
  )
}
