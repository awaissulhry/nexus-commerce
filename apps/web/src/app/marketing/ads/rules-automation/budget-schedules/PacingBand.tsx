'use client'

/**
 * BSP.0 — the pinned pacing band. Built live, not as a shell.
 *
 * This band is the reason the page has this layout. The question the page exists to answer —
 * *"will my money last the month?"* — must be on screen while you read anything else, so the band
 * sticks and never scrolls away.
 *
 * Everything here comes from `GET /advertising/budget-manager`, which already computes spend to
 * date, calendar-weighted `expectedPct`, `forecastSpendCents` and `projectedOverspend`. The
 * enterprise-tier pacing header was a fetch, not a build. No new route, no migration.
 *
 * ── Three things this band refuses to do ───────────────────────────────────────────────────────
 *
 * 1. **It shows a market with spend and no plan honestly.** `analyzeBudgetManager()` unions both
 *    sources, so such a market arrives with `id: null` and `status: 'no-budget'`. It is rendered as
 *    "no monthly cap" with its real spend beside it — never hidden, and never as "€0 of €0", which
 *    would read as a market that is switched off rather than one that is uncapped.
 * 2. **It dims the unselected chips with GROUND, not opacity.** `getComputedStyle` reports the
 *    declared colour, so an opacity-dimmed chip cannot be contrast-checked without compositing by
 *    hand — and usually fails once you do. Every chip keeps full-strength text.
 * 3. **It is read-only in BSP.0.** The cap editor, the per-day calendar and the pacing toggles
 *    arrive in BSP.1. Until then the rail links out to /marketing/ads/budget-manager, which owns
 *    them today.
 *
 * The chips double as the page's sticky market control — see `BudgetScopeBar`'s header for why
 * market is not in the spine.
 */

import { ExternalLink } from 'lucide-react'
import { ProgressBar } from '@/design-system/components'
import type { BudgetManagerResult, BudgetPlanRow } from './slot-contract'

const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Compact form for the chips, where two full amounts would not fit in 1154px across four markets. */
const eur0 = (cents: number) => `€${Math.round(cents / 100).toLocaleString('en-IE')}`
const pct = (r: number) => `${(r * 100).toFixed(1)}%`

const STATUS_LABEL: Record<BudgetPlanRow['status'], string> = {
  'on-track': 'on track',
  over: 'over pace',
  under: 'under pace',
  'no-budget': 'no cap',
}

export function PacingBand({
  data, loading, error, market, onMarket, onOpenPlan,
}: {
  data: BudgetManagerResult | null
  loading: boolean
  error: string | null
  market: string
  onMarket: (m: string) => void
  onOpenPlan: (marketplace: string) => void
}) {
  if (error) {
    // The "broke" state of the shared vocabulary: the actual error text, never an empty band that
    // reads as an account with no budget.
    return (
      <div className="h10-bsp-band broke">
        <span className="h10-bsp-bandmsg">
          <b>Pacing could not be loaded.</b> {error}
        </span>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="h10-bsp-band">
        <span className="h10-bsp-bandmsg dim">Loading this month’s pacing…</span>
      </div>
    )
  }

  const rows = data?.rows ?? []
  if (!data || rows.length === 0) {
    return (
      <div className="h10-bsp-band">
        <span className="h10-bsp-bandmsg">
          <b>No monthly budget plans yet.</b> A plan sets the monthly cap a market paces against.
        </span>
      </div>
    )
  }

  // The summary reads the SELECTED scope: the account total for `all`, that market's line for one.
  const selected = market === 'all' ? null : rows.find((r) => r.marketplace === market) ?? null
  const capCents = selected ? selected.monthlyBudgetCents : data.totals.budgetCents
  const spendCents = selected ? (selected.spendCents ?? 0) : data.totals.spendCents
  const forecastCents = selected
    ? selected.forecastSpendCents
    : rows.reduce((a, r) => a + (r.forecastSpendCents ?? 0), 0)
  const over = selected ? selected.projectedOverspend : forecastCents != null && forecastCents > capCents

  return (
    <div className="h10-bsp-band">
      <div className="h10-bsp-chips">
        {rows.map((r) => {
          const on = market === r.marketplace
          const ratio = r.monthlyBudgetCents > 0 ? Math.min(100, ((r.spendCents ?? 0) / r.monthlyBudgetCents) * 100) : 0
          return (
            <button
              key={r.marketplace}
              type="button"
              // Clicking the selected chip clears back to the account view, so the control is its
              // own undo and there is no separate "all markets" affordance to hunt for.
              onClick={() => onMarket(on ? 'all' : r.marketplace)}
              className={`h10-bsp-chip${on ? ' on' : ''} s-${r.status}`}
              aria-pressed={on}
              title={`${r.marketplace}: ${r.status === 'no-budget' ? 'no monthly cap set' : `${pct((r.spendCents ?? 0) / r.monthlyBudgetCents)} of cap, ${pct(r.expectedPct)} expected by today`}`}
            >
              <span className="hd">
                <b>{r.marketplace}</b>
                <i>{STATUS_LABEL[r.status]}</i>
              </span>
              <span className="amt">
                {r.status === 'no-budget'
                  // 🔴 Honest, not "€0 of €0": this market is spending against no cap at all.
                  ? <>{eur0(r.spendCents ?? 0)} · <em>no cap</em></>
                  : <>{eur0(r.spendCents ?? 0)} <s>/</s> {eur0(r.monthlyBudgetCents)}</>}
              </span>
              <ProgressBar value={ratio} height={4} className="h10-bsp-bar" />
            </button>
          )
        })}
      </div>

      <div className="h10-bsp-sum">
        <span className="l">
          <b>{eur(spendCents)}</b> of {capCents > 0 ? eur(capCents) : 'no cap'}
          <s>·</s> day {data.dayOfMonth}/{data.daysInMonth}
          {forecastCents != null && (
            <>
              <s>·</s> projected <b className={over ? 'bad' : ''}>{eur(forecastCents)}</b>
            </>
          )}
        </span>
        <button
          type="button"
          className="h10-bsp-plan"
          onClick={() => onOpenPlan(selected ? selected.marketplace : (rows[0]?.marketplace ?? ''))}
        >
          Plan <ExternalLink size={11} />
        </button>
      </div>
    </div>
  )
}
