# The Product Sheet — PROGRESS

**Updated 2026-09-22. Branch `pes/phase-0` — 40 commits ahead of `main`, all pushed. Nothing
merged, so nothing is deployed and nothing has migrated production.**

**Latest continuation:** **Step 2.2 part 2 is BUILT** under **R-11** (A-18 (a)): the sheet writes
prices through the one door, the reset cleanup lives in the door, and the eBay hold is lifted.
Review §3a is ruled: **eBay only**; the Amazon sale-price wipe is gated out of the sheet, not fixed.

Read [PLAN.md](PLAN.md) for the plan and, at its end, the amendments **A-1…A-18** and the Owner
rulings **R-1…R-11**. Built work carries its commit; A-18 is approved, with uncommitted
implementation and archived probe evidence. See the session checkpoint below.

🔴 **One data write exists, and it is LOCAL ONLY.** Step 2.1 (b) marked 5 `FamilyAttribute` rows in
`nexus_development`. Production is untouched and needs its own word. `--revert` undoes it and has
been exercised.

---

## Where it stands

| Step | State | Commit |
|---|---|---|
| **0.1** Untracked prod migrations | ✅ **CLOSED** — premise was false (0 drift both ways); its missing gate was built | `861280afe` |
| **0.2** One lane at a time | ✅ **CLOSED** — with 15.8's exit condition written in | `ae1757f88` |
| **0.3** Rotate the credential | ⏸️ **OPEN — the Owner's, deliberately deferred to the end.** Do not raise it | `ae1757f88` |
| **0.4** Migration history replay | ✅ **CLOSED** — a fresh database builds from a baseline | `1eaecb03d` |
| **1.1** Delist FK cascade | ✅ **STRUCK** — premise false; no migration needed, nothing to build | `647c1e4d1` |
| **1.2** Never orphan a live listing | ✅ **BUILT** | `5c2030a44` |
| **1.3** Reversible unpublish | 🔴 **BLOCKED** on Step 3.1 (no live eBay/Amazon credentials) | — |
| **1.4** Gate the Amazon delete | ✅ **CLOSED** — Amazon was already done; the real hole was eBay's permission | `6ff3b6b58` |
| **1.5** Price cell read-only | ✅ **BUILT, then LIFTED by Step 2.2 part 2** — the hold did its job and is deleted | `cf49c88d2` |
| **A-8** `apps/api` suite was not gated | ✅ **BUILT** — 833 test files now run on every push | `43ace2666` |
| **15.3** Bound the column-set cache | ✅ **CLOSED** — capped at 64 per workspace; 2 of its 3 sibling caches were already bounded | `3e4f881d3` |
| **15.3 (b)** Report the cache size | ✅ **CLOSED** under R-6 — `GET /admin/pim/sheet-cache-stats`, behind `admin.view` | `8f931f913` |
| **15.11** The scale fixture | ✅ **CLOSED** — seeded at 1,000 and 10,000; measured; it refuses numbers it cannot stand behind | `d399c1660` |
| **15.11a / 15.12** `Cost when` on every step | ✅ **CLOSED** — all 25 steps carry one; 2 of the research's 6 numbers carried, 4 stated as uncarryable here | `d399c1660` |
| **A-13** Bootstrap built a database with **no RLS** | ✅ **CLOSED** under R-7 — the bootstrap now applies the isolation layer; 443 policies, 1,778 grants; gated twice | `8908961e3` |
| **2.1 (a)** Requirements become real — the code | ✅ **BUILT** under R-8 — a channel-scoped family requirement reaches `requiredBy` as a coordinate label; 4 arms, 3 mutations | `ca8782153` |
| **2.1 (b)** Which attributes are required — the data | ✅ **APPLIED under R-10** — 5 rows mirrored on the **local** catalogue, revert exercised. 🔴 **Production untouched, and needs your word** | `69debb8de` |
| **A-15** 64 businesses × 64 entries ≈ 1.9 GB | ✅ **CLOSED** under R-9 — the bucket count is now reported on the admin route, so the cap can be chosen from data | `c3d452d03` |
| **15.1 + 15.6** Bounded, resumable sweep | ✅ **CLOSED** — 10-min nightly budget, derived checkpoint, one helper; 10,000 products reconciled in 6.2 min of chunks | `04ee5bb24` |
| **2.4 (move 1)** Shared means shared | ✅ **BUILT** — presence narrowed to the page's products, market switcher kept global, absence stated in the UI. **~150 ms → 6 ms**, flat | `f8fcd1158` |
| **2.2 (part 1)** One price door | ✅ **BUILT** — `expectedVersion` required; an unguarded caller must NAME why; chunked at 500 | `76b8be797` |
| **2.2 (part 2)** The sheet uses the door | ✅ **BUILT under R-11** — `ebay_price` and `attr_price` go through `writeChannelPrices`; legacy keys cleaned in the door; hold lifted; 16 tests, 12 mutations red. 🔴 Concurrency gate NOT done | see `git log` |
| **15.5 (c)** Does the reconcile bump the version? | ✅ **ANSWERED — NO**, 0 of 15, with a positive control. 2.2 and 2.7 do not fight | `76b8be797` |
| **A-17** 15.5 (b)'s auto-retry is a lost update | 🟡 **FOR YOUR RULING** — recommended: add `expectedPrice` and retry only the safe case | — |
| **A-18** Price reset loses legacy-key cleanup at the price door | ✅ **BUILT under R-11** — with Step 2.2 part 2 | see `git log` |
| **Review §3a** Amazon price PATCH wipes the sale price | ✅ **RULED: eBay only.** The sheet has no Amazon price column, and a test now fails if one appears. 🔴 The wipe itself is NOT fixed for the three existing callers | — |
| **A-19** The price door is linear, ~17 ms a row (5,000 rows ≈ 1.5 min) | 🟡 **FOR YOUR RULING, not blocking** — recommended: record the limit; batch later | — |

