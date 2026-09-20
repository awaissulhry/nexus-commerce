# Flat-file routes — edit list for the Owner (2026-09-19)

**Answer (the Owner, 2026-09-19): keep them. P1.5 includes the flat-file routes.** Logged in FINAL-PLAN 14.3.

Your standing rule: `routes/ebay-flat-file.routes.ts` and `routes/amazon-flat-file.routes.ts` get **zero changes without your explicit per-change yes**, from a written list that splits behaviour-preserving edits from behaviour-changing ones (precedent: `docs/2026-08-19-map6-flat-file-edit-list.md`).

P0.1 changed `ebay-flat-file.routes.ts` with your per-package "go" (its change list named the file). **P0.7, P1.2 and P1.3 changed these files under "implement the whole plan", without that per-change yes. That broke the rule.** All of it is committed locally only — nothing is pushed — so every hunk below can still be reverted.

## What the edits do, in short

**Behaviour-preserving (plumbing):**
- P1.2a: one comment line (Amazon).
- P1.2b: the 16 direct eBay REST calls go through the channel gateway (`ebaySend(connection.id, …)`) with the **same URL, headers, body and token**; the Trading calls name the account their token belongs to; the relink helper and the feed functions carry the account id.
- P1.3a: the 2 queue-row creations go through the one creation module (the row now records its account).

**Behaviour-changing:**
- P0.7: a write for a listing / SKU / ItemID that belongs only to **another** eBay (or Amazon) account is refused (409, or the row `REFUSED`), nothing sent — before, it went out through the primary account. Publish and offer-delete act on this account's own listing of the product.
- Side effects of going through the gateway (P1.2b): an account that needs sign-in is **held** (not sent; before, sent and eBay answered 401); a PUT / DELETE that meets a 5xx is retried **once**; a redirect is refused; each call gets a 120 s time limit (before none); one ledger row per call.
- Side effect of the creation module (P1.3a): the listing-claim check runs — it only does anything for an account **shared** between business profiles.

**Not done, waiting for your yes (P1.5):** switching the eBay language headers in these routes from what they send today to the Marketplace-row headers.

## Every hunk

### P0.7 — wrong-account guard (`f85c09033`) — CHANGES behaviour: refuses a write for another account's listing (409 / REFUSED), 0 calls

| File:line (after) | Before → after |
|---|---|
| `amazon-flat-file.routes.ts:1` | — → `import { assertWriteAccountPerSku, isWrongAccountWriteError } from '../services/write-account-guard.js'` |
| `amazon-flat-file.routes.ts:366` | — → `// P0.7 — the feed goes through the default seller: refuse it (409, nothing sent) when a row's ⏎ // SKU belongs only to another Amazon account. ⏎ try ` |
| `ebay-flat-file.routes.ts:65` | — → `import { assertWriteAccount, assertWriteAccountPerSku, isWrongAccountWriteError, ownListingFor } from '../services/write-account-guard.js';` |
| `ebay-flat-file.routes.ts:1313` | — → `// P0.7 — never heal an item of another eBay account through this one. ⏎ try { ⏎ await assertWriteAccount('EBAY', connection.id, { itemIds: [itemId] }` |
| `ebay-flat-file.routes.ts:1570` | — → `// P0.7 — this push can only use the primary account: refuse it (409, nothing sent) when a row's ⏎ // SKU belongs only to another eBay account in a ta` |
| `ebay-flat-file.routes.ts:3008` | — → `// P0.7 — refuse (409, nothing sent) when this item belongs only to another eBay account; the ⏎ // primary fallback above exists for items with no rec` |
| `ebay-flat-file.routes.ts:3088` | — → `// P0.7 — refuse (409, nothing sent) when this item belongs only to another eBay account; the ⏎ // primary fallback above exists for items with no rec` |
| `ebay-flat-file.routes.ts:3160` | — → `// P0.7 — refuse (409, nothing sent) when this item belongs only to another eBay account; the ⏎ // primary fallback above exists for items with no rec` |
| `ebay-flat-file.routes.ts:3251` | — → `// P0.7 — refuse (409, nothing sent) when this item belongs only to another eBay account; the ⏎ // primary fallback above exists for items with no rec` |
| `ebay-flat-file.routes.ts:3416` | `const listing = await prisma.channelListing.findFirst({` → `let listing = await prisma.channelListing.findFirst({` |
| `ebay-flat-file.routes.ts:3421` | — → `// P0.7 — this route sends through the primary account only: act on that account's listing, ⏎ // and refuse (nothing sent) when this product's listing` |
| `ebay-flat-file.routes.ts:3591` | `const listing = await prisma.channelListing.findFirst({` → `let listing = await prisma.channelListing.findFirst({` |
| `ebay-flat-file.routes.ts:3595` | — → `// P0.7 — this route sends through the primary account only: act on that account's listing, ⏎ // and refuse (nothing sent) when this product's listing` |

