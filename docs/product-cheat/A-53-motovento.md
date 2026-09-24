# A-53 — Motovento: the studio waits forever for a market — BUILD RECORD

The plan is `PLAN.md` § "A-53" (commit `9a6efc1da`). This file is the build record. `PLAN.md` stays the
R-11 lane's; this file was released to the A-53 session (`docs/pes-claims.md`, MV1 row).

## Owner ruling — Q1 (2026-09-24, in the chat)

**Q1: how does Motovento get its markets? → a data MIGRATION, per ROW.**

- The migration adds any catalogue market that a business does not have. It never changes a row that
  exists. This is the same rule as the create-only `POST /marketplaces/seed` (step 2b), so the two paths agree.
- The plan's alternative filled only a business with **zero** rows. The Owner chose the per-row rule
  (the "enterprise" pattern: reference data kept in code, synced to every business by a repeatable,
  create-only migration). On production today both rules give the same result: Motovento +20, Xavia +0
  (Xavia already holds all 20 — measured below).
- That answer is the Owner's word for this one production write (it runs with the deploy).

Also asked by the Owner: "load all markets when new profiles or new accounts are connected?" Answer given:
new profiles — yes, step 2c. New accounts — no separate hook: markets belong to the business, and the
connect flow already discovers which markets an account sells in (`ConnectionScope`, `amazon-sp/spec.ts`
`discoverScopes`) and matches them to the business's `Marketplace` rows.

## Corrections to the plan text (measured 2026-09-24, production READ ONLY)

