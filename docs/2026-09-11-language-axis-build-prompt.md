# Build prompt — Language as an axis of the Product Edit Studio

Paste everything below the line into the implementing session. It is self-contained; the two documents it cites
are in this repository.

---

You are the implementing engineer for **LX — the language axis of the Product Edit Studio** in the repository
at `/Users/awais/nexus-commerce`. Your specification is `docs/2026-09-11-language-axis-design.md` (read it
end to end first; §3 is the contract, §11 is your order of work, §12 binds how you verify). The mock of every
screen you will build is served at `http://127.0.0.1:3000/design/language-axis`
(`apps/web/src/app/design/language-axis/`); the audit that justifies the design is the 2026-09-11 "Studio
Language Audit" artifact and §1 of the design. The Owner's bar, verbatim: **"AAA quality and no inconsistency
at all"**, at **thousands of products**.

## 1. What you are building, in one paragraph

Language becomes a key on the value. One store for non-primary text (`ProductTranslation`), one pin store per
listing and language (`ChannelListingTranslation`), one market-to-languages authority (`Marketplace.languages`),
one resolver (`resolveContent`, order pin → language → source → computed), write routing with a language axis,
readiness per (coordinate, language) materialised in `ReadinessIndex`, language chips inside every scope, the
Languages side-by-side view, one cell vocabulary on both scopes with one new provenance member (`outdated`), the
compare pane fed, a language column and one filter-scoped Translate verb on the catalogue grid, and every publish
path stamping its language tag from the resolved value. Everything is additive; nothing drops a column in this
programme.

## 2. Standing rules of this repository (non-negotiable)

1. **Local dev writes PRODUCTION.** The API on `:8091` talks to the production database. Rehearsal writes only
   on the **XAVIA** test family, announced in `docs/pes-claims.md` BEFORE the write, restored **by value**
   afterwards, re-read after ≥ 8 s. A status code is never proof of a write; a `000` transport failure is an
   UNKNOWN outcome, re-read after a delay. Never touch a live eBay or Amazon listing outside the fixture.
2. **Nothing is committed unless the Owner says so in their own words.** The tree holds ~1,900 uncommitted paths
   and 317 untracked `_*.mts` probe scripts; never `git add -A`, never `--amend`, never stash, never checkout a
   shared file, never reset. `git diff` is blind to untracked files — state scope from mtime + content.
3. **Claim before editing.** Append a section to `docs/pes-claims.md` naming your session and the files you own
   before the first edit; one owner per file; tell the file's owner (from the ledger) before touching theirs;
   a new file cannot clobber, a shared one can. Rulings read newest-at-TOP; lane sections at the bottom.
4. **The design system is mandatory.** Compose from `apps/web/src/design-system` (`primitives`, `components`,
   `patterns`, `grid`). If the DS lacks something, add it TO the DS and file the gap in `.claude/DS-GAPS.md`
   with the measurement. No raw `<button>/<input>/<select>/<textarea>/<table>` in any new file
   (`scripts/check-raw-primitives-ratchet.mjs` holds a new file at zero). No inline `fontSize` (ds-conformance
   guard); page-local sizes are module classes reading `--nds-font-size-*`. No literal colours. Never import
   `ag-grid-*` outside `design-system/grid` (import boundary guard). Grid chrome lives in the ENGINE, never
   page-locally. Shared means EXACTLY the same on both scopes — no copied props, no second vocabulary.
5. **Untouchable:** the flat-file editors, FBA quantity, the existing import. Additive migrations are
   pre-approved; a migration folder under `packages/database/prisma/migrations/` is applied on the NEXT sibling
   deploy the moment it exists — author it in scratch space and move it in at the sequenced step; `migrate deploy`
   drags every folder it finds.
6. **Design authority is the Owner.** Every design or UX decision not written in the design document is a
   QUESTION to the Owner with your measurement and a recommendation — never a ruling of your own. The seven
   decisions in design §14 must be answered by the Owner before the step that needs them (D2 before step 1, D3
   before step 2, D4 before step 3, D1 before step 4, D7 before step 7, D5 and D6 later).
