# The Product Sheet plan — consistency and honesty review

**Date: 2026-09-22, 18:25–18:35 CEST. Branch `pes/phase-0` at `7221436aa` (40 ahead of `main`,
0 unpushed) plus the live lane's uncommitted A-18 / R-11 work.**
**Status: REVIEW ONLY. No product code was changed. No plan file under `docs/product-cheat/` was
edited — that path is held by the running lane (claims ledger, top row).** This file belongs in
`docs/product-cheat/` once that hold lifts; move it with `git mv`, nothing links to it yet.

> **Update, 2026-09-22 evening (the R-11 lane).** Moved here (it was never tracked, so `mv` + `add`,
> not `git mv`). §2's 17 fold-ins are applied to `PLAN.md` and `PROGRESS.md`; §5.3's banner is on
> `RESEARCH.md`. §3a is ruled (eBay only, gated — see PLAN "Step 2.2 part 2"); `formula-database` has a
> named load budget (§1, §8.4). The rest of this file is unchanged, as written at 18:35.

Every claim below names the file and line it was read at, or the command that measured it. Where
something could not be verified today, it says so.

---

## 0 — The verdict, on one page

1. **`docs/product-cheat/PLAN.md` is the right plan, and it is the ONLY current plan.** Its Phase
   order (control → safety → model → proof → UI), its five rules and its 15 amendments all hold
   against the code today. Every code change it records as built is on the branch, pushed, and
   its named gates pass (§1). Nothing in the older `docs/product-sheet/` set or the root
   `2026-09-21-*` files should be built from.
2. **But the plan disagrees with itself in 17 places.** The step bodies (Parts 4–11) still say
   things its own amendments measured as false: eleven untracked migrations, a delist cascade,
   an ungated Amazon delete, a `{ everywhere, channels }` object, a gate ledger with seven rows
   "in the test suite" and a drift check "in the hook". A reader who starts at Step 0.1 builds the
   wrong thing. The fold-in list is §2, with the exact edit for each.
3. **Four research findings were dropped between the research and the plan, and all four are
   real in the code today** (§3). One of them — a price PATCH to Amazon overwrites the whole
   `purchasable_offer` slot and so **wipes any sale price** — sits directly on the path Step 2.2
   part 2 is building right now. The research said *"fix before any price write ships"*; the plan
   has no step for it.
4. **AAA is measured against a palette the sheet does not use.** Step 4.0 targets
   `scripts/check-contrast.mjs`, which reads the legacy `--text-*` tokens in `globals.css`. The
   studio and the grid paint with `--nds-*` tokens only (40 of 40 studio files; 0 legacy refs).
   The real 7:1 baseline, derived from `styles/tokens.css` today: **47 of 88 role pairs fail;
   8 fail even 4.5:1** (§4).
5. **Three older document sets still state the refuted claims as live, with no marker** — the
   `docs/product-sheet/` folder (whose README says "START HERE"), the root `2026-09-21-*` UI
   files, and `docs/product-cheat/RESEARCH.md` itself (§5). Banners were added today to the files
   nobody holds; the text for the held one is in §5.3.
6. **A second programme, `docs/listings/`, started in parallel while the plan's Step 0.2
   ("one lane at a time") is explicitly still in force**, holds the same grid and readiness files,
   and asserts full-page WCAG AAA as a release gate — a claim the sheet plan says cannot be held
   (§6). Its content is otherwise consistent with the plan's rules.
7. **The push hook is flaky, not red.** The full `apps/api` suite failed one file
   (`formula-database`, a 10 s timeout) in the hook run and passed it alone twice. The plan already
   records this and its own rule applies: a gate that fails one run in two is on its way to being
   disbelieved (§1).

---

## 1 — What was measured today

All runs from the tree at 18:25 CEST, before the live lane's edit to
`channel-price-write.service.ts` landed on disk (18:31). Commands run from `apps/api`, never the
repo root. Local database: Docker `nexus-development-postgres-20260908` on `127.0.0.1:55439`.

