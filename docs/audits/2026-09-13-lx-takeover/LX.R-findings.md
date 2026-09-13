# LX.R — independent quality review of the landed language axis (read-only)

**Lane:** LX.R, agent of `[3aec8721]`. **Claimed** at the bottom of `docs/pes-claims.md`.
**Window:** 2026-09-13 04:29Z – 07:0xZ. **Nothing edited, no browser, no database row written, no provider call.**
Only this file was created. Every `grep` in this review was `/usr/bin/grep`; every set claim below either derives its
members from source or names the positive control that fired in the same run.

## Ranking at a glance

| # | sev | one line | file:line |
|---|---|---|---|
| P0-1 | P0 | a two-language market emits two byte-identical `language_tag` entries when the language tier is empty | `pim/amazon-content-payload.ts:22,49-57` |
| P0-2 | P0 | D7 is enforced on the Amazon builder only — eBay/Shopify/Etsy/syndication have no review gate | `pim/amazon-content-payload.ts:43-46` · 5 files at 0 hits |
| P1-4 | P1 | an untranslated required field raises TWO error issues for one field | `studio-sheet.service.ts:1496` + `readiness.service.ts:234` |
| P1-5 | P1 | `ReadinessIndex` is empty on production and nothing backfills it; the reader is index-only | `scope-readiness.service.ts:35` · prod rows **0** |
| P1-6 | P1 | `channelSnapshot` has no word in the drawer's layer map → `unknown` on `source`-only payloads | `drawer/types.ts:356-379` · test red |
| P1-7 | P1 | an untranslated market publishes source text as `it_DE` / `it_ES` / `it_FR` (a QUESTION, not a ruling) | `pim/amazon-content-payload.ts:54` |
| P1-8 | P1 | a child inheriting its parent's language text exports as `inherited`/null (needs a ruling) | `catalog-transfer-plan.ts:92-100` · test red |
| P2-3 | P2 | `grid/renderers/index.ts` is NEW web↔factory drift; the gate is in no hook | `--check` exit **1** · `.git/hooks/pre-push` 0 hits |
| P2-3b | P2 | the resolver's pin `from` is a raw CUID; safety is held by one wrapper and one call shape | `content-resolver.ts:183` · `studio-content-wire.ts:12` |
| P2-9…21 | P2 | guard blind spots, over-broad exemptions, five duplicated definitions, two unchecked axes, one residual SP-API path | see each |
| P3-22…26 | P3 | 13 red tests (harness schema), a test that cannot run, a parity list missing a member, two stale state-block claims | see each |

Two claims in the takeover state block are **stale**: the lx4/lx5 migration folders are committed (P3-25), and no file
carries the 04:45 mtime attributed to 8 renderer tests (P3-22d). One finding of my own was **refuted by measurement**
and is recorded in "Retracted" rather than annotated in place.

## 0. The review set, derived (not remembered)

Derived from the step manifests under `docs/audits/2026-09-12-language-axis/step*/` —
`manifest.json` (`sources[].path` / `files[].path` / `sourceFiles[]`), `source-manifest.json` (`[].file`),
`step7/audit-manifest.json`, and — because **step 6 never wrote a `source-manifest.json`** — `step6/checkpoint-c.json`
and `step6/checkpoint-d-pending.json`.

| reading | value |
|---|---|
| manifest files parsed | **24** |
| source files in the review set (excl. `docs/`, `.claude/`) | **275** |
| of those, contributed only by step 6's checkpoints | **60** |
| test files in the set | **58** (38 API, 19 web, 1 shared) |
| review-set files still byte-identical to their last recorded manifest hash | **256 / 275** |
| review-set files that have CHANGED since their last recorded hash | **18** |
| review-set files no longer in the tree | **1** (`apps/api/src/services/pim/content-resolver-shadow.ts`, recorded in `step3/manifest.json`) |

The 18 changed files, newest first (mtime · step whose manifest last recorded them):

```
04:43:05Z step6  apps/api/src/services/pim/sheet-columns.service.ts
04:37:55Z step6  apps/api/src/services/pim/studio-sheet.service.ts
04:33:56Z step2  apps/web/src/app/products/[id]/edit/_studio/drawer/types.ts
04:33:29Z step3-switch apps/api/src/services/pim/sheet-values.ts
04:31:03Z step6  .../_studio/sheet/master/channelColumns.tsx
04:31:03Z step6  .../_studio/sheet/master/columns.tsx
04:30:40Z step6  .../_studio/sheet/master/types.ts
04:30:40Z step6  .../_studio/sheet/channel/types.ts
04:30:04Z step6  apps/{web,factory}/src/design-system/grid/theme/grid.css
04:29:34Z step6  apps/web/src/design-system/grid/renderers/index.ts
02:49:54Z step4  scripts/check-editor-open.mjs
02:49:54Z step6  apps/web/src/design-system/grid/renderers/provenanceMark.tsx
02:49:54Z step6  .../_studio/sheet/channel/CascadeCell.tsx
02:31:06Z step6  .../sheet/buildSheetColumns.vitest.test.ts
02:31:06Z step6  .../sheet/master/channelColumns.vitest.test.ts
02:29:02Z step6  apps/factory/src/design-system/grid/renderers/provenanceMark.tsx
06:08:11Z(09-12) step2 apps/api/src/services/categories/marketplace-ids.ts
```

**Concurrency, stated where it matters.** `studio-sheet.service.ts` was rewritten at **06:37:55Z**,
`_studio/sheet/master/columns.tsx` at **06:31:03Z**, `design-system/grid/editors/sheetColumn.ts` at **06:30:22Z**,
`apps/api/src/services/pim/family-projection.service.ts` at **06:18:29Z**, and
`apps/api/src/services/categories/reference-labels.service.ts` + `apps/api/src/routes/categories.routes.ts` at
**06:46:28Z / 06:46:47Z** — i.e. VT.1, VT.2 and an LX.6 lane were editing during this review. Every line number I cite
in those files was re-verified against the revision on disk at the time I read it, and I re-checked the two LX hunks in
`studio-sheet.service.ts` after its 06:37 save (`resolveWriteRouting` moved 570 ← 562; the LX.9 issue push moved
1496 ← 1471). Line numbers in those four files may move again. I reviewed the LX hunks, not VT's.

One batch of mtimes — `market-languages.ts`, `scope-readiness.service.ts`, `translation-write.ts`,
`catalog-transfer-plan.ts`, all `2026-09-13T04:49:54Z` — carries **unchanged content** (their hashes still match the
step manifests). That is consistent with the 05:05 revert having been undone at 05:25 by rewriting identical bytes: the
mtimes moved, the content did not. No finding.

---

# P0 — data loss · wrong write · live provider call

## P0-1 · A two-language market emits TWO byte-identical `language_tag` entries when the language tier is empty

**`apps/api/src/services/pim/amazon-content-payload.ts:22`** (`return languages.map(language => …)`) and
**`:49-57`** (`for (const row of content) … entries.push(entry)`), with the tag at **`:54`**:

```
const entry = { value: String(value), marketplace_id: input.marketplaceId, language_tag: languageTag(resolved.language, input.marketplace) }
```

**Failure scenario (inputs → wrong output).** Amazon · BE carries `languages = ['nl','fr']` (LX.2 backfill; the step-2
§4 record measured all 20 marketplace arrays, BE = `[nl,fr]`). A product with no `ProductTranslation` row for `nl` or
`fr` resolves BOTH requested languages to the **source** tier, so `resolved.language === 'it'` twice. The loop appends
one entry per (language × value) with no de-duplication by `(marketplace_id, language_tag)`.

**Measured, with its positive control, in one run** (probe run under the apps/api vitest config against the real
`buildAmazonContentAttributes`, prisma's `marketplace.findFirst` stubbed, `fetch` stubbed to throw, 4 tests, 4 passed):

| arm | `item_name` produced |
|---|---|
| **positive control** — `nl` + `fr` both translated (the only arm the shipped test runs) | `[{value:"Title nl",…,language_tag:"nl_BE"}, {value:"Title fr",…,language_tag:"fr_BE"}]` |
| **neither translated** | `[{value:"Giacca",…,language_tag:"it_BE"}, {value:"Giacca",…,language_tag:"it_BE"}]` ← **two identical entries** |
| same arm, `product_description` | `[{value:"Descrizione",…,"it_BE"}, {value:"Descrizione",…,"it_BE"}]` |
| only `nl` translated | `[{value:"Titel nl",…,"nl_BE"}, {value:"Giacca",…,"it_BE"}]` |
| DE (single language), untranslated | `[{value:"Giacca",…,language_tag:"it_DE"}]` |

**Why this is a live write, not a lab curiosity.** The path is the real outbound drain:
`apps/api/src/services/outbound-sync.service.ts:1060` → `buildAmazonListingPatch(…, content)` →
`:309 if (content) Object.assign(attrs, await buildAmazonContentAttributes(...))`, and the publish route
`apps/api/src/routes/marketplaces.routes.ts:1069` → `buildMarketplaceAmazonAttributes({… content})` → `:33`. The
production measurement in the design's §1 says `ProductTranslation` holds **1 row** for 338 products (the step-0
baseline `production-baseline.json` refines it: `translationRowsByLanguage {"en": 1}`), so the untranslated arm is the
**default state of the catalogue**, not an edge case.

**Proposed fix.** Group the resolved rows by the tuple the provider keys on — `(attribute key, marketplace_id,
language_tag)` — before pushing, and emit one entry per tuple; where two requested languages collapse onto the same
resolved language, that is exactly one entry, and the fact that a requested language was not answered belongs in the
preflight (which already has `publishReviewIssues` as the place to say it), not in a duplicated array element. Do it in
`buildAmazonContentAttributes` rather than at each call site, so both the route and the drain inherit it, and add the
untranslated and half-translated BE arms to `amazon-content-payload.vitest.test.ts` as named cases so the arm that
fires today is the one the suite exercises.

## P0-2 · D7 `requireReviewed` is enforced on the Amazon builder only — eBay, Shopify, Etsy and syndication have no gate

**Enforced at** `apps/api/src/services/pim/amazon-content-payload.ts:43-46`:

```
const issues = publishReviewIssues(content)
if (issues.length) throw Object.assign(new Error(...), { statusCode: 422, issues })
```

