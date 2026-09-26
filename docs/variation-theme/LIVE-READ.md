# Read live — what is on the channel right now (Owner requirement, 2026-09-26 ~23:40)

The Owner: *"I also want the ability to read whatever is currently live on the channel."*

## What the Owner gets

- On the Information sheet, for any channel × market × account × listing alias: **Read live**. It reads the listing from the channel
  now (read only, nothing is sent) and shows, beside Nexus:
  - the content fields (title, description, bullets, item specifics / attributes, category, images, …);
  - the variation structure: axes and their channel names, every variant with its values, the value order, and what the channel says
    about each variant (live / missing / extra — a variant on the channel that Nexus does not have);
  - price and stock as the channel shows them (read only; they are still set by the price and stock doors);
  - the read time, and "Could not read" with the reason when a read fails — never an empty value that looks like "no change".
- Differences are marked (Nexus vs live). The same read feeds the publish review, so the review and the sheet can never disagree.

## One reader per channel, one shape

`readLiveListing(destination) → { readAt, source, content, variations: { axes[], variants[{ sku, values, price, stock, state }],
order }, errors[] }` — pure normalisers on top of the existing channel reads:

| Channel | Existing read to reuse | Owner of the reader |
|---|---|---|
| Amazon | `getListingsItem` per SKU (PCO live read at review) | publish lane (PCO code) |
| eBay Trading | `GetItem` (`readLiveItem` in `studio-publication-ebay.ts`) | publish lane |
| eBay Inventory | group GET + `bulk_get_inventory_item` (PE P3.1) | publish lane |
| Shopify | `readInformation` / `readRemoteProduct` (PE P4.2) | publish lane |
| Etsy | listing + inventory + properties GET (PE P5.1) | publish lane |

VTR owns the sheet side: the **Read live** action and the comparison view in the Variation panel (step 3) and a general live column
set on the Information sheet. Channel logins are KMS-sealed since 2026-09-26 ~06:20 UTC, so live reads run in the deployed API only;
local work uses recorded, anonymised fixtures.

## Rules

Read only. Rate-limited per channel (a family read counts as one action). Never stored as Nexus data; the last read is kept with its
time so the sheet can show it without a new call. A read never changes what publish sends.

## Agreed with the publish lane (~23:55)

1. `revision` = digest of the parsed live content; the raw provider documents stay server-side (`raw`, never sent to the web). The
   review compiles sends from the fresh raw object and re-checks `revision` at send.
2. `errors[{ scope: 'item'|'sku'|'field', sku?, field?, reason }]` — one unread SKU shows "Could not read" for that SKU only; the
   review marks exactly those rows "Cannot compare".
3. `content` keyed by the publish review's field ids (title, description, pictures, `aspect:<key>`, Amazon
   `<attribute root>@<marketplace>/<language>`, Shopify/Etsy field keys) — sheet columns and review rows line up 1:1.
4. The reader takes the expected SKUs and marks `live|missing|extra`; stock = channel-reported AVAILABLE (eBay GetItem: Quantity −
   QuantitySold, labelled).
Files (publish lane): `apps/api/src/services/live-read/{index,types,amazon,ebay-trading,ebay-inventory,shopify,etsy}.ts` + tests,
`packages/shared/src/live-read.ts`, `apps/api/src/routes/live-read.routes.ts` (`POST /products/:id/live-read`, rate-limited). The
Amazon + eBay Trading readers and the route are new scope for that lane — it asks the Owner to confirm in its session.
VTR builds the sheet side in step 3 against the shared type only.