**Phase 0 and Phase 1 are complete except 0.3 (Owner) and 1.3 (credentials).**

---

## What actually changed in the product

1. **A hard delete can no longer orphan a live listing.** It refuses per product, names the
   coordinate and the listing id, and returns per-row outcomes (`487 deleted · 13 refused`). The
   UI announces only what was really deleted.
2. **`POST /api/ebay/flat-file/delete` required `listings.flatfile.edit`** — an *edit* permission
   for a permanent channel removal. Now `products.delete`. Measured first: **0 roles lose the
   action**. `ebay-flat-file.routes.ts` was NOT touched (no-touch rule).
3. **A price typed in the eBay sheet now goes through the one price door** — event, audit row,
   `PRICE_UPDATE` enqueue, and a check on the **listing** version. It used to skip all four. The
   temporary read-only hold (Step 1.5) is gone.
4. **A deploy now refuses a database holding a migration with no folder in the repo.**
5. **A fresh database can be built again** — `bootstrap-fresh-database.mjs`.
6. **The `apps/api` suite runs on every push.** It was auth-only before.
7. **`GET /admin/pim/sheet-cache-stats`** reports the cache, behind `admin.view`. 🔴 Not PUBLIC —
   `/admin/health` next to it *is*, by exact path, so being under `/admin/` proves nothing.
8. **The sheet's column-set cache can no longer grow without end.** It is keyed per family and per
   saved column selection, so it used to hold one full column set per product a user opened, for
   the life of the process. Now 64 per business, oldest write evicted first.
9. **`bootstrap-fresh-database.mjs` now produces an ISOLATED database** — 443 policies, 1,778
   grants. It used to build a schema with **0** of either, which the app could not use and which
   was one `GRANT` away from every business reading every other business.
10. **A family requirement scoped to a channel survives.** *Required on Amazon* used to be
    discarded outright; it now reaches the sheet as *"required by Amazon · DE"* on Shared and as a
    real requirement on Amazon, and never touches eBay.
11. **The nightly readiness sweep is bounded at 10 minutes** and resumes on the next tick. It used
    to run for a projected 11.4 hours at 10,000 products, holding Serializable transactions.
12. **The sheet's column build is ~25× faster and no longer grows with the catalogue** — one
    un-narrowed aggregate was the entire cost of the page. ~150 ms → **6 ms**.
