# Market-specific features in the Product Edit Studio — placement design (for the Owner's approval)

**Status:** DESIGN FOR APPROVAL. Nothing built, nothing committed. 2026-09-05.
**Method:** 34 read-only research agents, one per market-specific feature of the old edit page (eBay ×12,
Amazon ×12, cross-channel ×10). Each read the old UI, the API, the Prisma schema, the studio as built,
the parity audit and the hub rulings, and wrote a 450–590-line report to
`docs/market-features/NN-*.md` (path in §11). Every claim below cites a report; every report cites
`file:line`. No server was started, no browser opened, no row written.
**Answers:** hub ruling #105 D1 ("where do the 22 per-listing channel operations live?" — undecided, research
ordered) and the Owner's question of 2026-09-05: *"we have not yet built any toolbar … do we integrate it
directly in the description cell of eBay, or with the images section, or how does it actually work?"*

---

## 0. The answer in one paragraph

**There is no "market features toolbar", and there should not be one.** Every one of the 34 features
decomposes into things the studio already has a place for: a **value** the operator sets (a cell), a
**fact** the channel reports (a read-only status column), an **operation** on a listing (a verb on the alias
band, declared once in the action registry), **depth** (a section or pane in the record drawer), **media**
(the Images tab), a **queue** (the Errors & Sync tab), or **account-level config** (a page outside the
studio, with the studio holding only the assignment). The eBay description theme is the clearest case: the
description cell keeps holding the operator's body copy; the theme is a *neighbouring select cell on the
alias band* (the column already exists, read-only); the "as eBay renders it" preview is a drawer pane; "push
description only" is a band verb; and the theme *library* lives outside at `/channels/description-themes`.
eBay images stay in the Images tab because a photo's identity is (bucket, position), not (row, field) —
the sheet gets one derived "photos" column and one "image axis" cell. The toolbar changes only by gaining a
few scope-level verbs in the `leading`/`trailing` slots it already has, and view chips it already renders.

The 34 reports converged on this without coordination, which is the strongest evidence the grammar in §2
is right. They also found the same **backend defect underneath a dozen of them**: the studio's channel write
route lands channel values in `overrideData`, a bag nothing reads (§5, D-D). That, plus three ungated
live-marketplace image publish paths, is what "it all feels bugged" is.

---

## 1. What the old features actually are (the census)