| Check | Command / source | Result |
|---|---|---|
| Branch state | `git rev-list --count main..HEAD` · `origin/pes/phase-0..HEAD` | **40 ahead · 0 unpushed** — PROGRESS is right |
| Hook is what git says | `git diff HEAD -- .githooks/pre-push` | empty — the hook on disk is HEAD's (an untracked `pre-push.backup` differs; it is not the hook) |
| A-18 probe left in the suite? | `ls apps/api/src/services/pim/price-door-reset.probe.vitest.test.ts` | **gone** — PROGRESS's "no failing diagnostic is left" is true now (the session-start `git status` was older) |
| The 13 gate files the amendments name | `npx vitest run <13 files> --disableConsoleIntercept` | **13 files · 110 tests · all pass** (0.8 s) |
| The push-hook `apps/api` suite | `npm run test:hook --silent` | **872 files pass · 1 fail · 16 skipped** — the fail is `mapping/formula-database.vitest.test.ts` (timeout 10 s). Alone, twice: **15/15 pass**. Flaky under load, as PROGRESS records. `tsc` ran concurrently, which is a load the hook does not have |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` (apps/api) | **exit 0** |
| Web gate for Step 1.2 | `hardDelete.vitest.test.ts` | **33 pass** |
| `@nexus/database` gates (A-2, 0.4, A-13) | `npm run test --workspace=@nexus/database` | **2 files · 17 pass** — reads `apps/api/.env`, refuses a non-loopback host |
| Sheet still bypasses the price door | `grep -c writeChannelPrices\|PRICE_UPDATE\|PriceChangeEvent bulk-edit.service.ts` | **0** — as the plan says (part 2 is the live build) |
| Price door type is compile-time mandatory | `channel-price-write.service.ts:68-69` | union `{ expectedVersion } \| { unguardedReason }`; `guarded:` on every outcome (`:84,:137`) |
| eBay price hold | `EBAY_PRICE_HELD_REASON` / `editHeldReason` | in `channel-specs/types.ts`, `ebay.ts`, `sheet-columns.service.ts`, its test |
| Requirements collapse fixed | `family-sheet-schema.ts:51-58,85`; `sheet-columns.service.ts:559-563,595` | `requiredChannels` → `familyRequiredBy()` → coordinate labels |
| Shared narrowing + stated absence | `sheet-columns.service.ts:246,1206-1215,1297` | `coordinatesNotListed`, `catalogueMarkets()` with its own 4-entry cache |
| Sweep budget | `readiness-reconcile.job.ts:21,70` | `NIGHTLY_BUDGET_MS = 10 min`, `resumable-sweep.ts` imported |
| Cache route | `admin.ts:1055-1073` | `GET /admin/pim/sheet-cache-stats` with `businesses: { held, max }` |
| Deploy gate | `migrate-direct.mjs:32,63-66` | `checkAppliedButMissing` runs before `migrate deploy` |
| Bootstrap isolation | `bootstrap-fresh-database.mjs:119-141` | `variationExcluded`, legacy workspace row, `workspacePolicySql()`, refusal on 0 policies |
| eBay delete permission | `permissions-manifest.ts:275`; order test `:36` | `POST /api/ebay/flat-file/delete` → `products.delete` |
| Orphan guard | `channel-delist.service.ts:117`; `delist-error-codes.ts:50`; `products-catalog.routes.ts:1784-1806` | `delistCapability`, `hardDeleteOrphanReason`, refusal inside the transaction |
| Scripts named in PROGRESS | `ls` | all nine exist; `derive-required-attributes.ts` has `--apply` / `--revert`; `seed-scale-fixture.ts` has `--wipe` |
| Gates the plan says are missing | `grep -c` in `.githooks/pre-push` | `editor-open` 0 · `census` 0 · `grid-chrome` 0 · `check-editor` 0 · `check-contrast` 0 — unchanged |
| Contrast script threshold | `scripts/check-contrast.mjs:31` | `const AA = 4.5` — unchanged |
| Hook test lines | `.githooks/pre-push:62,479,522,570,597` | database · web · api `test:hook` · api security · profiles-ON ratchet |

**Not re-measured today:** the scale-fixture numbers (no `nexus_scale` database was opened), the
profiles-ON ratchet (it runs on push; not run here), and anything needing eBay/Amazon credentials.

---

## 2 — The plan disagrees with itself: the fold-in list

The amendments at the end of `PLAN.md` are the truth. The step bodies were never updated to match.
Each row gives the body location, what it still says, what the amendment established, and the
smallest edit that closes the gap. Line numbers are from `PLAN.md` at 18:25.

| # | Body location | Body still says | Established by | Edit |
|---|---|---|---|---|
| 1 | Step 0.1, L265–283 | "11 migrations applied to production but untracked… `lx4`/`lx5` must be committed before any push" | **A-1**: 467 folders, 469 rows, 0 pending, 0 applied-but-missing; both folders tracked | Strike the Do/Why premise; keep the step as its gate; add `✅ CLOSED — 861280afe` |
| 2 | Step 0.1 Gate, L279; Part 11 L996 | "`scripts/check-schema-drift.mjs` already exists and is already in the push hook" · ledger row "Migrations do not drift · Exists · 🟢 Yes" | **A-2**: the file is `packages/database/scripts/check-schema-drift.mjs`, reads repo files only, covers one direction. A-2 RESULT L1762–1770 asks for the row to be corrected and a new row added | Fix the path; re-word the row to *"A Prisma model has a CREATE TABLE in some migration"*; add the A-2 ledger row (deploy gate in `migrate-direct.mjs`, tests in the hook) |
| 3 | Part 11, L975–990 | Seven rows: "In the hook? · Test suite" | **A-8 RESULT**: "They are now. The ledger should say *push hook — `apps/api` `test:hook`*" | Edit the seven cells |
| 4 | Step 1.1, L326–349; Part 10 L943 | "Drop the cascade… make `productId` nullable… Rollback: revert the migration" · graph `1.1 ──► 1.2 ──► 1.3` | **A-7 / R-5**: premise false; `productId` already nullable; delist rows carry `productId: null`; migration STRUCK | Add `✅ STRUCK — 647c1e4d1` and the R-5 wording (L2245); remove 1.1 as 1.2's predecessor in the graph |
| 5 | Step 1.4, L400–417 | "Anyone who can edit a product can delete a live listing… a distinct permission (`listings.delete`)" | **A-10**: false — every path needs `products.delete`, kill switch already in the client; the real hole was eBay's `listings.flatfile.edit`, closed `6ff3b6b58`; `listings.delete` does not exist and must not be created | Add `✅ CLOSED — Amazon already true; eBay fixed 6ff3b6b58`; strike the `listings.delete` line |
| 6 | Step 1.5, L419–449 | The `readOnlyReason` code block as the fix; Gate = `check-silent-disabled.mjs` | **A-11 correction + Step 1.5 BUILT**: `readOnlyReason` means "the channel owns this value" and deleting the master mapping; the hold is `editHeldReason`; the JSX gate cannot see a field spec; real gate = `ebay-price-held.vitest.test.ts` | Replace the block with `editHeldReason`; replace the Gate; add `✅ BUILT (column half) — cf49c88d2`; write half → 2.2 (A-12) |
| 7 | Step 2.1, L460–496 | "Chosen: return a requirement object `{ everywhere; channels[] }`… let the column decide" | **A-14 / R-8**: that object would be read by nothing; reuse `requiredBy`; fix BOTH homes (`family-sheet-schema.ts` and `master-sheet.ts:90`) | Replace Chosen with the R-8 form; add `(a) ✅ BUILT ca8782153 · (b) ✅ APPLIED LOCALLY 69debb8de — production needs the Owner's word` |
| 8 | Step 2.2, L498–539 | Where: `product-channel-data.routes.ts:187`; two callers; "Rollback — make the field optional again. One character" | **Step 2.2 part 1**: the line is now `:180`; a THIRD unguarded caller (`pricing.routes.ts` bulk override) existed; rollback now also drops `unguardedReason` | Update Where; add the caller; mark `part 1 ✅ BUILT 76b8be797 · part 2 🟡 building under R-11 (A-18)`; list the three not-built items (bypass, hold lift, concurrency gate on `concurrent-database.ts`) |
| 9 | Step 2.4, L567–611 | Move 1 = "add `where: { productId: { in: familyIds } }`" | **15.4 + Step 2.4 BUILT**: that line does not compile on a channel scope; built with explicit `productIds`, a split `catalogueMarkets()` cache and the `coordinatesNotListed` pill; ~150 ms → 6 ms | Replace the move-1 line; add `move 1 ✅ BUILT f8fcd1158 · move 2 ⬜ not built` |
| 10 | Step 2.7, L662–693 | "Do it after 2.1, so it computes against real requirements — a reconcile against 0 required attributes would fill the table with meaningless 100%s" | **A-16**: a channel coordinate already had 8 of 163 required from the spec before 2.1; only Shared had 1 of 101. **15.1 RESULT**: at 4 s/family a 10-min budget is ~150 families/night → a rotation, not nightly-in-full | Add the premise check as the step's first action; add the rotation to Cost when; D-E stays open |
| 11 | Part 9, L916 (D-A), L923 (D-H), L922 (D-G) | D-A "198 definitions, 0 required" with a default; D-H "Now"; D-G default "gate first" | **R-10** ruled D-A (a) Mirror — 486 rows locally, 5 mirrored, production open; D-H is done (move 1); **15.9** asks to flip D-G to collapse and nobody has ruled | Mark D-A `RULED R-10`; D-H `DONE`; D-G `⬜ 15.9 proposes flipping the default — unruled`; D-B/D-C default stands; D-D, D-E, D-F still open |
| 12 | Part 10, L934–971 | No 0.4, no 15.3/15.11/15.1+15.6 pre-steps; 1.1 feeds 1.2 | R-3 added 0.4; the Phase 2 pre-steps were built first by 15.13's ranking | Redraw: `0.4 baseline ──► 15.11 fixture ──► 15.1/15.6 sweep ──► 2.7`; strike 1.1 |
| 13 | Part 14.3, L1071–1083 | "Does any rule lack a gate? No" · "Part 15 amends six (0.2, 1.2, 2.1/2.6, 2.2, 2.4, 2.7, 3.2, 3.5)" | The A-2 deploy gate has no ledger row; the list names eight | Add the row; fix the count |
| 14 | Part 14.4, L1085 | Hole #1 "the 'Unpublish (recommended)' string was not located" | **A-9**: the string exists in no current file; the replacement copy names the orphan outcome | Strike hole #1 |
| 15 | Part 15.3, L1230–1256 | `workspace-cache.ts:11-13`, `sheet-columns.service.ts:1144`, `:1127-1141` | 15.3 RESULT: now `:22`, `:1173`, `:1156-1170` (and moving again with 2.4) | Cosmetic; say "see 15.3 RESULT" |
| 16 | `PROGRESS.md`, "How to work here" | The "Traps measured the hard way" list repeats five entries verbatim from the "second session" list above it (Proxy patch, row count with no context, `getSheetColumns` needs `productTypes`, `beforeAll` throws, `formula-database` flaky) | — | Keep one copy |
| 17 | `PROGRESS.md` L24 | Step 0.2 "✅ CLOSED — with 15.8's exit condition written in" | **A-5**: the exit condition is NOT met (four gates still out of the hook), so one-lane-at-a-time STANDS | "🟢 IN FORCE — exit condition written (A-5); exit not yet met" — a reader of "CLOSED" starts a second lane |