7. **Servers.** Check first: `lsof -nP -iTCP:3000 -iTCP:8091 -sTCP:LISTEN`. If they are up they belong to
   another session — do not restart or kill them. If they are down: API `NEXUS_API_HOST=:: PORT=8091
   NEXUS_DISABLE_BACKGROUND_JOBS=1 NEXUS_ENABLE_TIMING_ALLOW_ORIGIN=1 npm --prefix apps/api run dev`; web
   `NEXT_PUBLIC_API_URL=http://127.0.0.1:8091 npm --prefix apps/web run dev`, as background tasks that you own.
   The API's tsx watcher restarts on the IMPORT GRAPH only (a test file save restarts nothing).
8. **Typecheck etiquette.** `uptime` first; no tsc/vitest while the 1-minute load is above 8. Scope tsc to your
   files: `node scripts/typecheck-scoped.mjs <files…>` (~20 s). `apps/api` tsconfig is NOT strict — do not rely
   on it to catch nulls. Never wait on a process pattern; wait on your own pid. A timeout under load is not
   evidence about the code. An empty error list from a command that did not run is not clean — check `wc -c`.
9. **Browser gates run alone.** Announce "gate starting" in the ledger, hold `apps/web` and `apps/api` saves in
   every peer, run, announce "gate finished". The open-gesture gate is `node scripts/check-editor-open.mjs
   --strict`; the layout gate `scripts/check-layout-v2.mjs`; the control census `scripts/check-control-census.mjs`.
   Read the exit code from the script itself, never through a pipe.
10. **Report faithfully.** Every claim names the file and line it was read from and the time. "Could not
    measure" is never reported as zero or as green. A reading of another lane's live file is a reading, not a
    property — re-measure before attributing. A `file:line` shifts under concurrent edits: cite content.

## 3. Order of work — do these in sequence, each with its gate (design §11)

### Step 0 — Measure (read-only; do it regardless)
Write and run, via `railway run` with a read-only transaction, one script that reports: per (product, field,
language) whether the text is byte-identical across channels within a language or genuinely per-channel; the
count of `Product.localizedContent` slots vs `ProductTranslation` rows per language; every `Marketplace` row with
its language; any `de-DE`-style keys anywhere in Appendix C's stores; the count of `ChannelListing` rows with a
non-empty `titleOverride`/`descriptionOverride`/`bulletPointsOverride`. Put the numbers in the ledger for the
Owner. **Gate:** the Owner has seen them.

### Step 1 — Store (D2)
Add LX.1's columns to `ProductTranslation` (additive migration). Write the idempotent backfill
`localizedContent → ProductTranslation` (every slot, every language, `_meta` → `sourceHash`/`authoredAt`/
`reviewedAt`), dry-run first with counts, then run. `GET /products/:id/global` reads the table and reports every
language present. `contentSlots()` becomes the backfill reader only. **Gate:** backfill count equals slot
count; a second run changes nothing; the GET returns the same values as before for `en` and `it` (byte-diff on
the XAVIA family).

### Step 2 — Authority (D3)
Add `Marketplace.languages String[]` (additive), backfill `[lower(language)]`, set Belgium per the Owner. Write
`marketLanguages(channel, code)` and `languageTag(language, code)` in ONE module
(`services/pim/market-languages.ts`). Replace every definition in design Appendix A with a call to it; delete the
maps. Add the guard test: fails if `apps/api/src` contains a literal Amazon language tag outside that module, or
a `Marketplace` lookup by `code` without `channel`. **Gate:** guard green; `outbound-sync`'s `language_tag` for
BE equals the row's; `assertInformationLocale` accepts every language in `marketLanguages` and refuses others
naming them.

