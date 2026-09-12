# 14 — Amazon A+ CONTENT + Brand Story

## 1. What it is (operator terms)

A+ Content is a **document**, not a field. A brand-registered seller builds a stack of up to 5
(standard) or 7 (premium) visual modules — hero image + headline, comparison table, FAQ, carousel —
in a builder, then **attaches that one document to a set of ASINs** so Amazon renders it in the
"From the manufacturer" band of each product detail page. It is authored once per
**(marketplace, locale)** and translated per market, which is exactly why hub ruling #8(c) names it
"the sanctioned home for embedded localized text": a picture with German words baked in cannot ride
the ASIN-global Listings-API image slots, but it can ride a `de-DE` A+ document. Brand Story is the
same machinery one level up — one document per **(brand, marketplace, locale)**, no ASINs, four
module types, shown on every product of that brand. The person who uses it is the content/marketing
operator preparing a market launch; the person who needs to *see* it is the catalogue operator in
the product editor, who today only wants to answer three questions: does this ASIN have A+ on this
market, what state is it in, and where do I go to fix it. Everything past those three questions is
authoring, and authoring already has a home elsewhere in the app (`/marketing/aplus`,
`/marketing/brand-story`).

## 2. Old UI — inventory

**Entry point.** One card in the Amazon cockpit, rendered unconditionally:
`tabs/amazon-cockpit/AmazonCockpit.tsx:726-731` → `AplusCard asin/brand/marketplace={marketInfo.code}`.
Jump target `data-jump-target="aplus"` (`aplus/AplusCard.tsx:204`), reachable from the health panel
and from `useCockpitShortcuts.ts:33`.

**The card** (`tabs/amazon-cockpit/aplus/AplusCard.tsx`, 389 lines, read-only by design — its own
footer at :374 says "AC.8 — read + deep-link. Inline attach + approval submit land in AC.8.2",
which never landed):
- three parallel fetches on every `[asin, brand, marketplace]` change (:123-192):
  `GET /api/aplus-content?asin=&limit=20` (attached), `?marketplace=&brand=&limit=500` (library
  count), `GET /api/brand-stories?marketplace=&brand=&limit=1`.
- renders attached docs as a list of link-outs to `/marketing/aplus/<id>` (:278) with a status pill
  (`STATUS_TONE`, :68-93, hand-rolled Tailwind — six statuses), marketplace · locale · module count,
  and an `n/m approved or published` roll-up (:306-318).
- Brand Story block (:321-369): one row for the brand's story on this marketplace, or a "Create"
  link. Explicitly says "Brand Stories are brand-scoped" when the master has no brand (:326-329).
- empty state (:250-272) links to the library and to `/marketing/aplus/new`, with a conversion-lift
  claim ("~5–15 %") that appears again in the health hint.

Everything round-trips to the server; nothing is browser-local. No writes at all: the card cannot
attach, detach, submit or approve.

**The editor lives elsewhere** — this is the answer to "find it":
`apps/web/src/app/marketing/aplus/` (list `AplusListClient.tsx` 427 lines, builder
`_components/AplusBuilderClient.tsx` 614 lines, `ModuleCanvas/ModuleEditor/ModulePalette/
ModuleRender` (962 lines of per-module preview), `TemplatePicker`, `ValidationResultModal`,
`VersionHistoryModal`, `LocalizationsPanel`) and `apps/web/src/app/marketing/brand-story/`
(`BrandStoryBuilderClient.tsx` 1281 lines). Module spec is client-side at
`marketing/aplus/_lib/modules.ts` (308 lines, 17 types), templates at `_lib/templates.ts`.

**DEAD in the old tree:**
- `CockpitCapabilities.aplusContent` (`_shared/cockpit-shell/contracts.ts:107`, default at :120) —
  **declared and never read** (grep: only those two lines in all of `apps/web/src/app/products`).
  The card is not capability-gated; `AmazonCockpit.tsx` contains no `capability` reference at all.
- `composed.aplusSummary` (`useAmazonCompositor.ts:399-405`) is a **hardcoded literal**
  `{ moduleCount: 0, brandStoryAttached: false, approvalStatus: 'NONE' }`, comment "placeholder until
  AC.8 wires the MC-series module registry". Its only consumer is the health check below.
- `platformAttributes.aplus_content` — a legacy per-listing scalar key, documented at
  `schema.prisma:1490` and preserved-on-merge at `amazon/flat-file.service.ts:3447`, with **no writer
  anywhere**. Not declared in any channel spec (`services/pim/channel-specs/{amazon,ebay}.ts`), so the
  AM.1 adapter will not surface it as a column — checked, not a risk.
- `Product.aPlusContentAttachments` (`schema.prisma:191`) — relation declared, **never read** in
  `apps/api/src` or `apps/web/src`.

## 3. Backend that exists

**Routes** (`apps/api/src/routes/aplus-content.routes.ts`, 786 lines, registered
`index.ts:735` at prefix `/api`):

