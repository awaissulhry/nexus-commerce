# 34 — LIST ON CHANNEL: creating a NEW listing for a product on a channel × market

## 1. What it is (operator terms)

A cataloguer has a product that exists in the PIM and is sold on, say, Amazon·IT, and now wants it
on eBay·DE for the first time. Today they press **List on Channel ▾** in the old edit header, pick
`eBay · DE`, and are thrown out of the product page into a nine-step full-screen wizard at
`/products/:id/list-wizard` that asks them for the channel, the category, the identifiers, the
variation theme, every required attribute, the images, the price, a review, and finally a Submit
that fires real channel calls. The wizard keeps its own JSON draft; if the operator leaves, the
draft lands on `/products/drafts` to be resumed. In the studio this is the one capability that
CREATES a coordinate rather than editing one — and it is the same act as the studio's
`[+ Add listing alias]`, the header `Publish ▾` on a coordinate with nothing on it, and the eleven
"List on Amazon/eBay · market" link-outs D9 deleted. Those must be ONE verb, not four.

## 2. Old UI — inventory

**Entry points (all still live):**

| entry | file:line |
|---|---|
| `List on Channel ▾` in the edit header | `edit/ListOnChannelDropdown.tsx:16`, mounted `ProductEditClient.tsx:52,1215` |
| hard-coded market lists | `ListOnChannelDropdown.tsx:13-14` — Amazon `IT DE FR ES UK US`, eBay `IT DE FR ES UK`, plus `SHOPIFY/GLOBAL` and `WOOCOMMERCE/GLOBAL` (`:100,110`) |
| `router.push(?channel=&marketplace=)` | `ListOnChannelDropdown.tsx:44-51` |
| `/products/drafts` resume | `drafts/DraftsClient.tsx:681,768` |
| Drafts lens | `products/_lenses/DraftsLens.tsx:146,181` |
| Stranded products → "Create Listing" | `products/stranded/page.tsx:123` |
| old grid row action | `products/_components/GridView.tsx:433,1515` |
| after creating a product | `products/new/CreateProductWizard.tsx:167` (`router.replace`) |
| AI-usage row link | `settings/ai/AiUsageClient.tsx:789` |

**Nine "steps" are eight components whose filenames no longer match their positions.**
`lib/steps.ts:38-121` declares 9 steps; `ListWizardClient.tsx:650-684` routes `currentStep` 2 →
`Step3ProductType`, 3 → `Step1Identifiers`, 4 → `Step5Variations`, 5 → `Step4Attributes`, 6 →
`Step7Images`, 7 → `Step8Pricing`, 8 → `Step9Review`, 9 → `Step9Submit`. Step 3 is `hidden: true`
(`steps.ts:63`) but still routable.

**Sizes** (`wc -l`): `Step5Variations` 2311 · `drafts/DraftsClient` 2113 · `Step9Review` 1619 ·
`Step9Submit` 1450 · `Step3ProductType` 1431 · `Step1Channels` 1373 · `Step4Attributes` 1309 ·
`Step8Pricing` 1147 · `Step2GtinExemption` 835 · `ListWizardClient` 735 · 19,474 lines total.

**Round-trips vs local.** Everything round-trips; nothing is `localStorage`. The page POSTs
`/api/listing-wizard/start` **client-side on mount** because the API cookie is cross-site and the
Next server cannot present it (`list-wizard/page.tsx:1-7,95`). Every state change is a
fire-and-forget `PATCH /api/listing-wizard/:id` with `{currentStep, state, channels}`
(`ListWizardClient.tsx:215-222`); a 409 raises a sticky conflict banner (`:229-237,613-632`).
`beforeunload` guards only the `saving` window (`:413-421`). Cross-tab refresh is a
`BroadcastChannel` emit (`wizard.created` `:500-505`, `wizard.deleted` `:327-331`).
Keyboard: `Cmd+←/→`, `Cmd+Enter` (smart continue), `Cmd+G` (jump to blocker) (`:428-472`).

**Templates.** `Step1Channels.tsx:203-209,424,454` lazily fetches `/api/wizard-templates` and
POSTs `/:id/apply`, then **reloads the page** to pick up the patched wizard.
`Step9Submit.tsx:1078` saves the current wizard back as a template.

**Nothing DEAD by importer**, but `ChannelGroupsManager.tsx:1-30` persists only into
`state.channelGroups` and `DraftListing` (`schema.prisma:2526`) is a different, older eBay-only
"AI Listing Generator" model used by `services/ai/ai-listing.service.ts:278` and
`workers/bulk-list.worker.ts:91` — **not** the list-wizard's draft store, despite the name.

## 3. Backend that exists

