# Per-Market Inventory Control — Full Plan (Follow Master + safe saves)

**Date:** 2026-07-08 · **Status:** PROPOSAL, awaiting approval. No code until approved; then phase-by-phase, verified on prod each step ("face-to-face").
**Owner constraints honored:** flat-file editors are change-protected (this IS the approval request); FBA quantity is untouchable; new UI on the design system; ship live + verify on prod.

---

## 1. Goal — what you will control, and where

**One physical stock number per product** (the shared warehouse pool) that you set in exactly one place, and **full per-(channel × market) control** over how each listing draws from it — visible and editable right in the flat-file grid, identically on Amazon and eBay.

Concretely, per listing (= product × channel × market) you control:

| Control | How it's stored | Where you set it | Per-market? |
|---|---|---|---|
| **Quantity: follow the pool or pin a fixed number** | `followMasterQuantity` + `quantity`/`quantityOverride` | **NEW: Qty + Follow columns** in the flat file | ✅ per active market |
| Pinned quantity value | `quantity`/`quantityOverride` | Qty column (editable once pinned) | ✅ |
| Price: follow master or override | `followMasterPrice` + `price`/`priceOverride` | Price column (already per-market) | ✅ |
| Title / description / bullets | `followMasterX` + `*Override` | flat file / product drawer | ✅ |
| Buffer (units held back from the pool) | `stockBuffer` | **RECOMMEND: Buffer column** | ✅ |
| Publish / active | `isPublished` / `listingStatus` | flat file / bulk-action | ✅ |

**The shared pool itself is NOT per-market** — it's one number, controlled ONLY by the **/stock page and imports**. Every channel/market derives from it unless you pin it. This is the mental model the whole plan protects.

## 2. Two hard invariants (the safety spine)

**Invariant A — the tool NEVER writes the shared pool.** It writes only per-listing columns (`followMasterQuantity`, `quantityOverride`, `quantity`) on the specific listing. It never touches `StockLevel`/`Product.totalStock`. This is what prevents the AIRMESH wipe (an eBay-market qty edit that rewrote the pool and zeroed every market).

**Invariant B — Amazon FBA quantity is NEVER written or pushed.** Defense in depth, all verified in current code:
1. Backstop (never weakened): `buildAmazonListingPatch` (`outbound-sync.service.ts:173`) sends a merchant quantity only `if (!isFba)`; `isFbaListing()` is fail-closed (any FBA signal ⇒ strip qty). An FBA quantity can never reach Amazon.
2. Follow column renders "—"/disabled for FBA rows (reuse `isFbaQtyCell`, `AmazonFlatFileClient.tsx:6601`).
3. Save + follow endpoint skip FBA listings entirely.
4. FBA stock isn't in the merchant pool, so Invariant A already keeps it out. eBay is always FBM (no FBA there).

Both invariants get explicit tests (pool byte-unchanged; FBA quantity fields byte-unchanged) after every operation.

## 3. The quantity write — done correctly (the column hazard)

There's no single authoritative quantity column — different push paths read different ones (`marketplaces/*-sync` → `quantityOverride ?? totalStock`; eBay publish → `quantity`; cockpit/import → `quantityOverride ?? quantity`). So a correct write sets **all of them coherently**:

- **Follow ON (rejoin pool):** `{ followMasterQuantity: true, quantityOverride: null }`, recompute base `quantity = availableToPublish(warehouseAvailable − stockBuffer)` (FBM only), enqueue a `QUANTITY_UPDATE` push.
- **Pin OFF:** `v = current effective qty (quantityOverride ?? quantity ?? pool-available)`; write `{ followMasterQuantity: false, quantityOverride: v, quantity: v }`; enqueue push. **Snapshot ⇒ nothing changes at the moment of pinning**; you then edit the number deliberately.

The one place already doing this fully-correct write is `stock-import.service.ts` `pinOverride` (~L700-729) — we reuse that exact shape.

## 4. The UI — a Follow column, identical on both editors

Both editors show **one active market at a time** (verified — the eBay "all markets" claim was wrong; `EbayFlatFileClient.tsx:851` shows only the active market). So the design is symmetric:

- A **`Follow`** dropdown column (`Follow` / `Pinned`) sits next to the active market's **Qty**, in both Amazon and eBay.
- **Follow** ⇒ the Qty cell mirrors the live pool number and tracks it. **Pinned** ⇒ Qty is your editable fixed value. Typing into a following Qty auto-flips it to Pinned.
- Edited/filled/pasted like any other field ⇒ **bulk is native** (select a range, fill `Pinned` down 200 rows). No special button needed.
- **FBA rows:** Qty and Follow both render "—"/disabled.
- Switch markets with the strip to control another market; the market you're not on is untouched.
- **eBay shared "Quantity" column** (a legacy "shared/default" field separate from per-market `it_qty`): OPEN DECISION — keep as read-only reflection, or hide it, so Follow is unambiguously based on the per-market Qty. (Needs your answer on whether you use it.)

## 4b. UX affordances — tooltips + warnings (REQUIRED, owner-mandated)

Nothing ships without clear guidance on-screen. Every new control explains itself, and the model change is impossible to forget.

