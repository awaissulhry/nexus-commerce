# EPF2-REPORT — `/financials` at design law: SHIPPED (gate report, 2026-07-17)

Built to `EPF2-SPEC.md` in a worktree (commits `9b3f9938` server+helpers, `35b9be75` client+FS3+verify script), merged + verified on main. The 376-line client monolith became a container + 7 siblings; the page now meets every design-law bullet and the FS3 financials-grid adoption handoff is **done (×4)**.

## Plain-English summary

The money page now behaves like the best page in the app: real filters (date range in Italian time with a labeled 12-month default + one-click All time, customer picker, state filter), every list windowed with Load-more (the "showing 200" dead-end is gone), skeletons instead of the false "No orders yet" flash, every customer/month row drills into the filtered orders view, deposits' "blocked" pill jumps to the exact work order on the production board, the page URL captures everything (tab, open drawer, window, customer — shareable/bookmarkable; browser Back closes the drawer), live updates ride the SSE bus with a "money synced Ns ago" line, and **every money action states its consequence before doing anything** — invoice preview with editable amount (partial invoices now possible), mark-paid confirmation, an explicit escalation when a payment would overpay, REFUND entry with mandatory note, bank-import dry-run → apply summary. VAT shows on the drawer (display-only, labeled), everything is captioned EUR. Import accepts drag-and-drop files as well as paste.

## Verification

- **Tests 736 green** on main post-merge (EPF.2 added +41: Rome day-window DST/year boundaries, EU amount matrix, FD13 kind default, cursor codec no-gap/no-overlap, projection+strip matrix). All five checks green; `tsc --noEmit` clean; `.next-verify` build green.
- **Headless UI verification: 44/44 asserts** at 1512/1728/1920 (no horizontal overflow, ARIA tabs, deep links, URL round-trips, skeleton-not-empty-state under throttle, FD13 kind defaults, 409 overpay escalation, Back-closes-drawer) — script committed at `scripts/verify/epf2-ui.ts`; **21 screenshots** reviewed by the coordinating session (orders tab + drawer spot-checked by eye). The agent's verifier caught and fixed two visual defects mid-run (drawer screenshotted mid-animation; import-diff amount ellipsized).
- **Parity 10/10** re-run on the 50k harness post-merge (no fold semantics changed — asserted).
- **Perf**: default 12-month view ~390ms p50 / all-time ~465ms at the 50k harness (was 598 at EPF.1's worst). Still above the 310 FS1 baseline — the residual is the five aggregate queries not yet joining the window (named next lever), plus the pre-existing 308ms of base+actual-cost SQL. At real factory volume this is single-digit ms. The EPF.1 named deviation stands, improved.

## Merge repair (out-of-scope fix, flagged)

The shared tree contained another session's **half-finished EPQ.4 merge** (conflict markers in the status-board canvas; conflicted schema). An initial ours-side resolution dropped EPQ.4's schema fields and broke the factory build in *their* costing route; repaired with a proper three-way union (schema keeps EPQ.5 `bespoke`/tax fields AND EPQ.4 `laborHours`/`TemplateConsumption`; quotes GET keeps both sides' imports). `tsc` clean + 736 tests green after. Lesson recorded: complete your merges before leaving the shared tree.

## Deviations (deliberate, from the build report)

`?range=all` param beyond the spec's five (the All-time toggle needs a third state) · state filter is client-side over loaded rows (labeled) · by-order grid has no client sort (cursor page — sorting a partial page would lie; EPO.7 precedent) · invoice-number preview shows the pattern `INV-2026-…` (exact number is unknowable pre-mint) · apply-confirm shows N-to-record, created/skipped/errored land in the result step.

## ⚠ Owner steps

1. **Restart `:3100`** (covers EPF.1/.2 + the other sessions' migrations — the board's Owner card lists them all; EPQ.4's `epq4_cost_model` and FS5's `fs5_fts` also need `db:migrate` against the live DB from their sessions or this one on request).
2. Click-through: the EPF1-REPORT script still applies, now through the new UI; additionally — change the date window and watch the URL; open a customer row's drill; drag a CSV onto Import; try an overpay to see the escalation; open the cancelled-money tile.

## Rollback

`git revert` the two EPF.2 commits — server params are additive and the EPF.1 backend is untouched; no migration in this phase.
