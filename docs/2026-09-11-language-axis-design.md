# Language as an axis of the Product Edit Studio — design and implementation plan

**Status:** 🟡 **FOR APPROVAL.** Design mock built and served at `/design/language-axis` on the dev server
(`apps/web/src/app/design/language-axis/`, frozen fixture, no API, no writes). Written 2026-09-11 by
`nexus-commerce-39` from the Owner's words of the same evening and the audit published the same day
("Studio Language Audit", https://claude.ai/code/artifact/d5dadf31-c424-4b2e-bbba-19eac9ecdbb2). Every
number in §1 was measured that day against the working tree (HEAD `80f6cfb84`, ~1,900 dirty paths) and the
production database through read-only probes; nothing is relayed. Nothing in this document is built
except the mock. The build is specified for a single implementing session in
`docs/2026-09-11-language-axis-build-prompt.md`.

Composes with, and does not reopen: the approved layout (`docs/2026-09-01-product-edit-studio-layout.md`),
the channel attribute model (`docs/2026-09-04-channel-attribute-model-design.md`), the views design
(`docs/2026-09-04-sheet-views-and-full-attributes-design.md`), the cell editing contract
(`docs/2026-09-03-cell-editing-contract.md`), the wave-4 import/export design (`docs/2026-09-02-wave4-design.md`
§2) and the market-features placement design (`docs/2026-09-05-market-features-placement-design.md`, whose
D-J this document settles).

---

## 0. The Owner's words

> "Could you please do an audit on how we are doing on the product information page for each channel, market,
> and multiple languages, and whether this is really the best approach … I want it all to be AAA quality and
> have no inconsistency at all. We must go with the best approach possible to manage multiple thousands of
> products … managing multiple languages across channels through a single product edit studio has to be kept
> in mind."
>
> "I very much agree with you. I want you to build me the design and keep it running on the dev server, and
> then I'll use a large, complex LLM to build it all … making sure everything's AAA quality."

Three asks: (1) the best approach the industry knows for channels × markets × languages, not a local
invention; (2) zero inconsistency — one definition of every fact, on every scope; (3) it must hold at thousands
of products, which means the language dimension has to exist at catalogue level, not only on one product page.

## 1. What was measured (2026-09-11)

| reading | value |
|---|---|
| stores that can hold "the German title of product X" | **16** (7 language-keyed, 4 untagged, 5 channel-specific bags) |
| resolution cascades implemented | **5** — `attribute-resolver.ts:256`, `resolve-channel-field.ts:546`, `content-locale.ts:36`, `etsy/information-content.ts:4`, `translation-resolver.service.ts:126` |
| "primary" languages inside ONE resolver call | **2** — `attribute-resolver.ts:139` (`'en'` for JSON slots) vs `content-locale.ts:4` (`'it'` for columns); a pure probe resolves a product's title to English and its description to Italian in the same call |
| market → language definitions | **12** — 11 code maps + `Marketplace.language`, with three different fallbacks (`it`, `it_IT`, `en_US`, `en`) |
| what those say Amazon **Belgium** speaks | prod row **nl** · `translation-resolver.service.ts:50` **fr** · `outbound-sync.service.ts:280` **fr_BE** · `compliance-resolver.service.ts:271` **fr_BE** · `field-links.routes.ts:15` **nl** · `listing-preflight.service.ts:319` **[fr_BE, nl_BE]** · `marketplaces.routes.ts:1027` **it_IT for every market** |
| can a market carry two languages? | **No, structurally**: `Marketplace.language` is a scalar (`schema.prisma:1945`), `@@unique([workspaceId, channel, code])` (`:1981`) allows one row per market, and `information-locale.ts:7-12` returns HTTP 400 for any other locale |
| master sheet write store vs read store | write → untagged `Product.name/description/…` (`bulk-edit.service.ts:2101`); read → `localizedContent[locale]` (`studio-sheet.service.ts:746`); master row loader omits `translations` (`sheet-rows.service.ts:300-310`) |
| write routing's language axis | none (`studio-sheet.service.ts:542-594`); a channel-scope text edit lands untagged |
| readiness locale terms | `readiness.service.ts`: **0** |
| language control on Amazon / eBay scopes | **none**; the language is the most common one across the market's channels, alphabetical tiebreak (`scopes.ts:190-199`); the channel's own row is read into `fixedLocale` and not used (`contracts.tsx:671-680`) |
| side-by-side languages | approved 09-01 (layout doc :71-72), blocked on `?locales=` (`pes-claims.md:24353-24359`), unbuilt |
| compare pane language target | typed and queried (`drawer/types.ts:624`, `useCompare.ts:65-80`), fed by no host |
| per-coordinate readiness columns | built (`MasterSheet.tsx:932-947`), fed only by the legacy adapter; `/studio/sheet` returns no `coordinates` |
| translation editor in the studio | **none**; the only one is the legacy `edit/tabs/LocalesTab.tsx` (1,074 lines) plus a copy in `ProductDrawer.tsx:4224` |
| channel page load | a **live SP-API** `getDefinitionsProductType` call — `channel-specs/index.ts:60` bypasses the spec cache whenever `accountId` is set, which a channel scope always is; Amazon·IT 4.0 s cold / 0.18 s warm / 3.2 MB; a 50-row family 7.9 MB |
| readiness cost | 1 master read + 1 full sheet read per channel per product per market (`scope-readiness.service.ts:81-87`), 0.41 s warm, no index |
| production shape | 338 products (37 roots) · 977 listings · 20 marketplaces, 9 languages · `ProductTranslation` **1 row** · aliases 0 · formulas 0 · `CategorySchema` 124 rows, 45 MB, **all expired and served** |

The July 2026 proposal `docs/2026-07-31-locale-layer-ll.md` named the conflation exactly ("no row can express
'Italian, any channel'"), compared five vendors, and was never gated: no `LocaleContent` model exists, LL.0 was
never run, no later document cites it. Ruling #107 (09-01) then refused any locale-plus-channel cell — the
opposite default from every reference system — to stop a write mis-routing between two stores. This design
removes the cause of that mis-routing instead of keeping the refusal as the model.

## 2. The principle, and what it changes

**LX.0 — Language is a property of the content. The channel and the market are properties of the delivery.**
A text value is authored once per language; every destination that speaks that language inherits it; a
destination may pin its own value on top. Akeneo (localizable × scopable), Salsify (localized properties),
Pimcore (Localized Fields), inRiver (LocaleString), Shopify Markets (translations shared across markets, plus
market × language localization) and Amazon's own listing model (every value carries `language_tag` and
`marketplace_id`) all encode this. Nexus keeps what none of them has — a STORED outbound tier with read-back —
and adds the tier it lacks.

**The resolution chain, for any cell on any scope:**

```
1. pin        (product, channel, market, language)     ChannelListingTranslation  — the listing's own text
2. language   (product, field, language)               ProductTranslation         — shared by every destination in that language
3. source     (product, field)                         Product columns            — the primary language (PRIMARY_CONTENT_LOCALE, 'it')
4. computed   mapping rule · formula · default
```

**What stays exactly as approved:** one grid re-projected per scope; the scope bar; the alias band; the drawer
with its four panes; autosave through `SheetWriter`; per-cell provenance through `classifyProvenance` and
`ProvenanceMark`; English headers on every scope with the channel's own label in the tooltip (D10); factual
attributes never per-language (#107's second half: a code with a localized label, never per-language free text);
`ChannelListing` as the stored outbound tier; the cell editing contract; the views engine; import/export.

**What changes, in one line each:** one store for non-primary text · one resolver · one market-to-languages
table · write routing with a language axis · readiness per (coordinate, language), materialised · language
chips inside every scope · the Languages side-by-side view · one cell vocabulary on both scopes · the compare
pane fed · a language column and one bulk verb at catalogue level · every publish path stamping its language
from the resolved value.

## 3. Vocabulary and the one contract

Every lane uses these names. A second spelling of any of them is a defect.

```ts
/** ISO 639-1, lowercase, language only (Owner decision D4). 'de-DE' normalises to 'de' at every boundary. */
export type ContentLanguage = string

export interface Coordinate { channel: string; market: string; accountId?: string; aliasId?: string }

/** Where a text value is addressed. Exactly one of these per write and per read. */
export type ContentAddress =
  | { tier: 'source' }                                            // Product columns, primary language
  | { tier: 'language'; language: ContentLanguage }               // ProductTranslation
  | { tier: 'pin'; language: ContentLanguage; coordinate: Coordinate } // ChannelListingTranslation

export interface ResolvedContent {
  value: unknown
  /** The tier that ANSWERED. `computed` when a rule/formula/default did. */
  tier: 'pin' | 'language' | 'source' | 'computed'
  /** The language of the value actually returned — differs from the requested language on a fallback. */
  language: ContentLanguage
  requested: ContentLanguage
  /** What the cell's mark says. Same vocabulary as the DS `CellProvenance`, plus the fact that names `from`. */
  provenance: { member: CellProvenance; from: string | null }
  translation?: { source: 'manual' | 'ai' | 'translated'; reviewedAt: string | null; outdated: boolean }
}
```

The DS `CellProvenance` vocabulary (`design-system/grid/renderers/provenance.ts:61`) gains **one** member,
`outdated` — "a translation older than the source it was written from". It earns a member under the §9.6b rule
because its next click differs (open Compare against the source; re-translate or mark reviewed). `aiStale`
stays for machine drafts. No other member is added; a value inherited from the language tier is `inherited`
with `from` naming the language ("German · shared"), a fallback to the source is `inherited` with `from` =
"Italian · source". The mark names the tier that answered, and the tooltip says where the next click lands, as
every member already does.

## 4. Data model (LX.1–LX.6) — all additive

### LX.1 `ProductTranslation` is the language tier (Owner decision D2)
It already holds `name`, `description`, `bulletPoints`, `keywords`, `source`, `sourceModel`, `reviewedAt`,
keyed `(workspaceId, productId, language)` — and children are full `Product` rows, so per-variant text needs no
new key. Add, additively:

```prisma
attributes   Json     @default("{}")   // family-declared localizable attributes (the set validateLocalizedPatch already whitelists)
sourceHash   String?                   // sha256 of the SOURCE text at authoring time — `outdated` = hash ≠ current source
authoredAt   DateTime?
version      Int      @default(0)      // optimistic CAS, the same discipline as Product.version
```

`Product.localizedContent` is **backfilled once into this table and becomes read-only** (LX.6). The
`_meta` review fingerprints in the JSON slot become `sourceHash`/`authoredAt`/`reviewedAt` on the row.

### LX.2 `Marketplace.languages String[]` is the ONLY market-to-languages authority (Owner decision D3)
```prisma
languages    String[] @default([])     // ordered; [0] is the market's default content language
```
Backfill: `languages = [lower(language)]` for every row; then set Belgium to `['nl','fr']` (or as the Owner
decides — the prod row says `nl` today). `language` stays as a column, always equal to `languages[0]`, until
every reader is on `languages`; then it is dropped in a later release. **One accessor**,
`marketLanguages(channel, code): ContentLanguage[]`, reads the row by `(channel, code)` — never by code alone
(`sheet-columns.service.ts:1079` matches on code and cannot tell Amazon·DE from eBay·DE). **One function**,
`languageTag(language, code)`, derives Amazon's regional tag (`de`+`DE` → `de_DE`, `en`+`UK` → `en_GB`,
`nl`+`BE` → `nl_BE`) — the twelve definitions in Appendix A are deleted, and a test fails the build if a
literal `it_IT` or a code-only lookup reappears in `apps/api/src`.

### LX.3 `ChannelListingTranslation` is the pin tier for text
```prisma
model ChannelListingTranslation {
  workspaceId      String   @default(dbgenerated(...))
  id               String   @id @default(cuid())
  channelListingId String
  channelListing   ChannelListing @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  language         String
  name             String?
  description      String?
  bulletPoints     String[] @default([])
  keywords         String[] @default([])
  attributes       Json     @default("{}")
  source           String?
  reviewedAt       DateTime?
  version          Int      @default(0)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@unique([workspaceId, channelListingId, language])
  @@index([channelListingId])
}
```
The existing `ChannelListing.title` / `titleOverride` / `descriptionOverride` / `bulletPointsOverride` columns
are the **legacy pin for `marketLanguages(...)[0]`**: the resolver reads them as a pin in that language until
LX.6's blanking step, after which they are ignored and later dropped. `overrideData` stays for
language-independent attribute overrides (untagged is correct for a fact). `platformAttributes` (the Amazon
arrays with `language_tag`) stays the outbound store — the resolver never reads a value from it, the publisher
always writes into it.

### LX.4 One locale normaliser
`normalizeLanguage(tag): ContentLanguage` — lowercases, strips the region (`de-DE`/`de_DE` → `de`), rejects
anything that is not `^[a-z]{2,3}$`. Applied at every read and write boundary (routes, services, import). A
one-off migration folds any `de-DE`-style key in `localizedContent`, `ProductSeo.locale`, `ProductAiDraft.locale`
and `CellFormula.locale` (Appendix C lists the grains found). `PRIMARY_CONTENT_LOCALE` is the one primary;
`attribute-resolver.ts:139`'s `DEFAULT_LOCALE = 'en'` is deleted.

### LX.5 `ReadinessIndex` — readiness is materialised, per (coordinate, language)
```prisma
model ReadinessIndex {
  workspaceId  String  @default(dbgenerated(...))
  id           String  @id @default(cuid())
  productId    String
  channel      String?     // NULL = the shared product
  market       String?
  language     String
  pct          Int?        // NULL = not scorable (no schema / no mapping) — never 0
  state        String      // the SCOPE vocabulary: ready | warn | blocked | absent
  missing      Json        // [{ field, label, reason }]
  computedAt   DateTime
  @@unique([workspaceId, productId, channel, market, language])
  @@index([channel, market, language, state])
}
```
Refreshed by the same request that wrote the value (synchronous, inside the write's transaction boundary, the way
formula recalculation already runs — "producer + consumer in one write"), and by a nightly reconcile. Read by
the scope bar, the Needs-attention page and the catalogue grid instead of recomputing a sheet. **Rule:** a
required text field counts as FILLED for language L only when the resolved value's `language === L`. Showing
the Italian source on Amazon·DE is `blocked` for German, never `ready`.

### LX.6 Retire `Product.localizedContent` in three gated steps
(a) backfill into `ProductTranslation` (idempotent, reversible: the JSON is not dropped); (b) every reader on
the resolver, the JSON read-only; (c) a later release drops the column. The flat-file editors seed the JSON
(`amazon/flat-file.service.ts:1697`, `ebay-flat-file-create.logic.ts:276`) and are untouchable — step (a)
re-runs on their writes until (c), and the seed default changes to `{}` (the `{"en":{},"it":{}}` default is one
of the hardcodes). `GET /products/:id/global` reports every language present, from the table.

## 5. The resolver (LX.7)

**One exported function**, in `services/pim/content-resolver.ts`:

```ts
resolveContent(input: { product; parent?; listing?; field; address: { requested: ContentLanguage; coordinate?: Coordinate } }): ResolvedContent
resolveContentBatch(...)  // the sheet's shape: every field × every requested language for a family in one pass
```

Order per §2. The five implementations in §1 are deleted behind it: `attribute-resolver.ts`'s locale branches,
`resolve-channel-field.ts`'s value pick (it keeps mapping/transform/link and CALLS the resolver for its source
value), `content-locale.ts`'s `sourceContent`/`contentSlots` (kept only as the LX.6 backfill reader),
`etsy/information-content.ts` and `shopify/listing-information-plan.ts` (their locale bags become pins in
`ChannelListingTranslation` for the store's languages), `translation-resolver.service.ts` (its route calls the
resolver). `FieldLinkGroup.translatePolicy`/`sourceLanguage` stay as the link semantics they are; the group
stores no value today and stores none after.

