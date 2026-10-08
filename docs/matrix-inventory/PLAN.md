# Matrix inventory — plan draft (2026-10-07)

## Summary
- **Goal (Owner):** the Matrix becomes the inventory manager — stock by location and by case, each market sells
  from one location or the sum of several, and "Send to FBA" from the Matrix. Real time. As simple as the Products
  page "Available" pop-up. Design system only.
- **Good news:** most of the base exists — locations, stock per location, routing of locations to markets, one
  quantity formula for every push, live page updates, and the "Available" pop-up itself.
- **Bad news:** nothing models a case; two location lists disagree; orders always take stock from one fixed
  warehouse; FBA inbound does not work end to end (v2 code has 4 blocking bugs and most steps are missing).
- **Build in 4 steps**, one small PR each, all kept LOCAL until the Owner says ship:
  1. Stock by location in the Matrix (no schema change).
  2. "Sells from" per market + orders take stock from the right location.
  3. Cases: units per case, case size and weight (one new table).
  4. Send to FBA from the Matrix (Amazon "Send to Amazon" v2024-03-20 flow, run as a background job).
- **Owner decisions (2026-10-07):** D1 = A (per market for the business + per-product exceptions in the Matrix) ·
  D2 = B (count sealed cases and loose units apart, per location).
- **Status:** Steps 1–4 DONE locally (not pushed). Next: release (Owner's go).

Research notes (private, with file paths and line numbers): `~/nexus-archive/2026-10-07-matrix-inventory/research/`
1 Matrix page · 2 stock backend · 3 FBA inbound code · 4 Available pop-up + design system · 5 web research.

## What the research found
- **Matrix** (`_studio/matrix/`): AG Grid via `NexusGrid`, one column builder `matrixColumnDef`. Rows already carry
  `stock.locations`; the Qty cell already carries `routedLocations`. Edits go `PATCH …/studio/matrix` →
  `matrix-write.service.ts`; bulk via `…/studio/matrix/verbs` (preview + Undo for free). Live: SSE
  `/api/listings/events` → re-read 400 ms after `inventory.stock_changed`.
- **Stock**: `StockLocation` (WAREHOUSE, AMAZON_FBA, CHANNEL_RESERVED, SHOPIFY_LOCATION) + `StockLevel` (units).
  Follow quantity = sum of `available` over routed WAREHOUSE locations − buffer (`sync-control-core.ts:229`).
  Routing = `StockLocation.syncRoutes` (per location) + `ChannelListing.sourceLocationCodes` (per listing, no writer).
  The Locations page edits a different list (`servesMarketplaces`) that pushes ignore.
- **Orders**: Amazon orders reserve at one fixed warehouse; eBay at the default one. A listing can show a sum
  while a sale takes from one place → oversell risk once several locations feed a market.
- **Amazon EU**: one merchant quantity for all EU markets → one "Sells from" choice for the whole EU group.
- **FBA inbound**: v0 plan calls are removed by Amazon; v2 client misses `prepOwner`/`labelOwner`, loses the plan
  id, never calls packing/placement/transport/delivery-window steps, asks labels from a v2 path that does not exist,
  and waits up to ~4 min inside a web request. Amazon's inbound numbers are read and thrown away.
- **Channels**: only Shopify takes stock per location; Amazon (EU), eBay and Etsy take ONE number → Nexus sums.
- **Amazon facts**: one plan = one marketplace (amazon.it for Italy, Pan-EU moves it on); no API for case-pack
  templates (store them in Nexus); EU boxes ≤ 63.5 cm a side and ≤ 23 kg (forum source); no inbound placement fee
  in the EU; partnered carrier for Italy unconfirmed → build "own carrier" first; labels via v0 `getLabels`.

## Step 1 — Stock by location (UI only) — DONE locally 2026-10-07
- Shared group in the Matrix: the Stock cell shows own stock; tooltip lists each location; a click opens the SAME
  `InventoryEditorModal` the Products page uses (shared component, exactly the same — no copy).
- FBA qty stays locked; later (Step 4) it shows "Inbound +N".
- Checked: an inactive WAREHOUSE still feeds listings (`stock-pool/sync-ledgers.ts` reads every WAREHOUSE row), while
  the editor hides inactive locations. No inactive location holds stock today → the fix moves to Step 2 (it changes
  the push).
- Built: pencil in the Stock cell (hover), Enter / F2 / double-click open the editor; parent = family, variant = its
  SKU; Apply → `stock.adjusted` → the Matrix re-reads at once. Test `matrix/stock-column.vitest.test.ts`.

## Step 2 — "Sells from" per market — DONE locally 2026-10-07
- Build plan: `~/nexus-archive/2026-10-07-matrix-inventory/research/6-step2-build-plan.md` (parts A routing · B orders ·
  C Matrix contract + write · D web). Lead took its recommended answers: the default is set in the same pop-up
  ("This product | Every product"); an order line is never split; switching off a warehouse that holds units is
  refused; ship-from addresses (OrderRoutingRule) stay as they are for now.
- Data: one additive column `SyncChannelPolicy.sourceLocationCodes` (market default, in sale order). The product
  exception is `ChannelListing.sourceLocationCodes`. A list REPLACES the routes; no lists = numbers as before.
- Before release: set `MATRIX_FROM_SINCE` (`_studio/matrix/statusCells.ts`) to the real release day.
- Not exercised in a browser: an "Every product" save and the toast Undo (unit-tested).
- One list: `syncRoutes` is the truth; the Locations page edits the same list.
- Inactive warehouses stop feeding listings (from Step 1's check).
- Matrix: a "From" cell in each market group (once for AMAZON:EU). Pop-up = tick locations; the order of the list
  = which location ships first. Bulk Edit gets a "Sells from" field.
- Saving re-pushes the affected listings and sends `inventory.stock_changed` (no silent change).
- Orders take stock from the first location in the market's list that has stock (replaces the fixed warehouse).
- Combine = sum only. Not now: percent, max shown, per-market combine modes.

## Step 3 — Cases (D2 = B: sealed cases + loose units) — DONE locally 2026-10-07
- Build plan: `~/nexus-archive/2026-10-07-matrix-inventory/research/8-step3-build-plan.md`. Owner answers: a size change
  with sealed cases in stock shows the cases and opens them on a 2nd click; goods received arrive as loose units (the
  Owner sets sealed cases); prep / label owner stays "not set" until Send to FBA asks once.
- Built: `ProductPackage` + `StockCaseCount` (migration `20261008w_case_packs`), the shared rule
  `packages/shared/stock-cases.ts`, the keeper `stock-cases.service.ts` on every movement / import / pool settle,
  `POST /api/stock/adjust-locations` + `cases`, `PUT /api/stock/case-packs`, the Matrix Case column + pop-up, the
  stock editor's Cases column ("4 + 3").
- Before release: set `MATRIX_CASE_SINCE` (`_studio/matrix/statusCells.ts`) to the real release day.
- New table `ProductPackage` (product, units per case, case L/W/H cm, case weight kg) + FBA prep owner and label
  owner per SKU. Additive migration, model-ownership, scoped-keys, baseline.sql.
- New side table for sealed cases per location (same pattern as `StockBinQuantity`): `StockLevel.quantity` stays the
  unit total; loose units = total − cases × units per case. The push to channels does not change.
- Matrix Shared group: a "Case" column ("12 / case"); a click opens a small pop-up. The stock editor shows
  "4 cases + 3" per location and can open / count cases.

## Step 4 — Send to FBA — DONE locally 2026-10-07 (fake Amazon only)
- Build plan: `~/nexus-archive/2026-10-07-matrix-inventory/research/11-step4-build-plan.md`. Owner answers: loose units
  go in mixed boxes; units are held at Create plan (cancel releases them); placement is confirmed with ONE click that
  shows Amazon's fees; the first real plan is a real small send after release, stopped at the placement choice.
- Built: migration `20261008x_fba_send`, `packages/shared/fba-send.ts` (box rules), the fixed v2024-03-20 client, a
  background runner + resume job (never confirms on its own), `/api/fba/inbound/*` routes, holds + FBA_TRANSFER_OUT on
  Mark shipped, Amazon's inbound units kept (FbaInventoryDetail INBOUND rows), the Matrix toolbar action + dialog +
  plans drawer, "+N" on the FBA cell. Full browser flow passed against the fake Amazon.
- Switches: `NEXUS_ENABLE_FBA_INBOUND_SEND` (off by default — no plan reaches Amazon until it is on);
  `NEXUS_FBA_INBOUND_FAKE=1` (private stack only; refused in production and off a loopback test database).
- Before the first real send: the ship-from address (Settings › Company name + phone, IT-MAIN's warehouse address) must
  be filled in production; open the dialog in production and read its address line first.
- Known open: an FBA_SEND hold never expires by itself (cancel releases it); no route yet to correct a tracking number
  Amazon refused; "+N" shows Amazon's own inbound count (up to one 15-min read late).
- Tick rows → "Send to FBA…" → one dialog: From (default warehouse) · per SKU cases or units · boxes worked out ·
  checks (23 kg / 63.5 cm) · one summary · primary button "Create plan · N units".
- A background job runs Amazon's steps; each step's status shows live (Matrix cell + a small shipments drawer).
- The Owner picks the placement option (Amazon's fees shown). Confirming is final at Amazon → always his click.
- Own carrier first (delivery window + tracking). Labels as PDF.
- Stock: units leave the warehouse when "Shipped"; FBA shows "Inbound +N" from Amazon's numbers; Amazon's 15-min
  read adds them to FBA when received. Nexus never writes the FBA quantity.
- Fix the 4 v2 bugs; tables for plan lines, boxes, shipments; double-click protection.
- Tests use recorded Amazon answers. The first real plan is an Amazon write → only with the Owner's yes.

## Owner checks outside the code
- Pan-EU needs an active amazon.nl offer since 2026-09-03 (web research) — check in Seller Central.
- Does Amazon IT need a DDT with the boxes? (accountant / Seller Central IT).

## Decisions (Owner)
- **D1 — where "Sells from" is set.** CHOSEN: A. A: once per market for the whole business, with per-product exceptions in
  the Matrix (recommended). B: per product only.
- **D2 — cases.** CHOSEN: B. A: count units only; cases are worked out (48 units = 4 cases) (recommended, faster).
  B: count sealed cases and loose units separately per location (exact, more work, more counting).

## Several case sizes per SKU (Owner 2026-10-08) — DONE locally
The Owner asked for several case sizes per SKU (12 / case, 6 / case, …), wired end to end and real time. Lead's
choices: a sale opens the smallest case first; at most 5 sizes; the units per case name a size. Contract and screens:
`docs/matrix-inventory/CASE-SIZES.md`.