13. **A price write cannot silently skip its version check.** A caller with no version must name
    why, from a closed set, and every outcome says whether it was guarded.
14. **Resetting a price now removes the old hidden price keys** (`overrideData.price`,
    `ebay_price`) that could make a listing show a stale price after a reset.

---

## The scale fixture — how to use it

```
# once, on a fresh throwaway database (created next to nexus_development).
# Since A-13 this ALSO applies the isolation layer — no --prepare needed.
DATABASE_URL=…/nexus_scale node packages/database/scripts/bootstrap-fresh-database.mjs
# then
DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/seed-scale-fixture.ts --products 10000
DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/measure-scale-fixture.ts --readiness-families 5
```

The measure script **exits 1** rather than print a number it cannot stand behind — including on a
database with 0 policies. `--prepare` still exists for a database prepared some other way.

---

## Open, carried forward

- 🔴 **1.3** blocked on **3.1** — eBay decrypt + Amazon `invalid_grant`. Blocks 3.4, 3.5 too.
- 🔴 **The Amazon price PATCH wipes a sale price** (review §3a, `amazon-sp-api.client.ts:637-655`).
  Live for the Matrix, `PATCH /channel-pricing` and bulk override. The sheet is gated out of it.
  Needs its own step before any Amazon price column joins the sheet.
- 🟡 **A-19** — the door is ~17 ms a row. Not blocking: the sheet sends one request per row.
- 🔴 **Step 2.2's concurrency gate is NOT written** — *"the second write returns `conflict`, on
  `concurrent-database.ts`, never on PGlite."* The six tests that exist are contract arms on mocks.
- 🟢 ~~**15.5c**~~ **ANSWERED: the reconcile does NOT bump `ChannelListing.version`** — 0 of 15,
  with a positive control. 2.2 and 2.7 do not fight.
- ⬜ The 467-migration history still does not replay (443/467). It is history, not a build path.
- ⬜ An orphaned eBay *variation* under a surviving parent ItemID is not covered by 1.2.

---

## Next — start here

### Where this lane stands — 2026-09-22, evening

