# PUBLISH-EVERYWHERE (PE) — plan for the Owner, 2026-09-26

Owner, 2026-09-26: *"switch on the publishing for every channel and market."* This lane: P1, P3, P4, P5 of
`docs/variation-theme/PUBLISH-EVERYWHERE.md` (VTR worktree; PR #45). Not this lane: WooCommerce (removal stands), variation theme/values (VTR).

**Status: APPROVED 2026-09-26 — Owner in this session: "go"** (after the plan and D1/D2 were shown with (a) recommended):
**D1 (a), D2 (a), and every default in §9.** Build order: P1 prepare → P4.0 → P3.0 → … Each live send and each switch still needs the Owner's word per run.
Research: `RESEARCH-P3-ebay.md`, `RESEARCH-P4-shopify.md`, `RESEARCH-P5-etsy.md` (this folder). Paths start at `apps/api/src/`.

## 1. Today (read 2026-09-26)

| Channel | Switch in production | Studio Publish today | Blocked |
|---|---|---|---|
| Amazon | **on** (boot log 18:32 UTC) | change-only per market (PCO) | first live proof never run (P1) |
| eBay | **on** | change-only, Trading items only | **208 listings / 8 families use the Inventory model → refused**; variation changes on live items refused (R-PCO-2) |
| Shopify | **off** | new products only | existing products refused; **no tool to link** a Nexus family to the store's products |
| Etsy | **off** | "not available yet" | no studio adapter (the P4.6 write client exists) |

Production API build `b70469ed` (health, 18:45 UTC). origin/main is 6 commits newer (#41, #37, #38, #32, #21, #44).

## 2. Order of work (recommended)

1. **P1 — the two one-listing proofs** (Amazon IT, eBay IT). No product code. Prepare only when you are ready to answer (a prepared proof lives 2 hours).
2. **P4.0 — one Shopify safety fix** (small, first): a full-overwrite route exists for existing Shopify products. Safe today only because Shopify is off.
3. **P3 — eBay** (biggest gain: 208 live listings).
4. **P4 — Shopify** linking + change-only. Value order waits for VTR step 1.
5. **P5 — Etsy** adapter. Starts with a read-only count of the Etsy shop.

Each step: tests red first, then green; mutation checks; fresh types; local proof on the private copy `nexus_pe_test`;
then the first live send per channel is ONE listing: read → preview → write → read back → restore → delayed re-read — on your word per run.

**Marker check, production, read-only, 2026-09-26 ~19:45 UTC (`BEGIN READ ONLY`):** eBay IT, per item — AIREON 40/40, AIRMESH 20/20,
IT-MOSS 30/30, REGAL 40/40, VENTRA 40/40, WATERPROOF 10/10, normal-knee-slider 8/8 children carry `__offerIds`; GALE-JACKET: the
primary item 20/20, its 4 alias items 0/20 each (Trading, as PCO found); xavia-knee-slider: 0/8, no active child. No item is PARTIAL.
This shows the database is consistent. It cannot show a marker was never erased — only eBay can (P3.0).

## 3. P1 — the two proofs (PCO-7)

| | Amazon IT | eBay IT (Trading) |
|---|---|---|
| Listing | GALE-JACKET-BLACK-MEN-S | one normal Trading family item (tool picks, >12 h before end) |
| Change | add one hidden token to the Italian backend search terms | add one hidden HTML comment to the description |
| Buyer sees a change? | no | no |
| Restore | exact original value | exact original description (byte for byte) |
| Check before send | Amazon validates both the send and the restore | local compiled preview; live GetItem |

Tools exist: `docs/publish-changes-only/tools/pco7-amazon-proof.mts`, `pco7-ebay-proof.mts` (`--prepare`, then `--execute-approved --proposal --digest`).
Preparing = read-only production database + live channel reads (these may refresh a login token and write gateway log rows; nothing else).

Found:
- The Amazon tool runs code from the main checkout (`ROOT = '/Users/awais/nexus-commerce'`), which is **63 commits behind** origin/main.
  Fix: one line — take ROOT from the tool's own location, as the eBay tool does. Run both from this worktree (origin/main code),
  with the main `.env` symlinked in for the run only, then removed.
- The eBay tool checks the source of `pim/studio-publication-ebay.ts`, which PR #45 changes → prepare the eBay proof **after #45 merges**.
- Proposal files hold real seller/item ids. **The repo is public** → they are never committed (checked before every push).

Flow: you say "prepare P1" → I prepare → I show you the exact send and restore → you say "send the Amazon proof" (and/or eBay) within 2 hours → I run it → I report the read-backs.

## 4. P3 — eBay

Goal: (a) studio Publish for the 8 Inventory-model families, change-only; (b) variation changes on live items (Trading and Inventory).

| Step | What | Done when | Stop if | Rollback |
|---|---|---|---|---|
| P3.0 | Read-only production probe of the 8 families: real group key vs parent SKU, variants vs Nexus, offers, other-market drafts, sold count per variant. **Also every other ACTIVE eBay family: ask eBay (Inventory API offer lookup by SKU, read-only) which model it really uses** — the Nexus marker `__offerIds` can be erased by past flat-file saves (VTR step 0b bug) | all recorded (counts, no ids in git); Nexus marker = eBay truth for every active item | a family differs → refused in v1 | none |
| P3.1 | Inventory reader: group GET + `bulk_get_inventory_item` + GetItem; a failed read shows "Cannot compare" | stubbed tests; one local read | >10 s for a 41-listing family | revert |
| P3.2 | Inventory change plan (pure): group title, description, pictures, aspects; per-SKU aspects/pictures. Built from the fresh read with only the ticked fields replaced. Price, stock, offer fields refused by name | table tests; a group PUT never drops a live SKU | comparator cannot reuse `compareEbayContent` | revert |
| P3.3 | Inventory sender: item PUTs then group PUT; re-read before send; journal each request; accept a field only after read-back; **never delete offers**; publish call only if proven needed | stubbed order + refusal tests | eBay needs a publish after content | revert |
| P3.4 | Wiring: replace the refusal at `pim/studio-publication-ebay.ts:112` with the Inventory branch; selection + service arms | review lists rows, not a refusal | #45 not merged (VTR file) | revert → refusal returns |
| P3.5 | Trading variation changes: add / change value / remove / reorder rows, per **D1** | compiled XML echoes eBay's own price and available stock | eBay refuses value changes on SKU items | revert |
| P3.6 | Inventory variation changes (add / value / remove / reorder) | proven on one listing | removal meaning unclear | revert |
| P3.7 | Review screen rows (existing ChangeReview DS component): "price/stock sent back unchanged: X / Y" | browser light/dark, 390 px | a shared DS file must change | revert |
| P3.8 | Live proofs, one listing each, on your word per run | recorded read-backs | any mismatch | restore step in the run |

Rules kept: a variant with sales is never removed silently — refused by name, and "set stock 0" stays a separate stock action.
Found, fix in P3.5: `ebay-axes-convert.service.ts:61,89` sends back eBay's LIFETIME quantity (available + sold). It would add sold units
back to stock. It has never succeeded, so no harm yet.
Inventory proof: smallest family (normal-knee-slider, 8): description comment added then exact restore; price and stock of every SKU must stay the same.
Trading proof: (1) value reorder only; (2) an "identity" revise on a variant with a sale, to prove what eBay's Quantity means; (3) one value change on a variant with no sales.

## 5. P4 — Shopify

Found: your store keeps **each colour as its own Shopify product**, joined by a `custom.variation_products` list (your choice, 2026-09-09).
One Nexus family = several Shopify products. Today's publisher would rebuild them as one product → never used on existing products.

| Step | What | Done when | Stop if | Rollback |
|---|---|---|---|---|
| P4.0 | **Safety**: `synchronizeContent` refuses any Shopify product Nexus did not create (covers the images route, the queue, the wizard); linked-product content from the queue becomes "publish needed" (per **D2**); a gid in productType is refused by name | tests: existing product → 0 mutations | needs >3 files | revert |
| P4.1 | **Linking** (local only): pick a Shopify product or its colour family → read variants → exact SKU match → preview (matched / only in Nexus / only in Shopify / duplicates) → save ids. New links start **paused**. Unlink | a mocked client that fails on ANY mutation stays green | >20 % SKUs unmatched → manual pairing screen | unlink |
| P4.2 | Live read: existing `readInformation` + option/value order read | "Cannot compare" on failure | >10 s per family | revert |
| P4.3 | Change plan (pure): title, description, vendor, productType, tags, SEO, category (from the attributes lane's one map only), mapped metafields, barcode, weight, HS code, origin. Price/stock/SKU/handle never sent. Add/remove variants, media, translations refused by name (later) | table tests | — | revert |
| P4.4 | Send: `productUpdate` / `productVariantsBulkUpdate` / `metafieldsSet` only — **never `productSet` on an existing product**; re-read before; journal; read back; accept per SKU | payload = preview, byte for byte | >1 migration | revert |
| P4.5 | Value order from `AttributeOption` (VTR step 1): `productOptionsReorder` listing all live values | GALE sends XXS…5XL | VTR step 1 slips | revert |
| P4.6 | Review screen (existing ChangeReview) | DS + browser checks | — | revert |
| P4.7 | Before the switch: read-only production census (0 pending Shopify queue rows, 0 AUTOMATIC links, …). Then **your word** → Railway `NEXUS_ENABLE_SHOPIFY_PUBLISH=true` + `SHOPIFY_PUBLISH_MODE=live` + redeploy | boot log `Shopify=live`; 30 min logs with 0 unexpected writes | any unexpected writer | unset both + redeploy |
| P4.8 | One-product proof on your word: one SEO description change → read back → restore | only that field differs | anything else differs | restore in the run |

## 6. P5 — Etsy

| Step | What | Done when | Stop if | Rollback |
|---|---|---|---|---|
| P5.0 | Read-only production count: which profile owns the Etsy shop, how many shop listings, how many already linked in Nexus, 2 or 3 variations, regional pricing, every automatic Etsy writer | record with counts only | anything needs a write | none |
| P5.1 | Live reader (`GET` listing, inventory, properties) + new `channel-drift/etsy-content-compare.ts` | table tests; one local read parses | a field cannot be compared | revert |
| P5.2 | Change plan: title, description, tags, materials, policy and classification fields. Category only from the one map. State, auto-renew, images refused by name. Price/stock never sent | one ticked field → a PATCH with one key | — | revert |
| P5.3 | Sender + service/selection/web arms: re-read → journal → PATCH → read back → accept on match | stubbed + real-DB tests; gated sends nothing | VTR `studio-publication-plan.ts` not merged | revert |
| P5.4 | Variations (existing SKUs only): echo live price/stock per **D1**; per-listing lock shared with the stock lane; add/remove refused by name | one renamed value = the only difference in the PUT | VTR step 1 not done | revert |
| P5.5 | Proof tool (`--prepare` / `--execute-approved --digest`), like the eBay one | preparing writes nothing | — | delete |
| P5.6 | Your word → Railway `NEXUS_ENABLE_ETSY_PUBLISH=true` + `ETSY_PUBLISH_MODE=live` + redeploy; Etsy added to the boot log line | boot shows `Etsy=live`; 0 unexpected Etsy writes | unexpected sends | flag off + redeploy |
| P5.7 | One-listing proofs on your word: (1) title + tags (settles the open array question); (2) one variation value renamed and restored | read-backs match; price and stock unchanged | any mismatch | restore in the run |

Note: when Etsy is on, **master price changes also go to Etsy** listings that follow the master price (`master-price.service.ts` has
no channel filter). That is normal behaviour, but P5.0 counts those listings before the switch.

## 7. Files (named before the first edit; none edited yet)

| Step | New files | Changed files | Held by another lane |
|---|---|---|---|
| P1 | — | `docs/publish-changes-only/tools/pco7-amazon-proof.mts` (ROOT line) | — |
| P3.0–P3.3 | `docs/publish-everywhere/tools/ebay-inventory-probe.mts`, `pim/studio-publication-ebay-inventory.ts`, `pim/studio-publication-ebay-inventory-changes.ts` (+ tests) | `ebay-inventory-drift.service.ts` (share the group read) | — |
| P3.4 | — | `pim/studio-publication-ebay.ts`, `pim/studio-publication-selection.ts`, `pim/studio-publication.service.ts` | **VTR** (`studio-publication-ebay.ts`) until #45 merges |
| P3.5 | — | `pim/studio-publication-ebay-changes.ts`, `ebay-axes-convert.service.ts` | — |
| P3.7 / P4.6 | — | `apps/web/src/app/products/[id]/edit/_studio/publication/PublishDialog.tsx` (+ model) | — |
| P4.0 | — | `shopify/content-sync.service.ts`, `shopify/listing-write.service.ts`, `outbound-sync.service.ts` (Shopify content branch only) | VTR reads content-sync (no edit) |
| P4.1 | `shopify/link.service.ts`, a route, a studio link dialog (DS components) | — | — |
| P4.2–P4.4 | `pim/studio-publication-shopify-changes.ts` (+ tests) | `shopify/information-gateway.ts`, service/selection arms | — |
| P4.5 | — | `shopify/content-publisher.ts`, `shopify/content-workspace.service.ts` | **VTR** (after step 1) |
| P5.1–P5.5 | `channel-drift/etsy-content-compare.ts`, `pim/studio-publication-etsy.ts`, `pim/studio-publication-etsy-changes.ts`, `etsy/inventory-variations.ts`, proof tool | `etsy/listing-content.ts`, `etsy/inventory-write.service.ts` (lock), `pim/studio-publication-plan.ts` (:66), `runtime/scheduler.ts` (boot line) | **VTR** (`studio-publication-plan.ts`); `etsy/*` client = channel-connections (coordinate) |

Category (Etsy `taxonomy_id`, Shopify `category`): from the attributes lane's one channel → category-field map (Owner chose A). No fallback here.
`resolve-batch.service.ts` and `studio-sheet.service.ts` belong to the attributes lane.

## 8. Found on the way (not built here)

1. **10 real Shopify ids (products, themes) in the public repo**: `docs/audits/2026-09-09-shopify-family-migration/README.md`.
   A scrub like PR #38 hides them in the current files; git history keeps them.
2. The Shopify full-overwrite route (P4.0) — safe while Shopify is off.
3. The flat-file eBay publish deletes other-market offers when a publish fails (`ebay-variation-push.service.ts:2025`) — P3 never reuses it.
4. The flat-file eBay variation delete silently sets stock 0 when eBay refuses (`ebay-flat-file-delete.service.ts:196-203`).

## 9. Decisions for the Owner

**D1 — Variation changes on live listings (eBay now, Etsy later).** eBay needs the price and stock in the same message.
- **(a) Recommended:** send back the channel's OWN live price and live available stock, read a moment before. Refuse while a stock
  sync is waiting. Show those numbers in the review. Re-send Nexus stock after. Nothing moves unless the channel moved in that second. (Changes R-PCO-2.)
- (b) Keep refusing these changes.

**D2 — Automatic Shopify title/description pushes to linked products.** Today each child row would overwrite the shared product title.
- **(a) Recommended:** stop them. Content goes to Shopify only through Publish (you see it first).
- (b) Keep them, after a fix.

**Defaults I take unless you say otherwise:** new Shopify links start paused · link per family with a preview · keep your separate colour
products · an eBay variant with sales is never removed silently · the eBay Inventory proof runs on the smallest family (8 listings) ·
the Etsy scope is set after the P5.0 read-only count · read-only production reads (P3.0, P4.7 census, P5.0) are run by me.

## 10. Progress

| Step | State | Commit (local branch, not pushed) |
|---|---|---|
| Plan | ✅ approved by the Owner 2026-09-26 ("go") | `bfded1bc0` |
| P1 Amazon prepare | 🔴 **BLOCKED — KMS.** The tool fix is in `bfded1bc0`. `--prepare` stopped before any Amazon call: `credentials: KMS Decrypt failed (AccessDeniedException)`. Since 2026-09-26 ~06:20 UTC every channel login in production is sealed with KMS key `alias/nexus-credentials-production`; only the Railway IAM user can open it. This Mac cannot. Nothing was sent, nothing was written. | — |
| P4.0 Shopify guard + D2 | ✅ built and tested locally: 5 new refusal tests + 1 flipped (red first), 670 Shopify/queue tests green, 4/4 mutations caught (sha256 restored), API types clean | `746ead5b1` |
| P3.0 eBay probe | 🔴 same KMS block for the eBay reads; the database half can run | — |

**The KMS block hits every live read and proof run from this Mac** (P1, P3.0, P3.8, P4.7–4.8, P5.0, P5.7). Two ways out — the Owner decides:
(a) run the tools ON the production server (it already holds the key): merge the tool changes, deploy, then run them there with
`railway ssh`; no new key anywhere; or (b) give this Mac decrypt rights on the key (fast, but this laptop could then open every channel login).

## 11. Proposed addition — "Read live" (Owner requirement relayed by VTR, 2026-09-26 ~23:40; NOT yet confirmed in this session)

Owner (VTR session): *"I also want the ability to read whatever is currently live on the channel."* Spec: VTR `docs/variation-theme/LIVE-READ.md`.
Proposal: one reader per channel, one shape, used by both the publish review and the Information sheet. This lane would own the readers +
a read-only route; VTR owns the sheet side. eBay Inventory (P3.1), Shopify (P4.2) and Etsy (P5.1) readers are already in this plan and
will be written in that shape. **New for this lane (needs the Owner's word here):** the Amazon and eBay Trading readers in the same shape,
and the route. Files (none held today): `apps/api/src/services/live-read/{index,types,amazon,ebay-trading,ebay-inventory,shopify,etsy}.ts`,
`packages/shared/src/live-read.ts`, `apps/api/src/routes/live-read.routes.ts`. Shape changes sent to VTR: a `revision` + server-only raw
documents; addressable errors (item / SKU / field); `content` keyed by the review's field ids; `state` needs the expected SKUs; stock = available.