- **§4 2a says "BE (`nl, fr`), IE, TR, and US inactive, as on Xavia".** Only **US** is inactive on Xavia.
  BE, IE and TR are **active**. (20 rows, 19 active — the plan's own count agrees with this reading.)
- `packages/database/scripts/seed-marketplaces.ts` carries **17** rows (no BE, IE, TR); the route carried 17
  with no VAT. The catalogue is Xavia's 20.
- Migration role `neondb_owner` has `BYPASSRLS = true`; `Marketplace` has `FORCE ROW LEVEL SECURITY` and one
  policy (`nexus_workspace_isolation`, role `nexus_workspace_runtime` only). So the migration can insert for
  every business; `Marketplace.id` has **no database default** (Prisma's `cuid()` is client-side), so the SQL
  must write an id.

Probe: `c1.sql`, `c2.sql` with MV1's `ro.cjs` (BEGIN READ ONLY … ROLLBACK, `TZ=UTC`, host `*.neon.tech`), in
this session's scratchpad `a53/`.

## Build log — 2026-09-24, BUILT (steps 1, 2 and 3), committed; pushed by the R-11 lane's one push

### Step 2 — every business gets its markets (API)

- **2a. One catalogue:** NEW `apps/api/src/services/pim/market-catalogue.ts` (pure) — Xavia's 20 production rows,
  reference columns only, VAT included. Every writer reads it:
  - `routes/marketplaces.routes.ts` — its own 17-row list (no VAT, no BE/IE/TR) is deleted.
  - `packages/database/scripts/seed-marketplaces.ts` — its 17-row list is deleted; it re-exports the catalogue as
    `MARKETPLACES` (the 15.11 scale fixture reads that name; probe: 20 rows, PL→PLN), and its `main()` is create-only.
  - `apps/api/scripts/check-market-currency.mjs` — the seed exemption moved to the catalogue file; its reason check
    now also requires TR→TRY.
- **2b.** `POST /api/marketplaces/seed` is create-only: `createMany({ data: catalogue, skipDuplicates: true })`,
  returns `{ success, created, total }` (was `{ success, upserted, total }`; no caller in `apps/web`). Permission
  unchanged: `channels.sync` (manifest `pfx('/marketplaces')`), pinned by a test.
- **2c.** `workspace.service.ts` `create()` writes the catalogue in the creation transaction, after `accountSettings`.
  `createMany` takes `workspaceId` from the transaction's business — proven on the real database, profiles ON and OFF.
- **Found while building (not in the plan):** `POST /products/:id/publish-preflight` read the deleted static list to
  decide "No marketplace mapping for AMAZON/<market>". The publish route itself reads the business's own row
  (`configuredAmazonMarketplaceId`). The preflight now makes the SAME lookup, so it predicts the publish. Effect: a
  business with Amazon BE/IE/TR rows (Xavia) no longer sees a false "no mapping" for them in the preflight; a row with no
  `marketplaceId` is now reported, as the publish would refuse it.

### Step 3 — Motovento (Owner ruling Q1: migration, per row)

NEW `packages/database/prisma/migrations/20260924a_a53_market_catalogue_backfill/migration.sql`: one
`INSERT … SELECT … FROM "Workspace" CROSS JOIN (VALUES <catalogue>) WHERE status = 'active' ON CONFLICT
("workspaceId", "channel", "code") DO NOTHING`. `id` = `gen_random_uuid()::text` (the column has no default).
**NOT applied to the local database** (the R-11 lane's browser gates use it). It runs on production with the deploy.

### Step 1 — one honest "no market" state (web)

- NEW `_studio/marketGate.ts` (pure): `marketGate` → `ready | failed | none`; the chip sentences; `setUpMarkets`.
- NEW `_studio/NoMarketState.tsx`: DS `EmptyState` + `Button`, centred with the frame's existing `.centered` class; no new
  CSS, no DS change, so no factory mirror. `NoMarketView` is the pure render; `NoMarketState` wires it.
  - `none` → "This business has no markets yet" + **Set up markets** (with `channels.sync`), else "Ask an owner…".
  - `failed` → "Markets could not be loaded" + **Try again** (the frame's discovery re-read).
- The three "Waiting for the market…" lines (`ProductSheetTab.tsx`, `MatrixTab.tsx`, `FamilyVariants.tsx`) now render
  `<NoMarketState />` under the SAME condition (`!market || !locale`), so a business with markets renders exactly as before.
- `contracts.tsx`: when the resolved market is absent, the readiness chip's reason is the gate's sentence
  ("No market is set up for this business." / "Markets could not be loaded."). A scope error or an unready destination
  keeps "No market selected."
- **Deviation from the plan text:** a refused set-up does not use `StudioReadError`'s wording for 403 and 5xx — that
  class speaks of "this product" and "loading". 403 → "You do not have permission to set up markets for this business.";
  5xx → "Nexus could not set up the markets. Try again in a moment."; 401/429/server sentence → the studio's usual text.

### Tests (all green)

| File | Arms |
|---|---|
| `apps/api/src/services/pim/market-catalogue.vitest.test.ts` | 7 — equals the production snapshot (`market-catalogue.production-2026-09-24.json`), unique keys, languages, VAT on 16 EU rows, SE/PL/TR currency, 19 active, fresh copies |
| `apps/api/src/services/pim/market-catalogue-backfill.vitest.test.ts` | 3 — PGlite, four businesses: EMPTY +20 (row for row = catalogue), PARTIAL +17 with its 3 own rows untouched, ARCHIVED +0, LEGACY (whole, one row edited) unchanged; second run changes nothing |
| `apps/api/src/services/workspace.vitest.test.ts` | +1 — creation gives 20 (19 active), `EBAY:IT` VAT 22, isolation between two businesses, replay adds none; profiles ON and OFF |
| `apps/api/src/routes/marketplaces-seed.vitest.test.ts` | 6 — permissions; **reproduction** (0 rows → only `_meta`, as production); seed 20 then 0, other business untouched; an own row is never rewritten (19 created); profiles OFF → legacy; the preflight reads the business's row |
| `_studio/marketGate.vitest.test.ts` | 11 — the four gate cases, reasons, set-up success/refusals, source scan of the three tabs with a positive control |
| `_studio/NoMarketState.vitest.test.ts` | 7 — every rendered state (SSR) |

**Mutations — 16 of 16 red, every file restored by hash:** gate ready with no market · failed/none swapped · the waiting
line back in `MatrixTab` · no re-read after set-up · button without `channels.sync` · creation writes no markets · seed
without VAT · seed route upserts again · creation seeds another business · PL dropped · migration without `ON CONFLICT` ·
migration fills only empty businesses · migration fills archived businesses · migration VAT drifts · preflight reads a
static list again · the currency gate no longer scanning the catalogue.

**Gates run on this tree:** web tsc 0, api tsc 0; web `_studio` vitest 146 files / 1,967 passed; api: the 29 files near
the change, profiles OFF 27 passed + 2 skipped, profiles ON the same except `variation-quality.vitest.test.ts`, which is in
`profiles-on-baseline.json` ("suite", "Select a business profile." — unrelated); `@nexus/database` tests 17/17; schema and
column drift, model ownership (447), policy parity, i18n, link targets, DS conformance, raw primitives, silent-disabled,
button vocabulary, help cursor, route-prisma (no file rose), context boundary, global exposure, market languages (0 new),
market currency, api-guard, RBAC coverage (0 unmapped) — all exit 0. The browser gates and the full suites run in the
R-11 lane's one push.

### After the deploy (predictions, written before it)

- Production read: Motovento `Marketplace` = 20 rows, 19 active, `EBAY:IT vatRate 22.00 taxInclusive true`; Xavia still
  20 with every column equal to `market-catalogue.production-2026-09-24.json`.
- Browser, Motovento, `GALE-JACKET`: the Sheet opens (no empty state). The scope bar shows Shared + eBay + Etsy. The
  landing market is the browser's remembered one, else **DE** (follow-up F2 in PLAN.md A-53).

### Not done (named)

- No arm proves "if the market insert fails, the business is not created": the insert is inside the creation
  transaction (read), but nothing forces it to fail in a test.
- Follow-ups F1–F3 in PLAN.md A-53 stand. Also noticed: the catalogue carries Amazon TR VAT **18 %** because Xavia's
  production row does; Turkey's standard rate has been 20 % since July 2023. Not changed here (the catalogue copies
  production); a data ruling for the Owner.
