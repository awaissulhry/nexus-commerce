# 27 — TRANSLATION: translate-all on a coordinate, AI translate a locale, locale metadata, add/delete locale, mark reviewed

## 1. What it is (operator terms)

Xavia sells one Italian-authored catalogue across nine marketplaces (IT, DE, FR, UK, ES, NL, PL, SE, US).
Every channel payload needs the market's own language, and the master row is Italian. So a content operator
needs, per product: *which locales exist*, *how complete each one is*, *who wrote it — a person or a model*,
*has a human signed it off*, and one gesture to fill a missing locale. On a channel coordinate (eBay·DE, say)
the same person wants "translate every text field on THIS listing" without retyping. Today that work happens
on the old Locales tab (a per-locale accordion) plus a `Translate` button in the channel tab's toolbar. The
locale a market implies comes from `Marketplace.language` (`schema.prisma:1855`) — the studio already binds
market → locale from it (`_studio/scopes.ts:182-196`).

## 2. Old UI — inventory

| Surface | file:line | What it does | Round-trip? |
|---|---|---|---|
| Locales tab (mounted) | `tabs/LocalesTab.tsx`, mounted at `ProductEditClient.tsx:60,1375` | 1,074-line accordion: master row read-only + one card per `ProductTranslation` | yes |
| Completeness % | `LocalesTab.tsx:117-125` | client-side 4 × 25 % over name/description/bullets/keywords | browser-only |
| Source badge | `LocalesTab.tsx:1030-1053` | `manual` / `ai-<provider>` + truncated model id | from row |
| Reviewed badge | `LocalesTab.tsx:1055-1074` | rendered ONLY when `source` starts `ai-` | from row |
| Edit + autosave | `LocalesTab.tsx:296-380` (`flushLocale`), `:382-410` (`updateField`) | 600 ms debounce → `PUT …/translations/:lang` with `source:'manual'` | yes |
| Add locale | `LocalesTab.tsx:441-470` | an EMPTY `PUT` seeds the row — there is no create endpoint | yes |
| AI translate one locale | `LocalesTab.tsx:477-542` | `POST …/:lang/ai-translate`, clears the locale's dirty set first | yes |
| Bulk translate all addable | `LocalesTab.tsx:548-620` | serial browser loop over `addable`, one POST per locale, no cancel | yes ×N |
| Mark reviewed | `LocalesTab.tsx:625-648` | `POST …/:lang/review` | yes |
| Delete locale | `LocalesTab.tsx:651-700` | `useConfirm` → `DELETE …/:lang` | yes |
| Draft-bus mirror | `LocalesTab.tsx:186-215` | pushes `localeTranslations` into the in-page draft bus so the Amazon/eBay compositors overlay per-locale copy | **browser-local only** |
| Channel `Translate` button | `tabs/ChannelListingTab.tsx:368-377`, bound at `:542` | calls the editor's `translateAll` handle; status via `setStatusMsg` (`:267-291`) | yes ×N |
| translate-all implementation | `_shared/ChannelFieldEditor.tsx:1156-1212` | iterates `manifest.fields`, one `POST /api/products/:id/generate-content` per AI-mapped field, writes via `setBase` → debounced listing autosave | yes ×N |
| per-field translate | `ChannelFieldEditor.tsx:1088-1145` | same endpoint for one field; refuses cross-channel (`:1094`) | yes |
| EN/IT locale columns (Global tab) | `tabs/_shared/LocaleColumn.tsx:33-187`, used by `MasterGlobalSections.tsx:246,252` | side-by-side EN + IT slots with bullet/keyword add-remove-reorder; writes `PATCH /api/products/:id/global` | yes |

Nothing here is dead — `LocalesTab` and `LocaleColumn` both have live importers.

🔴 The channel `Translate` button does not translate. `translateAllFields` calls
`/generate-content` — the listing-wizard GENERATOR — so it re-writes marketing copy from master in the
market's language, straight into the saved listing value, with no draft, no diff, no cost preview, and
`catch { skipped++ }` swallowing every failure (`ChannelFieldEditor.tsx:1204-1210`).

## 3. Backend that exists

**Routes** — `apps/api/src/routes/product-translations.routes.ts`, registered `index.ts:792` with prefix `/api`:

| Method + path | line | Notes |
|---|---|---|
| `GET /api/products/:id/translations` | :59-77 | `{ primaryLanguage, translations[] }` |
| `GET /api/products/:id/translations/:language` | :79-87 | `resolveProductContent` — field-level fallback to master |
| `PUT /api/products/:id/translations/:language` | :89-156 | upsert; primary language **400s** with "PATCH /api/products/:id instead" (:103-109); an `ai-*` source write with no explicit `reviewedAt` resets it to null (:124-131) |
| `POST …/:language/review` | :158-174 | `updateMany reviewedAt: now()`; 404 when no row |
| `DELETE …/:language` | :176-191 | primary refused (:181-185) |
| `POST …/:language/ai-translate` | :218-418 | 503 when `GEMINI_API_KEY` unset (:229-234); rate-limit 60/min/IP (:225); `marketplaceForLanguage()` picks a representative market (:280); `TerminologyPreference` glossary (:281-288); writes `source:'ai-gemini'`, `sourceModel: GEMINI_DEFAULT_MODEL`, `reviewedAt: null` (:330-334, :404-406) |

There is **no** `POST /api/products/:id/translations` (create-locale). Parity row 6.36 names one; it does not
exist — the old UI seeds with an empty `PUT`.

**Also translation-shaped:**
- `POST /api/products/translation-coverage/bulk` — `families.routes.ts:326-384`. Per product × language
  `{ hasContent, fieldCount, reviewed }`. **A ready-made feed for the metadata column.**
- `AI_TRANSLATE_PRODUCT` bulk action — `bulk-action.service.ts:2650-2740`. `targetLanguages[]`,
  `fields?`, `skipReviewed` (default true — never overwrites reviewed copy). Never writes `keywords`
  (:2670-2673). After-snapshot for the diff drawer at `:2155-2170`.
- `translateProductCopy` — `services/ai/translate.service.ts:134`. A real translator (not a generator);
  glossary-aware; refuses under `NEXUS_AI_KILL_SWITCH` (:150). Callers: `field-links.routes.ts:109,431`,
  `bulk-action.service.ts:2700`, `listing-automation/action-handlers.ts:244`.
- PES.6 TRANSLATE link policy — `FieldLinkGroup` (`schema.prisma:1942-1972`): `translatePolicy`
  TRANSLATE|VERBATIM|NONE, `sourceLanguage`, `members` = `[{channel, marketplace, variantId?}]`.
  `linkForCoordinate()` (`resolve-channel-field.ts:459-479`) resolves the target language.
  Planner `services/field-resolution/propagation.ts:79-96`. Routes:
  `POST /api/products/:id/field-links/:fieldKey/propagate-preview` (`field-links.routes.ts:266`),
  `…/cross-channel/propagate-preview` (:340), `…/cross-channel/back-translate` (:423),
  `…/cross-channel/applied` (:451). **All preview/audit — "Read + AI only — NO listing writes here."**
- `{ type: 'translate' }` transform op — `schema-mapping.service.ts:60,153`, auto-added on clone (:577);
  in the resolver it is an inert **deferred marker** that only raises `needsTranslation`
  (`resolve-channel-field.ts:388-391, 592-594`), shipped on the wire (`payload-preview.ts:161`).
- Studio AI lane (D7, BUILT) — `routes/product-enrichment.routes.ts`:
  `POST /api/ai/product-enrichment/estimate` (:76) / `generate` (:104) take
  `{ productIds, market, channel, marketplace, locale, columns, provider }`;
  `GET /api/products/ai/drafts` (:135); `approve` (:189); `reject` (:205). Locale drafts apply through
  `applyTranslationGroup` → `PUT /translations/:lang` (`ai/enrichment/draft.service.ts:507-600`) and stamp
  **both** halves: `source:'ai-anthropic'` AND `reviewedAt: <now>` (:541-544). Locale draft fields are
  capped to the four `ProductTranslation` keys (`:112-118, 136-139`); locale+channel is refused (:625-629).

**Prisma:** `ProductTranslation` `schema.prisma:12544-12569` — `language`, `name`, `description`,
`bulletPoints[]`, `keywords[]`, `source`, `sourceModel`, `reviewedAt`, `@@unique([productId, language])`.
`Product.localizedContent Json @default("{\"en\":{},\"it\":{}}")` at `:146`.
`Marketplace.language` at `:1855`; the seed table is `marketplaces.routes.ts:13-31`.

**Permissions:** `products.translations.edit` exists (`packages/shared/permissions.ts:59`) and the manifest
maps it to `pfx('/api/product-translations')` (`permissions-manifest.ts:381`) — **a prefix no route uses.**
The real paths are `/api/products/:id/translations`, so they fall through to
`RW(F.productsView, F.productsEdit, pfx('/api/products'))` at `:412`. The fine-grained permission is dead
code and translation writes are gated only by `products.edit`. (The same file already documents this failure
mode for `/api/products-ai` — `product-enrichment.routes.ts:19-22`.)

## 4. Studio today

- **Locale IS a scope dimension.** `StudioBar.tsx:51,103-137` renders a `Content locale` picker;
  `scopes.ts:132-135` derives its options from `Marketplace.language`; `scopes.ts:182-196`
  (`defaultLocaleFor`) lands a session on the market's own language; the locale rides the URL cursor
  (parity row 1.15).
