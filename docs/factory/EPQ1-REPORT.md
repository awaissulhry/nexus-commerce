# EPQ.1 — Gate report: quote lifecycle closed & audited

Built to `EPQ-PROPOSAL.md` §5 EPQ.1 by a worktree agent (merged `bd091df8`), migration `epq1_quote_lifecycle` applied live + harness, expiry tick wired into the worker.

## Plain English
Quotes can no longer drift into impossible states or die silently. An offer that passes its validity date now flips to EXPIRED automatically (with a bell notification and an Expired tab to find them); the state machine only allows legal moves (anything else is refused and recorded); a sent quote's deposit and dates are locked until you revise it; every re-send issues a fresh accept link and old links now show "this offer was superseded" instead of letting a customer accept stale pricing; sending below your margin floor is permanently recorded (who, when, at what margin); every price edit logs its before/after money; and the pipeline gained bulk mark-lost.

## Shipped (vs the 9 audit defects)
S1 EXPIRED dead state → worker sweep (`quote-tick.ts`, bounded + indexed via new `Quote.validUntilAt` index, drains across ticks) + Expired tab + Revise path ✓ · S2 forward-only machine (`quotes/transitions.ts`, 422 + `transition.refused` audit; SENT field-guard) ✓ · S3 supersede (fresh token per send, pinned to its QuoteVersion via new unique `acceptTokenHash` column; old links render the superseded banner with that version's own frozen snapshot, never leaking the new token) ✓ · S4 `marginFloorBreached` finally written + `floor.acknowledged` audit ✓ · S5 before/after money in line audits ✓ · S8 four-row waterfall (Adjustment visible, signed, reason beneath) + bulk mark-lost ✓.

## Judgment calls (accepted at merge)
1. DRAFT→SENT via raw PATCH → 422 "use Send" (mirrors the orders START_PRODUCTION_EDGE precedent; a PATCH-minted SENT would have no frozen version).
2. Bulk mark-lost on EXPIRED rows records the reason but keeps EXPIRED (EXPIRED→REJECTED is not a legal edge; analytics already counts EXPIRED as loss).
3. Revise offered on EXPIRED (the only path to the approved EXPIRED→DRAFT edge).
4. Migration authored via `migrate diff --script` (shadow-only — even `--create-only` touches the dev DB; safer with the Owner's server running).

## Owner decision D-5 (executed as approved)
Lapsed SENT quotes sweep to EXPIRED on the first tick; each generates one notification — your one-time review list IS the bell + Expired tab.

## Honest limits
- The superseded-link path is unit-tested and API-shaped, but a full live re-send needs Gmail (not connected on the harness) — it gets its interactive proof on your first real Revise→Send, or in EPQ.2's click-through with the view-tracking build.
- The 16 UI-inventory gaps NOT in EPQ.1's scope (broken ⌘K `?focus` deep link, quote→order dead end, inert overdue counter, non-sortable grid…) are queued for EPQ.2/.6 — tracked, not lost.

## Verified
Worktree gates (tsc · 217 tests incl. 11 new transition/sweep/supersede tests · rbac · query-bounds · no-touch · ds-parity) + post-merge main gates (225 tests, all checkers) · migration applied to live + scale DBs · dev runtime restarted post-generate (trap 6b) · :3199 click-through of the new pipeline surfaces recorded in the session log.
