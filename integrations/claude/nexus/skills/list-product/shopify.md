# Shopify: listing reference (and Etsy)

Read with the list-product skill. The business's own Shopify market and store ids come from `business-overview` (`markets[]` with channel `SHOPIFY`; `accounts.SHOPIFY[].id`). Quoted sentences are what Nexus answers.

## 1. Shopify basics

- **Market:** always `GLOBAL`. publish-review, create-draft-listings and set-listing-fields call it `market`; publish-listing calls it `marketplace` (the other name is refused). Matrix key: `SHOPIFY:GLOBAL` (a second listing: `SHOPIFY:GLOBAL#<aliasId>`). The market's `currency` is what Shopify prices are in; Nexus never converts.
- **Stores:** `business-overview` `accounts.SHOPIFY` and `listing-coordinates` list them. With several active stores, name `accountId`: create-draft-listings without it takes the primary store; publish-listing takes the store its drafts name; publish-review refuses ("This business has N active Shopify accounts (…). Name one as accountId."). `listing-matrix` shows one store per coordinate (the family's store, else the primary).
- **Location:** `publish-review` lists the store's active `locations` (`id`, `name`). Pass one as publish-listing `location` when there are several. The first publish puts each variant's stock there, and later stock pushes go to the same location.
- **One product per colour** ("colour products") is a per-store setting a person runs in Nexus (Find, then Confirm). No Claude tool switches it on or links colour products; `product-identity` shows a family's colour products. link-channel-id refuses Shopify ("a Shopify product is linked through colour products (Find, then Confirm) in Nexus, not here."); close/reopen refuse such a family ("This family is several Shopify products (one per colour). Change their status in Shopify for now.").
- **Publish only creates.** A product Shopify already holds cannot be re-published: section 3.

## 2. New product: the first publish

1. **Drafts first.** `create-draft-listings` (`channel: SHOPIFY`, `market: GLOBAL`, `accountId`). Without them a family is refused: "This Shopify family has excluded variants. Review the family selection before publishing." Excluded = a variant with no Shopify row, a row left out of the listing, or a variation whose own Status is Not listed. A variation added after the drafts is not added by naming the family again: call create-draft-listings with that variation's id. A row left out: `set-listing-fields` `variants.include`. A Not listed variation: the person changes its Status in the product sheet.
2. **Text.** Title and description are the shared text (`set-content`) unless the listing holds its own; Claude cannot write a Shopify-only text (`set-listing-content` refuses a Shopify coordinate). Vendor (the brand) and product type come from the Shared product through the mapping, or from the listing's own value; the theme template is `nexus` unless the listing names another. A value Nexus cannot resolve holds the publish, with the reason.
3. **Store fields and metafields.** `product-content` refuses a Shopify coordinate ("A Shopify listing is read with shopify-content …"). Before the first publish `set-shopify-content` cannot write them (the rows carry no Shopify ids yet): a person fills them in the product sheet's Shopify scope (its cells say "Saves in Nexus · Publish to send it to Shopify"). `set-listing-fields` `values` takes only keys the listing has (an unknown key is refused with the list of its attributes); title, description and tags keys are refused as text.
4. **Photos.** `media-plan`, `add-photo-from-url`, `arrange-photos`. Only https images go to Shopify; at most 250 media per product. Shopify gets photos from the first publish only.
5. **Price and stock: set them before publishing, the first publish sends them.** Each variant gets its listing's own price, else the master price under its rule, but only when the Shopify market's currency is the master currency (else: "Shopify GLOBAL sells in <X>, and this listing follows the master price in <Y>. Nexus does not convert it. Set this listing's own <X> price."). Its quantity is the sellable stock, or the pinned quantity, minus the buffer; 0 is allowed. Use `set-listing-price` `set-price` and `set-listing-stock` `pin-quantity` with targets `{rowId, coordinateKey: "SHOPIFY:GLOBAL"}` from `listing-matrix` (variant rows; the parent row takes no price). On a draft the price is kept: "…is a draft that has not been published; Publish sends it."
6. **Draft or Active: one rule.** Shopify creates the product with the main row's choice in the product sheet's Status column: Active → ACTIVE, Inactive → DRAFT, Not listed → nothing is created ("The main product's Status is Not listed, so Publish leaves this family out here. Set the main product Active or Inactive to create it."). Nobody chose: a Draft (Active only when the family's stored Shopify status is ACTIVE). No Claude tool sets the Status column: ask the person before you publish whether it should go live.
7. **Review.** `publish-review` (`market: GLOBAL`): `ready`, `issues`, `products` (`live`), `locations`, `visibility` (`DRAFT` or `ACTIVE`). Shopify has no `changes` rows.
8. **Publish.** `publish-listing` (`marketplace: GLOBAL`, `fields: "all"`, `location`). Any other `fields`: "A new Shopify product is sent complete: name fields "all"." The preview's `summary`, `creates[{sku, startsAs}]`, `visibility` and `location` say what is created; `send` is empty and `sendCount` 0 because the product goes as a whole. Tell the person in words: texts, options, every variant with price and quantity, photos, store fields, Draft or Active.
9. **Follow.** `publication-status`: Shopify answers at once, `VERIFIED`, `FAILED` (nothing sent) or `UNVERIFIED`. A Shopify result is never checked again by itself (the "every 2 minutes" note does not apply to it). UNVERIFIED ("…Some Shopify steps may have completed…"): a person checks the product in Shopify, then uses "Mark as checked…" in Publish history in Nexus; until then every later publish of that product to that store is refused ("A previous publication still needs a result (<id>). …"). If Shopify now holds the product, the next review treats it as an existing product.
10. **Created as Draft but should sell:** `reopen-listing` on its listing ids (Shopify: "a product that is a Draft in Shopify becomes Active"). A Draft product gets no price or stock pushes ("The Shopify offer is unavailable, unpublished or paused."). Confirm with `listing-coordinates` (`published`) after it ran.

**Limits:** 3 options per product; 1 to 250 variants per family ("Publish between 1 and 250 native variants per family."); 200 products per publication including the main product; option values up to 255 characters; 250 media; a compare-at price at least the selling price.

**Cold store schema.** When Nexus has no copy of the store's field list, the Shopify sheet drops every store metafield: `shopify-content` answers `storeFieldsLoaded: false` ("…they are missing here, not empty"), and `set-shopify-content` refuses ("…A write is refused until it is loaded: ask again in a minute."). Read again a minute later; never report those metafields as empty or missing on Shopify.

## 3. Product already on Shopify

`publish-review` shows its products as `live: true` and blocks; `publish-listing` refuses: "Publish cannot update a product already on Shopify yet. Use Review and synchronize… for its fields; its status changes in the Status column."

| Change | What Claude can do | What reaches Shopify |
|---|---|---|
| Store fields: metafields, vendor, tags, product type, category, SEO title and description | Read with `shopify-content` (live), change with `set-shopify-content` (`fields` by id or label; `englishMeaning` for every text unless the store language is `en`) | Saved in the listing's Nexus draft only (`nexusDraft`). Shopify changes when a person runs "Review and synchronize…" in the product sheet's Shopify scope; no Claude tool and no automation sends it. Say so after the approval. |
| Title, description | `set-content` (shared text) | A product Nexus created: re-sent while it is Active on Shopify and has no unreviewed Shopify edits. A product Nexus did not create: "Content for a linked Shopify product is sent only through Publish (changes only). Nothing was sent." |
| Price | `set-listing-price` `set-price`, `adjust-prices`, `copy-prices` | Sent. A `sale` is stored in Nexus but no Shopify send reads it. The compare-at price cannot be set from Claude. |
| Stock | `set-listing-stock` | Sent to the location chosen at the first publish. A pin to 0 does not check "Continue selling when out of stock": such a variant keeps selling. |
| Pause, resume | `close-listing`, `reopen-listing` | Close: quantity 0 per variant, held (the page shows "sold out"; status and sales channels stay); a "Continue selling" variant is not paused. Reopen: lifts the hold, sends the current stock, a Draft becomes Active. End (archive) and Delete stay a person's choice in the product sheet. |
| Photos | none | Not sent: only a first publish sends photos. |

- A product that is a Draft on Shopify gets no price or stock pushes until it is Active.
- `listing-live-content` returns no content for Shopify ("Reading live from Shopify comes with the Shopify publish step (P4.2)."): read with `shopify-content`.

## 4. Refusals and their fix

| Nexus says | Fix |
|---|---|
| "This Shopify family has excluded variants. …" | `create-draft-listings` with the missing variation's id; `set-listing-fields` `variants.include`; a Not listed variation: the person changes its Status. |
| "Publish cannot update a product already on Shopify yet. …" | Section 3. |
| "The main product's Status is Not listed, so Publish leaves this family out here. …" | The person sets the main row Active or Inactive in the Status column. |
| "This Shopify store has N locations: name one (location)." / "This Shopify store has no such location: publish-review lists its locations." | Pass a `locations[].id` from publish-review. |
| "This Shopify store has no active inventory location." | A person sets up a location in Shopify. |
| "Sending is off: publishing to Shopify is turned off on this server. …" | Nothing can be sent from this server; tell the person. |
| "A previous publication still needs a result (<id>). …" | A person checks Shopify, then "Mark as checked…" in Publish history. |
| "This listing has no price of its own for Shopify GLOBAL. Set its price first." / "…Nexus does not convert it. …" | `set-listing-price` `set-price` in the market's currency. |
| "<SKU>: valid SKU, price and stock are required." / "<SKU>: missing <option>." / duplicate variant SKUs or option combinations | Fix the product data in Nexus. |
| "The document's default language must match the Shopify store's primary language." / "Shopify language <x> is not published in this store." | A person aligns the store's languages and the Shopify content in Nexus. |
| "Review the <Language> (<xx>) content before publishing." | A person reviews that text in Nexus. |
| "This Shopify store already has the field "Nexus family identity" (nexus.family_id) as plain text, …" | A person deletes that field in Shopify (Settings → Custom data → Products), then publish again. |
| "The Shopify product type holds a Shopify category id (gid://…). …" | Set a plain product type, and the category in its own field. |
| set-shopify-content: "…Choose and synchronize a Shopify product category before editing this category-specific field." | A person sets and synchronizes the category first. |
| "This Shopify connection needs write_products permission. …" | A person reconnects the store with product editing access. |

## 5. Etsy

Nexus has no Etsy publisher yet. Nothing Claude asks for creates, edits or reads an Etsy listing. Tell the person plainly.

| Tool | Etsy today |
|---|---|
| `create-draft-listings` (`ETSY`, `GLOBAL`) | Works with an active Etsy account and Etsy market: inert drafts in Nexus that nothing can publish yet. `remove-draft-listings` removes them while untouched ("…it has values of its own; removing it would lose them." once they hold values). |
| `publish-review` | Never ready: "Direct publishing to Etsy is not available yet. Your product changes are saved in the studio." |
| `publish-listing` | Refused: "<SKU>: publishing to Etsy from Nexus is not available yet; nothing can be sent there." |
| `product-content`, `set-listing-content`, `listing-live-content` | Refused: "Etsy publishing is not available yet: Nexus cannot read or change an Etsy listing's text until the Etsy publish step (P5) exists." |
| `set-content`, `set-listing-fields`, photo tools | Nexus only: shared text does not go to Etsy, and "Publish does not send Etsy listing fields yet. They stay in Nexus." Title, description and tags keys are refused by set-listing-fields as text. |
| `set-listing-price` | Saved in Nexus; the push is skipped while Etsy publishing is off on the server, and fails without an Etsy listing id ("This product has no Etsy listing id, so there is nothing on Etsy to change. Nothing was sent."). No sale: "No sale price on this coordinate". |
| `set-listing-stock` | As price, and also held until Etsy order import is on: "Etsy order import is off (…), so Etsy's own sales do not reach Nexus stock. … Turn on Etsy order import first." |
| `close-listing`, `reopen-listing` | Only a listing live on Etsy, with Etsy publishing on ("Etsy publishing is turned off. Nothing was changed."). Close sets it inactive; reopen sets it active (Etsy may set its quantity to 1 and charge a renewal). A draft: "…a draft was never live — remove it (remove-draft-listings) instead." |
| `link-channel-id`, `unlink-channel-id` | Link refused: "…linking a ETSY listing is not built yet." An unlink cannot be undone from Claude. |
| `out-of-sync-listings` | Etsy is never read back, so never reported as differing. |
