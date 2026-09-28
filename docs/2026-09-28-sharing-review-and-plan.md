# Sharing between businesses — review and plan

Date: 2026-09-28
Status: **APPROVED 2026-09-28** (D-1 A, D-2 A, reading confirmed, "yes, start"). **Steps 1, 2, 3 and 5 BUILT and tested
locally (§9–§12). Step 4 is next, as its own change (§12).** Nothing pushed. Branch `feat/sharing-studio`, worktree `/private/tmp/nexus-sharing-studio`.
Builds on: `docs/2026-09-16-assortment-engine-plan.md` (AE), `docs/2026-09-19-shared-stock-plan.md`.
The review facts were read from `origin/main` (c520befc5).

## Owner rulings (newest first)

| When | Ruling | Decision |
| --- | --- | --- |
| 2026-09-28 | R-SH-4 | "Keep it all running, and when everything's done, push it to production … AAA … if there is anything next in the plan, go ahead." |
| 2026-09-28 | R-SH-3 | Step 3: "Go ahead." |
| 2026-09-28 | R-SH-2 | Step 2: "Go ahead." |
| 2026-09-28 | R-SH-1 | D-1 **A** (Settings keeps the deal; a studio page per product), D-2 **A** (copy the layout once as drafts), the reading of "no multiple aliases" is right, and "yes, start". |

## Summary

- **The data model is right. Keep it.** Each business keeps its own copy of the product. A link ties the copy to the source.
  This fits separate businesses with their own item IDs and their own accounts.
- **The screens are in the wrong place for day-to-day work.** Today, sharing is only in Settings. No product page
  and no products grid shows that a product is shared, or which fields follow the source.
- **Aliases and accounts are not shared at all.** A shared product arrives with **no listings and no aliases**.
  The other business must build every listing and every alias again by hand.
- **We found 7 defects.** Two are serious: shared photos can skip the media plan, and a pause on one account can
  pause another account.
- **The plan:** keep Settings for the deal between businesses. Add a product-studio page for each product.
  Add a way to copy the listing layout (accounts and aliases) to the other business.

## 1. What exists today (all on main)

| Part | State |
| --- | --- |
| Assortment → share → accept → first copy (AE.2, AE.3) | Live code. Screens in Settings › Catalog › Shared products. |
| Live sync of product fields (AE.4) | Live code. Database triggers + worker. |
| FOLLOW / OVERRIDE per field | **API only.** `GET /api/catalog-links`, `POST /catalog-links/:id/follow-again` exist. **No screen calls them.** |
| Stock lending (shared pool, AE.6/AE.7) | Live code and screens. |
| Mapping settings follow (AE.5) | **Not built.** `followSettings` is saved but never read. |
| Rule-based assortments (AE.8) | Not built. |

Note: `docs/2026-09-19-shared-stock-*.md` still say "not pushed". That is out of date. The code is on main.

## 2. Review: is this the best approach?

**Data model — yes.** A linked copy per business is right for separate businesses (R-AE-1, R-AE-5).
Row security keeps them apart. Every existing page works on the copy with no change.

**Screens — Settings alone is not enough.**

- Settings is good for the **deal** between two businesses: which products, which fields, accept, copy, lend stock.
  These are decisions about many products at once.
- Settings is bad for **one product**. You cannot answer "is this product shared?", "which fields follow?",
  "where is it listed in the other business?" without leaving the product.
- The AE plan (§7) asked for badges in the grid and the studio. They were never built.

**Recommendation: both.** Settings keeps the deal. A new studio page shows one product.

## 3. The alias and account gap (measured)

| Area | What happens today | Where |
| --- | --- | --- |
| First copy | Copies **no listings** and so **no aliases** | `copy-source.service.ts:267` (`listings: []`) |
| Live sync | Product rows only. Listings, aliases, media plan, formulas are never read | `sync.service.ts` |
| The link | One source product ↔ one follower product. No account or alias column | `assortment-copy.sql:101,103` |
| Photos | Only the flat photo library. Media plan sets and per-alias photos are lost | `copy-source.service.ts:332-335` |
| Accounts | Sharing has no account concept. No way to say "list on accounts X and Y" | `AssortmentShare`, `CatalogLink` |
| New variation arrives by sync | It is left out of every existing listing and alias. Must be added by hand | `family-projection.service.ts` ("absence is exclusion") |
| Draft listings | Only the primary listing is made. An alias listing is never made | `draft-listing.service.ts:19-20` |
| Stock pool | **Works with aliases.** Every listing of the product follows the pool | `stock-movement.service.ts:767` |

