# The product page: every status and action

The product page is the Nexus product studio: the product sheet (a Shared scope, and one scope per channel, market and
account), its Publish window and its Media tab, plus the read-only datasheet. Screen words are in **bold**. "Claude reads"
names the tool and field that show the same thing; "—" means Claude cannot see it and must ask the person.

## 1. Status words

### Status column (one value per listing row and market)

| Screen | Meaning | What a person does next | Claude reads |
|---|---|---|---|
| **Active** | Buyers can buy it here. | — | `listing-matrix` `cells[key].listing.selling.state` = `active` (+ `reason`) |
| **Active**, "Marked inactive in Nexus only — the channel still sells…" | An old Nexus-only mark; the channel still sells. | Status Inactive, Publish | `selling.reason` |
| **Active**, "Amazon lists it but reports it not buyable…" | Amazon shows it but it cannot be bought now (no stock, or a problem Amazon found). | check stock and the listing's issues | `selling.reason`; `listing-issues` |
| **Active**, "Nexus still marks it a draft, but it has a channel number…" | It is live on the channel. | — | `selling.reason`. `product-snapshot`, `listing-health` and `listing-issues` say `draft: true` with `linked: true` here: treat that as live |
| **Inactive** | Buyers cannot buy it here; the listing, its number, reviews and content stay. Amazon: this market's offer is removed (other markets sell). eBay, Shopify: quantity 0 held by Nexus. Shopify Draft or Unlisted. Etsy inactive. | Status Active, Publish | `selling.state` = `paused`; `listing-coordinates` `offerClosed` |
| **Ended** | eBay ended the item, or Shopify archived the product. Amazon and Etsy never read Ended. | Status Active, Publish (= Relist) | `ended` |
| **Active** or **Inactive** + **new** / **new · as main**, on a row not on the channel | A Nexus draft (never sent), or no listing here yet. The cell shows what Publish will CREATE: its own choice (clock), the main row's, or the default (no glyph). | change the choice, Publish | the state: `selling.state` = `draft` (`listing-coordinates` `draft: true`) or `not_listed`, or the key in `listing-matrix` `notListed[]`. The choice: — until `publish-listing`'s preview (`creates[].startsAs`) |
| **Not listed** on a row not on the channel (aside **as main** when copied from the main row) | Publish leaves it out; it stays in Nexus only. On a main row, the whole family is left out here. | Active or Inactive, Publish | same state; `publish-listing` preview `held` |
| **Not listed** + **deleted** *date* | Nexus deleted it from the channel; every Publish skips it. | Status Active or Inactive, Publish (lists it again) | Shows as `draft`, the same as a draft that was never sent, with no delete date. Only `publish-listing`'s preview says so: `held[].why` "deleted from the channel and left Not listed", or `creates[].relist: true` |
| **Not listed**, "Removed from Amazon … outside the product sheet…" | Removed on Amazon some other way; Nexus still holds the ASIN. | cannot be listed again from the sheet yet | `selling.reason` |
| **Not listed**, "Expired or removed on Etsy." | Etsy ended it. | — | `selling.reason` |
| **Mixed** | A main row whose variations are in different states ("2 of 7 variations are inactive"). | open the variation rows | `mixed` + `reason` |
| **Unknown** | No confirmed state (an old Nexus-only inactive mark, a failed last change, a Shopify status not read yet). | check it on the channel; only Inactive (and Ended where the channel has it) is offered | `unknown` + `reason` |

`product-snapshot` `status` is the Nexus-only catalog status (Active, Draft, Inactive). It is not a channel state.

### Values waiting for Publish (Claude cannot see any of these)

- Status cell: the target with a clock and "now *live state*" means a change was set on the sheet and is sent only by
  Publish (the tooltip says who set it and when). **No longer applies** means the listing already reached that target.
- Rows not on the channel: a clock on **Active**, **Inactive** or **Not listed** means the choice was made on this row;
  **lists again** marks a deleted row set to Active or Inactive.
- Action cell: **Partial update** (the quiet default, never stored), **Full update** or **Delete** with a clock. A row not
  on the channel reads **Full update** because a create is always sent whole. A Partial update note "Publish cannot update a
  product already on Shopify yet…" or "Publish does not send Etsy listing fields yet…" means Publish sends no fields
  there.
- Counters: toolbar **N waiting for Publish** ("2 inactive · 1 ended · 1 full update", red when an End or Delete waits);
  header **Active on 5 of 7 · 1 to end · 1 to delete**; button **Publish · N**; Shared cells **Active in 5 of 7 · 2 new**,
  **Delete on 2 of 7**, **3 waiting**.