### Step 3 — Resolver (D4)
Write `normalizeLanguage` and apply it at every boundary listed in design LX.4. Write `resolveContent` /
`resolveContentBatch` in `services/pim/content-resolver.ts` exactly per design §3 and §5, behind a flag
(`NEXUS_CONTENT_RESOLVER=v2`). Write the **shadow gate**: a read-only script that, for every product × coordinate
× localizable field in production, runs the old cascade and the new resolver and prints every diff with its
classification. **Gate:** zero diffs, except the reclassification list the Owner has seen. Then move every reader
in Appendix B onto the resolver and delete the old branches. Delete `attribute-resolver.ts`'s `DEFAULT_LOCALE`.

### Step 4 — Write routing (D1)
Add `ChannelListingTranslation` (additive). Extend `resolveWriteRouting` with the `ContentAddress` axis per
design §6; route the master sheet's non-primary text through `translation-write.ts`; route channel pins to the
new table; make `master-content.service.ts`'s same-language cascade run for EVERY language-tier write; implement
the acknowledgement (design LX.14) with decline = revert; audit rows carry `metadata.language`. Every write
carries an address or is refused with the field named. **Gate:** one positive-control write per path on XAVIA
(master primary, master German, channel pin, channel acknowledged-to-tier, decline), each read back after ≥ 8 s
at the DB, each restored by value; the version bump read back (`Product.version`, row `version`); the
open-gesture gate green.

### Step 5 — Readiness
Add `ReadinessIndex` (additive). Producer inside every content write (synchronous, same request), plus a
reconcile job. Implement LX.5's rule (filled only when the resolved language equals the coordinate's). Scope bar
chip = pressed language; Needs-attention list per (coordinate, language); the readiness matrix. **Gate:** on
XAVIA, a market with no translated text reads `blocked`; the scope bar's chip and the matrix agree with the DB
row; `/products/:id/readiness` no longer reads a full sheet per channel (timing before/after, three runs each).

### Step 6 — Screen
In this order, each seen on screen at 1440 and 1728, both themes, every scope, before the next:
(a) DS half — `CellProvenance += 'outdated'` (class, tooltip sentence, precedence, `ProvenanceMark` glyph),
`describeCellSource()` in the DS, the parity test over the two sheet wire mirrors, `buildChannelColumns` hoisted to
a module beside `buildMasterColumns` and tested; (b) language chips in `StudioBar` on every scope
(`FilterChip`, derived from `marketLanguages`; delete `defaultLocaleFor`'s tiebreak, `fixedLocale`, the
hardcoded lists); (c) `?locales=` on the sheet route and the Languages view (`<key>@<locale>`, grouped by
field, `columns[].locale`, chips Needs translation / AI drafts / Out of date with real counts); (d) both sheets
render every cell through `ProvenanceMark` + `describeCellSource`; `SourceIndicator` leaves the sheets;
(e) compare targets fed on both hosts; copy-across through the router; (f) the acknowledgement banner;
(g) the master sheet's per-coordinate readiness columns fed from the index or deleted; (h) the legacy edit page
retired (D6). **Gate:** the mock's S1–S6 reproduced on the real studio on GALE-JACKET and XAVIA; the Owner's
walkthrough on a visible window; `check-editor-open.mjs --strict`, `check-layout-v2` §9.1, the control census,
the raw-primitive ratchet, the ds-conformance guard, the token guard and the import boundary all green.

### Step 7 — Catalogue and publish (D7)
(a) the `Language` selector and `title@<lang>` / `description@<lang>` / `readiness@<lang>` columns on
`/products/next` from the index, server-side sort and filter; (b) the filter-scoped Translate verb: preview
(counts, cost from `rate-cards.ts`, reach), one revertible `BulkOperation`, drafts on the language tier,
`requireReviewed` at publish with the preflight naming the language; (c) the `key@channel:market:locale` header
row on import/export and the catalogue workbook's locale sheets through the router; (d) every Amazon publish path
on `languageTag(resolved.language, market)`, one entry per language of the market; (e) honour the spec cache on
channel scopes (`channel-specs/index.ts:60`: the account-specific path is a cache MISS fallback, not a bypass)
and the column caches (`studio-columns.ts:50`, `sheet-columns.service.ts:1055`). **Gate:** "fill the German title
for 3,000 products" is one verb with a preview and a revert, exercised on XAVIA as drafts and reverted; a
channel page load's `meta.schemaAge.fetchedAt` is a database date, not the request time, three loads in a row;
the DE listing on XAVIA publishes (dry-run) with `de_DE` derived, not literal.