- **Step 2.2 part 2 is BUILT and committed** (A-18 (a) / R-11). All four fields are in
  [PLAN.md, "Step 2.2 part 2 — BUILT"](PLAN.md#step-22-part-2--built-a-18--r-11-the-sheet-now-writes-prices-through-the-one-door).
  Done when ✅ · Gate ✅ (12 mutations red) · Rollback = revert one commit · Cost when ✅ for the
  5,000-row call (it completes, per-row outcomes), with the linear cost stated as **A-19**.
- **Not done, stated:** the real screen was not exercised (no API server of this lane; a save
  would write the local catalogue). The web path was traced read-only and needs no change.
- **The gate:** `apps/api/src/services/pim/price-door-reset.vitest.test.ts`, on disposable
  PostgreSQL via `concurrent-database.ts`. Run it **from `apps/api`**:
  `NEXUS_WORKSPACES_ENABLED=1 ../../node_modules/.bin/vitest run src/services/pim/price-door-reset.vitest.test.ts --disableConsoleIntercept`.
  Local PostgreSQL is on port 55439.
- **Archived A-18 probe evidence** stays in `docs/product-cheat/probes/`.
- **Carry the earlier rulings:** the Owner's A-17 preference is **(a), `expectedPrice`** — raise
  it when the retry work is reached. D-E and the production mirror remain unauthorised
  production writes. Do not raise the deferred credential rotation.

**Standing execution rules:** one lane, one commit per step group, never `--no-verify`, push when
green. A step closes only when **Done when / Cost when / Gate / Rollback** all pass. Prove each
gate can fail, including both arms when the code has two paths. Verify `file:line` rather than
trusting a plan sentence. Any new defect or better approach goes into a PLAN amendment for Owner
approval **before building**. Each turn reports what changed, whether it worked, and what is next.

### Three earlier rulings remain open. Raise them only when needed.

| # | What | Recommended |
|---|---|---|
| **A-17** | 15.5 (b) asks for a retry that is a **lost update** — on conflict, re-read and resubmit over somebody else's change | **(a)** carry `expectedPrice` and retry only when the price itself is untouched |
| **D-E** | Run the readiness reconcile on **production**. It is a live write | read 2.7's re-check below first |
| **Step 2.1 (b) on production** | The 5-row mirror ran on the local database only. Same script, same ruling, a different database | yours to authorise |

### The build queue

1. ✅ ~~**Step 2.2, part 2 — the sheet's price bypass.**~~ Built under R-11.
2. **Step 2.2's concurrency gate** — on `concurrent-database.ts`, never PGlite.
3. **Step 2.4 move 2** — *the family decides Shared's columns*. Move 1 (the stopgap) shipped.
   🟢 Step 2.1 (a) already built the *"also required by Amazon · DE"* marker it needs.
4. **Step 2.7** — 🔴 **re-read its ordering rule first.** It says *"after 2.1, so it computes
   against real requirements"*, written believing there were none. Measured: a channel coordinate
   already has **8 of 163** required; Shared has **1 of 101**. **2.7's premise needs its own check
   before it runs**, and at a real 4 s per family a 10-minute nightly budget covers ~150 families —
   so a 2,000-root catalogue refreshes on a **rotation**, not nightly-in-full.
5. Then **2.3** (two lines, locale into publish), **2.5**, **2.6** (use the new sweep helper).

### Still blocked, not forgotten

- 🔴 **1.3** on **3.1** — eBay decrypt + Amazon `invalid_grant`. Blocks 3.4 and 3.5 too.
- ⏸️ **0.3** the credential rotation — the Owner's, deliberately deferred.

## The rule that earned its keep, again

Seven things went wrong this session. **Every one was caught by measuring, and four of them were
caught by a test of mine failing on its own scaffolding rather than on the code.** Three mutations
ESCAPED a gate I had just called green, and each time the fix was a second arm, not a second line.

> A gate with two paths needs two arms. One of them is decoration until it is mutated.

---

## How to work here — the things that cost time this session

**Commands**
- `npm run test:hook --workspace=@nexus/api --silent` — the suite as the hook runs it (~50 s).
  🔴 Plain `vitest run` exits 1 at random on a teardown race; `--disableConsoleIntercept` is why.
- `node apps/api/scripts/profiles-on-ratchet.mjs` — re-runs the suite with profiles **ON**, as
  production runs. It refuses a new failure, a worse file, **and a fixed file left in the list**
  (`--write` shrinks the baseline). It rejected two pushes this session.
- 🔴 Run vitest from **`apps/api`**, never the repo root — the root `.env` is Neon production. The
  R-VT-12 guard refuses it, loudly.
- `NEXUS_WORKSPACES_ENABLED=1 npx vitest run <file>` — reproduce a ratchet refusal on one file
  instead of waiting for the whole suite.

**Traps measured the hard way, 2026-09-22 (second session)**
- 🔴🔴 **A row count with NO workspace context returns 0, and that reads exactly like "empty".**
  The local catalogue has 355 products; a `count(*)` outside `withWorkspace(...)` said 0 and a whole
  paragraph was written on it. Run counts inside the context, with a control.
- 🔴🔴 **`getSheetColumns` needs `productTypes`** or it returns 3 columns — and it SAYS SO, in
  `schemaMissing: ["AMAZON:category not selected"]`. With one: **163 columns, 474 KiB**. Read
  `schemaMissing` before explaining a small column count.
- 🔴🔴 **You cannot patch `prisma.<model>.<method>`** — the client is a Proxy (`db.ts` →
  `contextualDatabase`). The assignment is silently discarded. A 250 ms injection moved the number
  by 3 ms, which reads as *"this is not the cost"*.
- 🔴 **`readSaleWindows` returns a MAP.** `Object.assign` to merge chunks type-checks and merges
  nothing. The symptom was a re-submit reading as a change, only above 500 rows.
- 🔴 **Scope a state count to what the RUN touched.** A whole-table `ReadinessIndex` count stayed
  green while the run under test checked nothing.
- 🔴 **A `beforeAll` that throws gives `N passed | M skipped`.** vitest still exits 1, but the
  assertions never ran — that run does not show the assertions work.
- 🔴 **`process.exit(0)` after an unawaited `main()`** prints nothing and exits 0, having done
  nothing. A silent success.
- 🔴 **Importing a script RUNS it.** `seed-marketplaces.ts` had a module-scope `main()`; the import
  seeded a database and then killed the importer mid-write with an unhandled rejection.
- 🔴 **Prisma's `groupBy` argument type is conditional** — a spread `where`, or annotating the
  `await`, reports a circular reference. Two explicit calls, or map then annotate.
- ⬜ **`mapping/formula-database.vitest.test.ts` is flaky** — failed twice in four full runs at
  ~10 s, passes alone and on re-run. PGlite is one connection.

**Traps measured the hard way**
- 🔴 **Prisma orders migrations by `localeCompare`, not `.sort()`.** A replay using `.sort()`
  measures a different sequence. Pinned against an observed deploy.
- 🔴 **`prisma migrate diff` cannot see its own `dbgenerated` defaults.** It reports 420 missing
  `SET DEFAULT` statements against a database that has them. Query `information_schema` instead.
- 🔴 **`readOnlyReason` ≠ a policy hold.** It means *"the channel owns this value"*, and
  `master-default-rule.ts:8` drops the master mapping for any field carrying it. Use
  `editHeldReason` (read only by `sheet-columns.service.ts`).
- 🔴 **`ebay_price` is the repo's canonical fixture for a mapped channel field.** Blocking it at a
  generic gate breaks 19 arms across 3 files covering #689/#700/#703.
- 🔴 **Flat-file routes are a no-touch zone.** Table the exact edits, split preserving from
  changing, ask separately.
- ⬜ **`mapping/formula-database.vitest.test.ts` is FLAKY** — failed twice in four full runs at ~10 s,
  passes alone and on re-run. PGlite is one connection; it looks like a timeout under parallel load.
- 🔴 **A truncated `grep` is not a set.** `| head -10` on a 74-match search produced a confident,
  wrong amendment (A-11).
- 🔴🔴 **You cannot patch `prisma.<model>.<method>` — the client is a Proxy** (`db.ts` →
  `contextualDatabase`). The assignment is silently discarded and the patch is never called. A
  250 ms injection moved the number by 3 ms, which reads as *"this is not the cost"*.
- 🔴 **Scope a state count to what the RUN touched.** A whole-table `ReadinessIndex` count stayed
  green while the run under test checked nothing — rows from an earlier run answered for it.
- 🔴🔴 **`getSheetColumns` needs `productTypes` or it returns 3 columns and says so.** Without one it
  reports `schemaMissing: ["AMAZON:category not selected"]` — a field I did not read, and then
  published a wrong reason for the small number. **With** a product type: **163 columns, 473.9 KiB**
  (268 / 1.1 MiB for three types). Read `schemaMissing` before explaining a small column count.
- 🔴 **A `beforeAll` that throws gives `N passed | M skipped`, not a failure count.** vitest still
  exits 1, but the assertions never ran — so that run does NOT show the assertions work. To prove
  an assertion, the thing it measures must be broken *without* an earlier guard stopping the run.
- 🔴 **Three test files mock `WorkspaceCache` as a bare `Map`.** Adding a constructor argument
  therefore breaks them with `number 32 is not iterable` — a suite **LOAD** failure, which reads as
  `1 failed | 4 passed (5)` with `10 passed` tests. Count files, not tests.
- 🔴🔴 **A row count with no workspace context returns 0, and that reads exactly like "empty".**
  The local catalogue holds **355 products**; a `count(*)` outside `withWorkspace(...)` said 0 and
  a whole paragraph was written on it. Row-level security makes *"could not see"* look like
  *"nothing there"*. Always run the count inside the context, and give it a positive control.
- 🔴 **`process.memoryUsage().heapUsed` did not see a deliberately retained 1 MiB string.** Give
  every memory probe a known-size positive control before believing its deltas.

---

## The rule that earned its keep

Six plan claims marked "verified" were wrong, and two of my own findings were wrong. **Every one
was caught by measuring, not by arguing** — and twice by deliberately breaking my own test and
watching what did *not* go red.

> A green that has never been shown able to fail is not evidence.