**In short:** "no alias support" means the other business gets a bare product. Its accounts, listings,
aliases, alias labels and alias photos must all be made again by hand.

## 4. Defects found (fix first)

| # | Defect | Effect | Where |
| --- | --- | --- | --- |
| D1 | Sync writes photos straight into the photo library | For a family on the media plan, followed photos never reach a channel | `sync.service.ts:483-515`, `copy-media.service.ts` |
| D2 | Sync pauses are keyed by channel + market, not account | Pausing account X can pause account Y, or be undone by Y | `sync-control-policy.service.ts:22`, `stock-pool.sql:494` |
| D3 | Photo language tags are not copied | An Italian size chart arrives as "no text" and can go to Germany | `copy-source.service.ts:332-335` |
| D4 | Stock-switch preview shows "eBay IT" with no account or alias | Primary + 2 aliases show as 3 identical rows | `pool-links.service.ts:166-168`, `stockWords.ts:117-120` |
| D5 | SKU rename hold counts only ACTIVE listings | An INACTIVE listing still on the channel can lose its SKU | `sync.service.ts:430` |
| D6 | Same bell notice on every sync | A new variation whose SKU already exists sends the notice again and again | `sync.service.ts:537-545` |
| D7 | Retry race in the sync worker | A batch can sit claimed for 10 minutes | `sync-worker.ts:134-141` |

D2 is **not only a sharing bug**. It affects every business that has two accounts on one channel and market.

## 5. The plan

One branch, one worktree, one local test setup. One commit per step. One PR at the end, on your word.

### Step 1 — Fix the defects (API only)

- D1: a follower family on the media plan does not get silent photo writes. The link is held as "photos held",
  and the bell tells a person. (Step 4 then shares the media plan properly.)
- D2: pauses are keyed by channel + market + account. A row with no account still means "all accounts".
- D3–D7: as in the table.
- Each fix gets a test that fails before the fix.

### Step 2 — Studio page "Other businesses" + grid column

A new item in the studio's **THIS PRODUCT** group: `…/edit/studio?tab=sharing`.
Name: **"Other businesses"**. Not "Shared": the studio already uses "Shared product" for the master scope.

What it shows:

- **In the business that receives the product:** "Following <business> · linked on … · last synced …".
  A banner for a held SKU or a sync error. A table of fields: follows, or own value, with **Follow again**.
  (Reads the API that already exists.)
- **In the business that owns the product:** which assortments hold it, which businesses receive it, link state per
  business. **Add to assortment / Remove.** (Needs one new read-only route.)
- **Stock:** which stock the product uses, and a link to Settings to change it.
- **Listings in the other business** (Step 3 fills this).

Products grid: a **Source** column and filter (Own / Following <business> / Shared out). Click → the studio page.

Settings page stays. Small clean-up: remove the Tailwind `grow`, raw headings, the raw `fetch`.

Design system: reuse `SourceIndicator` (its `linked` kind is unused today), `AliasMark`, `KeyValue`, `Banner`,
`DataGrid`, `PoolSourceTag`. The words for "follows another business" come from one words function.

### Step 3 — Accounts and aliases in the business that receives the product

- **Copy layout** (one action per product, or per share for all products): the receiving business picks, per channel,
  which of **its own** accounts get the product, and how many aliases.
  - It sees the source's layout: channels, markets, alias count, alias labels. Never the source's item IDs or accounts.
  - Nexus makes **draft** listings and aliases there. Drafts send nothing until Publish (same rule as today).
- `ensureDraftListings` learns to make alias listings (today: primary only).
- A new variation that arrives by sync joins every draft listing and alias of its family as a draft row.
  A live listing is not changed. The bell says "new variation — add it to <listing>".
