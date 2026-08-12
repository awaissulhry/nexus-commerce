'use client'

/**
 * BSP.0 — the inspector rail, opened by `?open=` and closed back to it.
 *
 * 🔴 An in-flow layout COLUMN, not a DS `Drawer`. `Drawer.tsx:140` is `createPortal` to
 * `document.body`, which takes it out of `.h10-shell` — and `.h10-shell` is what pins this section
 * to `color-scheme: light` with hard-coded hex. A portalled drawer here renders dark inside a
 * permanently light page. The brief anticipated this and asked me to say so if the rail should be
 * in-flow: it should, and not only to dodge the portal. The layout the operator drew puts the rail
 * BESIDE the sections rather than over them, so an overlay would be the wrong thing even if the
 * portal were free.
 *
 * In BSP.0 every kind renders a titled placeholder naming the session that fills it. `plan:` also
 * links out to /marketing/ads/budget-manager, which owns the cap editor until BSP.1 migrates it —
 * so the read-only band still has somewhere honest to send an operator who wants to change a
 * number today.
 */

import { X, ExternalLink } from 'lucide-react'
import type { BspOpen } from './urlState'
import type { BudgetManagerResult } from './slot-contract'

const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** What each rail kind is titled and which session builds it out. */
const RAIL: Record<BspOpen['kind'], { title: (id: string) => string; session: string; what: string }> = {
  plan: {
    title: (id) => `${id} · monthly plan`,
    session: 'BSP.1',
    what: 'The monthly cap, the burn-down, the per-day calendar, auto-pacing and stop-over-spend, and the per-campaign min/max limits — migrating here from Budget Manager.',
  },
  schedule: {
    title: (id) => `Schedule ${id}`,
    session: 'BSP.4',
    what: 'What this schedule changes, on which days and hours, against which base budget, and whether Amazon or Nexus enforces it.',
  },
  event: {
    title: (id) => `Event ${id}`,
    session: 'BSP.5',
    what: 'A named, dated raise and the date it reverts itself.',
  },
  campaign: {
    title: (id) => `Campaign ${id}`,
    session: 'BSP.2',
    what: 'This campaign’s budget, what it spent against it, and every engine that moved it.',
  },
}

export function InspectorRail({
  open, onClose, pacing,
}: {
  open: BspOpen
  onClose: () => void
  pacing: BudgetManagerResult | null
}) {
  const def = RAIL[open.kind]
  const plan = open.kind === 'plan' ? pacing?.rows.find((r) => r.marketplace === open.id) ?? null : null

  return (
    <aside className="h10-bsp-rail" aria-label={def.title(open.id)}>
      <div className="h10-bsp-railhd">
        <b>{def.title(open.id)}</b>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          <X size={14} />
        </button>
      </div>

      <div className="h10-bsp-railbd">
        {/* The one fact the rail can already state honestly, so a `plan:` rail is not empty on a
            page whose whole subject is this number. Everything editable is BSP.1's. */}
        {plan && (
          <dl className="h10-bsp-railfacts">
            <div><dt>Monthly cap</dt><dd>{plan.monthlyBudgetCents > 0 ? eur(plan.monthlyBudgetCents) : 'none set'}</dd></div>
            <div><dt>Spent so far</dt><dd>{eur(plan.spendCents ?? 0)}</dd></div>
            <div><dt>Projected finish</dt><dd className={plan.projectedOverspend ? 'bad' : ''}>{plan.forecastSpendCents != null ? eur(plan.forecastSpendCents) : '—'}</dd></div>
            <div><dt>Auto-pacing</dt><dd>{plan.autoPacing ? 'on' : 'off'}</dd></div>
            <div><dt>Stop over spend</dt><dd>{plan.stopOverSpend ? 'armed' : 'off'}</dd></div>
            <div><dt>Campaign limits</dt><dd>{plan.campaignLimitCount || 'none'}</dd></div>
          </dl>
        )}

        <div className="h10-bsp-pending">
          <b>Not built yet — {def.session}.</b>
          <span>{def.what}</span>
        </div>

        {open.kind === 'plan' && (
          <a className="h10-bsp-raillink" href="/marketing/ads/budget-manager">
            Edit this plan in Budget Manager <ExternalLink size={12} />
          </a>
        )}
      </div>
    </aside>
  )
}
