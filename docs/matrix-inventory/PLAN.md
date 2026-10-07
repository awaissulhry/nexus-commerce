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
- **Status:** Step 1 DONE locally (not pushed). Next: Step 2.

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

## Step 2 — "Sells from" per market
- One list: `syncRoutes` is the truth; the Locations page edits the same list.
- Inactive warehouses stop feeding listings (from Step 1's check).
- Matrix: a "From" cell in each market group (once for AMAZON:EU). Pop-up = tick locations; the order of the list
  = which location ships first. Bulk Edit gets a "Sells from" field.
- Saving re-pushes the affected listings and sends `inventory.stock_changed` (no silent change).
- Orders take stock from the first location in the market's list that has stock (replaces the fixed warehouse).
- Combine = sum only. Not now: percent, max shown, per-market combine modes.

## Step 3 — Cases (D2 = B: sealed cases + loose units)
- New table `ProductPackage` (product, units per case, case L/W/H cm, case weight kg) + FBA prep owner and label
  owner per SKU. Additive migration, model-ownership, scoped-keys, baseline.sql.
- New side table for sealed cases per location (same pattern as `StockBinQuantity`): `StockLevel.quantity` stays the
  unit total; loose units = total − cases × units per case. The push to channels does not change.
- Matrix Shared group: a "Case" column ("12 / case"); a click opens a small pop-up. The stock editor shows
  "4 cases + 3" per location and can open / count cases.

## Step 4 — Send to FBA
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
