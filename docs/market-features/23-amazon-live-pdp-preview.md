# 23 — Amazon LIVE PDP PREVIEW (+ the shared preview band / skin toggle)

## 1. What it is (one paragraph, in operator terms)

One question, asked at one moment: **"before I push this to amazon.it, what will the buyer actually
see?"** The operator is a listing operator on a channel scope (Amazon · IT/DE/FR/ES/UK), immediately
before a publish and immediately after a bulk edit. They are not checking a value — the sheet does
that, cell by cell, with readiness chips. They are checking a *composition*: that the title does not
wrap into nonsense on a phone, that there are five bullets and not two, that the gallery has a hero
image and it is not the size chart, that the description is not an empty block, that the price block
does not read `€ —`. It is a **glance for gross wrongness**, and it is worth exactly as much as its
honesty: a mock that invents star ratings, Prime badges and "30-day returns" trains an operator to
stop believing the parts that ARE real. Its twin question — "what fields is this actually going to
send?" — is the same surface's second view, and it is the parity gap the audit already names (3.14n).

## 2. Old UI — inventory

**Entry point.** There is none. The preview is not a control an operator opens: it is mounted
unconditionally in the Amazon cockpit's right rail —
`tabs/amazon-cockpit/AmazonCockpit.tsx:830` `<div className="w-96 flex-shrink-0">` →
`:831` `sticky top-4` → `:832` `<AmazonLivePreview composed childrenList>` with `HealthPanel`
below it at `:836`. So the preview is **384px wide, always on, and never dismissable**.

**Component.** `tabs/amazon-cockpit/AmazonLivePreview.tsx` — **725 lines**, one file, no tests.
- Own state: `skin` (`:79`, `useState<Skin>('mobile')`) and `galleryIdx` (`:80`). Browser-local,
  **not** persisted — no `localStorage`, so the operator re-picks Desktop on every page load.
- Header strip `:102-121`: hardcoded `amazon` wordmark on `bg-[#232f3e]`, market flag emoji from a
  local `MARKET_FLAG` map (`:59-61`), TLD from a local `MARKET_TLD` map (`:64-76`) — an eleven-entry
  hardcoded list beside `Marketplace.domainUrl`, which the compositor already reads (`:415-420`).
- `PreviewSkinToggle` mounted at `:115`; `MobileSkin` `:185`, `DesktopSkin` `:302`.
- Health footer strip `:147-163`: `Title n/200 · Bullets n/5 · Desc n · Images n/9`, plus a
  `Master is newer` badge.
- 🔴 **`DesktopSkin` declares `min-w-[820px] max-w-[920px]` (`:311`) inside a 384px rail**, wrapped
  in `overflow-x-auto` (`:310`) so the geometry failure is hidden as a horizontal scrollbar. The
  three-column Amazon desktop layout (`40px_240px_1fr_220px`) has never been seen at its own width
  in this page. Identical defect to eBay's (report 10 §5.9) — same cause, same rail.

**Data.** `tabs/amazon-cockpit/useAmazonCompositor.ts` — 468 lines, a **pure `useMemo`** (`:130`)
over props the parent already fetched plus the in-page draft bus (`useProductDraft`, `:129`).
**Zero server round-trips**, ever. It composes 17 fields into `ComposedAmazonListing`
(`amazon-cockpit/types.ts:30-70`) with a per-field `source` label drawn from a **sixth provenance
vocabulary** — `FieldSource = manual | master | translations | ai | sibling | default`
(`types.ts:17-23`) — which matches neither the server's `CellLayer` nor FM.2's
`ChannelFieldSource`.

**Invented facts presented as this listing's** (all CODE-READ, all `feedback_100_percent_honest_ui`
violations):
| what it shows | where | truth |
|---|---|---|
| ★★★★☆ `4.3` · `Ratings TBD` | `:522-546` (`FakeRating`) | no review data is read anywhere |
| `prime` badge + `FREE delivery` + `FREE Returns` | `:548-556`, `:203-212` | inferred from `fulfillment_channel === 'FBA'` only |
| `Climate Pledge Friendly (preview)` | `:353` | fixed chip; no attribute consulted |
| `Ships from Xavia` / `Sold by Xavia` | `:430-441` | hardcoded seller name |
| `30-day returns` | `:638-662` (`DeliveryRow`) | no returns policy is read |
| `Quantity: 1 ▾` | `:443-449` | a stub |
| `Safety & Compliance: GPSR / hazmat / battery checks land in AC.4.` | `:716-724` | placeholder text shipped to the operator |
| colour swatch = grey square | `:610-613` | the axis value's colour is never resolved |
| Add to Cart / Buy Now | `:451-462` | "visual only" per the file's own header `:22` |

**Genuinely wrong renderings** (not just invented chrome):
- `DescriptionBlock` (`:694-714`) renders the description as **plain text with `line-clamp-4`**
  (`:709`). Amazon's `product_description` is the single largest thing on the PDP and four clamped
  lines of `whitespace-pre-wrap` is not it.
- `BulletBlock` (`:664-692`) reads `composed.bullets.value`, which the compositor fills **only**
  from `listing.bulletPointsOverride` (`:246-252`) — never from master (`useAmazonCompositor.ts:245`
  says master has no bullet field, which is false: `Product.bulletPoints String[]` exists at
  `schema.prisma:114` and the resolver synthesises it, `attribute-resolver.ts:152`). So a listing
  that publishes five bullets from master previews as **"No bullet points set"** in red.
- `pickGallery` (`:92-101`) is `product.images` sorted by `sortOrder`, capped at 9 — the **master**
  gallery. The Amazon outbound gallery is a per-(market, productType) **slot plan** with its own
  cascade (§3). The preview's gallery is not the gallery that ships.

**Shared pieces.**
- `_shared/cockpit-preview/PreviewSkinToggle.tsx` — 54 lines, two `<button>`s with `lucide`
  Smartphone/Monitor, channel-themed via `activeClass`/`inactiveClass` props. Two consumers:
  `AmazonLivePreview.tsx:115` and `tabs/ebay-cockpit/EbayLivePreview.tsx:18,185`. Hand-rolled, not
  a DS control — the DS `SegmentedControl` already exists
  (`design-system/primitives/SegmentedControl.d.ts:2`).