- **`Localisation · <LOCALE>` view preset EXISTS** — `sheet/views.ts:167-173` (rule: `storage ===
  'localizedContent'`), labelled with the active locale at `:381`. It shows **one** locale, not locales
  side by side.
- **Localised cells read and write.** Read `studio-sheet.service.ts:674` (`ownValue` →
  `localizedContent[locale][key]`) with a fallback to the master `Product` column (`:638`).
  Write `_studio/sheet/master/masterWrite.ts:35-36` routes `storage==='localizedContent'` to
  `PATCH /api/products/:id/global` with `{ patch: { [locale]: { … } } }` (`:203-206`).
- **AI translate review is built (ruling #107).** `_studio/ai/**` (`AiDraftReview.tsx`, `useAiDraftLayer.ts`,
  `api.ts`) with the `✦ AI drafts (N)` chip (`useAiDraftLayer.ts:85`) and a locale filter throughout
  (`ai/api.ts:22-27,54`). Deliberately **no generate call** — `ai/api.ts:1-12`: *"This file deliberately does
  NOT expose generate — under hub ruling #13 the Owner has held live generation."*
- **Compare pane** supports a locale target in type and query (`drawer/types.ts:621`,
  `drawer/useCompare.ts:74`) with copy-across (`ComparePane.tsx:4`) — but **no lane builds one**:
  master supplies a single `master` target (`MasterSheet.tsx:1751-1754`), channel supplies master + channel
  coordinates (`ChannelSheet.tsx:1365-1382`). Wired, unfed.
