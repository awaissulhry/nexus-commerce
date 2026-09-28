# Sharing between businesses — review and plan

Date: 2026-09-28
Status: **APPROVED 2026-09-28** (D-1 A, D-2 A, reading confirmed, "yes, start"). **Steps 1 and 2 BUILT and tested
locally (§9, §10).** Nothing pushed. Branch `feat/sharing-studio`, worktree `/private/tmp/nexus-sharing-studio`.
Builds on: `docs/2026-09-16-assortment-engine-plan.md` (AE), `docs/2026-09-19-shared-stock-plan.md`.
The review facts were read from `origin/main` (c520befc5).

## Owner rulings (newest first)

| When | Ruling | Decision |
| --- | --- | --- |
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