- A choice is held with a reason (for example "Etsy publishing is turned off, so Publish cannot change this. Change it in
  Etsy."). A lock glyph means the cell is read-only for this person or row. In the Publish window, a value set by someone
  else or more than 24 hours ago **Starts unticked**.

### Last publish column (one row, one destination)

**Sending** = `PUBLISHING`, **Waiting for channel** = `SUBMITTED`, **Result unknown** = `UNVERIFIED`, **Accepted** =
`ACCEPTED`, **Verified** = `VERIFIED`, **Partly failed** = `PARTIAL`, **Failed** = `FAILED` (`publication-status`
`status`, with `results[]` per SKU). **Waiting its turn**, **Cancelled** (a background batch's queue) and **Edited
since** have no MCP value; **Not sent** means a check failed before sending and nothing changed. "—" means never
published from Nexus. A pause, resume, end or delete is never Verified. Claude reads a publication only by its id
(`approval-status` names it; `publish-review` gives `previousPublicationId` while one is pending). There is no read for
"the last publish of this listing".

### Cell marks and readiness

| Screen | Meaning | Claude reads |
|---|---|---|
| **Waits for Publish** on Amazon offer cells ("Saved — sent when you publish", "Live changed since you saved: a → b. Publish sends your saved value.", "Restock date has passed — not sent"); toolbar **N changes wait for Publish** | A person's saved offer change (price, sale, minimum and maximum, offer dates, handling time, restock, always available) on a live Amazon listing. Only the screen's Publish sends it. | — |
| Shopify "Saved in Nexus — not sent to Shopify yet. Use Review and synchronize… to send it" | A Shopify draft value on a product already on Shopify. | `shopify-content` `nexusDraft` |
| **Needs attention**, **Listing value**, **One value for the whole listing** (eBay), **Derived per product, shared by every alias** | Saved but not sent, a reported problem, the listing's own older value, an item specific held once per eBay item. | — |
| **Inherited**, **Pinned**, **Derived by a mapping rule**, **Calculated by a formula**, **Out of date**, **AI-drafted**, empty "required" | Where the value comes from. | `product-content` cell `fromParent`, `layer`, `followsShared`, `review`, `required` |
| Chips **Missing required**, **Invalid values**, **Warnings**, **Mapping errors**; the Progress column; header **Draft · not published**, **Not listed on** *channel · market* **yet** | How ready the listing is to publish. | `listing-issues` (readiness: `missing`, `otherIssues`, `untranslated`). `listing-health` checks only title, price and quantity |
| ASIN cell: the ASIN, **Published · ASIN pending**, **Draft · not published**, **Parent ASIN — not buyable** | Amazon's id. | no tool returns an ASIN; `linked` says one exists |
| Shopify status cell on a product not on Shopify yet | Read-only. It shows the Status column's create choice (Active creates the product active, Inactive creates a Draft). | `publish-listing` preview `visibility` |
| Datasheet: Launch readiness **Ready** / **Not ready**, the health pulse | A read-only page (print, JSON export). | — (no tool returns these words) |

## 2. Actions

Nothing on the sheet reaches a channel until **Publish**, except where a row below says otherwise. A Status or Action
value only marks the row. In the Claude column, "—" means only a person can do it, on the product page.

| Action (screen) | What it does | Undo | Claude |
|---|---|---|---|
| Status **Inactive** + Publish (Pause offer) | Amazon: removes this market's offer only (FBA too, with a warning; never quantity 0). eBay: quantity 0 held by Nexus. A Trading item needs its out-of-stock control on (read when sending), an Inventory listing needs the account preference on; otherwise the change is refused and End is offered. Shopify: quantity 0 per variant (a variant that "continues selling when out of stock" is skipped). Etsy: inactive. | Resume | `close-listing` (`listingIds` on ONE channel, market, account and alias; live listings only; the same engine). It acts once a person approves it; it never sets a waiting value. |
| Status **Active** on an Inactive row + Publish (Resume offer) | Amazon: the saved offer comes back at its paused price. eBay, Shopify: the hold is lifted and the CURRENT stock is sent. A Shopify Draft becomes Active in every market of the store. Etsy: active (may cost a renewal). | Pause | `reopen-listing` (takes no `quantity`) |
| Status **Ended** + Publish (End listing; eBay and Shopify only) | eBay: ends the whole item (its number is kept). Shopify: archives the product in every market of the store. Needs the products.delete permission and the family SKU typed. | Relist | — a person only |
| Status **Active** on an Ended row + Publish (Relist) | eBay: lists it again under a NEW item number. Shopify: active again. | End | — (`reopen-listing` refuses: "Ended — use Relist.") |
| Action **Full update** + Publish | Sends every field Nexus manages, and removes the channel values Nexus does not hold (the review lists them). Amazon: per SKU. eBay Trading: on the main row only. Held for eBay Inventory and for products already on Shopify. | publish the old values | — (`publish-listing` sends Partial updates only) |
| Action **Delete** + Publish | Amazon: deletes the listing in this market only (FBA allowed, with Amazon's unit count and a Pan-European warning). eBay Trading: ends the item, then Nexus forgets its item number. eBay Inventory: withdraws it and deletes this market's offers. Shopify: deletes the product and all its variants in every market of the store. Etsy: not available. On eBay and Shopify, only on the main row. Needs products.delete and the family SKU typed. The row then reads **Not listed** · **deleted** *date*. | cannot be undone | — a person only |
| List again after a delete: Status **Active** or **Inactive** on the deleted row + Publish | Creates the listing again, whole. eBay gives a new item number. Amazon uses the ASIN in the product ID cell, or the one Amazon matches ("Lists *SKU* on ASIN … (was …)"); FBA units labelled for an old ASIN cannot sell on a new one. Amazon refuses for up to 24 h after the delete, or while the SKU is still tied to another ASIN in another market. | Delete again | Claude cannot set this Status. If a person already set it, `publish-listing` lists the row again (`creates[].relist: true`). Left Not listed, `publish-listing` holds the row (`held`). |
| Status on a row not on the channel: **Active**, **Inactive** or **Not listed** | What Publish creates. Active: it sells. Inactive: Amazon without this market's offer, eBay at quantity 0 (needs the account's out-of-stock option), Shopify as a Draft product. Not listed: left out (on a main row, the whole family is left out here). With no choice, the default is Active on Amazon and eBay, and Draft on Shopify unless the family's stored Shopify status is Active; a variation with no listing here and a deleted row default to Not listed. On a row with no listing, a choice first starts the whole family's drafts on the sheet's account. | change it | Claude cannot choose. `create-draft-listings` starts drafts that take the default. `publish-listing` follows whatever a person chose (`creates[].startsAs`, `held`). |
| **Publish** / **Publish · N** (studio header) | One window for every listed market of the sheet's channel and account (from the Shared tab: the first listed channel). Each market gets one review: content, waiting Status changes and Deletes, held rows, and values that no longer apply. Nexus wins by default; the **Keep channel values** switch keeps the channel's. Order per account: resume, relist, content, pause, end, delete. A row being ended, deleted or relisted gets no content ("This listing is being ended, so its changes are not sent…"). | Done: "Undo: set N listings Active again" (resumes or relists; on eBay a relist gets a new number). A Delete cannot be undone. | `publish-listing`: one destination per call (see §3) |
| **Action ▾** (selection bar) | Fills Status or Action for the ticked rows and names the rows that refused. | refill | — |
| Products list **Publish…** | Send changes (with **New listings start as**), Set Active, Set Inactive or Set Ended for many products; no Delete. Set Ended needs the number of listings typed. | Publish history: **Resume these N…**, **Relist…** | content: `publish-listing` steps in one `submit-change-plan`; Set Inactive / Active: `close-listing` / `reopen-listing`, one channel·market·account per step; Set Ended: — |
| **+ Add listing alias** (channel ⋯) | Adds a second listing of the family on the same account and market (for example a second eBay item). This is allowed. It stays a Nexus record until it is published. Removing an alias archives it, and its records stay. | archive | Claude cannot add or archive one. `listing-coordinates` shows `alias`; `publish-review` and `publish-listing` take its `listingId`; `set-listing-sku` records its own seller SKU |
| Shared-scope text edit | Saves in Nexus AND queues a content update (30-second hold) to every live, unpaused Amazon, eBay or Shopify listing that follows the shared text. There is no Publish review. | Ctrl+Z, reset | `set-content` and `bulk-content-change` save in Nexus only; `publish-listing` sends the text |
| Channel-scope cell edit | Sets the listing's own value. The first edit where there is no listing starts a draft. | reset to inherited | `set-listing-content`, `set-listing-fields`. Both refuse where there is no listing yet (run `create-draft-listings` first) |
| Amazon offer cell on a live listing | Saved as a draft; the screen's Publish sends it. | **Discard saved changes…** | — `set-listing-price` changes the live price at once; a person's saved offer draft for that cell is still sent by their next Publish |
| **Review and synchronize…** (a product already on Shopify) | Sends the Shopify draft fields to Shopify. | — | — `set-shopify-content` only saves the draft |
| Family: Add child, Attach existing…, Unlink from parent, Move to another parent…, Promote to parent…, Demote…, **Delete child…** | Nexus only. Delete child… is a HARD delete, refused while the child holds a marketplace id or is marked published. | per action | `create-variations`, `fix-parent`, `discard-new-products` (unused products, recycle bin); no hard delete |
| Media **Publish photos** | Sends photos only, to each destination. | publish again | `publish-listing` `fields: "photos"`. Amazon live photos usually go through Nexus's photo review. Layout: `arrange-photos` |

Etsy: while Etsy publishing is off on the server, Status changes are held and `close-listing` / `reopen-listing` are
refused. A Shopify family split into one product per colour cannot change status from Nexus.

## 3. Claude's `publish-listing` and the screen's Publish

| | Screen Publish | `publish-listing` |
|---|---|---|
| Reach | Every listed market of the channel and account, in one window. | One family on one channel, market and account (an alias by `listingId`). For several, use one change plan with one step each. |
| Waiting Status and Action values | Sends them in a fixed order and clears them. | Never reads, sends or clears them. It never pauses, resumes, ends, relists or deletes. |
| Content of rows waiting for End or Delete | Held back (on eBay and Shopify, for every row of that destination). | Sent anyway: it cannot see the waiting value. Ask first. |
| Send mode | Partial or Full, per row. | Partial only, by field group. It never removes channel values. |
| Which values | Per-field ticks; Nexus wins; a **Keep channel values** switch; stale values start unticked. | Every changed field of the named groups. `DIFFERS` replaces the channel's value. To keep one, leave its group out. |
| New rows | Status choices; products list **New listings start as**. | Follows the stored choices and defaults; cannot set them. Preview: `summary`, `creates[{sku,startsAs,relist}]`, `held[{sku,why}]`. |
| Price, quantity, fulfilment | First publish: creates the listing with them. Live Amazon offer drafts: sent. | First publish: creates the listing with them (`warning`: a first Amazon EU publish sets the ONE EU quantity). A re-publish and Amazon offer drafts: never (`notSent`). |
| Ended rows | No content. A waiting Relist is sent; on eBay and Shopify its content waits for the next Publish. | Skipped (`publish-review` `skipped`). On eBay and Shopify, one skipped row skips the family. |
| eBay check of a new item | Runs in the review. | Runs only when the approved publish starts; a refusal sends nothing. |
| When it sends | On the click. | After approval, as the approver. If the review changed in the meantime, nothing is sent. |
| Undo | Done → Undo resumes or relists. | First publish: `close-listing` (the listing stays, Inactive). Re-publish: publish the previous values. |

## 4. Dangerous actions and their guards

| Danger | Guard |
|---|---|
| End: the whole eBay item, or a Shopify product in every market of the store | A person only; products.delete; the family SKU typed; red tone; a relist gets a new eBay number |
| Delete: cannot be undone; the eBay number is forgotten; Shopify loses every market; Amazon FBA units are stranded until the listing is back; a relist may land on another ASIN | A person only; products.delete; the SKU typed when set on Shared, and again at Publish; FBA unit count and Pan-European warning |
| Products list Set Ended on many listings | The number of listings typed; products.delete |
| `publish-listing` sends content next to someone's waiting End or Delete | Nothing in the tool. Before publishing, ask whether the destination shows **waiting for Publish** |
| A value someone else set, or set over 24 hours ago, gets sent | Starts unticked in the Publish window; a write is refused if someone changed the value since it was read |
| Shared text reaches live listings in 30 seconds, with no Publish review | Only listings that follow the shared text; a pinned listing keeps its own value |
| After `unlink-channel-id`, the rows become drafts with the default choice (Active on Amazon and eBay): the next Publish creates a NEW item while the old one stays live. This is allowed (a second item is intended, as with aliases): say it plainly before asking | The unlink preview's `risk` names the live item and its oversell risk; a later `publish-listing` preview says `first publish` and lists the rows in `creates`. To avoid a second item instead: a person sets those rows' Status to Not listed, or the listing is linked again (`link-channel-id`) |
| An eBay pause while out-of-stock control is off would END the item | Refused, and End is offered; checked again when sending |
| Delete child… with live listings | Refused while a marketplace id or a published mark exists |