**Routes** — `apps/api/src/routes/listing-wizard.routes.ts`, **5,555 lines, ~35 endpoints**,
RBAC `RW(listings:view, listings:publish)` on the whole prefix
(`permissions-manifest.ts:345`; `/api/wizard-templates` the same, `:346`):

| method + path | file:line |
|---|---|
| `POST /api/listing-wizard/start` (find-or-create by `channelsHash`) | `:900-1013` |
| `GET`/`PATCH`/`DELETE /:id` | `:1015`, `:1041`, `:1374` |
| `GET /drafts`, `/drafts/summary`, `POST /drafts/bulk-delete` | `:485`, `:356`, `:1275` |
| `GET /connection-status` | `:278` |
| `GET /:id/gtin-status`, `/required-fields`, `/variations`, `/variation-themes`, `/images`, `/pricing-context`, `/review` | `:1446`, `:1783`, `:1909`, `:1986`, `:2083`, `:2156`, `:2532` |
| `POST /:id/submit`, `/poll`, `/retry` | `:2596`, `:2821`, `:2992` |
| `POST /:id/schedule-publish`, `GET /:id/scheduled-publishes`, `DELETE /scheduled-publishes/:id` | `:4541`, `:4607`, `:4642` |
| AI: `/suggest-product-types`, `/generate-content`, `/ai-complete-all`(+`/estimate`), `/score-quality`, `/suggest-pricing`, `/suggest-variation-theme`, `/suggest-channels` | `:1682`, `:2227`, `:3731`/`:5245`, `:4149`, `:4355`, `:4925`, `:5085` |
| `POST /api/wizard-templates/:id/apply`, `/from-wizard/:id` | `wizard-templates.routes.ts:211`, `:136` |

**Services:** `submission.service.ts` (1556 ln) — `validateMultiChannel`,
`composeMultiChannelPayloads`, `writeAsinsBack` (`:1425-1510`); `channel-publish.service.ts`
(351 ln) dispatcher; adapters `amazon-publish.adapter.ts` (443), `ebay-publish.adapter.ts` (779),
`shopify-publish.adapter.ts` (278); `schema-parser.service.ts` (979), `variations.service.ts` (506),
`product-types.service.ts` (514), `telemetry.service.ts` (196).

**Prisma:** `ListingWizard` (`schema.prisma:7339`) — `channels Json`, `channelsHash`,
`currentStep`, `state Json`, `channelStates Json`, `submissions Json`, `status`, `version`,
`expiresAt`, `@@unique([productId, channelsHash, status])`. `WizardTemplate` (`:7562`) —
`channels`, `defaults Json`, `builtIn`, `categoryHint`, `usageCount`. `WizardStepEvent` (`:7502`),
`ScheduledWizardPublish` (`:7450`). Creation targets: `ProductListingAlias` (`:1732`) and
`ChannelListing`.

**External channel calls and their gates.** `publishToChannel` branches for real:
AMAZON `:144-180` → `amazonAdapter.publish` → `getAmazonPublishMode()` per PUT
(`amazon-publish.adapter.ts:147`; `gated` short-circuits with an audit row `:150-167`);
EBAY `:184-215` → `getEbayPublishMode()` **before any DB read or network call**
(`ebay-publish.adapter.ts:262-290`); SHOPIFY `:219-256` (drafts on the Shopify side).
`NOT_IMPLEMENTED` now covers only WooCommerce/Etsy (`:85-94`). eBay account selection is
**declared unsolved in the code**: `tryResolveConnection({channel:'EBAY', primary:true})` with the
comment *"a wizard publishing a NEW listing has no row to derive an account from. 🔴 MAP.4: the
wizard should ask which account to publish to"* (`ebay-publish.adapter.ts:291-296`).

**Jobs:** `wizard-cleanup.job.ts` (daily — orphan pass, `wizard_abandoned` telemetry, deletes
DRAFT past `expiresAt`) and `scheduled-wizard-publish.job.ts` (60s tick, **default-OFF** behind
`NEXUS_ENABLE_SCHEDULED_WIZARD_PUBLISH=1`, `:16-19`); both imported at `index.ts:200,282`.

**The studio's own creation backend already exists.** `POST /api/products/:id/aliases` →
`createAlias` (`product-studio.routes.ts:752-767`; `services/pim/listing-alias.service.ts:64-131`)
creates the alias **and** one `ChannelListing` per family member with
`listingStatus:'DRAFT', isPublished:false` (`:121-126`) and inherits the siblings' account
(`:82-87`). **The guard the prompt asked for:** `if (await legacyAliasIndexesPresent()) throw new
AliasCreationBlockedError()` — `listing-alias.service.ts:76`, class at `:19-28`, index probe at
`:47-57`, surfaced as HTTP 409 `alias_creation_blocked` (`product-studio.routes.ts:60`). The
migration that lifts it is parked at
`packages/database/prisma/migrations-pending/20260901d_pes5_ii_drop_legacy_alias_keys.sql`
(2 `DROP INDEX` statements, rollback beside it).

