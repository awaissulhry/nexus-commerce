'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the rail shell that hosts the binding rail and the plan editor.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: travels with its bodies.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

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
 * BSP.1 — `plan:` is no longer a placeholder: the client composes the real editor and passes it in
 * as `planBody`. The rail stays a frame that knows what each kind is CALLED, not what it contains,
 * so BSP.2/.4/.5 each fill one branch without touching this file's structure. The other three kinds
 * still render a titled placeholder naming the session that owns them.
 */

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { BspOpen } from './urlState'

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
  open, onClose, planBody, campaignBody, title,
}: {
  open: BspOpen
  onClose: () => void
  /**
   * BSP.2 · binding — an operator-facing name for the entity, when the caller knows one.
   *
   * The `RAIL` map builds a title from the id because in BSP.0 every branch was a placeholder and
   * an id was all there was. Now that `campaign:` carries real content, `Campaign
   * cmpee2fun09oioj01764ctbqb` is what an operator reads at the top of it — a cuid identifies the
   * row to the database and to nobody else.
   */
  title?: string
  /**
   * BSP.1 — the `plan:` editor, composed by the client because it owns the writes and the shared
   * pacing fetch. The rail stays a frame: it knows what each kind is called, not what it contains.
   */
  planBody?: ReactNode
  /** BSP.2 · binding — same arrangement as `planBody`: the client composes it and the rail frames it. */
  campaignBody?: ReactNode
}) {
  const def = RAIL[open.kind]
  const heading = title ?? def.title(open.id)

  return (
    <aside className="h10-bsp-rail" aria-label={heading}>
      <div className="h10-bsp-railhd">
        <b title={heading}>{heading}</b>
        <button type="button" onClick={onClose} aria-label="Close inspector">
          <X size={14} />
        </button>
      </div>

      <div className="h10-bsp-railbd">
        {open.kind === 'plan' && planBody ? planBody
          : open.kind === 'campaign' && campaignBody ? campaignBody : (
          <div className="h10-bsp-pending">
            <b>Not built yet — {def.session}.</b>
            <span>{def.what}</span>
          </div>
        )}
      </div>
    </aside>
  )
}