| method + path | line |
|---|---|
| `GET /api/aplus-content` (?marketplace, ?status, ?brand, ?search, ?asin, ?limit≤500) | :80 |
| `GET /api/aplus-content/:id` (modules + asinAttachments + localizations + master) | :126 |
| `POST /api/aplus-content` (create draft; **`asins[]` accepted only here**) | :164, :199-207 |
| `PATCH /api/aplus-content/:id` (name/brand/status/notes) | :220 |
| `DELETE /api/aplus-content/:id` | :260 |
| `POST /api/aplus-content/:id/modules`, `PATCH/DELETE /api/aplus-modules/:id` | :278, :308, :335 |
| `POST /api/aplus-content/:id/submit` | :363 |
| `GET /api/aplus-content/_meta/submission-mode` | :443 |
| `GET /api/aplus-content/:id/versions`, `POST …/versions/save`, `POST …/versions/:versionId/restore` | :449, :464, :479 |
| `PATCH /api/aplus-content/:id/schedule` | :543 |
| `POST /api/aplus-content/:id/validate` | :577 |
| `POST /api/aplus-content/:id/apply-template` | :613 |
| `POST /api/aplus-content/:id/localize` (clone master → sibling marketplace+locale) | :670 |
| `POST /api/aplus-content/:id/modules/reorder` | :752 |

`brand-story.routes.ts` (667 lines, `index.ts:736`) mirrors it: list :70, detail :107, create :137,
patch :204, delete :240, modules :254/:285/:312, submit :337, validate :412, apply-template :449,
localize :473, mode :543, versions :547/:562/:577, schedule :629.

🔴 **There is no attach/detach-ASIN endpoint.** `APlusContentAsin` rows can be created only inside
`POST /aplus-content` (:201-207) and are never written again — no route, and no UI (grep for
`asinAttachments` in the builder returns nothing; `AplusListClient.tsx:265` only *counts* them).
This is the single biggest backend gap for the studio.