- The receiving business stays in charge. It can add, remove or rename its own aliases at any time.

### Step 4 — Listing content per alias (optional, off by default)

- A new field group **"Listing content"**. Off by default for every share.
- When on: the source's per-listing content (title, description, item specifics, per-alias photos) is copied **once**
  into the matching draft listing from Step 3. Price and item IDs never cross.
- Media plan: the Shared and Channel photo layers follow through the link's photo map. Alias photo layers use the
  Step 3 match.
- Live follow of listing content is **not** in this plan. It needs a link per listing. Ask again later if needed.

### Step 5 — Duplicate listing warning

- Before a business publishes shared content on eBay, the review shows a warning when the same product is live on
  another business's account. It names the listing. It does not block. (Same account is already blocked today.)

## 6. How we test (local only)

- Worktree from `origin/main`: `/private/tmp/nexus-sharing-studio`, branch `feat/sharing-studio`.
- Own throwaway Docker PostgreSQL. The worker runs only against it (hard rule 2 allows a private database).
- API with `NEXUS_AMAZON_ENV_TOKEN=off`. Web with `NEXT_PUBLIC_API_URL` set to the local API.
- Two local businesses, A and B. A family with a primary eBay IT listing, 2 aliases, 2 accounts, and a media plan.
- Each step: typecheck, the area's tests, the real-PostgreSQL copy/sync tests, then a check in the browser
  (keyboard, light and dark, phone and desktop width).
- Nothing touches production. Push only on your word.

## 7. Decisions for you

**D-1 — Where the screens live**
- A (recommended): Settings keeps the deal between businesses. Add the studio page and the grid column.
- B: Move everything into the studio. Assortments and stock lending cover many products, so they lose their home.

**D-2 — How aliases and accounts reach the other business**
- A (recommended): copy the layout once as drafts; the receiving business owns it after that (Steps 3–4).
- B: listings and aliases follow the source live. Much bigger: a link per listing, new triggers, and more eBay
  duplicate risk.

**Check my reading:** "no multiple aliases" = a shared product arrives with no listings and no aliases.
If you meant "one source product becomes several products in the other business", tell me. That is a different change.

## 8. Not in this plan

- AE.5 (mapping settings follow) and AE.8 (rule-based assortments).
- Three-level families (grandchildren) in sharing. Measure first if they exist.
- Live follow of listing content (see D-2 B).

## 9. Step 1 — build record (2026-09-28)

All seven defects are fixed and tested. One more was found while building (D2b).

| # | What changed | Proof |
| --- | --- | --- |
| D1 | A family on the media plan gets no shared photo written. The first copy and new variations report "N photos were not added" and tell the owners (bell). Live sync leaves the change due and records the reason on the link; it arrives once the family leaves the plan. `copy-media.service.ts` `PHOTOS_HELD`, `sync.service.ts` `syncMedia`. | `copy-media.vitest.test.ts` (new case), `sync.vitest.test.ts` test 5 (real PostgreSQL). |
| D2 | A pause names one account, or none (= every account). Every lookup passes the listing's account (15 call sites). The pool impact preview (SQL) counts a one-account pause only for that account. | `sync-control-policy.vitest.test.ts` (6 new cases), `stock-pool-e2e` test 6. |
| D2b | **Found while building, worse than D2:** the save route looked a pause up by the primary account and wrote it with no account, so **Resume never found it**: it answered "ok" and the channel stayed paused. Reproduced on the local copy through the real route before the fix. The save now lives in `writeChannelPolicy` (service), reads and writes one key, and merges duplicate rows. | Route probe before/after on the local copy (pause → resume → paused stayed, before; removed, after). |
| D3 | Photo language and language-version group are copied and followed. A photo with no text prints as before, so existing links see no change; a copy that arrived as "no text" is corrected by the next sync. | `sync-fields.vitest.test.ts` (new case). |
| D4 | The stock-switch preview names each listing's account, and marks ★/①② where one account and market hold more than one listing (same rule and `AliasMark` as the Media page). | `stock-pool-e2e` test 2, `stockWords.vitest.test.ts`. |
| D5 | A SKU rename waits while any listing is still on a channel: ACTIVE and published, INACTIVE with a channel id (`whereDelistTargets`), or an active shared eBay variant. | `sync.vitest.test.ts` test 6. |
| D6 | The "new variation was not linked" notice is sent once per conflict, not again after it is read (`notifyOwners` `once`). | `sync.vitest.test.ts` test 7. |
| D7 | A failed sync's note is put back with one write; a newer note (unique index) closes it instead of throwing and leaving the batch claimed. | `sync-worker.vitest.test.ts` (3 new cases); with the fix removed, the race case fails. |

