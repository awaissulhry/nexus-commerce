# EPF2-SPEC — `/financials` at design law (binding build spec)

Second EPF phase (proposal approved 2026-07-17; EPF.1 shipped — `EPF1-REPORT.md`). Rebuilds the page UI to PLAYBOOK §6 design law on the EPF.1 backend, adopts FS3 on all four grids, and closes the EPF.1 follow-ups that belong to the UI. Server changes limited to: response slimming, Rome-windowed `from/to`, and the `?party=` filter — no fold semantics change (parity untouched).

## Scope IN

**1. Client rebuild (`FinancialsClient.tsx` + siblings — DS + FS3 only).**
- `PageHeader` (title/subtitle/actions) · tiles via `MetricStrip` (4 tiles + a 5th "Cancelled w/ money" tile shown only when count > 0, opening its bucket list in a drawer) · proper `Tabs` with tablist ARIA (By order / By customer / By month / Deposits) · `FilterBar`/`GridToolbar` with **date range** (two `DateField`s, Rome semantics), **customer** (`AsyncCombobox` from FS3, `/api/parties-lite`), and state filter · **all four grids on FS3 `VirtualDataGrid`** (the registry handoff; sortable headers where DataGrid supports it).
- **Skeletons everywhere** (`Skeleton` rows on first load per tab; the false "No orders yet" flash dies); drawer body skeleton while detail loads; empty states keep purpose + next-action copy.
- **Default window = last 12 months** (Rome), visibly labeled in the FilterBar with one-click "All time" — this is the EPF.1 perf lever; the "Showing N of M" note becomes a real Load-more (VirtualDataGrid + server cursor or window-narrowing hint, simplest honest option).
- **Freshness + live**: `useFactoryEvents(["payment.recorded","order.updated","import.finished"], …)` (M6 handoff included) → debounced refetch of the active tab + tiles; a freshness line ("money synced Ns ago") in the header.
- **Keyboard**: `1-4` switch tabs, `Esc` closes drawer/modals, `/` focuses search-combobox. Nothing that collides with typing contexts; no global letter shortcuts beyond these (cross-review MINOR noted a cross-page `e` clash — EPF stays conservative).

**2. Drill-through & URL state (house conventions).**
- URL contract: `?tab=orders|party|month|deposits` · `?o=<orderId>` opens the money drawer (deep-linkable; pushState so browser Back closes it — the EPO.7 idiom) · `?from=YYYY-MM-DD&to=YYYY-MM-DD` (Rome day boundaries) · `?party=<id>` (EPO D-5 law). All read on load, all written on change.
- By-customer row → `?tab=orders&party=<id>` · By-month row → `?tab=orders&from=<month start>&to=<month end>` · deposits "N blocked" pill → `/production?wo=` reader with the first blocked WO (or `/production` filtered — whichever the EPO-built reader supports; verify, don't guess) · drawer footer keeps `/orders?o=`.
- "Export period" becomes a real control: exports THE CURRENT VIEW's window + filters (`/api/exports/financials?from&to&party`), and says so on the button's confirm.

**3. Money-action UX (consequence dialogs — escalation ladder).**
- **New invoice**: confirm modal previewing the number-to-be (`INV-2026-…`), default amount (net − paid, editable → partial invoices land here since the API accepts `netCents`), and the consequence line. 400s (nothing invoiceable / cap exceeded) render inline with the remaining-invoiceable figure.
- **Mark paid**: confirm stating "records a BALANCE payment of €X"; on 409 `{overpayCents}` show the explicit overpay confirm that re-sends `allowOverpay: true`.
- **Record payment**: DS inputs, labeled; kind default **context-sensitive** (DEPOSIT while the FD13 gate is open, else BALANCE); **date field** (`receivedAt`, defaults today); EU-safe amount parse (`1.234,56` and `1,234.56` both correct — pure helper + tests); **REFUND kind** entry (visible only for `payments.record`, requires note, shows the refund consequence line).
- **Bank import**: `FileDropzone` + paste textarea both; dry-run diff table keeps confidence pills + adds the duplicate/already-settled annotations EPF.1 emits; Apply confirm summarizes (N create / N skip / N error); a note explains the identical-rows fingerprint edge.
- VAT/gross display line in the drawer (from `financials.defaults.vatRatePct`) + an "all figures EUR" caption (D-12).

**4. Server touches (no fold changes).**
- `/api/financials`: project the hot response — drop the degraded `invoicedByMonthCents`/`paidByMonthCents` maps and `invoiceNumbers` from rows (page never renders them; EPF.1 follow-up); accept `from/to` as Rome-day windows (pure helper `romeDayWindowUtc`, tested) and `party` (WHERE o.partyId — index-backed); tiles stay window-scoped as today.
- By-month tab sources **`/api/financials/period`** (real doc-date buckets — never the degraded maps).
- `/api/financials/party` + `/deposits`: accept the same window/party params for consistency (bounded, annotated).

## Scope OUT
Party ledger/reconciliation (EPF.3) · credit-note UI (EPF.4) · exception queues/close (EPF.5) · saved views/group-by (EPF.6) · courtesy-copy relabel + external-number field (EPF.7 batch) · any EPQ.5 field rendering (M5) · new folds.

## Tests & verification (the gate)
- Pure helpers tested: Rome day-window parse (DST + year boundary), amount parse matrix, kind-default logic, response projection (maps/numbers absent, money grain-strip still intact — extend the strip matrix test).
- Full suite green + the five checks + `.next-verify` build.
- **Headless UI verification on `:3199` + scale DB (mandatory — the Owner must never catch a visual defect):** Playwright via the apps/web `createRequire` trick, login via the scale-manifest `sessionToken` cookie (measure.ts pattern). Script asserts at **1512 / 1728 / 1920**: no horizontal overflow; tiles+tabs+grid render with data; skeleton (not empty-state) during a throttled first load; drawer opens via `?o=` deep link; date filter round-trips the URL; screenshots of every surface (all tabs, drawer, both modals, import diff) saved to the scratchpad for the coordinating session's review.
- Re-run `measure.ts`: record financials p50 with the default 12-month window (expected well under 310 — this closes the EPF.1 named deviation's lever) AND with All-time (should match EPF.1's ~440-480).
- Parity script re-run (should be untouched — assert it).

## Build plan
Two commits: (a) server touches + pure helpers + tests; (b) client rebuild + FS3 adoption + headless-verify script + screenshots dir (gitignored if large; keep the script committed). Conventional style, factory scope, same footer.