**The gate before the flag flips:** a shadow run over EVERY (product × coordinate × field) in production, old
cascade vs new resolver, read-only. Zero diffs, except a written list of reclassifications the Owner has seen
(e.g. a `de-DE` slot now found; a coordinate whose language changed from a code map's answer to the row's). The
same instrument as LL.3 specified. A diff that is not on the list is a defect in the new resolver, never a
reason to widen the list.

## 6. Write routing (LX.8)

`resolveWriteRouting()` (`studio-sheet.service.ts:542-594`) gains the language axis and stays the one pure
function both scopes call:

| the operator edits | on scope | the write lands on | provenance after |
|---|---|---|---|
| a text field, language = primary | Shared product | `Product` columns (unchanged path) | `own` |
| a text field, language ≠ primary | Shared product | `ProductTranslation[language]` via `translation-write.ts` (CAS, review stamp, audit with `metadata.language`) | `own` (human) / `ai` (draft approve) |
| a text field whose cell is `inherited` from the language tier | channel | **asks**: "Edit the shared German" → `ProductTranslation[language]` + the same-language cascade · "Pin on Amazon · DE · de" → `ChannelListingTranslation[listing, language]` · decline → the cell reverts | `own` on the tier / `pinned` |
| a text field whose cell is `pinned` | channel | `ChannelListingTranslation[listing, language]` | `pinned` |
| a text field whose cell is `inherited` from the source (no text in this language yet) | channel | the same question, worded for the source: "Write the shared German (new)" / "Pin here" | as above |
| a non-text attribute | either | unchanged (`overrideData` / master columns / `platformAttributes` path) | unchanged |