**Migration `20260928m_sync_policy_account`** (data + function, no schema change):
- Every existing pause row becomes "every account" — what it always did in effect. Duplicate rows of one
  business, channel and market merge into the newest; a pause wins; "new listings start paused" keeps its
  earliest start. A check refuses the migration if a row still names an account or duplicates remain.
- Ends with `workspaces/stock-pool.sql` (the impact preview's account rule). `policy-migrations.json` points at it.
- Tested on the local copy with seeded duplicate rows in two businesses: merged per business, nothing else touched.
- The real-PostgreSQL runner builds as `nexus_owner` (NOSUPERUSER **BYPASSRLS**), the same kind of owner that runs
  migrations, so the data update sees every row.

**Checks run:** API and web typecheck; the changed areas' tests (703 tests, 0 failed after two old tests were updated
to the new shapes); all 59 static gates; the real-PostgreSQL runner (see the final line in the PR).

**Not done in step 1, said plainly:**
- No screen offers a per-account pause yet. The API accepts `channelConnectionId`; the Sync Control page still
  pauses every account. A button needs the Owner's word.
- The stock preview's new names were checked by tests, not yet on screen. Step 2's browser check covers it (it needs
  a share, a copy and a grant on the local copy).

## 10. Step 2 — build record (2026-09-28)

**The studio page "Other businesses"** (`…/edit/studio?tab=sharing`, in THIS PRODUCT after Media, every scope):
- *Comes from another business:* where the product comes from, how it was linked, when it was last updated, a waiting
  SKU and sync errors. The fields this business keeps are listed with **Follow again** (one or all). The fields that
  follow sit behind one button ("Show 220 followed fields"): 220 rows of "Follows" hid the rest of the page.
- *Shared with other businesses:* the assortments of this business, whether each holds the product (a variation
  through its main product), **Add / Take out** (list) or **Leave out / Put back** ("every product"), and each other
  business's copy (follows, SKU waiting, not copied yet, offer not answered, stopped). Taking it out of an offered
  assortment asks first with the DS `ActionConfirm`, naming each business and what it keeps.
- *Stock:* own stock or the lender's pool (`PoolSourceNote`), and the businesses selling from this business's stock.
- A person without "Edit products" sees every fact and a sentence saying why there is no button.

**API:** `GET /api/products/:id/sharing`, `POST /api/assortments/:id/product` (service `product-sharing.service.ts`).
**Products grid:** a **Source** column ("Follows <business>", "Shared with <business>"; empty for an own product; the
mark opens the page) and its filter (Own / Follows another business / Shared with other businesses), server-side on
both the live and the cached list.
**Settings › Shared products:** the Tailwind `grow` is gone (a layout class), the product search uses the page's API
helper. The headings stay: they match the profile manager page they sit beside.

**Proof:**
- `sync.vitest.test.ts` 4b (real PostgreSQL): the page's data from both businesses, add / take out on both kinds of
  assortment, a stale version refused, another business's assortment refused, the grid facts and filter conditions.
- `sharingWords.vitest.test.ts` (10): every sentence, and the take-out confirmation passes the DS `validateImpact` rules.
- On the local copy with profiles ON, through the real screens: the share was accepted and 7 products copied in
  Settings; in the receiving business the page showed the link, a field changed there showed as kept, **Follow again**
  moved it back to following; in the sharing business the page showed the assortment, the other business and its copy;
  **Take out** asked first, Escape closed it and focus went back to the button; the grid's Source column and filter
  answered correctly in both businesses; the mark opened the page.