**And a second, unlabelled creation path.** `PATCH /api/products/bulk` upserts a `ChannelListing`
on first write to a coordinate with `listingStatus:'DRAFT'` and the context's `aliasKey`
(`products.routes.ts:2448-2473`). `aliasKey?: string` **is** on `marketplaceContexts`
(`:1042-1052`) — the parity audit's "writes to a non-primary alias are not routable" (line 571-575)
is stale. `channel: 'AMAZON' | 'EBAY'` still excludes Shopify. The publish preview already treats
an unlisted coordinate as sendable — *"`unlisted` — nothing exists on the channel yet. Still
sendable (that is how a listing is born)"* (`services/pim/sheet-publish.service.ts:16-17`).

## 4. Studio today

- `[+ Add listing alias]` is a `Button` in the **toolbar `trailing` slot**, after one
  `AliasPublishControl` per alias (`ChannelSheet.tsx:1958-1976`); handler
  `onAddAlias` `:1838-1849` → `addListingAlias` (`useChannelSheet.ts:350-378`).
- `AliasBandCell.tsx:7` quotes layout §1's *"`[+ Add listing alias]` row at group end"* — **that row
  is not built**; and the band has **no `⋯` at all**: *"The channel declares no parent-row verbs
  today (`channelActions`: HIDDEN off a variant), so the ⋯ does not render"* (`:58-62`).
- `channelActions.ts` declares three verbs — `offer-toggle` (ROW `:162-184`),
  `broadcast-to-listings` (SELECTION `:308-310`), `open-record` (ROW `:380-382`). **No
  `CONTEXT(alias-group)` verb exists yet**, and `ContextAxis` has exactly two values
  (`design-system/grid/actions/registry.ts:33`).
- Unlisted coordinates: `unlisted` derived from the server only
  (`ChannelSheet.tsx:1888-1889`), pill reads **"Not listed"**, neutral tone
  (`grid/renderers/readiness.ts:56`); shells flagged `isUnadoptedShell` (`rows.ts:232-248`),
  band says *"No variations and no stock behind it yet"* (`AliasBandCell.tsx:68-70`).
- Header `Publish ▾` lists channels with readiness but **every item is `disabled: true`**
  (`PublishMenu.tsx:67`) under one footer sentence (`:31-32,77`).
- `/products/next` has **no** "List on…" affordance (grepped: zero hits).
- WizardTemplate already has an out-of-studio manager: `settings/ai/AiWizardTemplatesClient.tsx`.

**Parity audit.** Row **8.5** (`docs/pes-parity-audit.md:443`): *"🔁 RE-DERIVED under D9 (#214) →
add a coordinate + `Publish ▾`. 🔴 REGRESSED (#248)"*. Row 1.26 (`:78`) drops the ⌘K route opener.
Rows 8.2–8.4, 8.9 all carry D9's *"a new coordinate + `Publish ▾` is List on…"*.

**Hub rulings that bind this feature.**
- **#214 (D9, Owner)** — the `⋯` link-out menu is removed entirely; *"List on X · market → a new
  channel coordinate in the sheet, born DRAFT, + `Publish ▾`"*; **→ PES.3: verify an operator can
  CREATE a new channel coordinate from the scope bar**.
- **#235 (PES.3)** — answered #214: two clicks reach eBay·DE, a cell edit upserts a listing born
  DRAFT + `isPublished:false`, *"typing cannot produce something publishable"*; band fixed from
  `?? 'DRAFT'` to **NOT LISTED**; ⚠ *"`Preflight ★ (20)` and `Warnings (42)` both render on a
  coordinate with no listing"* — still open, → UX.1.
- **#248** — BE-1's narrowing **removed the create path** (`scope_not_available` on every unlisted
  coordinate); *"D9 STANDS … the create path is the thing to restore, and it is one flag"*; and
  *"any of them puts a fabricated number exactly where an operator decides whether to create a
  listing"*. **The flag has since landed** — `studio-sheet.service.ts:838` passes
  `{ onlyChannels: [wantChannel], includeEmptyChannels: true }` with the two-directions comment at
  `:831-837`, and the error path re-reads the full coordinate set (`:848-855`).
- **#18 (Owner)** — shell adoption = **adopt all 22, end nothing**, dry-run first; blocked on
  PES.5-ii (`pes5-phase0-backend.md:3199-3203`).
- **#13 (Owner)** — no live AI generation.
- **#110 / #114** — publish snapshot doctrine; a context verb must NAME ITS AXIS.

## 5. Defects and slowness