- **Follow column header tooltip:** "Follow = this market draws from the shared warehouse pool (auto-updates). Pinned = this market holds the fixed quantity you set and ignores the pool. Default: Follow."
- **Follow cell (per market):** hover shows the current effective source ("Following pool: 24" vs "Pinned at 0"). FBA cells show "—" with a tooltip: "Amazon FBA — quantity is managed by Amazon and can't be set here."
- **Qty column header tooltip:** "When Following, this shows the live pool quantity. When Pinned, it's the value you set for this market. Typing a value pins this market."
- **Standing reminder (the owner-requested "remind me every time"):** a persistent, non-dismissible info bar in BOTH editors near Save: **"Saving updates per-listing values only. Warehouse stock is managed on the Stock page and imports — the flat file never changes your pool."** Always visible, zero friction.
- **Warning modal on risky bulk changes:** when a save (or a fill-down) would *stop N listings following the pool* or *publish 0 to a live market*, a confirmation lists exactly what changes ("6 listings will stop following the pool · 2 will publish 0 to eBay-DE — proceed?"). Not shown for benign edits.
- **First-save-after-rollout notice:** the very first save after Phase 1 lands shows a one-time explainer that flat-file saves no longer move warehouse stock (so the behavior change is never a surprise), then the standing bar carries it thereafter.
- All copy/components come from the design system; verified with a screenshot self-check before shipping.

## 5. Safe saves — the companion fix (required, not optional)

Because the Follow/Qty columns save like every other field, both editors' **save must be reworked** so a save writes only per-listing values and **never the shared pool**:
- eBay save (`ebay-flat-file.routes.ts:664-737`) — stop the `StockLevel`/`totalStock` write; a market's qty edit pins that listing (Invariant A).
- Amazon save (`amazon/flat-file.service.ts:2674-2748`) — same; also fix it to write the value in all quantity columns coherently (§3), not just base `quantity`.
This is the change that finally makes "one place controls stock (/stock + import); the flat file controls per-listing publishing" actually true. It touches the protected flat-file routes → needs explicit approval.

## 6. Recommendations — things worth adding (your call)

1. **Buffer column** (`stockBuffer`) per market — hold back N units on a channel (e.g. keep eBay 2 lower than the pool) without pinning. Natural companion to Follow.
2. **Reconcile the 295 already-pinned Amazon listings.** Some are in the column convention `marketplaces/*-sync` ignores, so they may currently push the pool instead of their pinned value. One-off audit + normalize to §3's coherent shape. (eBay: all 75 currently follow the pool, none pinned.)
3. **Save preview / confirmation** on commit: "N listings will stop following the pool · M will publish 0". Cheap insurance against a bad fill-down. (The flat file already has a validation step to hang this on.)
4. **Oversell note:** pinning a market above the pool is allowed (shared pool = every channel can sell up to the full pool); the existing order-time oversell clamp settles contention. No pre-split of stock (per your earlier decision).
5. **Audit trail:** every follow/pin flip is journaled to `ChannelListingOverride` — you can see who changed what, when.
6. **Read cache already fixed (ES.4, shipped):** stock changes now refresh the product list immediately, and a 15-min reconcile cron heals any drift — so the "list didn't update / products vanished" class is closed independently of this work.
7. **Shopify:** out of scope (no Shopify flat-file editor; not transacting). The same follow/override model exists in the schema if it's ever needed.

## 7. Phased rollout (approve-then-build, verify each on prod)

- **Phase 0 — Backend primitive** (`POST /api/listings/follow-master-quantity`, or extend `processMarketplaceOverrideUpdate`): the correct per-listing follow/pin write (§3), FBA-skipped, pool-untouched, audited, enqueues push. + unit tests incl. both invariant tests. *No UI risk.*
- **Phase 1 — Safe saves** (§5): both flat-file saves stop writing the pool; per-listing writes coherent (§3). Verify a save no longer moves `StockLevel`.
- **Phase 2 — Follow column** in both editors (dropdown cell, per active market, FBA "—"), wired to Phase 0's write. Bulk via fill/paste. + optional save preview.
- **Phase 3 — Reconcile** the 295 pinned Amazon listings to the coherent convention (audit → normalize).
- **Phase 4 — Polish:** Buffer column (if wanted), drift surfacing, docs.

**Verification each phase (prod, end-to-end):** pin eBay-DE → only DE changes, pool + eBay-IT + Amazon untouched → edit DE to 0 → only DE goes 0 → set Follow → DE rejoins and tracks the pool. Repeat on an Amazon market. Confirm an FBA row shows "—" and its quantity is unchanged throughout. Confirm `StockLevel`/`totalStock` unchanged by any grid save.

## 8. Open decisions I need from you

1. **eBay shared "Quantity" column** — do you use it? Keep as read-only reflection, or hide it (base Follow purely on per-market Qty)?
2. **Label:** `Follow` / `Pinned`, or literal `true` / `false`?
3. **Buffer column** — include now (Phase 2) or later (Phase 4)?
4. **Reconcile the 295 pinned Amazon listings** as part of this — yes?
5. **Companion save fix** (§5, touches protected flat-file routes) — approved as part of this?

## 9. Current live state (baseline)

- eBay: 75 active listings, all follow the pool, none pinned (can't pin from the eBay editor today). Markets IT, DE.
- Amazon: 477 follow, 295 pinned. Markets IT, DE, FR, ES.
- Read-cache reconcile (ES.4) shipped + live. AIRMESH-style pool clobber still possible until Phase 1 lands.
