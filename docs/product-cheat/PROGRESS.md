# The Product Sheet — PROGRESS

**Updated 2026-09-23 ~11:00 (see "Where this lane stands" below). Branch `pes/phase-0` holds `main` (`0a563d6d5`, DEPLOYED
06:46 UTC, no migration) plus docs only.**

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
| **0.2** One lane at a time | 🟢 **IN FORCE** — exit condition written (A-5); **exit not yet met** (gates still out of the hook). A reader of "closed" would start a second lane | `ae1757f88` |
| **0.3** Rotate the credential | ⏸️ **OPEN — the Owner's, deliberately deferred to the end.** Do not raise it | `ae1757f88` |
| **0.4** Migration history replay | ✅ **CLOSED** — a fresh database builds from a baseline | `1eaecb03d` |
| **1.1** Delist FK cascade | ✅ **STRUCK** — premise false; no migration needed, nothing to build | `647c1e4d1` |
| **1.2** Never orphan a live listing | ✅ **BUILT** | `5c2030a44` |
| **1.3** Reversible unpublish | ✅ **BUILT (R-38, R-39)** — hard delete + "stop selling": Amazon closes the market's offer (SCT.6's channel half, shared), eBay quantity 0 under the out-of-stock control; FBA and an unknown/off control refused before the delete. Both mechanisms proven live and restored. ⬜ not run live end-to-end through the worker; eBay single-SKU path never run live | `65e1d9c0a` |
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
| **2.2 (part 2)** The sheet uses the door | ✅ **BUILT under R-11** — `ebay_price` and `attr_price` go through `writeChannelPrices`; legacy keys cleaned in the door; hold lifted; 16 tests, 12 mutations red | `a55d8da5f` |
| **2.2 Gate (2)** Concurrency | ✅ **BUILT** — a forced race on real PostgreSQL: one `applied`, one `conflict` (door, sheet, mixed); each guard proven by a different arm | `1c2efb671` |
| **15.5 (c)** Does the reconcile bump the version? | ✅ **ANSWERED — NO**, 0 of 15, with a positive control. 2.2 and 2.7 do not fight | `76b8be797` |
| **A-17** 15.5 (b)'s auto-retry is a lost update | ✅ **BUILT under R-12** — `expectedPrice`: retry only when the price is the one the caller saw; the Matrix passes it; 8 mutations red. **Step 2.2 CLOSED** | see `git log` |
| **A-18** Price reset loses legacy-key cleanup at the price door | ✅ **BUILT under R-11** — with Step 2.2 part 2 | `a55d8da5f` |
| **Review §3a** Amazon price PATCH wipes the sale price | ✅ **RULED: eBay only.** The sheet has no Amazon price column, and a test now fails if one appears. 🔴 The wipe itself is NOT fixed for the three existing callers | — |
| **A-19** The price door is linear, ~17 ms a row (5,000 rows ≈ 1.5 min) | ✅ **RULED R-13** — the limit is recorded in Step 2.2's Cost when; batch later | — |
| **A-20** Step 2.4 move 2 — the editor already does it; the products grid is left, and **28 of 42** live local parents have no family (the first count, 40 of 54, included deleted products) | ✅ **RULED R-14 (a), BUILT** — move 2 closed for the editor; the grid shows *"N without family"*; new **Step 2.4b** (assign families) comes before the grid flip | see `git log` |
| **2.4 (move 2)** The family decides Shared's columns | ✅ **BUILT under R-14 / R-16** — editor since `f212c2348`; the grid now too: 365 → **0** channel-declared columns on a real page, no stored value hidden. **Step 2.4 CLOSED** | see `git log` |
| **A-22** Step 2.3's example cannot happen; the gap is Amazon BE (Dutch + French) | ✅ **CORRECTED, then RULED R-18 (b), BUILT** — the main paths already send every language; the mapping cascade and the cockpit refuse a multi-language market, named. **Step 2.3 CLOSED** with that limit stated | see `git log` |
| **A-23** The cockpit sent an unknown market (NL, PL, SE, TR, IE) to Amazon **Italy** | ✅ **RULED R-19, BUILT** — refused per market, by name | see `git log` |
| 🔴🔴 **A-24** Every Amazon queue push (price, content, stock, full sync) was sent to Amazon **Italy** | ✅ **RULED R-20, BUILT** — the listing decides the market; refuse, never Italy; 5 mutations red. 🔴 Production: **256** DE/ES stock rows were built for Italy and marked sent on 2026-09-08 — whether they reached Amazon is unknown until Step 3.1 | see `git log` |
| **A-25** Step 2.5: nothing enforced "factual = code" | ✅ **RULED R-22, BUILT — Step 2.5 CLOSED**: a choice list cannot be per-language (route + router + gate, 5 mutations red). 🔴 Deploy checklist: count per-language choice lists on production first | see `git log` |
| **A-26** Step 2.6 measured (2026-09-23): **four** stores; production has **no** colliding variants (the XS/XXS pair is local only); the sheet shows FLAT first, every publisher reads `categoryAttributes.variations` first | ✅ **RULED R-23 (a)**: `categoryAttributes.variations` is the one store. The sheet's size cell holds **0** values on production | — |
| **A-27** Step 2.6's build, four slices: 2.6a the sheet reads/writes the one store · 2.6b four writers stop wiping it · 2.6c one writer, `variantAttributes` retired as an axis store · 2.6d data (Owner) | ✅ **APPROVED R-24** — building 2.6a → 2.6b → 2.6c, one commit each; 2.6d waits for the Owner | — |
| **2.6a** The sheet reads and writes the one store | ✅ **BUILT** — the store beats the flat key on read; a held axis is written even when undeclared (`xracing`); 13 arms, 6 mutations red (1 equivalent, explained) | see `git log` |
| **2.6b** Four writers stop wiping the store | ✅ **BUILT** — organize publish, eBay import, Amazon reconciliation, catalog PATCH merge instead of replace; 5 arms on real PostgreSQL, 7 mutations red | see `git log` |
| **2.6c-1** Every reader takes the store first | ✅ **BUILT** — 23 of 24 live readers read through `variationBag` (the 24th moves with its writer in c2); a source scan names every remaining direct read (32 exceptions, each with a reason); 6 mutations red | see `git log` |
| **2.6c-2** One writer; the legacy bag never written | ✅ **BUILT** — every writer sets the store and REMOVES the touched axis from the legacy bag (a stale legacy size cannot come back on clear); real-database gates consolidated onto one in-process database (the server's lock table overflowed); 27 mutations red across Step 2.6 | see `git log` |
| **A-29** AIREON: the store holds eBay's colour name (`Nero Neo \| Giacca`); Amazon·IT says `Nero Neo` | ✅ **RULED R-27 (a)** — a per-channel value name is its own later step. 🔴 **Do not publish AIREON to Amazon until then.** Nothing sent | — |
| **2.6d** The data run (fill 77 sizes + 77 colours from eBay·IT; drop the one wrong legacy value) | ✅ **APPLIED on production** (on the Owner's authorisation): 78 products, 0 left, store colour 301 / size 285, no collision; record kept for `--revert`. **Step 2.6 CLOSED** | see `git log` |
| **2.6c-3** One synonym table | ✅ **BUILT under R-26** — production counted first; the product side reads the eBay table (unchanged, because a no-touch flat-file copy mirrors it byte-for-byte); `talla`/`groesse` stay product-only, named; 5 mutations red | see `git log` |
| **A-28** Three findings: organize undo leaves the store changed; eBay import overwrites type and bullets; the variant-attributes route stringifies objects | ✅ **RULED R-25 (a), BUILT** — undo restores both stores (snapshot inside the existing JSON, no migration); the import keeps type and bullets; objects refused by name; 5 mutations red | see `git log` |
| **2.1 (b) on production** (2026-09-23) | ✅ **APPLIED by the Owner — Xavia Racing: `WROTE 5 rows`, count 5** (dry run first, `0 already required` before, `--revert` exact). ✅ Motovento: 0 rows (no cached schemas). **Done for both businesses** | — |
| **A-21** Step 2.7's premise re-checked — the "after 2.1" rule protects nothing; ~2–4 s per family | ✅ **RULED R-15** — ordering rule struck. 🔴 **D-E NOT approved**; count production roots first | — |
| **A-30** Step 2.7 measured again: rows from the old nightly; the dry run could not count; 🔴 past its budget the nightly re-did the same first families forever | ✅ **RULED R-28, BUILT** — oldest first + the dry run counts (`42 of 42` local, matching `readiness-age.mjs`); 500-family simulation: 300 never computed → 0; 5 mutations red. ⏳ **Step 2.7 closes on the verify** after the 02:17 nightly on 2026-09-24 (production read — the Owner runs `readiness-age.mjs`) | see `git log` |
| **A-31** GitHub CI red on the deploy commit `0a563d6d5` | ✅ **RULED R-29, BUILT** — reset test on PGlite, race test skips without a test server and runs in the push hook's real-PostgreSQL stage (11/11); CI step here: 0 failed; 6 mutations red. 🟠 `main`'s CI turns green at the next merge. Found: the price door takes a second connection for an account-less listing (P1.3 owner) | see `git log` |
| **A-32** Amazon·DE listings pin an Italian title; a publish sends it tagged German | ✅ **RULED R-30, BUILT** — **production counted: 25 Amazon·DE titles, 21 live** (AIR-MESH-JACKET-MEN 6, REGAL-JACKET 13, VENTRA-JACKET 4, IT-MOSS-JACKET 1, MISANO-JACKET-XS-BLACK 1); FR/ES 0. The studio publish preview now names such a listing (warning); 5 mutations red. ⏳ **The Owner decides per listing**: German title, or follow the product | see `git log` |
| **A-33 / Step 3.3** The two Amazon payload builders had drifted (a cascade clear went out by name alone) | ✅ **RULED R-31, BUILT — Step 3.3 CLOSED**: one serializer + one patch for both; the parity gate (5 arms) is red on the old cascade and on 6 mutations; a cascade clear now carries the schema selectors | see `git log` |
| **A-34 / Step 3.6** The server already refuses a bad paste, per row | ✅ **RULED R-32; gate BUILT** (4 arms on the real save path, 3 mutations red). ⚠️ **Browser check: could not measure** — the local Amazon account is disconnected, and the automated paste does not reach the grid (a text field takes it; no save request was sent). ⏳ **The Owner's one-minute check**: paste a too-long value next to a valid one in the studio sheet | see `git log` |
| **3.1** Open the two shut doors | ✅ **Premise changed — both OPEN on production** (read only, R-33): Amazon `getListingsItem` → the stored ASIN; eBay `GetItem` with the account token → `Success`, `Active`. Opened by the channel-connections lane. Unblocks 1.3, 3.4, 3.5 | — |
| **A-35 / Step 3.4** The first live write and read-back | ✅ **RULED R-35 — CLOSED 2026-09-23**: Amazon·IT backend search terms on `GALE-JACKET-BLACK-MEN-S` — preview passed, write `ACCEPTED` and read back in 15 s, restored and read back, a delayed re-read equals the saved value (the probe was live ~45 s). Seeds Step 3.5 | see `git log` |
| **A-36 / Step 3.5a** What the channel holds that differs from us | ✅ **RULED R-36, BUILT**: `ChannelDrift` (additive migration `20260923a`), one writer, fed by the Amazon (quantity + price) and Shopify read-backs; the list's new **"Differs on the channel"** filter; the old one renamed **"Has overrides"**; the Amazon dedupe per market; 10 mutations red. ⬜ eBay mapping (next slice), 3.5b content reads (for approval). 🟠 Local DB has 2 pending migrations (not applied by this lane) | see `git log` |
| **A-37 / Step 1.3** Reversible unpublish — the live proof | ✅ **RULED R-37; proven live and restored**: eBay quantity 0 (out-of-stock control on) keeps the item `Active`, restores to 10; Amazon merchant quantity 0 reads back, restores to 2. 🔴 The Amazon quantity is shared across EU markets — the test likely paused the SKU EU-wide for ~90 s (restored) | — |
| **A-38** Step 1.3's Amazon half already exists (SCT.6 per-market offer close/reopen) | ✅ **RULED R-38 / R-39** — SCT.6 close + replay proven live on `xracingbxn48` Amazon·IT (no Nexus row written; re-read equal at ~1, 2.5, 3.7 min); the build is for the hard-delete flow (no republish exists) | `f7bd4b085`, `65e1d9c0a` |
| **Step 3.5 eBay slice** The eBay quantity read-back records drift per listing | ✅ **BUILT (R-36)** — one per-entry verdict; a diff lands on the product's own listing on that ItemID, else the ItemID's one owner as `quantity:<SKU>`; ambiguous = counted, not guessed. 🔴 The list hides eBay shells — the filter now reaches through them | `298364359` |
| **A-39 / Step 3.5b** Amazon content reads | ✅ **RULED R-41, slice b1 BUILT; b2 eBay BUILT (A-40, `fb992c921`)** — nightly 03:37 UTC per business, ≤ 10 min, ≤ 1 read/s, rotating; one additive column `ChannelDrift.checkedBySource` (migration `20260923b`); the writer keeps the true count. On with the deploy (`NEXUS_ENABLE_CONTENT_DRIFT=0` holds it). ⬜ b2 (eBay) later | `22ed2676b` |
| **3.2** The four measurements | ✅ **CLOSED 2026-09-23** — M1 ✅, M2 = 0, M3 ✅, M4 = 0, predictions written first; the gate (15.7 #1) `sheet-payload-parity.vitest.test.ts` built, 3 mutations red; the production sample (15.7 #2) is Step 3.5b's rotation | see `git log` |

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
- ✅ **Step 2.2 is CLOSED** (A-17 built under R-12).
- 🟢 ~~**15.5c**~~ **ANSWERED: the reconcile does NOT bump `ChannelListing.version`** — 0 of 15,
  with a positive control. 2.2 and 2.7 do not fight.
- ⬜ The 467-migration history still does not replay (443/467). It is history, not a build path.
- ⬜ An orphaned eBay *variation* under a surviving parent ItemID is not covered by 1.2.

---

## Next — start here

### Where this lane stands — handoff 8, 2026-09-24 13:52 UTC (READ THIS FIRST; everything below is history)

> **DEPLOYED 2026-09-24 (the Owner: "merge it, and push to main").** `main` = **`60539940f`** (fast-forward from `0a563d6d5`, 64 commits). The
> first push to `main` was refused by the known AE.4 flake (`claimed: 0`, `sync.vitest.test.ts:419`; the same commit passed it at 14:21); the one
> retry passed every stage (14:44 UTC). 🔴 The runner scopes the browser gates by `origin/pes/phase-0..HEAD`, so a push of this ref to `main` ran
> NO browser gate — they had run on this exact commit at 14:21 and 13:48 (a gap to fix: scope by the pushed range).
> **Railway:** `495a2006` SUCCESS 14:59 UTC — the 3 migrations applied (`20260923a`, `20260923b`, `20260924a` A-53); then `5149a312` (a second
> deploy of the same source, as on 09-23) SUCCESS 15:03 UTC, "No pending migrations", now live. **Vercel:** the live CSS carries the new tokens
> (text-3 #48505b / dark #b3bac6, primary-hover #0f4290).
> **Production reads after (read only, predictions written first — all held):** Motovento `Marketplace` 0 → **20 (19 active)**, `EBAY:IT` VAT 22
> tax-inclusive; Xavia **20 / 19, every row equal to the 09-24 snapshot** (0 differences). `ChannelDrift`: 219 eBay rows, 0 drifted.
> `prod-run.mjs content-drift` (dry run): **235 Amazon listings in scope, 235 due** (never checked — its first night is 2026-09-25 03:37 UTC).
> **Seen, pre-existing (not this deploy):** `ebay-readback: per-SKU error — EBAY_APP_ID and EBAY_CERT_ID environment variables must be set`
> (logged at 14:30 UTC by the OLD deploy too); `stock-import stuck-job sweep failed on boot: Select a business profile` (on 09-23 too).
> **Next:** after 04:20 UTC 2026-09-25 read the first nights' lines (`node docs/product-cheat/tools/nightly-lines.cjs`, read only; baseline
> `records/nightly-before-2026-09-24.txt`, predictions `records/nightly-predictions-2026-09-25.md`): readiness-reconcile both businesses, A-50's drop on non-Italian % (Xavia de 60.4,
> en 59.4, es 60.6, fr 60.7, nl 70.9, pl/sv/tr 100 before; it 75.7), and content-drift's FIRST run.

**`main` = `0a563d6d5` (deployed; unchanged). `origin/pes/phase-0` = `8fd499675`** — the 12:04 UTC push LANDED with every gate green (editor-open
0 new, 18 gone: the 36 `=` keys GONE; census 7 gone). **Step 0.2 CLOSED** by it. The final push of this round carries the commits below.

**The plan's 26 steps:** Phase 0 — 0.1 ✅ 0.2 ✅ 0.4 ✅, 0.3 the Owner's (kept for the end) · Phase 1 5/5 ✅ · Phase 2 7/7 ✅ · Phase 3 6/6 ✅ ·
Phase 4 — 4.0 ✅ 4.1 ✅ 4.2 ✅ **4.3 ✅ all five** (#1 editor, #2 top bar, #4 completeness earlier; **#3 bullets `80baa4492`, #5 the AAA sweep `975e64882`** now).
**Built ≠ live:** production runs `main`; everything since 09-23 06:28 UTC (60+ commits) goes live with the Owner's merge.

**This round (rulings unchanged; lanes BL2, AA2, MV1 — disjoint files, R-44):**
- **#5 AAA sweep** (AA2): web 49/90 → 0/92 below 7:1, factory 56/104 → 0/106; the hook holds both at 0/0; a hover pair measured. Residue named in PLAN.md.
- **#3 bullets in one cell** (BL2): `SlotListEditor` + one engine column; Bullet 1–10 hidden by default on channel scopes (R-56); 33/33 mutations red.
  Stated choices for the Owner: each following bullet keeps its own LX.14 acknowledgement; saved layouts keep the ten.
- **A-53 Motovento "Waiting for the market…"** (MV1 diagnosed, read only): no business created under profiles gets `Marketplace` rows. Plan `9a6efc1da`;
  **built by a SEPARATE Owner session as `9bb81217e`** (its record: `docs/product-cheat/A-53-motovento.md`). Its data migration `20260924a_a53_market_catalogue_backfill`
  (Owner ruling: per row, add missing markets only) runs on PRODUCTION with the deploy — Motovento +20.
- **Browser gates by hand 13:26–13:48 UTC** over all of it: chrome 0 · editor-open 0 new (bullets rows green) · census 0; local database unchanged. Baseline lowered
  (editor-open 20 → 2, census 7 → 0).

**Next:** the push (running from this handoff) → the Owner merges to `main` → after the merge: `node docs/product-cheat/tools/prod-run.mjs content-drift` (read only)
and the first nights' CronRun lines (content-drift; readiness — A-50 lowers non-Italian readiness % to the true value); a read-only count of Motovento's
`Marketplace` rows after the deploy (A-53's migration). The A-53 session waits for this lane's "push landed" message before editing again.
**Still the Owner's, kept for the end:** 0.3; listing content data (R-34).

### Where this lane stands — handoff 7, 2026-09-24 11:58 UTC (history)

**`origin/pes/phase-0` = `a80a3044e`. Local `pes/phase-0` is ~21 commits ahead, NOT pushed** — the last push was REFUSED by the
editor-open gate on a real regression (below). `main` = `0a563d6d5` (NOT deployed; the Owner merges).

**The plan's 26 steps:** Phase 0 — 0.1 ✅ 0.4 ✅, 0.2 (its exit — the four gates in the hook — is MET once a push lands green), 0.3
the Owner's (kept for the end) · Phase 1 5/5 ✅ · Phase 2 7/7 ✅ · Phase 3 6/6 ✅ · Phase 4 — 4.0 ✅ 4.1 ✅ 4.2 ✅ (all four gates in the
hook), 4.3: #1 editor BUILT (regression being fixed), #2 top bar BUILT, #4 completeness BUILT, **#3 bullets and #5 the AAA sweep NOT
built** (plans ruled: A-46/R-55/R-56 with BL1's phase-1 file; A-51/R-65/R-66 with AA1's plan).

**Open right now:**
1. ✅ **E1's regression FIXED** (`48bdcfb68`; the test's AG import moved behind an engine seam, `a9bae2b62`). 🔴 **A push was
   started at 12:03 UTC 2026-09-24 by the old session** — the new session checks `git fetch` + `origin/pes/phase-0`; if it is still
   `a80a3044e` and no push is running, push again. That push must show the 36 `=` keys GONE.
2. The browser gates' blind spots: editor-open 20 baselined keys (AMAZON·IT contract rows may now be measurable — the next run shows
   "gone"); census now fully green (7 gone).
3. Then: build #3 bullets (BL1 phase 2, plan folded into PLAN.md as **A-52**) and #5 the AAA sweep (A-51: 11 token edits in `tokens/css-vars.ts` + `colors.ts`, web AND factory, `npm run tokens:gen` +
   `tokens:gen:factory`, `grid/spec.json:14,19` stripFg, new hover values + a hover check, the hook's contrast ratchet → 0 / 0).
4. After the Owner's merge: `node docs/product-cheat/tools/prod-run.mjs content-drift` (read only) and the first nights' CronRun lines
   (content-drift, readiness — A-50 will lower non-Italian readiness % to the true value).

**Session lessons (this handoff):** 🔴 `open(p,'w').write(open(p).read()+x)` EMPTIES the file first — PLAN.md was cut to 101 lines
three times and repaired from the pushed text (always read into a variable first; `git diff --numstat origin/pes/phase-0 --
docs/product-cheat/PLAN.md` must show 0 deletions). The browser gates must not change the shared local database (the runner's API
runs with `NEXUS_AMAZON_ENV_TOKEN=off`). A UI push through the gates takes ~40 min; lanes must not edit files while a push runs.
Sub-agent lanes (R-44): disjoint files named in `docs/pes-claims.md`; shared DS files (CHANGELOG, DS-GAPS, catalog, barrels) are
edited only by the main session from the lanes' patches.

### Where this lane stands — handoff 6, 2026-09-24 11:34 UTC (history)

**Branch `pes/phase-0`; `main` still `0a563d6d5` (NOT deployed; the Owner merges).** Since handoff 5 (rulings R-63 … R-64; A-49, A-50):
- **Step 4.3 #1, #2, #4 BUILT** in three parallel lanes + an integrator: **one text/number editor** on every scope (R-63), a letter never
  wipes a number (R-47), one hint line (R-48) · **the top bar**: scope + language dropdowns, filters always folded, Shared "See each
  channel" (R-51…R-53), and a `ListboxPanel` Enter bug proven + fixed · **completeness**: the readiness card names the empty required
  fields with "Go to", "Filled (all fields)" (A-45, R-54). Non-browser push stages all green (web 4,692 · api 11,540 · builds · tsc 0).
- **A-50 fixed (R-64):** a source-language fallback no longer counts as filled on another language — production readiness % will
  drop to the true value after the next nightly once merged.
- **Gates:** the runner no longer rewrites the local Amazon env connection (`NEXUS_AMAZON_ENV_TOKEN=off`); an eBay "needs
  reconnecting" footer is a blind spot, not a defect. 🔴 A PLAN.md truncation (a Python `open(p,'w')` before read) was found and
  repaired from the pushed text — see "A PLAN.md loss, found and repaired".
- **Not yet browser-measured:** the new editor/top-bar/card UI — the next push's browser gates are its first measurement.

**Next:** the push (all gates) · Step 4.3 #3 bullets in one cell (A-46, R-55/R-56; needs E1's editor — now in) · #5 the AAA sweep
(lower the contrast ratchet; the amber chip first) · after the merge: `prod-run.mjs content-drift` (read only) + the first nights'
CronRun lines. Still the Owner's, for the end: 0.3; listing content data (R-34).

### Where this lane stands — handoff 5, 2026-09-24 09:45 UTC (history)

**Times are UTC (`date -u`). Branch `pes/phase-0`; `main` still `0a563d6d5` (NOT deployed). The Owner merges.** The next merge ships
three additive migrations (`20260923a`, `20260923b` — and the channel lane's `20260922a` is already on production).

**Since handoff 4 (rulings R-42 … R-62 at the end of PLAN.md):**
- **Step 2.7 CLOSED** (02:35 UTC verify): the first nightly after the deploy ran to `stopped: complete` for both businesses; every live
  product has a fresh row. Step 2.6's day-after check ✅ (legacy `va` 35 / 44, not grown).
- **Step 3.5 complete:** 3.5a + the eBay quantity slice + A-39 b1 (Amazon content, nightly) + A-40 b2 (eBay content, 13 studio ItemIDs;
  shells "not compared" for good — Nexus never writes a live shell's title/specifics). **Step 3.6 CLOSED** by a browser check
  (a refused cell keeps the typed value, marked "not saved" — noted for the Owner).
- **A-41 fixed:** the studio eBay publish was refused for every family since 09-21 (no currency). **R-58** master bullets capped at the
  tightest channel cap; **R-60** the sheet's content saves are per row (other callers keep all-or-nothing).
- **R-42:** no single-SKU eBay item exists on production (31 ItemIDs, all multi-variation) — that unpublish path cannot be proven live.
  eBay's Trading pool: 5,000 calls/day (GetApiAccessRules is retired, HTTP 410).
- **Phase 4 STARTED (R-44: parallel sub-agent lanes allowed; R-45: the gates come back):** Step 4.0 BUILT (`check-nds-contrast.mjs`,
  baseline 49/90 below 7:1, 10 below 4.5:1; R-49 strict 7:1 for all text). **Step 4.2: all four gates in the hook** — the contrast
  ratchet + the three browser gates (fixed; a write guard that sees the proxy; own servers; a ratchet; ~20–26 min on a UI push, R-61).
  Plans ruled: **A-42** EditorShell step 1 (R-47 number-cell fix, R-48 one hint line) · **A-44** top bar (R-51 scope dropdown too,
  R-52 filters always folded) · **A-45** completeness column (R-53 "See each channel", R-54 "Filled (all fields)") · **A-46** bullets
  in one cell (R-55 Tab between bullets, R-56 one cell by default).

**Next, in order:** push (runs every gate, ~40 min) · build Step 4.3 #1 the EditorShell (A-42) behind the editor-open gate · #2 the top
bar (A-44) · #3 bullets (A-46) · #4 completeness (A-45; 2.7 is closed, so it may build) · #5 the AAA sweep last (lower the contrast
ratchet as it lands; the amber chip first). After the Owner's merge: `node docs/product-cheat/tools/prod-run.mjs content-drift`
(read only) and the first night's `content-drift` CronRun line.
**Known blind spots:** the browser gates cannot see Amazon scopes locally (the local Amazon account is disconnected) — 25 baselined keys.
**Still the Owner's, kept for the end:** 0.3; listing content data (R-34).

### Where this lane stands — handoff 4, 2026-09-23 ~21:35 UTC (history)

**Times in this section are UTC, measured with `date -u`.** Handoff 3's "2026-09-24 ~01:30" was not UTC (its commit
`f4c90dd19` is 20:09 UTC on 09-23).

**Branch `pes/phase-0`. NOT deployed:** `main` is still `0a563d6d5`. The next merge to `main` (the Owner's) ships A-30, A-32,
A-33, 3.5a and everything below, with **two additive migrations** (`20260923a_channel_drift`, `20260923b_channel_drift_checked_by_source`).

**Done this session (rulings R-38 … R-41 at the end of PLAN.md; all four closure fields in each section):**
- **R-38** — SCT.6 offer close + verbatim replay proven LIVE on `xracingbxn48` Amazon·IT (channel only, no Nexus row written;
  both `ACCEPTED`; offer absent ~30 s; re-read equal at ~1, 2.5, 3.7 min). The read found this SKU's DE offer closed by the SCT.6
  pilot since 2026-07-26. Tool `tools/sct6-close-probe.mts`. `f7bd4b085`.
- **Step 1.3 BUILT (R-39)** — `65e1d9c0a`. The only producer of unpublish is the hard delete, so there is no republish.
- **Step 3.5 eBay slice BUILT (R-36)** — `298364359`. The list hides eBay shells; the filter now reaches through them.
- **A-39 / Step 3.5b slice b1 BUILT (R-41)** — `22ed2676b`. 🔴 The job is ON with the next deploy (03:37 UTC nightly, reads only).
- **R-40** — the Owner: *"do all the running of the commands yourself."* This lane runs the read-only production tools.
- Work ran as three-plus sub-agents with disjoint files (the Owner asked for 2–3); this session verified and committed each.
- `axis-stores.mjs` mid-way (21:09 UTC): legacy `va` sizes **35** (not grown), colours **44**; store 301 / 285.

**Running when this was written:** a background wait that runs `readiness-age.mjs` + `axis-stores.mjs` at **02:35 UTC
2026-09-24** (output in this session's scratchpad). If this session is gone, the next one runs both itself (R-40) and records
them: Step 2.7 closes if both businesses show `readiness-reconcile` SUCCESS, `stopped: complete`; legacy `va` must stay ≤ 35 / 44.

**Waiting on the Owner:** the merge to `main` (then the migrations apply) · the one-minute paste check by hand (A-34).
**Next, in order:** record the 02:35 runs · after the merge: `node docs/product-cheat/tools/prod-run.mjs content-drift` (read only)
and the first night's `content-drift` CronRun line · A-39 slice b2 (eBay content — needs one read of the eBay daily call limit) ·
eBay single-SKU unpublish never run live. R-34: listing CONTENT writes stay LAST. Not this lane's: Phase 4, `docs/listings/`, flat files.

### Where this lane stands — handoff 3, 2026-09-24 ~01:30 [not UTC — 20:09 UTC 2026-09-23] (history)

**Branch `pes/phase-0`, all pushed. NOT deployed:** `main` is still `0a563d6d5`. The branch = `main` + everything below.
The next merge to `main` ships A-30, A-32, A-33 and Step 3.5a, including one **additive** migration
(`20260923a_channel_drift`, a new table).

**Closed or built since handoff 2 (all four closure fields, mutation-proven, rulings R-27 … R-37 at the end of PLAN.md):**
A-31 (CI red: price-door tests) · A-30 (nightly readiness: oldest first + the dry run counts) · Step 3.1 (both doors OPEN on
production, read only) · **Step 3.4 (the first live write + read-back, restored)** · Step 3.2 CLOSED (M1–M4 + the
sheet↔payload gate) · Step 3.3 CLOSED (A-33: one serializer for both Amazon payload builders) · A-32 (production counted:
25 Amazon·DE Italian titles, 21 live; the publish preview names them) · A-34 (3.6 re-scoped; server gate built; the browser
check COULD NOT MEASURE) · **Step 3.5a (ChannelDrift table, one writer, Amazon + Shopify feed it, "Differs on the channel"
filter, old filter renamed "Has overrides")** · A-37 (quantity-0 unpublish proven live on eBay + Amazon and restored).

**Waiting on the Owner:**
1. **A-38** (for approval): Step 1.3's Amazon half already exists as SCT.6 per-market offer close/reopen
   (`amazon-market-offer.service.ts`); recommended: build unpublish on SCT.6 (Amazon) + proven quantity 0 (eBay), after one live
   SCT.6 close/reopen.
2. **After 02:17 UTC 2026-09-24:** `node docs/product-cheat/tools/readiness-age.mjs` (closes Step 2.7 if both businesses show
   `readiness-reconcile` SUCCESS, `stopped: complete`) and `node docs/product-cheat/tools/axis-stores.mjs` (legacy `va` must not grow).
3. The one-minute paste check by hand (A-34). The merge to `main`. Two pending migrations on the LOCAL database
   (`20260922a` from the channel lane + `20260923a`) — not applied by this lane.
4. **R-34: listing CONTENT work comes LAST** (the 25 DE titles, AIREON's per-channel colour — R-27). Do not raise it earlier.

**Next, in order:** A-38's build once ruled · Step 3.5b (content reads, rotating, on the resumable sweep — needs an amendment)
· the eBay drift slice (its read-back diffs per product across shared SKUs) · Phase 4 is not this lane's.

**Session rules learned (this handoff):** the safety check ALLOWED read-only production tools and live channel writes once the
Owner ruled in the chat (R-30, R-33, R-35, R-37); each live write: read → preview → write → read back → restore → delayed
re-read. 🔴 Amazon EU merchant quantity is ONE number for all EU markets — a quantity-0 test on one market pauses the SKU
EU-wide (it happened, ~90 s, restored); per-market stops use SCT.6. FBA quantity is never touched. A schema change also needs
`packages/database/scripts/generate-baseline.mjs` (the push hook's baseline test). The push hook takes ~15 min; AE.4 may flake
once. Tools for this lane live in `docs/product-cheat/tools/` (`*.mts` run with `npx tsx` from the repo root or `apps/api`).

### Where this lane stands — 2026-09-23 ~11:00 (history)

**Housekeeping done.** The two handoff commits pushed (every gate green). `origin/main` (`0a563d6d5`) merged into
`pes/phase-0` as `06b2bc485`: the merged tree is `main` plus `PROGRESS.md` only.
**Vercel:** ✅ `0a563d6d5` deployed to Production. 🔴 **GitHub CI #4162 on it is red** — [A-31](PLAN.md) (two of this
lane's test files need a real database at load).
**Step 2.7:** A-30 BUILT under R-28 (oldest first; the dry run counts). ⏳ Closes on the verify after the 02:17
nightly on 2026-09-24: the Owner runs `node docs/product-cheat/tools/readiness-age.mjs` (read only; the session's
safety check refuses it). **A-31 BUILT** under R-29 (CI's red step passes here; `main` turns green at the next merge).
**A-29:** ruled R-27 — AIREON waits for a per-channel colour name; do not publish it to Amazon until then.
**Still to do:** re-run `tools/axis-stores.mjs` after a day (2026-09-24): the legacy `va` counts must not grow.

### Where this lane stands — handoff 2, 2026-09-23 ~09:00 (history)

**DEPLOYED.** `pes/phase-0` was merged with `main` in a separate worktree and pushed to `main` by the Owner:
`main` = **`0a563d6d5`** ("merge: main into pes/phase-0 for its deploy"). Railway deploy `7cdbe141` **SUCCESS 06:46 UTC**
(health check passed; the only error lines are the old pg SSL warning and `[fleet-workflow] clock resync failed`, which
the previous deploy had too). Vercel deploys from `main` on its own — **not checked** from this session.

**Closed today (all pushed, all four closure fields, mutation-proven):** Step 2.6 (a, b, c1, c2, c3, d — one store
for a child's size/colour, R-23/R-24/R-26) · A-28 (R-25) · Step 2.1 (b) on production for both businesses (Xavia 5 rows;
Motovento 0). Production data runs done **on the Owner's authorisation**: 2.6d fill (78 products, record in
`docs/product-cheat/records/`, `prod-run.mjs fill-axes --revert <file>` undoes it).

**Open, in order:**
1. 🔴 **Step 2.7's premise changed — MEASURE before any write.** Production already holds **9,886 `ReadinessIndex`
   rows** (the plan said 0). `prod-run.mjs backfill` dry run: `9886 → 9886`, nothing due, no count of stale families
   printed. Unknown: when those rows were computed and whether the deployed nightly sweep (15.1) recomputes them under the
   new rules. The read-only age check was stopped by the Owner before it ran — ask before re-running it. Likely outcome:
   Step 2.7 becomes "verify the nightly sweep ran", not a one-shot — an amendment for the Owner.
2. **Post-deploy checks:** re-run `tools/axis-stores.mjs` after a day — the legacy `va` counts must not grow (only the
   two flat-file creates still write it); confirm the Vercel deploy of `0a563d6d5`.
3. **A-29** (AIREON colour: store holds eBay's `Nero Neo | Giacca`, Amazon says `Nero Neo`): RULED — a per-channel value
   name as its own later step; **do not publish AIREON to Amazon until then.** Nothing was sent.
4. **Git housekeeping:** the shared tree's `pes/phase-0` has one unpushed docs commit (this handoff) and does NOT contain
   the merge — merge `origin/main` into it (or fast-forward) before new work. The deploy worktree
   `/private/tmp/nexus-product-cheat-deploy-20260923` (branch `deploy/product-cheat-20260923`, own `node_modules`, a
   placeholder non-local root `.env` for the R-VT-12 guard) can be removed with `git worktree remove` once not needed.
5. Still blocked: 1.3 / Phase 3 on 3.1 (credentials); 0.3 (rotation) is the Owner's — do not raise it. Deploy checklist
   left: the 256 DE/ES Amazon stock rows marked sent for Italy (needs 3.1). Unruled: D-F, D-G, the third readiness
   vocabulary.

**Session rules learned today:** this session's safety check blocks production access and deploys unless the Owner
authorises in the chat; even then, a push to `main` and the merge commit leading to it were refused — the Owner ran
those two commands. A real-database gate belongs on `formulaDatabase()` unless it tests a race (3 `concurrentDatabase()`
files overflowed the local lock table). `AXIS_SYNONYM_GROUPS` has a no-touch flat-file mirror + parity test.

### Where this lane stands — handoff, 2026-09-23 (read this first)

**Branch `pes/phase-0`, everything pushed. Nothing merged or deployed; no production write by this lane.**

**Closed in the 09-22 session (all four fields, mutation-proven, pushed):** Step 2.2 (parts 1–2, Gate 2,
A-17 `expectedPrice`) · Step 2.3 (R-18: one-language paths refuse a multi-language market) · Step 2.4
(move 2: the family decides Shared's columns, editor and grid) · Step 2.5 (R-22: a choice list cannot be
per-language). Also fixed: **A-23** the cockpit no longer sends unknown markets to Amazon Italy;
**A-24** 🔴🔴 every Amazon queue push was built for Italy — the listing now decides the market.
Rulings R-11 … R-22 are at the end of PLAN.md.

**Open, in order (updated 2026-09-23):**
1. ✅ **2.1 (b) APPLIED on production (Xavia Racing, 5 rows, verified).** Earlier text: **the Owner said OK; Xavia Racing dry run DONE and reviewed** (5 rows, the
   same 5 families as local; `0 already required`, so `--revert` undoes exactly these). Next, run by the
   Owner: `node docs/product-cheat/tools/prod-run.mjs derive --workspace bf0047bf-e1d9-48d0-8cc6-20e94bb734dd`
   (Motovento, dry run), then `… derive --apply` (expect `WROTE 5 rows`, and `now: 5`). The agent's
   session cannot reach production. The launcher refuses any non-Neon host, points Redis at a dead port,
   and turns business profiles on.
2. **Step 2.6 — D-D RULED (R-23 (a)): `categoryAttributes.variations` is the one store. The build is
   A-27, APPROVED (R-24) and in progress** (four slices; 2.6a first — the `xracing` family shows the live
   defect: a sheet size edit lands where no publisher reads). Four stores, not three; production has no
   colliding variants; one wrong value (`AIR-MESH-JACKET-MEN-XXL-BLACK`). Count tool:
   `node docs/product-cheat/tools/axis-stores.mjs` (`--local` for local).
3. **2.7 on production — R-21: after this branch deploys** (`tools/prod-run.mjs backfill`, dry run first). The deploy is
   the next step: see the deploy checklist (R-22 ✅; merge measured).
4. **Deploy checklist (before this branch is deployed):** count `CustomAttribute` rows with type
   select/multiselect AND `localizable` on production (R-22 would stop showing their per-language values);
   the **256** DE/ES Amazon stock rows marked sent for Italy on 2026-09-08 — check Amazon IT stock for
   those SKUs once Step 3.1 opens the credentials; Amazon BE (two languages) stays refused on the two
   one-language paths until its first listing.
   **Measured 2026-09-23 (read only, on the Owner's authorisation):** ✅ R-22 — production holds **0** per-language
   choice lists (1 choice list in all), so nothing stops showing. The branch adds **no migration**. It is **77 commits
   ahead of `main`, 25 behind**; a merge has **2 conflicts**, both Amazon test files (`amazon-validation-preview`,
   `amazon-classifications`) that `main`'s channel-connections lane (`a05f3792f`) and this lane (A-8) fixed for the same
   cause in different ways — take `main`'s isolated fixtures and re-run. 🔴 A push to `main` deploys production for
   every lane, and that lane pushes to `main`: the merge is coordinated by the Owner, and done outside this shared tree
   (a separate worktree) so no other session's files move.
   **Deploy prepared (2026-09-23), waiting for the Owner's two commands** — this session's safety check refuses a
   push to `main` (production deploy) and the merge commit that leads to it. In the separate worktree
   `/private/tmp/nexus-product-cheat-deploy-20260923` (branch `deploy/product-cheat-20260923`): `main` merged in, the two
   Amazon test conflicts resolved with `main`'s version (staged, not committed), `npm ci`, the three workspace packages
   built, local-only env files copied (never the production root `.env`; a placeholder non-local root `.env` so the
   R-VT-12 guard test can prove refusal), full `apps/api` suite green there. The Owner runs:
   `git -C /private/tmp/nexus-product-cheat-deploy-20260923 commit -m "merge: main into pes/phase-0 for its deploy"` then
   `git -C /private/tmp/nexus-product-cheat-deploy-20260923 push origin HEAD:main` (every gate, then the deploy).
   **Step 2.6 (a–c2), added 2026-09-23:** read and write paths only, no migration. After deploy, re-run
   `tools/axis-stores.mjs` (read only): the legacy `variantAttributes` key counts (`SPELLINGS … va`) must not
   grow any more — only the two flat-file creates still write it — and the store (`vr`) is where new values
   appear. The one child with an empty flat `size` key will show its stored size on the sheet.
5. Blocked, not forgotten: 1.3 / Phase 3 on 3.1 (credentials). 0.3 (rotation) is the Owner's — do not
   raise it. Unruled: D-D, D-F, D-G (15.9's flip), the third readiness vocabulary. Step 4.0: read the
   review (`PLAN-REVIEW-2026-09-22.md` §4) first — `check-contrast.mjs` measures the wrong palette.

**Read-only production checks** the Owner can run (each one `BEGIN READ ONLY`, refuses non-Neon hosts):
`tools/family-count.mjs`, `tools/market-languages.mjs`, `tools/amazon-market-history.mjs`,
`tools/axis-stores.mjs` (Step 2.6 / D-D). 🔴 Creating a new production-reading tool needs the Owner's
word first — the session's safety check refused it until the Owner authorised it (2026-09-23).
`--local` on any of them is a dry run against `nexus_development`.

**The push hook is flaky under machine load** (≈10 sessions share it): the web-font build error, AE.4
`assortment/sync`, and 10 s timeouts in otherwise ~1.5 s tests. A retry that re-runs every gate is fine;
**never `--no-verify`**. Three PGlite suites got a named budget; more will need one (note for the
vitest-config owner above).

**Standing execution rules:** one lane, one commit per step group, never `--no-verify`, push when
green. A step closes only when **Done when / Cost when / Gate / Rollback** all pass. Prove each
gate can fail, including both arms when the code has two paths. Verify `file:line` rather than
trusting a plan sentence. Any new defect or better approach goes into a PLAN amendment for Owner
approval **before building**. Each turn reports what changed, whether it worked, and what is next.

### Two rulings remain open. Raise them only when needed.

| # | What | Recommended |
|---|---|---|
| **D-E** | Run the readiness reconcile on **production**. It is a live write | read 2.7's re-check below first |
| **Step 2.1 (b) on production** | The 5-row mirror ran on the local database only. Same script, same ruling, a different database | yours to authorise |

### The build queue

1. ✅ ~~**Step 2.2, part 2 — the sheet's price bypass.**~~ Built under R-11.
2. ✅ ~~**Step 2.2's concurrency gate**~~ — built; a forced race on `concurrent-database.ts`.
3. ✅ **A-17 (R-12)** — `expectedPrice` retry built. **Step 2.2 CLOSED.**
4. ✅ **Step 2.4 move 2 (R-14)** — closed for the editor; the grid states *"N without family"*.
   ✅ **Step 2.4b counted on production** (read only, run by the Owner): nothing to assign — the 18
   Xavia Racing parents without a family are all eBay listing shells; Motovento has one unlisted
   draft. ✅ **R-16 (a): shells are not a missing family; the grid flip is BUILT. Step 2.4 CLOSED.**
5. 🟡 **Step 2.7 (R-15)** — ordering rule struck. D-E (the production run) stays the Owner's;
   count production roots first.
6. ✅ **Step 2.3 — CLOSED (R-18)** with a stated limit: the two one-language paths refuse a
   multi-language market. ✅ **A-23** (cockpit → Italy) fixed under R-19.
7. ✅ **Step 2.5 — CLOSED (R-22).** Next: **2.6** (needs D-D).
8. 🟡 **2.1 (b) on production — OK given; Xavia Racing dry run done (5 rows); Motovento dry run and
   `--apply` next** (`tools/prod-run.mjs derive`, run by the Owner). **2.7 on production — R-21: after
   this branch deploys.**
9. 🟡 **Step 2.6 — D-D ruled (R-23 (a)); A-27 approved (R-24).** ✅ 2.6a, 2.6b, 2.6c-1 (readers) and 2.6c-2 (one writer) built and pushed. c3 (one synonym table) waits for the Owner's
   production count (`tools/axis-stores.mjs`, `AXISNAMES` lines): locally every spelling in use is classified the same by
   both tables; adding `talla` / `groesse` to the eBay table re-keys any saved order that uses them. ✅ A-28 built (R-25).
   ✅ c3 built (R-26). ✅ 2.6d built; **Step 2.6 closes after the Owner's production run** — `node docs/product-cheat/tools/prod-run.mjs fill-axes`
   (dry run: 78 products, 77 + 77 fills, 1 drop), then `--apply` (0 left), then `tools/axis-stores.mjs` (store colour 301, size 285).

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

**Traps measured the hard way, 2026-09-22 (third session — this lane's continuation)**
- 🔴🔴 **On real PostgreSQL a price is a Prisma `Decimal`.** The bulk editor's generic `same()`
  compares objects by `JSON.stringify`, so `Decimal(10)` never equals `10`. A mocked row with a plain
  number says "no-op"; the real database says "write". A fix that "restored" a no-op from a mocked
  test would have changed real behaviour. Check the type the real row carries.
- 🔴 **The sheet saves inside a Serializable transaction that retries `P2034` twice**
  (`lib/database-context.ts:59-83`). A blocked write logs *"write conflict or a deadlock"* and the
  whole save re-runs with the caller's original version. That log line is the retry, not a failure.
- 🔴 **The profiles-ON ratchet names a failing file but prints no error.** Twice this session it
  refused a push for a file that passed alone (`data-validation` "fails to load";
  `catalog-transfer-http` "1 failing"). Re-run it with `--reporter=json` to read the message.
  `catalog-transfer-http` did not reproduce in 2 full runs, under CPU load, or alone; a second push
  went green. Cause unknown — recorded, not explained.
- 🔴 **Two more one-off hook refusals, both outside this lane, both green on the next push:**
  the `apps/web` build (`next/font/google queries have exactly one entry` on JetBrains Mono — Google's
  CSS was normal when checked), and `run-real-postgres-tests.mjs` → AE.4 `assortment/sync` 13/14
  (passed alone twice; that suite never calls the price code; the runner prints no test name, and
  its test 13 asserts a p95 latency under 5 s). The hook builds the WORKING TREE, and these runs
  share the machine with the full suite.
- 🔴 **Both of those then failed a SECOND time** (web build 2 of 4, AE.4 2 of 5 hook runs). AE.4
  passed **5 of 5** isolated runs of the full runner (3 idle, 2 with every core loaded). 🔴 **The
  runner hides the failing test's name:** on failure it prints the first 40 lines matching
  `Error:`, and `[ioredis] Unhandled error event: AggregateError:` fills all 40
  (`scripts/run-real-postgres-tests.mjs`, the last `console.error`). Not this lane's file — a
  one-line filter fix for its owner. Neither is caused by this lane's code; neither is explained.
- 🔴 **PGlite suites need a named load budget.** They start in-process on one connection; under the
  hook ~1.3–2 s alone becomes >10 s. `formula-database` and `data-validation` got one (`c4cb6fe71`),
  then `information-database` refused a push the same way (`721788ab8`). 🟠 **Most of the other 24
  PGlite suites budget only their SETUP** (60–180 s) and leave each test at vitest's 10 s default,
  so this will recur one file at a time. For the owner of `apps/api`'s vitest config: one per-test
  budget for the PGlite files would end it. Not changed here — shared config, not this lane's.
- 🔴 **A probe script with `REDIS_URL=redis://127.0.0.1:1` never exits** — the retry loop keeps the
  process alive, and a pipe hides all output until exit. End with `process.exit(0)` and write to a
  file.
- 🔴 **The shell has no `DATABASE_URL`, and the ROOT `.env` is production.** A probe must read
  `apps/api/.env` explicitly and refuse any host that is not `127.0.0.1` before it connects.
- 🔴🔴 **`zsh` does not word-split `$VAR`.** `FILES="a b c"; for f in $FILES` loops ONCE over the
  whole string: a multi-file backup loop copied nothing, every restore failed, and
  `md5 -q $FILES | diff - saved` compared two identical errors and printed `RESTORED_OK` — three
  files stayed mutated. Use a Python harness with per-file backups and a hash check that cannot pass
  on an error (`scratchpad/mutate18.py` pattern).
- 🟢 **Measure a writing job without writing:** wrap it in your own `inDatabaseTransaction`, read the
  result inside, then throw. Nested calls join the outer transaction. Control: the row count and
  newest timestamp before and after (A-21).

**Traps measured the hard way, 2026-09-22 (second session — the entries not repeated below)**
- 🔴 **`readSaleWindows` returns a MAP.** `Object.assign` to merge chunks type-checks and merges
  nothing. The symptom was a re-submit reading as a change, only above 500 rows.
- 🔴 **`process.exit(0)` after an unawaited `main()`** prints nothing and exits 0, having done
  nothing. A silent success.
- 🔴 **Importing a script RUNS it.** `seed-marketplaces.ts` had a module-scope `main()`; the import
  seeded a database and then killed the importer mid-write with an unhandled rejection.
- 🔴 **Prisma's `groupBy` argument type is conditional** — a spread `where`, or annotating the
  `await`, reports a circular reference. Two explicit calls, or map then annotate.

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
- ✅ ~~**`mapping/formula-database.vitest.test.ts` is FLAKY**~~ — **fixed `c4cb6fe71`** with a named
  30 s load budget: the test that timed out takes ~1.7 s alone and >10 s under the hook.
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
