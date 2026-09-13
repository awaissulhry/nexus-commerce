# LX — takeover lane prompts (language axis) — 2026-09-13

**Owner's word 2026-09-13:** "Take over the LX language axis lane. And do whatever is necessary to make sure it's all AAA
quality." Orchestrated in-session by `[3aec8721]` (the same session orchestrating VT). Design:
`docs/2026-09-11-language-axis-design.md`; build prompt `docs/2026-09-11-language-axis-build-prompt.md`; LX audit
evidence `docs/audits/2026-09-12-language-axis/`; the 09-13 revert/undo record `docs/audits/2026-09-13-lx-revert/README.md`.

## State at takeover (measured 2026-09-13 ~07:40, from the ledger + audit manifests + tree)

- Steps 0–5 (measure · store · authority · resolver · write routing · readiness) — **done and closed by the Owner**.
- Step 6 (screen): (a) DS `describeCellSource` + `outdated` + hoisted `channelColumns.tsx` — landed; (b) language chips — done;
  (c) Languages view — 20/20 screens exit 0 both themes at 00:48Z, "checkpoint only, not accepted"; (d) cells through
  `ProvenanceMark`/`describeCellSource` (= LX.12) — implemented, gate exit 1 twice (Q-LX6-2), **then UNDONE by the Owner at
  04:30** ("I do not want any differences at all"); (e) compare pane (LX.13), (f) acknowledgement wording (LX.14 on screen),
  (g) master readiness columns from the index or deleted (LX.15), (h) legacy edit page retired (LX.16, D6) — **not started**.
  **No §4 record for step 6.** `check-layout-v2.mjs` and `check-control-census.mjs` were **never run for LX**.
- Step 7 (catalogue · publish): implementation complete (45 files), strict editor gate exit 0 at 00:26:44Z, §4 report at
  00:29Z, **stopped at the gate awaiting acceptance**. Two hand-offs to step 6: **123 cold seller-spec gateway entries on a
  full Studio load** (`apps/api/src/services/categories/reference-labels.service.ts:30`) — a live provider call per page
  load, exactly the trap the step-7 gate forbids; and "undeclared/unrendered optional cells unmeasured" by the strict run.
- Migrations `20260912_lx4_channel_listing_translations` + `20260912_lx5_readiness_index`: applied on production; folders
  **COMMITTED 2026-09-13 as `da1078ddf`** on the Owner's word (only those two files; unpushed). What is NOT in HEAD is the
  rest of LX: `schema.prisma`'s LX models, `content-resolver.ts`, everything else in the tree.
- DS fork drift on `design-system/grid/renderers/index.ts` (web vs factory); `drawer/layers.vitest.test.ts` does not map the
  new `channelSnapshot` source; Q-LX4-2 loading-state reclassification not applied.
- Persisted per-user layout: master lands on `Custom (227)` (Customise → Reset) — per-user state, re-check on screen.

## Orchestrator rulings (under the Owner's delegation, 2026-09-13)

- **R-LX-1 Q-LX6-2 is CLOSED as superseded.** Item (d) was LX.12; the Owner undid LX.12 at 04:30. The sheets keep the
  checkpoint renderers (per-cell `SourceIndicator` on channel cells, checkpoint master renderer and tooltip format).
  `describeCellSource` stays in the DS and in `/products/next/languageColumns.tsx`. The design's LX.12 is recorded as an
  **Owner deviation**, not re-landed. No lane touches `CascadeCell.tsx` / `master/columns.tsx` renderer hunks for LX.