- **Provenance vocabulary** already carries `ai` / `aiStale` (`design-system/grid/renderers/provenance.ts:170`)
  with precedence ruled at `:151-160` (#355) and the "a combination earns its own member only when it changes
  where the next click lands" rule (§9.6b).
- **Toolbar slots exist**: `SheetToolbar.tsx:92,94,150,215` — `leading` / `trailing` are ADDITIONS (:15).
- **A readiness column precedent exists**: `MasterSheet.tsx:917`.

**Parity rows:** 3.5 🕳 · 6.35 🔁 partial (metadata missing) · 6.36 🕳 · 6.37 🔁 (superseded) · 6.38 🕳 ·
6.39 🕳 · 7.8 🕳→ now BUILT per #107 (review half only) · 7.9 🕳 · 2.15 🔁 partial (side-by-side blocked on
PES.5's `?locales=`).

**Rulings that bind:** #105 D7 APPROVED → PES.8, AI translate into the enrichment lane, **dark per #13** ·
#107 the apply path is NOT shared (bulk PATCH has no `title` and no locale dimension), locale+channel scope
REFUSED, attributes excluded from locale runs, and *"unreviewed machine copy can PUBLISH today"* flagged to
the Owner queue · layout doc `docs/2026-09-01-product-edit-studio-layout.md:71-72` — "Locale dropdown swaps
content columns; **a Localisation view shows locales side-by-side**"; `:105` — the drawer does
"compare/translate (vs master, another locale, another alias, with copy-across)"; `:131` decision 6 —
"Locales/SEO fold into the sheet + drawer"; `:168` — "`Marketplace.language` gives content locale".

## 5. Defects and slowness

1. **🔴🔴 P0 — the studio's localised write is a silent no-op on every locale except `en` and `it`.**
   `PATCH /api/products/:id/global` hardcodes the locale set three times: the body type declares only
   `en?`/`it?` (`pim-global.routes.ts:70-77`), `validatePatch` loops `for (const locale of ['en','it'])`
   (`:110`) so `patch.de` is neither validated nor rejected, `mergeLocalizedContent` loops the same pair
   (`:152`), and the handler gates on `if (patch.en || patch.it)` (`:347`). With only `patch.de`,
   `Object.keys(data).length === 0` → **`reply.send({ ok: true, changed: false })`** (`:380-382`).
   `masterWrite.ts:211-214` marks every localised cell `{ ok: true }` on `res.ok` and never reads `changed`.
   Net effect: with the locale switcher on DE/FR/ES/NL/PL/SE, typing into Title / Description /
   Bullet points / Search keywords reports **saved** and writes nothing; the read then falls back to the
   Italian master column (`studio-sheet.service.ts:638`) so the cell repaints Italian on reload.
   `FM_CASCADE_ON_SAVE` has the same blind spot (`:396`). **CODE-READ** — cheap live check: PATCH
   `/global` with `{patch:{de:{title:"x"}}}` and read `changed`.
2. **🔴 TWO locale content stores, no sync.** The studio reads/writes `Product.localizedContent[locale]`
   (`studio-sheet.service.ts:674`, `masterWrite.ts:203`); the old tab, the AI-draft approve path, the bulk
   translate action and the coverage endpoint all read/write `ProductTranslation`. Nothing copies either
   way (`grep -rn 'productTranslation' apps/api/src` → 8 files, none of them the sheet or `/global`).
   So an AI-approved German description lands where the sheet cannot see it, and a sheet edit lands where
   the translation metadata cannot describe it. **CODE-READ.**
3. **🔴 `ProductTranslation` content reaches no channel payload.** `resolveProductContent` /
   `…Batch` have **no caller outside their own route** (`translation-resolver.service.ts:200` documents
   "used by the catalog publish path"; grep finds only `product-translations.routes.ts:83`), and
   `apply-mapping.service.ts` contains **zero** matches for `translat`. This directly contradicts ruling
   #107's premise that "`apply-mapping.service.ts` will publish it". Either the ruling banked a claim that
   has since gone false, or the path is somewhere I did not find. **CODE-READ — needs PES.5 to confirm
   before anyone acts on #107's Owner-queue item.**
4. **🔴 Five market→language maps plus the DB column, and they disagree.**
   `translation-resolver.service.ts:32-52` (`BE: 'fr'`) · `field-links.routes.ts:13-17` (`BE: 'nl'`) ·
   `listing-wizard.routes.ts:194` · `listing-wizard/submission.service.ts:152` · and the authority,
   `Marketplace.language`, used by the studio (`scopes.ts:132`) and the column builder
   (`sheet-columns.service.ts:893`). The AI lane picks the hardcoded one (`enrichment/generate.service.ts:297`).
   **CODE-READ.** (`reference_a_list_of_members_is_a_set_claim`.)
5. **🔴 `needsTranslation` is a flag nothing acts on.** `mapping-propagation.service.ts:10` promises "the
   FM.6 apply step fills them"; `apply-mapping.service.ts` has no translation code at all. The `translate`
   transform op is auto-added when cloning a mapping to a new market (`schema-mapping.service.ts:577`), so
   an operator can clone Amazon·IT → Amazon·DE, see `needsTranslation` on the preview, apply, and ship
   Italian. **CODE-READ** (`reference_api_accepts_a_flag_it_ignores`).
6. **Old translate-all is a generator, not a translator, and writes live.** `ChannelFieldEditor.tsx:1156-1212`
   — N sequential `/generate-content` calls (one per AI-mapped field), each result written through `setBase`
   into the listing's saved value via the debounced autosave. No draft, no review, no cost estimate, errors
   swallowed. **CODE-READ.**
7. **`POST …/:lang/ai-translate` does not use the translator.** It calls `ListingContentService.generate`
   (`product-translations.routes.ts:292`) — the marketplace copy generator — while a purpose-built
   `translateProductCopy` with a house glossary sits unused by this route. Two AI paths for one operator
   word. **CODE-READ.**
8. **`AI_TRANSLATE_PRODUCT` never translates `keywords`** (`bulk-action.service.ts:2670-2673`) although the
   model, the studio columns and `/ai-translate` all carry it. **CODE-READ.**
9. **Readiness is locale-blind.** `services/pim/readiness.service.ts` (289 lines) has no `locale` or
   `translat` match — a market whose content is 0 % translated can score `ready`. **CODE-READ.**
10. **Old-tab slowness:** a 1,074-line component; per-locale debounce timers in a ref map
    (`LocalesTab.tsx:161`); an unmount fire-and-forget flush that PUTs after the component is gone
    (`:288-300`); a serial browser fan-out with no cancel for bulk translate (`:548-620`); completeness
    recomputed client-side per render (`:117-125`); and the `localeTranslations` draft-bus overlay
    (`:186-215`) is browser-local state two cockpits depend on. **CODE-READ.**
11. **Side-by-side locales blocked at the contract.** `getStudioSheet` takes ONE locale
    (`studio-sheet.service.ts:842`). PES.2's request to PES.5 is precisely specified —
    `?locales=it,de,fr`, widening only `localizedContent` columns into `<key>@<locale>` carrying the same
    `SheetCellValue` and named in `columns[].locale` (`docs/pes-claims.md:24353-24359`) — and undelivered.
    The Owner-approved layout line (`layout doc:71-72`) is therefore unbuilt. **MEASURED-IN-DOC.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H2 — two derived status columns per locale, `Locale source` and `Reviewed`.** The metadata is the
missing half of parity 6.35, and it is exactly what H2 is for: facts the system reports about a row, filterable,
with a tooltip. They belong beside the localised value columns inside the `Localisation · <LOCALE>` preset, so
the operator sees content and its standing in one horizontal read. `Reviewed` is the column the review workflow
needs a handle on; `Locale source` carries `manual` vs `ai-gemini · gemini-2.0-flash` from
`ProductTranslation.source`/`sourceModel` — a string a cell mark cannot hold.

**H6 — the locale switcher grows a verb group in `SheetToolbar` `trailing`.** `Add locale`, `Delete locale`
and `Translate this coordinate` act on the SCOPE, not on any row, so a row menu cannot host them and a
selection bar would force an operator to tick an arbitrary row to reach a verb that does not touch it — the
correction PES.2 already made for the family verbs (`MasterSheet.tsx:1767-1772`). The switcher is where the
operator already is when they think "this locale is missing".

**H4 + H3 — `Mark reviewed` and `Translate selected` in the action registry.** Signing off is naturally
row-or-selection: an operator reviews the parent's copy, or ticks eight children and accepts them together.
Declared once in the registry and mirrored on the row menu, the `⋯` column, the selection bar and the drawer's
`RecordActions`, per ruling #110/#113. `Translate selected` is the same verb as the H6 one with a narrower
collect step.

**H7 — the drawer's Compare pane IS the Localisation pivot, per field.** It already reads N coordinates and
offers copy-across (`ComparePane.tsx:4`, `useCompare.ts:74`); it needs locale targets fed into
`compareTargets`. That is depth for one field — the right place for "what does this title say in five
languages, copy the French one here" — while the sheet's side-by-side pivot (H2 + `?locales=`) is the breadth.

**H12 — nothing.** No capability from the Locales tab should be dropped.

**Not H1 for the metadata.** A `Reviewed` cell is not something the operator types; making it editable would
invite "mark reviewed" by keyboard fill-down, which is exactly how a review flag becomes worthless.

### 6.2 What the sheet shows at rest

**Master scope × locale = the primary language (`it`):** no translation columns at all. The master row IS the
primary translation (`product-translations.routes.ts:27-29`), so `Reviewed` would be a question with no
subject. The columns appear the moment the locale switcher leaves the primary language — this is the one place
the sheet's column set legitimately changes with the locale.

**Master scope × a non-primary locale:** the localised value columns as today, plus
`Locale source` (`✎ Manual` / `✦ gemini-2.0-flash` / `—` when no row exists) and `Reviewed`
(`✓ 2026-09-04` / `⚠ Unreviewed` / `—`), both read-only, both filterable, tooltip naming the model and the
reviewer. Per-cell provenance is unchanged except for one addition (§6.5).

**Channel scope (Amazon·DE, eBay·IT):** the metadata columns are **absent**, and the toolbar's translate verb
carries a sentence saying why: `ProductTranslation` is master-only, and ruling #107 REFUSED locale+channel
scope because `ChannelListing` has its own per-coordinate content — writing one into the other silently
overwrites a different cell. A channel cell that is inheriting master content shows the ordinary `🔗`; what it
inherits is the master's copy *in the market's language*, and the alias band is where the market is named.

**Single-store channels (Shopify·GLOBAL):** `Marketplace.language` is `'en'` for all three webstore rows
(`marketplaces.routes.ts:29-31`), so the locale switcher has one meaningful position and the verb group reads
`Translate to en` — offered, not hidden, because "already in the source language" is a fact worth showing.

### 6.3 The interaction, step by step

**Mark reviewed (H4/H3).**
`open` — right-click a row, or tick rows and read the selection bar. `collect` — the registry's `collect`
gathers `(productId, locale)` pairs from the selection; the locale is the frame's, never guessed.
`preflight` — one `POST /api/products/translation-coverage/bulk` (`families.routes.ts:326`) returns
`{hasContent, fieldCount, reviewed}` per pair, which yields the `ActionImpact`: rows with no translation row
are `hidden`/`disabled("nothing to review — this locale has no content")`; already-reviewed rows are
`disabled("reviewed on <date>")`. `confirm` — `none` for 1-3 rows, `confirm` above that, level from the
preflight per the registry contract, never a fixed flag. `run` — `POST …/:lang/review` per product (the route
is per-id; a batch is N calls, which is fine at review scale). `repaint` — the `Reviewed` column and any
`unreviewed` cell marks in the affected rows; the `⚠ Unreviewed (N)` chip decrements and disappears at a real
zero (`hideWhenZero`, the honest-count rule PES.8 already follows). DS: `Menu`, `BulkActionBar`
(`patterns/BulkActionBar`), `ActionConfirm`, `Badge`, `Tooltip`. Keyboard: the registry's `useActionPress`
already binds the selection bar; `Enter` on the identity cell opens the drawer, per §5.5 — unchanged.
Drawer open: the sheet stays live, and the drawer's `RecordActions` renders the same verb, so a review done
in the drawer repaints the sheet behind it through the existing `onWrite` path.

**Add / delete locale (H6).**
`Add locale` opens a DS `Listbox` of the locales `Marketplace.language` offers minus the ones that exist
(the same derivation as the switcher, so the two can never disagree) → `POST /api/products/:id/translations`
(new; see §7) → the switcher jumps to it and the sheet re-reads. `Delete locale` preflights with the coverage
endpoint, warns with the field count it is about to destroy, uses `type-to-confirm` when
`fieldCount > 0` (an operator can lose a translated description here), then `DELETE …/:lang`; the switcher
falls back to `defaultLocaleFor(market)`.

**Translate this coordinate (H6) / Translate selected (H4) — DARK.**
`collect` — the rows in view (or selected) × the frame's locale × the localised columns.
`preflight` — `POST /api/ai/product-enrichment/estimate` (`product-enrichment.routes.ts:76`) returns cost and
per-cell caps against the TARGET market's schema (the D7 walk proved the panel groups read `Amazon · DE` caps,
not the source's). The gate pill carries the SERVER's reason — "no AI provider is configured", the
`NEXUS_AI_KILL_SWITCH` message — the way `AliasPublishControl` carries `getAmazonPublishMode()`.
`confirm` — shows N cells × M products and the estimate. `run` — **the studio does not call generate.** Per
ruling #13 and `_studio/ai/api.ts:1-12`, the surface ships built and honest with the button disabled and the
server's own sentence beneath it. When the Owner lifts #13, one `generate` call with
`{ productIds, market, locale, columns }` produces `ProductAiDraft` rows and the whole downstream path already
works: `✦ AI drafts (N)` chip → tinted cells → `AiDraftReview` diff → approve →
`PUT /translations/:lang` stamping `source:'ai-anthropic'` AND `reviewedAt` (`draft.service.ts:541-544`).
**So translate-all DRAFTS; it never writes.** That is the single most important shape change from the old
`Translate` button, which wrote live.

### 6.4 Per-scope rules

- **Master × primary locale:** no metadata columns, no add/delete (the route refuses primary,
  `:181`), translate verb hidden with the reason "this is the source language".
- **Master × non-primary locale:** everything above.
- **Channel scope:** metadata columns absent; translate verb offered but re-targeted — it translates the
  MASTER locale the market implies (`defaultLocaleFor`), and says so in the confirm, because #107 refused
  locale+channel drafts and PES.8 already returns that refusal from the server (`draft.service.ts:625-629`).
  A verb that silently did something else would be worse than one that explains the redirection.
- **Alias band:** no translate verb. An alias is a listing of the same product in the same market and the
  same language; a per-alias translation has no address in any store.
- **Single-store channels:** as §6.2.

### 6.5 Provenance / autosave / readiness / publish

**One new provenance member, `unreviewed`** — a stored cell whose `ProductTranslation.source` starts `ai-`
and whose `reviewedAt` is null. It earns a member by §9.6b's own rule (a combination earns a member only when
it changes where the next click lands): this cell needs a human decision, which is a different next action
from every other member. It ranks directly **below `ai`** (an unapproved draft is not in the record yet;
this one is) and **above `formula`**. A *reviewed* AI translation gets **no** mark — it is simply the value —
and its provenance lives in the H2 column and the tooltip. `refused` still outranks everything (#780).

**Autosave** is unchanged in shape: a localised cell keeps writing on commit through the one `SheetWriter`.
What must change is the route (§7) — today it silently succeeds. A manual edit sets `source:'manual'` and
`reviewedAt: now()` (the `PUT` create branch already does exactly this, `:147-151`): a human typed it, so it
is reviewed by definition. Editing an `ai-*` row must clear `reviewedAt` — the route already has that rule
(`:124-131`) and the studio should send `source:'manual'` so the row becomes manual-and-reviewed rather than
AI-and-stale.

**Readiness** gains a locale term: for a non-primary locale, a scope with 0 % coverage is `warn`, not `ready`.
This belongs in the ONE server definition (`readiness.service.ts`) so the chip, the band and the row agree —
never derived on the client.

**Publish** is where the Owner's decision bites. Ruling #107 flagged that unreviewed machine copy can ship.
Whether that is true today is now in doubt (defect 3), but the *guard* is worth having either way:
`resolveProductContent` should take `requireReviewed` (default on for any publish path) and fall back to
master when a row is unreviewed, so a preflight can say "DE description is unreviewed AI copy" instead of
shipping it.

### 6.6 ASCII mockup — master scope, locale `de`

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]   Market [DE ▾]  Locale [German (de) ▾]         │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 21 rows · 2 selected  [View: Localisation · DE ▾][⚠ Unreviewed (6)]  Find…                 │
│                                    Locale ▸ [+ Add locale][🗑 Delete de][✦ Translate to de]│
├──────────────┬──────────────────────────┬───────────────┬──────────────┬───────────────────┤
│ SKU          │ Title                    │ Description   │ Locale source│ Reviewed          │
├──────────────┼──────────────────────────┼───────────────┼──────────────┼───────────────────┤
│ ▾ GALE-KAN…  │ 🔗 Gale Pro Racing Suit  │ ✦ Der Gale …  │ ✦ gemini-2.0 │ ⚠ Unreviewed      │
│   · KAN-S    │ ✎ Gale Pro Rennanzug S   │ 🔗            │ ✎ Manual     │ ✓ 04 Sep 14:02    │
│   · KAN-M    │ 🔗 Gale Pro Racing Suit  │ 🔗            │ —            │ —                 │
│   · KAN-L    │ ✦ Gale Pro Rennanzug L   │ ✦ Der Gale …  │ ✦ gemini-2.0 │ ⚠ Unreviewed      │
└──────────────┴──────────────────────────┴───────────────┴──────────────┴───────────────────┘
  🔗 inherited from the Italian master · ✎ pinned, manual · ✦ AI, awaiting review · — no de row
  right-click a row → Mark reviewed · Translate this row · Compare across locales
