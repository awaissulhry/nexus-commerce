# Amazon: listing reference

Read with the list-product skill. The business's own markets, languages and account ids come from `business-overview` (`markets[].code`, `marketplaceId`, `sharesEuQuantity`; `accounts.AMAZON[].id`): a business can switch a market off or carry other languages than the table below.

## 1. Markets Nexus supports

| Code (tools take) | Marketplace id | Currency | Content languages | One EU quantity | Notes |
|---|---|---|---|---|---|
| IT | APJ6JRA9NG5V4 | EUR | it | yes | |
| DE | A1PA6795UKMFR9 | EUR | de | yes | |
| FR | A13V1IB3VIYZZH | EUR | fr | yes | |
| ES | A1RKKUPIHCS9HS | EUR | es | yes | |
| NL | A1805IZSGTT6HS | EUR | nl | yes | |
| BE | AMEN7PMS3EDWL | EUR | nl + fr | yes | two languages: write the text in both |
| IE | A28R8C7NBKEWEA | EUR | en | yes | |
| PL | A1C3SOZRARQ6R3 | PLN | pl | yes | needs its own PLN price |
| SE | A2NODRKZP88ZB9 | SEK | sv | yes | needs its own SEK price |
| UK | A1F83G8C2ARO7P | GBP | en | no: own quantity | code `UK`, never `GB`; needs its own GBP price |
| TR | A33AVAJ2PDY3EV | TRY | tr | no: own quantity | needs its own TRY price |
| US | ATVPDKIKX0DER | USD | en | no | inactive unless the business turned it on; net prices |

- Prices are decimals in the market's currency, VAT included (US: net). A listing that follows the master price gets it only where the market sells in the master currency (EUR unless the server sets another). Nexus never converts.
- "One EU quantity": Amazon keeps ONE merchant (FBM) quantity per SKU for all nine markets marked yes. In `listing-matrix` it is the `AMAZON:EU` cell; price and sale stay per market (`AMAZON:DE`).
- Photos and the variation theme are one per account and ASIN: they show in every Amazon market.

## 2. Before the first publish

| What | How | Note |
|---|---|---|
| Drafts | `create-draft-listings` (`channel: AMAZON`, `market`, `accountId` when the business has several Amazon accounts) | One market per call; several markets = one plan. |
| Product type | Nexus picks it: this market's listing, else the family's Amazon listings in the region's other markets (when they agree), else the category mapping, else `create-product` `productType` | Type Amazon's own code. One type per family. `product-content` does not show it; on an existing product a person changes it in the product sheet. |
| Required attributes | `product-content` (`product`, `coordinate: {channel: AMAZON, market, accountId}`): `required`, `options` + `optionsOnly` (send the option code), `unitOptions`, `maxLength`/`maxBytes`; gaps from `content-gaps` / `listing-issues` | Set with `set-listing-fields` `values` (a measure is `{value, unit}`). A preview `warning` means Amazon will likely refuse it at publish: fix it first. `rulesMissing` = no schema cached, requirements unknown. |
| Variation theme | `set-listing-fields` `variationTheme` (its own request: values, variants and theme never together) | Only a theme Amazon accepts for the product type. Nexus builds parentage, the child-parent link and the theme on every row: never set them as values. |
| Variations added after the drafts | `set-listing-fields` `variants: {include: [ids]}` | Creates their draft rows. |
| Barcode | `set-gtin` on each variation (the sellable SKUs) | No barcode: the GTIN-exemption attribute (`supplier_declared_has_product_identifier_exemption`) through `set-listing-fields`, only if `product-content` lists it. |
| Text per market language | `set-content` (shared text, per language) or `set-listing-content` (this listing's own text; its `language` must be one of the market's) | A language with no text is left out of what is sent, never filled from another language: a create then lacks title/bullets and Amazon refuses. BE needs nl and fr. Limits come per product type and market from `product-content`; over-limit text is saved with a warning and blocks the publish. Keywords go out as one string joined by spaces. |
| Photos | `media-plan` (`destination` for the Amazon layout) → `add-photo-from-url` → `arrange-photos` | `arrange-photos` needs the family on the media plan (a person switches it on the Media page). Layout: MAIN + PT01–PT08 per ASIN (9); long edge under 500 px is an error, under 1000 px a warning (no zoom). Off the plan: the product gallery, 1 to 9 photos. |
| Price | master price, or `set-listing-price` `set-price` on `AMAZON:<M>` from `listing-matrix` | Required in PLN, SEK, GBP, TRY markets. On a draft it is stored and sent by the first publish. Must sit inside the product's floor/ceiling (`set-price-bounds`) and Amazon's min/max. |
| Fulfilment (FBA/FBM) | `set-listing-stock` `action: "set-fulfilment"`, `method` FBA or FBM, targets `AMAZON:<M>` from `listing-matrix` (the EU markets share one: `AMAZON:EU`); or a person in the Amazon sheet's Fulfillment method column | Without one, a new variation or single blocks the publish. It sends Amazon nothing: it sets what Nexus sends. |
| Stock (FBM) | the first publish sends what the stock sync works out: following the stock (with buffer and routed locations) or a pin (`set-listing-stock`) | 0 is allowed. Needs a stock location routed to the market (`set-stock-policy` `locationCode` + `feeds`) and no stock-sync hold there. FBA rows send no quantity. |
| How a new row starts | the product sheet's Status column (Active / Inactive / Not listed): a person | Default Active. An Inactive create is made without this market's offer. |

