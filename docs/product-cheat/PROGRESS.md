# The Product Sheet — PROGRESS

**Updated 2026-09-22. Branch `pes/phase-0` — 14 commits, all pushed. Nothing merged to `main`,
so nothing is deployed and nothing has migrated production.**

Read [PLAN.md](PLAN.md) for the plan and, at its end, the amendments A-1…A-12 + Owner rulings.
Every claim below carries the commit that measured it.

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
| **1.5** Price cell read-only | ✅ **BUILT** (column half). Write half deferred to Step 2.2 — see A-12 | `cf49c88d2` |
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
| **2.2 (part 1)** One price door | ✅ **BUILT** — `expectedVersion` required; an unguarded caller must NAME why; chunked at 500. 🔴 The sheet bypass, the hold, and the concurrency gate are NOT done | _this commit_ |
| **15.5 (c)** Does the reconcile bump the version? | ✅ **ANSWERED — NO**, 0 of 15, with a positive control. 2.2 and 2.7 do not fight | _this commit_ |
| **A-17** 15.5 (b)'s auto-retry is a lost update | 🟡 **FOR YOUR RULING** — recommended: add `expectedPrice` and retry only the safe case | — |

**Phase 0 and Phase 1 are complete except 0.3 (Owner) and 1.3 (credentials).**

---

## What actually changed in the product

1. **A hard delete can no longer orphan a live listing.** It refuses per product, names the
   coordinate and the listing id, and returns per-row outcomes (`487 deleted · 13 refused`). The
   UI announces only what was really deleted.
2. **`POST /api/ebay/flat-file/delete` required `listings.flatfile.edit`** — an *edit* permission
   for a permanent channel removal. Now `products.delete`. Measured first: **0 roles lose the
   action**. `ebay-flat-file.routes.ts` was NOT touched (no-touch rule).
3. **The eBay sheet price cell is held read-only**, with its reason, until Step 2.2.
4. **A deploy now refuses a database holding a migration with no folder in the repo.**
5. **A fresh database can be built again** — `bootstrap-fresh-database.mjs`.
6. **The `apps/api` suite runs on every push.** It was auth-only before.
7. **`GET /admin/pim/sheet-cache-stats`** reports the cache, behind `admin.view`. 🔴 Not PUBLIC —
   `/admin/health` next to it *is*, by exact path, so being under `/admin/` proves nothing.
8. **The sheet's column-set cache can no longer grow without end.** It is keyed per family and per
   saved column selection, so it used to hold one full column set per product a user opened, for
   the life of the process. Now 64 per business, oldest write evicted first.

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
- 🔴 **A-12** — a direct API caller can still `PATCH ebay_price` and bypass the price door. The
  sheet cannot. Closes at **Step 2.2**, which should reuse `EBAY_PRICE_HELD_REASON`.
- ⬜ **15.5c, never verified** — does the readiness reconcile bump `ChannelListing.version`? If it
  does, Steps 2.2 and 2.7 fight. **Verify before 2.2 ships.**
- ⬜ The 467-migration history still does not replay (443/467). It is history, not a build path.
- ⬜ An orphaned eBay *variation* under a surviving parent ItemID is not covered by 1.2.

---

## Next

**Phase 2.** Per [15.13](PLAN.md#1513--ranked-what-to-do-and-when), before Step 2.1:

1. ~~**15.3 — bound the column-set cache**~~ ✅ **CLOSED.** See
   [15.3 RESULT](PLAN.md#step-153-result--the-column-set-cache-is-bounded-and-two-of-its-three-sibling-caches-already-were).
2. ~~**15.11 — the scale fixture**~~ ✅ **CLOSED.** See
   [15.11 RESULT](PLAN.md#step-1511-result--the-scale-fixture-stands-up-and-the-first-thing-it-measured-was-step-24).
3. ~~**2.1**~~ ✅ **BUILT (a) + APPLIED (b, local).** ~~**15.1 + 15.6**~~ ✅ **BUILT.** **2.1 (b)** needs **D-A** — I derive the required list from the
   channel schemas and bring it back for approval. Then **2.7 reconcile**, **2.4** (needs 15.4's
   fix — the plan's `where` clause does not compile on a channel scope), **2.2** (needs 15.5).

✅ **A-13 is closed** (R-7). One bootstrap command now gives an isolated database.

🔴 **Before 2.7, re-read its ordering rule.** It says *"after 2.1, so it computes against real
requirements"*, written believing there were none. Measured: a channel coordinate already has 8 of
163 required; Shared has 1 of 101. **2.7's premise needs its own check.**

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