- Keyboard: every control is in the accessibility tree. Contrast of the page's own text: 8.16–15.48:1 in light,
  9.37–12.73:1 in dark (AAA is 7:1). Phone width (390 px, in a frame): the page does not scroll sideways; a table
  scrolls inside its own box. A long button label was cut off at 390 px and was shortened.

**Not done in step 2, said plainly:**
- The stock-switch preview's account and alias names (step 1, D4) are still checked by tests only: the receiving
  business has no listings yet. Step 3 makes them, and its browser check covers the preview.
- The live sync worker did not run locally (it starts every queue consumer). "Follow again" is proven to record the
  choice; the value arriving is proven by the real-PostgreSQL test.

## 11. Step 3 — build record (2026-09-28)

**The layout.** Where the sharing business lists the product: per channel and market, per account of its own, the
main listing and each alias by name. Its accounts never cross the wall: an account is its **rank** on the channel
("account 2 of 2", primary first), shown only when it uses more than one. Item ids and listing values do not cross.
Read through the same guarded door as the live sync (`nexus_assortment_sync_source`), then in the owner's context as
the system, with the context checked back. Service: `listing-layout.service.ts`.

**Making it here.** The receiving business picks, per row, one of ITS accounts (or "Don't make it here"). The
default is its account of the same rank. Nexus makes the main listing with `ensureDraftListings` (the whole family)
and each missing alias with `createAlias` (the whole family). Everything is an inert draft: DRAFT, unpublished,
sync paused, no channel id. Made again, nothing doubles (one main listing per coordinate; an alias with the same
name on the same account and market is reused). A row that cannot be made says why: no account for the channel,
the market is not a market of this business, the account is not connected.

**Accounts the business may list on.** Its own, and another business's account shared with it **for publishing**.
An account shared **for reading only** is never offered (the database refuses a listing on it); a shared account is
named with its owner and never suggested; a shared account limited to some markets is offered only there.

**Screens.**
- Studio page, new card **Listings in this business** (on a product that follows another business).
- Settings › Shared products › Shared with this business: **Make draft listings** on an active share with linked
  products — one choice per channel and account of the sharing business, for every product at once.

**A new variation that arrives by sync** joins its family's DRAFT listings and aliases as draft rows. A listing that is
on a channel is not changed; the owners get one notice to add it there before its next publish.

**Step 1's D4 now uses the app's account-name rule** (`connectionLabel`): real accounts often have an empty label, and
the preview showed no account.

**Proof:**
- `sync.vitest.test.ts` 4c (real PostgreSQL): the layout from A with two accounts and an alias; none of A's account ids
  or names in the answer; made on B's account as drafts (6 family rows); a blocked market refused with its reason;
  made again = nothing; another business's account refused; the per-share summary and apply; a read-only shared
  account not offered, a publish-shared one offered and named, never suggested.
- `sync.vitest.test.ts` 7: the new variation JKT-L got draft rows on the main listing and the alias; the listing on
  eBay UK was untouched and one notice named it.
- `layoutWords.vitest.test.ts` (7): every sentence.
- On the local copy through the real screens: the first business got two aliases (Winter, Summer) on eBay IT; the
  second business got two eBay accounts. The studio card offered "Second store (primary)", said why the Amazon rows
  could not be made, and made 1 main listing and 2 aliases (3 × 7 draft rows, unpublished, paused, nothing queued to a
  channel). The eBay sheet then showed the three listings. Settings' dialog showed one row per channel; made again,
  it said nothing new was needed. The account picker works by keyboard; the page does not scroll sideways at 390 px.
- **Step 1's D4, now checked on screen:** the stock-switch preview names "eBay IT · Second store · ★ Main listing",
  "① Winter", "② Summer".