| # | feature | old surface | what survives (capability, not code) |
|---|---|---|---|
| 01 | eBay description themes | Description Studio drawer on the flat-file page | theme assignment per market row · themed preview · push-description-only · staleness |
| 02 | eBay images | Images tab eBay panel | bucket × position grid · exclusive buckets · axis · verbatim publish |
| 03 | eBay category | cockpit card + 3-mode modal | category as the key that selects the aspect column family |
| 04 | eBay aspects | cockpit AspectsCard | one column per aspect (AM.1, approved) — chip cells for MULTI |
| 05 | eBay policies + offer | cockpit PricingPoliciesCard | payment/return/shipping ids · best offer · duration as cells |
| 06 | eBay publish / snapshot / restore | PublishDrawer + VersionHistoryDrawer | preflight-first publish · snapshot on publish · restore to DRAFT |
| 07 | eBay field-source / lock / undo | field-source system | per-cell provenance already replaces source; LOCK and restore-a-value are the lost halves |
| 08 | eBay compatibility | CompatibilityCard | fitment sub-table (rows of leaves) |
| 09 | eBay AI improve | AiImproveModal | draft → review → apply, dark (#13) |
| 10 | eBay pull + live preview | Pull button, EbayLivePreview | check the channel · adopt a diff · sandboxed themed preview |
| 11 | eBay realtime | SSE hook + toast | "changed elsewhere" mark · live count in Errors & Sync |
| 12 | eBay apply-to-siblings / shared listings | ApplyToSiblingsModal | copy listing setup to other aliases/products |
| 13 | Amazon images matrix | Images tab Amazon panel (built in studio) | colour × slot matrix · per-market · mirror · export ZIP · feed |
| 14 | Amazon A+ / Brand Story | AplusCard | A+ state per ASIN × market · attach · link-out |
| 15 | Amazon product type / browse nodes / schema alerts | CategoryCard + SchemaChangeBanner | product type select with confirm · browse-node chip cell · schema-changed chip |
| 16 | Amazon preflight + publish | PreflightPanel + PublishCard | ONE publish flow: preflight · payload · mode · result |
| 17 | Amazon suppressions / issues / recovery | SuppressionCard + /recover page | suppressions + listing issues as Errors & Sync sources · recover verb |
| 18 | Fulfilment FBA/FBM | FulfillmentCard + MatrixTab toggle | select cell + Available column + Set fulfilment verb |
| 19 | Amazon pricing / buy box | PricingCard | Offer column group · buy-box status columns · Refresh buy-box |
| 20 | Compliance (GPSR, hazmat, PPE, certificates, fit) | ComplianceCard + ComplianceTab | scalars as cells · protectors + certificates in a drawer pane |
| 21 | Amazon apply-to-siblings + template vault | ApplyToSiblingsModal + flat-file vault | copy channel setup verb · vault stays outside |
| 22 | Variation matrix by market | VariantCube | Markets pane in the drawer · broadcast made real |
| 23 | Amazon live PDP preview | AmazonLivePreview | ONE preview pane shared with eBay (four real blocks, no mock chrome) |
| 24 | Amazon pull from channel | Pull + ImportFromAmazonModal | the same `Check the channel` verb as eBay, SELECTION-led (Amazon's unit is the child SKU, N calls) · adopt onto the channel only, with a snapshot first · `ImportFromAmazonModal` dropped, its capability re-homed to `/channels/mapping` |
| 25 | Channel pricing rules + qty | pricing panel + MatrixTab bulk modes | price/sale/qty cells · % adjust + copy-from-market verbs · strategy cell |
| 26 | Replicate to markets + broadcast | replication panel + per-field broadcast menu | broadcast = the focused column to N markets (verb exists, disabled by an empty `siblingMarkets`) · replicate = a toolbar verb beside Import reusing the live import diff→apply→revert pipeline |
| 27 | Translation / locales | LocalesTab + translateAll | Locale source + Reviewed columns · mark reviewed · add/delete locale · translate = DRAFT |
| 28 | Auto-publish + sync policy + queue | toggle + Errors & Sync | auto-publish cell on the band · Sync column · pause verb · retry/drop |
| 29 | Cross-channel image planner | CrossChannelSyncBar + modal | planner (built) reachable from `Publish ▾` and the alias band, not only after picking a scope · "Copy images from…" as ONE registry verb replacing eight fixed buttons · an `Images` status column per channel scope |
| 30 | Shopify images | ShopifyPanel | DEFER the grid (0 rows anywhere); ship gate + honest disabled chip |
| 31 | Live channel images / drift | LiveChannelStrip + drift modal | folds into ONE Channel check column · adopt = channel baseline |
| 32 | Image publish machinery | schedule / approval / rollback / history | a sticky Publish rail on the Images tab (Health · History · Schedule · Settings) · image jobs as an Errors & Sync source · server-backed restore points · approval queue dropped |
| 33 | Cascade to channels + field links | CatalogCascadeDrawer | Push master changes to channels (family verb) · Link identical values |
| 34 | List on channel | ListOnChannelDropdown + list-wizard | `+ Add listing` on the band · four-step Stepper · first listing now, alias after PES.5-ii |

---

## 2. The placement grammar (the rule that decides where any feature goes)

Answer these in order; the first "yes" wins. Every feature in §3 was placed with exactly this.

1. **Is it a VALUE the operator sets on a row or a listing?** → **H1, a cell**, edited in place through the
   ONE `SheetWriter`. A *listing-level* value (theme, category, policies, auto-publish, image axis,
   compatibility mode) lives on the **alias band row** and renders `writable:false` on every variant row
   beneath with the server's sentence ("eBay carries this on the listing, not the variation — edit it on the
   ① band row"). This needs a third column scope, **`per_listing`**, the mirror of `per_variant` (05, 01, 28).
   Options for closed lists come from the account snapshot (policies), the channel cache (categories,
   browse nodes) or the theme table — the operator *assigns*, never authors (05).
2. **Is it a FACT the channel or the pipeline reports?** → **H2, a read-only derived status column** with a
   glyph, a tooltip naming the source, filterable, never an editor, never in the fill handle, plus a view chip
   where the count is actionable. Honest-count rule everywhere: `count: null` = "not checked", never `0`
   (17, 14, 10, 31).
3. **Is it an OPERATION?** → **a verb in the action registry, declared once, rendered on the row menu, the
   ⋯ column, the selection bar and the drawer** (ruling #110). Scope follows the *subject*:
   - the subject is a **listing** → `CONTEXT(alias-group)` on the alias band's ⋯ and an `AliasVerbs` bar in the
     channel `SheetToolbar.leading` (publish, restore, check the channel, push description, copy listing setup,
     apply fitments, pause sync, recover, publish images, export image files);
   - the subject is the **family** → `CONTEXT(product-family)` on master's family bar (push master changes to
     channels, variation theme & axes);
   - the subject is a **coordinate** with no listing yet → a new axis **`channel-scope`** (`+ Add listing…`;
     report 34 found the registry has no axis for it and forcing `alias-group` is the #114 mistake);
   - the subject is **rows or cells** → `ROW` / `SELECTION` (dismiss suppression, attach A+, freeze, mark
     reviewed, adjust prices %, copy prices from market, copy value to markets, draft with AI, refresh buy-box,
     link across markets, set fulfilment, restore this value); freezing needs a **`CELL`** scope (07);
   - the subject is the **whole scope** → `SheetToolbar` `trailing`/`leading` (translate this coordinate,
     add/delete locale, refresh policies, preview listing, check with Amazon, refresh what's live).
   Order is always COLLECT → PREFLIGHT → CONFIRM → RUN; the confirm level comes from the preflight's
   `ActionImpact`, never a flag; a live target escalates to type-to-confirm with a real phrase (the channel or
   the ItemID/ASIN/SKU), never the word DELETE.
4. **Is it DEPTH — a structured sub-editor, a history, a preview?** → **H7, the record drawer** (non-modal,
   520px, sheet stays live). Prefer a **section inside an existing pane** over a new pane (§4.3); a new pane
   only for a shape nothing else can hold. A verb must never live only in the drawer.
5. **Is it MEDIA?** → **H8, the Images tab**, on the media substrate; the sheet holds a derived column only.
6. **Is it QUEUE-shaped — many rows, triaged by cause?** → **H9, Errors & Sync**, which gains a **SOURCE axis**
   (§4.4). A queue must never be inline-only.
7. **Is it ACCOUNT-level config?** → **H11, a page outside the studio**; the studio holds the per-listing
   assignment and a link-out (theme manager, policy defaults, pricing rules, A+ editor, template vault, sync
   control, wizard templates, Shopify locations, Brand Settings' Responsible Person).
8. Otherwise **H12, drop** — with the Owner's sign-off (§6).

Two cross-cutting honesty rules the reports kept hitting: **a disabled control explains itself** (reason on
screen, never only in a tooltip — 30's disabled Shopify chip; 34's `+ Add listing` while PES.5-ii is parked),
and **"never checked" is a state, not a green** (10, 31, 17, 14).

---

## 3. The map

Legend: **P** = primary home; mirrors after it. "At rest" = what the sheet shows before anyone clicks.
Effort is the report's own estimate.

### 3.1 Values → cells (H1)

| # | value | where the cell lives | at rest | mirrors | effort | blocked by |
|---|---|---|---|---|---|---|
| 01 | Description theme | eBay band row, `select` (column exists read-only, `ebay.ts:111`) | theme NAME, `Default (X)`, `None — raw body`, `⚠ Theme deleted` | H11 manager · H7 "Description on eBay" section · H5/H3 `push-description` (refused in wave 1) · H2 `Description sync` | S–M | phase-2 store (D-D) |
| 02 | eBay image axis | eBay band row, `select` over family axes + `__shared__` | `Colore` / `One shared gallery` | H8 grid reads it | S | — |
| 03 | eBay category | eBay band row, async lookup popup (Suggested · Matches · Recent · Browse…) | breadcrumb path, `⚠` when no cached schema | H7 tree/history section · H3 `pick-category` · H4/H5 `apply-category` · H2 `Category state` · H9 | M–L | phase-2 store; changing it re-projects the column set (controlled remount) |
| 04 | eBay aspects | eBay variant rows (axes locked on the band), one column each | scalar as today; MULTI = chips + `+N` | H7 existing "Item specifics" group · H2 `Item specifics 14/20` · H9 · H6 `Pull item specifics` (v2) | S→M | push drops MULTI values (`ebay-flat-file.routes.ts:2145,2513`) — fix together |
| 05 | eBay policies + offer | eBay band row, `Offer` group: Payment · Return · Shipping · Location · Best offer · Auto-accept/decline · Duration · Qty limit | policy NAME, 🔗 from account default / ✎ pinned; children locked | H7 Offer section (free via `RecordPane` groups) · H11 account default on connection settings · H6 `Refresh policies` | M | phase-2 store; `per_listing` scope |
| 15 | Amazon product type | EVERY row (per-row store), `select` with a preflighted CONFIRM ("14 columns replaced by 21; 3 holding values disappear") + "apply to the other N rows" | code + `hasSchema` tick | H7 Record pane detail · re-read of the column set after write | M | ruling #86 parks pickers until D1 is disposed |
| 15 | Browse nodes | Amazon rows, chip-list cell over `extractBrowseNodes` | `2 nodes` + first path | eBay/AI suggestion labelled by real source, never "AI" | S | — |
| 18 | Fulfilment | channel variant rows, `select` FBA·FBM (eBay: FBM·MCF), group Inventory | method + ✎/🔗 (derived vs set) | H2 `Available` · H4 `Set fulfilment…` (the only path with a preflight — fill handle has none) · H7 Inventory section | S–M | typed-column write route (`fulfillmentMethod` would land in `overrideData`) |
| 19/25 | Price · Sale price · Sale window · Qty | Amazon `Offer` column group on the channel scope; `Sale window` = ONE compound cell | money in market currency; qty read-only on FBA rows | H2 `Save %` · `Price source` · buy-box set · H7 Pricing section · H11 `/pricing` | M (+L: outbound sale_price) | `op:'replace'` on `purchasable_offer` wipes the sale price on Amazon; no push emits `sale_price`; `CHANNEL_FIELD_MAP` has no price/qty entry |
| 25 | Pricing strategy | channel rows, `select`: Manual · Match competitor · Cost-plus · <rule> | strategy name | H11 rule library | S | — |
| 25 | PERCENT_OF_MASTER | collapses into the FORMULA cell: `= $basePrice * 1.05`, ƒ at rest | — | — | S | — |
| 20 | Compliance scalars (PPE cat, garment class, NB no./name, DoC URL, hazmat class, UN no., HS code, origin) | master + channel (masterKey-linked) | as any cell | H6 `Compliance` preset + `GPSR missing (n)` chip | S | nine registry entries missing |
| 28 | Auto-publish content | channel band row, `Checkbox` cell; children locked | ✓/– + tooltip naming the policy chain | H2 `Sync` · H5 pause verb · H7 Sync section | S | no enqueue path from `PATCH /products/bulk` (§5) |
| 22 | Axis cells | master rows, re-routed to `variant-attributes` | axis values (band's second line finally fills) | — | S | — |

### 3.2 Facts → status columns (H2)

| # | column | scope | states | chip |
|---|---|---|---|---|
| 10+31+24 | **`Channel check`** — ONE column for fields AND images (both arrive in one channel response) | channel rows; band = `checked 2h ago` / `never checked` + `⚠ 3 differ` | `—` never checked · `✓ matches` · `⚠ N differ (3 fields · 2 images)` | `Drift (n)` |
| 28 | `Sync` | channel rows | queued · sent · failed · dead + last sent; `⏸` paused with reason; gated → `gateNote` sentence | — |
| 16/06 | `Publish` / `Last publish` | channel rows / off-by-default | Live · Ready · Missing · Errors · Not listed; band carries `⇧ 2 d ago · rehearsed` | `Never published` preset |
| 17 | `Amazon status` | Amazon rows + ⚠ on band | ACTIVE · ⚠ Suppressed — reason · Blocked · Not listed | `Suppressed (n)` · `Listing issues (n)` |
| 14 | `A+` | Amazon rows, per (market, locale) | — · ◐ draft · ↑ submitted · ● approved · ⚠ rejected · ? unread | `No A+ (n)` |
| 03 | `Category state` | eBay | ✓ · — none · ⚠ schema not cached · ⚠ drift vs eBay | — |
| 04 | `Item specifics` | eBay | `14 of 20 · 1 required missing` | — |
| 08 | `Compatibility` | eBay band | `Universal fit` · `42 vehicles` · — ; ⚠ only once eBay's `compatibilityEnabled` is cached | — |
| 13/29 | `Images` strip · `MAIN` · `Slots` · `Image sync` (13) — and 29's `Images` coverage cell `6/7 · MAIN missing · ⚠ drift · —` against `PLATFORM_RULES`, with 🔗/✎ from the existing vocabulary; the band's cell is the roll-up; master shows none | every channel scope | thumbnail strip; ● / ⚠ MAIN missing / ⛔ live-but-empty; `12/16`; queued · live · stale · drift | — |
| 02/30 | `ebayPhotos` / `shopifyPhotos` | eBay band / Shopify rows | `12 · 3 buckets` · ⚠ no cover · ⚠ 13→12 | — |
| 01 | `Description sync` | eBay band | ⚠ stale · ✓ in sync · ? unknown (reasons verbatim) | counted in `Warnings (n)` |
| 19 | `Save %` · `Buy box` · `BB price` · `Δ vs ours` · `BB checked` · `Repricer` | Amazon; buy-box facts on the BAND once, blank on variants | won · lost · `No observation` (#334) | — |
| 25 | `Price source` | channel | Sale · Offer · Override · Rule · Master · Fallback, `⚠ clamped` | — |
| 22 | `Markets` | channel rows, 92px | `n/m` markets holding a listing + how many tracked fields differ | — |
| 27 | `Locale source` · `Reviewed` | master × non-primary locale | ✎ Manual / ✦ model · ✓ date / ⚠ Unreviewed | `Unreviewed (n)` |
| 20 | `Certificates` | master | `3 valid · CE exp 12/03/26` | `Compliance (n)` |
| 18 | `Available` | channel | resolved qty from the roll-up + pool, ⚠ oversold | `Oversold (n)` |
| 11 | `⟳ changed elsewhere` | any, on the identity cell | mark only; footer note carries the count | — |
| 15 | `Schema changed (n)` | chip on master + Amazon; mark on the scope chip | — | ✓ |
| 33 | 🔗 `linked` | fix `classifyProvenance` so `linked` is its own member | — | `Link suggestions (n)` |
| 12 | `pool_sync` | eBay variant rows (shared listings) | follows pool · paused (+N buffer) | — |

### 3.3 Operations → verbs (registry, declared once)

| # | verb | scope | preflight → confirm | wave-1 run |
|---|---|---|---|---|
| 06/16 | `Publish this listing…` | `CONTEXT(alias-group)`; mirrored by header `Publish ▾` (a router, never a second send) and `SELECTION` "just these variants" | `publish-preview` → verdicts per row; **Payload** table (fields being sent, with provenance — closes 3.14n); mode from the server; type-to-confirm when live | Amazon: **Rehearse (dry run) only** (D8 holds); eBay: the Send step renders the server's refusal verbatim |
| 06 | `Restore this listing…` | alias-group + SELECTION | field-level diff view; whole-snapshot write | lands in DRAFT and sets `syncPaused` (the flag the eBay push honours) |
| 10/31/24 | `Check the channel` (one id, both channels) | eBay: alias-group leads (one `GetItem` per ItemID); Amazon: SELECTION leads (`getListingsItem` is keyed by seller SKU, so a family pull is N calls and the confirm prices them) + ROW + alias-group | ONE call fetches fields + images, persists the snapshot, returns the diff; findings are **checkable** — untick all = "just record the check" | adopts only fields with a real destination; aspects read-only until their columns exist |
| 24 | `Adopt master for selected cells` (the bulk form of the existing per-cell reset) | SELECTION | local preflight, no marketplace call; on a variant row clears BOTH the aliasVariant and the alias layer and says so | one bulk PATCH with `intent:'reset'` |
| 31 | `Adopt live images` | H8 truth panel + alias band | `dryRun:true` as the preflight | writes the per-market channel baseline, never the master gallery |
| 01 | `Push description only` | alias-group | staleness + preview per family; Lane A rows named as "Full Publish is the safe path" | refused in wave 1 (no request-level dry run exists) |
| 12 | `Copy listing setup to…` | alias-group (in-sheet aliases wave 1; other products wave 2 via `EntityPicker`) | per target × field `previous → next`; live target → type-to-confirm | snapshots each target under one `batchId`; undo-all in Errors & Sync |
| 21 | `Copy this Amazon setup to…` | alias-group + SELECTION; **not** on `/products/next` (no donor) | D15.13 diff shape; `pins` flag shown | one `BulkOperation` row = the restore point |
| 08 | `Edit compatibility…` · `Import fitments (CSV)…` · `Copy fitments to…` · `Clear fitments` | alias-group | import previews and NAMES rejected rows; clear ≥40 rows → type-to-confirm | — |
| 28 | `Pause / resume sync` | alias-group beside `offer-toggle` | states which of three levers is in force; renders `skippedFba` | — |
| 17 | `Recover this listing…` | alias-group (folds the `/recover` page in) | `POST /recover/preview` = the consequence panel; cooldown risk → type-to-confirm | opens the wizard URL in a new tab |
| 17 | `Dismiss suppression` | ROW + SELECTION (a whole GPSR wave at once) | warns when other episodes stay open | — |
| 14 | `Attach A+ document…` · `Detach` · `Open A+ editor ↗` | ROW + SELECTION | "12 of 13 ASINs; 1 has no ASIN; 3 already have it" | needs a new attach/detach endpoint (none exists) |
| 07 | `Freeze <field> on this row` / `Freeze fields…` | **CELL** (new) + SELECTION | none / confirm naming what a freeze refuses | server-enforced in `PATCH /products/bulk` |
| 07 | `Restore this value` | History pane row (the one verb that IS drawer-only, because a history entry exists only there) | CAS on the value; a frozen cell refuses | normal `SheetWriter` write, audited |
| 25 | `Adjust selected prices by %…` · `Copy prices from market…` · `Set price…` · `Set listed qty…` | SELECTION | server-computed `old → new` per cell; refusals by cause; −30% on 400 cells → type-to-confirm | revert via the D14.4 toast |
| 19 | `Refresh buy-box` | ROW + H6 trailing (coordinate-level call) | "asks Amazon for offers on 7 ASINs, reads only" | `POST /pricing/refresh-competitive` |
| 18 | `Set fulfilment…` | SELECTION | pool each row moves to; oversell; FBA guard verdict; EU region-wide | `PATCH …/fulfillment` batched |
| 09 | `Draft with AI…` | SELECTION + H6 `leading` | `estimate` (spends nothing) → cost shown | **refused honestly** (ruling #13); review = existing `✦ AI drafts (n)` chip |
| 27 | `Mark reviewed` · `Translate selected` | ROW + SELECTION | coverage endpoint | translate DRAFTS, never writes |
| 27 | `Add locale` · `Delete locale` · `Translate this coordinate` | H6 trailing beside the locale switcher | delete with `fieldCount > 0` → type-to-confirm | — |
| 33 | `Push master changes to channels…` | `CONTEXT(product-family)` on master + SELECTION pre-filled | Stepper: where · what (default = fields that `follow`) · language (OFF, #13) → per-coordinate diff | queued jobs → Errors & Sync; 30 s undo |
| 33 | `Link identical values across markets…` | SELECTION inside ONE column | cluster pre-ticked from suggestions | — |
| 34 | `+ Add listing…` | **`channel-scope`** (new axis) on the band strip + `EmptyState` CTA; header `Publish ▾` routes here when unlisted | four steps: scope & variants · preset · prerequisites · preflight → **Create as draft** | first listing now; alias branch `disabled` with `AliasCreationBlockedError.message` until PES.5-ii |
| 03 | `pick-category` · `apply-category` | ROW + SELECTION + alias-group | columns gained/lost, values orphaned (named) | — |
| 13/02/30 | `Publish images` · `Export image files` | alias-group; `Publish ▾` lists images as a **named destination** per coordinate (different feed) | validate + readiness held separately; blocked/deletes → type-to-confirm | `dryRun` honoured |
| 26 | `Copy <field> to markets…` (the existing `broadcast-to-listings`, re-unit'd to the FOCUSED COLUMN) | ROW + SELECTION; the channel scope gains the selection bar master already has | picker shows each market's current value + layer; `error` for a column absent from that market's schema or a single-store coordinate; live alias → type-to-confirm | ONE bulk PATCH with `marketplaceContexts`, no `expectedVersion`, after `writer.flush()`; review in the drawer's Compare pane |
| 26 | `Replicate this coordinate to markets…` | H6 `trailing` beside Import (the subject is the scope, not an alias) | two steps: targets + field groups (old modes = presets over the contract's groups; qty/images/price excluded and said so) → the EXISTING import diff (`computeImportDiff` already reads one sheet per coordinate) | `storePreview → apply` with the import pipeline's own refusals and **revert**; the market switcher gets a "changed" dot on every market written |
| 29 | `Copy images from…` (replaces the sync bar's eight fixed buttons) | alias-group + SELECTION + ROW; rendered as the Images tab's own bar through `menuAdapters` | `Listbox` of legal sources (Master · Amazon·IT · Amazon all markets · eBay·IT) + `gallery / colour sets / both`; preflight returns `wouldAdd / wouldSkip / wouldOverwrite / lockedSkipped`; overwriting pinned rows → type-to-confirm | one server transaction filed through the `SaveReporter` — the staged `pendingUpserts` limbo is retired |
| 29 | `Publish images → channels…` (the built planner) | H8 primary; **three doors**: `Publish ▾` (a Modal over the sheet), the alias band verb pre-ticked to that alias, the Images tab in place | per-target coverage from a new server preflight incl. eBay/Shopify `PLATFORM_RULES`; type-to-confirm when any selected gate is open; Amazon's eleven markets as ONE card by default | sequential per target; eBay/Shopify **refused on screen with the reason** until their gates exist (see §5 #2/#3) |
| 32 | `Restore images to…` | alias-group + SELECTION | report 06's snapshot shapes (`pre-publish` · `pre-restore` · `manual`), coordinate-level diff, un-gradeable entries listed and not selectable | a server-written restore point captured INSIDE the publish path (`requestPayload` already half-built); localStorage dropped |
| 32 | `Retry image job` | ROW on a History row + SELECTION; mirrored in Errors & Sync | the job's own receipt; level from the publish mode (rehearsal → confirm, live → type-to-confirm with the SKU) | eBay/Shopify have no rehearsal — `sideEffects` says so in the server's words |
| 11 | `Reload (n changed)` | H6 through `reloadImpact()` | — | — |
| 23/10 | `Preview listing` | ROW + alias-group + H6 trailing; no preflight, no permission gate | — | opens the drawer's Preview pane |
| 05 | `Refresh policies` | H6 trailing | — | `refresh=1` on the account snapshot |
| 17 | `Check with Amazon` | H6 trailing | — | `preflight?live=1`, non-mutating, populates `ListingIssue` today |

### 3.4 Depth → drawer (H7) — see §4.3 for the pane/section rule
Sections inside the **Listings pane** (rename: **Channel**): Description on eBay (01) · Offer (05) · A+ & Brand
Story (14) · Channel says — suppressions, issues, recovery timeline (17) · Sync (28) · Pricing chain (19/25) ·
Inventory per market (18) · Images (02/30) · shared-listing members (12) · **Markets** table — rows =
coordinates, ≤4 fields, per-cell edit (22).
Modes in the **History pane**: field history (exists) · record restore (exists) · **Publish history** with
field-level diff (06) · **Restore this value** button on rows with a recorded previous (07).
**New panes** (scope-conditional): **Preview** — one pane for eBay and Amazon, `Page | Payload` sub-views,
Desktop 920 / Mobile 375, four real blocks, never invented chrome (10, 23); **Compatibility** — eBay only,
bounded `NexusGrid` sub-table with `Modal size="xxl"` escalation (08); **Compliance** — master, protectors +
certificates sub-tables (20).

### 3.5 Media → Images tab (H8)
Amazon matrix (13, built), eBay bucket grid (02, built), Shopify pool + assignment (30, **deferred** until a
store is connected — 0 rows across 37 products), channel truth panel generalised to all three (31),
cross-channel planner (29, built; gains the server preflight it lost and refuses ungated eBay/Shopify targets on screen) and the **Publish rail** (32): a 320px sticky right rail beside the matrix with four collapsible blocks — Health · History · Schedule (disabled-and-explained until the cron has an atomic claim and a cluster lock) · Settings — plus `⟲ n` and a three-state publish word (`Images sent 2h ago` / `Never sent` / `Sent, outcome not recorded`) on the alias band, and an off-by-default `Images sent` status column.

### 3.6 Queues → Errors & Sync (H9) — see §4.4
Sync queue (exists) · Suppressions · Listing issues (17) · Publish attempts (06/16) · Image jobs, stale, drift
(13, 31, 32) · Schema changes (15) · Certificate expiry (20) · Propagation jobs (33) · Copy-setup results (12,
21) · Category problems (03) · Aspect problems (04).

### 3.7 Outside the studio (H11) — the studio holds the assignment + a link-out
`/channels/description-themes` (01, to build) · eBay policy defaults on the connection settings page (05, to
build) · `/pricing` rules (19/25) · `/marketing/aplus` (14) · Amazon template vault + `/channels/amazon/
templates` manager (21) · `/fulfillment/stock/sync-control` (28) · `/settings/ai` wizard templates (34) ·
Brand Settings Responsible Person (20) · `/channels/mapping` (04's aspect↔master rules, 33) · `/products/stranded`
(17, a catalogue report, not this feature).

---

## 4. What the frame needs once, so every feature can plug in

### 4.1 Action registry (PES.2, substrate)
- `ContextAxis` gains **`'channel-scope'`** (34). `ActionScope` gains **`CELL { row, colId }`** with
  `p.column` forwarded through `menuAdapters` (07).
- An **`AliasVerbs`** bar in the channel `SheetToolbar.leading` (free slot), the twin of master's
  `FamilyVerbs`, rendering `CONTEXT(alias-group)` verbs; the band's ⋯ is its second adapter (12, 06, 33).
- `AliasPublishControl` leaves the `trailing` slot (rendered N times today) and becomes the band verb (06, 16).

### 4.2 ONE publish flow (PES.2 shell · PES.3 verbs · PES.5 server)
DS `Drawer variant="modal" width≈640–720` + DS `Stepper`: **1 Preflight** (verdicts per row, optional
"Ask Amazon to validate" = `live=1`, operator-pressed, one alias at a time) · **2 Payload** (every field that
would leave, resolved value, provenance mark, `shared` marker for EU qty / global images; unreviewed ✦ drafts
listed and excluded) · **3 Mode** (server's `gateNote`, Rehearse toggle, type-to-confirm when live) · **4 Result**
(server's words; "queued", never "published"; written as an H9 job row polled by the cron, not the tab).
Entered from the band verb, header `Publish ▾` (per coordinate; images as a second named item) and the
selection bar. The **Payload table is one component** also mounted in the Preview pane (23 Q3).

### 4.3 Drawer budget (PES.4)
Four panes today in 520px. Rule: **sections inside Listings/History first; a new pane only for a shape
nothing else holds.** Result: Record · History (3 modes) · Compare · Channel (sections above) · Preview
(channel scopes) · Compatibility (eBay only) · Compliance (master only) — never more than **six tabs on any
one scope**. Report 31 is right that a seventh is the #169 chrome cost; report 22's Markets table lives as a
section, not a pane.

### 4.4 Errors & Sync gains a SOURCE axis (PES.7/channel-ops owner + PES.5)
A DS `SegmentedControl` of sources above the facet row — `Sync queue (2,553) · Suppressions (—) · Listing
issues (—) · Publish attempts · Image jobs · Drift · Schema changes · Certificates · Propagation` — each with
its **own facets** (Dead/Retrying/Stuck stay bound to the queue), the existing `groupByCause`, jump-to-row, and
`—` for an unqueried source (never `(0)`). `DORMANT_SOURCES` (`syncQueue.ts:296`) already names the first two
tables. Retry/drop become registry verbs; retry is preview-first (#127).

### 4.5 ONE `Channel check` (PES.3 + PES.5 + PES.7)
One column, one `checkedAt`, one `channel-check` verb for fields AND images, with `unreadable[]` mandatory
(401 / 429 / `API_DISABLED` / `NO_CREDS` rendered as words, never as an empty channel) (10, 31, 24).

### 4.6 Realtime (PES.1 + PES.5)
Gate both SSE routes with a `preHandler` first (they are unauthenticated). Then **widen the one existing
studio stream** (`contracts.tsx:494`) with a version-carrying payload (`version` + `versionOf`); repaint an
untouched row silently, mark a pending/refused one, footer note above five rows; a 20 s conditional version
poll only when the stream is down, stated in the footer. Header `Pill`: `Live` / `Reconnecting` /
`Not live (local)`. Drop the 30 s toast (11).

### 4.7 New DS components — six, each reused by ≥2 features (PES.2 / DS lane)
| component | first user | reused by |
|---|---|---|
| `LookupCombobox` + `LookupPanelEditor` (async remote search, grouped sections, loading/error, footer action) | 03 eBay category | 15 browse nodes · 05 policies · 01 theme · 34 product types |
| `ChipListCell` + `ChipListEditor` (strict `MultiSelect` · open + "use what I typed" · free `TagInput`) | 04 MULTI aspects | 15 browse nodes · 20 `dg_hz_regulation` · every AM.1 list-shape column |
| `EntityPicker` (Modal + search + virtualised rows + multi-select + "N of M · max K") | 21 copy setup | 12 cross-product · `attach-existing` · 26 market picker |
| `SandboxedHtmlFrame` (`sandbox=""` + `srcDoc`, scale stated) | 10 eBay preview | 23 Amazon preview · 01 theme preview |
| `MediaStripCell` (N faces + `+N` at text-row height) | 13 Amazon `Images` column | 02 eBay · 30 Shopify |
| `PriceTrendChart` (or additive `series[]` on `PerformanceGraph`) | 19 pricing history | 25 |
Plus three additive props: `ListboxOption` second dimmer line (05), `ScopeBar.disabledNote` rendered as a
`Banner` in the scope row (30), `GridSheetNote kind="foreign"` (11/28 share one footer slot).

### 4.8 Server contracts that recur (PES.5) — the shortlist
`attr_* + target:'channel'` honours the column's **declared store** (D-D) · `scope: 'per_listing'` on
`SheetColumn` (server type and client mirror in ONE write) · `ChannelListing` snapshot capture on every
outbound push · a `publish-preview` **payload projection** · `channel-check` preview/apply · `GET
/api/products/:id/studio/listings` (all coordinates, one read) · `GET …/studio/versions` (poll fallback) ·
capability read for `AliasCreationBlockedError` · `POST /api/aplus-content/:id/asins` · `POST …/channel-pricing/
preview` · six `CHANNEL_FIELD_MAP` entries for `{amazon,ebay}_{price,salePrice,quantity}` + follow flags ·
`SchemaChange` read · cardinality persisted on the eBay aspect cache · `ChannelPullRecord` audit.

---

## 5. What "it all feels bugged" is — defects the reports measured in code (fix before or with the feature)

Ranked by blast radius. Each is `CODE-READ` with `file:line` in the named report.

| # | defect | report |
|---|---|---|
| 1 | **Channel values written to `overrideData`, which nothing reads.** The bulk PATCH knows two channel stores (typed column, `overrideData`); eBay's store is `platformAttributes`, Amazon's is `platformAttributes.attributes` (107 keys on 725/725 listings). Policies, category, theme, fulfilment, copy-setup and AI aspect approvals would all return 200 and change nothing. | 05, 03, 01, 18, 21, 09 |
| 2 | **`POST /ebay-images/publish` reaches `api.ebay.com` with no `getEbayPublishMode()`, no `NEXUS_EBAY_REAL_API`, only `products:edit`** — while the studio shows an eBay gate pill that does not govern it; it also re-sends the description and can delete other markets' draft offers. | 02 |
| 3 | **Shopify image publish `PUT /products/{id}.json` replaces the store's whole image set** with no gate, breaker, limiter or audit, while `outbound-sync.service.ts:1833` applies all four to the same endpoint. | 30 |
| 4 | **Amazon publish "dry run" is a no-op** — `publish-amazon` short-circuits before the feed build, byte gate and VALIDATION_PREVIEW, and writes no `AmazonFlatFileFeedJob`, so the outcome dies with the tab. | 16 |
| 5 | `deleteListingsItem` reads `AMAZON_PUBLISH_MODE` directly, bypassing the master flag; `/api/listing-recovery` matches no route so the destructive delete falls to `products.edit`; the recover client uses relative URLs that 404 in prod. | 17 |
| 6 | **Price push `op:'replace'` on `purchasable_offer` wipes the sale price on Amazon**; no push emits `sale_price`; `BuyBoxHistory` has zero prod rows. | 19 |
| 7 | **`PATCH /api/products/:id/global` hardcodes `['en','it']` three times** and returns `200 {ok:true, changed:false}` — every DE/FR/ES/NL/PL/SE content edit is a silent no-op that the sheet reports as saved. | 27 |
| 8 | **Cascade apply's queued push is a no-op reporting success** — values nested under `payload.fields`, readers read flat keys, Amazon returns "SKIPPED — empty patch" as `success:true`. | 33 |
| 9 | The eBay push drops the 2nd..Nth value of a MULTI aspect (`typeof v === 'string'`); MULTI-ness itself is a regex over a prose `notes` string. | 04 |
| 10 | `restoreToDraft` sets `isPublished:false`, but the eBay push gates on `syncPaused`; and that gate sits inside `if (payload.quantity !== undefined)`, so a content FULL_SYNC bypasses both pauses. | 06, 28 |
| 11 | Both SSE routes have no `preHandler` (unauthenticated) and carry account-health text. | 11 |
| 12 | The drawer's `HtmlField` allowlist drops `<img>`, `<table>` and `style=` and **commits on blur with no edit** — focusing an eBay description in the drawer destroys live body copy through autosave (and local dev writes prod). | 01 |
| 13 | Image drift is structurally always "all differ" (Amazon-hosted URL vs Cloudinary URL; `findDrift` has no production consumer). | 31 |
| 14 | `callTradingApi` returns a fake empty success in dev; `fetchListingForFlatFile` is `catch { return null }`, so 401/429/500 all read as "not on eBay". | 10 |
| 15 | A matrix drop onto an owned cell silently nulls `altOverride`, `variationId`, dimensions and mime (full-row `bulk-save`). | 13 |
| 16 | `APlusContent.marketplace` is written as `'AMAZON_IT'` by the UI and `'IT'` by the pull — a market-keyed column reads "no A+" for every operator-created document; no attach/detach endpoint exists. | 14 |
| 17 | The old `ai-improve` route is live, unbudgeted and gated on `channels.sync`; `draft.service.ts` never sends `target:'channel'`, so the first eBay aspect approval would write master and return 200. | 09 |
| 18 | `MATCH_AMAZON` is a silent no-op on the live sync path (`amazonPrice` never passed); `/pricing/bulk-override` writes an override the engine ignores; four price chains disagree. | 25 |
| 19 | `PATCH /channel-pricing` swallows every rejection via `Promise.allSettled`, hardcodes `aliasKey:''`, has no CAS. | 22 |
| 20 | eBay `template-apply` never bumps `ChannelListing.version` (invisible to CAS); fitment copy fans out to 200 live listings **by default**; the fitment write is alias-blind `findFirst`. | 12, 08 |
| 21 | `TECH_DEBT.md`, `channel-publish.service.ts` and the wizard route all say the wizard's adapters are NOT_IMPLEMENTED; all three dispatch for real. | 34 |
| 22 | The sheet calls a suppressed listing **live** (`sheet-rows.service.ts:264`); `evaluateCompliance`'s CE `block` is applied by no studio path. | 17, 20 |
| 23 | `Product.fulfillmentChannel` (what the master cell writes) is not what the FBA guard or channel resolution reads (`fulfillmentMethod`). | 18 |
| 24 | `bulk-replicate` copies `quantity` with no call to the Amazon EU shared-quantity guard (the Zero-&-Pins incident class); `jobWriters.currentOf` ignores `cell.scope` and the bulk PATCH dedupes contexts without `aliasKey` — two latent blockers for any multi-market apply. | 26 |
| 25 | The studio's image **approval** and **auto-publish** toggles are read by nothing (`queueApproval` has no caller; neither publish path consults prefs) — less honest than the old tab; the Schedule button has no `onClick`. | 32 |
| 26 | Image restore points are Amazon-only in fact (`layerRows` filters `amazonSlot`; eBay upserts have none) while the panel says "nothing is pinned to EBAY". | 32 |
| 29 | **Pan-EU makes quantity and images ONE account/ASIN-global value** — a per-coordinate drift column would light five markets for one fact and let an operator zero five marketplaces from a DE screen; every channel field needs a `per-market | account-global` scope from the adapter. The old Pull calls a debug route with the wrong API, market and parent ASIN and writes nothing; `resync` and `enrichProductFromAmazon` already pull with no diff, confirm or snapshot; `externalListingId` means SKU to one service and ASIN to another. | 24 |
| 28 | The built planner's footer says "every gate is closed, nothing reaches a channel" while the eBay/Shopify image publish path (route + 3 services) has **zero** publish-gate references and hardcodes `api.ebay.com` — "Rehearse" can write live eBay; the sync bar's eBay branch is dead; `copy-scope` is a dead route with wrong overwrite/dedupe semantics; `followMasterImages` is read by no image service. | 29 |
| 27 | The schedule cron reads-then-fires with no atomic claim and no `lib/cron/clustered` — arming `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH` double-pushes live; `EBAY_API_BASE` defaults to production and the eBay/Shopify image publishes have no dry run. | 32 |

---

## 6. Deliberately not rebuilt (H12 — needs the Owner's sign-off at swap)
Cockpit/classic mode toggle · classic passthrough · cockpit telemetry (parity 3.15/3.33/3.34/3.37) ·
the 30 s cross-tab toast (11) · the invented PDP chrome — stars, Prime, buy box, shipping lines (10, 23) ·
promote-to-master (07; if wanted later, "Copy this value to the master" via the audited bulk PATCH, an S) ·
the `/products/:id/recover` page (17, the flow survives as a verb) · the Amazon Fit/Compatibility card (20,
covered by a `Fit & sizing` preset) · Subscribe & Save / Business pricing (19) · the template-vault UI in the
studio (21, link-out) · the `×10` Shopify position scheme (30) · `FIXED` as a pricing rule (25, it is a
literal) · the `Republish to fix` button on image drift (31, dead prop, all channels gated) · the localStorage
approval queue and rollback snapshots (32 — the queue gates nothing and is per-browser; the preflight is what an operator reaching for "stop me" wants) · `Alt+1..9` market switching and `Cmd+Shift+P` publish
(a shortcut that fires an outward action is the reflex the drawer's own comment warns about).

---

## 7. Waves (the Owner assigns lanes; ownership below follows the layout doc §4 table)

**Wave 0 — safety, before any market feature ships (mostly PES.5):** §5 items 1–4, 7, 8, 10, 11, 12 (12 is PES.4).
Close the three image gates (D-C), make the channel write honour the declared store (D-D), fix the locale
hardcode, gate the SSE routes, stop the drawer's blur-commit, fix the cascade payload.

**Wave 1 — the frame (PES.2 / PES.1 / PES.4 / PES.5):** §4.1 registry axes · `per_listing` scope · the ONE
publish flow shell with the Send step refused · §4.4 source axis · §4.5 `Channel check` · §4.3 drawer
sections · the status-column renderer family · four DS components (`LookupCombobox`, `ChipListCell`,
`SandboxedHtmlFrame`, `EntityPicker`).

**Wave 2 — the features, in dependency order.** eBay (PES.3 + PES.5 + PES.6): 01 theme cell + preview +
sync column → 03 category cell/pane → 04 aspect chips (with the MULTI push fix) → 05 Offer group → 06
publish/restore → 07 freeze + restore-a-value → 08 compatibility pane → 09 AI mount → 10 check + preview →
12 copy listing setup → 34 add listing. Amazon (PES.3 + PES.5 + PES.7): 13 image columns/verbs → 14 A+
column → 15 product type confirm + browse nodes → 16 publish flow → 17 suppressions source + Check with
Amazon → 18 fulfilment → 19/25 Offer group + buy box + price verbs → 20 compliance pane → 21 copy setup → 22
Markets section → 23 preview. Cross (PES.4/5/7/8): 27 locale metadata → 28 auto-publish + Sync column → 31
drift folded into Channel check → 33 propagation (after §5.8) → 11 realtime widening → 26 broadcast (S–M, unblock the existing verb) then replicate (M + two S server fixes) → 32 the Publish rail (M) + server restore points (L) → 29 the `Images` column, the copy verb and the planner's three doors (S–M each, one L for the server preflight).

**Wave 3 — later, and said so on screen:** Shopify image grid when a store is connected (30) · cross-product
copy (12/21) · per-alias AI drafting (09) · field-level restore *write* (06) · a real eBay send (06) · the
fifth AM.1 shape (repeating sub-table) and a fitment library (08) · a repricer provenance mark `↻` (19).

---

## 8. Decisions for the Owner (consolidated; each report's remaining questions are in §11 by pointer)

| # | decision | recommendation |
|---|---|---|
| D-A | **Ratify §2 as the D1 disposition** — the 22 channel operations live by the grammar, not in a new surface; hub ruling #86's "a sheet is the wrong shape" stands for *verbs and queues* and is superseded for *values* by AM.1 §A.3a. | Yes. This is what all 34 reports independently arrived at. |
| D-B | **Publish in wave 1:** Amazon = Rehearse only (D8 holds after swap); eBay = preview-only with the Send step rendering the server's refusal; snapshot capture wired into the *flat-file* push so history is real on day one. | Yes to all three (06, 16). |
| D-C | **Close the three ungated live image paths now** (eBay publish, Shopify publish, Amazon dry-run honesty) onto `get*PublishMode()` with a caller `dryRun`. | Yes — zero Shopify jobs have ever run; the cost is nil (02, 30, 16). |
| D-D | **The channel write honours the column's declared store** (`platformAttributes` / typed column) in ONE predicate shared with the readers, **before any channel value cell ships**; the affected cells stay read-only with the reason until then. | Yes — producer and consumer land together (03, 05, 18, 21). |
| D-E | **Listing-level values live on the alias band row** with a new `per_listing` column scope; variant rows render locked with the server's sentence. | Yes (05, 01, 28). |
| D-F | **Registry:** add `channel-scope` and `CELL`; `AliasVerbs` bar in channel `leading`; publish moves from the toolbar to the band. | Yes (34, 07, 12, 06). |
| D-G | **Drawer:** sections in Listings (→ "Channel") and modes in History first; new panes only Preview, Compatibility (eBay), Compliance (master); ≤6 tabs per scope; the Payload table is one component shared with the publish confirm. | Yes (22, 31, 23). |
| D-H | **ONE `Channel check` column and verb for fields and images.** | One (10, 31). |
| D-I | **Errors & Sync gains a source axis**; sources ship dark-but-honest (`—`, never `(0)`) with "Check with Amazon" as the one live, non-mutating read. | Yes (17, 15, 06). |
| D-J | **Translation store = `ProductTranslation`**, `localizedContent` backfilled once and read-only; `requireReviewed` default-on for publish; translate-all DRAFTS. | Yes (27). |
| D-K | **Pricing:** `MATCH_AMAZON` stays a strategy (select cell), `PERCENT_OF_MASTER` becomes a formula, the channel price column is `priceOverride` + `followMasterPrice=false`, the bulk PATCH learns six price/qty keys; sale price ships **read-only with the reason** until the push carries it. | Yes (25, 22, 19). |
| D-L | **Lock = "Frozen ❄"**, refused outright (Unfreeze one right-click away), per coordinate with master freezes inherited-in-effect, enforced server-side. | Yes (07). |
| D-M | **Deferrals/drops in §6**, and explicitly: Shopify grid deferred with the reason ON SCREEN; promote-to-master stays dropped; PDP = four real blocks in a device frame, never a mock. | Yes (30, 07, 23, 10). |
| D-N | **Product type is one master-stored cell on every row**, joined 🔗 onto Amazon; changing it is a preflighted confirm that re-projects the sheet. eBay's own category suggestion and the rule-based hint ship labelled by source ("eBay's suggestion"), never as AI. | Yes (15). |
| D-O | **Fitment and auto-publish are listing-level** (band); fitment's ⚠ waits for eBay's cached `compatibilityEnabled`. | Yes (08, 28). |
| D-P | **First-listing create ships now; the alias branch renders disabled with the server's sentence until PES.5-ii**; the old wizard route stays reachable, unlinked, until its DRAFT count drains. | Yes (34). |
| D-Q | **Replicate = a two-step drawer beside Import over the live import pipeline (real diff, refusals, revert), not a five-step wizard; broadcast acts on the FOCUSED COLUMN.** | Yes (26). |
| D-T | **Pull adopts onto the CHANNEL only** in wave 1 (master-routed differences listed and refused with a reason); each pull takes a `ChannelListingSnapshot` first; the two existing silent pulls (`resync`, `enrichProductFromAmazon`) are flagged now and gain `captureSnapshot` in PES.5's pass. | Yes (24). |
| D-S | **Planner:** refuse ungated eBay/Shopify image targets ON SCREEN now (one PES.7 edit) and close the gates as the #247 remedy; `followMasterImages` becomes load-bearing in the publish path or the flag is hidden and only the copy is offered; Amazon's eleven markets are ONE destination card. | Yes (29). |
| D-R | **Image publish rail:** drop the browser approval queue (replace with nothing for now; the smallest honest later version is a per-product `requiresApproval` refusal); auto-publish-after-save is wired to the fire path this pass or removed; scheduling is finished only together with the atomic claim + cluster lock. | Yes (32). |

---

## 9. What this changes in the approved documents (once approved)
Layout doc §1 "Channel scope": the `[+ Add listing alias]` row becomes the `+ Add listing…` band verb (34);
§1 "Autosave & writes": publish entry = band verb + `Publish ▾` router (06/16). Layout v2 spec §5: the drawer
gains the pane/section rule in §4.3. `docs/pes-parity-audit.md` §3: rows 3.4, 3.8, 3.9, 3.22–3.26, 3.28,
3.31, 3.32, 3.40, 3.44–3.48, 3.50, 3.52 move from 🕳 to "designed" with the H-code above. Hub ruling #105
D1: disposed by D-A. Ruling #86: bounded to verbs/queues.

---

## 10. Acceptance (mechanical, before any lane reports done)
For every feature landed: (1) the verb appears on all four registry surfaces from one declaration (a grep for
a second declaration fails the gate); (2) every status column is `editable:false` on the wire and covered by
`scripts/check-editor-open.mjs` (the fill handle must not fill an inert column); (3) every disabled control's
reason is in the DOM, not only in `title` (control census gate extended); (4) a write from a cell that
claims a store is read back from **that** store after ≥8 s (`reference_read_before_the_write_arrived`);
(5) no path reaches `api.ebay.com`, SP-API or Shopify without the channel's `get*PublishMode()` — a unit test
enumerating the outbound clients; (6) `count: null` never renders as `0` anywhere a chip counts.

---

## 11. The reports (paths) and their remaining per-feature questions
`docs/market-features/NN-<slug>.md` (copied from the session scratchpad), §9 of each holds up to three Owner questions with a
recommendation. The ones NOT folded into §8 above, by pointer: 01 Q2 (body hash in staleness) · 02 Q2 (shell
listings' images via an alias selector) · 02 Q3 (eBay images one set per market) · 03 Q2 (union of aspect sets
across two leaves) · 03 Q3 (recommended tier derived from eBay) · 04 Q1 (channel store wins for joined aspects)
· 05 Q2 (`listingFormat`/`handlingTime` read-only) · 05 Q3 (account default on the connection page) · 06 Q3
(field-level restore view first) · 08 Q3 (fifth AM.1 shape later) · 09 Q2 (cost estimate on the dark trigger)
· 09 Q3 (re-gate the old route now) · 11 Q3 (three-state liveness pill) · 12 Q2 (`products.edit`) · 12 Q3
(shared listing never a target) · 13 Q2 (country-specific upload = operator-assisted ZIP) · 13 Q3 (lock skips
mirror deletes) · 14 Q2/Q3 (A+ out of readiness; fix the key drift first) · 15 Q3 (chip first, queue second)
· 16 Q2/Q3 (live validation operator-pressed; typed confirm on the image arm now) · 17 Q1 (suppressed → `errors`
for the swap) · 18 Q2 (retarget master to `fulfillmentMethod`) · 19 Q2/Q3 (sale-window columns; repricer mark)
· 20 Q1/Q3 (CE block with audited override; several certificates, latest wins) · 21 Q3 (workbook export =
link-out) · 22 Q3 (`pim.manage` for theme/axes) · 24 Q2/Q3 (snapshot per pull; flag the two silent pulls) · 25 Q3 (`priceOverride`) · 26 Q3 (translate on replicate → drafts, checkbox honest and disabled) · 27 Q3 (translate offered on
channel scope, re-targeted) · 28 Q1 (enqueue silently, never send silently; the 10-min hold is the confirm)
· 31 Q3 (settle drift with one unit case, not a live call) · 33 Q2 (`linked` gets its own glyph) · 34 Q2
(legacy drafts read-only).