**Services.** `aplus-validation.service.ts` (document validator; module cap 5 standard / 7 premium,
required fields, oversized text, duplicate hero — and its own header at :13-19 admits it "duplicates
a thin slice of the client-side spec at `marketing/aplus/_lib/modules.ts`"). `aplus-amazon.service.ts`
(`MODULE_TYPE_MAP` → SP-API `contentModuleType`, `buildSubmissionRequest` :146, `submitAplusDocument`
:198). `brand-story-validation.service.ts`, `brand-story-amazon.service.ts` are the analogues.
`aplus-amazon-pull.service.ts` = `GET /aplus/2020-11-01/contentDocuments` metadata pull.

**Prisma** (`packages/database/prisma/schema.prisma`): `APlusContent` :7657 (name, brand?,
marketplace, locale, masterContentId self-relation, status string, amazonDocumentId, submittedAt,
submissionPayload, publishedAt, notes, scheduledFor; indexes `[marketplace,status]`, `[brand]`,
`[masterContentId]`, `[status,scheduledFor]`; **no uniqueness at all**), `APlusContentVersion` :7713,
`APlusContentAsin` :7738 (`@@id([contentId, asin])`, nullable `productId`), `APlusModule` :7774,
`BrandStory` :7803 (**`@@unique([brand, marketplace, locale])`**), `BrandStoryModule` :7846,
`BrandStoryVersion` :7862. `ContentPushDetail` (:~14830) can already reference `aPlusContentId` /
`brandStoryId` + `targetRefs` for campaign-driven pushes.

**External calls and their gates — two independent gates, neither is the studio's:**
- **Submit is sandbox-stubbed and live is NOT IMPLEMENTED.** `submissionMode()`
  (`aplus-amazon.service.ts:31-33`) reads `APLUS_SUBMISSION_MODE`; sandbox (the default) mints a fake
  `AP########` id (:210-227) and the route then writes `status='SUBMITTED'` +
  `amazonDocumentId` from that fake (`aplus-content.routes.ts:417-431`). The `live` branch returns
  `ok:false, error:'not implemented'` (:230-240). Brand Story: `BRAND_STORY_SUBMISSION_MODE`,
  same shape (`brand-story-amazon.service.ts:16-20`).
- 🔴 **This gate is NOT `getAmazonPublishMode()`** (`services/amazon-publish-gate.service.ts:45-53`,
  the one the studio's publish doctrine and GDS-4 bind to). A+ has its own env switch, so the studio
  could truthfully report "Amazon = dry-run" while A+ submits, or vice versa.
- **Pull cron:** `jobs/amazon-aplus-sync.job.ts`, daily 04:00 UTC, gated
  `NEXUS_ENABLE_AMAZON_APLUS_CRON=1` (:46) — off unless set; schedule override
  `NEXUS_AMAZON_APLUS_CRON_SCHEDULE`. Uses raw LWA creds + `sellingpartnerapi-<region>` directly
  (`aplus-amazon-pull.service.ts:42-62, 96-99`), pageSize 20, ≤50 pages, 250 ms spacing.

**Permissions** (`apps/api/src/lib/auth/permissions-manifest.ts`): `RW(aplusManage, aplusManage,
pfx('/api/aplus-content'))` :307, `pfx('/api/aplus-modules')` :183, `RW(brandManage, brandManage,
pfx('/api/brand-story'))` :308 and `/api/brand-stories` :309. `aplus.manage` / `brand.manage` are
defined at `packages/shared/permissions.ts:125-126` and granted to OPS_MANAGER (:247-248).
🔴 **Read and write are the SAME permission**, so a catalogue-only role cannot even *read* A+ state —
a studio status column would 403 for exactly the operator it is for.

**Tests:** none. `find` for `*aplus*test*` / `*brand-stor*test*` returns nothing; the only file
mentioning `aplus` in a test is an unrelated browse-node fixture key.

## 4. Studio today

**Nothing.** `grep -ri 'aplus|a-plus|brand.stor'` over `_studio/**` and `design-system/grid/**`
returns zero hits. Parity audit row **3.23 = 🕳** (`docs/pes-parity-audit.md:145`): "no A+ / Brand
Story surface". A+ is named in the §3 summary (:189) among the 22 🕳 channel-operations rows whose
placement "is a programme-level decision and it should be made deliberately, not discovered at swap
time".

**Rulings that bind this feature:**
- **#8(c)** (`docs/pes-claims.md:51-52`): "**A+ Content is per-marketplace/language** and is the
  sanctioned home for embedded localized text", and the per-market image publish UI "must say which
  mechanism each market's set rides (global SP-API vs country-specific vs A+)". That honesty clause
  is **already implemented** in the images lane: `_studio/images/plan/crossChannel.ts:111-117`
  (`mechanismNote('sp-api-global')`) tells the operator in prose that "localized text belongs in A+
  Content; neither is automated from this screen".
- **AM.1 §4** (`docs/2026-09-04-channel-attribute-model-design.md:213`): "A+ content and per-market
  image TEXT — PES.7's surfaces; **not attributes of the product-type schema**." So A+ must not
  become a `ChannelFieldSpec` column with a store behind it.
- **channel-ops research §2** (`docs/2026-09-01-channel-ops-research.md:76-78`): status readouts —
  and it names **"A+ status"** explicitly — are "chip/column at scope level in the grid … + detail
  pane in the drawer". That is the recommendation below, pre-authorised in shape.
- **Layout §59** (`docs/2026-09-01-product-edit-studio-layout.md:59`): tabs are non-tabular surfaces
  only, and the set is fixed (Sheet · Images · Analytics/Ads · Activity, + Errors & Sync). **No new
  tab for A+.**
- **Ruling #5 / layout §2.10**: rebuild, never wrap `AplusCard`.
- **Ruling #13**: no live AI generation — so an "AI-translate this A+ document" verb stays dark.

## 5. Defects and slowness

1. 🔴 **The marketplace key is written in two incompatible shapes.** `CreateAplusDialog` writes
   `'AMAZON_IT'` (`marketing/aplus/AplusListClient.tsx:318, 338`, values from
   `_lib/types.ts:105-111`); the HB.8 migration normalised existing rows to `'IT'`
   (`migrations/20260521_hb8_marketplace_code_sweep/migration.sql:100-104`); the pull service writes
   the canonical 2-letter `marketCode` (`aplus-amazon-pull.service.ts:121-125`). The list route
   filters with exact equality (`aplus-content.routes.ts:95`). **The cockpit card passes
   `marketInfo.code` = `'IT'` (`AmazonCockpit.tsx:729`), so its library count and Brand Story lookup
   miss every operator-created document.** `LocalizationsPanel.tsx:313` clones into `'AMAZON_DE'`
   too, and `BrandStory.@@unique([brand, marketplace, locale])` cannot see `'AMAZON_DE'` and `'DE'`
   as the same audience, so the "one story per audience" guarantee is evadable. **CODE-READ.**
2. 🔴 **`APlusContentAsin` is write-once-at-create.** No attach/detach route, no builder UI (§3).
   Documents pulled from Amazon are created with **no** attachments
   (`aplus-amazon-pull.service.ts:171-183`), so a doc that is live on Amazon never appears in the
   per-ASIN card. **CODE-READ.**
3. 🔴 **The health score permanently penalises every Amazon product.**
   `computeHealthScore.ts:265-277` grades "A+ Content attached" from
   `c.aplusSummary.moduleCount`, which is the hardcoded `0` at `useAmazonCompositor.ts:401-405` —
   weight 3, `fail()`, always, on every product and market. The card beside it shows the truth from
   its own fetch. **CODE-READ.**
4. **Status can be a fabrication.** In sandbox mode a submit writes `SUBMITTED` + a random
   `AP########` `amazonDocumentId` (`aplus-amazon.service.ts:210-227`,
   `aplus-content.routes.ts:417-431`). Any studio column that prints "submitted" must say **which
   mode produced it**, from `GET /aplus-content/_meta/submission-mode`. **CODE-READ.**
5. **Two publish gates.** `APLUS_SUBMISSION_MODE` / `BRAND_STORY_SUBMISSION_MODE` vs
   `getAmazonPublishMode()` (§3). **CODE-READ.**
6. **The pull hardcodes `locale = 'it-IT'`** for every imported document
   (`aplus-amazon-pull.service.ts:147`, with an honest comment) — so a German A+ pulled from Amazon
   claims Italian, which is precisely the axis ruling #8(c) cares about. It also **skips every Brand
   Story** (`contentSubType !== 'EBC'` → `skipped++`, :136-139), so `BrandStory` is local-only. And
   it approximates `submittedAt`/`publishedAt` from `updateTime` (:155-157). **CODE-READ.**
7. **Over-fetch in the card:** three fetches per market switch, one of them `limit=500` whose entire
   result is thrown away except `.length` (`AplusCard.tsx:153-159`) — so a brand with >500 docs
   silently undercounts and every switch downloads up to 500 rows plus three `_count` aggregates.
   **CODE-READ.**
8. **The library page truncates at 200 and filters client-side.** `AplusListLoader.tsx:30`
   (`?limit=200`, no filter params) + `AplusListClient.tsx:71` (`row.marketplace !== marketplace`).
   The list route has no cursor at all. **CODE-READ.**
9. **The module spec is triplicated** — client `_lib/modules.ts`, server `aplus-validation.service.ts`
   `MODULE_RULES`, submission `MODULE_TYPE_MAP`. I derived all three id sets from source: they are
   **currently identical (17 types), zero drift** — so this is a live hazard, not a live bug, and the
   validator's own header (:13-19) says consolidation was deferred. **CODE-READ.** The schema comment
   at `schema.prisma:7760-7761` does list `image_gallery_6`, which exists in none of the three.
10. **Zero tests** on any A+/Brand Story route, service or validator (§3). **CODE-READ.**
11. **Dead declarations:** `CockpitCapabilities.aplusContent`, `Product.aPlusContentAttachments`,
    `platformAttributes.aplus_content` (§2). **CODE-READ.**
12. *Checked and NOT a defect:* the loaders' bare `fetch` without `credentials` is fine — the global
    patch at `lib/auth/install-fetch.ts:42` sets `credentials:'include'` for API-origin browser
    requests, and the loaders' headers explain why they must run client-side.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H2 — an `A+` status column on the Amazon channel scope, per market.** A+ is an
account-level document attached to ASINs; from the sheet's point of view it is a *fact the channel
reports about this row*, which is the exact definition of H2 in the vocabulary and the exact
placement the channel-ops research already gives for "A+ status"
(`docs/2026-09-01-channel-ops-research.md:76-78`). It cannot be H1: AM.1 §4 rules A+ out of the
product-type schema, there is no cell store for it, and an operator does not *type* an A+ document
into a cell. It cannot be a tab: layout §59 fixes the tab set. Crucially, a column is the only shape
that answers the question **per ASIN** — and per ASIN is the only granularity A+ has, because
`APlusContentAsin` is keyed `(contentId, asin)` and a variation family's children each carry their
own ASIN. Twenty-one rows, twenty-one different answers; a card can only show one.

**MIRROR: H3 — two row verbs in the one action registry.** `Attach A+ document…` (COLLECT: a DS
Combobox picker over the brand's library for this marketplace+locale → PREFLIGHT: which of the
selected rows already have it, which have no ASIN yet → CONFIRM → RUN: one call), and
`Open A+ editor ↗` (a pure link-out, the H11 half). A verb must never live only in the drawer
(channel-ops §3.2), and the registry renders each verb on the row menu, the `⋯` column, the selection
bar and the drawer from one declaration — the precedent is `channelActions.ts:162` (`offer-toggle`),
:308 (`broadcast-to-listings`), :380 (`open-record`).

**MIRROR: H4 — the same attach verb on the selection bar.** This is not a nicety: "apply this
document to these N ASINs" *is* Amazon's own workflow, and the registry gives it for free from the
same declaration. Selecting the parent + 12 children and attaching one document is the single most
common real operation in this feature.

**MIRROR: H7 — an "A+ & Brand Story" section inside the existing `Listings` pane**, not a fifth
pane. The pane is already "what THIS scope's channel currently thinks the record is"
(`drawer/panes/ListingsPane.tsx:4-19`) and already renders a `<dl>` of channel facts (:100-186); the
drawer's four panes are fixed at `RecordDrawer.tsx:473-479`. The section lists each attached document
(name · locale · module count · status pill · a module thumbnail strip), the submission **mode**, the
last submitted/published timestamps, and — once, at section level, not per row — the brand's Brand
Story for this marketplace. It is read-only for the same stated reason the pane is read-only.

**MIRROR: H11 — the editor stays at `/marketing/aplus/<id>` and `/marketing/brand-story/<id>`.**
It is already there, it is 8.5k lines of module builder, and it is account-level: one document serves
many products. The studio holds only the ASSIGNMENT. Rebuilding the builder inside the studio is the
opposite of the vocabulary's H11 guidance and of ruling "extend, don't add pages".

**MIRROR: H8 — one link, no surface.** The images lane already tells the operator, in prose, that
localized text belongs in A+ (`images/plan/crossChannel.ts:111-117`). That sentence should become a
link to the A+ surface. **I argue against a thin "A+" surface inside the Images tab** as the primary
home: A+ modules are documents with text, tables and FAQs whose images are DAM/Cloudinary asset ids
(`marketing/aplus/_lib/modules.ts:72` — `kind: 'asset_id'`), not ProductImage slots; the Images tab
renders one scope's slot matrix, and a document-status readout there would be invisible from the
sheet where the operator actually works, and would have to be duplicated per market anyway.

**Brand Story is deliberately NOT a column.** It is keyed `(brand, marketplace, locale)` — identical
for all 21 rows of a family and for every other product of that brand. A column would repeat one
value 21 times, which is the "a column that is the same on every row" anti-pattern. It belongs in
the H7 section (one line, scope-level) plus the H11 link.

### 6.2 What the sheet shows at rest, per scope

| scope | column | at rest |
|---|---|---|
| **master** | none | A+ is per-marketplace by definition (ruling #8(c)). No column, no mark. The drawer's Listings pane already says "Master is the stored truth, not a channel" (`ListingsPane.tsx:64-72`) — the A+ section inherits that sentence. |
| **Amazon × market** | `A+` — read-only, 72px, right of the readiness/identity band, hideable via the DS Customise dialog | one glyph per row: `—` none · `◐` draft/review · `↑` submitted · `●` approved/published · `⚠` rejected. `?` when the read did not happen (403 / not attempted) — never `—`, because "no document" and "we could not look" are different facts. |
| **eBay / Shopify × any** | column absent | Amazon-only capability; declaring the column and greying it would teach that eBay has A+. |

**Tooltip** (DS `Tooltip`, or `HoverCard` when >1 document): document name, locale, module count,
status, mode (`sandbox`/`live`), last submitted. For a row whose `listing.externalListingId` is null:
"No ASIN on this coordinate yet — A+ attaches to an ASIN", which is the honest version of the old
card's line (`AplusCard.tsx:243-246`).

**One view chip**, produced by the channel scope's own producer (`sheet/channel/viewChips.ts`,
along`missing-required` :113 / `channel-warnings` :126 / `mapping-errors` :139): **`No A+ (n)`**,
tone `info`, `hideWhenZero`. It obeys that file's honest-count rule (:9-15) exactly: if the A+ read
failed or was not attempted, `count: null` + a `note` — a chip that printed `(0)` on an unread
endpoint would claim we checked.

**A+ does NOT enter readiness.** `services/pim/readiness.service.ts` is column-driven (missing
required, GTIN mod-10, enum, length, GPSR) and there is ONE server definition feeding chips, bands
and rows. A+ is a recommendation, not a channel requirement; folding it in would move every Amazon
readiness percentage on the day it ships and would need a column that does not exist. The old
cockpit's decision to make it a weight-3 "recommended" check is precisely what produced defect §5.3.

### 6.3 The interaction, step by step

**Read (at rest).** The studio sheet read returns each row's `listing.externalListingId`
(`services/pim/sheet-rows.service.ts:92`, one listing per row per
`studio-sheet.service.ts:225`) — that is the ASIN, and the key. PES.5 adds A+ state to the same
response (§7), so the column, the chip and the drawer section cannot disagree, which is the rule the
Listings pane was built on ("No second fetch, so this pane and the sheet's readiness chip cannot
disagree", `ListingsPane.tsx:17-18`).

**Attach.** ① `Attach A+ document…` from the row context menu / `⋯` / selection bar / drawer actions.
② **COLLECT** — a DS `Modal` with a `Combobox` over the brand's library filtered to this
marketplace+locale, each option showing name · status · module count (DS `Pill`), plus a
"Create new in the A+ editor ↗" footer link. ③ **PREFLIGHT** — the lane folds the choice into an
`ActionImpact`: "Attach *Premium A+ — Airmesh* to 12 of 13 selected ASINs. 1 row has no ASIN on
Amazon·IT and is skipped. 3 already have it." The confirm level comes from the preflight, never a
fixed flag. ④ **CONFIRM** — `ActionConfirm` at the level the impact returned. ⑤ **RUN** — one batched
`POST /api/aplus-content/:id/asins`. ⑥ **REPAINT** — the `A+` cells of the affected rows only
(`api.refreshCells({ rowNodes, columns:['aplus'] })`, the pattern at `ChannelSheet.tsx:617-619`), the
view chip's count, and the drawer section if open. No full reload.

**Detach** is the same shape with `DELETE` and an impact that names what will stop showing on the PDP.

**Open.** `Open A+ editor ↗` on a row with exactly one document opens `/marketing/aplus/<id>` in a
new tab; with several, the drawer section's per-document rows are the links (DS `PressableRow`). The
sheet is not navigated away from — the drawer is non-modal and the sheet stays live.

**Keyboard.** The column is not editable, so `Enter`/type-to-edit must be refused, not swallowed:
`editable: false` on the wire (the `#253-255` note in `master/columns.tsx` is the precedent — AG
correctly refuses `Enter` and double-click for a truly non-editable column). ⚠ Per
`reference_ag_fill_handle_swallows_dblclick`, a read-only column still needs
`scripts/check-editor-open.mjs` in the gate so the fill handle cannot fill an inert column down.
Verbs are reachable by the registry's existing keyboard path; nothing new.

**With the drawer open** the column keeps working and the section repaints from the same row object.
`⌘↑`/`⌘↓` walk records with the section following.

**DS components:** `Tooltip`, `HoverCard`, `Pill`, `Badge`, `Modal`, `Combobox`, `PressableRow`,
`Thumbnail`, `Banner`, `EmptyState`, `Button`, `FilterChip` (view chip) — plus grid `actions/registry`,
`menuAdapters`, `ActionConfirm`, `useActionPress`. **No new DS component is needed.**

### 6.4 Per-scope rules

- **master:** no column, no verbs; the drawer section says A+ is per-market and offers the market
  switch, not a document.
- **Amazon × market:** full behaviour. `marketplace` **and** `locale` both discriminate — a document
  is `(marketplace, locale)`, and the studio's scope bar carries Market and Locale separately, so the
  column must key on the pair, not the market alone. A document whose locale differs from the scope's
  locale is shown, but marked "locale it-IT ≠ scope de-DE" rather than counted as satisfied.
- **eBay / Shopify:** column absent, verbs `HIDDEN` (not `disabled`) — the registry distinguishes
  them, and a disabled verb on eBay would teach that eBay has A+.
- **Alias band rows** are not offers and have no ASIN of their own; the column renders blank on a band
  row and the attach verb refuses with "Select a listing row — the alias band is not an ASIN", exactly
  as `offerVerb` does (`channelActions.ts:186`).
- **Single-store channels (Shopify):** N/A — Shopify's analogue is metafields/rich content, a
  different feature.
- 🔴 **Amazon EU shares an ASIN across markets but NOT its A+ document.** The same ASIN is IT·DE·FR;
  each market needs its own `(marketplace, locale)` document. So the column's value legitimately
  differs across market chips for the *same* ASIN — the opposite of the image slots, where one set is
  ASIN-global (`crossChannel.ts:113-117`). The tooltip must state which market's document it is
  reporting, or an operator will read a green IT mark as covering DE.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance:** none. The column carries no cell value, no layer, no inheritance — so no `🔗`/`✎`
  mark, and it is excluded from `provenanceClassRules` (`ChannelSheet.tsx:1097-1101`). Attribution
  belongs to the *document*, not the cell, and the drawer section shows it.
- **Autosave:** the column never writes, so it never touches `SheetWriter` / `PATCH /api/products/bulk`
  / `expectedVersion`. Attach/detach are **verbs**, not autosaves: explicit, confirmed, reported
  through `useSaveReporter` as a discrete operation. This also keeps the nav-guard question out
  (`reference_autosave_still_needs_a_nav_guard`).
- **Readiness:** untouched (§6.2). One server definition, one percentage; A+ adds its own chip.
- **Publish:** A+ submission stays **out** of the studio's `Publish ▾`, matching parity row 3.20's
  decision that the studio does not submit to Amazon. The drawer section *reports* the submission mode
  from `GET /api/aplus-content/_meta/submission-mode` and labels a sandbox-produced `SUBMITTED` as
  such — otherwise the studio would relay a fake Amazon id as fact (§5.4). If the Owner later wants
  submit from the studio, it must first read `getAmazonPublishMode()`, not its own env (§5.5).

### 6.6 ASCII mockup — the primary surface (Amazon · IT)

```
 21 rows · 3 selected  [View ▾][Missing required (7)][No A+ (14)]  Find…   [Customise][Export ▾]
┌──────────────────────────┬─────┬──────────────┬───────────┬───────┬─────┬───┐
│ Product                  │ A+  │ Title        │ Bullet #1 │ Price │ Qty │ ⋯ │
├──────────────────────────┼─────┼──────────────┼───────────┼───────┼─────┼───┤
│ ▾ ① GALE Pro · B0C1…     │  ●  │ Giacca…      │ Airmesh…  │ 189   │  12 │ ⋯ │   ● approved/published
│    ▸ GALE-KAN-PRO-S      │  ●  │ 🔗Giacca…    │ 🔗Airmesh │ 189   │   4 │ ⋯ │
│    ▸ GALE-KAN-PRO-M      │  ◐  │ 🔗Giacca…    │ 🔗Airmesh │ 189   │   5 │ ⋯ │   ◐ draft/review
│    ▸ GALE-KAN-PRO-L      │  —  │ 🔗Giacca…    │ 🔗Airmesh │ 189   │   3 │ ⋯ │   — none attached
│    ▸ GALE-KAN-PRO-XL     │  ?  │ 🔗Giacca…    │ 🔗Airmesh │ 189   │   0 │ ⋯ │   ? not read (403)
│ ▾ ② GALE Track · B0C2…   │  ⚠  │ Giacca…      │ Airmesh…  │ 199   │   7 │ ⋯ │   ⚠ rejected
└──────────────────────────┴─────┴──────────────┴───────────┴───────┴─────┴───┘
  hover ⚠ ──▶ ┌──────────────────────────────────────────────┐
              │ Premium A+ — Airmesh Jacket                  │
              │ Amazon·IT · it-IT · 5 modules · REJECTED     │
              │ mode: sandbox · submitted 3 Sep, 14:02       │
              │ "Image 2 exceeds 1464×600"   Open editor ↗   │
              └──────────────────────────────────────────────┘
  right-click a row ──▶  Attach A+ document…   Open A+ editor ↗   Detach A+ document…
```

## 7. Contracts and data

**Reused as-is** (no change): `GET /api/aplus-content/:id` (drawer section detail),
`GET /api/aplus-content?marketplace=&brand=&locale=` (the attach picker's library — but see the key
fix below), `GET /api/aplus-content/_meta/submission-mode`, `GET /api/brand-stories?marketplace=&brand=`,
and every `/marketing/aplus/*` editor route as the H11 link-out target.

**New server work — PES.5:**
1. **A+ state on the studio sheet read.** Extend the row projection with
   `aplus: { count, state: 'none'|'draft'|'submitted'|'approved'|'rejected', docs: [{id,name,locale,status,moduleCount}] } | null`
   — **`null` means not read**, and the client must render `?` for it, not `—`. One `findMany` over
   `APlusContentAsin` `where: { asin: { in: [...rowAsins] } }` joined to `APlusContent` filtered to
   the scope's `(marketplace, locale)`; the join is already indexed `@@index([asin])`
   (`schema.prisma:7752`). **This is the N+1 killer** — one query for the family, not one fetch per
   row as the old card did per product.
2. **`POST /api/aplus-content/:id/asins`** (body `{ asins: string[], productIds?: string[] }`,
   `createMany` + `skipDuplicates`) and **`DELETE /api/aplus-content/:id/asins`** — the missing
   attach/detach endpoints (§5.2). Idempotent, returning the resulting attachment set.
3. 🔴 **Normalise `APlusContent.marketplace` / `BrandStory.marketplace` to the canonical 2-letter
   code** and fix the writer (`marketing/aplus/_lib/types.ts:105-111`). Until this lands **any studio
   column keyed on the market is wrong for half the rows** (§5.1). Additive-safe shape: accept both
   forms on read (normalise in the service), fix the writer, then a one-off `UPDATE` mirroring
   `20260521_hb8_marketplace_code_sweep`. **Blocking dependency** for 6.2.
4. **Split the permission:** add `aplus.view` / `brand.view` and map GET to it
   (`permissions-manifest.ts:307-309` becomes `RW(aplusView, aplusManage, …)`), so a catalogue role
   can read the column. Additive to `packages/shared/permissions.ts` + the role sets.
5. Optional, later: reconcile `APLUS_SUBMISSION_MODE` with `getAmazonPublishMode()` (§5.5), and give
   the pull service the real per-document locale instead of `'it-IT'` (§5.6).

**Schema:** **no changes needed** — `APlusContentAsin` already models exactly the join the studio
needs. Everything above is route + service work. (Any future `SavedAPlusTemplate` is the marketing
lane's, not the studio's.)

**Lane ownership:** **PES.5** items 1–5 above. **PES.3** the `A+` column, the view chip, the two
verbs in `sheet/channel/channelActions.ts` + `viewChips.ts`. **PES.4** the "A+ & Brand Story" section
in `ListingsPane.tsx`. **PES.2** nothing new — the registry, `menuAdapters`, `ActionConfirm` and the
`Tooltip`/`HoverCard` renderers already cover it; a read-only glyph column needs no substrate change.
**PES.7** the one-line link from `crossChannel.ts:117`'s mechanism note. **PES.1** nothing. **PES.8**
nothing (an "AI-translate A+" verb stays dark under ruling #13). **PES.6** nothing — A+ is not a
mapped field (AM.1 §4).

## 8. Risks and traps

1. 🔴 **The market-key drift (§5.1) will silently produce a wrong column.** Every glyph would read
   "none" for operator-created documents. A column that says "no A+" on a product that has A+ is
   worse than no column. **Gate: derive the distinct `marketplace` values from the DB before shipping
   the column, and assert set membership in the canonical code list** — not a grep, a query, and not
   by the lane that wrote the fix.
2. **Real writes from local dev.** Local dev hits the **production** database
   (`reference_local_dev_hits_prod_api`), so an attach test attaches a real document to a real ASIN.
   Attach is DB-only (no channel call) so it is recoverable, but it changes what Amazon renders on the
   next A+ republish. Test with the picker's COLLECT step only; never exercise RUN on a live ASIN
   outside the fixture family.
3. **A sandbox `SUBMITTED` is a fake** (§5.4). Relaying it unlabelled is the same class of dishonesty
   as a green dry-run read as a live publish. The column's tooltip must carry the mode.
4. **The pull cron is off** (`NEXUS_ENABLE_AMAZON_APLUS_CRON` unset ⇒ disabled,
   `amazon-aplus-sync.job.ts:46-49`), so `status` is *our* record, not Amazon's. The section must say
   "as we last recorded", never "Amazon says". And per `reference_cron_is_per_process`, if it is ever
   enabled it must go through the clustered wrapper it already imports (`clustered.js`, :15).
5. **Permission asymmetry** (§5, item on `aplus.manage`): before the split lands, the column will 403
   for most roles. The `?` glyph + `count: null` chip are what makes that honest rather than a silent
   "no A+ anywhere".
6. **Untouchables:** the flat-file editors preserve `platformAttributes.aplus_content` on merge
   (`amazon/flat-file.service.ts:3447`) — do not touch that line; the studio does not read that key.
7. **AI dark** (ruling #13): the A+ builder's translate/generate paths stay where they are; the studio
   proposes no generation.
8. **Not applicable but worth stating for the record:** per-channel oversell and Amazon EU shared
   quantity do not touch A+; **Amazon global-per-ASIN images do** — the *contrast* is the point (§6.4,
   final bullet), and an operator who has just learned "images are ASIN-global" will assume A+ is too.
9. **AG traps:** a read-only glyph column must still be covered by `scripts/check-editor-open.mjs`
   (fill-handle double-click swallow), and any inline `cellRendererParams` object must not be rebuilt
   per render (`reference_ag_react_inline_options_rerun_column_model`).
10. **Two column builders drift** (`reference_two_column_builders_drift`): the `A+` column is
    channel-scope-only and client-declared (the precedent is the `alias` identity column,
    `ChannelSheet.tsx:1641-1642`), so it will NOT appear in the server column set and must be
    excluded from any master/channel column-parity assertion deliberately, with the reason stated —
    otherwise the parity gate either fails or is loosened for the wrong reason.

## 9. Open questions for the Owner (max 3)

1. **Does the studio ever SUBMIT an A+ document to Amazon, or only attach and link out?**
   *Recommendation: attach + link out only.* Parity row 3.20 already settled that the studio does not
   submit to Amazon, live A+ submission is not implemented (`aplus-amazon.service.ts:230-240`), and it
   rides a second env gate that disagrees with `getAmazonPublishMode()`. Submitting from two places is
   how a sandbox fake becomes a reported fact.
2. **Does A+ count toward Amazon readiness?**
   *Recommendation: no — its own `No A+ (n)` chip, out of the readiness percentage.* Readiness is one
   server definition over columns; A+ is a document and a recommendation. The old cockpit's weight-3
   "recommended" check is exactly what produced a permanent, false −3 on every product (§5.3).
3. **Fix the marketplace-key drift now, or ship the column reading both shapes?**
   *Recommendation: fix it first (PES.5 item 3), then ship the column.* A tolerant reader leaves two
   writers alive, and `BrandStory.@@unique([brand, marketplace, locale])` is already evadable through
   the second shape. This is a ~30-line service + one-off UPDATE mirroring an existing migration.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Marketplace-key normalisation + writer fix (§7.3) | PES.5 | **S** — mirrors an existing migration; **blocks everything else** |
| `POST/DELETE /aplus-content/:id/asins` (§7.2) | PES.5 | **S** |
| A+ state on the studio sheet read, one batched join (§7.1) | PES.5 | **M** |
| `aplus.view` / `brand.view` permission split (§7.4) | PES.5 | **S** |
| `A+` status column + tooltip/HoverCard + `No A+` view chip | PES.3 | **S/M** |
| `Attach` / `Detach` / `Open editor` verbs + picker (COLLECT→PREFLIGHT→CONFIRM→RUN) | PES.3 | **M** |
| "A+ & Brand Story" section in the Listings pane | PES.4 | **S** |
| Mechanism-note link from the images planner | PES.7 | **XS** |
| First tests for the A+ routes/validator (none exist) | PES.5 | **S** |

**Dependencies:** the column depends on §7.1 which depends on §7.3. The verbs depend on §7.2. The
drawer section depends on §7.1 (same row object — no second fetch). Nothing here depends on feature
13 (images) beyond the one link, and nothing depends on PES.6 (A+ is not a mapped field) or PES.8
(no AI). Total: one **S** blocker, then roughly **M** of parallel work across three lanes.
