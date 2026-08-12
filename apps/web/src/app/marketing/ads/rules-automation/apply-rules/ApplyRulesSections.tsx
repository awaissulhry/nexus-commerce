'use client'

/**
 * AR.S0 — the seam where S1–S9 attach.
 *
 * Every one of the nine sections renders below the grid, above it or over it, and every one of them
 * needs the same things: the resolved scope, the grain, the rows, the aggregates, the account
 * totals and the URL writer. Rather than each section reaching into `ApplyRulesClient` and each
 * arrival editing it, they land here — one import line and one element apiece — and
 * `ApplyRulesClient` never changes shape again.
 *
 * This file renders nothing today, on purpose. It exists so that the props S1 needs are declared,
 * typed and already flowing before S1 is written.
 *
 * The order below is the build order, which is not the display order. Each comment says where the
 * section goes, so nobody has to re-derive the layout from the study.
 *
 *   S1  population band       → above the grid, replacing RuleImpactStrip
 *   S2  governance columns    → inside the grid, via `columns`
 *   S3  settings columns      → inside the grid, via `columns`
 *   S4  performance + time    → columns, plus the date control in `toolbarRight`
 *   S5  writes                → the selection bar + the row action (replaces NO_WRITE_ACTIONS)
 *   S6  automations column    → inside the grid, via `columns`
 *   S7  row drawer, `?row=`   → portal over the page
 *   S8  views & export        → `toolbarRight` + `filterPresetsKey` + `storageKey`
 *   S9  assignment            → a selection action, blocked on scope*Ids arrays (session 10)
 *
 * 🔴 A section that writes must not simply appear. S0 is read-only, and `NO_WRITE_ACTIONS` in the
 * slot contract passes that as an explicit absence rather than an omission. The first section to
 * write REPLACES that object; it does not quietly stop passing it.
 */

import type { ApplyRulesSlotProps } from './slot-contract'

export function ApplyRulesSections(_props: ApplyRulesSlotProps) {
  return null
}