1. **🔴 Three places say the wizard's Submit sends nothing; it sends.** `TECH_DEBT.md:1216`
   (*"channel publish adapters all NOT_IMPLEMENTED"*), `channel-publish.service.ts:1-14`
   (*"v1 ships every adapter as NOT_IMPLEMENTED"*) and `listing-wizard.routes.ts:2590-2594`
   (*"every adapter returns NOT_IMPLEMENTED … the publishes are stubs"*) all contradict
   `channel-publish.service.ts:144, 184, 219`, which dispatch Amazon, eBay and Shopify for real.
   The gates hold (`getAmazonPublishMode` / `getEbayPublishMode`), so the *outcome* is safe — but
   any lane sizing this feature from the docs would conclude Submit is inert. **CODE-READ.**
2. **🔴 `[+ Add listing alias]` is a control that cannot succeed and only says so after the press.**
   Rendered unconditionally (`ChannelSheet.tsx:1971-1976`); the 409 arrives from
   `listing-alias.service.ts:76` and lands in an `addError` span (`:1844-1847`). Exactly
   `reference_disabled_control_cannot_explain`, inverted: it explains itself *after* the action.
   **CODE-READ.**
3. **🔴 Zero tests.** `grep -rln 'listing-wizard\|list-wizard' --include='*test*'` over
   `apps/api/src` + `apps/web/src` → **0 files**; `find … -path '*list-wizard*' -name '*.test.*'`
   → **0**. 19.5k lines of web + 5.5k lines of routes with no test naming them. (Two service tests
   exist and do not name the wizard: `conditional-requirements.vitest.test.ts`,
   `ebay-publish.adapter.vitest.test.ts`.) **MEASURED-BY-GREP.**
4. **🔴 `POST /drafts/bulk-delete` HARD-deletes Products.** `prisma.product.deleteMany`
   (`listing-wizard.routes.ts:1349`), up to 200 ids per call, while the wizard rows beside them are
   soft-deleted to `DISCARDED` (`:1330-1334`) and the rest of the tree filters `deletedAt: null`.
   **CODE-READ.**
5. **The wizard is a parallel draft store that the studio cannot see.** `grep` for
   `prisma.product.update|create` in the routes file returns only the bulk-delete; the only
   `channelListing` writes in `submission.service.ts` are the post-submit ASIN write-back
   (`:1443`, `:1486`). So `ListingWizard.state` diverges from the master record silently for as
   long as a draft lives, and no studio surface reads it. **CODE-READ.**
6. **8 live AI-generation endpoints gated only by an API key.** `isConfigured()` at
   `listing-wizard.routes.ts:2239, 3502, 3739, 4154, 4360, 4930, 5093` (+ `/ai-complete-all`). No
   dark-mode flag. Against ruling #13. **CODE-READ** (whether a key is set in prod: HYPOTHESIS).
7. **No account axis.** `ebay-publish.adapter.ts:291-296` states the gap in its own comment
   (MAP.4). **CODE-READ.**
8. **Polling.** `/products/drafts` runs two 30s timers (`DraftsClient.tsx:1104`, `:1139`);
   `Step9Submit.tsx:73-82` backs off 3s → 30s for 15 minutes.
9. **Resume is keyed on the channel SET.** `@@unique([productId, channelsHash, status])`
   (`schema.prisma:7386`) + find-or-create on `channelsHash` (`routes:958-966`) means changing the
   selection creates a *second* draft for the same product; the route already counts
   `siblingWizardCount` (`:846`). **CODE-READ.**