## 4. Definition of done, for every step

- The design's LX item is implemented as written, or the deviation is a numbered QUESTION the Owner answered.
- Producer and consumer of every new field land in the SAME edit (a consumer written before its declaration has
  crashed the studio twice in this programme).
- One definition per fact. Any second copy of a list, a map, a vocabulary or a column builder is a defect,
  including your own.
- Tests: pure logic as vitest (node-only in `apps/web`, `*.vitest.test.ts`); the wire mirrors under the parity
  test; the guard test of step 2; the shadow gate of step 3 kept as a script that can be re-run.
- Verified on screen where there is a screen, on the fixture where there is a write, with the positive control
  in the same run, and reported as: what was measured, when, on which family, with file:line, and the exact
  restore performed.
- Reported ONCE per step in `docs/pes-claims.md` under your section: mtime + sha of each file, tests run
  (counts), gates run (exit codes), one screen reading the Owner can see, open questions.

## 5. Traps this repository has already paid for (read before touching each area)

- **Editors:** AG 36 React editors commit only through `props.onValueChange`; the fill handle swallows a
  double-click and fills the column down; a popup editor owns Enter/Tab/Esc; an unregistered AG module fails
  silently. Run `check-editor-open.mjs --strict` after any column change.
- **Value setters must MUTATE `params.data`**; inline column options re-run the column model; column state is
  frozen at mount; a `colId` that collides with a schema column is renamed `sku_1` silently.
- **Wire → UI:** a client MIRROR of a server type drifts (third time this programme); the batch endpoint returns
  a KEYED OBJECT, not an array; `Product.version` is not the row version — read it back.
- **Writes:** `attr_*` writes need a marketplace context; the bulk PATCH routes nine channel fields; the write's
  routing predicate binds its readers — re-derive nothing one line away; hardening a write RELOCATES it, re-run
  the write test; an in-flight autosave can undo an API revert — a delayed re-read catches it.
- **Measurement:** a stale reading looks like a missing one; a scroll probe must verify it moved; an outside
  instrument cannot see inside a request; a fixture pins a dimension — ask what yours holds constant that the
  claim does not; a coordinate's contract can vary by MARKET (`color.scope` per_variant on IT, global on DE).
- **Caches:** the Amazon schema cache is keyed and invalidated in-process per replica; all 124 `CategorySchema`
  rows are expired and still served; `ProductReadCache` and the read cache go stale.
- **Prisma:** `upsert` emits ON CONFLICT (a `@@unique` change breaks it — sweep call sites); `NOT` excludes
  NULL; `null` matches every `lte`; a `Decimal` becomes a silent zero; `Invalid invocation` is a prefix.
- **Vacuous greens:** `--reporter=basic` is not installed and still exits 0; a guard that reads `git ls-files`
  is blind to untracked files; a ratchet reports a total, not a delta; a gate at 0/0 is a PASS produced by
  having nothing to look at.
- **People:** in a shared tree "who changed this file" is not a question git can answer; a marker names a
  programme, not a session; an mtime is a time, not an author.

## 6. What to do when blocked

Finish everything that does not depend on the answer; write the QUESTION in the ledger with your measurement
and one recommendation; continue. Stop only for: a write outside the fixture family, a migration that is not
additive, a change to a flat-file editor, a commit, or a deviation from the design that changes what an
operator sees. Those are the Owner's alone.