- `_shared/cockpit-shell/CockpitPreviewBand.tsx` — 82 lines, the collapsible preview+health band.
  **DEAD.** Repo-wide grep: its own file, the barrel export (`cockpit-shell/index.ts:13-14`) and one
  *comment* in `CockpitClassicPassthrough.tsx:8`. **Neither cockpit mounts it** — Amazon hand-rolls
  the `w-96` sticky rail (`AmazonCockpit.tsx:830`), eBay hand-rolls its own. The parity audit
  reached the same verdict independently (`docs/pes-parity-audit.md:276`, row 4.17; also `:486`),
  including the warning that a plain grep makes it look alive. So **"the shared preview band the
  eBay cockpit also used" does not exist** — it was built, never wired, and both channels drifted
  into two 384px rails instead.

## 3. Backend that exists

**The resolved outbound payload EXISTS server-side, and it is already in the studio's own sheet read.**

1. `resolveChannelField` — `apps/api/src/services/pim/resolve-channel-field.ts:537`. Its header
   states the invariant verbatim: *"preview / validate (today) and cascade / sync (FM.5–FM.8) all
   call this so 'what you preview' == 'what ships'"* (`:8-10`), with a 7-layer precedence
   (`:18-30`: missing · locked · override · linked · fallback · default · catalogRule).
2. `previewPayload` — `services/pim/payload-preview.ts:94` (178 lines). *"Generates the exact
   key/value payload a publish would send for one product on one marketplace"* (`:5-6`), delegating
   per field to (1). Returns `{payload, fields[{fieldKey, value, source, provenance,
   needsTranslation, raw, appliedTransforms, warnings, required}], missingRequired[]}` (`:44-71`).
   Exposed as **`GET /api/pim/mappings/:channel/:code/preview/:productId?locale=`** —
   `routes/pim-mapping.routes.ts:350-370`. One web consumer today:
   `apps/web/src/app/settings/mappings/MappingsClient.tsx:333`.
3. `resolveBatch` — `services/pim/mapping/resolve-batch.service.ts`. Its header is the ruling in
   code: *"THE seam… There is deliberately ONE implementation: a preview must RUN the engine
   (reference_preview_must_run_the_engine), and a sheet that re-derived values in the browser would
   drift from what publishes the moment a transform changed"* (`:4-8`). It is *"`payload-preview`
   widened on two axes"* (`:10-16`) — N products, full field catalogue. Route
   `POST /pim/channel-mapping/:channel/:code/resolve` (`routes/channel-mapping.routes.ts:170`).
   `ResolvedCell` (`:35-53`) carries `value` (post auto-correction), `status`, `provenance`,
   `appliedTransforms`, `warnings`, `errors`, `autoCorrected {from,to}`, `required`, `overLimit`.
