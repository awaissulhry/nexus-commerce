# eBay: listing reference

eBay facts for the list-product skill. The tools and `business-overview` give the valid values; this file gives the eBay order of work, the traps and what only a person can do.

## Markets

| Code the tools take | eBay site id (`business-overview` `siteId`) | Currency | Language | Notes |
|---|---|---|---|---|
| `IT` | `EBAY_IT` | EUR | it | Variation and item-specific names go out as eBay Italy's Italian names (Brand → Marca). |
| `DE` | `EBAY_DE` | EUR | de | |
| `FR` | `EBAY_FR` | EUR | fr | |
| `ES` | `EBAY_ES` | EUR | es | |
| `UK` | `EBAY_GB` | GBP | en | Never `GB`. A price that follows a EUR master price is refused, not converted: give the listing its own GBP price. |

- These are Nexus's default eBay markets; a business can switch rows off. Its own list is `business-overview` `markets` (channel `EBAY`). Nexus publishes to these five eBay sites only.
- Listing, publish, price and stock tools take the code (`UK`). The site id (`EBAY_GB`) is only for tools that say so (eBay ads).
- Matrix keys: `EBAY:IT`; a second listing `EBAY:IT#<aliasId>`. eBay has no sale-price cell (an eBay sale is a promotion).
- Outside IT, the variation theme's names go out as written (nothing translates them): on DE, FR, ES and UK use that site's own aspect names.
- Each site has its own category ids, policies and item: a family listed on IT and DE is two eBay items.

## Accounts and second listings

