# Channel connections — progress and handover

Updated **2026-09-20**. P0, P1 and three P6 packages are **built, pushed and live in production**. The next package is **P2.1** (the incoming event ledger).

Read in this order:

1. `docs/channel-connections/FINAL-PLAN.md` — the one plan. Section 6 has the package rows; section 14 has the rules (14.1), the progress table (14.2) and the Owner's decisions (14.3).
2. This file — where work stopped, what is next, and the traps that cost time.
3. The build record of the package you touch: `docs/channel-connections/build/<ID>.md`.

---

## 1. Rules from the Owner (in force)

- "Start to implement the whole plan. I'll stop you where we need it." → packages run **in plan order**, no per-package "go". Commit each package when its proof is green.
- **Ask first** for: any production **write**, any **live channel call**, each P7 drop, and the Owner-only steps in plan section 8. Production **reads** (Railway traffic and logs) are allowed since 2026-09-20.
- **Pushing is allowed** (Owner, 2026-09-20) once the package's proof is green. A push deploys to production and **applies migrations there**.
- **Flat-file routes need a yes per change**: `apps/api/src/routes/ebay-flat-file.routes.ts`, `apps/api/src/routes/amazon-flat-file.routes.ts`, `apps/web/src/app/products/*-flat-file/**`. Write an edit list first (`build/P1.7-flat-file-edit-list.md` is the pattern), then ask.
- Never `--no-verify`. **Never lower a ratchet baseline to make it pass.** **Never weaken a test to make it pass** — if a test proves a real defect, fix the code (that is how the P1.3 per-row read was caught).
- Migrations: apply to the **local** database only (check the host is `127.0.0.1` first); production gets them from the deploy.
- Other sessions share this tree. `git status` first. Do not touch their files: the assortment files, `.githooks/post-commit`, `.githooks/pre-push.backup`, `docs/channel-connections/PLAN.md`, `RESEARCH.md`, `full/`, `apps/web/src/app/settings/sharing/`.
- Reports to the Owner: simple English, short sentences, **max 2 options with a pick**.

## 2. Done — on `origin/main` and live

Deployment `a05565cc` from commit `e124f24ac`: SUCCESS, migrations applied.

| Package | What | Commits | Record |
|---|---|---|---|
| P0.1 – P0.8 | Safety: every dry-run / sandbox path that wrote live is closed, monitoring routes authed, operator webhooks, signed eBay refunds, secret-expiry alert, notifications per profile, wrong-account guard, deadlines | `8fcd1d500` … `ab92ed828` | `build/P0.*.md` |
| P6.1, P6.3, P6.5 | Automatic Amazon secret rotation (**off** until the Owner registers the queue), Etsy refresh-token save, per-profile heartbeat | `a7ad73294`, `6e9db49a6`, `6a243db24` | `build/P6.*.md` |
| P1.1 – P1.2 | One outgoing gateway + its ratchet: **0 channel sends outside it** (47 exempt, each with a written reason) | `aadbfc374` … `e8c84b0d0` | `build/P1.1.md`, `build/P1.2.md` |
| P1.3 | Every queue row carries its destination account; 2 per account at a time; one creation helper for all sites | `7eaf48d59`, `eaa8f5856` | `build/P1.3.md` |
| P1.4 | Shopify on the 2026-07 GraphQL client with the row's / order's / listing's own account; order actions; the gateway refuses any other Shopify change | `842841031`, `86d128291`, `2a0493c6b`, `bc9baf734`, `836c66f15` | `build/P1.4.md` |
| P1.5 | eBay market headers from the Marketplace row (`EBAY_IT` → `it-IT`) | `b2af8d68b` | `build/P1.5.md` |
| P1.6 | 26 files of dead channel code deleted (groups A, B, C); the eBay feed lane is no longer chosen by row count | `7f2d43422`, `8666b9d29`, `96ed9c65c`, `cb1677123` | `build/P1.6-delete-list.md` |
| P1.7 | Validate before send: Amazon previews every content write, eBay verifies before every Add, the push lock refuses an ENDED listing | `04166df5d`, `ee9fe18ea`, `986b2862e`, `4158ff87c` | `build/P1.7.md` |
| P1.8 | Nightly sandbox contract run — **off** until the Owner turns it on | `314916688` | `build/P1.8.md` |
| P1.3 follow-up | The claim check reads once per chunk, not once per row (found by the profiles-ON gate: a real defect) | `e124f24ac` | section 5 below |

**Production proofs taken (2026-09-20):** anonymous `GET /api/monitoring/queue-stats` → **401**, with `/api/health` → **200** in the same run as the control; `Applying migration 20260919a_p11_gateway_call_ledger` in the deploy log; the contract cron logs itself off; **0 × 5xx** since the deploy.

## 3. Next — P2.1, the incoming event ledger

Plan row: *A ledger that works for every channel: status lifecycle, dedupe on the channel's delivery id (Amazon `NotificationId`, Shopify `X-Shopify-Webhook-Id`, eBay notification id), rejects recorded in every mode, retry worker, dead-letter queue, replay button, **archive instead of delete**. Done when: a forced failure retries, lands in dead letters, and replays; no row is ever deleted.* Size M. Decision D8 is settled: **archive, never delete**.

