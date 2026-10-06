# Etsy publisher — PLAN (2026-10-05)

Status: **APPROVED by the Owner 2026-10-05 ("I'll go with your recommendations. Please go ahead"): D1–D4 = A.**
Lane: ETSY-PUBLISHER. Base: origin/main 502761c62. Research (private, has real ids):
`~/nexus-archive/2026-10-05-etsy-publisher/` — R1-ETSY-API.md (Etsy API), R2-STUDIO-CONTRACT.md (studio contract),
R3-ETSY-IN-NEXUS.md (Etsy code in Nexus), R4-ETSY-DATA.md (data), ETSY-PHOTO-RESEARCH.md (photos).

## Summary
- Goal: Publish in the product sheet (and Claude's publish tools) sends a Nexus product family to Etsy, the same way
  as eBay: review → change plan → send → read back → receipt.
- Today: Etsy has a sign-in, read and write clients, a publish switch, price and stock pushes, and Pause/Resume.
  Etsy has no create, no full listing update, no variations build, no photos and no live read.
- Data: only **Motovento** has an Etsy shop (connected). **No business has an Etsy listing in Nexus.** So the first
  real use is to CREATE a listing from Nexus.
- Plan: 5 small PRs (E1–E5). E1 shows the review only. Nothing reaches Etsy before E2 and the Owner's switch.

## 1. Facts that shape the design (from the research)
- One Etsy listing per product family, market GLOBAL; each child product = one Etsy "product" (variation) with its
  own SKU. Variant rows already carry the parent's `externalListingId` (R3 §6).
- Etsy has **no idempotency key**. A second create POST makes a second listing (R1 §11). Nexus never retries
  POST/PATCH (apps/api/src/services/etsy/write-client.ts:94-95,114-115).
- `updateListingInventory` is a **full replace**: a product left out is deleted on Etsy (R1 §3).
- Price, quantity, SKU and processing profile go **only** through inventory. Every physical offering needs
  `readiness_state_id` (R1 §2-3).
- Create and update bodies are form-encoded; inventory and variation images are JSON; photos are multipart (R1).
- A draft needs quantity ≥ 1 and the 7 fields quantity, title, description, price, who_made, when_made, taxonomy_id.
  To go active it needs ≥ 1 photo, a complete shipping profile and a processing profile. An EU shop needs no return
  policy (R1 §1-2).
- An active listing at stock 0 becomes **sold out**. `state=active` on a sold-out listing silently sets quantity 1
  (R1 §2). Each activation costs about $0.20 (BELIEVED).
- Etsy stock writes in Nexus are skipped unless Etsy order import is on for the account
  (apps/api/src/services/etsy/order-ingest-switch.ts:20-49). This stops double sales.
- Etsy Ads may switch on by default for listings made by API (BELIEVED, R1 §1).

## 2. The contract (how Etsy plugs into studio publication)
Same shape as eBay Trading (R2 §1.2, §10). There is no registry; Etsy gets explicit branches.

New files (apps/api/src/services/pim/):
- `studio-publication-etsy.ts`
  - `EtsyPublication { kind: 'etsy'; listingId | null; products[{productId, sku}]; listing (form fields);
    inventory (full products[]); properties; translations; liveRevision; liveContent; fieldWrites; notices;
    full?; createState?: 'draft' | 'active' }`
  - `prepareEtsyPublication(facts, {full?, inactiveProductIds?})` — reads the family's resolved cells, runs every
    check, collects every problem, reads Etsy only when live and the listing exists, throws `{issues, notes}` or a
    `gateOnly` error (eBay pattern, studio-publication-ebay.ts:867-870).
  - `sendEtsyPublication(plan, accountId, reviewId, beforeSend)` → `{reference, verified, warnings}`.
- `studio-publication-etsy-changes.ts` — `prepareEtsyChanges` (one change per field via `planPublicationChanges`;
  a new listing is one `__create__` change) and `compileEtsyChanges` (pure).
- `studio-publication-etsy-problems.ts` — the problem collector (copy of the eBay one).
- `apps/api/src/services/live-read/etsy.ts` — one live read (listing, inventory, properties, translations, images)
  used by the review, the read-back and later the sheet.
- Writers in `apps/api/src/services/etsy/`: create draft, update listing (all fields), properties, translations,
  full inventory build. All through `etsyWriter` (the gateway).

Existing files that get an ETSY branch: the full list is in R2 §7.3 (studio-publication.service.ts mode/prepare/
plan/sparse/send, -selection.ts compile, -plan.ts skips, -settle.ts go-live write, publish-plan.ts, shared
publish-actions.ts / listing-actions.ts, publish.tools.ts, web dialog destinations.ts / pickers.ts).

Receipts: the existing `BulkOperation` + `ChannelListingSnapshot` + `ChannelPublishAttempt` journal, written
before each call. Etsy returns VERIFIED or UNVERIFIED at once from the read-back (like Shopify).

What each part of the listing maps to:
| Nexus (sheet) | Etsy call | When |
|---|---|---|
| title, description, tags, materials, category, who/when made, is_supply, type, section, shipping profile, return policy, weight/size, taxable, auto-renew, EU guarantee | createDraftListing (new) / updateListing PATCH | Publish |
| category properties (`etsyProperties`) | updateListingProperty PUT / delete | Publish |
| other languages (`_etsyInformationLocales`) | listing translations | Publish |
| variations (family axes → `variationMapping`), SKUs, processing profile | updateListingInventory (full products[]) | Publish (create, or a variation change) |
| price, quantity of existing variations | the existing price/stock doors | on save, as today |
| Product media | photo-core Etsy adapter | Publish (E4) |
| Status (Draft / Active / Inactive) | updateListing `state` | Publish / listing-action engine |

## 3. PRs (small, one worktree each)
| PR | What | Reaches Etsy? |
|---|---|---|
| **E1** review only | Etsy adapter: build the payload, every problem, the change plan, the JSON preview. Live read for an existing listing. Studio Publish and MCP `publish-review` show the result. Send says "Sending to Etsy comes in the next step." Fix: the review names the shop, not the raw `displayName` field. | No |
| **E2** update existing | Send for listings that exist: PATCH fields, properties, translations, inventory structure (full replace from a fresh read). One inventory write per listing for price/stock (today one per variant row, R3 §5). Settle branch. Sheet Action "Full update" for Etsy; drop "Etsy fields are not sent". Sheet holds Status changes by mode, not only by the flag. | Yes, only with the switch on |
| **E3** create as draft | createDraftListing with a "creating" marker first; store the listing id on every family row at once; then E2's steps; read back. New-listing Status for Etsy: **Draft**. "Active" is refused with the reason "Etsy needs at least 1 photo — photos come with E4". | Yes, only with the switch on |
| **E4** photos + go live | Etsy adapter on the PHOTO-CORE shared core: download → JPEG → multipart upload with explicit rank → delete extras → set order → variation images → record assetId ↔ listing_image_id. Then **activation** (state=active) after a pre-flight check. | Yes |
| **E5** live read + drift + Claude tools | `includes=Images` (and inventory) on the 4-hourly sweep, drift mark in the sheet. MCP `publish-listing`, `set-listing-content`, `listing-live-content` for Etsy; `tags` grouped as keywords; skill file `etsy.md`. | Reads only (plus publish through the same gate) |

E4 waits for the PHOTO-CORE PR to merge. The adapter interface is agreed through the Owner.
What the Etsy adapter needs from the core: the ordered photo list of one listing (locale `und`), each with
assetId, URL, content hash and alt text; and each variation value's own photo (one property only).

### E1 notes for the next PRs (from the E1 reviews)
- A new variation of a listing already on Etsy defaults to Active (for sale), like eBay and Amazon. "Inactive" (hidden)
  is refused until Nexus can show one hidden Etsy variation again (the price/stock pushes keep Etsy's `is_enabled`;
  Pause/Resume act on the whole listing). E2 decides whether to add that path.
- E2 must add ETSY to the publication batch's sparse set (`publication-batch.service.ts`) and default ticks
  (`publication-batch.processor.ts`), and an Etsy settle branch (go-live write) instead of the Amazon-style closed offer.
- E2 must check that the claim's revision check does not refuse a send only because live stock moved.

## 4. Safety rules
1. **An Etsy POST is never retried.** Before a create, Nexus writes a "creating" marker on the family's listing row.
   No answer → UNVERIFIED. A second create is refused while a marker is open, until Nexus finds the draft on Etsy
   (drafts page, match by SKU and title) or a person marks it checked.
2. **Every send = read → diff → act → read back.** VERIFIED only when the read-back matches. A failed step leaves a
   draft; the next Publish reads it again and sends only what still differs.
3. **Inventory is a full replace.** Nexus always sends every variation, built from a fresh Etsy read plus the family.
   A live Etsy variation with no Nexus row blocks the send, unless Full update lists its removal.
4. **New listings start as drafts.** Nothing goes live until the Owner picks Active. The review says the listing fee.
5. **Going live needs:** ≥ 1 photo, shipping profile, processing profile, stock > 0, and Etsy order import on for
   that shop (decision D3). Nexus never sets `state=active` on a sold-out listing; it sends the stock first.
6. **The switch:** `NEXUS_ENABLE_ETSY_PUBLISH=1` and `ETSY_PUBLISH_MODE=live` on Railway. Claude never sets them; the
   Owner does. Until then the review shows the full plan and "nothing was sent".
7. **Ids never cross businesses.** The shop id comes from the account's own identity; the listing id only from
   this business's own Etsy account. Tests use fake ids (the repo is public).
8. **Quota:** the gateway honours 429 `retry-after`. A batch publish checks `x-remaining-today` first and stops
   early instead of half-publishing.
9. **Live tests:** only after the Owner's yes, on one draft listing, after Claude says exactly what reaches Etsy.
   Things only a live call can prove: does `image_ids` remove omitted photos; does a draft accept all-0 stock;
   repeated `tags=` keys; is `readiness_state_id` needed on a draft POST.

## 5. Decisions (Owner chose A for all four, 2026-10-05)
- **D1 — How a new Etsy listing starts.** A: as a draft; you set Status Active to sell (recommended). B: active at once.
- **D2 — Stock 0.** Etsy cannot sell at 0 (it shows "sold out") and cannot create at 0. A: at 0 Nexus makes the listing
  as a draft, with the real stock; it goes live when you Publish with stock (recommended). B: refuse to publish at 0.
- **D3 — Going live without Etsy order import.** A: go live only when Etsy order import is on, so an Etsy sale lowers
  Nexus stock and no unit sells twice (recommended; this is today's rule for Etsy stock). B: allow it (risk: double sales).
- **D4 — Order of work.** A: build E1 → E3 now; photos and go-live (E4) after the PHOTO-CORE PR merges (recommended).
  B: wait for the photo core before E2.

### E2 decisions (Owner, 2026-10-05: "B B")
- **D5 = B:** the price/stock pushes send ONE inventory write per Etsy listing (not one per variation row). In E2.
- **D6 = B:** one variation of a live Etsy listing can be hidden (Status Inactive → `is_enabled: false`) and shown
  again (Active → `is_enabled: true`); a new variation may start hidden. In E2.

### Parallel build (Owner, 2026-10-05: "A")
- E3 (create as draft) is built stacked on E2 as soon as E2's review fixes land; E5a (live read + drift on the 4-hourly
  sweep) is built at the same time in its own worktree; E5b (Claude tools) after E2 merges. Each PR has its own review
  and its own "merge #N". About 6 agents at once at most (the Mac is shared).

## 6. Out of scope (park; ask before adding)
- Delete on Etsy (Action Delete) — Etsy delete cannot be undone; Pause/Resume already exist.
- Adopting the shop's listings that are not in Nexus (bulk import). Linking one family at a time already works.
- A 3rd variation (`max_variations_supported=3`), personalization, digital listings, videos.
- Creating shipping or processing profiles from Nexus (Nexus picks the shop's existing ones).
- Etsy Ads settings; sale prices on Etsy.
- Removing the dead legacy Etsy code (R3 §10) — not needed for the goal.
- Moving or renaming an Etsy SKU on a live listing.
