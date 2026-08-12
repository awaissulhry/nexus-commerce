/**
 * HV.2 — the thresholds, as live controls. NOT BUILT YET.
 *
 * The graduation threshold, the negation threshold and the window, as controls whose count moves
 * when you move them. That is the whole argument for this page: measured 2026-08-12, minOrders
 * 1 → 92 candidates (58 new) · 2 → 17 (1 new) · 3 → 8 (0 new); window 30d → 9 · 60d → 17 · 90d → 25.
 * One drag has to make that legible.
 *
 * What it owns: the per-scope values, in a NEW additive table `AdsHarvestPolicy` (D3). Today the
 * thresholds are constants in `ads-harvest.service.ts:41-42` with no UI anywhere, and the two
 * engines disagree about them — the SCHEDULE path reads `action.minOrders`, the
 * SEARCH_TERM_CONVERTING path reads `CONVERTING_MIN_ORDERS` from the env as a `having` clause a
 * rule condition can only tighten, never loosen.
 *
 * What it must NOT own: the account mode dial or any ceiling. Automations owns both (§11 C1, C2,
 * C3). This section changes what COUNTS as a candidate, never what is allowed to act on one.
 *
 * ⚠ It must also carry the negation threshold's honesty problem. `minSpend €15` with zero orders
 * is a proxy that varies 8× with CPC: at this account's €1.69 max CPC that is nine clicks, while
 * the published bar for negating is 15–20 clicks with zero conversions. All 8 of today's negative
 * candidates clear the click bar, but by accident, not by construction.
 *
 * Renders null. Hidden, not disabled: the section does not exist, so the page shows nothing rather
 * than a control that cannot work. Its props are already the shared contract, so HV.2 is one file
 * and one import line — nobody restructures the client.
 */
import type { HvSlotProps } from './slot-contract'

export function HvThresholds(_props: HvSlotProps) {
  return null
}