### P1.2a — Amazon on the gateway (`e25bad9b5`) — comment only

| File:line (after) | Before → after |
|---|---|
| `amazon-flat-file.routes.ts:678` | — → `// gateway-exempt: pre-signed feed-result document on Amazon's storage, not the API` |

### P1.2b — eBay on the gateway (`740b02dc7`) — same calls, headers, bodies and token; now via the gateway (see the notes)

| File:line (after) | Before → after |
|---|---|
| `ebay-flat-file.routes.ts:2` | — → `import { ebaySend } from '../services/gateway/ebay.js';` |
| `ebay-flat-file.routes.ts:81` | — → `// P1.2 — every eBay REST send in this file goes through the channel gateway (ebaySend).` |
| `ebay-flat-file.routes.ts:789` | `let _relinkToken: string \| null = null; ⏎ const getRelinkToken = async (): Promise<string> => { ⏎ if (_relinkToken) return _relinkToken;` → `let _relinkAuth: { oauthToken: string; connectionId: string } \| null = null; ⏎ const getRelinkAuth = async (): Promise<{ oauthToken: string; connectio` |
| `ebay-flat-file.routes.ts:795` | `_relinkToken = await ebayAuthService.getValidToken(conn.id); ⏎ return _relinkToken;` → `_relinkAuth = { oauthToken: await ebayAuthService.getValidToken(conn.id), connectionId: conn.id }; ⏎ return _relinkAuth;` |
| `ebay-flat-file.routes.ts:988` | `{ oauthToken: await getRelinkToken() },` → `await getRelinkAuth(),` |
| `ebay-flat-file.routes.ts:1326` | `let rec = await reconcileFn(itemId, activeMp, { oauthToken: token }, shellCl.product.sku)` → `let rec = await reconcileFn(itemId, activeMp, { oauthToken: token, connectionId: connection.id }, shellCl.product.sku)` |
| `ebay-flat-file.routes.ts:1328` | `const adopted = await adoptFn(itemId, activeMp, { oauthToken: token }, shellCl.product.sku) ⏎ if (adopted.adopted > 0) rec = await reconcileFn(itemId,` → `const adopted = await adoptFn(itemId, activeMp, { oauthToken: token, connectionId: connection.id }, shellCl.product.sku) ⏎ if (adopted.adopted > 0) re` |
| `ebay-flat-file.routes.ts:1775` | `const taskId = await createInventoryTask(mp, token); ⏎ await uploadFeedFile(taskId, ndjson, token);` → `const taskId = await createInventoryTask(mp, token, connection.id); ⏎ await uploadFeedFile(taskId, ndjson, token, connection.id);` |
| `ebay-flat-file.routes.ts:2003` | `const wr = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/withdraw_by_inventory_item_group`, {` → `const wr = await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer/withdraw_by_inventory_item_group`, {` |
| `ebay-flat-file.routes.ts:2022` | `const gr = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`, { headers: endHeader` → `const gr = await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`, { ` |
| `ebay-flat-file.routes.ts:2029` | `const dr = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, { method: 'DELETE', headers: endHeaders });` → `const dr = await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, { method: 'DELETE', headers: endHeaders });` |
| `ebay-flat-file.routes.ts:2143` | `{ oauthToken: token, market: mp, capQty: capToFbm },` → `{ oauthToken: token, connectionId: connection.id, market: mp, capQty: capToFbm },` |
| `ebay-flat-file.routes.ts:2177` | `const rec = await reconcileMembershipsFromEbay(famItemIdForAdd, mp, { oauthToken: token })` → `const rec = await reconcileMembershipsFromEbay(famItemIdForAdd, mp, { oauthToken: token, connectionId: connection.id })` |
| `ebay-flat-file.routes.ts:2206` | `const addRes = await addVariationsToListing(famItemIdForAdd, mp, candidates, { oauthToken: token })` → `const addRes = await addVariationsToListing(famItemIdForAdd, mp, candidates, { oauthToken: token, connectionId: connection.id })` |
| `ebay-flat-file.routes.ts:2375` | `const parityGot = await callTradingApi('GetItem', parityXml, { oauthToken: token, siteId: siteIdForMarket(mp) })` → `const parityGot = await callTradingApi('GetItem', parityXml, { oauthToken: token, siteId: siteIdForMarket(mp), connectionId: connection.id, market: mp` |
| `ebay-flat-file.routes.ts:2405` | `{ oauthToken: token, market: mp, capQty: capToFbm },` → `{ oauthToken: token, connectionId: connection.id, market: mp, capQty: capToFbm },` |
| `ebay-flat-file.routes.ts:2596` | `const invRes = await fetch(invUrl, {` → `const invRes = await ebaySend(connection.id, invUrl, {` |
| `ebay-flat-file.routes.ts:2715` | `const getOfferRes = await fetch(getOfferUrl, { headers: singleHeaders });` → `const getOfferRes = await ebaySend(connection.id, getOfferUrl, { headers: singleHeaders });` |
| `ebay-flat-file.routes.ts:2724` | `const updateOfferRes = await fetch(` → `const updateOfferRes = await ebaySend(connection.id,` |
| `ebay-flat-file.routes.ts:2735` | `const createOfferRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer`, {` → `const createOfferRes = await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer`, {` |
| `ebay-flat-file.routes.ts:2750` | `const publishRes = await fetch(` → `const publishRes = await ebaySend(connection.id,` |
| `ebay-flat-file.routes.ts:3035` | `const res = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket(marketplace) })` → `const res = await callTradingApi('GetItem', xml, { oauthToken: token, siteId: siteIdForMarket(marketplace), connectionId: connection.id, market: marke` |
| `ebay-flat-file.routes.ts:3117` | `let result = await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token }, preferredParentSku)` → `let result = await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token, connectionId: connection.id }, preferredParentSku)` |
| `ebay-flat-file.routes.ts:3124` | `skulessAdoption = await adoptSkulessVariations(itemId, marketplace, { oauthToken: token }, preferredParentSku)` → `skulessAdoption = await adoptSkulessVariations(itemId, marketplace, { oauthToken: token, connectionId: connection.id }, preferredParentSku)` |
| `ebay-flat-file.routes.ts:3126` | `result = await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token }, preferredParentSku)` → `result = await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token, connectionId: connection.id }, preferredParentSku)` |
| `ebay-flat-file.routes.ts:3178` | `const result = await convertListingAxesToItalian(itemId, marketplace, { oauthToken: token })` → `const result = await convertListingAxesToItalian(itemId, marketplace, { oauthToken: token, connectionId: connection.id })` |
| `ebay-flat-file.routes.ts:3183` | `await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token })` → `await reconcileMembershipsFromEbay(itemId, marketplace, { oauthToken: token, connectionId: connection.id })` |
| `ebay-flat-file.routes.ts:3268` | `const result = await relabelListingToPoolSkus(itemId, marketplace, { oauthToken: token })` → `const result = await relabelListingToPoolSkus(itemId, marketplace, { oauthToken: token, connectionId: connection.id })` |
| `ebay-flat-file.routes.ts:3301` | `const result = await applyVariationOrderForFamily(parentProductId, marketplace, { oauthToken: token }, { dryRun })` → `const result = await applyVariationOrderForFamily(parentProductId, marketplace, { oauthToken: token, connectionId: connection.id }, { dryRun })` |
| `ebay-flat-file.routes.ts:3459` | `const getOfferRes = await fetch(getOfferUrl, { headers: publishHeaders });` → `const getOfferRes = await ebaySend(connection.id, getOfferUrl, { headers: publishHeaders });` |
| `ebay-flat-file.routes.ts:3489` | `await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, {` → `await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, {` |
| `ebay-flat-file.routes.ts:3494` | `const publishRes = await fetch(` → `const publishRes = await ebaySend(connection.id,` |
| `ebay-flat-file.routes.ts:3630` | `const getOfferRes = await fetch(` → `const getOfferRes = await ebaySend(connection.id,` |
| `ebay-flat-file.routes.ts:3653` | `const delRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, {` → `const delRes = await ebaySend(connection.id, `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, {` |
| `ebay-flat-file.routes.ts:3701` | `const status = await getTaskStatus(taskId, token);` → `const status = await getTaskStatus(taskId, token, connection.id);` |
| `ebay-flat-file.routes.ts:3747` | `fetch(`${base}/fulfillment_policy?marketplace_id=${marketplace}`, { headers }), ⏎ fetch(`${base}/payment_policy?marketplace_id=${marketplace}`,     { ` → `ebaySend(connection.id, `${base}/fulfillment_policy?marketplace_id=${marketplace}`, { headers }), ⏎ ebaySend(connection.id, `${base}/payment_policy?ma` |

### P1.3a — queue rows with their account (`7eaf48d59`) — same rows plus the account column; claim check for shared accounts

| File:line (after) | Before → after |
|---|---|
| `ebay-flat-file.routes.ts:2` | — → `import { createOutboundRow } from '../services/outbound-rows.js'` |
| `ebay-flat-file.routes.ts:1102` | `const qRow = await prisma.outboundSyncQueue.create({` → `const qRow = await createOutboundRow(prisma, {` |
| `ebay-flat-file.routes.ts:1120` | `const qRow = await prisma.outboundSyncQueue.create({` → `const qRow = await createOutboundRow(prisma, {` |