```

## 7. Contracts and data

**Reused unchanged:** `GET/PUT/DELETE /api/products/:id/translations[/:lang]`, `POST …/:lang/review`,
`POST /api/products/translation-coverage/bulk`, `POST /api/ai/product-enrichment/{estimate,generate}`,
`GET /api/products/ai/drafts` + approve/reject, the registry + `SheetToolbar` slots + Compare pane.

**Server changes (all additive):**
1. **PES.5 — settle the store, then fix the write.** Recommendation: `ProductTranslation` is the value store
   for non-primary locales (it already carries the metadata, the review flow, the AI approve path and the
   coverage endpoint), the primary language stays on the `Product` columns (the sheet already falls back to
   them, `studio-sheet.service.ts:638`), and `Product.localizedContent` becomes legacy — migrated once,
   read-only after. Then `masterWrite`'s `localized` route sends `PUT /translations/:locale` instead of
   `PATCH /global`, which fixes defect 1 by deleting its cause rather than adding a fourth locale list.
   The alternative — teach `/global` every locale — leaves two stores and defect 2 alive.
2. **PES.5 — the wire carries translation metadata.** `SheetRow` gains
   `translation?: { source, sourceModel, reviewedAt, fieldCount }` for the active non-primary locale, from the
   same read the rows already do. That feeds the two H2 columns with no second endpoint (the mistake
   `useCompare.ts:1-20` is proud of avoiding).
3. **PES.5 — `POST /api/products/:id/translations`** `{ language }` → creates an empty row, 409 on primary or
   existing. Parity row 6.36 names it; it has never existed.
4. **PES.5 — `?locales=it,de,fr`** on `/studio/sheet`, exactly as PES.2 specified it
   (`pes-claims.md:24353-24359`). Unblocks the Owner-approved side-by-side Localisation view.
5. **PES.5 — `requireReviewed` on `resolveProductContent`**, default on for publish paths (§6.5), and
   confirm or retract ruling #107's premise (defect 3).
6. **PES.5 — one market→language answer.** `languageForMarketplace` reads `Marketplace.language` and the four
   hardcoded copies are deleted (defect 4).
7. **PES.5 — manifest fix:** `permissions-manifest.ts:381` must match `/api/products/:id/translations` (a
   `has('/translations')` matcher placed above `:412`) or the permission is dead.
8. **PES.2 — the two H2 columns** + the `unreviewed` provenance member in
   `design-system/grid/renderers/provenance.ts` (DS-owned vocabulary) + the `⚠ Unreviewed (N)` chip via
   `useRegisterViewChip`.
9. **PES.4 — feed locale targets into `compareTargets`** (`MasterSheet.tsx:1751`); the pane already handles
   them. Add `Mark reviewed` to `RecordActions`.
10. **PES.8 — the dark translate verb** (estimate + gate pill + disabled run) and the locale-scoped
    generate payload; the review/approve half already exists.
11. **PES.6 — decide the `translate` transform op's fate:** implement the fill in the FM.6 apply step, or
    stop auto-adding it on clone (`schema-mapping.service.ts:577`) so it cannot promise what it does not do.
12. **PES.1 — nothing new**; the locale switcher and the URL cursor already carry the dimension.

**Additive schema:** none required. `ProductTranslation` already models everything; only a one-time
`localizedContent → ProductTranslation` backfill migration is needed if change 1 is approved.

## 8. Risks and traps

- **Local dev writes PROD.** `_studio/ai/api.ts:10-11` says it: approving a draft here writes a real
  catalogue value. Any verification of the review flow must use fixture drafts and the seed-and-walk
  precedent PES.8 was authorised under, and tear down with independent verification.
- **Defect 1 means every "it saved" reading on a non-`en`/`it` locale is untrustworthy** until the route is
  fixed. Anyone measuring translation writes today will get a green that means nothing
  (`reference_a_scanner_passing_for_the_wrong_reason`).
- **AI dark (#13).** The translate verb must ship disabled with the server's reason. No `generate` call in
  the studio's client, keeping `ai/api.ts`'s guarantee — a UI that *cannot* call it beats one that chooses not to.
- **`DELETE …/:lang` is a hard delete** with no snapshot; a locale with a hand-written description is
  destroyed. Hence `type-to-confirm` when `fieldCount > 0`.
- **eBay listings in the fixture family are LIVE and DRAFT rows are live too**
  (`reference_ebay_draft_still_live`). Nothing in this feature should touch `ChannelListing` content —
  #107's refusal is the guard, and it should stay a refusal.
- **Untouchables:** the flat-file editors seed `localizedContent` (`amazon/flat-file.service.ts:1697`,
  `ebay-flat-file-create.logic.ts:276`). If change 1 retires that field they must keep working — so the
  migration is additive and the field stays readable, never dropped.
- **Cost.** A translate-all is `products × locales × field-groups` calls
  (`enrichment/generate.service.ts:317`). The estimate must be shown before the confirm, priced through the
  existing `rate-cards.ts`, never a number this feature invents.
- **Per-channel oversell / Amazon EU shared quantity / images-global-per-ASIN** are untouched: this feature
  writes text only, on the master, in one language.

## 9. Open questions for the Owner (max 3)

1. **Which store is the truth for non-primary locale content — `ProductTranslation` or
   `Product.localizedContent`?** Everything else in this report depends on the answer, and today the studio
   writes one while the review flow, the bulk translator and the coverage endpoint use the other.
   *Recommendation: `ProductTranslation`, with `localizedContent` backfilled once and left read-only. It is
   the only one of the two that can express who wrote a translation and whether anyone accepted it — and
   metadata bolted onto a JSON bag is how this split happened in the first place.*
2. **May unreviewed machine copy ship?** Ruling #107 flagged that it can; my read cannot find the path that
   would ship it (defect 3), so the answer may be "no, by accident".
   *Recommendation: make it "no, on purpose" — `requireReviewed` default-on for publish, with the preflight
   naming the unreviewed locale, so the guarantee does not depend on a missing caller staying missing.*
3. **On a channel scope, should `Translate` be offered at all,** given `ProductTranslation` is master-only
   and #107 refused locale+channel drafts? *Recommendation: offer it, re-targeted to the master locale the
   market implies, with the redirection stated in the confirm. Hiding it recreates the old tab's promise
   (`Translate` on eBay·DE) with no successor; silently doing something else is worse than either.*

## 10. Effort and dependencies

| Piece | Effort | Depends on |
|---|---|---|
| Store decision + `/global` write retargeted to `PUT /translations/:lang` (defect 1 + 2) | **M** | Owner Q1 · PES.5 |
| `localizedContent → ProductTranslation` backfill migration | **M** | Q1; additive, pre-approved class |
| Translation metadata on the sheet wire | **S** | store decision · PES.5 |
| H2 `Locale source` + `Reviewed` columns, `unreviewed` provenance member, `⚠ Unreviewed (N)` chip | **S** | wire · PES.2 |
| `Mark reviewed` H3/H4 registry verb (+ drawer mirror) | **S** | coverage endpoint exists · PES.2/PES.4 |
| `POST …/translations` create + Add/Delete locale H6 verbs | **S–M** | new route · PES.5 + PES.2 |
| Translate-all H6/H4, dark (estimate + gate + disabled run) | **M** | PES.8; review half already built (#107) |
| Compare-pane locale targets (the per-field pivot) | **S** | PES.4 only — the pane already supports them |
| `?locales=` + side-by-side Localisation view | **L** | PES.5 contract, then PES.2 column widening |
| One market→language answer; manifest fix; readiness locale term; `translate` transform op decision | **S** each | PES.5 · PES.6 |

Cross-feature dependencies: **feature "AI enrichment / draft review"** (shares the whole approve path),
**"replicate to sibling markets"** (parity 3.9 — the same `translatePolicy` machinery),
**"SEO per locale"** (parity 6.40 — `ProductSeo` has the identical per-locale + review shape and should get
the same two H2 columns rather than a second vocabulary), and **PES.6's mapping clone-to-markets** (which
auto-adds the inert `translate` op today).
