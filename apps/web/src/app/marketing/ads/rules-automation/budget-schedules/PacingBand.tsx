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

import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { ProgressBar } from '@/design-system/components'
import type { BudgetManagerResult, BudgetPlanRow } from './slot-contract'
import { currentMonthUTC, shiftMonth } from './urlState'

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

/**
 * BSP.1 — the month stepper lives HERE, not in the scope spine.
 *
 * The page has two windows and they are not the same thing: the spine's `weeks` is the PERFORMANCE
 * window the hourly cube speaks, and `month` is the MONEY window a plan is keyed by. Putting both
 * in one bar would invite an operator to read one as the other. The band is already the
 * monthly-money surface — it prints `day 12/31` — so the month belongs to it.
 *
 * Measured: the band had 185px of spare horizontal room at 1280, and the stepper fits inside it
 * without changing the band's height, which is load-bearing for the page's 120px chrome budget.
 */
function MonthStepper({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
  const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })
  const isCurrent = month === currentMonthUTC()
  return (
    <div className="h10-bsp-month">
      <button type="button" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>
        <ChevronLeft size={14} />
      </button>
      <b>{label}</b>
      <button type="button" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>
        <ChevronRight size={14} />
      </button>
      {/* A month that is not "now" must say so — every number beside it is then historical. */}
      {!isCurrent && (
        <button type="button" className="today" onClick={() => onMonth(currentMonthUTC())}>Today</button>
      )}
    </div>
  )
}

export function PacingBand({
  data, loading, error, market, month, onMarket, onMonth, onOpenPlan,
}: {
  data: BudgetManagerResult | null
  loading: boolean
  error: string | null
  market: string
  month: string
  onMarket: (m: string) => void
  onMonth: (m: string) => void
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
        <MonthStepper month={month} onMonth={onMonth} />
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="h10-bsp-band">
        <span className="h10-bsp-bandmsg dim">Loading this month’s pacing…</span>
        <MonthStepper month={month} onMonth={onMonth} />
      </div>
    )
  }

  // `analyzeBudgetManager()` returns markets in its own order, which comes out alphabetical —
  // DE, ES, FR, IT — so IT lands last while carrying €2,220 of the €4,000 account cap. Ordered by
  // the money instead: cap first, then spend, so a market with real spend and no cap set still
  // sorts by what it is actually costing rather than falling to the end on a zero.
  const rows = [...(data?.rows ?? [])].sort(
    (a, b) => (b.monthlyBudgetCents - a.monthlyBudgetCents) || ((b.spendCents ?? 0) - (a.spendCents ?? 0)),
  )
  if (!data || rows.length === 0) {
    return (
      <div className="h10-bsp-band">
        <span className="h10-bsp-bandmsg">
          <b>No budget plan for this month.</b> A plan sets the monthly cap a market paces against.
        </span>
        {/* The stepper renders in EVERY branch. Without it, stepping into a month with no plans
            would remove the only control that steps back out of it. */}
        <MonthStepper month={month} onMonth={onMonth} />
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

      <MonthStepper month={month} onMonth={onMonth} />

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