- **R-LX-2 The not-reverted surfaces are WANTED.** StudioBar language chips, the Required / Languages / Needs translation /
  Out of date toolbar chips and the Languages view stay (the Owner's 05:25 words: "Didn't we make the chips for languages
  in the latest version?"). The dropped cross-channel footer note was measured absent at the checkpoint API too — not an
  LX regression; LX.6 measures it once more and records the answer.
- **R-LX-3 The screen bar is the design's:** seen on screen at 1440 and 1728, both themes, every scope, numbers in the
  ledger; `check-editor-open.mjs --strict`, `check-layout-v2.mjs` §9.1 and `check-control-census.mjs` green.
- **R-LX-4 A channel page load makes NO provider call.** The 123 cold gateway entries are a defect to fix, not a note.
- **R-LX-5 Sequencing with VT:** VT.2 owns `_studio/sheet/master/columns.tsx`, `master/channelColumns.tsx`,
  `design-system/grid/editors/{sheetColumn,shapeColumn,sheetWriter}.ts`, `_studio/variants/channel/dock/sections.tsx`;
  VT.1 owns additive hunks in `studio-sheet.service.ts`, `sheet-columns.service.ts`, `scope-readiness.service.ts`,
  `product-studio.routes.ts`. LX lanes do not edit those files; item (g) (master readiness columns) waits for VT.2's
  report and is claimed afterwards.

## The AAA bar

Verbatim from `docs/vt-prompts.md` § "The AAA bar" — paste it at the top of every LX prompt; it binds LX lanes identically.

---

## LX.R — independent quality review of everything LX landed (read-only)

[paste "The AAA bar"]

You are lane **LX.R**, a READ-ONLY reviewer. You edit nothing, run no browser, write no database row; you may run vitest
and tsc. Claim `### LX.R — agent of [3aec8721] — quality review, read-only — 2026-09-13` at the bottom of `docs/pes-claims.md`.

Read: the state block above; `docs/2026-09-11-language-axis-design.md` (all; §3 the one contract, §5 resolver, §6 write
routing, §7 readiness, §8 screen, §9 catalogue, §10 publish, §12 verification protocol, §14 decisions D1–D7 on their
defaults); the LX ledger sections (`/usr/bin/grep -nE "^LX|^### LX|LX Step" docs/pes-claims.md` — read each §4 record:
lines ~38642–40590); the step manifests under `docs/audits/2026-09-12-language-axis/step*/` (they list every file LX
changed — that list is your review set; derive it from the manifests, never from memory).

Review the LANDED code against the design and the memory traps, hunting defects the way the traps were found — read the
consumer, not the producer's comment: `reference_two_column_builders_drift`, `reference_a_list_of_members_is_a_set_claim`,
`reference_contract_field_varies_by_market`, `reference_write_predicate_must_match_its_readers`,
`reference_check_what_else_read_from_what_you_narrowed`, `reference_null_matches_every_lte`, `reference_and_guard_does_not_exclude_null`,
`reference_prisma_not_excludes_null`, `reference_cron_is_per_process`, `reference_cursor_fields_are_metronomes`,
`reference_strictmode_latching_cleanup_flag`, `reference_autosave_still_needs_a_nav_guard`, `reference_ds_toast_two_providers`,
`reference_comment_asserts_property_code_lacks`, `reference_docs_describe_deleted_code`. Specifically verify, with file:line:
1. **The resolver** (`content-resolver.ts`): pin → language → source → computed, exactly §5; the locale normaliser at every
   boundary (§LX.4); no second cascade anywhere (Appendix B's five collapsed — grep for survivors); `''`/null handling.
2. **Write routing** (`studio-sheet.service.ts:551+`, `content-write.ts`, `translation-write.ts`, `content-bulk-write.ts`):
   every caller passes the language axis; the acknowledgement path; audit rows carry the language; the zero-change trap.
3. **Readiness** (`readiness-index.service.ts`, `readiness-reconcile.job.ts`, `scope-readiness.service.ts`): the producer
   runs inside the write; the reconcile job is per-process safe; the LX.9 rule (filled only when resolved language ==
   coordinate's); an untranslated market reads `blocked`.
4. **`Marketplace.languages` is the only authority**: no surviving market→language literal (the LX.2 guard's exemptions —
   read each of the 13 and say whether it is justified); `languageTag` on EVERY Amazon publish path in §10 (list each path
   and whether it stamps it); D7 `requireReviewed` enforced at publish with the preflight naming the language.
5. **The screen**: `StudioBar` chips derive from the wire, not a literal; the Languages view columns `<key>@<locale>`
   grouped by field; the toolbar chips' counts are real; the wire mirrors (`sheet/master/types.ts` vs `channel/types.ts`)
   have the parity test the design demands; the 8 renderer tests rewritten at 04:45 assert the RESTORED rendering.
6. **Step 7**: `studio-columns.ts` cache-first (schema-age stamp = DB date, no provider call on a channel page load — and
   the `categories/reference-labels.service.ts:30` leak); `/products/next` `languageColumns.tsx` + `TranslateDialog.tsx`
   (filter-scoped, preview first, one `BulkOperation`, revertible, `✦` drafts land on the language tier); the import/export
   `key@channel:market:locale` row; `catalog-translate.ts`.
7. **Tests**: name every LX test file; find assertions that pin the WRONG dimension (a fixture that holds constant what the
   claim varies — `reference_a_fixture_pins_a_dimension`), sentinels that became real, node-only tests asserting DOM.
8. **Drift**: `design-system/grid/renderers/index.ts` web vs factory (what differs, which is right); any other shared file
   pair that differs (`node scripts/check-ds-fork-drift.mjs` if it exists — run it).

Output = your final report AND a file `docs/audits/2026-09-13-lx-takeover/LX.R-findings.md` (create the directory):
findings ranked by severity (P0 data-loss/wrong-write/live-call · P1 wrong result shown · P2 drift/duplication · P3
tests/docs), each with `file:line`, the failure scenario (inputs → wrong output), the evidence you read, and a proposed fix
(one paragraph, no code). Then a section "verified correct" listing what you checked and found right, with the same
precision — a review that lists only defects has no positive control. Numbers, never adjectives. Nothing edited.

---

## LX.6 — step 6 close-out and the step-7 hand-offs

[paste "The AAA bar"]

You are lane **LX.6**, an implementing lane. Claim `### LX.6 — agent of [3aec8721] — step 6 close-out — 2026-09-13` at the
bottom of `docs/pes-claims.md` with the EXACT paths you will edit (locate them first; the list below names the areas). You
never edit VT's files (R-LX-5 above) and never the renderer hunks the Owner restored (R-LX-1: `CascadeCell.tsx`,
`master/columns.tsx` renderer/tooltip, `provenanceMark.tsx` fallback title).

Read: the state block and rulings above; the design §8 (LX.10–LX.16), §11 step 6 gate, §12 verification protocol;
`docs/2026-09-11-language-axis-build-prompt.md` §3 "Step 6"; the LX6 ledger lines (~40151–40579); the design mock at
`apps/web/src/app/design/language-axis/` (scenarios S1–S8 — the screen truth for LX.10–LX.15); the step-6 audit folder
`docs/audits/2026-09-12-language-axis/step6/` (its screen scripts are yours to reuse: `*screen*.mjs`, `before.json`,
`checkpoint-c.json`, `checkpoint-d-pending.json`, `boundary-integration.md`).

Environment: web :3000 (open at `http://localhost:3000`) and API :8091 are up, started by other sessions — never kill or
restart them; API on local Docker `127.0.0.1:55439/nexus_development` (GALE-JACKET `Product.version` 59 local, 51 Neon);
discriminate through the API before any write; writes on the XAVIA fixture family only, restored by value, read back after
≥ 8 s. Browser gates: announce in the ledger (`LX.6 gate starting <what>` / `LX.6 gate finished <what> exit N`) and run
alone — VT.2 also runs browser gates; before starting one, check the ledger's last 60 lines for a `VT.2 gate starting`
without a `finished`, and wait. Two agents share :3000; a source save during a gate invalidates it (Q-LX6-2's lesson) —
hold your own saves while any gate runs.

Do, in this order, each with its numbers in your ledger section before the next:
1. **Close Q-LX6-2** with one ledger line citing R-LX-1. Re-measure the footer note (R-LX-2): on eBay·IT, how many cells
   carry `affectsAllChannels` and whether the checkpoint contract also omitted the note; record the answer, change nothing.
2. **The 123 cold gateway entries** (`apps/api/src/services/categories/reference-labels.service.ts:30`): reproduce on a full
   Studio load with the network capture (positive control: the count), then make the path cache-first with a DB-dated
   stamp exactly as `studio-columns.ts` does, never a provider call on a page load; re-measure: 0 gateway entries on a
   cold Studio load on master, Amazon·IT, eBay·IT, with the capture as evidence and the timing before/after.
3. **Item (c) — the Languages view, accepted on measurement**: against design LX.11 and mock S-scenarios, at 1440 and 1728,
   both themes, on master, Amazon·IT, Amazon·DE, eBay·IT, Shopify and Amazon·BE (nl/fr): the `<key>@<locale>` columns
   grouped by field, chips multi-pressed, the three toolbar chips with real counts (cross-check one count against the API),
   the single-language sheet unchanged. Record every reading. BE: state whether the local NL→BE `CategorySchema` fixture
   seeded at 01:06Z is still present and whether BE text columns populate; if not, say what BE needs.
4. **Items (e), (f), (h)**: (e) LX.13 the compare pane fed — every language of the field (source first) + every coordinate
   carrying it; copy-across writes through the router with the target's address and a copy onto a coordinate says it is a
   pin; (f) LX.14 the acknowledgement `Banner` re-worded for the tier with both answers and the reach named (copy from the
   mock S3); decline reverts the cell; (h) LX.16 retire the legacy edit page — D6 default: when the Languages view is on
   screen, which after item 3 it is: remove the route/tab/menu entries and `LocalesTab.tsx` + the `ProductDrawer.tsx` copy
   block, with a redirect from `/products/[id]/edit` to the studio; list every deleted path. Item (g) is NOT yours yet —
   note it as deferred to a follow-up claim after VT.2 reports.
5. **Gates never run for LX**: `node scripts/check-layout-v2.mjs` (§9.1) and `node scripts/check-control-census.mjs`
   (signed in), plus `check-editor-open.mjs --strict`, the raw-primitives ratchet, the dark-alias guard, the LX.2 language
   guard, tsc web + API, vitest for touched modules, the factory mirror ratchet — one clean run, every exit code.
6. **The Step 6 §4 record**: write it in your ledger section in the format the earlier steps used (what landed · measured ·
   held · open), with the `step6/source-manifest.json` LX never wrote (every file step 6 changed, with hashes).

Done = your final report: files (full paths), the ledger claim, item-by-item numbers (screens per scope × width × theme,
the gateway counts before/after, the compare-pane and banner readings, the deleted legacy paths), test names + counts, every
gate's exit code from one clean run, `ASSUMED:` / `QUESTION FOR THE OWNER:` lines, what you did NOT do and why.

---

## LX.7V — step 7 verification on screen and on the wire (after LX.6's browser gates)

[paste "The AAA bar"]

You are lane **LX.7V**. Claim `### LX.7V — agent of [3aec8721] — step 7 verification — 2026-09-13`. Read the design §9–§10,
§11 step 7 gate, the LX7 ledger lines (~40156–40461) and its audit folder `docs/audits/2026-09-12-language-axis/step7/`.
Verify, on screen and on the wire, against the fixture family only: (1) `/products/next` Language selector + `title@<lang>`,
`description@<lang>`, `readiness@<lang>` columns with marks, server-side sort/filter by readiness state and "falls back to
source" (network capture shows the predicate on the request); (2) the Translate verb: filter-scoped count, the preview
(get a draft / already have one / skipped, cost, reach), ONE `BulkOperation`, `✦` drafts on the language tier, the revert
as a run — exercised on the fixture with the run reverted and read back after ≥ 8 s; D7: an unreviewed draft is refused
at publish preflight, naming the language; (3) import/export: the `key@channel:market:locale` header row round-trips one
value on the fixture (a real write, read back, restored by value — the zero-change trap); (4) publish tags: a dry-run
Amazon payload for a two-language market (BE) carries one entry per language with `language_tag` from
`languageTag(resolved.language, market)`; eBay uses `languages[0]`; (5) a channel page load makes NO SP-API call
(schema-age stamp = DB date; network capture). Record every reading; fix nothing outside a one-line obvious defect in an
LX-owned file (claim it first); everything else is a finding for the orchestrator. Done = the report with numbers.

---

## Orchestrator rulings after LX.R (2026-09-13, on the review `docs/audits/2026-09-13-lx-takeover/LX.R-findings.md`)

- **R-LX-6 (P0-1 + P1-7).** A publish payload emits ONE entry per distinct `(attribute, marketplace_id, language_tag)`. A
  requested language that resolves to the SOURCE tier (untranslated) is **omitted from the payload** and reported by the
  preflight as an issue naming the language — option (a): consistent with LX.9 (an untranslated market reads `blocked`) and
  with D7's preflight. Never a duplicate entry, never the source text under the destination's tag (b), never a foreign tag
  (c). A PATCH that omits an attribute does not delete it on Amazon; a PUT of a required untranslated field is refused by
  readiness. The test `amazon-content-payload.vitest.test.ts:24-27` that pins `it_DE` is corrected with this ruling as its
  reason, and the untranslated / half-translated BE arms become named cases. Behaviour change vs the pre-LX drain (Italian
  descriptions stamped `de_DE` on ~128 DE / ~61 ES / ~53 FR listings) is recorded for the Owner; nothing is deployed yet.
- **R-LX-7 (P0-2).** D7 is ONE function (`assertPublishable` or the existing `publishReviewIssues` lifted) applied at the
  point every publisher converges (the outbound drain / `listing-publish.service.ts`) AND consulted by every named path:
  Amazon, eBay, Shopify, Etsy, `channel-publish`, `content-auto-publish`, `listings-syndication`. `requireReviewed` becomes
  a real setting read by that one function, default ON; the preflight sentence is the single wording. An AI draft
  (`source: 'ai'`, `reviewedAt: null`) never reaches any payload. A test per path proves the refusal (positive control: a
  reviewed row publishes).
- **R-LX-8 (P1-8).** A child's inherited language-tier text exports as `{ state: 'inherited', value: <the parent's text>,
  from: <parent id> }` — value present, ownership stated; never `stored`, never `null`. Transfer writes it onto the child
  only when the parent is not in the transfer set. The assertion at `content-read.vitest.test.ts:68` is corrected to this
  with the reason recorded beside it.
- **R-LX-9 (P1-5).** `ReadinessIndex` empty ≠ ready: the reader distinguishes **not computed** (no rows for the coordinate)
  from computed values and the scope chip says `Not computed` — absent is not empty. A one-shot backfill command (the
  reconcile, invoked once) is the documented deploy prerequisite; it runs on prod only with the Owner's word.
- **R-LX-10 (P2-19).** The Studio sheet read is wrapped in `withCachedSchemas` so a page load is cache-only by construction;
  on-demand paths keep their explicit live intent. One assertion in the gate covers the property.
- **R-LX-11 (P2/P3).** All P2 and P3 findings are fixed, not filed: the DS fork drift (`grid/renderers/index.ts`, factory
  mirrored) and `check-ds-fork-drift.mjs --check` added to every lane's gate list; the LX.2 guard detects bare maps,
  `?? 'it'` and `de-DE`, its 11 vacuous exemptions removed, and it runs inside a gate script; the five duplicated
  definitions collapse to one each; the empty `fallback@<lang>` filter no longer writes; the market-language gate covers
  every channel and carries a status; master and channel locale positions accept the same tags; the batch-feed
  market→locale map is deleted for the accessor; the catalogue sort orders one page server-side; the test harness builds
  its disposable DB from the real `schema.prisma`; `.tsx` tests are collected; the parity test carries
  `contentAcknowledged`; the pinned-dimension fixture gains its arms; the reconcile lock outlives a full run.

### R-LX-9 deploy prerequisite — written by LX.F, 2026-09-13 (numbers measured, not estimated)

**Before the language-axis surfaces go live on production, the readiness index must be built once.** It is empty there
(`docs/audits/2026-09-12-language-axis/step5/production-schema-read.json`: `"rows": 0`, read-only probe on Neon at
2026-09-12T21:38:47Z, migration `20260912_lx5_readiness_index` finished 21:29:58Z), and after LX.F the reader no longer
pretends otherwise: a coordinate with no row reads `notComputed` / "Not computed", never `absent` / "Not set up" and never
a score. Nothing is wrong if the backfill is skipped — every scope chip and the Needs-attention page simply say
"Readiness has not been computed for this language" until the 02:17 UTC reconcile runs or a write touches that family.

- **Command (prod, one shot, with the Owner's word only):**
  `railway run --service "/api" env -u REDIS_URL npx tsx -e "import('./src/jobs/readiness-reconcile.job.js').then(m => m.runReadinessReconcile()).then(console.log)"`
  It is the same `runReadinessReconcile()` the nightly cron calls, it replaces only derived rows
  (`readiness-index.service.ts:74-75`: `deleteMany` + `createMany` scoped to one family's product ids, inside one
  transaction per family), and it writes no content, no version and no legacy JSON.
- **Cost, from the step-5 measurement:** 714 rows in 4,087 ms for ONE family → 37 root families ≈ **150 s** of
  single-threaded work. It also restamps `ReadinessIndex.missing[].kind`, which rows written by the pre-LX.F producer do
  not carry (the catalogue's `fallback@<lang>` filter reads that key — P2-14).
- **Verification after it runs:** `SELECT count(*) FROM "ReadinessIndex"` > 0 and one spot-check that a known
  untranslated coordinate reads `blocked` rather than `notComputed`.
- **Alternative considered and NOT taken:** self-healing on first read (enqueue a reconcile when the reader finds zero
  rows). It hides an unbuilt index behind a background write on a GET, and the honest "Not computed" chip already tells
  the operator what happened. Recommended only if the Owner prefers no deploy step.

---

## LX.F — fix lane for the LX.R findings (P0 → P1 → P2 → P3)

[paste "The AAA bar"]

You are lane **LX.F**. Claim `### LX.F — agent of [3aec8721] — fixes for LX.R findings — 2026-09-13` at the bottom of
`docs/pes-claims.md` with every path you will edit. Read `docs/audits/2026-09-13-lx-takeover/LX.R-findings.md` in full and
the rulings R-LX-6…R-LX-11 above; each finding's "proposed fix" is the starting point, the ruling is the outcome. Order: the
two P0s first, each with its test arms named for the arm that fires today; then P1-4…P1-8; then every P2; then every P3.
After each finding: the test(s) that prove it, run green, and a ledger line `LX.F fixed <id>: <one measured sentence>`.

Shared-file etiquette (VT.1 holds additive claims in `studio-sheet.service.ts`, `scope-readiness.service.ts`,
`product-studio.routes.ts`; LX.6 is editing `reference-labels.service.ts`, `categories.routes.ts` and step-6 screen files):
targeted string edits only, re-read the file immediately before each edit, never rewrite a file, list every hunk in your
ledger section, and write `REQUEST TO <lane>:` when a hunk would sit inside theirs. Never edit `master/columns.tsx`,
`channelColumns.tsx`, the grid editors, `CascadeCell.tsx`, `provenanceMark.tsx` (VT.2's and the Owner's restored files).

Environment: web :3000 / API :8091 belong to other sessions (never restart); local Docker DB `127.0.0.1:55439/nexus_development`
(GALE-JACKET `Product.version` 59; Neon 51) — discriminate before any write; fixture writes only (XAVIA), restored by value,
read back ≥ 8 s; Neon prod is SELECT-only with the URL passed explicitly. Load etiquette: `uptime` load < 8 before a repo-wide
tsc; use `scripts/typecheck-scoped.mjs` for your files otherwise. Browser gates: none are yours except re-running
`check-ds-fork-drift.mjs --check`, the LX.2 guard and the vitest suites; if a fix needs a screen reading, write
`REQUEST TO LX.6:`.

Done = your final report: per finding id → the fix (files, hunks), the test names + counts (before red / after green,
with the positive control), and for the P0s the measured payload arms before and after; every gate's exit code from ONE
clean run (API tsc, web tsc, vitest for every touched module incl. the 14 core LX API files that LX.R measured 13 failed /
105 passed — report the new numbers, `check-ds-fork-drift.mjs --check`, the LX.2 guard, the raw-primitives ratchet, the
dark-alias guard, the AG boundary); the deploy prerequisite text for R-LX-9; every `ASSUMED:` / `REQUEST TO:` /
`QUESTION FOR THE OWNER:`; what you did NOT do and why. Numbers, never adjectives.

---

## Orchestrator rulings after LX.F (2026-09-13 ~13:10)

- **R-LX-16 (F-LX-8, P0-class).** A content write that reports success and stores nothing is refused, never accepted: an Etsy
  cell with `contentAddress: null` ("choose") written through the acknowledgement's pin address either lands on the language
  tier through the router with the address it resolves to, or answers 400 naming the address it needs — no third path. The red
  test in `information-database.vitest.test.ts` becomes the arm; a fixture write on the XAVIA family proves the store, read back
  after 8 s.
- **R-LX-17 (P2-21).** The durable fix, not the cap: materialise the resolved per-language `title` and `description` beside
  `ReadinessIndex` (the producer already computes them) as a sortable projection with an index, so a page sort is one SQL
  `ORDER BY`. Schema change → authored OUTSIDE `prisma/migrations/`, applied to LOCAL only with the discriminator queried, the
  prod SQL verbatim in the ledger for the Owner (the `variationSource` path).
- **R-LX-18 (CENSUS-toolbar).** The sheet toolbar never clips: measured child widths at 1280/1440/1728/2048 decide a collapse
  rule in the ENGINE (`GridToolbar` / `.nds-grid-selbar`, `design-system/grid/theme/grid.css`), never page-local, in this
  priority: the filter chips fold first into one `Filters ▾` menu (count kept on the trigger), then `Export` and `Import` fold
  into `⋯`; count and Find never fold. Census green on amazon·DE and ebay·IT at all four widths is the gate.
- **R-LX-19 (the 13 NUL-byte files).** Fixed, not baselined: each is a delimiter constant — change it WITH its reader in the same
  hunk (they are the same file in every case listed), positive control that the reader still splits, then
  `check-no-nul-bytes.mjs` runs with NO baseline (strict) in every lane's gate list.
- **R-LX-20 (F9).** The reader normalises on read (`EBAY_<code>` → `<code>` at the `CategorySchema` coordinate, one function);
  the untouchable writer's one-line fix and the 3-row migration (local first, collision-checked, restore path written) wait
  for the Owner's exemption and word — asked in the terminal.
- **R-LX-21 (F-LX-4).** The transfer apply's CAS reads the row versions AFTER the same-language cascade has bumped them (or the
  cascade does not bump a channel row it did not change) — the 8 red transfer tests are the arm, plus the positive control that
  a genuinely stale row is still refused.

## LX.F2 — the remaining LX items

[paste "The AAA bar"]

You are lane **LX.F2**. Claim `### LX.F2 — agent of [3aec8721] — remaining LX items — 2026-09-13` at the bottom of
`docs/pes-claims.md` with every path you will edit. Read LX.F's section (`### LX.F — agent of`, ~1,600 lines; its "Not done"
block, its bucket-3 triage table, F-LX-1…F-LX-8, the 13 NUL files, P2-21, F9, CENSUS-toolbar, its REQUEST TO LX.6) and the
rulings R-LX-12…R-LX-21 above. Order: (1) R-LX-16 F-LX-8; (2) R-LX-21 F-LX-4 + the other bucket-3 failures that are LX's or
VT's to explain (`theme-change` 1 is VT.4b's — write `REQUEST TO VT.4:`; `information-database` 2; `channel-specs/etsy-mapping` 1;
`catalog-source-mapping` 1; `product-relationship` 1 — attribute each, fix the LX-caused ones, list the rest with owners);
(3) R-LX-19 the 13 NUL files + strict gate; (4) R-LX-18 the toolbar, with the census through
`node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs` (announce `LX.F2 gate starting/finished`, run
alone — check the last 80 ledger lines for an unfinished `VT.2c/VT.3/VT.4 gate starting`); (5) R-LX-17 the sortable projection;
(6) R-LX-12 the schema-backed reference-label cache; (7) R-LX-14 the four translation surfaces (measure through the wrapper, one
fixture write per surface, then route through the router or remove); (8) R-LX-20's reader half; (9) LX.6's item (g) — the
master sheet's per-coordinate readiness columns fed from `ReadinessIndex` or deleted, never dead (`master/columns.tsx` is free:
VT.2 is done and VT.2c owns only the editor and the dock); (10) LX.F's three screen readings for LX.6 (Amazon·PL cold load after
R-LX-10; a no-schema coordinate's 5-column sheet + `schemaMissing`; the `Not computed` chip). Shared-file etiquette as LX.F:
re-read before every hunk, targeted edits, list hunks, scoped tsc after every export/import hunk (the `_studio/scopes.ts`
incident), never `git checkout/stash/reset/restore`. Done = the report with per-id measurements, the two prod SQLs verbatim,
the census before/after widths, and one clean gate run incl. the strict NUL gate, web tsc 0 and API tsc 0.