**Found, not fixed (older code, outside this plan):** in a business that has another business's account shared with
it, the account list can hold two "primary" eBay accounts: its own and the shared one (a connection's primary flag is
its owner's). Code that resolves "the channel's primary account" (for example `resolveDraftAccount`) can then pick the
other business's account; with a read-only grant the write is refused by the database. Worth its own look.

**A timing defect found by a flaky test, and fixed (D8).** The live-sync suite failed in about 3 of 12 runs (test 5: a
photo still there; test 9: a retry not picked up). Measured at a failure: the job's `availableAt` was `…54.178` and the
claim ran a fraction of a millisecond before it. Cause: `availableAt` is `TIMESTAMP(3)`, so a job written now is stored
rounded to the millisecond, sometimes up, and "due" compared it with the unrounded `CURRENT_TIMESTAMP`. The business
was then skipped until the next poll (2–60 s in production: a small delay, never a loss). Fix: "due" compares with
`CURRENT_TIMESTAMP(3)`, rounded the same way (rounding keeps order), in the worker's claim (`sync-worker.ts`) and in
`nexus_assortment_pending_workspaces()` (`assortment-sync.sql`, migration `20260928n_assortment_due_rounding`,
function body only). Proof: the combination that failed ran repeatedly after the fix (result in the PR).

## 12. Step 5 — build record, and step 4's status (2026-09-28)

**Step 5 — the duplicate-listing warning.** The publish review (`studio-publication.service.ts`, one line) adds a
**warning** when the same shared product is already live on eBay, on the same market, in the other business — in
either direction (this business follows it, or another business follows this one). It names the business and how
many listings are live; it never blocks and shows no item id or account. The database answers through
`nexus_shared_product_live_listings(product, channel)` (in `assortment-sync.sql`, carried by migration `20260928n`):
only for a product of the business asking, only through an active link, only a name, a market and a count. A listing
on the SAME account was already refused by the listing claim. Service: `shared-listing-warning.ts`.

Proof: `shared-listing-warning.vitest.test.ts` (2) and `sync.vitest.test.ts` 4c (real PostgreSQL: no warning while A's
listing is not on eBay; a warning naming Business A once it is; none for another market or channel; none for a
product of another business; the other direction for Business B's live copy; no item id in the answer). On the local
copy the real `…/studio-publication/preview` returned the warning. **Not seen on screen:** the local test accounts are
not really connected, so the publish dialog lists no destination; the dialog already shows a review's warnings in its
list (the same path as the variation-theme warning).

**Step 4 — listing content per alias: NOT built in this change, on purpose.** Measured while starting it: a
listing's own content is spread over the listing row (title, description and bullet overrides, the follow-master
flags, item specifics in `platformAttributes`), per-language `ChannelListingTranslation` rows, legacy
`ChannelListingImage` rows and the media plan's listing layers, and it can only be written through the catalog
transfer engine's listing rows and each channel's field contract (a cached category schema per channel and market).
Copying it across businesses needs the field group (a CHECK-constraint migration), a coordinate map from the
sharing business's rank/alias to this business's account/alias, and a check on real listing content. Rushing that
into this production push would put untested writes on live listing data. It is the next change: its own branch and
PR, with the same local proof on a copy of real listing content first.

## 13. Step 4 — design (2026-09-28, before any code; its own branch `feat/sharing-listing-content`)

**What it adds.** A share may also offer **Listing content**: when the receiving business makes the listing layout
(step 3), each draft it makes gets the sharing business's own content for that listing, **once**. After that the
receiving business owns it; nothing follows live.

**Field group `listings` — off by default.** Offered only when the sharing business ticks it (the default groups do not
include it). The database's list of allowed groups gains `listings` (`assortment-share.sql`, a migration).
- **Copied:** the listing's title, description and bullet points (its own, or "follows the product"), item specifics
  (the channel's attribute fields), the channel category, and the same per language (`ChannelListingTranslation`).
- **Never copied:** price, sale price, quantity and stock settings, seller SKU, listing status and publication, item
  and offer ids, eBay business policies (payment, return, shipping — they belong to one seller account), and every
  fulfilment setting.

**How.** The only writer is the catalog transfer engine, as for a file import and the live sync: the sharing business's
rows for that one listing are read through the guarded door (in its context, as the system), exported as the
engine's `Listings`/`Overrides` rows, filtered to the copied fields, moved to the receiving coordinate (its SKU, its
account, its alias of the same name), planned against the receiving business's channel contract, and applied. A field
the contract refuses is left out and named. Only a listing that is still a **draft here** (never published, no channel
id) receives content: a listing on a channel is never changed, and the result says so.

**Screens.** Settings' offer dialog gets the "Listing content" choice with its words (off by default). The studio card
and the Settings dialog say, before making, that content will be copied into the drafts, and after, how many fields
were copied and which were refused.

**Not in step 4a:** photos per alias (the media plan's listing layers). They need the receiving family on the media
plan and a photo map per alias; that is step 4b.

**Proof planned.** Real-PostgreSQL: a listing with its own title, specifics, a translation, a price and a policy in A;
made in B → the title, specifics and translation arrive, the price and the policy do not; a listing in B already on a
channel is untouched; made again changes nothing. Browser: the offer dialog, the studio card, Settings' dialog.


## 14. Step 4 — build record (2026-09-28)

**Built as designed (§13), with five findings folded in.**
- `services/assortment/listing-content.service.ts` — the copy. The sharing business's rows at one coordinate are read
  through the door (`linkSource`) in its context and exported by `catalogRows` (listings only; the bounded export already
  leaves price and stock out). Each row is classified by the field its channel declares for the category the row was
  read under (`classifyListingField`, an allow-list of spec groups: `content`, `aspects`, `category_attributes`,
  `product_details`, `product_identity`, `classification`, `safety_and_compliance`). Rows move to this business's SKU
  (through the share's links), account and alias of the same name, and are planned and applied **per listing** by the
  transfer engine with no channel push (`queueOutbound: false`), under the sync-write flag.
- Wired into `applyListingLayout` (studio and Settings): every chosen group copies into the family's drafts that have
  no content of their own, made now or before. The drafts stand when the copy cannot be made; the result says why.
- The studio's GET says, per slot, whether the other business has content to copy (`slot.content`) and which drafts
  here are still blank (`present.blank`), so the card offers "Copy content into N listings" only when it would copy.
- Migration `20260928o_sharing_listing_content` re-applies `assortment-share.sql`: the field-group check gains
  `listings` (rules only; drop and re-add in one transaction).

**Findings, fixed before commit.**
1. A listing with no category (none of its own, none mapped by default) made the engine refuse its fields — and, with
   every listing planned together, the same fields of the other listings too. Now each listing is planned alone; one
   with no category on either side is named ("Choose one on the listing, then copy again"), never failed.
2. A category is not content: a draft whose only own value is a category chosen here stays open to a copy, and the
   copy never replaces that category (the source's category travels only as a value, only into a draft with none).
3. A listing that over there only follows the product has nothing to copy: no refusal, no note.
4. Fields inside allowed groups that name a record of one business are never copied: eBay's description theme (a
   template of the business), Etsy's shop section and production partners (`BUSINESS_OWNED_LISTING_FIELDS`).
5. A text in a language this business's market does not carry is left out and named ("Text in German was not copied").
Shopify's store fields carry no spec group, so the allow-list copies none of them; its card offers no copy.

**Also.** The offer dialog's words now name listing content ("live channel listings always stay with each business").
The sharing page's grids without a height limit showed ~110 px of empty grid body under one row (AG Grid's
auto-height minimum); they now take `maxHeight` like the studio's, so each grid is as tall as its rows.

**Proof.**
- Real PostgreSQL (`assortment/sync.vitest.test.ts` arm 4c, 16/16): A's listing with a title in Italian and German,
  a subtitle, an item specific, a category, a price, a condition and a shipping policy; made in B → the category,
  subtitle, item specific and Italian titles arrive; the German title, price, condition and policy do not; A is
  untouched; made again → B's own title stays; a listing of B's on eBay is never changed; no category on either side →
  named, nothing written; B chooses a category → the copy fills the title and keeps B's category.
- Unit: the classifier (7), the share rules, the words (17); the AE.2 share tests take "listings" as a valid group.
- Local stack (profiles ON, private DB copy): the studio card offered "Copy content into 2 listings", copied the title,
  subtitle and category into B's drafts, not the description theme or shipping policy; drafts stayed DRAFT, unpublished,
  sync paused; nothing queued. Settings' dialog and the offer dialog; keyboard; light and dark; 390 px (no page scroll).
- API and web typecheck; 59/59 static gates; policy parity; the fresh-vs-upgraded migration check (504 migrations).