**Plus the research file in the same folder.** `docs/product-cheat/RESEARCH.md` still carries,
with no marker: the eleven untracked migrations (Part 1 alarm, Part 8 Step 0, Part 9 #1, Part 13
L.0-style table), the delist cascade (Part 5 #2, Part 8 item 4, Part 13.2), the ungated Amazon
delete (Part 5 #3, Part 6 gap 7, Part 8 item 3), "Unpublish (recommended)" (Part 1, Part 5 #1,
Part 8 item 2, Part 13.1 row 9), "route price through `matrix-write.service.ts` and retire
`PATCH /channel-pricing`" (Part 8 item 6, Part 9 #2), and the repo-root test hazard (Part 5 #6).
The plan's Part 1 corrects four of these; A-1, A-7, A-9 and A-10 correct the rest — but only in
the plan. The banner text for the research file is in §5.3; it was not applied because the folder
is held.

---

## 3 — Research findings the plan dropped, verified in the code today

| # | Finding | Code today | Why it matters to the plan | Proposed home |
|---|---|---|---|---|
| a | 🔴 **A price PATCH to Amazon wipes the sale price.** | `amazon-sp-api.client.ts:637-655`: `patchListingPrice` sends `op: 'replace'` on `/attributes/purchasable_offer` with only `our_price`; its own comment says *"The whole purchasable_offer slot is overwritten"*. `pricing-outbound.service.ts:9,203` is the `PRICE_UPDATE` path into it. No push sends a sale price (0 hits for `sale_price`/`discounted_price` in the client or the outbound service) | Already live for every Amazon price write that reaches the door today (Matrix, `PATCH /channel-pricing`, bulk override). **Step 2.2 part 2 — building now — adds the sheet as a third client of the same door.** The research (`RECOMPILED.md:469,1182`; `docs/product-cheat/RESEARCH.md` Part 9 #2) says *"fix before any price write ships"*. The plan has 0 mentions | A step before 2.2 part 2 lifts the hold, or a stated limit in 2.2: read-modify-write the `purchasable_offer` schedule so an existing `discounted_price` survives, or refuse the PATCH when a sale window exists. Gate: seed a `discounted_price`, PATCH `our_price`, assert it survives, with a control that `our_price` changed |
| b | 🔴 **Two readers disagree about a stored channel value.** | `channel-inheritance.ts:13-14`: a `listingColumn` store returns `undefined` unless `followMasterPrice === false` (so `null`/missing → Master wins), and returns before the `overrideData` bag at `:26` is ever read. `attribute-resolver.ts:259-264` (A-18's own trace) applies the bag FIRST | A-18 / R-11 fixes the writer side (stale keys cleaned at the door). The reader fork stays: the same listing can resolve two different prices depending on which reader asks. That is Rule R1 broken one layer down | One line in Step 2.2's "not built" list, or a pre-step of 2.6: one reader for a stored channel value; gate = a null-flag arm and a bag-vs-column arm |
| c | 🟠 **A field outside the category schema is never sent; Shopify/Woo mapping is off; `sourceOwner` fields skip the merge.** | `sync-mapping-merge.ts:11` (default `off` except Amazon/eBay), `:80` (iterates `resolved.catalogue.fields` only), `:82` (`if (field.sourceOwner) continue`), `:85` (only `mapped`/`override` cells) | Step 3.2's M2 will find this as part of the diff; the plan does not name it, so a large M2 number will read as a mapping-coverage problem when part of it is structural | Name all three under Step 3.2 as expected components of the M2 diff, and under Part 13.1 |
| d | 🟠 **Columns with no cached schema carry no caps and no closed lists; 42 products have a null `productType`.** | `schemaMissing` is a real output (`getSheetColumns`; PROGRESS trap) — the plan treats it only as a probe caveat | Step 3.6 (paste/fill validity) cannot validate a column that has no cap. D-A already notes 9 unreadable coordinates | A limit line in 3.6 and in D-A: "validity is only as complete as the cached schema; count the uncached types first" |

**Asserted by the older documents, NOT verified today, and NOT in the plan** — each needs one
check, then a home in Phase 1 or in Part 12 (out of scope, named):

- BE-11 — eBay/Shopify batch submits are live by default (`all-in-one/RESEARCH.md:290,819`).
- Live-update (SSE) routes do not check who is signed in (`README.md:210,225`). Today four route
  files serve `text/event-stream` (`fulfillment`, `dashboard`, `advertising`, `sync-logs`); their
  auth was not read. The 09-16 public-route audit programme may already own this.
- eBay image publish is ungated (`all-in-one/RESEARCH.md:817-818`).
  `services/images/ebay-inventory-image-publish.service.ts` has **0** references to
  `getEbayPublishMode`; the gate may sit at the route. Not confirmed either way.
- `'default-user'` is written as the actor at **42** non-test sites in `apps/api/src`
  (`grep -rn "default-user"`, e.g. `fulfillment.routes.ts:290`, `products-images.routes.ts:276`).
  Verified count. This is Layer 5 (governance, "who did it"); the plan has no step for actor
  attribution.
- The drawer `HtmlField` strips styles/images/tables on blur; a letter typed on a number cell opens
  an empty editor and commits a clear (`all-in-one/RESEARCH.md:826-828`). UI-track items; not in
  Part 8.

**Refuted today — do not carry:**

- "`closeMarketOffers` writes `offerClosedAt` even on a dry run" — false.
  `amazon-market-offer.service.ts:175-177` returns before the write.
- "The RBAC hook defaults to shadow" — true as a default (`rbac-hook.ts:31`) but **enforced whenever
  business profiles are ON** (`:76`), which production has been since 09-16.

---

## 4 — AAA: the plan measures the wrong palette

**What the plan says.** Step 4.0: raise `scripts/check-contrast.mjs` to 7:1 and derive its token
list from source. Part 11: *"Contrast is 7:1, from a derived token list · `check-contrast.mjs`,
raised"*.

**What the sheet paints with.** `check-contrast.mjs` hardcodes the legacy `--text-primary`,
`--text-secondary`, `--surface-card`… tokens from `apps/web/src/app/globals.css`. Measured today:
the studio (`apps/web/src/app/products/[id]/edit/_studio/**`) references `--nds-*` in **40 files**
and `var(--text-` in **0**; the design-system grid references `--nds-*` in **30 files**. The
design-system palette lives in `apps/web/src/design-system/styles/tokens.css` (`:root` L10–448,
`.dark` L450–563). A 7:1 gate on `check-contrast.mjs` would go red or green about text the sheet
never draws.

**The legacy list, at 7:1** (scratch copy of the script with `AA = 7`; hand-written triples still
match `globals.css` L25–34, L60–68): **9 of 24 pairs fail** — light `text-tertiary` (4.55–4.76),
`text-link` (4.94–5.17), all four status pairs (4.84–6.16); dark `text-tertiary on surface-card`
(6.96).

**The design-system palette, at 7:1, derived from `tokens.css` today** (script in Appendix A;
every value resolved through its `var()` chain; positive control `--nds-text` on `--nds-surface`
= 15.48, matching Study 02's ~15.5; negative control: an absent token resolves to null):

| | pairs | below 7:1 (AAA) | of those, below 4.5:1 (AA) |
|---|---|---|---|
| light | 44 | **31** | **8** |
| dark | 44 | **16** | 0 |
| **total** | **88** | **47** | **8** |

The eight that fail even AA: light `--nds-text-3` on all five surfaces (**3.20–3.62**) and light
`--nds-primary` on `--nds-bg`, `--nds-surface-sunken`, `--nds-surface-hover` (**4.23–4.42**).
The AAA misses, by token: light `--nds-text-2` 5.22–5.91 · `--nds-text-muted` 4.69–5.32 ·
`--nds-text-link` 5.27–5.98 · `--nds-primary` 4.54–4.79 · `--nds-pill-success` 6.37 ·
`--nds-pill-neutral` 5.22 · white on `--nds-primary` 4.79; dark `--nds-text-2`/`--nds-text-muted`
on raised/hover 6.85 · `--nds-text-3` 4.62–5.20 · `--nds-text-link` on raised/hover 6.75 ·
`--nds-primary` 5.19–5.84 · both success/neutral pills 6.32–6.42 · white on primary 5.84.

Two things this changes:

1. **`--nds-text-3` is #7e8796 in `tokens.css` (L74), not the #8a93a1 that `tokens/colors.ts:45`
   and the June `studies/02-contrast-audit.md` record (~3.2:1).** The source moved and the study
   did not. That is the "hand-kept list" trap the plan warns about, already live in the DS's own
   study. Derive, do not quote.
2. The DS rule (Study 02, finding 1) is that `text-3` is for labels and metadata, never body.
   So a 7:1 gate must be **usage-aware**: which token counts as body text on which surface is a
   ruling, not a formula. `scripts/check-grid-swatch-contrast.mjs` already shows the right shape —
   every input derived from `tokens.css` at run time, grounds composited, two tiers — and
   `token-guard` is already in the hook.

**Proposed rewrite of Step 4.0.** Do: a derived 7:1 check over `styles/tokens.css`, both blocks,
role pairs (text × surface, status text × soft, pill fg × bg, inverse × primary), modelled on
`check-grid-swatch-contrast.mjs`, with a usage table the Owner rules on (`text-3` = large/UI tier
or body?). Done when: the number above is reproduced by the script in the repo. Gate: itself, in
the hook next to `token-guard`, at Step 4.2. Part 11 row: replace `check-contrast.mjs` with the
new script. The plan's honest warning (Part 8, "AAA everywhere is not a claim this or any product
can hold") stands and is now backed by a number: **47 of 88**.

---

## 5 — The other document sets

### 5.1 `docs/product-sheet/` — written 09-19 to 09-21, untracked, 1.2 MB of digests

Its README says of `RESEARCH-2026-09-21-RECOMPILED.md`: **"START HERE."** That file, the README,
and both `all-in-one/` files state as live, with no marker, every claim the plan refuted on 09-22.
Counted by a line-by-line sweep today (severity 🔴 = a reader would build or decide the wrong thing):

| File | 🔴 rows | The claim families |
|---|---|---|
| `README.md` | 10 | irreversible Unpublish (L34–35, 332) · cascade (L35–37, 330) · `products.edit` deletes (L37, 227, 339) · repo-root test hits prod (L39–40, 415) · 11 untracked migrations (L49–50, 398; "pending" L284, 319, 401, 411, 416) · "no price column" (L230) |
| `RESEARCH-2026-09-21-RECOMPILED.md` | 13 | the same four dangers (L150–155 and ~20 repeats) · 11 migrations (L103, 166, 1434–1438, 1525) · "one writer = `matrix-write`, retire `PATCH`" (L167, 570, 1062, 1176, 1317, 1472, 1519) · "fake success" (L471–472, 1176) · three writers/no version check (L153, 455, 1173, 1456) · no `where` (L306–312, 731, 1117–1124) · 0 of 198 (L92, 123, 832–841, 908, 1049, 1316) |
| `all-in-one/FUNCTIONALITY.md` | 8 | two writers (L19–26) · no `where` (L425–467) · "no channel price column" (L267–268, 386, 515) · fake success (L270–271, 554–556) · `matrix-write` (L387, 540) · cascade/Unpublish/kill switch (L679–682, 752) |
| `all-in-one/RESEARCH.md` | 12 | Unpublish (L81–82, 228, 561, 802, 1566) · cascade (L82–83, 556, 804, 1565) · kill switch / `products.delete` gates nothing (L404–405, 571, 806, 848, 1567) · repo-root (L83–84, 231, 622, 853–857, 1595 "remove `DATABASE_URL`") · 11 migrations + "apply A6–A12 to prod" (L540, 610–616, 789–792, 1548–1556, 1744–1751) · 198/0 (L471, 890, 1667) |
| `PLAN.md` / `IMPLEMENTATION.md` / `RESEARCH.md` (the 300–450 KB digests) | 9 / 13 / 24 | the same families; notable: `IMPLEMENTATION.md:42–43, 84, 1194, 1206, 1913, 2091–2108, 2431–2439, 2596`; `RESEARCH.md:26–30, 272, 1250–1264, 1478–1550, 2775–2785, 2975–3128, 3303, 3711`. `IMPLEMENTATION.md` contradicts itself (`:347, :1620, :1819` already agree with the plan) |

**Done today:** a dated banner at the top of `README.md` and `RESEARCH-2026-09-21-RECOMPILED.md`
naming the refuted claims and pointing at `docs/product-cheat/PROGRESS.md`. The digests inherit it
through the README.

**The folder name.** `docs/product-cheat/` is a typo of `product-sheet` that became the tracked
name. A `git mv` is the Owner's call — the lane's 40 commits and its claim row link to the current
name. The banners cross-link both folders so neither is read alone.

### 5.2 The root `docs/2026-09-21-product-sheet-ui-*.md` pair

Both say at line 3 **"FOR APPROVAL"** / **"RESEARCH ONLY"**. The only statement that they are
superseded lives in a third file (`docs/product-sheet/README.md:60–62`). Their false claim —
*"There is no `metafield` anywhere in `apps/api/src/services/pim/` or in the studio sheet"*
(`ui-plan.md:204`, `ui-consistency-research.md:127–129`) — is refuted at `README.md:68–71`; **UI.5
rests on it entirely.** Three of their items are absent from the plan's Part 8 and should be folded
in, not lost: UI.0(a) the Customise-reload defect (a ticked column not surviving reload — it blocks
editor work), UI.1 delete every "Enter saves"/Esc hint line with a grep gate (Part 8 names the six
files only inside the EditorShell row), UI.2 turn `OrderedList` reordering on for metafields
(`draggable={false}` → `draggable` + `keyboardGrip`, one prop in two places).

**Done today:** a SUPERSEDED banner at line 3 of both files.

### 5.3 `docs/product-cheat/RESEARCH.md` — banner text, to apply when the hold lifts

> **🔴 CORRECTIONS (2026-09-22).** Eight claims below were measured false or closed after this file
> was compiled; read `PLAN.md` Part 1 and amendments A-1, A-7, A-9, A-10, and `PROGRESS.md`, before
> acting on any of them: (1) *11 untracked production migrations* — 0 drift both ways (A-1);
> (2) *the delist cascade destroys the queue rows* — rows carry no FK; unpublish is refused, not
> destroyed (A-7); (3) *anyone with `products.edit` can delete a live Amazon listing* — false; the
> hole was eBay's edit permission, closed (A-10); (4) *"Unpublish (recommended)" is an irreversible
> delete* — wrong diagnosis; the orphaning delete is now refused (Correction 3, Step 1.2);
> (5) *route price through `matrix-write.service.ts` and retire `PATCH /channel-pricing`* — no; the
> door is `writeChannelPrices` and the route was fixed (Corrections 1–2); (6) *a repo-root test run
> reaches production* — refused by the R-VT-12 guard (A-6); (7) *0 of 198 attributes required* —
> 486 rows; 5 mirrored locally; a channel coordinate already had 8 of 163 (A-16); (8) *the Shared
> `groupBy` has no `where`* — narrowed and measured (Step 2.4).

---

## 6 — `docs/listings/` — a second programme, started today

Four files (`PLAN.md`, `RESEARCH.md`, `READINESS-RESEARCH.md`, `READINESS-PLAN.md`), untracked,
still being written at 18:23. Checked against the plan's rules R1–R5, Part 12 and Step 0.2:

| # | Finding | Verdict |
|---|---|---|
| 1 | Step 0.2 ("one lane at a time") is explicitly still in force (`PLAN.md:1816`, four gates still out of the hook), and it rejected per-lane worktrees by name (`:293-295`). `READINESS-PLAN.md:206` starts on "an isolated branch/checkout" and its tasks hold `design-system/grid/`, `ProductsNextClient.tsx` and `apps/api/src/services/pim/` readiness files — the same substrate the sheet's Phase 4 and Step 2.7 own. No claim row in `docs/pes-claims.md` | 🔴 process conflict — the one thing that blocks "proceed as written" |
| 2 | `READINESS-PLAN.md:36,161,171` make full-page WCAG 2.2 AAA a release gate over a scope that includes the product editor. `PLAN.md:905-907`: *"'AAA everywhere' is not a claim this or any product can hold"* — and §4 above puts a number on it | 🔴 contradicts the plan; narrow to the plan's four countable items on the surfaces listings owns |
| 3 | Production has 0 `ReadinessIndex` rows and D-E is unapproved (`PLAN.md:667,693`). `docs/listings/*` never names this; `READINESS-PLAN.md:147` says missing rows show as "Not checked", so its C1 route switch would ship a table reading "Not checked" on every production row | 🟠 state the precondition; block C1 on D-E or ship behind preview |
| 4 | A third readiness vocabulary ("preparation verdict", `READINESS-PLAN.md:111`) beside the two the plan already counts as a fork (`PLAN.md:259-260`). It correctly refuses a UI conversion and a second store | 🟠 needs a ruling; not a rule breach |
| 5 | `docs/listings/PLAN.md:165` still lists pause/unpublish/end/delete/archive verbs the plan says have no writers (`RESEARCH.md:243-247`); the newer `READINESS-PLAN.md:40,151` defers them | 🟠 the older file is superseded in place but not in its title |
| 6 | `READINESS-PLAN.md:202` asks for 100 / 10,000 / **50,000-listing** fixtures; the plan's fixture is products-denominated (3 listings/product) and no 50,000-listing one exists | 🟠 |
| 7 | R1 (one writer), R3 (channel never decides the catalog), R4 (absence stated), the tab rule, and every AGENTS.md design-system clause | 🟢 honoured, clause by clause |
| 8 | `docs/listings/RESEARCH.md` §4 "Corrections to older documents" — all five rows agree with the plan; row 131 is one day stale (Step 2.2 part 1 is built) | 🟢 / 🟠 |

Not edited today — the files were changing on disk while this was written. The three edits that
make them consistent: name Step 2.7 / D-E / the 0-rows fact and block C1 on it; add a claim row or
sequence Phase B after the sheet's Phase 2; narrow Q3/D8's AAA claim to the plan's form.

---

## 7 — The honest state, in one table

| Works, measured today | Not yet, stated |
|---|---|
| Deploy refuses an applied-but-missing migration; a fresh isolated DB from one command; the whole `apps/api` suite on push; a hard delete cannot orphan a live listing; the eBay delete needs `products.delete`; the eBay price cell is held with its reason; the column cache is bounded and reported; the sweep is bounded and resumable; Shared is narrowed and states its absences; a channel-scoped requirement survives to `requiredBy`; a price write cannot silently skip its version check | The sheet still bypasses the price door (building, R-11); the concurrency gate on `concurrent-database.ts`; 2.4 move 2; 2.3, 2.5, 2.6; 2.7 and the 5-row mirror on production (D-E, Owner); every Phase 3 item (credentials shut); every Phase 4 item; five gates out of the hook; the Amazon sale-price wipe (§3a); the reader fork (§3b); the flaky `formula-database` file; the credential rotation (0.3, Owner) |

---

## 8 — Recommended order from here

1. **Before Step 2.2 part 2 lifts the eBay hold:** decide §3a. Either add the Amazon sale-price
   step, or scope the lift to eBay and write the Amazon limit into 2.2's Cost when. Building the
   third caller into a door that wipes a sale price is the plan's own "fix the writer first" rule
   applied to itself.
2. **Fold §2 into `PLAN.md` and `PROGRESS.md`** — 17 edits, all named; the lane holds the files.
   Apply §5.3's banner to `RESEARCH.md` in the same change.
3. **Rule:** D-G (15.9's flip), D-E, D-D, D-F, A-17, and the third readiness vocabulary (§6.4).
4. **Quarantine or fix `formula-database.vitest.test.ts`** with a named reason, per the plan's own
   rule. It timed out once in one hook run here and passed alone twice; the hook has no reason to
   be believed while one file decides its colour by load.
5. **Rewrite Step 4.0 to the design-system palette (§4)** and rule D-F before any UI work starts —
   in either programme.
6. **`docs/listings/`:** a claim row, or sequence it after the sheet's Phase 2; and the two
   content edits in §6.

---

## Appendix A — the derived 7:1 probe (reproducible; not a gate)

Run with `node <file>`; reads `apps/web/src/design-system/styles/tokens.css` only. Exit 2 if either
control fails. This is a measurement for Step 4.0, not the gate the step should build.

```js
import { readFileSync } from 'node:fs'
const css = readFileSync('apps/web/src/design-system/styles/tokens.css', 'utf8')
const lines = css.split('\n')
const rootStart = lines.findIndex(l => /^:root\s*{/.test(l))
const rootEnd = lines.findIndex((l, i) => i > rootStart && /^}/.test(l))
const darkStart = lines.findIndex(l => /^\.dark/.test(l))
const darkEnd = lines.findIndex((l, i) => i > darkStart && /^}/.test(l))
function decls(a, b) { const m = new Map(); for (const l of lines.slice(a, b)) { const x = l.match(/^\s*(--nds-[a-z0-9-]+):\s*([^;]+);/); if (x) m.set(x[1], x[2].trim()) } return m }
const light = decls(rootStart, rootEnd), dark = decls(darkStart, darkEnd)
function resolve(name, mode, depth = 0) {
  if (depth > 12) return null
  const v = (mode === 'dark' && dark.has(name)) ? dark.get(name) : light.get(name)
  if (v == null) return null
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/); if (ref) return resolve(ref[1], mode, depth + 1)
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i); if (!hex) return null
  let h = hex[1]; if (h.length === 3) h = [...h].map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}
const lin = c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a, b) => { const x = lum(a), y = lum(b); const [hi, lo] = x >= y ? [x, y] : [y, x]; return (hi + 0.05) / (lo + 0.05) }
const TEXT = ['--nds-text', '--nds-text-strong', '--nds-text-2', '--nds-text-muted', '--nds-text-3', '--nds-text-link', '--nds-primary']
const SURF = ['--nds-surface', '--nds-bg', '--nds-surface-raised', '--nds-surface-sunken', '--nds-surface-hover']
const PAIRS = [['--nds-success-text', '--nds-success-soft'], ['--nds-warning-text', '--nds-warning-soft'], ['--nds-danger-text', '--nds-danger-soft'], ['--nds-info-text', '--nds-info-soft'],
  ['--nds-pill-success-fg', '--nds-pill-success-bg'], ['--nds-pill-warning-fg', '--nds-pill-warning-bg'], ['--nds-pill-danger-fg', '--nds-pill-danger-bg'], ['--nds-pill-neutral-fg', '--nds-pill-neutral-bg'],
  ['--nds-text-inverse', '--nds-primary']]
const ctl = ratio(resolve('--nds-text', 'light'), resolve('--nds-surface', 'light'))
if (!(ctl > 15 && ctl < 16)) { console.error('CONTROL FAILED', ctl); process.exit(2) }
if (resolve('--nds-zz-never-exists', 'light') !== null) { console.error('NEGATIVE CONTROL FAILED'); process.exit(2) }
let failAAA = 0, failAA = 0, total = 0
for (const mode of ['light', 'dark']) {
  const rows = []; for (const t of TEXT) for (const s of SURF) rows.push([t, s]); for (const p of PAIRS) rows.push(p)
  for (const [fg, bg] of rows) {
    const a = resolve(fg, mode), b = resolve(bg, mode); if (!a || !b) continue
    const r = ratio(a, b); total++; if (r < 7) failAAA++; if (r < 4.5) failAA++
    console.log(`${r >= 7 ? ' ok ' : (r >= 4.5 ? 'AA  ' : 'FAIL')}  ${r.toFixed(2).padStart(6)}  ${mode}  ${fg} on ${bg}`)
  }
}
console.log(`\n${total} pairs · ${failAAA} below 7:1 · ${failAA} of those below 4.5:1`)
```

Result on 2026-09-22: `88 pairs · 47 below 7:1 · 8 of those below 4.5:1`; control 15.48.