---

## Orchestrator rulings after LX.F2 (2026-09-13 ~14:40)

- **R-LX-22 (LX.15 item g).** The master sheet's per-coordinate readiness columns are fed from `ReadinessIndex` in the SCOPE
  vocabulary (`readinessMeta(state, 'scope')`) — they are per-coordinate facts and need no mapping between the two vocabularies
  (PES.0 #3 stands: no converter). A column that cannot be fed in that vocabulary is deleted, never left dead.
- **R-LX-23 (`error-grouping` fingerprints, from R-LX-19's delimiter change).** Existing groups must not split: a one-off
  backfill recomputes every stored fingerprint with the new delimiter (74 rows on local, rehearsed with before/after group
  counts identical), the prod SQL/script goes to the Owner verbatim beside the R-LX-17 SQL.
- **R-LX-24 (R-LX-12).** The schema-backed reference-label cache lands with the schema change authored outside `prisma/migrations/`
  (local apply, prod SQL to the Owner); its cold-load reading is proven with a MOCKED provider (the arm that would call → 0,
  positive control → 1) and the DB-dated stamp on the wire; the live-token reading is an Owner-run item, recorded as such.
- **R-LX-25 (R-LX-14, the remaining two surfaces).** LX.6's section names them (`ProductDrawer.tsx`'s copy block ~:4224-4331 is
  measured as routed; the datasheet tab writes nothing); the remaining two are the "lens" surface and the fourth LX.6 listed —
  identify from LX.6's ledger section and `/usr/bin/grep` for `localizedContent` / `_etsyInformationLocales` writers outside
  the router (positive control: the router's own writer), then route or remove.
- **R-LX-26 (store channels' `Marketplace.languages`).** Until the Owner says otherwise, a GLOBAL store market carries exactly
  the store's own primary language as reported by the store (Shopify `shop.primaryLocale`, Etsy shop language, Woo site
  locale) — measured per store, written to `Marketplace.languages` on local with the reading recorded; the prod value is the
  Owner's word.

## LX.FIN — final pass of the language axis

[paste "The AAA bar"]

You are lane **LX.FIN**. Claim `### LX.FIN — agent of [3aec8721] — final pass — 2026-09-13`. Read LX.F2's section (its "Not done",
its Owner questions, its item-10 wire readings) and rulings R-LX-22…R-LX-26. Do, in order: (1) R-LX-25; (2) R-LX-22 item (g);
(3) R-LX-23; (4) R-LX-24; (5) R-LX-26 measured on local; (6) the screen half LX.F2 left: the `Not computed` chip, the folded
toolbar with its `Filters ▾` panel open, the 5-column `schemaMissing` sheet — at **1440 and 1728, light AND dark** (set the
Playwright viewport and `colorScheme` inside the wrapper — LX.6 could not; you can), on master, Amazon·IT, Amazon·DE, Amazon·BE
(nl+fr), eBay·IT; (7) the step-6/7 §4 record LX never issued as ONE table: what landed · measured · held · open, with every prod
SQL verbatim (R-LX-17, R-LX-23, R-LX-24) and the deploy prerequisite (the one-shot readiness backfill); (8) one clean gate run —
API tsc 0, web tsc 0, every LX suite (list the remaining reds with owners — target: zero LX-owned), NUL strict 0,
market-languages 0, drift 0, raw-primitives 0, dark-alias 0, AG boundary 0, shared build 0, and the three signed-in gates through
`node scripts/studio-gate-session.mjs -- <gate>` — VT.F is fixing the wrapper's overlap guard (its item A8): wait for
`VT.F fixed A8` in the ledger or verify by `pgrep -fc studio-gate-session` = 0 before each run; announce
`LX.FIN gate starting/finished`, alone. Done = the report with per-item numbers, the §4 table, the SQLs verbatim, `ASSUMED:` /
`QUESTION FOR THE OWNER:`, what you did NOT do and why.

## Gate list, as CLOSE.1 leaves it (2026-09-13 — R-LX-28, R-LX-29)

Two gates join every lane's list in this programme, both with their own positive control inside each run:

- `node scripts/check-table-grants.mjs` (**R-LX-28**, NEW) — every `model` in `schema.prisma` whose table exists on the LOCAL
  database has the privileges `20260908b_workspace_data_isolation` grants it (its `GRANT`s minus its `REVOKE`s — 425 tables
  SELECT/INSERT/UPDATE/DELETE, 2 SELECT-only by design) and, where that migration's pattern requires one, the
  `nexus_workspace_isolation` policy. `--strict` fails on any violation, `--baseline` re-records. It refuses a `neon.tech` host
  and asserts `current_database() = nexus_development` before its first read; its only write is a probe table created and rolled
  back in the same transaction as the run's negative arm. Baseline today: **2 carried** (`ChannelListingTranslation`,
  `ReadinessIndex` — both on production, printed loudly on every run, Owner SQL in CLOSE.1's ledger section).
- `node scripts/check-market-languages.mjs` (**R-LX-29**, extended) — the LX.2 guard now also detects **language → market**
  literals (a map keyed by a language code yielding a market, or a `switch` on a language that returns one), the direction that
  missed `MARKETPLACE_FOR_LOCALE` for the whole programme. Its in-run instrument control now expects **5** shapes, not 3, and
  **the scan now covers `apps/web/src` as well as `apps/api/src`** — the one real language→market map was a WEB file, so an
  API-only scan would have been a rule pointed at a tree that never held it. 4,485 files scanned (was 1,507); baseline 17 (was
  1): the 16 new entries are pre-existing web violations, printed on every run, owners in CLOSE.1's ledger section. API paths in
  the baseline are unchanged, so the Owner's two exemptions and the existing entry did not move.
