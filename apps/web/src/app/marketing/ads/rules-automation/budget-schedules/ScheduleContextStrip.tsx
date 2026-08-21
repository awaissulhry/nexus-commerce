'use client'

/**
 * BSP-P5 — the census strip, the idiom every other perfected tab gained (BP, HP, NEG, BUD-P):
 * ONE line of live numbers with links out, above the work.
 *
 * What belongs on THIS tab is set by the ownership line the operator settled on 2026-08-12 —
 * "BSP decides how much money exists; BUD decides who may move it" — so it carries out-of-budget
 * reality, who is moving budgets right now, and the ceiling a schedule will collide with:
 *
 *   · **Out of budget now** — `Campaign.deliveryStatus = NOT_DELIVERING` +
 *     `deliveryReasons ⊇ CAMPAIGN_OUT_OF_BUDGET`. Amazon's own answer, already synced, and this
 *     tab showed nothing about it despite owning "out-of-budget hours".
 *   · **Budget writes in 24h, and how many reached Amazon.** The gate skipped 298 of 398 in the
 *     7 days before this shipped. A page about scheduling budget changes that never says how many
 *     budget changes land is the same lie in a larger frame.
 *   · **The day-move ceiling.** A schedule exists to make a big intraday jump; the gate caps total
 *     daily movement across every writer. Saying it here is cheaper than an operator discovering
 *     it as a silent refusal.
 *
 * 🔴 Absent, not fabricated. A failed fetch renders NOTHING (the strip is context, not the work,
 * and an error bar above an empty grid teaches people to ignore both). A field that came back null
 * drops its own clause rather than printing a zero — `null` and `0` are different facts, which is
 * the defect this whole phase set exists to remove.
 *
 * 🔴 The link uses the `.h10-hv-cohortline .h10-nt-open` pair, NOT `.h10-nt-open` alone: outside a
 * strip that class is an opacity-0 hover affordance and shipped an INVISIBLE link once already
 * (fixed in 6e13e3614). Reuse the pair; do not reinvent it.
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface Ctx {
  marketplace: string | null
  enabledCampaigns: number | null
  atFloor: number | null
  withBaseline: number | null
  outOfBudget: number | null
  outOfBudgetSample: Array<{ id: string; name: string; marketplace: string | null }> | null
  budgetWrites24h: number | null
  budgetWritesDelivered24h: number | null
  budgetWritesBlocked24h: number | null
  dayMove: { dropPct: number; risePct: number; riseAbsEur: number } | null
}

export function ScheduleContextStrip({ market }: { market?: string }) {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const scope = market && market !== 'all' ? market : null

  useEffect(() => {
    let alive = true
    setCtx(null)
    const qs = scope ? `?marketplace=${encodeURIComponent(scope)}` : ''
    fetch(`${getBackendUrl()}/api/advertising/budget-schedules/context${qs}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setCtx(j as Ctx) })
      .catch(() => { /* absent, not fabricated — the strip simply does not render */ })
    return () => { alive = false }
  }, [scope])

  if (!ctx) return null

  const where = ctx.marketplace ?? 'all markets'
  const dm = ctx.dayMove

  return (
    <p className="h10-hv-cohortline h10-bs-strip">
      {ctx.enabledCampaigns != null && (
        <>
          <b>{ctx.enabledCampaigns}</b> enabled campaign{ctx.enabledCampaigns === 1 ? '' : 's'} in {where}
          {ctx.atFloor != null && <> · <b>{ctx.atFloor}</b> at the €1 floor, where a decrease is a no-op</>}
          {ctx.withBaseline != null && <> · <b>{ctx.withBaseline}</b> with a captured baseline, which is the number a schedule restores to</>}
        </>
      )}
      {ctx.outOfBudget != null && (
        <>
          {' · '}
          <b>{ctx.outOfBudget}</b> out of budget right now
          {ctx.outOfBudget > 0 && ctx.outOfBudgetSample?.length ? (
            <> — {ctx.outOfBudgetSample.map((c) => c.name).join(', ')}
              {ctx.outOfBudget > ctx.outOfBudgetSample.length ? ` and ${ctx.outOfBudget - ctx.outOfBudgetSample.length} more` : ''}
              {' '}(Amazon’s own <code>CAMPAIGN_OUT_OF_BUDGET</code>, not our estimate)
            </>
          ) : null}
        </>
      )}
      {ctx.budgetWrites24h != null && (
        <>
          {' · '}
          <b>{ctx.budgetWrites24h}</b> budget write{ctx.budgetWrites24h === 1 ? '' : 's'} in 24h
          {/* 🔴 The two numbers that must never be collapsed into one. */}
          {ctx.budgetWritesDelivered24h != null && <>, <b>{ctx.budgetWritesDelivered24h}</b> confirmed at Amazon</>}
          {ctx.budgetWritesBlocked24h != null && ctx.budgetWritesBlocked24h > 0 && <>, <b>{ctx.budgetWritesBlocked24h}</b> blocked before they got there</>}
          {' '}
          <a className="h10-nt-open" href="/marketing/ads/changelog?field=dailyBudget">See the Change Log</a>
        </>
      )}
      {dm && (
        <> · a schedule may move one budget by at most <b>−{dm.dropPct}%</b> / <b>+{dm.risePct}%</b> (or €{dm.riseAbsEur.toFixed(0)}, whichever is larger) per UTC day, counting every writer</>
      )}
    </p>
  )
}