**Set claim, derived:** the only two files in `apps/api/src` that reference `publishReviewIssues` or
`resolvePublishContent` are `routes/marketplaces.routes.ts` and `services/pim/amazon-content-payload.ts`
(`/usr/bin/grep -rln`). Measured per file, count of `publishReviewIssues|resolvePublishContent|reviewedAt`:

```
apps/api/src/services/ebay-publish.service.ts            hits=0
apps/api/src/services/channel-publish.service.ts         hits=0
apps/api/src/services/listing-publish.service.ts         hits=0
apps/api/src/services/content-auto-publish.service.ts    hits=0
apps/api/src/routes/listings-syndication.routes.ts       hits=0
```
Positive control for the instrument: `reviewedAt` appears in **32** files under `apps/api/src`, so the pattern is not
silently failing.

**Failure scenario.** `apps/api/src/routes/products-ai.routes.ts:281` writes AI content through
`applyProductBulkEdits` with `contentState: 'draft'` at `body.contentAddress`; for a non-primary language that address
is `{tier:'language', language}`, so `content-write.ts:21` → `translation-write.ts` stores the row and
`content-write.ts:69` / `translation-write.ts:52-55` stamp `source: 'ai'`, `reviewedAt: null`. The resolver then
returns that value for every destination speaking that language. An Amazon publish is refused (422, naming the
language). An eBay, Shopify, Etsy or syndication publish is **not** — those paths never consult
`translation.reviewedAt`. Owner decision **D7** is "No, on purpose".

**There is no `requireReviewed` flag.** Exactly **one** occurrence exists in all of `apps/api/src`, `apps/web/src` and
`packages`: `apps/api/src/routes/marketplaces.routes.ts:1255`, `languages: content.map(row => row.language),
requireReviewed: true,` — a hardcoded literal in the preflight **response body**, with no definition and no reader.
So the rule is unconditional where it exists and absent where it does not; the docs' "`requireReviewed` is the publish
default" describes a switch that was never built (`reference_docs_describe_deleted_code`).

**Proposed fix.** Move the verdict to where every publisher already passes: have each non-Amazon publish path resolve
its content through `resolvePublishContent` (it is channel-parameterised already — `amazon-content-payload.ts:15-16`
takes `channel`) and refuse on `publishReviewIssues`, or lift the refusal into the one place all four converge
(the outbound queue drain / `listing-publish.service.ts`) so a new channel inherits it rather than opting in. Either
way the check belongs behind one function, and the preflight sentence — which already names the language and its code
identically at preview and at publish — should be the single source of the wording.

---

# P1 — a wrong result shown

## P1-4 · An untranslated required field produces TWO error issues for the same field

Both arms fire for the same cell, in order:

1. `apps/api/src/services/pim/readiness.service.ts:212-214` nulls the value before validation —
   *"LX.5: a source-language fallback is displayable but cannot fill a translated requirement"* —
   `content.fields[key] && translationMissing(content.fields[key]!, content.requested) ? null : value`
   → `findMissingRequired` then pushes `` `${miss.label} is required by ${v.coordinateLabel}` `` at
   **`readiness.service.ts:234`**, `severity: 'error'`.
2. **`apps/api/src/services/pim/studio-sheet.service.ts:1496-1498`** pushes a second error for the **same `column.key`**:
   `` `${locale} content ${…} is missing…; showing ${localized.language} fallback.` ``, `severity: 'error'` when the
   column is required.

The mapping-error branch immediately below (**`:1499-1508`**) *does* de-duplicate — *"A blocking mapping verdict
replaces the weaker warning for the same field"*, and it skips when an error already exists for that key. The
translation push has no equivalent.

**Failure scenario → wrong output.** Amazon · DE, German pressed, `item_name` required and untranslated:
`row.readiness.issues` contains two entries keyed `title`. Consequences, each with the line that consumes them:
the alias/coordinate summary's `errors` count double-counts (`studio-sheet.service.ts:1541-1543`), and
`readiness-index.service.ts:66-67` maps `row.readiness.issues` one-to-one into `ReadinessIndex.missing`, so the
Needs-attention list and the readiness matrix show the same field twice with two different sentences.