10. **Step numbering drift** (see §2) — a mirrored numbering that no type can check.
11. **Preflight/Warnings chips describe a listing that does not exist** on an unlisted coordinate
    (#235, still open). **MEASURED-IN-DOC.**
12. **The toolbar `trailing` strip is the geometry SR.1 measured as ragged** — N publish controls +
    the add button + notes in one slot (`ChannelSheet.tsx:1958-1980`); claims ledger 22584 records
    *"+ Add listing alias) spread over three rows, with 1077px of horizontal emptiness on row 1"*.
    **MEASURED-IN-DOC.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY — H5, a CONTEXT verb `+ Add listing…` rendered on the alias band strip, in the
`[+ Add listing]` band row at group end that layout §1 already specifies** (quoted in
`AliasBandCell.tsx:7` and never built), **plus a DS `EmptyState` CTA when the scope has no listing
at all.** The subject of this verb is a LISTING on this coordinate — the same object the band is —
so it belongs where the bands are and nowhere else. It is not a ROW verb (a listing is not a
variant), not a SELECTION verb (selecting 4 child SKUs cannot express "make a listing"), and not a
toolbar-only control, which is where it sits today and is precisely why the trailing strip reads
ragged (defect 12).

⚠ **One honest snag the Owner should see: the registry has no axis for it.** `ContextAxis` is
`'product-family' | 'alias-group'` (`registry.ts:33`), and creating a listing acts on the
*coordinate*, not on any existing alias group. Forcing it onto `alias-group` is the one-level-up
mistake ruling #114 exists to prevent. Recommendation: **PES.2 widens `ContextAxis` by one value,
`'channel-scope'**, and `+ Add listing…` declares it. That keeps #114's rule intact instead of
bending it, and the same axis then hosts every future scope-subject verb.

**MIRROR — H10, the header `Publish ▾`.** Today every item is `disabled` (`PublishMenu.tsx:67`).
Each item becomes a router: on a coordinate that HAS a listing it opens the publish flow report 06
designs; on one that does not, the **same item opens this create Stepper**, pre-scoped. That is
literally D9's replacement sentence — *"a new channel coordinate in the sheet, born DRAFT, +
`Publish ▾`"* (#214) — with one implementation behind both halves. The menu still sends nothing
itself.

**MIRROR — H4/H11, `/products/next` "List on…".** On the catalogue grid the same act is a
SELECTION verb over N products, and its only honest run is per-coordinate and preflight-first. It
must reuse the exact same COLLECT/PREFLIGHT/CONFIRM/RUN implementation and the same server routes;
what differs is the target set. The WizardTemplate **library** stays outside the studio at
`/settings/ai` where it already lives (`AiWizardTemplatesClient.tsx`) — the studio holds only the
per-create ASSIGNMENT (H1-shaped, inside the Stepper).

**QUEUE — H9, Errors & Sync.** A create that the server refuses (alias blocked, missing category,
no connection) is queue-shaped when it happens over N products from `/products/next`, and belongs
in `channel-ops/ErrorsSyncConsole.tsx`, grouped by cause, rows jumping to the coordinate.

**And the answer to "should the old route be retired": YES from the studio, NOT YET from the
tree.** D9 already deleted the header link-out (#217), so nothing in the studio may point at
`/products/list-wizard` again — restoring that link is, by #214's own words, a parity defect. But
**eight other surfaces still push into it** (§2 table). Recommendation: (a) remove
`ListOnChannelDropdown.tsx` with the old edit page at swap; (b) repoint `stranded`, `DraftsLens`,
`GridView` and `CreateProductWizard` at the studio's channel scope + this Stepper; (c) keep the
route itself reachable, unlinked, until the DRAFT-wizard count reaches zero. **Do not build a
JSON→column migrator** for in-flight `ListingWizard.state`: it is an untested shape (defect 3)
writing prod data. `/products/drafts` instead keeps a clearly labelled **"Legacy wizard drafts
(read-only)"** section that resumes on the old route, and the existing 30-day expiry cron
(`wizard-cleanup.job.ts`) drains it. `ListingWizard` rows are **never deleted** — `submissions` +
`WizardStepEvent` are the audit trail of real publish attempts (§3).

### 6.2 What the sheet shows at rest

- **Master scope:** nothing. Master has no coordinate to list on, and `PublishMenu.tsx:98-100`
  already says so in the trigger's title. No column, no mark, verb `HIDDEN`.
- **Channel × market that HAS listings:** one `[+ Add listing]` row at the end of the alias group
  list — a band-shaped, always-visible row, not a hover affordance. When PES.5-ii has not landed it
  renders **`disabled` with the server's own sentence** (`AliasCreationBlockedError.message`,
  fetched once per scope from a cheap capability read, never guessed client-side), which fixes
  defect 2.
- **Channel × market with NO listing** (`readiness.state === 'unlisted'` on every alias,
  `ChannelSheet.tsx:1888`): the grid is replaced by a DS `EmptyState` — title "Not listed on
  eBay · DE", description naming what would be created, action `[+ Add listing]`. Per #248, **no
  fabricated count**: the readiness figure, `Preflight ★` and `Warnings (N)` are all removed here
  (this also closes #235's open flag), and the one countless line is
  `readinessMeta('unlisted','row').label` + its hint.
- **No new H2 status column.** "Has a listing here" is already the band's own state; a per-row
  column would invite a per-variant create, which no channel offers.
- **Tooltip:** the band-row title states which of the two things the press will do — *create the
  PRIMARY listing on this coordinate* or *create an additional listing (alias)* — because those are
  two different backend paths with two different gates (6.4).

### 6.3 The interaction, step by step

**Open.** Band row `[+ Add listing]`, the empty-scope `EmptyState` CTA, or header
`Publish ▾ → eBay · DE` on an unlisted coordinate. Opens a DS `Drawer` (`variant="modal"`,
`width={640}`) carrying a DS `Stepper` (`components/Stepper.tsx:27-36`, `onSelect` + `canSelect` so
completed steps are clickable and later ones are not) with **four** steps — the old wizard's nine
collapse because steps 5–8 (attributes, images, pricing, review) **are the sheet**:

1. **Scope & variants.** Channel × market are NOT asked — they come from `useStudioScope`. This
   step shows the coordinate, the resolved account (closing MAP.4: a DS `Listbox` of
   `ChannelConnection`s when more than one, never a silent `primary:true`), and a `Checkbox` list of
   which family members go into the listing, defaulted to all. Modal, so no cell edit can change
   what is being created mid-flight.
2. **Preset.** DS `Listbox`/`PressableRow` over `GET /api/wizard-templates`, `categoryHint` matches
   badged "Recommended for this product", plus "Start from master only". Applies the template's
   `defaults` slices to the *draft* the next step validates — **not** a page reload
   (`Step1Channels.tsx:207-209`).
3. **Prerequisites.** The genuine ones only — the fields the channel needs before a row can be
   addressed at all: **category / productType** (Amazon `productTypes`, eBay leaf category),
   **business policies** for eBay, **identifiers / GTIN exemption**, **variation axes**. Each is a
   `KeyValue` row with an inline editor and its own server source; a missing one is `warn` or
   `error` from the readiness service, never a client rule.
4. **Preflight & create.** `POST /api/products/sheet/publish-preview` on the prospective row set
   (the call `AliasPublishControl.tsx:79` already makes) → its answer becomes `ActionImpact`; the
   confirm level comes from the preflight, never a flag. The button is **`Create as draft`**, and
   the drawer states in the server's own words that the marketplace is not touched. **There is no
   publish step here** — publishing is report 06's flow, reached afterwards from the new band.

**Run.** One call — `POST /api/products/:id/aliases` for an additional listing, or a single
`PATCH /api/products/bulk` with the coordinate's `marketplaceContexts` for the first one (6.4). No
channel call of any kind.

**Repaint.** `ActionResult.invalidates` reloads the channel sheet (`reload()`,
`ChannelSheet.tsx:1848`): a new band appears at position N, its rows fully inheriting (`🔗`), pill
`Not listed` → `missing`/`ready` from the server's one readiness definition, the scope chip's
percent recomputed, `Publish ▾` becomes live for that channel. Nothing is added to Errors & Sync
unless the server refused.

**Keyboard.** `Enter` on the `[+ Add listing]` band row opens it; inside, `Tab` walks the Stepper's
completed steps, `Esc` cancels at every step, and the drawer returns focus to the band row.

**With the record drawer open.** The record drawer is `dock`/non-modal and stays beside the sheet;
this one is `variant="modal"` deliberately — creation is not reversible by `⌘Z`, and a cell edit
mid-flow would change what is being created after the operator read the preflight.

### 6.4 Per-scope rules

- **The create path is TWO paths, and only one is gated.** The **first** listing on a coordinate is
  the PRIMARY row (`aliasKey: ''`) and needs **no** PES.5-ii — the bulk upsert already creates it
  born `DRAFT` + `isPublished:false` (`products.routes.ts:2448-2473`, #235 verified it on eBay·DE).
  An **additional** listing is an alias and is dead until PES.5-ii drops the two legacy indexes.
  So the eleven "List on Amazon/eBay · market" link-outs D9 removed are **all** the first-listing
  case and can ship now; only "a second eBay listing of the same product" waits.
- **Master:** `HIDDEN`.
- **Amazon:** one offer per ASIN, so the additional-listing branch is `hidden` with that as its
  reason, and step 1 must state that **EU quantity is shared** across markets before creating a
  second market's listing. Images are global per ASIN, so step 3 never asks for them.
- **eBay:** the additional-listing branch is the real case (the shared-SKU model); policies are a
  step-3 prerequisite; a created row is `DRAFT` and **still a local record only** —
  `reference_ebay_draft_still_live` applies to anything with a push path, which this deliberately
  has none of.
- **Single-store channels (Shopify / Woo):** `aliasKey = ''`, one band, no additional-listing
  branch — and honestly so: `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'`
  (`products.routes.ts:1043`), so the write is *unreachable* there, not merely unimplemented. The
  verb renders `disabled` with that sentence until PES.5 widens the union.
- **An unadopted shell alias** is not a create target — it is an *adoption* (#18, blocked on
  PES.5-ii). The band already knows (`isUnadoptedShell`, `rows.ts:248`); the Stepper must refuse it
  by name rather than offering a second listing beside it.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** A created listing carries **no overrides** (`listing-alias.service.ts:118-126`),
  so every cell opens `🔗 inherited` and the operator pins only what differs. The Stepper's
  prerequisite values are the exception and they land **pinned at the channel/alias layer** — which
  is what they are. A preset must never write a value it did not ask about.
- **Autosave.** The create is NOT autosave: one confirmed call with its own endpoint. It must be
  `disabled` while `writer.pending > 0` with that as its reason, and the post-create `reload()`
  must run after the in-flight PATCH settles — `reference_autosave_still_needs_a_nav_guard`, and
  the studio has already had an in-flight autosave undo an API revert.
- **Readiness.** One server definition (`services/pim/readiness.service.ts`); the Stepper's
  prerequisite list is the readiness `required` set for that coordinate, never a second client
  rule. `null` survives as `null`. #248's rule holds throughout: **no count on an unlisted
  coordinate until a create count exists.**
- **Publish.** Untouched and separate. A created listing is born `DRAFT` + `isPublished:false` so
  no outbound sweep can pick it up, and the first send goes through report 06's preflight-first
  alias verb with the mode from `getEbayPublishMode()` / `getAmazonPublishMode()`. The three verbs
  then read as one family on the band: **`+ Add listing…` (34) · `Copy listing setup to…` (12) ·
  `Publish this listing…` (06)**.

### 6.6 ASCII mockup

```
CHANNEL SHEET — eBay · DE                                     [Publish ▾]  autosave ✓
┌──────────────────────────────────────────────────────────────────────────────────────┐
│           ┌───────────────────────────────────────────────────┐                      │
│           │  ○  Not listed on eBay · DE                       │                      │
│           │     Nothing exists on this coordinate yet. This   │                      │
│           │     product is on Amazon·IT and eBay·IT.          │                      │
│           │     4 fields are required before it can be sent.  │                      │
│           │                 [ + Add listing ]                 │                      │
│           └───────────────────────────────────────────────────┘                      │
└──────────────────────────────────────────────────────────────────────────────────────┘

CHANNEL SHEET — eBay · IT (already listed)
│ ▾ ① GALE Pro Racing Suit        ACTIVE 1103…  ⚠71% ▓▓▓▓▓░░  ⋯                        │
│   ├ GALE-KAN-PRO-48   🔗Giallo  48   ✎ €489.00   12                                  │
│ ▸ ② Summer title test           DRAFT   —      ○—          ⋯                          │
│ ┌ + Add listing ──────────────────────────────────────────────────────────────────┐   │
│ │ ⛔ A second listing needs PES.5-ii — the pre-alias unique indexes are still in   │   │
│ │    place, so the row would violate them. (server: alias_creation_blocked)       │   │
│ └────────────────────────────────────────────────────────────────────────────────┘   │

DRAWER (modal, 640px) — Add a listing on eBay · DE
 ①Scope & variants ─── ②Preset ─── ③Prerequisites ─── ④Preflight & create
 ③ Category      Motorradbekleidung › Anzüge (57998)         ✎ set here
   Policies      Payment ✓ · Shipping ✓ · Return ⚠ not set   ⚠ required to list
   Identifiers   EAN present on 18 of 20 SKUs                ⚠ 2 need an exemption
   Variation     Colore × Taglia (from master axes)          🔗 inherited
 ④ 18 sendable · 2 blocked · created as DRAFT — eBay is not contacted
                                        [Cancel]  [Create as draft]
```

## 7. Contracts and data

| piece | reuse or new | lane |
|---|---|---|
| `POST /api/products/:id/aliases` (additional listing) | **reuse as-is** (`product-studio.routes.ts:752`) | PES.5 |
| First-listing create via `PATCH /api/products/bulk` + `marketplaceContexts` | **reuse** (`products.routes.ts:2448-2473`) | PES.5 |
| `POST /api/products/sheet/publish-preview` as the Stepper's step-4 preflight | **reuse** | PES.5 |
| A **capability read** so the band row can be `disabled` BEFORE the press — e.g. `aliasCreation: {enabled, reason}` on the existing channel-sheet response | **new field, additive** | PES.5 |
| `marketplaceContexts[].channel` widened past `'AMAZON' \| 'EBAY'` | server change | PES.5 |
| eBay `connectionId` accepted on the create (MAP.4) | server change, additive | PES.5 |
| `ContextAxis` += `'channel-scope'`; `+ Add listing…` declared once in the registry | new | PES.2 |
| The `[+ Add listing]` band row at group end; the band `⋯` (does not exist yet) | new | PES.3 |
| Empty-scope `EmptyState` replacing the grid, and removing the fabricated chips | new | PES.3 |
| The Stepper drawer (4 steps, `Drawer variant="modal"` + `Stepper`) | new, DS components only | PES.3 (+ PES.4 if it lands as a drawer pane) |
| `GET /api/wizard-templates` reused for the preset step; library stays at `/settings/ai` | reuse | PES.3 |
| Header `Publish ▾` items routed to this flow on unlisted coordinates | change | PES.1 |
| `/products/next` "List on…" selection verb | new, wave-2 | AG.1 |
| **No new Prisma model.** `ProductListingAlias` + `ChannelListing` are the store; `ListingWizard`/`WizardTemplate` are read-only legacy (templates keep being read) | — | — |
| PES.5-ii migration application (2 `DROP INDEX`) | **exists, parked** | PES.5 + Owner |

## 8. Risks and traps

1. **Local dev writes the PRODUCTION database** and every eBay listing in the fixture family is
   LIVE. A create rehearsal makes a real `ChannelListing` row. Rehearse on a fixture family, name
   the row, and clean up **by value** — `reference_clean_up_by_value_not_by_row`.
2. **The three stale "NOT_IMPLEMENTED" statements (defect 1).** Anyone sizing this from
   `TECH_DEBT.md:1216` will believe the old Submit is inert; it is not. Fix the docs before anyone
   reasons from them.
3. **PES.5-ii is a rolling-deploy sequence, not a switch.** The pending SQL's own verification step
   is *"expect: every container on the new build"*; applying it early breaks the old container with
   `42P10`, and `reference_migrate_deploy_drags_parked_migrations` says a parked folder can be
   dragged in by a deploy. The additional-listing branch must degrade honestly, not assume.
4. **`/drafts/bulk-delete` hard-deletes Products (defect 4).** Do not touch it while retiring the
   wizard; anything that reduces the drafts list must not route through it.
5. **AI must stay dark (#13).** Do not port `/ai-complete-all`, `/suggest-*` or `/score-quality`
   into the Stepper. The preset step is a *stored* template, not a generation.
6. **Amazon EU shares quantity; images are global per ASIN.** Creating a second Amazon market is
   not creating a second inventory pool, and the Stepper must say so before the create, not after.
7. **Per-channel oversell.** A new listing on a coordinate adds a channel that draws on the same
   stock; oversell is per-channel, never summed — the Stepper must not display a total.
8. **Untouchables.** The flat-file editors, FBA quantity logic and the existing import flows are
   not touched; `ProductsWorkspace.tsx:1181`'s `EBAY_LISTING_SHELL` label and the shell-aware
   flat-file paths stay exactly as they are until #18's adoption runs.
9. **A create that half-lands.** `createAlias` is transactional (`listing-alias.service.ts:105`);
   the bulk-PATCH first-listing path is not a transaction across contexts. Assert the read-back,
   and remember `reference_transport_failure_write_is_unknown_outcome` — a `000` may still commit.

## 9. Open questions for the Owner (max 3)

1. **Ship the first-listing create now and the additional-listing (alias) branch after PES.5-ii?**
   *Recommended: yes.* The eleven link-outs D9 removed are all first-listing; that path is
   ungated and already proven (#235). The alias branch renders `disabled` with the server's own
   sentence until the migration lands — honest, and it makes 34 shippable without waiting on a
   rolling deploy.
2. **Does the old `/products/:id/list-wizard` route stay reachable (unlinked) for existing DRAFT
   wizards, or do we cut it at swap?** *Recommended: stays, unlinked, read-only-ish, with a
   labelled "Legacy wizard drafts" section on `/products/drafts`, until the DRAFT count drains via
   the existing 30-day cron.* Cutting it discards operator work in an untested JSON shape; building
   a migrator writes prod data through 19.5k untested lines.
3. **Widen the action registry's `ContextAxis` with `'channel-scope'`?** *Recommended: yes.*
   Creation's subject is the coordinate, not a family and not an alias group; forcing it onto
   `alias-group` is the exact one-level-up mistake ruling #114 created the axis to prevent.

## 10. Effort and dependencies

| piece | size |
|---|---|
| `EmptyState` on an unlisted scope + removing the fabricated chips (closes #235's flag) | **S** |
| `[+ Add listing]` band row at group end + the capability read that disables it honestly | **S** |
| `ContextAxis` += `'channel-scope'` and the verb declared once in the registry | **S** |
| The 4-step Stepper drawer (scope/variants · preset · prerequisites · preflight) | **M** |
| Step 3's prerequisite editors (category tree, eBay policies, GTIN exemption) — the only genuinely new sub-editors | **M–L**, shared with reports 03 (category) and 04 |
| eBay `connectionId` on create (MAP.4) + Shopify channel union widening | **S** each, PES.5 |
| Header `Publish ▾` routed to this flow | **S**, PES.1 |
| Repointing the 8 non-studio entry points | **M** |
| `/products/next` "List on…" selection verb | **M**, wave-2 |

**Dependencies.** The alias branch → **PES.5-ii** (parked migration + a rolling-deploy window) and,
downstream of it, #18 shell adoption. The band `⋯` and the `CONTEXT` axis are shared with **report
06** (`Publish this listing…`) and **report 12** (`Copy listing setup to…`) — the three verbs must
land as one band strip, or the band gets three different affordances. Step 3 shares its category
picker with **report 03** and its aspects/attributes with **report 04**. The preflight is **report
16**'s. Nothing here needs the images lane (PES.7) — images are cells after the listing exists.