4. 🟢 **The studio sheet already composes (3) in-process, per cell.**
   `services/pim/studio-sheet.service.ts:916-980` — *"what the MAPPING ENGINE would ship for these
   cells. Composed IN-PROCESS (hub ruling #15.2 / #20.1): one payload, no second HTTP hop, and
   PES.2/3 are barred from fetching PES.6 separately"* — asked by the **channel's own** field names
   (`bullet_point`, `item_name`, `:957`; measured 2026-09-05: 186 sheet keys cost 3.7 s, ~107
   channel keys is the truth), bounded by `withTimeout` because PES.6's barrel touches Redis
   (`:933-948`). The result lands on every channel cell as
   `StudioCellValue.mapped: MappedCell | null` (`:144`, shape `:92-102`).
   **Consequence: `row.values[key].mapped.value` IS the outbound value, from the one engine.**

**The image half is also already resolved server-side.**
`GET /api/products/:productId/amazon-images/preview?marketplace=&activeAxis=` —
`routes/images/amazon-images.routes.ts:362-395` → `buildAmazonImagePreview`
(`services/images/amazon-image-preview.service.ts:71`), *"same resolver the publisher + ZIP exporter
use"* (`:4-7`), honouring the exact-variant → group → product cascade at MARKETPLACE / PLATFORM /
GLOBAL scope (`:9-13`). Returns per variant `{sku, amazonAsin, attributes, slots{MAIN,PT01…,SWCH},
filledSlots, totalSlots, hasMain, missingSlots}` (`:39-64`). Consumers today: the old
`PublishPreviewModal.tsx:115`, and `amazon-publish-validator.service.ts:87`.

**What actually SENDS, and why it is not (2) or (3).**
- `POST /api/products/:id/publish-amazon` — `routes/amazon-cockpit-publish.routes.ts:231`. Its own
  header (`:10-18`): builds a `JSON_LISTINGS_FEED` row *"from `listing.platformAttributes` +
  `listing.title/description/bullets/price/quantity` + `product.brand/sku/productType`"* and reuses
  `AmazonFlatFileService.buildJsonFeedBody`. It **does not import** `previewPayload` or
  `resolveChannelField` (import block `:28-39`).
- `syncProductToAmazon` — `services/marketplaces/amazon-sync.service.ts:48` (worker path,
  `workers/channel-sync.worker.ts:13`) has its own `generateAmazonPayload` (`:23`) and hands it to
  the FM.7 bridge at `:158-165`.
- `applyMappingToSyncPayload` — `services/marketplaces/sync-mapping-merge.ts:78`. `getSyncMappingMode`
  reads `FM_SYNC_<CHANNEL>` and **defaults to `off`** (`:24-27`); `off` returns the legacy payload
  untouched (`:85`), `shadow` logs the diff and still serves legacy (`:108-117`). Only `merge`
  serves the resolver's values. No repo file sets `FM_SYNC_AMAZON` (grepped; only the test file).
  **HYPOTHESIS — needs the hub's env authority: FM_SYNC_AMAZON is `off` on prod.**

**Not the payload preview, despite the name.** `POST /api/products/sheet/publish-preview`
(`routes/products-sheet.routes.ts:113`) → `sheet-publish.service.ts` returns a per-row **verdict**
`ready | warned | unlisted | blocked` + issues + `publishMode` (`:26-54`), *"makes no channel call
whatsoever"* (`:6-7`). It answers *whether*, never *what*.

**Follow-flag semantics (the trap the old preview walks into).**
`services/pim/attribute-resolver.ts:132-138` — `SSOT_FIELDS` = title, description, price, quantity,
bulletPoints, each with `followFlag` / `overrideCol` / `directCol`. At `:262-267`:
`const followsMaster = follows === undefined ? true : Boolean(follows); if (followsMaster) continue`
— **when the flag is true (the schema default), the override column is SKIPPED entirely**, and the
override is only consulted at `:273-281` when it is false.
`services/pim/channel-field-map.ts:31-34` states the operational consequence: *"an override the
listing still 'follows master' past is one the resolver and the feed ignore"* — with `512 of 725
listings already carry` a `bulletPointsOverride`. `FOLLOW_FLAG_FOR_COLUMN` (`:44-46`) wires the
bullet write to clear the flag; `title`/`description` keep pre-AM.1 behaviour (`:41-42`).

**Writable channel fields** — `channel-field-map.ts:22-36`, **7** entries (not 6):
`{amazon,ebay}_{title,description,variationTheme}` + `amazon_bulletPoints → bulletPointsOverride`.
The sheet-key twin is `CHANNEL_WRITABLE` (`studio-sheet.service.ts:462-473`) and it includes
`bulletPoints`. So **title, description, bullets and variation theme all have real columns on an
Amazon scope** — the four fields a PDP preview is mostly about.

**Permissions** (`lib/auth/permissions-manifest.ts`):
- `:383` `RW(F.pimManage, F.pimManage, pfx('/api/pim'))` — 🔴 **reading the payload preview requires
  `pim.manage`**, both verbs. An operator with `products.edit` (what every studio channel verb needs,
  `_studio/sheet/channel/channelActions.ts:52`, ruling #123) cannot open it.
- `/api/products/**` reads are `products.view` — so `amazon-images/preview` and the studio sheet read
  are correctly gated.
- `:353` `RW(F.listingsView, F.channelsSync, pfx('/api/amazon'))`.

**Channel calls / gates.** Nothing in this feature calls Amazon. `previewPayload`, `resolveBatch`,
`buildAmazonImagePreview` and the studio sheet read are all **pure DB reads**. `getAmazonPublishMode()`
gates only the send (`amazon-cockpit-publish.routes.ts:36`). No jobs, no crons.

## 4. Studio today

- **Nothing.** Parity row **3.17** = `🕳` — *"Live PDP preview (mobile / desktop skin toggle, gallery
  slots) … no live PDP preview anywhere in the studio"* (`docs/pes-parity-audit.md:139`). The row
  names only Amazon's files; **`EbayLivePreview.tsx` (458 lines) appears in NO row of the audit**
  (grep count 0) — the eBay preview is an unrowed capability, so 3.17 is the only handle either
  channel has.
- **Row 3.14n is the same pane's other half**: *"the preflight names blocked rows and their fields
  but does not list the fields that WOULD be published. **An operator cannot see the outgoing payload
  before sending.**"* (`:208-209`). Row 3.14 is `🔁` with *"No fields-being-published table"* (`:132`).
- Row **4.17** (`:276`) verifies `CockpitPreviewBand` DEAD, and warns that the grep hit is a comment
  (`reference_ds_guard_greps_comments`).
- Adjacent hole worth knowing: row **6.40** (`:409`) — the SEO tab's **live SERP snippet preview
  (desktop + mobile)** and **JSON-LD preview** are `🕳`, and the audit says *"the two PREVIEWS … are
  the part a grid cannot express, and they are the reason the tab existed."* Same shape, same pane
  idiom, third consumer.
- **Hub rulings that bind this feature:**
  - **#2** (`docs/pes-claims.md:13-15`) — *"PES.6's mapping engine CONSUMES that resolver — **one
    cascade, never a parallel implementation (a preview must RUN the engine)**."* This is the ruling
    that decides the question in §6.5. Encoded in code at `resolve-batch.service.ts:6-8`.
  - **#8(a)** (`:44-46`) — SP-API image attributes are **ASIN-GLOBAL** even with a marketplace_id
    selector, *"the honest cross-market publish preview stays mandatory for this path."*
  - **#118(1)/(2)** — `ActionImpact.payload` + `run(rows, impact?)`, order COLLECT → PREFLIGHT →
    CONFIRM → RUN (`design-system/grid/actions/registry.ts:122,203,221`).
  - **#169 / layout §1b** — chrome is expensive; the sheet is ~90-95% of viewport.
  - Layout doc `docs/2026-09-01-product-edit-studio-layout.md:59` — *"Tabs (thin, non-tabular
    surfaces only): Sheet · Images · Analytics/Ads · Activity"*. No preview tab is contemplated.
- **Industry evidence, and it is a negative:** `docs/2026-09-02-industry-research.md` §7 ranks the
  20 things a best-in-class operator expects on day one, re-ranked against the measured tree. **A
  storefront/PDP preview is not on the list at all**; the preview items that ARE there are #13
  *"Preview before apply"* — BUILT, `POST /pim/formulas/preview` — and the top three to build are
  paste/fill validation, import, and revertible bulk jobs (`:429-439`). §5's only render note is
  that *"nobody renders"* a 500-variation product page (`:327`). This is the strongest argument
  against spending an L on chrome fidelity.
- **Substrate that is ready:** `SheetToolbar` `leading`/`trailing`/`absent` (`:90-96`);
  `openRecordAction` as the precedent for a read-only ROW verb with **no preflight** — *"nothing is
  written, nothing is fetched, and a confirmation for 'look at this' would be noise"*
  (`channelActions.ts:391-392`); `RecordDrawer.tsx:473-478` builds panes as a DS `Tabs` array (four
  today); `RecordActions.tsx:3-34` is the drawer's registry adapter and declares no verb of its own;
  `ListingsPane.tsx:17-19` sets the no-second-fetch rule; `StudioCellValue.divergence`
  (`studio-sheet.service.ts:119`) already names a cell whose other layer holds a different value.

## 5. Defects and slowness

1. 🔴 **CODE-READ — the old preview is a client re-implementation of the cascade, and it drifts
   5-for-5 on exactly the fields it renders.** `useAmazonCompositor` takes the `*Override` column
   first and **never consults the follow flag to decide the value**:
   - title `:213` (`if (listing?.titleOverride)`) — `followMasterTitle` is read only at `:215,:218`,
     and only to pick the *label*;
   - description `:230`; bullets `:246-252`; price `:263-273`; quantity `:285-286`;
   - `followMasterPrice` / `followMasterQuantity` are declared (`:38-39`) and **never read at all**.
   Against `attribute-resolver.ts:262-267` (`if (followsMaster) continue`) the outcome is exact: a
   listing with `titleOverride = "X"` and `followMasterTitle = true` (the default) **previews "X"
   and publishes master**. On 512 of 725 listings carrying a `bulletPointsOverride`
   (`channel-field-map.ts:32`), any whose flag is still true previews bullets the feed drops. This
   is `reference_preview_must_run_the_engine` measured in the tree, not quoted.
2. 🔴 **CODE-READ — three payload builders for Amazon, and they do not agree.** `previewPayload`
   (mapping/FM.2) · `AmazonFlatFileService.buildJsonFeedBody` from listing columns (what
   `publish-amazon` actually sends, `amazon-cockpit-publish.routes.ts:10-18`) · `generateAmazonPayload`
   (worker, `amazon-sync.service.ts:23`). FM.7 was built to converge them and is **`off` by default**
   (`sync-mapping-merge.ts:24-27,:85`). This is `reference_two_column_builders_drift` at the payload
   level, and it means **"the resolver's payload" and "what publish-amazon sends" are two different
   documents today**.
3. 🔴 **CODE-READ — the existing image "what would publish" preview under-reports the slot set, and
   its own comment claims otherwise.** The publisher resolves the live taxonomy and passes it in:
   `amazon-image-feed.service.ts:313-315` (`resolveSlotTaxonomy(mkt, productType)` →
   `resolveAmazonImages(..., taxonomy.slots.map(s => s.slot))`). `buildAmazonImagePreview` calls
   `resolveAmazonImages(productId, mkt, variantIds, activeAxis)` with **no `slotCodes`**
   (`amazon-image-preview.service.ts:87`), so `:205` of the feed service falls back to the hardcoded
   legacy ten, and the preview file hardcodes the same ten again at `:29` — while
   `images-workspace.routes.ts:348-353` explicitly warns that *"a FALLBACK is also a non-empty list
   of slots"*. So every schema-discovered slot (PS0x / GPSR safety images) the publisher would send
   is **invisible** in the preview whose header says *"same resolver the publisher + ZIP exporter
   use"*. `reference_a_list_of_members_is_a_set_claim` + `reference_comment_asserts_property_code_lacks`.
4. **CODE-READ — the payload preview is gated behind a WRITE-grade permission.**
   `permissions-manifest.ts:383` gives `/api/pim` `pimManage` for read AND write. Rendering a
   read-only payload is not PIM administration. Same class as report 10 §3's finding on
   `POST /ebay/description-preview` (`channels.sync`).
5. **CODE-READ — a 725-line single-file component with no test**, containing two full skins, nine
   inner components and two hardcoded eleven-entry marketplace maps (`:59-76`) duplicating
   `Marketplace.domainUrl` (which the compositor reads at `:415-420`).
6. **CODE-READ — geometry never worked.** 820px minimum inside a 384px rail
   (`AmazonLivePreview.tsx:310-311` vs `AmazonCockpit.tsx:830`). The Desktop skin's whole point is
   the three-column layout, and it has never been rendered at its own width on this page.
7. **CODE-READ — eight invented facts** (§2 table), including placeholder engineering copy shipped
   to operators (`ComplianceFooter`, `:716-724`) and a fixed 4.3-star rating (`:522-546`).
8. **CODE-READ — the shared band is dead and the two channels drifted anyway.**
   `CockpitPreviewBand` has no importer; both cockpits hand-roll their own rail. A shared component
   nobody mounts is worse than none: it made the drift look solved.
9. **CODE-READ — skin choice is not persisted.** `useState<Skin>('mobile')` (`:79`). Every reload
   costs the operator the toggle again.
10. **CODE-READ — the preview cannot see a warning.** `previewPayload` returns per-field `warnings`
    and `resolveBatch` returns `warnings`, `errors`, `autoCorrected` and `overLimit`
    (`resolve-batch.service.ts:42-52`); the old preview renders none of them. It has its own
    `healthHints` counters instead (`useAmazonCompositor.ts:455-464`), computed in the browser.
11. **CODE-READ — the sheet row has no gallery.** `StudioRow` carries `imageUrl` (ONE server-picked
    face image, `studio-sheet.service.ts:196-205`) + `photoCount` (`:207`) + `imageInherited`
    (`:215`). A gallery strip therefore **cannot** honour `ListingsPane`'s no-second-fetch rule; it
    needs `amazon-images/preview`. Say so rather than rendering `imageUrl` nine times.
12. **MEASURED-IN-DOC — the mapping resolve is the sheet's slowest leg and is Redis-coupled.**
    `studio-sheet.service.ts:954-957`: 186 sheet keys → 3.7 s; the fix was to ask by ~107 channel
    keys. `:933-948`: PES.6's barrel connects to a Redis-backed queue during module *initialisation*
    and **retries rather than throwing** when unreachable, hence `withTimeout` on both the import
    and the call. Any new preview endpoint that re-enters that engine inherits both.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: `H7` — ONE `PreviewPane` in the record drawer, shared with eBay, with two sub-views
(`Page` / `Payload`) and a `Desktop | Mobile` skin toggle. Mirrors: `H3` ROW verb
"Preview listing", `H5` `CONTEXT(alias-group)` alias verb, `H6` `SheetToolbar trailing`
"Preview listing", `H10` link-out. At rest the sheet shows NOTHING new.**

**Why H7.** A preview is depth, it is read-only, and it needs 400-900px of continuous vertical
space with the sheet still live behind it — the drawer's exact brief
(`docs/2026-09-01-layout-v2-spec.md` §5). It is not a cell (H1): a description cell holds the *body*
an operator edits; the preview is the composed *page* that body lands in, and it moves when the
gallery, the price, the bullets or the theme move — none of which is that cell. It is not the Images
tab (H8): the gallery is one of four blocks, and the Images tab already owns the slot matrix and
`ChannelTruthPanel`; putting the PDP there would make the *other three* blocks second-class. It is
not H2 (there is no fact to report at rest — a preview is a thing you look at, not a state a row
carries).

**One pane for both channels — the shared-band lesson, applied properly.** Report 10 §6.1B lands on
`H7` + `H6 trailing` + `H10` for eBay, over `SandboxedHtmlFrame` (new DS component, `sandbox=""` +
`srcDoc`; verified: zero `iframe`/`srcDoc` occurrences in `design-system/**`). **We adopt that pane,
that toggle and that DS component unchanged, and add the `Payload` sub-view to it.** The shared
shell owns: the `SegmentedControl` skin toggle, the declared frame width (Desktop 920 / Mobile 375),
the scale-to-fit with the scale **stated on screen**, the `Banner` slot for warnings above the frame,
the `Live | Draft` selector, the sub-view switch and the `Open on <channel>` link. Only the
**renderer inside the frame** is channel-specific: eBay = the themed HTML from
`POST /api/ebay/description-preview`; Amazon = four DS-composed blocks (§6.3). `CockpitPreviewBand`
is the counter-example to imitate: a shared band **nobody mounted** did not prevent two 384px rails.
The pane must therefore be the *only* preview surface, not an optional wrapper.

**Why the verbs, and why not only the drawer.** channel-ops research §3.2 and ruling #110: *a verb
must never live only in the drawer.* `H3` "Preview listing" on the row menu / `⋯` / `RecordActions`
opens the drawer on the Preview pane for that row — structurally identical to `openRecordAction`
(`channelActions.ts:378-399`), including **no preflight** and **no permission gate**: reading is not
`products.edit`. `H5` on the alias band is the *Amazon-mechanical* one: an Amazon PDP is a **parent
page** — one ASIN, one title, one gallery, a variation strip across the children — so the alias band,
not a child row, is the unit whose preview means something. On a child row the pane previews the
parent page **with that child selected**, which is what an Amazon buyer actually lands on. `H6`
trailing gives a scope-level entry so the capability is reachable without opening a record; it opens
the same pane for the focused row, so there is still exactly one preview surface. `H10` carries
`Open on amazon.<tld>/dp/<ASIN>` — for a **live** listing the only 100%-honest "as the buyer sees
it" is Amazon's own page, and `_studio/drawer/listingUrl.ts` already builds it
(`ListingsPane.tsx:60-62` already uses it).

**🔴 Argument against a full tab.** Four reasons, in order of force. (1) **The layout doc forbids
it**: *"Tabs (thin, non-tabular surfaces only)"* (`:59`) lists four tabs and a preview is not among
them; adding a fifth is a layout amendment, not a lane decision. (2) **A tab leaves the sheet.** The
whole reason this pane exists is *comparison* — "the title looks wrong on the page; fix it in the
cell" — and the drawer is non-modal precisely so the sheet stays live behind it
(`layout-v2-spec.md` §5). A tab replaces the sheet with the preview and turns a two-second glance
into a navigation. (3) **Chrome cost, ruling #169.** A tab is permanent 40px chrome and a permanent
entry in every operator's mental model, for a surface used once per publish. (4) **No demand
evidence.** The industry research's 20-item day-one ranking does not contain a PDP preview at all,
and its three-to-build-first are elsewhere (§4). A tab would be the most expensive placement for the
least-evidenced capability. The 384px always-on rail was the same mistake in the old page: a preview
that is always there is a preview nobody reads, occupying width the sheet needs.

### 6.2 What the sheet shows at rest, per scope

| scope | at rest |
|---|---|
| **master** | Nothing. There is no channel to preview; the verb returns `HIDDEN` (the `ListingsPane.tsx:64-74` precedent — say so in words, never render an empty card). |
| **Amazon · market, alias band** | Nothing new. The band already carries readiness % and `externalListingId`; the verb appears in its context menu. **No drift pill, no preview mark** — a preview has no state, and inventing a "previewed 2h ago" chip would be chrome asserting something worthless. |
| **Amazon · market, variant rows** | Nothing new. The verb is on the row menu and the `⋯` column. |
| **eBay · market** | Identical, same verb id, same pane, eBay renderer. |
| **Shopify (single store)** | Verb `DISABLED` with a reason ("no Shopify page renderer yet"), never hidden — `registry.ts:226-229` and `SheetToolbar`'s `AbsentControl` doctrine (`:36-41`). |

No new column, no new view chip, no readiness change. This is the cheapest at-rest footprint of any
feature in this programme, and that is the point: the sheet pays nothing for it.

### 6.3 The interaction, step by step

**Open.** Right-click an alias band → **Preview listing** (`H5`); or a row → **Preview listing**
(`H3`); or `Preview listing` in the toolbar `trailing` slot (`H6`); or open a record and pick the
**Preview** pane. All four land on the same pane. **No COLLECT, no PREFLIGHT, no CONFIRM** — nothing
is written and nothing is fetched from a channel, so a confirmation would be noise
(`channelActions.ts:391-392`, verbatim precedent). `run` calls `deps.openRecord(rowId, 'preview')`
and returns `{ok:true}`; `invalidates: {kind:'none'}`.

**Sub-view `Page`** (default). DS `SegmentedControl` `Desktop 920px | Mobile 375px`; the frame is
scaled to fit 520px and **the scale is stated on screen** (`70%`), never silently. Four blocks,
each from the row the sheet already holds:
1. **Gallery** — DS `Thumbnail` strip + one hero, from `GET /api/products/:id/amazon-images/preview`
   (the ONE extra fetch, §5.11), slot-labelled (`MAIN`, `PT01`…). `missingSlots` renders as an
   explicit `— empty` tile, never as a shorter strip. `hasMain: false` is a DS `Banner`, because
   Amazon rejects the listing (`amazon-image-preview.service.ts:18-19`).
2. **Title** — `row.values['item_name'].mapped.value`, at the real PDP weight, with the `n/200`
   counter and `overLimit` rendered from the server's own verdict (`ResolvedCell.overLimit`), not a
   browser `length`.
3. **Bullets** — `row.values['bullet_point*'].mapped.value` as an `About this item` list. Fewer than
   five is a stated fact, not a red accusation, and it says where the value came from.
4. **Description** — `row.values['product_description'].mapped.value`, **rendered in full inside the
   scrollable frame**. No `line-clamp`. If it contains markup, it goes through the same
   `SandboxedHtmlFrame` the eBay renderer uses.
Above the frame: a `Banner` per `mapped.errors[]`, a quieter one per `mapped.warnings[]`, and an
`autoCorrected {from → to}` note — *"`variation_theme`: `SizeColor` → `SIZE_NAME/COLOR_NAME` (the
schema's spelling; this is what ships)"*. **Nothing is invented**: no stars, no Prime, no buy box, no
shipping, no returns, no compliance placeholder, no Climate Pledge. A `Not shown here` footnote lists
what a real PDP adds that we do not model, with the `Open on amazon.it` link. `Live | Draft`:
`Draft` = what a push would send (the default); `Live` renders the stored channel snapshot when
report 10's pull lands, and until then says **"never checked"** and offers the pull verb rather than
relabelling our draft as Live.

**Sub-view `Payload`** — the fields-being-published table, and the answer to 3.14n. A DS `DataGrid`
over `Object.values(row.values).filter(v => v.mapped)`: `field · value · provenance ·
appliedTransforms · required · warnings/errors · autoCorrected`. Group by `mapped.status`
(`mapped` / `unmapped`) and sort errors first. **It is the same component the publish confirm should
mount** (`AliasPublishControl`), so the table an operator reads *before* clicking Publish and the
table in the Preview pane are one component and cannot drift — the mistake `CockpitPreviewBand`
teaches, avoided by *mounting* it twice rather than merely sharing it.

**DS components:** `Drawer` + `Tabs` (pane host), `SegmentedControl` (skin, sub-view),
`SandboxedHtmlFrame` (new, report 10's — one component, two channels), `Thumbnail`, `Banner`,
`KeyValue`, `DataGrid`, `Pill`, `Tooltip`, `EmptyState`, `Button`, `Menu`/`MenuItemDef` (verb
adapters), `BulkActionBar` (not used — preview is never a selection verb). **No new DS component
beyond report 10's.** The old `PreviewSkinToggle` is replaced by `SegmentedControl`, not ported.

**Keyboard.** The verb inherits `useActionPress`. The skin toggle and sub-view switch are the DS
control's own arrow-key semantics. **Nothing is bound to a bare key.** With the drawer open the sheet
stays live behind it and the drawer's `⌘↑`/`⌘↓` record-walk keeps working — walking rows with the
Preview pane open re-renders the preview per row, which is the cheapest possible "check twenty
listings" flow and is the single strongest argument for the drawer over a tab.

**Persistence.** Skin and sub-view are per-viewer conveniences → `localStorage`, in try/catch, with
the pane rendering correctly on no stored value.

### 6.4 Per-scope rules

- **Master**: verb `HIDDEN`, no pane. There is no channel, therefore no page. The pane renders
  `ListingsPane`'s existing sentence, not an empty frame.
- **Alias band vs variant row (Amazon)**: the band previews the parent ASIN page — one title, the
  parent gallery, the variation strip built from the children's `axisValues`
  (`studio-sheet.service.ts:221`, and `StudioAxis.source: 'stored' | 'declared'` at `:290` means an
  axis with no stored values must render as **absent**, never inferred from the SKU). A variant row
  previews the same page with that child pre-selected. **One pane, one renderer, two entry
  coordinates** — never two components.
- **Shell aliases** (22 measured on prod, childless — `AliasBandCell.tsx:25-28`): the pane must say
  *"this alias has no variants and nothing behind it yet"* rather than render an empty PDP that
  reads as a broken preview.
- **Market channels vs single-store**: the coordinate is `(channel, marketplace, locale)` and the
  pane's title/bullets/description come from that coordinate's own resolved cells, so IT and DE
  differ correctly. 🔴 **The gallery does not**: ruling #8(a) — SP-API image attributes are
  **ASIN-GLOBAL**. The gallery block must state that the images shown are the ASIN's, shared across
  EU markets, and that per-market imagery rides Country-Specific Upload or A+ (ruling #8(b)/(c)).
  A per-market PDP mock with a per-market gallery would assert something Amazon does not do.
- **eBay**: same pane, same toggle, same `Payload` view; the `Page` renderer is the themed HTML
  through `POST /api/ebay/description-preview` (report 10 §6.3), which is *"the same renderer the
  push uses"*.

### 6.5 Provenance / autosave / readiness / publish — and the resolver question

**🔴 Must the preview render from the SAME resolver the publish path uses? YES — it is already
ruled, and the studio already has the answer in hand.** Ruling **#2** (`pes-claims.md:13-15`):
*"one cascade, never a parallel implementation (a preview must RUN the engine)."* The rule is
encoded in `resolve-batch.service.ts:6-8`, and the tree proves the cost of breaking it: the old
compositor's browser-side cascade drifts on **all five** SSOT fields (§5.1) because it never reads
the follow flags the resolver branches on. So: **no client re-derivation, ever, not even for the
title.**

**What that costs — and it is far less than it looks, because of ONE finding.** The Preview pane
does **not** need a new resolver endpoint: `StudioCellValue.mapped` (`studio-sheet.service.ts:144`,
shape `:92-102`) is **already** `resolveBatch`'s `ResolvedCell` for that (product, channel,
marketplace, field), composed in-process (`:916-980`) from the one engine, carrying value,
provenance, applied transforms, warnings, errors, auto-corrections and over-limits. The pane reads
`row.values[key].mapped` — the sheet's own row, no second fetch, `ListingsPane`'s rule honoured, and
by construction the pane and the cell **cannot disagree**. Cost: **one** extra fetch, for the
gallery, which the row genuinely does not carry (§5.11).

**The honest caveat that must ride on the pane, and it is the Owner's call, not a lane's.**
`mapped.value` is what the **mapping engine** would ship. The studio's actual Amazon send
(`publish-amazon` → `buildJsonFeedBody`) reads the **listing columns** instead, and the FM.7 bridge
that would converge them is `off` by default (§5.2). Two options, and only one is honest:
- **(a) Label it.** The `Payload` view says which builder it reflects, e.g. *"Resolved by the mapping
  engine. The Amazon feed currently builds from the listing's own columns (FM_SYNC_AMAZON = off), so
  a mapped-only value may not ship."* Cheap, truthful, and it makes the divergence visible — which is
  how it gets fixed.
- **(b) Converge.** Flip `FM_SYNC_AMAZON` to `shadow`, read the logged diff, then `merge`; or point
  `publish-amazon` at the resolver. A **production behaviour change** on a live channel — PES.5 work
  behind an Owner ruling, not something this pane may assume.
Shipping the pane **without** (a) would be exactly *"a preview that lies about what goes live is
worse than no preview"* (`ebay-description-themes.routes.ts:330`) — with the twist that here the
preview would be right about the *engine* and wrong about the *send*.

**Provenance.** The pane renders `mapped.provenance` (FM.2's vocabulary) beside each field, and
`StudioCellValue.layer` / `pinned` for the stored side, through PES.2's `ProvenanceMark`. It
introduces **no new provenance vocabulary** — the old `FieldSource` six-value enum
(`amazon-cockpit/types.ts:17-23`) is dropped, not ported. Where the two sides disagree,
`StudioCellValue.divergence {publishesAs, note}` (`:119`) already names it and the pane shows it.

**Autosave.** The pane writes nothing. It reads the row the sheet holds, so an autosaved cell edit
repaints the preview on the next sheet read with no pane-specific plumbing. 🔴 One trap: with unsaved
cells queued, the pane shows the **last server-resolved** values, not the operator's keystrokes — the
old compositor's draft bus (`useAmazonCompositor.ts:129`) is exactly what the audit retired
(row 2.20, `pes-parity-audit.md:108`: *"With per-cell autosave there is no pre-save state to
broadcast"*). The pane must therefore **state its freshness** (`as resolved at 14:32 · n cells still
saving`) rather than either lying about being live or silently lagging.

**Readiness.** Untouched. Readiness has ONE server definition (`services/pim/readiness.service.ts`)
and "the preview looks wrong" is not an issue class in it. The pane may *display* readiness issues
for the coordinate; it never computes or contributes one.

**Publish.** Nothing on this pane publishes. `ListingsPane.tsx:6-9` applies verbatim: *"a 'Publish'
button inside a record drawer is exactly how a preview-only channel gets published by reflex."* The
pane's only publish-adjacent act is that its `Payload` table is **mounted inside** the publish
confirm — the reverse direction, which is safe and closes 3.14n. Available in every publish mode
including `gated`: a read is not a publish.

### 6.6 ASCII mockup — the drawer's Preview pane

```
drawer (520px, non-modal, slides over; the sheet stays live behind it)
 Record │ History │ Compare │ Listings │ Preview
┌──────────────────────────────────────────────────────────────────┐
│ Amazon · IT · ASIN B0C7… · alias ① GALE-KAN-PRO   [Open on IT ↗] │
│ (Draft ▾)   [ Page | Payload ]   [Desktop 920 | Mobile 375] 70%  │
│ ⚠ variation_theme auto-corrected: SizeColor → SIZE_NAME/COLOR_NAME│
├──────────────────────────────────────────────────────────────────┤
│ ┌────────── scaled page frame (scrolls inside) ───────────────┐  │
│ │ [MAIN][PT01][PT02][— empty][— empty]      images 3 / 9      │ │
│ │ ┌──────────┐  GALE Pro Racing Suit — Nero, 3XL              │ │
│ │ │  hero    │  🔗 master · item_name · 34/200                │ │
│ │ │  image   │  € 249.00   ✎ pinned · our_price               │ │
│ │ └──────────┘  Colore: Nero Rosso  ·  Taglia: S M L 3XL      │ │
│ │ About this item                                             │ │
│ │  • CE-certified abrasion panels        🔗 master             │ │
│ │  • Removable CE Level 2 back protector 🔗 master             │ │
│ │  (3 of 5 — Amazon shows up to five)                         │ │
│ │ Product description                                         │ │
│ │  Full body, no clamp, scrolls …                             │ │
│ └─────────────────────────────────────────────────────────────┘  │
│ Not shown here: reviews · Prime & delivery · buy box · returns.  │
│ resolved 14:32 · engine payload — the Amazon feed builds from    │
│ the listing's columns today (FM_SYNC_AMAZON = off)               │
└──────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged — no new endpoint for the field half.**
- The studio sheet read the pane is already inside: `GET /api/products/:id/studio/sheet?scope=&
  market=&channel=&locale=`, whose rows carry `values[key].mapped` (`ResolvedCell`) from
  `resolveChannelValues` (`studio-sheet.service.ts:937-964`). **This is the payload.**
- `GET /api/products/:productId/amazon-images/preview?marketplace=&activeAxis=`
  (`amazon-images.routes.ts:371`) — the gallery. One fetch, `products.view`, no channel call.
- `POST /api/ebay/description-preview` (`ebay-description-themes.routes.ts:320`) — the eBay renderer,
  per report 10.
- `_studio/drawer/listingUrl.ts` — the `H10` link-out.
- `GridAction` / `ActionImpact` as they stand; the verb needs neither `preflight` nor `payload`.

**New, server (PES.5) — small, and two of the three are fixes, not features.**
- 🔴 **Pass the slot taxonomy into the image preview** (defect 3): `buildAmazonImagePreview` must
  call `resolveSlotTaxonomy(mkt, productType)` and hand `slotCodes` to `resolveAmazonImages`, exactly
  as `amazon-image-feed.service.ts:313-315` does, and drop its own hardcoded `AMAZON_SLOTS`
  (`amazon-image-preview.service.ts:29`). Until then the pane must state which slot set it rendered.
  This also fixes the OLD `PublishPreviewModal` and `amazon-publish-validator`, which share the bug.
- **Permission reclassification** (defect 4): reading `/api/pim/mappings/**/preview/**` should be a
  read permission, not `pim.manage`. Only relevant if the pane ever calls `previewPayload` directly;
  if it reads `mapped` off the sheet (recommended) this is a hygiene fix, not a blocker.
- **Optional, only if the Owner wants a single composed endpoint:**
  `GET /api/products/:id/studio/outbound?channel=&marketplace=&locale=&aliasId=` returning
  `{fields: ResolvedCell[], gallery: PreviewSlotCell[], builder: 'mapping'|'listing-columns',
  builderNote}`. **Recommended NOT to build it in wave 1** — it duplicates a read the pane already
  has and re-enters the Redis-coupled mapping engine a second time (defect 12).

**Additive schema:** **none.** This feature stores nothing.

**New, client.**
- **PES.4** — `PreviewPane.tsx` (the shared shell: skin toggle, sub-view switch, `Live|Draft`,
  warning banners, scale readout, `Not shown here` footnote, freshness line) + `AmazonPageView.tsx`
  (four blocks) + `PayloadView.tsx` (the fields-being-published table) + one `Tabs` entry in
  `RecordDrawer.tsx:473`. The eBay page view is report 10's; **the shell is written once, by whichever
  of PES.4's two pieces lands first, and the second one mounts it.**
- **PES.3** — the `preview-listing` verb in `channelActions.ts` at `H3` ROW and `H5`
  `contextOf('alias-group')`, added to the `channelActions()` array (`:403`), plus the `H6` trailing
  button in the channel scope's `SheetToolbar` props. No permission gate.
- **PES.2** — nothing new required. `SandboxedHtmlFrame` is report 10's DS.1 item.
- **PES.7** — hands over the gallery contract (`amazon-images/preview`) and keeps the slot matrix
  where it is (`H8`). The two must not merge: the Images tab answers *"is every slot filled"*, the
  pane answers *"does the page read right"*.
- **PES.1** — nothing. Explicitly **no new tab** (§6.1).
- **PES.6** — owns `resolveBatch`; consulted only to confirm that `mapped.value` is the shipping
  value and that `autoCorrected` should be surfaced as the pane plans to.

**Drop at swap (Owner sign-off):** `AmazonLivePreview.tsx` (725 lines),
`useAmazonCompositor.ts` (468), `amazon-cockpit/types.ts`'s `FieldSource`/`ComposedField`,
`_shared/cockpit-preview/**` (54), `_shared/cockpit-shell/CockpitPreviewBand.tsx` (82, already dead).
~1,330 lines out, none of it source.

## 8. Risks and traps

1. 🔴 **A preview that lies is worse than no preview** — and here the specific lie available to us
   is subtle: the pane can be *right about the engine and wrong about the send* (§5.2, §6.5). The
   builder label is not decoration; it is the condition on which this pane may ship.
2. 🔴 **Never re-derive the cascade in the browser.** Ruling #2; §5.1 is the measured cost. The
   temptation is real and cheap — "just show `titleOverride`" — and it is the exact defect being
   replaced.
3. 🔴 **Images are ASIN-GLOBAL** (ruling #8(a)). A per-market PDP mock with a per-market gallery
   asserts a mechanism Amazon does not offer. State the sharing; do not model it away.
4. 🔴 **The slot set is a SET CLAIM** (defect 3). A gallery rendered from the legacy ten reads as
   "3 of 9 filled" on a coordinate whose real taxonomy has more writable slots.
5. **"Could not fetch" ≠ "no images."** The gallery fetch can fail. An empty strip must say *we
   could not read the image plan*, never render as a listing with no images
   (`reference_could_not_measure_vs_measured_empty`).
6. **Freshness, not liveness.** With unsaved cells queued the pane is behind the operator's typing.
   Say when it resolved and how many cells are still saving; do not rebuild the draft bus (audit row
   2.20 retired it).
7. **No channel call, and that must stay true.** Every source here is a DB read. If anyone later
   wires a live Amazon read into the pane, `getAmazonPublishMode()` and the SP-API credential gate
   become relevant and the pane inherits a whole rate-limit story it does not have today.
8. **Local dev writes the PRODUCTION database.** This feature writes nothing at all, which is its
   best property — but the pane must be *verified* to make no write, including on blur of any
   control, because `reference_endpoint_safety_is_not_interaction_safety` was earned exactly here.
9. **Drawer tab overflow.** Four panes today; report 10 proposes two (`ChannelTruthPane`,
   `PreviewPane`), this one shares the second — **five** in 520px. The `Tabs` row needs measuring
   (icon-only or overflow) before either lands, or ruling #169's chrome complaint repeats. PES.4/UX.1
   geometry question, and it is shared: the two reports must not each add a pane unaware.
10. **AI stays dark** (ruling #13). Nothing here generates copy. A cell carrying an `✦ AI draft`
    value previews with that provenance shown, unchanged.
11. **Untouchables.** No edits under `products/amazon-flat-file/**` or `ebay-flat-file/**`. The
    Description Studio's iframe mechanism is **specification to re-derive**, not code to import.
    `AmazonFlatFileService` (the API service) is read as specification only; the cockpit publish
    route's existing reuse of it is not extended.
12. **Per-channel oversell / Amazon EU shared quantity.** The pane may render quantity; it must never
    be read as an inventory statement. Amazon EU quantity is shared, so `In Stock` on IT is not a
    claim about IT alone. Recommendation: **omit the stock line entirely** from the Page view — it is
    the block most likely to be misread and the least useful for catching a broken PDP.
13. **A dead shared component is worse than none** (`CockpitPreviewBand`). The shell ships **mounted
    by both channels in the same wave**, or it ships as one channel's local component and is promoted
    when the second arrives. It does not ship as an unmounted abstraction.

## 9. Open questions for the Owner (max 3)

1. **Do we want a PDP *mock* at all, or the four real blocks in a device frame?**
   *Recommended: the four real blocks — gallery, title, bullets, description — at 920/375, inside a
   device frame, with `Open on amazon.it` for everything else.* The old skin invented eight facts
   (§2 table) including a 4.3-star rating and placeholder engineering copy; chrome we cannot keep
   truthful costs credibility on the parts we can, and the industry ranking does not ask for a PDP
   preview at all (§4). This is the same answer report 10 §9.2 recommends for eBay, which is what
   lets the two share one pane.
2. **Which payload is the truth — and do we converge?** The engine (`resolveBatch`, what the pane
   would show) and the send (`buildJsonFeedBody` from listing columns) are two documents, and FM.7
   was built to bridge them and is `off` (§5.2).
   *Recommended: ship the pane now with the builder stated on screen, and separately ask PES.5 to run
   `FM_SYNC_AMAZON=shadow` on prod to READ the logged diff — a one-deploy, zero-behaviour-change
   measurement the flag was designed for.* Deciding `merge` before seeing that diff would be a
   production change on a guess.
3. **Does the `Payload` table also mount inside the publish confirm (`AliasPublishControl`), closing
   3.14n in the same wave?**
   *Recommended: yes.* It is one component with a second mount, it is the audit's own named gap
   (*"An operator cannot see the outgoing payload before sending"*), and it is the only part of this
   feature with a cost-of-being-wrong high enough to earn priority on its own.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Shared `PreviewPane` shell (skin toggle, sub-view switch, `Live|Draft`, banners, scale readout, freshness line) — **shared with report 10** | PES.4 | **M** |
| `AmazonPageView` — the four blocks off `row.values[].mapped` | PES.4 | **S–M** |
| `PayloadView` — the fields-being-published table (closes 3.14n) | PES.4 | **S** |
| Second mount of `PayloadView` in the publish confirm | PES.3 | **S** |
| `preview-listing` verb at `H3` + `H5`, `H6` trailing button, `H10` link-out | PES.3 | **S** |
| Gallery wiring to `amazon-images/preview` | PES.4 | **S** |
| 🔴 Slot-taxonomy fix in `buildAmazonImagePreview` (defect 3) | PES.5 | **S** |
| Permission reclassification for the payload-preview read (defect 4) | PES.5 | **S** |
| DS `SandboxedHtmlFrame` | DS.1 | **S** *(already costed in report 10)* |
| Drawer `Tabs` overflow geometry for 5+ panes | PES.4 / UX.1 | **S** |
| eBay `Page` renderer | PES.4 | **M** *(report 10)* |
| Payload convergence (FM.7 `shadow` → ruling → `merge`, or point `publish-amazon` at the resolver) | PES.5 | **L**, Owner-gated |

**Total for the Amazon half, excluding the convergence: ~S+M+S+S+S+S+S ≈ one M-sized piece of work**
— because the resolved payload is already in the row (§6.5). That is the single most important number
in this report: this capability was assumed to need a new resolver endpoint and does not.

**Dependencies.**
- **Shares its primary surface with report 10** (eBay preview, §6.1B). The two must land as ONE pane
  or the `CockpitPreviewBand` failure repeats. Whichever lane goes first writes the shell.
- **No dependency on the pull verb** (report 10 §6.1A) for the `Draft` view. `Live` waits on the
  pull's snapshot store and until then says "never checked".
- **Depends on PES.6's `resolveBatch` staying the seam** (`resolve-batch.service.ts:6-8`). If the
  channel-attribute model (`docs/2026-09-04-channel-attribute-model-design.md`, APPROVED 2026-09-05)
  changes how `mapped` reaches the row, this pane follows it rather than forking.
- **Feeds** parity rows **3.17** (closes for both channels only if both page renderers ship) and
  **3.14n** (closes on the `PayloadView` alone). The same pane shell is the natural home for row
  **6.40**'s SERP and JSON-LD previews later — a third consumer, and a reason to get the shell right.
- **Blocks nothing.** No lane waits on this.
