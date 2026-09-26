# P5 Etsy — research (read-only, 2026-09-26)

No file edited, no Etsy call, read-only SQL on the local copies. Paths start at `apps/api/src/services/`. Labels: R read · M measured · I inferred.

## 1. What the P4.6 client writes today

| Area | Endpoint | Status |
|---|---|---|
| Content | `PATCH /shops/{shop}/listings/{id}` (form, partial) | only `title`, `description`, `tags`, `materials`, `image_ids` (`etsy/listing-content.ts:44-125`) R; Etsy also takes policies, classification, weights, sizes (`pim/channel-specs/etsy-listing-schema.ts:88`) — not wired |
| State | same PATCH | separate on purpose; `active` needs an explicit yes (sold-out → qty 1 + paid renewal, `listing-content.ts:142-158`) R |
| Stock + price | `PUT /listings/{id}/inventory` (JSON, full replace) | read → strip → change → skip if same → PUT → 2 s → read back → drift alert (`etsy/inventory-write.service.ts:46-111`); only price + qty change (`etsy/inventory.ts:240`); `property_values` / `*_on_property` echoed (`:188-210`); no per-listing lock R |
| Images | POST multipart / DELETE | exists (`listing-write.service.ts:99-150`) R |
| Not built | — | create draft, listing properties, translations, variation images, `max_variations_supported=3` R |

- Only caller: the outbound Etsy lane (`outbound-sync.service.ts:2465, :2490`).
- Stock cascade skips Etsy (`stock-movement.service.ts:820`); content cascade skips Etsy (`master-content.service.ts:18`).
  **Master price cascade has no channel filter** (`master-price.service.ts:214, :286`; verified by the main session) → linked Etsy
  listings that follow the master price get price PUTs once the switch is live. 0 Etsy queue rows locally (M).
- Gate: `NEXUS_ENABLE_ETSY_PUBLISH` off → gated; on + `ETSY_PUBLISH_MODE=live|production` → live; else dry-run
  (`etsy-publish-gate.service.ts:28-43`). Gateway applies it to writes (`gateway/gateway.ts:215-218`, `gateway/channels.ts:36`).
  Studio: Etsy `unavailable` (`pim/studio-publication.service.ts:24`, refusal `:90`). Boot line omits Etsy (`runtime/scheduler.ts:1028`).

## 2. How Nexus holds an Etsy listing; local counts

- One `ChannelListing` per product (ETSY, GLOBAL, ETSY_GLOBAL); shop id in `identity.extra.shopId` (`etsy/account.ts:53-61`);
  listing id = `externalListingId` (shared by family rows, I). Products matched by SKU; fallback `product.etsyListingId` always null
  (column only on `ProductVariation`, schema.prisma:1402).
- Local (M): 1 Etsy connection in `nexus_legacy_workspace` (listings r/w/d scopes, token valid to 2026-12-12); 2 Etsy rows (GALE-JACKET
  parent + 1 child), DRAFT, no listing id, no `taxonomy_id`; 0 snapshots / drift / queue rows; 3 Etsy category schemas; Etsy GLOBAL = EUR, `{en}`.
- Production ownership is unknown (channel-connections §0a row 6, Owner correction 2026-09-22). Studio publish does not check listing
  claims (only `outbound-rows.ts:60` does).
- Category: `taxonomy_id` resolves empty today (`pim/mapping/resolve-batch.service.ts:338`); the attributes lane's channel→category-field
  map (Owner chose A, 2026-09-26) fixes it. No fallback of ours.

## 3. Etsy v3 contract

- `updateListing` PATCH (form): partial; null clears; arrays as repeated keys — unproven live (P4.6d §6). If Etsy keeps only the last
  key, tags collapse to one; read-back would catch it.
- `updateListingInventory` PUT (JSON): replaces the whole inventory; each product needs `sku`, `property_values`, `offerings`
  (`price` number, `quantity`, `is_enabled`, `readiness_state_id`) + the four `*_on_property` arrays; strip read-only keys; price reads back as Money.
- Variations: 2 properties by default (3 needs `max_variations_supported=3`, else a 400 on read); custom 513/514 carry free text (I);
  the VTR resolver offers only category properties with `supports_variations` (`variation-theme-facts.ts:267`); local limit table
  says 2 axes / 70 (`family-projection-limits.ts:109`) — maybe 70 options per property (unsure).
- Coupling (unsure): empty `price_on_property` → one price for all; property id change must remap arrays; product/offering ids may
  regenerate on each PUT; a custom value rename may drop its variation image. Value order likely first-appearance (measure on the proof).
- A variation change without price/stock change: echo every offering's price, qty, `is_enabled`, readiness by SKU from a read right
  before; limits: regional-pricing bug can blank the domestic price on ANY PUT; a sale in the read→PUT second; a NEW variant has no
  live values to echo; Etsy SKU limit 32 chars (unsure) — 17 of 301 local variant SKUs are longer (M).

## 4. How PCO plugs in a channel

No formal interface; each channel = switch arms + `prepareXPublication` / `prepareXChanges` / `compileXChanges` / `sendXPublication`
(+ optional `readXPublication`). Arms: `studio-publication.service.ts:24, :25, :71-95, :205, :256-307`; `studio-publication-selection.ts:7-20`;
`apps/web/…/_studio/publication/PublishDialog.tsx:77`. Baseline / records / overwrite work unchanged.
Live read: `etsy/information-content.ts` is a local helper, not a live read → need a reader (`GET /listings/{id}`, `/inventory`,
`/properties`) and a new `channel-drift/etsy-content-compare.ts`.

## 5. Risks

Master price cascade starts Etsy price PUTs once live · listing language may differ from `{en}` (translations not built) · 17 SKUs
may exceed 32 chars · 10,000 calls/day · nothing ever sent live to Etsy · regional pricing.