**Proposed fix.** Give the translation push the same precedence rule the mapping push already has: before pushing,
drop any existing `warn` for that key and skip if an `error` for that key is already present — better, merge the two
sentences into one issue whose message names both facts ("required by Amazon · DE; the German text is missing, showing
the Italian source"), since they describe one defect and one next click. The rule belongs next to the other precedence
rule in the same loop, not in a second place.

## P1-5 · `ReadinessIndex` is empty on production and nothing backfills it; the reader is index-only

`apps/api/src/services/pim/scope-readiness.service.ts:28-63` reads **only** the materialised index
(`prisma.readinessIndex.findMany`, `:35`) and has no fall-back to a sheet computation — correctly, per LX.5. When no
row exists it answers honestly: `state: 'absent'`, `pct: null`, note
*"Readiness has not been computed for this language."* (`:18-19`).

**Measured.** `docs/audits/2026-09-12-language-axis/step5/production-schema-read.json` (read-only probe on Neon
`neondb`, `read_only: on`, at `2026-09-12T21:38:47.487Z`): `"rows": 0`, migration
`20260912_lx5_readiness_index` finished `21:29:58.033Z`. There is no backfill: the five LX migration folders contain
DDL only, and the only writers are `produceReadiness` (3 call sites: `content-write.ts:76`,
`master-content.service.ts:153`, `bulk-edit.service.ts:2587`) and the nightly cron at
`apps/api/src/jobs/readiness-reconcile.job.ts:27`, `cron.schedule('17 2 * * *', …)`.

**Failure scenario.** The first deploy that ships this code serves an empty index: every scope chip and the whole
Needs-attention page read `—` / "has not been computed" for all 338 products (37 root families) until either the
02:17 UTC reconcile runs or a write touches that family. The design's rollback column says "index ignored when flag
off", but there is no flag in the code — `getProductReadiness` reads the index unconditionally.

**Proposed fix.** Make the first-read path self-healing or make the deploy fill the index: either have
`getProductReadiness` enqueue `reconcileFamilyReadiness(rootId)` (not await it) when it finds zero rows for the family
and keep returning the honest "not computed yet" until it lands, or run `runReadinessReconcile()` once as a deploy step
before the surface goes live. The second option has a measurable cost to state first — the step-5 record measured
**714 rows in 4,087 ms for one family**, so 37 root families is ≈150 s of single-threaded work.

## P1-6 · `channelSnapshot` has no word in the drawer's layer vocabulary

**Measured**, `apps/web` vitest, 1 file: **1 failed / 17 passed (18)**.

```
FAIL src/app/products/[id]/edit/_studio/drawer/layers.vitest.test.ts
  > every attribute-resolver ValueSource maps to a known layer
- Expected  []
+ Received  [ "channelSnapshot" ]
  at src/app/products/[id]/edit/_studio/drawer/layers.vitest.test.ts:55
```

The test derives its member list from the API source rather than hardcoding it (its own comment at `:11`: *"A test
that hard-coded the list would pass"*) — good practice, and it is the instrument that caught this. The member was
added at `apps/api/src/services/pim/attribute-resolver.ts:25` and
`apps/api/src/services/pim/content-read.ts:28`; `LAYER_OF` in
`apps/web/src/app/products/[id]/edit/_studio/drawer/types.ts:356-379` has **no `channelSnapshot` key**, so
`toLayer('channelSnapshot')` returns `'unknown'` (`:382-385`).

**Blast radius, bounded honestly.** `resolveLayer` prefers the server's explicit `layer`
(`drawer/types.ts:401-404`), and the studio sheet always sends one — `studio-sheet.service.ts:810-834` maps
`channelSnapshot → 'master'`. The fallback path is the one the file's own comment at `:349-353` names: *"the
catalogue-wide `GET /api/products/sheet` … sends only `source`"*. So on `/products/next` the affected cells render
`unknown` ("? Unrecognised"). Population: the step-3-switch R2 measurement counted **866 observations / 575 unique
listings** of exactly the `follows=true` legacy pin that produces `channelSnapshot`.

**Proposed fix.** Add `channelSnapshot` to `LAYER_OF`. Which word is a design call, and it is worth one sentence to
the Owner rather than a guess: `'master'` matches what the server's `layerFor` already says and what the value claims
to follow, but the value on screen is a *stale listing snapshot* (the resolver marks it `drift: true`), so labelling it
`'master'` lets a cell say "Master" while showing text the master does not hold. `grep` finds no web consumer of
`drift` on the studio surfaces, so the drift fact is currently carried on the wire and dropped — that is the second
half of the same fix.

## P1-7 · An untranslated market publishes the source text under a `language_tag` the marketplace does not speak

Same line as P0-1 (`amazon-content-payload.ts:54`), separate defect and separate decision. Measured above:
DE with no German translation yields `language_tag: "it_DE"`.

This is **deliberate and pinned by a test** — `apps/api/src/services/pim/amazon-content-payload.vitest.test.ts:24-27`,
`it('never relabels source fallback as a translated value')`, `expect(attributes.item_name[0].language_tag).toBe('it_DE')`.
The honesty is right; what is unmeasured is whether Amazon accepts a foreign `language_tag` on a marketplace.

**Scale, from the programme's own step-1 record:** AMAZON·DE 214 listings, **214/214 carry a title** but only **86
carry a description**; AMAZON·ES 123/123 title, 62 description; AMAZON·FR 115/115, 62. Titles resolve through the
legacy pin (`content-resolver.ts:190-196`, `requested === languages[0]`) and stamp `de_DE` correctly. The ~128 DE,
~61 ES and ~53 FR **descriptions** with no override fall to the Italian source and would now be stamped `it_DE` /
`it_ES` / `it_FR`. Before LX, `buildAmazonListingPatch`'s legacy branch
(`outbound-sync.service.ts:303-304`) stamped `languageTag(languages[0], code)` — i.e. `de_DE` — so this is a **change**
to a live publish payload on a measurable population.

**QUESTION FOR THE OWNER** (I do not rule): should a field whose resolved language ≠ the destination's language be
(a) omitted from the payload and reported by the preflight, (b) sent with the destination's tag as before, or (c) sent
with the true source tag as now? LX.9 already knows the answer at readiness level — such a market reads `blocked` —
so (a) is the option consistent with the rest of the design, and it is also the option that makes P0-1 disappear.

## P1-8 · A child that inherits its parent's language-tier text exports as "inherited / null"

**Measured**, `apps/api` vitest, 1 file: **1 failed / 9 passed (10)**; failing assertion pinned to the line:

```
FAIL src/services/pim/content-read.vitest.test.ts
  > catalogue transfer treats source fallback as untranslated, and keeps an explicit clear distinct
- Expected { "state": "stored", "value": "Deutscher Titel" }
+ Received { "state": "inherited", "value": null }
  at src/services/pim/content-read.vitest.test.ts:68
```

Both the test and the code are **byte-identical to what the step manifests recorded** (neither appears in the 18
changed files of §0), so this is not concurrency damage and not a stale file — it is red in the tree the manifests
describe.

**Mechanism.** `apps/api/src/services/pim/catalog-transfer-plan.ts:92-100`, `ownMaster`:
`return translationMissing(resolved, requested) || resolved.ownerId !== product.id ? undefined : resolved.value`.
For a child with no translations whose parent holds the German row, the resolver answers from the parent
(`content-resolver.ts:199-202`) and sets `ownerId` to the **parent's** id (`:183`). So `ownerId !== product.id` →
`undefined` → `masterTransferState` (`:101-106`) reports `state: 'inherited', value: null`, and the export/transfer
writes nothing for that child's German title.

**Two readings, and I cannot rule between them.** Either (a) the rule is right — a child's inherited text is not its
own stored value and duplicating it onto the child on transfer would be wrong — and the assertion at `:68` is stale
and must be corrected with a recorded reason; or (b) the rule is wrong for transfer — the target catalogue may not have
the same family shape, so a child exported alone loses its German title silently. **Both the step-7 §4 record's
"203/203 in 18 API files" and the step-3-switch record's "180/180" therefore excluded a red LX test file**, which is
itself the finding in P3-22.

---

# P2 — drift · duplication · a second definition

## P2-3 · `grid/renderers/index.ts` is NEW web↔factory drift, and the gate that says so runs in no hook

> This item replaces a P1 I drafted and then **refuted** — see "Retracted" at the end of this file.

Measured, exit codes captured directly (not through a pipe):

```
node scripts/check-ds-fork-drift.mjs            → exit 0   (plain mode only logs)
node scripts/check-ds-fork-drift.mjs --check    → exit 1   (scripts/check-ds-fork-drift.mjs:103)
DS fork: 156 shared files · 8 differing · 148 identical
✗ NEW drift — these were identical in both apps and no longer are:
   grid/renderers/index.ts
```

`apps/web/src/design-system/grid/renderers/index.ts` is **73** lines; `apps/factory/src/design-system/grid/renderers/index.ts`
is **3**; 75 diff lines. The factory barrel is:

```
export { describeCellSource, classifyProvenance, provenanceTooltip, provenanceClassRules, type CellProvenance, type ProvenanceLike } from './provenance'
export { ProvenanceMark, type ProvenanceMarkProps } from './provenanceMark'
export { CompletenessPill, type CompletenessPillProps } from './CompletenessPill'
```

so the factory **does** re-export the LX additions; the drift is that web's barrel carries ~30 further names the
factory copy does not. The four DS files LX actually changed are byte-identical across the fork — `diff` exit 0 on
`renderers/provenance.ts` (368/368 lines), `renderers/provenanceMark.tsx` (99/99),
`renderers/CompletenessPill.tsx` (55/55), `grid/theme/grid.css` (1518/1518). So the LX content mirrored correctly and
the **barrel** is what diverged, which the ratchet had frozen as identical.

**The gate is in no hook.** `.git/hooks/pre-push` runs `check-schema-drift.mjs`, `check-column-drift.mjs`,
`check-link-targets.mjs` and `check-rbac-coverage.ts`; `/usr/bin/grep -c fork-drift .git/hooks/pre-push` → **0**.
So the one instrument that reports this is red only when someone remembers to pass `--check` by hand —
the same shape as P2-11.

**Proposed fix.** Bring the two barrels back to identical (the factory one is the shorter, so add the names it can
serve) or, if the factory deliberately re-exports a subset, run `--write` and state the reason in the commit as the
script's own message asks — the baseline exists for exactly that. Separately, add `--check` to `.git/hooks/pre-push`
beside the other four, so the ratchet is enforced rather than advisory.

## P2-3b · The resolver's pin `from` is a raw CUID, and its safety is held by one wrapper and one call shape

`apps/api/src/services/pim/content-resolver.ts:183` and `:195` set a pin's `provenance.from` to `listing.id` — a raw
CUID. The programme's own evidence records it: `step3/reclassifications.md` §R7 shows an accepted answer with
`"provenance": { "member": "pinned", "from": "cmp27idw201g3nv01jk4nt11r" }`. And
`apps/web/src/design-system/grid/renderers/provenance.ts:364-366` interpolates `from` into the operator-visible
sentence verbatim (`Pinned at ${from} — changes to the shared language text do not replace this value.`).

**No measured render path shows it today**, and I verified each:
- Studio sheet: `apps/api/src/services/pim/studio-content-wire.ts:12` **discards** the pin's raw `from` and rebuilds
  it as `` `${languageLabel} · ${coordinateLabel ?? 'listing'} · ${follows ? 'following snapshot' : 'pin'}` ``.
  Its only caller is `studio-sheet.service.ts:1373`, so every studio cell is relabelled.
- `/products/next`: the only production caller of `describeCellSource` is
  `apps/web/src/app/products/next/languageColumns.tsx:16`, fed by `catalog-language.ts:37`, which calls
  `resolveContent({ product, parent, field, address: { requested } })` with **no `listing` and no `coordinate`** —
  so `content-resolver.ts:185`'s pin branch is structurally unreachable there.
- Master sheet: `sheet/master/columns.tsx:193-195` passes `sourceLabel(...)`, and
  `sheet/master/columnRules.ts:107` resolves an id to a SKU and returns **null** when it cannot, with the reason
  stated in its own comment (*"a cuid on screen is not a source label, it is noise that looks like one"*).
- Channel sheet: `channel/CascadeCell.tsx:77` → `channel/cellDetailsSource.ts:20` composes fixed semantic strings.
- The DS tests already guard it: `provenanceLanguage.vitest.test.ts:44` asserts
  `describeCellSource(cell, { from: 'an internal row id' })` → `from: 'German · shared'`, and `:58` uses a humanised
  pin label `'Dutch · Amazon · BE · pin'`. Run at 07:01:52Z: 3 files, **15 passed**, 0 failed
  (`provenanceLanguage`, `content-wire`, `SourceIndicator`).

**What remains is the hazard, not a live defect.** `apps/api/src/services/pim/content-read.ts:33-35`
(`contentAttribute`) passes the raw id straight through in **both** `inheritedFrom` and `contentProvenance`, with no
relabelling, and its consumers are `sheet-rows.service.ts`, `attribute-resolver.ts`,
`products/translation-resolver.service.ts`, `shopify/listing-information-plan.ts`, `etsy/information-content.ts`,
`global-content.ts`, `mapping-simulate.service.ts`, `catalog-transfer-export.ts`. `inheritedFrom` has always been an
id and every reader treats it as one; `contentProvenance.from` is the new field, and any surface that renders it
without going through `studioContentFacts` will print a CUID.

**Proposed fix.** Make the resolver emit the human label and keep the id where ids live: set the pin's
`provenance.from` to `` `${channelLabel} · ${market} · ${language}` `` (the string `resolveWriteRouting` already
composes at `studio-sheet.service.ts:606`) and leave `listing.id` in `ownerId`/`inheritedFrom`. Then
`studio-content-wire.ts:12` becomes a pass-through instead of a rescue, and a new consumer of `contentAttribute`
cannot leak the id by forgetting a wrapper it has no reason to know about.

## P2-9 · The LX.2 guard cannot detect the defect class Appendix A lists

`apps/api/src/services/pim/market-languages-guard.ts:29-44` detects exactly two shapes: a string literal matching
`/^[a-z]{2,3}_[A-Z]{2}$/` (`:30`) and a `Marketplace` lookup by `code` without `channel` (`:33-44`).

**Measured with positive controls in the same run** (`npx tsx`, pure module, no database):

```
1  POSITIVE CONTROL regional literal        const tag = 'it_IT'                        -> 1 violation
1  POSITIVE CONTROL code-only lookup        prisma.marketplace.findFirst({where:{code:'DE'}}) -> 1 violation
0  ARM bare language-only market map        const MARKET_LANGUAGE = { DE:'de', BE:'fr', IT:'it' }
0  ARM fallback literal                     const language = row?.language ?? 'it'
0  ARM two-language literal array           const BELGIUM = ['nl','fr']
0  ARM region-suffixed with a dash          const tag = 'de-DE'
```

Design LX.2 is "a test fails the build if a literal `it_IT` **or a code-only lookup** reappears" — which the guard
does — but the twelve definitions Appendix A deletes are market→language maps written with **2-letter codes**
(`field-links.routes.ts:15` **nl**, `translation-resolver.service.ts:50` **fr**, and so on). Not one of those shapes
is detectable. Nor is the dash form, which `normalizeLanguage` accepts everywhere else
(`packages/shared/content-language.ts:28`, `split(/[-_]/,1)`), so `'de-DE'` is a usable literal that passes.

**Proposed fix.** Extend the AST visitor with a third rule: an object literal (or `Record<string,string>` annotation)
whose keys are ≥2 ISO-3166 two-letter codes and whose values all match `^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$` is a
market→language map and must be reported; and widen the tag regex to accept the dash form. Add both as positive
controls in `market-languages-guard.vitest.test.ts` beside the eight that already exist, so the guard's own coverage is
visible.

## P2-10 · The guard's exemption list is over-broad by 11 files

`MARKET_LANGUAGE_EXEMPTIONS` (`market-languages-guard.ts:5-8`) is two regexes. Derived from the tree, they match
**13** files (matching the ledger's "13 exemptions"; my own run of the guard at 06:50Z reports `scanned: 1498`,
13 exempt, `violations: []`, 2/2 tests passed). Of those 13, the count of regional-tag literals per file:

```
18  apps/api/src/services/amazon/flat-file.service.ts
 6  apps/api/src/services/channel-batch/amazon-batch-feed.service.ts
 0  flat-file-coerce-ai.ts · flat-file-coerce.ts · flat-file-hydrate.service.ts · flat-file-mapping-ai.ts
 0  flat-file-mapping.ts · flat-file-merge.ts · flat-file-propagate.service.ts
 0  flat-file-pull-preview.service.ts · flat-file-pull.service.ts · flat-file-schema-walk.ts
 0  flat-file-verify-live.service.ts
```

So **2 of 13** exemptions are load-bearing; the other 11 are files with nothing to exempt, which the guard will now
never check again. The Owner's exemption was for the untouchable flat-file editors, and `flat-file.service.ts` is
that file; the other 11 are collateral of the `flat-file[^/]*\.ts` glob.

**Proposed fix.** Replace the glob with the two exact paths that need it, and let the other 11 be guarded like every
other file. If the Owner's exemption is meant to cover the whole flat-file family as a blast radius, then say so in
the exemption comment and keep the glob — but then the comment should state that 11 of the 13 carry no map, so a
future reader does not read breadth as necessity.

## P2-11 · The LX.2 guard is not in any gate script

`/usr/bin/grep -rln "marketLanguageViolations|market-languages-guard" scripts/ apps/api/src` returns exactly **two**
files, both the guard and its own test — nothing under `scripts/`. It runs only when someone runs that one vitest
file. The AAA bar's gate list (`docs/vt-prompts.md` rule 7) names nine `scripts/*.mjs` gates and does not include it,
while the LX prompt calls it "the LX.2 language guard" and lists it as a gate. A gate nobody's `npm run` reaches is a
gate that goes quiet.

**Proposed fix.** Either add `scripts/check-market-languages.mjs` that imports `marketLanguageViolations` and walks
`apps/api/src` (two lines of new code, the logic already exists and is tested), or add the guard's test file to the
gate list explicitly by name so an operator running the gates runs it. The first is preferable because the other eight
gates are already node scripts and the ledger's gate lines record exit codes, not test counts.

## P2-12 · `isLocalizableContent` is derived two different ways, one file apart

- `apps/api/src/services/products/bulk-edit.service.ts:559-566` derives the key from the **wire field** through
  `CHANNEL_FIELD_MAP`: `const key = contentField(CHANNEL_FIELD_MAP[base] === 'bulletPointsOverride' ? 'bulletPoints' :
  CHANNEL_FIELD_MAP[base] ?? base.replace(/^attr_/, ''))`, then `isLocalizableContent(key, col?.storage)`.
- `apps/api/src/services/pim/studio-sheet.service.ts:576` derives it from the **column key**:
  `isLocalizableContent(col.slot?.of ?? col.key, col.storage)`.

They can disagree for a column whose `key` is not a `CONTENT_COLUMNS` name (e.g. `item_name`) while its write field is
(`amazon_title → title`). In that case `applyContentBulk` runs but `resolveWriteRouting` takes the legacy branch, so
`routing.contentAcknowledgement` is `undefined` and the non-null assertion at
`apps/api/src/services/pim/content-bulk-write.ts:46` — `routing.contentAcknowledgement!.shared.label` — would throw a
`TypeError` (a 500) instead of the refusal sentence the operator is owed.

**Today it does not fire**, and the reason is three files away: `studio-sheet.service.ts:1418` synthesises a
`contentAddress` of tier `pin` (channel) or `source` (master) for exactly the legacy-branch case, so the client always
sends a pin and the `address.tier !== 'pin'` arm of `:46` is never reached. This is the
`reference_write_predicate_must_match_its_readers` shape: an equivalent predicate re-derived one line away, kept safe
by a fallback nobody reading `content-bulk-write.ts:46` can see.

**Proposed fix.** Export one predicate that takes the column and returns both the localizable verdict and the
content key, and have both call sites use it; then replace the `!` at `content-bulk-write.ts:46` with an explicit
refusal that names the column when the acknowledgement is absent, so the fail-closed behaviour is stated in the file
that depends on it rather than inherited from `studio-sheet.service.ts:1418`.

## P2-13 · Two serializers for the `key@channel:market:locale` header; the web one drops the locale on master

- API: `apps/api/src/services/pim/import-diff.service.ts:100-102`, `languageHeader()` — emits `title@de` for a master
  scope with a locale, `brand@amazon:IT:` for a channel scope without one. Used by the workbook writer
  (`catalog-workbook.ts:183`).
- Web: `apps/web/src/app/products/[id]/edit/_studio/sheet/sheetExport.ts:53-58`, `exportKeyFor()` — returns early
  (`:55`) for **any non-channel scope**, so a master sheet exported while German is pressed writes `title`, not
  `title@de`.

Round-tripping such an export would land on the **source** tier instead of the German language tier. The parser
(`import-diff.service.ts:104-149`) is fine; it is the two writers that disagree.

**Reach, measured and bounded:** `exportSheet` (`sheetExport.ts:126`) has **no call site** —
`/usr/bin/grep -rn "exportSheet(" apps/web/src` finds only the definition, while the same instrument finds **24**
`loadReferenceChoices(` call sites, so the grep is working. The only cross-file imports of the module are the **type**
`SheetExportMode` in `useChannelSheetAdapter.tsx:57` and `useMasterSheetAdapter.tsx:51`. So the defect is **latent**,
not live. Its test pins the current behaviour at `sheetExport.vitest.test.ts:7` and `:22`
(`exportKeyFor('brand', { kind: 'master' })` → `'brand'`).

**Proposed fix.** Delete `exportKeyFor` and have the web export call the API's `languageHeader` rule through a shared
module (the header grammar is a wire contract, so it belongs beside the parser in `packages/shared`), or — if the web
export is being retired with `exportSheet` — delete the module and its test so a future reader does not wire a second
grammar back in. Either way one grammar, one test, and the master-locale case named in it.

## P2-14 · One "falls back to source" string shape, two independently written matchers

`apps/api/src/services/pim/catalog-language.ts:10` (SQL) and `:12` (JS) both match the reason sentence the sheet
writes at `studio-sheet.service.ts:1497`:

```
:10  const fallbackSql = Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements(r.missing) issue WHERE issue->>'reason' LIKE '%; showing % fallback.')`
:12  return Array.isArray(missing) && missing.some(issue => … /; showing .+ fallback\.$/.test(issue.reason))
```

`%` matches empty, `.+` does not: a reason whose language segment is empty (`"; showing  fallback."`) passes the SQL
filter and fails the JS projection, so the grid's `fallback@<lang>` **cell** and the server-side **filter** would
disagree on the same row. The deeper issue is that a structured fact is being recovered by string-matching a sentence
that another file composes — change the wording at `studio-sheet.service.ts:1497` and both matchers go silently false
(`reference_a_banked_rule_can_go_false`).

**Proposed fix.** Record the fact, not the prose: add a boolean (or a `reason: 'language-fallback'` discriminator) to
each `ReadinessIndex.missing` entry at the point `studio-sheet.service.ts:1496-1498` knows it, and have both the SQL
predicate and the projection read that key. One definition, no sentence parsing, and the operator-facing wording stays
free to change.

## P2-15 · The channel display name is inlined twice in the LX hunks while two real label maps exist

`apps/api/src/services/pim/studio-sheet.service.ts:606` (the acknowledgement's pin label) and `:1197` (the
acknowledgement's reach list) each carry the same four-way chain
`channel === 'AMAZON' ? 'Amazon' : … : 'Etsy'`. A fifth channel is labelled **"Etsy"** by both — a hardcoded member
list standing in for a derived one (`reference_a_list_of_members_is_a_set_claim`). Meanwhile
`apps/web/src/app/products/[id]/edit/_studio/scopes.ts:25-33` and
`apps/web/src/app/settings/channels/[type]/channelDetail.ts:96-104` are real `Record<string,string>` label maps with
an `?? key` fallback, and the API has three more (`insights-*.service.ts`).

**Proposed fix.** Put one `channelLabel(channel)` in `packages/shared` with an explicit map and an `?? channel`
fallback, and call it from both `studio-sheet.service.ts` sites and from the P1-3 fix. The operator-facing copy is
Appendix A's, so the map's values are a copy decision, not a guess — which is another reason it should exist once.

## P2-16 · An empty `fallback@<lang>` filter writes the readiness field

`apps/api/src/services/products/products-grid.contract.ts:180`: for `languageColumn.field === 'fallback'`,
`if (!m.values.length) q.languageStates = []` — it sets `languageStates` (the **readiness** predicate), not a fallback
predicate, and it does so in a loop that may already have set `q.languageStates` from a `readiness@<lang>` entry, which
it silently clobbers. The observable result is currently right only because
`catalog-language.ts:16` short-circuits `q.languageStates?.length === 0` to zero rows, which happens to be the correct
answer for "nothing selected". A write whose correctness depends on a coincidence one file away is the same shape as
P2-12.

**Proposed fix.** Introduce the explicit empty-set state for the field being filtered (e.g. `q.languageFallbackNone =
true`, or make `languageFallback` a tri-state) and have `restrictCatalogLanguage` return `[]` for it by name. One
line each side, and the intersection with a readiness filter then follows from the code rather than from the order of
`Object.entries`.

## P2-17 · The market-language gate covers only `AMAZON` and `EBAY`, and its error carries no status

`apps/api/src/services/pim/information-locale.ts:8-14`. Two gaps visible in the condition itself:

- `channel && ['AMAZON','EBAY'].includes(channel) && marketLanguages && …` — a **Shopify or Etsy** coordinate with a
  language the market does not carry is accepted silently. Those coordinates are reachable:
  `catalog-workbook-scopes.ts` builds Shopify/Etsy destinations.
- `InformationLocaleError` (`:4-7`) sets `code` but **no `statusCode`**, so an unsupported language surfaces through
  whatever default the route applies rather than a 400. Contrast `content-language.ts:12`, which does set
  `statusCode: 400`.

The **armed** side is verified: all four channel-scope call sites pass the third argument
(`marketplaces.routes.ts:26`, `sheet-columns.service.ts:1157`, `outbound-sync.service.ts:303`), and the one that
omits it (`sheet-columns.service.ts:1158`) passes `undefined` as the channel, where the check is correctly inert.

**Proposed fix.** Drop the channel allowlist — the authority is `Marketplace.languages` for every channel, which is
the whole point of LX.2 — and refuse whenever `marketLanguages` is supplied and does not contain the language; add
`statusCode: 400` to the error class. If a store channel genuinely accepts any language, that is a property of its
`Marketplace` row (`languages`), not of a literal channel list in the validator.

## P2-18 · The master locale position rejects tags the channel position accepts

`apps/api/src/services/pim/import-diff.service.ts:131` gates a master header's locale on `/^[a-z]{2,3}$/`, while
`:137` gates a channel header's on `/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8})*$/` and then normalises at `:144`. So
`title@de-DE` and `title@DE` parse on a channel coordinate and return **`null`** (an unrecognised column) on a master
one. Nothing emits a regional master tag today — `languageHeader` normalises first — so this is consistent by accident.

**Proposed fix.** Use one accept-and-normalise rule in both positions: match the permissive shape, run
`normalizeLanguage`, and treat the throw as the rejection. That also removes the asymmetry between an uppercase
`title@DE` failing and `brand@amazon:IT:DE` succeeding.

## P2-19 · R-LX-4 is not fully closed: a Studio page load can still reach SP-API through the sheet columns

`withCachedSchemas` has exactly **two** call sites in `apps/api/src`, derived:
`apps/api/src/routes/categories.routes.ts:65` and `apps/api/src/services/pim/readiness-index.service.ts:19`
(the remaining hits are the definition at `cached-schema-context.ts:5-6`, imports, and `cachedSchemasOnly()` readers).
The Studio sheet load is **not** one of them: `studio-sheet.service.ts:959-961` calls `getStudioColumns({ accountId:
context?.connectionId, … })` → `sheet-columns.service.ts:1196 loadAmazonSpec(market, pt, input.accountId)` →
`channel-specs/index.ts:71-73`, whose provider fallback is guarded by **`accountId && !cachedSchemasOnly()`** inside
`if (!row)`. With no active `CategorySchema` row for that `(marketplace, productType)`, that is an SP-API
`getDefinitionsProductType` on a page load.

The historical unconditional bypass **is** fixed: `git show HEAD:…/channel-specs/index.ts` line 60 is
`if (accountId) return (await import(…)).amazonSellerSpec(accountId, mk, pt)` — gone in the working tree, and covered by
`channel-specs/cache-first.vitest.test.ts:9-15` (3 loads with an account, `expect(mocks.provider).not.toHaveBeenCalled()`,
one row read).

Separately, an LX.6 lane closed the **reference-labels** half of R-LX-4 during this review —
`reference-labels.service.ts:49 if (cachedSchemasOnly()) return {}` (mtime 06:46:28Z) plus
`categories.routes.ts:65 const result = live ? await read() : await withCachedSchemas(read)` (06:46:47Z). I observed a
~7 s window where the route's comment described a wrapper the handler did not yet apply and a ~15 s window where
`loadReferenceChoices`'s new required third parameter had no updated callers; by 06:48:07Z the tree had converged
(17/17 test calls carry an intent). No finding on that — recorded only so the lane knows a reader saw it mid-flight.

**Proposed fix.** Wrap the Studio sheet read in `withCachedSchemas` the way the readiness producer already does, so
the page-load path is cache-only by construction, and keep the account fallback for the on-demand paths that ask for
it (`ReferenceSelectEditor.tsx:19`, `sheetRecovery.ts:40`, `reference-values.service.ts:46`, all of which pass an
explicit live/refresh intent). Then the "no provider call on a page load" claim becomes a property of the scope
rather than of every branch inside it, and the gate can assert it once.

## P2-20 · A market→locale map survives in the batch feed, with no Belgium

`apps/api/src/services/channel-batch/amazon-batch-feed.service.ts:58-63`,
`export const MARKETPLACE_LOCALE: Record<string,string> = { IT:'it_IT', DE:'de_DE', FR:'fr_FR', ES:'es_ES', UK:'en_GB' }`
— Appendix A lists this file's map for deletion; it is Owner-exempt, so this is a recorded deviation rather than a
violation. Its one consumer is `apps/api/src/services/images/amazon-image-feed.service.ts:32` (an import), and image
feeds carry no localized text, so nothing publishes content through it. Worth one line because the map has **no `BE`
key** while the authority now says BE speaks `['nl','fr']`: any future content use of it returns `undefined` for
Belgium.

## P2-21 · The catalogue's `title`/`description` sort re-reads every filtered product to order one page

`apps/api/src/services/pim/catalog-language.ts:59-65` loads all matching ids, then re-reads them in 100-row batches
*including* `translations` and `parent.translations` (`:32`), to sort a single page. Four round trips on today's
338-product catalogue; linear in the filtered set, not in the page. The readiness and fallback sorts are proper SQL
(`:49-54`) — only the two text sorts are in memory.

**Proposed fix.** These two sorts need a sortable projection, not a resolver pass: either materialise the resolved
per-language title/description alongside `ReadinessIndex` (the producer already computes them) or accept an explicit
cap with a stated reason in the response. The design's third ask was "it must hold at thousands of products", so the
number to put in front of the Owner is the one at 3,000 rows, not at 338.

---

# P3 — tests · docs

## P3-22 · 13 red tests in the LX suite, and the cause is the test harness's schema source

One clean run, `apps/api` vitest, the 14 most LX-central files, `--maxWorkers=2`, at 06:44:20Z:

```
Test Files  2 failed | 12 passed (14)
     Tests  13 failed | 105 passed (118)
     Duration 8.26s
 FAIL  src/services/pim/content-write.vitest.test.ts   (12 failed / 5 passed of 17)
 FAIL  src/services/pim/content-read.vitest.test.ts    (1 failed / 9 passed of 10)
