'use client'

/**
 * ⛔ PARKED 2026-08-18 (U6) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the seam that mounted the guardrails card.
 * Why it left: the Budget tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BudgetRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.5, §7.7).
 * Candidate home: travels with BudGuardrails.
 *
 * ⚠ Nothing here was changed and no endpoint was retired. The budget WRITE GATE is server-side and
 * untouched, and the €1-floor ratchet condition is still stated on Budget Pacing & Schedules and on
 * Control Room › Activity. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BUD.1 — the seam where BUD.2–BUD.7 attach.
 *
 * Every one of the six sections renders below the grid, inside it, or over it, and every one needs
 * the same things: the resolved scope, the rows, the URL writer and the reserved params. Rather
 * than each section reaching into `BudgetClient` and each arrival editing it, they land here — one
 * import line and one element apiece — and `BudgetClient` never changes shape again.
 *
 * This file renders nothing today, on purpose. It exists so the props BUD.2 needs are declared,
 * typed and already flowing before BUD.2 is written.
 *
 * The order below is the build order, which is not the display order. Each section's comment says
 * where it goes, so nobody has to re-derive the layout from the study.
 *
 *   BUD.2  guardrails & the baseline    → a panel under the grid, + a baseline column inside it
 *   BUD.3  the rule record & restore    → a drawer over the page, on `?rule=` / `?open=`
 *   BUD.4  the rules made honest        → replaces the provisional list at the bottom
 *   BUD.5  proposals & the staged diff  → a tray docked to the bottom of the viewport
 *   BUD.6  reallocation                 → grid selection + a transfer dialog
 *   BUD.7  notifications                → a panel under the grid
 *
 * 🔴 **BUD.2 is where the ratchet stops, and it is the first section allowed to write.** A section
 * that writes must not simply appear: BUD.1 is read-only, and `NO_WRITE_ACTIONS` in the slot
 * contract passes that as an explicit absence rather than an omission. The first section to write
 * replaces that object; it does not quietly stop passing it.
 */

import type { BudSlotProps } from './slot-contract'
import { BudGuardrails } from './BudGuardrails'

export function BudgetSections(props: BudSlotProps) {
  // BUD.2 — the first section, and the first that writes. The remaining shells (BUD.3–BUD.7)
  // stay unmounted: hidden, not disabled.
  return <BudGuardrails {...props} />
}