## 3. Publish and follow

1. `publish-review` (`productId`, `channel: AMAZON`, `market`, `accountId`, `listingId` for an alias): reads Amazon live, saves nothing. `ready` = no error issue. `changes`: SEND, DIFFERS (replaces Amazon's value), CANNOT_COMPARE (never sent), SAME. `previousPublicationId` = one still in flight here.
2. `publish-listing` (`productId`, `channel: AMAZON`, `marketplace` — not `market` — `accountId`, `listingId`, `fields`):
   - **First publish** (the review shows a new row): `fields: "all"` only. Sends the complete listing: content in each market language, attributes, product type, barcode, photos, and per sellable row its offer (price in the market currency, a sale with both dates) and fulfilment (FBM: the merchant quantity; FBA: Amazon's code, no quantity). A parent gets no offer.
   - **Re-publish** (live listing): only the groups named — `title`, `description`, `bullets`, `keywords`, `attributes` (all other attributes). Never price, quantity or fulfilment: `set-listing-price` / `set-listing-stock` send those straight away.
   - **Photos on a live listing** normally do not go through `publish-listing` (`fields: "photos"` may answer "Nothing to send"): a person sends them with Publish photos on the product studio's Media page (or from Images for a family not on the media plan).
   - Preview: `summary`, `creates[{sku, startsAs}]`, `held[{sku, why}]`, `warning` (a first publish in an EU market with no live EU siblings sets the one EU quantity for all nine), `euQuantity` (what it sends vs what the live EU markets hold). Values in `send` are clipped: read price and quantity from `listing-matrix` and say them when asking.
   - At run time the studio reviews again; any difference sends nothing. Amazon's own validation runs per row before the upload: a refusal there sends nothing and the approval waits again with Amazon's words.
   - Undo: a first publish is undone with `close-listing` (this market's offer removed; the listing stays). A re-publish is put back only by publishing the old values.
3. `approval-status` → `publication.publicationId` → `publication-status`:

| Status | Meaning |
|---|---|
| NOT_SUBMITTED | the review was never sent |
| PUBLISHING | being sent; no receipt within 30 minutes → UNVERIFIED |
| SUBMITTED | Amazon's feed is processing |
| ACCEPTED | feed processed; whether it shows in the store is still Amazon's decision |
| PARTIAL | some products rejected: `results[]` per SKU |
| FAILED | every product rejected, or the feed was cancelled |
| UNVERIFIED | may have reached Amazon; Nexus does not resend by itself |

Nexus re-checks in-flight publications every 2 minutes (Amazon is asked after 2, 4, 8 and 15 minutes, then every 30, for up to 7 days). Then `listing-issues` (`sku` = the parent SKU as a prefix covers the family; `productId` is that one product only, `channel: AMAZON`, `market`) for what Amazon reported.

## 4. Refusals and their fix

| Refusal (starts with / contains) | Cause | Fix |
|---|---|---|
| `Amazon · <M> is not an active market in this business.` | market off or absent | use a code from `business-overview` |
| `… <n> active Amazon accounts (…). Name one as accountId.` / `Ambiguous AMAZON connection` | several accounts | pass `accountId` |
| `there is no listing here yet. Start its drafts first` | no draft | `create-draft-listings` |
| `every product of the family already has a listing there` | variations made after the drafts | `set-listing-fields` `variants.include` |
| `only listing attributes (attr_<attribute>) are set here` | key has quantity/price/fulfil/stock, or is title/description/bullets/keywords | price/stock/content tools; an Amazon attribute with such a word in its name (e.g. a package quantity): a person in the product sheet |
| `is not a variation theme Amazon accepts…` / `Amazon has deprecated <THEME> here` | wrong theme | pick one of the codes the refusal lists |
| `Set the Amazon variation theme in Information before publishing.` | family without theme | `set-listing-fields` `variationTheme` |
| `<SKU>: choose a fulfillment method before publishing.` | no FBA/FBM | `set-listing-stock` `set-fulfilment` (section 2) |
| `Amazon fulfils this product (FBA), but this listing is set to FBM.` | FBA stock or code on an FBM row | `set-listing-stock` `set-fulfilment` `method: "FBA"`, or a person chooses FBA |
| `<SKU> is fulfilled by Amazon (FBA): its quantity is Amazon's, and this first publish would send one.` | FBA row would carry a quantity | a person publishes it from the Nexus studio |
| `this first publish in <M> would set Amazon's one EU quantity to <n>, but its live EU listings hold …` | EU rows disagree | align the one EU quantity (`listing-matrix` `AMAZON:EU`, `set-listing-stock` there), then review again |
| `Amazon <M> sells in <CUR>, and this listing follows the master price in <EUR>. Nexus does not convert it.` / `has no price of its own for Amazon <M>` | no market price | `set-listing-price` `set-price` |
| `is below the pricing floor` / `above the pricing ceiling` / `below the minimum price on Amazon` | price out of bounds | change the price or the bounds |
| `No quantity was worked out for <SKU>: no stock location is routed to <M>` | no routed location | `set-stock-policy` `locationCode` + `feeds` |
| `No quantity was worked out for <SKU>: its pushes are paused (channel policy)` | stock sync held for that market | `set-stock-policy` `pushesPaused: false` |
| `add a product image` / `at most nine images` / `choose a main photo on the Media page` / `has no MAIN photo` / `Amazon needs 500 px` | photos | `add-photo-from-url`, `arrange-photos` |
| `this family's photos are not on the media plan yet` | family off the plan | a person switches it on the Media page |
| `Review the <Language> (<lang>) <field> before publishing.` | AI-drafted text not reviewed | re-save it with `set-content` / `set-listing-content` (saved as reviewed) |
| warning `is not translated … omitted from the payload` | no text in that language | `set-content` in that language |
| `Sync this category schema before publishing.` | no cached Amazon schema | a person: Settings › Mappings, Sync schema for that market and product type |
| `The completed listing payload is invalid:` / `Mapping validation failed:` / `<SKU>: <code>: <message>` | missing or wrong attribute values, Amazon's validation | fill the named attributes (`set-listing-fields`) |
| `This seller SKU already exists on Amazon. Link the existing listing before publishing` | SKU already on Amazon | `link-channel-id` (`listingId`; the ASIN is read by seller SKU) |
| `Amazon product type <X> differs from prepared product type <Y>.` | Nexus type ≠ live type | a person (product sheet: Delete, then Publish) |
| `<attribute> cannot be edited on an existing Amazon listing.` | Amazon locks it | none from Nexus |
| `Amazon is still removing this SKU` / `Amazon still links this SKU to … in another market` / `Amazon could not match this SKU to a product` | listing again after a delete | wait up to 24 h / a person deletes it there / a person enters the ASIN or barcode in the product ID cell |
| `A previous publication still needs a result (<id>).` | one in flight here | `publication-status`; wait for the sweep |
| `has multiple seller SKUs` / `conflicting Amazon seller SKUs` / `needs its own Amazon seller SKU` | listing identity disagrees | a person, in the product sheet |
| `Sending is off: publishing to Amazon is …` | server publish mode | a person (server setting); nothing is sent until then |
| `the studio's review changed since it was approved` | Nexus or Amazon moved | review again, ask again |

## 5. Delete, fulfilment, and what only a person does on Amazon

Claude can **delete** a listing in one market with `delete-listing` (`listingIds` of one family on that market and account, `confirmSku` = the family SKU the person typed; always a person's approval; cannot be undone; FBA units stay at Amazon and still pay storage). Amazon has **no End**: `end-listing` and `relist-listing` refuse it. Claude can also **switch fulfilment** FBA ↔ FBM with `set-listing-stock` `set-fulfilment`: Amazon is sent nothing (the offer itself is converted in Seller Central), and FBA → FBM is refused while FBA units, an active FBA offer or an Amazon FBA code remain. Only a person:

- **Listing a deleted row again**: its Status Active or Inactive, then Publish.
- **Status before the first publish** (Active / Inactive / Not listed): product sheet Status column. Claude can only pause or resume a live offer afterwards (`close-listing` / `reopen-listing`).
- **Photos on a live listing** (Media page, Publish photos) and **switching a family to the media plan**.
- **Offer fields other than price and sale** (min/max seller price, MAP, offer start/end, pricing rule, handling time, restock date, list price): the product sheet's Amazon offer cells, sent by Publish.
- **Full update** of a live listing: Action column. Claude publishes changed field groups only.
- Product type of an existing product, seller-SKU identity, schema sync, the server's publish mode, and anything in Seller Central.