```

The 12 in `content-write.vitest.test.ts` all fail the same way:

```
PrismaClientKnownRequestError: Raw query failed. Code: `42703`. Message: `column "variationExcluded" does not exist`
 ❯ readExcludedListingIds src/services/pim/family-projection.service.ts:401
 ❯ getStudioSheet         src/services/pim/studio-sheet.service.ts:1581
 ❯                        src/services/pim/readiness-index.service.ts:46
```

**Diagnosis, traced rather than relayed.** These are real-PostgreSQL integration suites whose database is
*disposable*: `vi.mock('@nexus/database', …)` → `apps/api/src/test-support/formula-database.ts:12`, which builds the
schema with `prisma migrate diff --from-empty --to-schema-datamodel …/schema.prisma`. And
`variationExcluded` is **deliberately absent from `schema.prisma`** — `family-projection.service.ts:385-398` explains
why (*"a database ahead of the schema is inert; a schema ahead of a database is an outage"*) and reads/writes it
through narrow raw SQL at `:402`, `:420-424`. `/usr/bin/grep -rn variationExcluded packages/database` returns **0**
hits in the schema and **0** in every migration; the 8 hits in the repo are all in that one service.
So the deployed databases have the column and the disposable one cannot.

**Consequence for the LX record.** The only integration coverage of "the readiness producer runs inside the write" —
`content-write.vitest.test.ts:65`, `:128-139` — cannot execute. The step-6 ledger recorded "13 failures reproduced
exactly … not a regression caused by this lane" and attributed them to "older content-read/resolve-batch fixtures";
the count is right and the attribution is not. This is the shape of
`reference_a_fixture_pins_a_dimension`: the arm that would have failed is the one never run.

**Proposed fix.** Give the harness the column the deployed databases have: after `migrate diff`, execute one
`ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false` in
`test-support/formula-database.ts`, with a comment pointing at `family-projection.service.ts:385` so the two stay
tied. That is the minimum that makes 12 LX assertions runnable again without touching the deliberate
schema/database asymmetry. `content-read.vitest.test.ts:68` is a separate question (P1-8) and needs a ruling, not a
harness change.

## P3-22b · A DS test file cannot run, and it is the LX-era one

`apps/web/vitest.config.ts:30`, `include: ['src/**/*.vitest.test.ts']` — **`.ts` only**, and the config's own header
warns against exactly this (*"A test that cannot run is worse than no test"*). Exactly one `.tsx` test file exists
anywhere under `apps/web/src`, and it is LX-era:
`apps/web/src/design-system/grid/renderers/CompletenessPill.vitest.test.tsx` (mtime 2026-09-13T03:03:35Z, 2 `it(`
cases).

**Measured, with a positive control in the same run** (`npx vitest list --run` in `apps/web`):

```
CompletenessPill occurrences in the collected list : 0
ProjectionCell   occurrences (positive control)   : 15
```

`ProjectionCell.vitest.test.ts` is the sibling that renders a `.tsx` from a `.ts` suite with the same
`renderToStaticMarkup` technique, and its 15 cases are collected. The only difference is the file extension. The
assertions themselves are fine for a node environment (`// @vitest-environment node` on line 1, no jsdom, no
`@testing-library`, no `document.`) — it is the glob that excludes it.

