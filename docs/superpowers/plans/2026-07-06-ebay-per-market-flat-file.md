# eBay Per-Market Flat File — Implementation Plan

> Makes the eBay flat file a genuinely separate, per-market file (parity with Amazon), instead of one all-markets editor with a client-side column swap.

**Goal:** Each eBay market (IT/DE/FR/ES/UK) is its own scoped, URL-driven view — loads only that market's listed products, switching re-scopes per market, cached per market so it stays instant.

**Architecture:** Reuse the exact machinery already in place: `buildListingScopeWhere({channel,marketplace,scope})` (per-market scope), the per-`ebayKey` SWR cache, the `onReloadCtxRef` reload trigger, and the URL sync already added to `handleMarketSwitch`. The eBay row still carries all-market columns (buildFlatRow unchanged → push / shared-SKU / image inheritance keep working); only the **product set** becomes per-market and the cache/fetch become per-market. The market column-group swap (MS-E) already scopes the visible columns to the active market.

**Constraints:** ESM `.js` on api imports · untouchable eBay editor/route edits are surgical & additive (this plan is the approval) · no schema change · commit+push when green.

---

## Changes

### Backend — `apps/api/src/routes/ebay-flat-file.routes.ts` (GET /rows)
- Add `marketplace?: string` to the Querystring.
- Read it: `const marketplace = request.query.marketplace?.toUpperCase() || undefined`.
- Thread into the scope filter: `buildListingScopeWhere({ channel: 'EBAY', marketplace, scope })` (per-market when provided; channel-level when absent → backward compatible). **Leave the `channelListings` include as-is** (all EBAY markets) so `buildFlatRow` still emits every market's columns and push/shared-SKU are unaffected.

### Client — `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx`
1. **Per-market cache key:** `const ebayKey = \`${familyId ?? '__global__'}:${marketplace}\``.
2. **Refs:** add `const marketplaceRef = useRef(marketplace)` and `const isFirstMarketEffect = useRef(true)`.
3. **Thread marketplace into both fetch sites** (initial `useLayoutEffect` ~L716 and `onReload` ~L891): `qs.set('marketplace', marketplaceRef.current)`.
4. **Market-change effect** (mirror the scope-change effect): on `marketplace` change (skip mount) — if this market's rows are cached & fresh, show them instantly via `latestSetRowsRef.current?.(snap.rows)`; else `void onReloadCtxRef.current?.()` to fetch the market's scoped rows.
5. `handleMarketSwitch` already updates the URL + `setMarketplace`; the effect above does the per-market re-scope. (No change needed there.)

---

## Steps

- [ ] **1.** Backend: add `marketplace` param + thread into `buildListingScopeWhere`. `cd apps/api && npx tsc -p tsconfig.json --noEmit` clean.
- [ ] **2.** Client: per-market `ebayKey` + `marketplaceRef`/`isFirstMarketEffect` refs.
- [ ] **3.** Client: `qs.set('marketplace', marketplaceRef.current)` in both fetch sites.
- [ ] **4.** Client: add the market-change reload effect (cache-aware).
- [ ] **5.** `cd apps/web && npx tsc -p tsconfig.json --noEmit` clean → commit + push.

## Verify (after deploy)
- `/products/ebay-flat-file?marketplace=IT` shows only eBay-IT-listed products; switching to DE re-scopes to eBay-DE-listed products + updates the URL; switching back to a visited market is instant (cache).
- A SKU listed on eBay-IT but not eBay-DE appears in IT, not in DE (unless "All products").

## Rollback
Additive; omitting `?marketplace` reproduces channel-level behavior. Revert the commit to restore all-markets load.