**Rules that bind:** every write carries a `ContentAddress`; a write without one is refused with the reason
naming the field (the server's sentence, verbatim in the cell — #780's rule). The same-language cascade in
`master-content.service.ts:167-169` runs for EVERY language-tier write, from every caller (today only the global
route passes `locale`; the sheet's bulk path fans out to every language — that is defect 6 in the audit and it
closes here). No write may cross tiers silently: #107's refusal survives as "a pin never becomes a shared value
without the acknowledgement". Paste and fill-drag go through the same router with the same validation
(D15.12). `x-nexus-formula-cascade` re-entrancy applies unchanged.

## 7. Readiness (LX.9)

Per (coordinate, language), from `ReadinessIndex`. The scope bar chip shows the **pressed** language; its tooltip
lists every other language of that scope with its state. The Needs-attention page gains a (coordinate, language,
missing fields) list. The catalogue grid shows one language's readiness column at a time (§9). Required-ness
still comes from the channel schema and the family; only the "is this filled" test changes (LX.5's rule).
`null` renders `—`, never `0%` (the ScopeBar's own rule).

## 8. The screen (LX.10–LX.16)

**LX.10 Language chips inside every scope.** `StudioBar` renders ONE `FilterChip` per language the scope can
carry, in the `right` slot beside the market listbox, on every scope. Shared product: the union of every active
market's languages, the primary chip labelled "· source". Channel scope: `marketLanguages(channel, market)`. In
the single-language sheet exactly one chip is pressed; pressing another switches. The listbox on master /
Shopify / Etsy and the absence on Amazon / eBay both go. `defaultLocaleFor` becomes `marketLanguages(...)[0]`
(no tiebreak); `fixedLocale` is deleted; `assertInformationLocale` becomes "language ∈ marketLanguages" and its
refusal names the market's languages. The hardcoded lists at `contracts.tsx:670` and `LocalesTab.tsx:66` go.

**LX.11 The Languages view.** `GET …/studio/sheet?locales=it,de,fr` widens every localizable column to
`<key>@<locale>` carrying the same `SheetCellValue`, `columns[].locale` set, grouped by FIELD (a translator reads
the source beside each language). Exactly PES.2's specification (`pes-claims.md:24353-24359`). It is a saved view
("Languages") with the chips multi-pressed; the single-language sheet is unchanged. Toolbar chips: Needs
translation · AI drafts · Out of date, each a `useRegisterViewChip` chip with a real count. **Both scopes build
their columns through ONE module-level `buildSheetColumns(scope, …)`** — the channel's 285-line inline memo
(`ChannelSheet.tsx:1115-1400`) is hoisted next to `buildMasterColumns` and tested (the "two column builders
drift" trap, closed).

**LX.12 One cell vocabulary.** The sheets render every cell through `ProvenanceMark` with `from` naming the tier;
`SourceIndicator` leaves the sheets (it stays a DS component for the drawer and elsewhere). `CellProvenance +=
'outdated'` with its class, tooltip sentence and precedence (`refused > ai/aiStale > outdated > formula > mapped >
inherited/inheritedOverride/pinned > own`). `channel/value-source.ts` and the inline branch in
`master/columns.tsx:192-196` are replaced by one DS `describeCellSource(resolved)` both scopes call. The two wire
mirrors (`sheet/master/types.ts`, `sheet/channel/types.ts`) get the drawer's parity test
(`drawer/api-source.testutil.ts` pattern) so a field added on one side fails the build until it exists on the
other. `translationState` / `requestedLocale` / `effectiveLocale` on the wire become the `ResolvedContent`
fields of §3.

**LX.13 The compare pane, fed.** `compareTargets` on both hosts = every language of the field (source first) +
every coordinate carrying it; copy-across writes through the router with the target's `ContentAddress` (a copy
onto a coordinate is a pin and says so).

**LX.14 The acknowledgement.** Editing a language-inherited cell on a channel scope shows the DS `Banner`
(tone `warning`) with both answers on it and the reach named ("Amazon · NL and Amazon · BE (nl)"); declining
reverts the cell (the existing master-routed acknowledgement, re-worded for the tier). Copy in the mock, S3.

**LX.15 Readiness on screen.** Scope chip per pressed language (§7); the readiness matrix and the Needs-attention
list as in the mock, S5; the per-coordinate readiness columns on the master sheet (`MasterSheet.tsx:932-947`)
are either fed from `ReadinessIndex` or deleted — not left dead.

**LX.16 Retire the legacy edit page** (`/products/[id]/edit` with `LocalesTab.tsx` and the copy in
`ProductDrawer.tsx:4224-4331`) once LX.11 is on screen (Owner decision D6). Two live surfaces for one product is
an inconsistency of its own.

## 9. Catalogue level (LX.17–LX.19)

**LX.17 A language column on `/products/next`.** The grid is already server-side paged (`POST /api/products/grid`,
block 100). Add a `Language` selector to its toolbar; the grid gains `title@<lang>`, `description@<lang>` (with
marks) and `readiness@<lang>` (from `ReadinessIndex`) columns for the selected language. Sorting and filtering
by readiness state and by "falls back to source" are server-side predicates on the index.

**LX.18 One bulk verb: Translate.** Filter-scoped (every product the grid's filter matches), not capped at 200;
**preview first** — counts (get a draft / already have one / skipped), the cost from `rate-cards.ts`, the reach
("lands on the shared German text; every listing that follows it inherits on approval"); runs as ONE
`BulkOperation` that lands `✦` drafts on the language tier and is revertible as a run (D15.13). Machine copy
never reaches a listing unreviewed (Owner decision D7): `requireReviewed` is the publish default and the preflight
names the unreviewed language. The existing `AI_TRANSLATE_PRODUCT` action is retargeted to this verb (it stays
sequential per product; parallelism is a later gate with its own measurement).

**LX.19 Import/export carry the language.** The `key@channel:market:locale` header row of D15.2 is the one
form; the catalogue workbook's locale sheets (`catalog-workbook-scopes.ts`) write the language tier through
the same router; "Blank cells: ignore / clear" applies per language.

## 10. Publish (LX.20)

Every Amazon publish path (`outbound-sync.service.ts`, `marketplaces.routes.ts:1027-1036`, the flat-file
generators, `amazon-batch-feed.service.ts`) stamps `language_tag` from `languageTag(resolved.language, market)`;
a market with two languages emits one entry per language, each resolved through the chain in that language.
eBay: the site's language is the market's `languages[0]`; a second language is out of scope (eBay sites are
one-language). Shopify: the language tier maps to the Translations API per language, a pin maps to a market
localization — the same three tiers Shopify itself has. The existing publish snapshot / restore-to-draft path
gains the language on its rows.

## 11. Order of work, gates, rollback

| step | what | gate | rollback |
|---|---|---|---|
| **0 · Measure** | read-only job over production: per (product, field, language) is text byte-identical across channels or genuinely per-channel; rows in the JSON slot vs `ProductTranslation` per language; every marketplace row's languages; any `de-DE`-style keys | the numbers in front of the Owner; the JSON-vs-table count sizes the backfill | none (read-only) |
| **1 · Store** | LX.1 columns · LX.6(a) backfill · `GET /global` reads the table | backfill count = JSON slot count; a re-run is a no-op | the JSON is untouched |
| **2 · Authority** | LX.2 `languages[]` + backfill · `marketLanguages` / `languageTag` · delete Appendix A's maps · the guard test | guard green; every deleted map's callers on the accessor; Belgium's languages as the Owner decides | `language` column still there |
| **3 · Resolver** | LX.4 normaliser · LX.7 resolver + batch · shadow gate | zero diffs across the catalogue (reclassifications listed and seen) | flag off = old cascades |
| **4 · Write routing** | LX.8 · LX.3 table · the acknowledgement · cascade from every caller · audit rows with language | one positive-control write per path on the XAVIA fixture, read back after ≥8 s, restored by value; the zero-change trap applied | new table unused when flag off |
| **5 · Readiness** | LX.5 index · producer in the write · reconcile job · LX.9 rule · scope chip / Needs attention / matrix | an untranslated market reads `blocked`; matrix on screen on every coordinate | index ignored when flag off |
| **6 · Screen** | LX.10–LX.16 (chips · Languages view · `outdated` · one vocabulary · compare · banner · parity test · builder hoist · legacy page retired) | seen on screen on every scope at 1440 (the programme's ✅ bar); `check-editor-open.mjs --strict` green; `check-layout-v2` §9.1 green | per-feature flags |
| **7 · Catalogue** | LX.17–LX.20 (grid column · Translate verb with preview + revert · import/export key row · publish tags · spec cache honoured on channel scopes) | "fill the German title for 3,000 products" is one verb with a preview and a revert; a channel page load makes no SP-API call (schema-age stamp = DB date) | verb hidden when flag off |

Steps 1–3 are server-only and invisible; 4–5 change behaviour behind a flag; 6–7 are the visible product.
Each step is separately gated by the Owner on the measured record, and nothing is committed except by the
Owner's word (the programme's standing rule).

## 12. Verification protocol (binds the implementing session)

- **Local dev writes PRODUCTION** (`:8091` is the prod database). Rehearsal writes only on the XAVIA test family,
  announced in `docs/pes-claims.md` before the write, restored **by value** afterwards, with a delayed re-read
  (≥ 8 s) — never a status code as proof (`reference_read_before_the_write_arrived`,
  `reference_transport_failure_write_is_unknown_outcome`).
- **A zero-change round trip proves nothing** — every write path gets a positive control that flips one cell
  and reads it back (`reference_zero_change_round_trip_cannot_test_the_write`).
- **✅ means seen on screen**, at 1440 and 1728, both themes, on every scope — a unit test cannot see a button
  that ignores its verdict (PES.3's closing note). The Owner's walkthrough on a visible window is acceptance.
- **Editors:** AG 36 React editors commit only through `props.onValueChange`
  (`reference_ag36_react_editor_onvaluechange`); the fill handle and paste go through the validator; the
  open-gesture gate (`scripts/check-editor-open.mjs --strict`) stays green after every column change.
- **Two column builders drift; a list of members is a set claim** — derive language lists from
  `Marketplace.languages`, never a literal; assert parity of the two wire mirrors in a test.
- **A quiet measurement is not a negative result; could-not-measure ≠ measured-empty** — every probe carries its
  positive control in the same run.
- **Tree etiquette:** claim in `docs/pes-claims.md` before editing; one owner per file; tsc scoped to your files
  (`scripts/typecheck-scoped.mjs`) with `uptime` load < 8; browser gates announced and run alone; never commit
  unless the Owner says; never `git add -A` (317 untracked probe scripts).

## 13. Lane split and effort

One implementing session can run steps 0–7 in order. If parallelised: **A** (server: LX.1–LX.7, steps 0–3) →
**B** (server: LX.8–LX.9, steps 4–5) → **C** (web: LX.10–LX.16, step 6, can start its DS half — `outdated`,
`describeCellSource`, the parity test, the builder hoist — as soon as A's contract types exist) → **D**
(catalogue + publish: LX.17–LX.20, step 7, after B). Effort, honestly: A **M**, B **M**, C **L**, D **M**.

## 14. Decisions only the Owner can make

| # | decision | recommendation |
|---|---|---|
| **D1** | Should a channel inherit the language tier by default (reversing #107's default)? | **Yes.** #107 refused a write mis-routing; the language axis on the router removes it. Keep the refusal for the case it was written for: a pin never silently becomes a shared value. |
| **D2** | Store of truth for non-primary text: `ProductTranslation` or the JSON slot? | **The table.** It can say who wrote a translation and whether anyone accepted it; the slot cannot. |
| **D3** | Model multi-language markets now (`languages[]`)? | **Yes.** Additive and cheap; seed only the languages you sell in. Deferring keeps the twelve maps, because each exists to answer this question. Belgium: `['nl','fr']` unless you say otherwise. |
| **D4** | Locale grain: language (`de`) or language-region (`de-DE`)? | **Language.** No product has regional variants; Amazon's tag is derived at publish; changing later is one column migration. |
| **D5** | Factual attributes as codes with localized labels? | **Yes, as its own gate after step 5.** Largest item; touches the flat file. |
| **D6** | Retire the legacy edit page? | **When the Languages view is on screen, not before.** |
| **D7** | May unreviewed machine copy publish? | **No, on purpose.** `requireReviewed` default-on for publish; the preflight names the unreviewed language. |

## Appendix A — the twelve market → language definitions to delete (keep only `Marketplace.languages`)

`services/products/translation-resolver.service.ts:33-55` · `:75-84` · `services/outbound-sync.service.ts:278-281`
(+ `:300` fallback) · `services/amazon/flat-file.service.ts:41-48` (+ `:1684, 2707, 3150`) ·
`services/categories/marketplace-ids.ts:20-30` (+ `:34`) · `services/channel-batch/amazon-batch-feed.service.ts:58-64` ·
`routes/listings-syndication.routes.ts:124-126` · `routes/field-links.routes.ts:13-17` ·
`routes/listing-wizard.routes.ts:181-194` · `services/listing-wizard/submission.service.ts:139-152` ·
`services/listing-automation/triggers.ts:78-79` · `services/reviews/review-insert-pdf.service.ts:36-52` ·
`services/listing-preflight.service.ts:311-320` (its two-language fact moves into the row) ·
`routes/marketplaces.routes.ts:1027, 1030, 1036` (literal `it_IT`) · `routes/pim-global.routes.ts:51-53, 165-167`
(GET's `en`/`it`) · `schema.prisma:148` default `{"en":{},"it":{}}` · web: `_studio/contracts.tsx:670`,
`edit/tabs/LocalesTab.tsx:66`, `sheet/channel/ChannelSheet.tsx:348, 1098` (`?? 'it'`).

## Appendix B — the five resolvers to collapse

`services/pim/attribute-resolver.ts:256-370` (locale branches; `DEFAULT_LOCALE` at `:139`) ·
`services/pim/resolve-channel-field.ts:546-663` (value pick only; mapping stays) · `services/pim/content-locale.ts:36-47`
(`sourceContent`; `contentSlots` kept as the backfill reader) · `services/etsy/information-content.ts:4-19` ·
`services/products/translation-resolver.service.ts:126-136`. Related readers that must move to the resolver:
`services/pim/studio-sheet.service.ts:674-746`, `sheet-rows.service.ts:300-434`, `shopify/listing-information-plan.ts`,
`listings-syndication.routes.ts:121-138` (`extractLocaleTitle`), `images/product-media.service.ts:33-35`.

## Appendix C — the sixteen stores and their disposition

| store | disposition |
|---|---|
| `Product.name/description/bulletPoints/keywords` | **keep** — tier 3, the source |
| `Product.localizedContent[locale]` + `_meta` | **backfill → read-only → drop** (LX.6) |
| `ProductTranslation` | **keep, becomes tier 2** (LX.1) |
| `ChannelListing.title/description` + `*Override` | **legacy pin for `languages[0]` → blank → drop** (LX.3) |
| `ChannelListing.overrideData` | **keep** for language-independent attributes |
| `ChannelListing.platformAttributes.attributes.*[]` (Amazon) | **keep** — outbound store, written by the publisher only |
| `_etsyInformationLocales`, `_shopifyInformationLocales`, `_nexusLinkedProducts.sheetValues[].locale` | **migrate into `ChannelListingTranslation` pins** |
| `_productMediaLocales` | keep (media captions are a media concern; normaliser applied) |
| `flatFileSnapshot` | keep (verbatim snapshot, untouchable) |
| `ProductSeo`, `APlusContent`, `BrandStory` | keep; normaliser applied to `locale`; readiness may read SEO per language later |
| `ProductAiDraft.locale`, `CellFormula.locale` | keep; normaliser applied |
| `AssetLocaleOverlay.locale` | keep |

## Appendix D — what the mock shows, scenario by scenario (`/design/language-axis`)

S1 the scope bar on three scopes (LX.10) · S2 the Languages view (LX.11, LX.12) · S3 a channel scope reading
through the tier, with the acknowledgement (LX.8, LX.14) · S4 the cell vocabulary incl. `outdated` (LX.12) ·
S5 the readiness matrix and Needs attention (LX.5, LX.9, LX.15) · S6 the compare pane fed (LX.13) · S7 the
catalogue grid's language column and the Translate preview (LX.17, LX.18) · S8 the chain and the one table
(LX.2, LX.7).