**Start by measuring**, not by building — the plan's reading is from 2026-09-19 and this tree moves daily. For each channel: which receiver routes exist, what they store, whether any delivery id is kept, what happens to a rejected or failed event, and whether anything deletes rows.

After P2.1: P2.2 → P2.3 (**needs the Owner's yes**: it starts live traffic) → P2.4 → P2.5 → P2.6 → P2.7 → P2.8 → P3.x → **P5.1 before 2026-12-15** → P4.x → P5 → P6.2 / 6.4 / 6.6 / 6.7 / 6.8 → P7 (each drop needs a yes) → P8.

## 4. Open items the Owner owns

1. **P1.8 is off.** Turn it on with `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` plus one sandbox account per channel (`NEXUS_CONTRACT_ACCOUNT_EBAY`, `…_AMAZON_SP`, `…_AMAZON_ADS`, `…_SHOPIFY`, `…_ETSY`, and `NEXUS_CONTRACT_AMAZON_SELLER_ID`). Shopify needs a development-store account named; Etsy has no sandbox and needs the Owner's decision about a test listing marked "test".
2. **P6.1 is off** until the Owner registers the credential queue and sets `AMAZON_APP_CREDENTIAL_QUEUE_URL` (`build/P6.1.md` section 4).
3. **Shopify order-action switches** now reach the connected account when set to `true`: `NEXUS_ENABLE_SHOPIFY_REFUND`, `NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL`, `NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM` (new in P1.7).
4. **Re-publishing an ended listing has no path**: the push lock refuses it and nothing in the code relists. Presence's relist verb is the planned answer.
5. **A live stock round-trip on a real Shopify dev store** is still unproven (P1.4 done-when 2) — it is a live channel call, so it needs the Owner's yes.
6. **Not this programme, found in production 2026-09-20:** the dashboard tax panel reads `OrderItem."vatRate"`, a column in neither the schema nor the database (query from `6c5c6d79a`, 2026-05-09), and its `.catch(() => 0)` shows **tax = 0** instead of saying it could not be read. Separately, the eBay readback cron fails every 30 minutes on missing `EBAY_APP_ID` / `EBAY_CERT_ID` (the same lines are on the previous deployment, so it predates this work).

## 5. Traps that cost time here — read before measuring anything

- **`@nexus/shared` runs from `packages/shared/dist`, which is not in git.** Edit the source and local tests still run the OLD code until `cd packages/shared && npm run build`. A green suite straight after a shared-package edit is a stale measurement, not a pass.
- **The pre-push gate runs the API suite with business profiles ON** (`node apps/api/scripts/profiles-on-ratchet.mjs`, baseline `apps/api/scripts/profiles-on-baseline.json`). It fails on any new failure, any baselined file getting worse, **and on a fixed file left in the list**. Production runs with profiles on: give the code a business (`withWorkspace`) and seed rows that belong to it.
- **The local database drifts** as other sessions add migrations: the generated client then expects columns your database lacks and DB-backed tests fail with `The column (not available) does not exist`. Fix from `packages/database`: `DATABASE_URL="<the one in apps/api/.env>" npx prisma migrate deploy --schema=prisma/schema.prisma` (check the host is `127.0.0.1` first — the repo's prisma config points somewhere else).
- Run API tests **from `apps/api`**, never the repo root (from the root, `DATABASE_URL` resolves to Neon **production**).
- A full suite **under load** fails files that pass alone (PGlite setup timeouts). Re-run a file alone before calling it a regression.
- Known-failing baseline of the full API suite: `clients/amazon-validation-preview` (5) and `services/marketplaces/amazon-classifications` (1) — both read a local Amazon account.
- `grep` in this shell is an `ugrep` function that skips ignored files. Use `/usr/bin/grep` for any "exists / does not exist" claim, with a positive control for every set claim.
- `docs/channel-connections/build/` is caught by the `build/` rule in `.gitignore` → `git add -f`.
- Channel client tests stub the gateway with `apps/api/src/test-support/gateway-stubs.ts` (`accountModule`, `ledgerModule`, `asResponse`).
- Shopify: `location { id }` on an inventory level needs the `read_markets_home` scope (the app has `read_markets`). Use `inventoryLevel(locationId:)`.
- zsh: pass arguments as arrays; do not put `===` in `echo`; quote `--include` patterns.

## 6. How every package here was closed — do the same

Measure first with commands you can quote. Build the smallest change. **Prove it with mutation checks**: break each new rule on purpose, watch a named test fail, restore the file and compare it byte for byte. Then run `tsc`, the full API suite, the gateway ratchet (`apps/api/scripts/channel-gateway-ratchet.mts --check`, must stay 0) and the push-lock gate (`scripts/check-push-lock.mjs`). Write `build/<ID>.md` with what was measured, what changed, the proof and what is still open, update table 14.2 in the plan, commit, push, and take the production proof.