- A business can hold several eBay accounts. `business-overview` `accounts.EBAY` lists each (`id`, `label`, `primary`, `listingsByMarket`); `listing-coordinates` (`productId`) lists this business's own accounts and where each listing of the family sits (account, alias, `draft`, `published`, `linked`).
- **Drafts** (`create-draft-listings`): the named `accountId`, else the business's primary eBay account; several accounts and none primary: refused until one is named. Name `accountId` whenever there are several, even with a primary.
- **Review and publish**: the named `accountId`, else the named `listingId`'s account, else (`publish-listing`) the one account the destination's listings record, else the business's only active eBay account. Several and none found: refused with every label and id.
- **Only this business's own accounts publish.** `create-draft-listings` also takes an account another business shares with this one, but `publish-review` and `publish-listing` refuse it ("This business has no eBay account with this id"): drafts there can never be published from here. Use an own account.
- **One eBay item per family, per site, per account, per listing.** The same family on a second account in the same site is a second item.
- **A second listing (alias, "extra listing")** is a second eBay item for the same product on the same account and site. It is allowed and intended: describe it as such. A person adds it on the product's eBay sheet in the product studio (no tool creates one). Claude reaches it by `listingId` (`publish-review`, `publish-listing`, `set-listing-fields`), `aliasKey` (`product-content`, `set-listing-content`, `listing-live-content`), the key `EBAY:<code>#<aliasId>` (`listing-matrix`, `set-listing-price`, `set-listing-stock`) and `extraListingId` (`set-listing-sku`, which only records the SKU the alias already has on eBay; it never renames one).
- `listing-matrix` shows one account per eBay market (the coordinate's `accountId`); the family's listings on another account in that market are not in it.
- **Item IDs never cross businesses.** No tool takes an eBay Item ID except `link-channel-id`, which accepts only an Active item listed by this account's own eBay seller and carrying the family's SKUs. `find-by-id` with an Item ID says in `elsewhere` whether another business also holds it; such a clash goes to the identity-check skill.

## Before the first publish

Read what is missing: `listing-issues` (`productId`, `channel: "EBAY"`, `market`; readiness `missing`) and `product-content` with `coordinate: {channel: "EBAY", market, accountId?}`: per field `required`, `options` (`optionsOnly` = a strict list), `maxLength`, and why a cell cannot be edited. eBay takes ONE value per listing for the item-level fields, the title, the description and every item specific that is not a variation axis: set them on the MAIN row (the parent's `productId`).

| Need | How | Notes |
|---|---|---|
| Category | Find it with `ebay-categories` (`market` + `query`: eBay's suggested categories for some words, with `leaf`), then `set-listing-fields` `values: {categoryId}` on the main row | A listing needs a leaf category; each site has its own ids. `ebay-categories` reads only and stores nothing: a category Nexus has not loaded is read live from eBay. If the review says "Nexus has not loaded eBay's details for category N yet", a person opens the product's eBay sheet in the product studio, which loads them by itself or with **Load eBay fields**. The category's item-specific keys appear in `product-content` only after that. |
| Item specifics | `set-listing-fields` `values` (keys as `product-content` lists them), or `set-listing-content` `attributes`. Before the category is loaded: `ebay-categories` `categoryId` (optional `specific`, `valueSearch`) lists them with their allowed values | A missing required one, or one value over 65 characters, blocks the publish. A value off eBay's list only warns in Nexus (the preview says so), but eBay's own check may still refuse it: prefer the listed `options`. |
| Condition | `values.conditionId` on the main row, from the category's `options` (or `ebay-categories` `categoryId` → `conditions`) | Required for a new listing. |
| Business policies | `paymentPolicyId`, `returnPolicyId`, `fulfillmentPolicyId` | Blank: the account's default, else this site's first policy, read from eBay at publish. No policy of a kind for the site: refused, and the seller creates one on eBay (Account › Business policies). |
| Item location | `itemLocationCountry` plus `itemPostalCode` or `itemLocation` (city) | Blank: the eBay account's location. |
| Title, description | the listing-content skill (`set-listing-content` `pin`, or the shared text) | Title at most 80 characters, subtitle 55. A longer title is saved with a warning, then blocks the publish. Only the main row's title and description are sent. |
| Photos | `media-plan`, `add-photo-from-url`, `arrange-photos` | Common gallery 1–24 (the first is the search photo), at most 12 per variation value, longest side at least 500 px, public https. |
| Price | `set-listing-price` on the variation rows (targets from `listing-matrix`) | Above 0 in the site's currency. A family's parent row has no price. |
| Stock | `set-stock` at the business's own warehouses; a fixed number with `set-listing-stock` `pin-quantity` | A listing may go live at stock 0 only while the eBay account's out-of-stock option is ON. Nexus reads it and never sets it: the seller turns it on in eBay (Account › Site Preferences › Selling preferences). At 0, eBay hides the item from search. |
| Variations | the eBay variation theme on the main row | A person sets it in the sheet's Variation theme column (`set-listing-fields` `variationTheme` is Amazon only). At most 5 axes; every variation needs a value for each axis; at most 200 products per publish. `set-listing-fields` `variants` includes or leaves out variations. |
| Colour and size words | nothing to do | Dictionary colours and sizes go out as the site's word (`black` → `Nero` on IT, `Schwarz` on DE); a value the dictionary does not know goes as stored. Stored values never change. |

Fixed rules: fixed price only (`listingFormat` `FIXED_PRICE`); duration always GTC; the handling time comes from the shipping policy (not sent); VAT a number 0–100, blank sends none; Best Offer only on a single-SKU listing; one package per listing (the main row's); a `videoId` blocks a new listing. New listings on IT, DE, FR and ES warn that the EU product-safety data (manufacturer, EU responsible person) is not sent: the seller adds it in eBay Seller Hub.

## Publish

1. `publish-review` (`productId`, `channel: "EBAY"`, `market`, `accountId?`, `listingId?`): `action` (`create` or `update`), `ready`, `issues` (severity error blocks), `changes`, `previousPublicationId`. It does NOT run eBay's own check of a new item.
2. `publish-listing` (`productId`, `channel: "EBAY"`, `marketplace` — not `market` —, `accountId?`, `listingId?`, `fields`).

**First publish** (`fields: "all"`, required). It sends the whole item: category, condition, policies, location, photos, item specifics, and each variation's price and quantity as Nexus holds them (available stock minus the buffer, or a lower pin). Check them in `listing-matrix` before asking. The preview's `creates[]` says how each row starts (an `inactive` row goes at quantity 0 and is paused once eBay accepts); rows in `held[]` are not sent.
- eBay's own check (VerifyAddFixedPriceItem) runs only when the approved publish runs. Tell the person before they approve: eBay can still refuse after the approval; then nothing is created, and `approval-status` gives eBay's reason in `failed` or `handedBack`. Fix it, review again, ask again.
- Once eBay accepts, the drafts become the live listing and the stock sync starts sending to eBay.
- The undo of a first publish is `close-listing` (quantity 0 held; the item and its number stay).

**Re-publish of a live item** (a change-only "Partial update"). Name only the groups that changed:

| Group | What reaches the live eBay item |
|---|---|
| `title`, `description` | the main row's text |
| `photos` | the gallery and the variation pictures |
| `attributes` | item specifics only |
| `bullets`, `keywords` | nothing: eBay has no such fields |

Everything else needs a person's **Full update** (product sheet: Action column = Full update on the main row, then Publish in the product studio): category, condition, policies, location, package, VAT, Best Offer, max per buyer, subtitle, the variation theme, adding or removing variations. A re-publish lists those in `notSent` ("…unsupported by change-only Publish"); when nothing else is left it is refused ("Nothing can be sent for the fields named"). A Full update adds a new variation at quantity 0: afterwards send its stock with `set-listing-stock` `push-now`. No publish changes a live item's seller SKU. A live item's price and stock change only through `set-listing-price` and `set-listing-stock`.

**Follow it.** `approval-status` names the `publication`; `publication-status` (`publicationId`) reads it: `PUBLISHING`; `UNVERIFIED` (eBay acknowledged the item, its active state not confirmed yet); `ACCEPTED` ("eBay accepted item … and reports it active": done); `FAILED` (nothing was submitted; the reason follows). A pending one is re-checked by the sweep every 2 minutes (eBay at 2, 4, 8, 15, 30, 60 and 180 minutes, 12 tries); after that a person checks eBay and uses **Mark as checked** on the publish run in Nexus. While one is pending, the next publish to the same family, site, account and listing is refused ("A previous publication still needs a result"). Then read `listing-issues` for what eBay reported.

## Traps and refusals

| Trap or refusal | Fix |
|---|---|
| `GB` or `EBAY_GB` as the market | `UK`: drafts and the studio take only the business's market code. |
| `market` on `publish-listing` | It takes `marketplace`. The content tools take `product` (an id or a SKU), not `productId`. |
| A clean `publish-review` read as "eBay will accept" | Not proof: eBay's own check runs at the approved run. |
| "Nexus has not loaded eBay's details for category N yet" | A person opens the product's eBay sheet (**Load eBay fields**), then review again. |
| "Variation theme: set the eBay variation theme on this listing's main row" | A person sets it in the sheet's Variation theme column. |
| "The stock is 0, and this eBay account's out-of-stock option is off…" (also a pin to 0 and `close-listing`) | Stock above 0, or the seller turns the option on in eBay. |
| "eBay UK sells in GBP, and this listing follows the master price in EUR…" | `set-listing-price` `set-price` in GBP on each variation row. |
| "…this eBay account has no … policy for eBay <code>" | The seller creates it on eBay (Account › Business policies), then review again. |
| "eBay needs the item location country and a postal code or city…" | `itemLocationCountry` plus `itemPostalCode` or `itemLocation` on the main row. |
| "eBay does not take Best Offer on a listing with variations" | `bestOffer: false` on the main row. |
| "Nexus cannot send a video with a new eBay listing yet" | Clear `videoId` on the main row. |
| "Ended on the channel. Set Active to relist it first." | `relist-listing` (or a person: Status Active in the sheet, then Publish); eBay gives the relisted item a NEW Item ID. |
| "A previous publication still needs a result (<id>)" | `publication-status` on that id; wait for the sweep. |
| "This business has no eBay account with this id" | The account is another business's: use one of this business's own (`listing-coordinates` `accounts`). |
| `unlink-channel-id`, then `publish-listing` | Allowed; say the effect plainly before asking. Unlinked rows are drafts again, so the publish CREATES A NEW eBay item with a new Item ID, while the old item stays live on eBay, no longer updated by Nexus (it can oversell) until it is ended there or linked again (`link-channel-id`). |
| "These products belong to different eBay listings…" | The family's rows point at different items: identity-check skill. |
| eBay codes 931 or 518 in `listing-issues` | Sign-in or call-limit failures, not content: a person reconnects the account, or try later. |
| "Sending is off: publishing to eBay is in … mode on this server" | A server setting; nothing to fix from here. |

## What only a person can do

| Action | Where |
|---|---|
| Full update of a live item | Action column = Full update on the main row, then Publish. |
| Choose a category in the sheet's picker; load its details into Nexus for the sheet's cells and the review | The product's eBay sheet in the product studio (**Load eBay fields**). `ebay-categories` reads them but stores nothing. |
| Set the eBay variation theme | The sheet's Variation theme column. |
| Add a second listing (alias) | The product's eBay sheet. |
| Mark a publication checked after its 12 tries | The publish run in Nexus (**Mark as checked**). |
| Out-of-stock option, business policies, EU product-safety data | The seller, on eBay. |

Claude can pause and resume a live listing: `close-listing` (quantity 0 held, only while the item's own out-of-stock control is on; the item and its number stay) and `reopen-listing` (sends the current stock). It can also end, relist and delete one, each with `confirmSku` (the family SKU the person typed) and always a person's approval: `end-listing` (the whole item, every variation; the Item ID is kept), `relist-listing` (an Ended item, under a NEW Item ID; eBay may charge an insertion fee) and `delete-listing` (Trading: ended, then Nexus forgets the Item ID; Inventory: withdrawn and this site's offers deleted; cannot be undone).