**Proposed fix.** Rename the file to `CompletenessPill.vitest.test.ts` and import the component as
`ProjectionCell.vitest.test.ts` does (its header documents the convention), rather than widening the `include` glob —
widening it would silently admit any future `.tsx` test that *does* assume a DOM, which is the thing the node-only
config exists to prevent.

## P3-22c · The wire-mirror parity test omits `contentAcknowledged`, the field the acknowledgement gate reads

`apps/web/src/app/products/[id]/edit/_studio/sheet/content-wire.vitest.test.ts`, `describe('LX.12 canonical language
wire mirrors')`, 5 tests — run at 07:01:52Z, all passing. Its strongest test (file line ~55, *"refuses any new field
present on just one sheet mirror"*) is properly **derived**: a TypeScript AST walk enumerates every member declared on
each mirror's own `StudioCellValue` / `SheetColumn` body and diffs the two key sets against an explicit exemption
list. That one is exemplary.

The gap is in the hardcoded lists beside it. `ContentWriteFacts` (`packages/shared/content-language.ts:44-53`) declares
**four** members — `contentAddress`, `contentVersion`, `contentAcknowledged`, `contentAcknowledgement` — while the
no-local-duplication assertion at **`content-wire.vitest.test.ts:73`** checks only
`['contentAddress','contentVersion','contentAcknowledgement']`. `/usr/bin/grep -c contentAcknowledged` on that test
file returns **0**: it appears in none of the five tests.

`contentAcknowledged` is not decorative — it is the boolean the server's acknowledgement gate reads
(`content-bulk-write.ts:46`, `change.contentAcknowledged !== true`) and the clients set it
(`channel/useChannelSheet.ts:242`, `channel/useChannelSheetAdapter.tsx:758`, `useCellFormulas.ts:205`). A field
redeclared locally on **both** mirrors with divergent types would pass every one of the five tests, because the derived
set-diff only catches a field present on one side. `reference_a_list_of_members_is_a_set_claim`.

**Proposed fix.** Derive that list too: read the member names off `ContentWriteFacts` with the same `properties()`
helper the file already has, and assert no mirror redeclares any of them — then adding a fifth member to the shared
contract cannot leave the test behind.

## P3-22d · Correction: no file on disk carries the 04:45 mtime the state block attributes to 8 renderer tests

The takeover state block refers to "the 8 renderer tests rewritten at 04:45". Measured:

```
files under apps/ packages/ scripts/ with mtime in 2026-09-13 04:45:00–04:46:00 : 0
files with mtime exactly 2026-09-13 04:49:54                                     : 164  (26 of them *.vitest.test.ts*)
test files under apps/web/src/design-system/grid/renderers/ with an 04:4x mtime : 0
```

The nearest renderer test is `renderers/provenanceLanguage.vitest.test.ts` at **03:34:52Z** (the LX.10/LX.12
`describeCellSource` suite, 6 cases, green). The 04:49:54 cluster is a bulk restore, not an authored rewrite — and
for every LX file in the review set that carries a recorded manifest hash, the **content after that cluster still
matches the hash** (§0), so the restore put the same bytes back. Nothing was lost and nothing was rewritten at 04:45;
the state block's sentence should be corrected before another lane looks for those 8 files.

On the underlying question the sentence was asking — whether the restored rendering is asserted — both vocabularies are
live and deliberately coexisting per R-LX-1: the master sheet marks cells with `ProvenanceMark`
(`sheet/master/columns.tsx`), the channel sheet's cascade cells with `SourceIndicator`
(`channel/CascadeCell.tsx:6`), and `SourceIndicator.tsx` is byte-identical across the web/factory fork.
`SourceIndicator.vitest.test.ts` (mtime 2026-09-06, untouched by the restore, 3 cases) asserts the restored strings,
e.g. `aria-label="Follows Master. Uses the resolved Master value"`.

## P3-23 · Step 6 has no `source-manifest.json`, so its review set is not derivable from the manifests

Steps 1, 2, 3, 3-switch, 4, 5 and 7 each record their changed files with hashes. Step 6 records none; its **60** files
are only recoverable from `step6/checkpoint-c.json` (76 entries, `path`/`mtime`/`sha256`) and
`step6/checkpoint-d-pending.json` (`file`/`mtime`/`sha256`). The step-6 close-out owes that file (the LX.6 prompt
already asks for it). Until it exists, any later lane deriving "what step 6 changed" from the manifests gets 0 files
and may believe step 6 changed nothing.

## P3-24 · `amazon-content-payload.vitest.test.ts:15` pins the dimension its claim varies

`it.each([['DE','de','de_DE'],['BE','nl','nl_BE'],['BE','fr','fr_BE'],['UK','en','en_GB']])` runs against a fixture
(`:8-9`) that carries translations for **all four** of `de, nl, fr, en`. `expect(attributes.item_name).toHaveLength(
marketplace === 'BE' ? 2 : 1)` therefore only ever measures the both-translated arm — which is exactly the arm
production does not have (§P0-1). Add the untranslated and half-translated arms; both are one line each and both are
red today.

## P3-25 · Correction to the takeover state block: the LX migration folders ARE committed

The state block says the lx4 and lx5 folders are "applied on production, folders **UNTRACKED** — must be committed
before any push". Measured:

```
20260912_lx1_translation_store            TRACKED · IN HEAD
20260912_lx1_remove_legacy_content_guard  TRACKED
20260912_lx2_marketplace_languages        TRACKED · IN HEAD
20260912_lx4_channel_listing_translations TRACKED · IN HEAD   (commit da1078ddf)
20260912_lx5_readiness_index              TRACKED · IN HEAD   (commit da1078ddf)
git status --porcelain -- <all five folders>  →  (empty: committed and clean)
```

`da1078ddf` is *"chore(db): add lx4 and lx5 migration folders already applied on production"*. The action item is
already done; the state block is stale.

**What is NOT committed, and is the thing worth naming instead:** `git show HEAD:packages/database/prisma/schema.prisma`
contains **0** of `model ChannelListingTranslation` / `model ReadinessIndex` (they exist only in the dirty working
tree), and `apps/api/src/services/pim/content-resolver.ts` and `readiness-index.service.ts` are **not in HEAD at all**.
So HEAD is a state where the migrations exist and neither the Prisma schema nor the code does. That direction is the
inert one by `family-projection.service.ts:385-398`'s own asymmetry rule, so it is not an outage — but a
`prisma migrate deploy` from HEAD now creates both tables in any fresh environment, unused
(`reference_migrate_deploy_drags_parked_migrations`).

## P3-26 · The reconcile cron's lock is shorter than a full reconcile run

`apps/api/src/jobs/readiness-reconcile.job.ts:1` uses the clustered cron (`lib/cron/clustered.ts`), which claims a
per-tick Redis lock — so `reference_cron_is_per_process` is genuinely addressed, not merely commented. But
`clustered.ts:45` holds it for `LOCK_TTL_MS = 50_000`, while the step-5 measurement (714 rows in 4,087 ms for one
family) puts a 37-family reconcile at roughly 150 s. With a daily schedule no second tick contends, so nothing
doubles today; the note is that the lock stops protecting the run two thirds of the way through, and any move to a
shorter schedule would double the work silently. One sentence in the job, or a renewing lease, closes it.

---

# Verified correct — what I checked, where, and why it holds

Each item names the instrument. Where the claim is a negative, the positive control that fired is named with it.

**The resolver (`apps/api/src/services/pim/content-resolver.ts`, 245 lines)**
- **Order is §5's**, in one function: pin (`:185-198`) → language (`:199-202`) → source (`:203-204`) → computed
  (`:205-206`). No second branch reorders it; `resolveContentBatch` (`:236-244`) reuses the same closure per family
  member, so a batch cannot diverge from a single read.
- **The legacy pin is read only for `languages[0]`** — `:190`, `requested === normalizeLanguage(listing.languages[0])`
  — exactly LX.3, and it is skipped when the row's `follows` list names the field (`:189`, `:190`), so a reset really
  returns to the tier.
- **Ownership is checked before anything is read**: `:161-162` refuse a parent whose `parentId`/workspace does not
  match and a listing whose `productId`/workspace does not match; `:164-165` filter translation rows by workspace and
  owner id. A cross-workspace row cannot answer a cell.
- **`''` and null are one rule, stated once** (`:70`, `present()`), and an explicit clear survives it: the write path
  records the clear as a key in the `attributes` bag (`content-write.ts:59`, `translation-write.ts:38`) and the
  resolver honours authored presence over emptiness at `:130`, `:153`, `:189`, `:201`. The two halves match.
- **The `outdated` fingerprint is computed over the same field set on both sides** — writer
  `translation-write.ts:54`, `contentSourceHash(product, parent, Object.keys(attributes))`; reader
  `content-resolver.ts:179`, `contentSourceHash(owner, …, authoredFields)` with
  `authoredFields = Object.keys(row.attributes ?? {}).sort()`; and `contentSourceHash` (`:100-103`) sorts and
  de-duplicates internally, so key order cannot change the hash. This is the step-4 defect ("a newly reviewed
  translation appeared outdated because the reader fingerprint included extra schema fields") and it is closed.
- **Ambiguous regional siblings fail loudly, not silently** — `:106-120` `translationIndex` throws
  `Ambiguous content translations for <language>` when two rows normalise to one language and neither is canonical;
  `packages/shared/content-language.ts:34-41` does the same for JSON-keyed stores. Production carries none:
  `production-baseline.json` → `regionalRowsByStore.ProductTranslation: 0`, `unknownLanguages: []`.

**One cascade, five collapsed (Appendix B)** — each of the five now calls the one resolver, verified by reading the
call, not the comment: `attribute-resolver.ts:267` (`resolveContentAttributes`),
`resolve-channel-field.ts:90` and `:615` (`resolveContentPath`), `content-locale.ts:22` and `:44` (`resolveContent`),
`etsy/information-content.ts` (now **9 lines** total, delegating), `products/translation-resolver.service.ts:74`
(`resolveContentAttributes`). `DEFAULT_LOCALE` is gone: `/usr/bin/grep -rn DEFAULT_LOCALE apps/api/src` → exit 1, no
matches, against a positive control of **33** files containing `PRIMARY_CONTENT_LOCALE`.

**The legacy JSON is read-only for content.** `mergeLocalizedContent` (`localized-content.ts:13`) has **no
non-test caller** — `pim-global.routes.ts:310` imports only `validateLocalizedPatch`. The surviving
`localizedContent` writers are `images/product-media.service.ts:81,139` (media captions, "keep" per Appendix C) and
the two Owner-untouchable flat-file seeders (`amazon/flat-file.service.ts:1697`,
`ebay-flat-file-create.logic.ts:276`). No route writes localized text into the slot any more.

**The primary language is one value, derived once and not from a per-request env read at the call sites.**
`content-locale.ts:7`, `PRIMARY_CONTENT_LOCALE = normalizeLanguage(process.env.NEXUS_PRIMARY_LANGUAGE ?? 'it')` —
already normalised at definition, so `translation-write.ts:21`'s `language === PRIMARY_CONTENT_LOCALE` cannot be
defeated by a regional env value. `NEXUS_PRIMARY_LANGUAGE` is set in none of `apps/api/.env`, `apps/web/.env.local`,
`.env` (so the default `'it'` is in force), and `NEXUS_CONTENT_RESOLVER` is unset, so
`contentResolverEnabled()` (`content-resolver.ts:64`) returns v2 — the resolver is live, not dark.

**No `ProductTranslation` row can be created for the primary language.** `translation-write.ts:21-23` refuses
`language === PRIMARY_CONTENT_LOCALE` with a 400 naming the language, and it is the only creator: the three
`productTranslation.create/update/delete` sites are `translation-write.ts:49,57,59` plus
`catalog-translate.ts:140`, which is the revert's fingerprint restoration *after* a routed `writeContent` in the same
transaction. So the resolver's deliberate skip of the language tier for the primary language
(`content-resolver.ts:199`) cannot hide a written value. Production agrees: the single row is `{"en": 1}`.

**Write routing carries the language axis and the client never re-derives it.**
`resolveWriteRouting` (`studio-sheet.service.ts:570-612`) returns `contentAddress` = `{tier:'source'}` /
`{tier:'language',language}` / `{tier:'pin',language,coordinate}` per §6's table, computed per cell per row with the
sheet's locale at `:1194-1197`. The master writer reads it off the cell and nothing else —
`masterWrite.ts:120`, `contentAddress: req.row?.values?.[c.colId]?.contentAddress`, beside the comment
*"The server told us the field name; never re-derive it from the column key."*

**`contentVersion` is a real CAS, not a flag the API accepts and ignores.** I checked this specifically because
`bulk-edit.service.ts:59` declares it and never reads it. It is consumed: `bulk-edit.service.ts:571-580` routes
**every** localizable change out of the legacy branch into `applyContentBulk`, which passes
`expectedContentVersion: change.contentVersion` at `content-bulk-write.ts:68` into `writeContent`, where it guards
the `ProductTranslation` row (`translation-write.ts:29`) and the `ChannelListingTranslation` row
(`content-write.ts:53`). `reference_api_accepts_a_flag_it_ignores` does not apply here.

**The acknowledgement cannot be skipped on a channel scope.** `content-bulk-write.ts:45-46`: a pin address whose
coordinate does not match the request's is refused; and with a coordinate present, any address that is not a pin —
or any cell the server marked `contentAddress: null` — is refused unless `contentAcknowledged === true`, with the
refusal quoting both answers. `:29-30` additionally refuse more than one marketplace context per write and any
address whose language disagrees with the request's locale, naming the locale the sheet showed.

**Audit rows carry the language on every tier.** `translation-write.ts:64-66`
(`metadata: { source, layer:'language', language, intent }`), `content-write.ts:74-75`
(`metadata: { layer:'pin', language, coordinate }`), `master-content.service.ts:151`
(`metadata: { fields, language, reason, cascadedListingIds, queuedSyncIds }`).

**The same-language cascade runs from every caller, and only for that language.**
`master-content.service.ts:104-107` refuses a pin address or a `ctx.locale` that disagrees with the address, then
`:120` skips any listing whose `marketLanguages(...)` does not include the language, and `:122-130` marks following
intent on the `ChannelListingTranslation` row for that language rather than writing an untagged listing column. The
outbound payload is language-qualified at `:141-143` (`locale: language, language, …payload`). Both content writers
reach it: `content-write.ts:43` (source tier) and `translation-write.ts:63` (language tier).

**The readiness producer runs inside the write, in all three entry points.** `produceReadiness` has exactly three
call sites — `content-write.ts:76` (pin), `master-content.service.ts:153` (source and language, reached from both
writers), `bulk-edit.service.ts:2587` — and it defers to `beforeDatabaseCommit` (`readiness-index.service.ts:14`), so
a failure rolls the content write back rather than leaving a stale index. `reconcileFamilyReadiness` replaces **only**
the derived rows (`:74-75`, `deleteMany` + `createMany` scoped to the family's product ids) inside one transaction.

**LX.9's filled rule is implemented where readiness is computed, twice consistently and not by two derivations.**
`studio-sheet.service.ts:1496` (the issue, `severity: 'error'` when the column is required by any shape or by a
mapping rule) and `:1558` (the filled count: a cell counts only when `!translationMissing(cell.language, locale)`),
both through the one exported `translationMissing` (`content-resolver.ts:67`). An untranslated required field
therefore yields an `error`, and `readiness-model.ts:43` turns any error into **`blocked`** — the design's
"Showing the Italian source on Amazon·DE is `blocked` for German, never `ready`". `pct` is `null`, never 0, when the
scope is unscorable (`readiness-model.ts:39-42`, `scope-readiness.service.ts:14-17`).

**The readiness reader constructs no sheet.** `scope-readiness.service.ts` (64 lines) touches
`prisma.readinessIndex`, `prisma.product`, `prisma.marketplace` and nothing else; `getStudioSheet` does not appear in
it. Its coordinate key includes account and alias (`readiness-model.ts:64-66`), which is Q-LX5-1's resolution, so a
pin on one destination cannot make another read ready.

**`Marketplace.languages` is the one authority, and the accessor is keyed by (channel, code).**
`market-languages.ts:16-29`: both overloads look the row up by `{channel, code}` — never by code alone, which is the
`sheet-columns.service.ts:1079` defect the design names — normalise every value, and **throw** rather than guess when
a row carries no languages (`:24`). `languageTag` (`:33-36`) validates both inputs and maps `UK → GB`.
`availableContentLanguages` and `marketplaceForLanguage` both read the same rows. The guard run at 06:50Z:
**2/2 tests, 1498 files scanned, 13 exemptions, 0 violations**, with eight positive controls inside the test
(`market-languages-guard.vitest.test.ts:14-21`) including two that must fire and six that must not.

**`languageTag` is on the Amazon publish path that matters, from the resolved language.**
`amazon-content-payload.ts:54` stamps `languageTag(resolved.language, input.marketplace)`, and both Amazon builders
route content through it: `marketplaces.routes.ts:33` and `outbound-sync.service.ts:309`. Per §10's list:
`outbound-sync.service.ts` ✅ (via the content branch), `marketplaces.routes.ts` ✅, the flat-file generators are
Owner-exempt and keep their own tags, and `amazon-batch-feed.service.ts` publishes price/stock/status/image operations
only (`AmazonBatchOperation`, `:66-83`) — no localized text, so it needs no tag. eBay takes the site language from the
authority rather than a code map (`marketLanguages(...)[0]` via the accessor). The defects in this area are the
*duplicate* and the *foreign tag* (P0-1, P1-7), not a missing stamp.

**D7's sentence names the language, identically at preview and at publish.**
`amazon-content-payload.ts:39`, `` `Review the ${Intl.DisplayNames…of(row.language)} (${row.language}) ${field} before
publishing.` ``, produced by the one `publishReviewIssues` that both `marketplaces.routes.ts:1027` (publish) and
`:1216` (preflight) call, and enforced as a 422 at `:46`. A following legacy snapshot cannot conceal an unreviewed
shared draft — `:27-30` re-resolves without the listing and returns the shared draft instead. Fixture coverage at
`amazon-content-payload.vitest.test.ts:30` and `:35`.

**LX.11's Languages view is one widening of real per-scope sheets, grouped by field.**
`language-sheet.ts:19-22` mints `${key}@${locale}` with `group: column.label` and
`groupKey: 'language:'+key` — a translator reads the source beside each language, as §LX.11 asks.
`sheetLanguages` (`:7-11`) normalises every requested locale and refuses an empty list with a 400.
Each language column takes its **cell** from that language's own sheet (`:26-28`), so the write address per
language column is that language's — I checked this specifically because the column objects are spread from
`sheets[0]`: the address lives on the cell (`studio-sheet.service.ts:133`, `StudioCellValue extends …
ContentWriteFacts`), not the column, and the two column-level `resolveWriteRouting` calls (`:1742`, `:1782`) pass no
`content` argument and therefore carry no address.

**The channel sheet's column builder is hoisted, not inlined.**
`apps/web/src/app/products/[id]/edit/_studio/sheet/buildSheetColumns.tsx` exists as a module with its own test
(`buildSheetColumns.vitest.test.ts`), which is the "two column builders drift" trap closed on the web side.

**`assertInformationLocale` is LX.10's rule and is armed at every channel call site** — see P2-17 for the two gaps;
the working half: `information-locale.ts:11-13` refuses a language outside `marketLanguages` and **names the market's
languages** in the message, and all four channel-scope callers pass the authority.

**Translate (LX.18) is filter-scoped, preview-first, one operation, revertible by value, on the language tier.**
Verified line by line: scope is the grid request, not an id list (`packages/shared/products-grid.ts:54`,
`catalog-translate.ts:32-37` destructures only `where` and discards paging); no cap
(`/usr/bin/grep -n 200 catalog-translate.ts` → one hit, the comment at `:24` saying there is none; `BATCH_SIZE = 100`
at `:15` is paging); preview is read-only and returns the three counts plus a rate-card cost (`:71-76`,
`previewCatalogTranslation` at `:79` calls only `product.findMany` and `marketplace.findMany`); **one**
`bulkOperation.create` (`:87`) against five `update`s on the same `job.id`; revert restores the captured `before` row
verbatim including `reviewedAt`/`authoredAt` (`:137-140`) and refuses when the row moved
(`:134`, hash + `Product.version`), with a CAS claim against a double revert (`:123-124`); drafts land on
`{tier:'language', language}` (`:96-97`) and are stamped `source:'ai'`, `reviewedAt:null` by the writer
(`content-write.ts:69`). Generation is gated shut and has no HTTP route:
`/usr/bin/grep -rn applyCatalogTranslationDrafts apps packages docs` → 4 hits, all the definition plus its test, and
`catalog-transfer.routes.ts:86` answers `requireTranslationGeneration()`.

**`/products/next` sorts and filters the language columns server-side, and both sides name the same field.**
The column id grammar is one shared parser used by both apps — `packages/shared/products-grid.ts:36-39`,
`catalogLanguageColumn` — so the client's ids (`languageColumns.tsx:13,19,22`) and the server's reads
(`products-grid.contract.ts:116-121` sort, `:177-181` filter) cannot drift on the name. The readiness value
vocabulary matches exactly on both sides (4 members, `readiness.ts:59-66` vs the allowlist at
`products-grid.contract.ts:179`). The predicates are real SQL over `ReadinessIndex`
(`catalog-language.ts:14-25` filter, `:49-54` sort) and the readiness projection reads the index
(`:33`, `prisma.readinessIndex.findMany` with `channel: null, market: null, accountId: null, aliasId: null`) rather
than recomputing a sheet.

**`studio-columns.ts` is cache-first with a database-dated stamp.** The cache decision is `:68-69`; the key
(`:51-66`) includes the account, market, locale and — importantly — `cachedSchemasOnly() ? 'cached-only' :
'interactive'` (`:52`), so a cache-only build can never be served to an interactive caller. The schema age comes from
`CategorySchema.fetchedAt` (`channel-specs/index.ts:47-55`, `sheet-columns.service.ts:1199`), never `Date.now()`;
`Date.now()` appears in the chain only as a TTL comparator.

**Import/export carries the language and the parser is strict.** `import-diff.service.ts:104-149` rejects a header
with more than one `@` (`:112`), requires channel and market when a coordinate is present (`:136`), validates the
locale shape (`:137`) and normalises it (`:144`); the workbook template normalises every requested locale, caps at 30
and excludes the primary language from the per-language sheets (`catalog-workbook-scopes.ts:29-56`). The import's
refusal keys are language-qualified so a DE refusal cannot contaminate the same FR field.

**`apps/web` vitest stays node-only in the LX set.** The one `.tsx` test —
`apps/web/src/design-system/grid/renderers/CompletenessPill.vitest.test.tsx:1-2` — opens with
`// @vitest-environment node` and asserts on `renderToStaticMarkup` output, not on a DOM. No `render(`,
`@testing-library` or `document.` assertion in the LX web set.

**The reconcile job is cluster-safe by construction, not by comment.**
`readiness-reconcile.job.ts:1` imports `../lib/cron/clustered.js`, whose per-tick Redis claim exists precisely for
`reference_cron_is_per_process` (`clustered.ts:1-32`); the job pages products by cursor in 100s (`:13-19`), collects
per-family failures instead of aborting (`:16-17`) and **throws** a message naming the counts if any family failed
(`:21`) rather than reporting a clean run. A disabled path is explicit (`:26`,
`NEXUS_ENABLE_READINESS_RECONCILE === '0'`), and that variable is set nowhere, so the cron is armed.

**LX.10's chips are derived from the wire, and both hardcoded lists the design named are gone.**
The list comes from `GET /api/marketplaces/grouped` → `MarketplaceLite.languages` → `scopes.ts:92` (`flattenGrouped`),
`:111` (`deriveScopeOptions`) and `:67` (`primaryLanguageFrom`, reading `_meta.primaryLanguage` — the step-7 → step-6
handoff), then `contracts.tsx:679` `scopeLanguages(scope, market, marketplaces, primaryLanguage)` (`scopes.ts:198`) and
`StudioBar.tsx:46` `options.locales.map(...)`. Grepping `languageChips.ts`, `useLanguageChips.ts`, `languages.ts`,
`StudioBar.tsx`, `contracts.tsx` and `scopes.ts` for `'it'|'de'|'en'|'fr'|'nl'|?? 'it'` yields exactly **one** hit —
`scopes.ts:49`, `new Intl.DisplayNames(['en'], { type: kind })`, the *display* locale for rendering a code as an
English name, which cannot affect which languages are offered. The two lists the design names as removals are gone:
`contracts.tsx` has no language-code array anywhere (`/usr/bin/grep -nE "\['?it'?,|LANGUAGES\s*="` → 0 hits), and
`tabs/LocalesTab.tsx` enumerates nothing locally — its known and addable locales both come from
`GET /api/products/:id/translations` (`:221-232`, `json.availableLanguages` / `json.primaryLanguage`), with
`languageLabel` used only to render. Positive control for the instrument: the same pattern *does* match `scopes.ts:49`.

**No StrictMode cleanup-only latch in `_studio`.** The pattern `let (mounted|cancelled|isMounted|active) = true`
has two in-scope hits — `sheet/EbayPolicyInput.tsx:16` and `sheet/ReferenceSelectEditor.tsx:17` — and in both the flag
is declared **inside** the effect callback on every invocation and flipped only by that same invocation's cleanup, which
is the correct idiom, not the latch (`reference_strictmode_latching_cleanup_flag` needs the flag to outlive the effect).
Searching `_studio` for the dangerous shape (a `useRef`/module-scope flag with a mounted/latched name) → **0** hits.
Positive control: the first grep also matches 3 files elsewhere in `apps/web`, so it was pointed at something.

**The two toast providers are a ruled, documented decision, and `_studio` does not mix them.**
`reference_ds_toast_two_providers` applies to this route: the root layout mounts the legacy `@/components/ui/Toast`
provider, so `StudioClient.tsx:24,39` deliberately re-mounts the design-system `ToastProvider` around the `_studio`
subtree, with the reason and the ruling stated at `StudioClient.tsx:8-20`. All **6** `useToast(` call sites inside
`_studio` import from `@/design-system/components` — the provider that is actually mounted above them — while the
sibling tabs outside `_studio` (`LocalesTab.tsx`, `MasterDataTab.tsx`, `PricingTab.tsx`) use the legacy one. No mixing
inside the LX surface.

**Autosave has a navigation guard, and it guards in-flight writes rather than dirtiness.**
`apps/web/src/app/products/[id]/edit/_studio/contracts.tsx:546-590`, `useInFlightGuard`, whose header (`:533-544`)
states the distinction explicitly (*"a per-cell autosave means writes are IN FLIGHT"*). It installs both real exit
paths: `beforeunload` (`:568-576`) and a capture-phase click interceptor for in-app `<a>` navigation via
`shouldInterceptLeave(...)`, exempting ⌘-click/new-tab, asserted in `saveState.vitest.test.ts:96`. Its trigger is
`pendingWrites(state)`, not `state.kind === 'saving'`, so an error state that still holds in-flight writes is guarded.
`reference_autosave_still_needs_a_nav_guard` is satisfied.

**Nothing was committed by this lane, no row was written, no provider was called.** The two probes I ran are in the
session scratchpad, not the repo: a vitest file executed against the apps/api config with `prisma` and `fetch`
stubbed (4 tests, 4 passed — `fetch` was stubbed to throw and never called), and a `tsx` script over the pure guard
module. The two existing integration suites I ran (`content-write`, `readiness-index`) mock `@nexus/database` to a
**disposable** PostgreSQL created by `apps/api/src/test-support/formula-database.ts` and closed in `afterAll`; they
never touch `127.0.0.1:55439/nexus_development` or Neon.

---

## Retracted — a finding of mine that measurement refuted

I drafted **"P1-3 · A raw listing CUID is rendered to the operator as the pin's provenance"** as a P1, on two true
facts: `content-resolver.ts:183` does set a pin's `from` to `listing.id`, and `provenance.ts:364-366` does interpolate
`from` into the operator-visible sentence. I then went looking for the render and the render is not there:
`studio-content-wire.ts:12` relabels every pin before the studio wire (sole caller `studio-sheet.service.ts:1373`),
`catalog-language.ts:37` passes no listing so `/products/next` cannot reach the pin branch at all, the master sheet
maps ids to SKUs (`columnRules.ts:107`) and returns null rather than printing one, and
`provenanceLanguage.vitest.test.ts:44` already asserts that an id handed to `describeCellSource` is replaced by the
tier label. The claim as written was false; it is recorded above as **P2-3b**, a latent hazard whose safety is held by
a wrapper and a call shape rather than by the resolver, which is what it actually is.

I am recording the retraction rather than quietly deleting it because the two facts that produced it are still true and
a later reader will find them. A correction appended below a claim does not retract the claim
(`reference_a_banked_rule_can_go_false`) — so the P1 is gone from the ranking, not annotated in place.

Separately I corrected one instrument error of my own: my first reading of `check-ds-fork-drift.mjs --check` reported
exit 0 because `$?` after a pipe into `tail` is `tail`'s status. Re-run with the output redirected, plain mode is
exit 0 and `--check` is exit 1 (`scripts/check-ds-fork-drift.mjs:103`). The numbers in P2-3 are from the second run.

## Not done, and why

- **`npx tsc --noEmit` for web and API was NOT run.** `uptime` read `load averages: 8.83` at 06:40Z and `9.77` at
  06:42Z, above the concurrent-sessions etiquette threshold of 8, with VT.1 and VT.2 saving into
  `studio-sheet.service.ts`, `sheet-columns.service.ts`, `master/columns.tsx` and `design-system/grid/editors/*`
  during the window. A typecheck taken across another lane's mid-edit revision would have produced diagnostics I
  could not attribute (`reference_establish_attribution_before_reverting`). **No typecheck claim is made either way.**
- **No screen reading.** I ran no browser, so nothing in this review says a surface "renders". P1-3, P1-4 and P1-6 are
  derived from the code and the wire and each names the line that would show it; they want one screen confirmation
  each before they are closed.
- **Amazon's tolerance of a foreign `language_tag` is unmeasured** (P1-7). It cannot be measured without a provider
  call, which this lane does not make.
- **The remaining 24 of 38 API and 19 web LX test files were not executed** — I ran the 14 most LX-central API files
  plus `drawer/layers.vitest.test.ts`, `market-languages-guard.vitest.test.ts` and
  `content-read/content-write` twice. The counts above are for what I ran; no aggregate green claim is made for the
  suite as a whole.
- **`check-layout-v2.mjs`, `check-control-census.mjs` and `check-editor-open.mjs --strict` were not run** — each drives
  a browser, which must be announced in the ledger and run alone while VT.2 also runs gates. The state block's
  "`check-layout-v2.mjs` and `check-control-census.mjs` were never run for LX" is therefore still open, and it is
  LX.6's item 5, not mine. `scripts/check-ds-fork-drift.mjs` needs no browser and **was** run (P2-3).
- **The `docs/audits/2026-09-13-lx-revert/README.md` undo record was not read.** My §0 hash comparison already
  establishes the tree's relationship to the step manifests independently, which is the stronger instrument for a
  reviewer, but a lane reconciling the 05:05/05:25 sequence should read that file rather than infer it from my mtimes.
