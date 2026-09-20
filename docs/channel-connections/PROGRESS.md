# Channel connections — progress and handover

Written 2026-09-19. Updated 2026-09-19 (fourth session): P1.4 is BUILT; the next package is P1.6, which starts by showing the Owner the delete list.

Read in this order:

1. `docs/channel-connections/FINAL-PLAN.md` — the one plan. Section 14 has the rules (14.1), the progress table (14.2) and the Owner's decisions (14.3).
2. This file — where work stopped and what to do next.
3. The build records in `docs/channel-connections/build/<ID>.md`.

---

## 1. Rules from the Owner (still in force)

- "Start to implement the whole plan. I'll stop you where we need it." → do the packages in plan order. No per-package "go".
- Commit each package **locally** when its proof is green. **Never push** without asking.
- Decisions D1–D9 = the plan's "My pick" column.
- Ask first for: any push; any production read or write; any live channel call; the P1.6 delete list; each P7 drop; the Owner-only steps in plan section 8.
- **Flat-file routes need a yes per change**, also under the blanket go: `apps/api/src/routes/ebay-flat-file.routes.ts`, `apps/api/src/routes/amazon-flat-file.routes.ts`, `apps/web/src/app/products/*-flat-file/**`. Write an edit list first (example: `build/flat-file-edit-list.md`), then ask.
- Never use `--no-verify`. Never lower a ratchet baseline to make it pass.
- Migrations go to the **local** database only. Check the host is `127.0.0.1` first.
- Do not touch other sessions' files: the assortment files, `.githooks/post-commit`, `.githooks/pre-push.backup`, `docs/channel-connections/PLAN.md`, `RESEARCH.md`, `full/`, `apps/web/src/app/settings/sharing/`.
- Reports to the Owner: simple English, short sentences, max 2 options with a pick.

## 2. Done — committed locally on `main`, NOT pushed

| Package | Commit | Record |
|---|---|---|
| P0.1 – P0.8 | 8fcd1d500, 97a739522, 8c2f10564, e5dd96609, be8195f0e, 92677ad03, f85c09033, ab92ed828 | `build/P0.*.md` |
| P6.1, P6.3, P6.5 | a7ad73294, 6e9db49a6, 6a243db24 | `build/P6.*.md` |
| P1.1 gateway + call ledger | aadbfc374 | `build/P1.1.md` |
| P1.2 every channel call through the gateway (ratchet 0 for all) | e25bad9b5, 740b02dc7, f951399b7, a034e6f2d, e8c84b0d0 | `build/P1.2.md` |
| P1.3 each queue row carries its account | 7eaf48d59, eaa8f5856 | `build/P1.3.md` |
| Flat-file edit list + Owner's answers | 52f985539 | `build/flat-file-edit-list.md` |
| P1.5 eBay market headers from the Marketplace row | b2af8d68b | `build/P1.5.md` |
| P1.4a Shopify queue on 2026-07 GraphQL with the row's account | 842841031 | `build/P1.4.md` |
| P1.4b part 1 Shopify order actions (refund, cancel, tracking) on the order's account | 86d128291 | `build/P1.4.md` 6.1 |
| P1.4b part 2 bulk Shopify price / stock on the listing's account | 2a0493c6b | `build/P1.4.md` 6.2 |
| P1.4b part 3 gateway: a Shopify change only on 2026-07 GraphQL with an account | bc9baf734 | `build/P1.4.md` 6.3 |
| P1.4 the shop's single location for a linked listing (Owner 09-20) | (this commit) | `build/P1.4.md` 4.1 |

**PUSHED 2026-09-20** — `e124f24ac` is on `origin/main`; the grid-kit blocker cleared when the sharing session moved its grids to the DS DataGrid, and the profiles-ON gate passed after the fixes in that commit. Production deploy `a05565cc` built from it. Production proofs (per build record) can now be taken.

**Old note, kept for the history — push was blocked.** The grid-kit ratchet in `.githooks/pre-push` fails on another session's untracked files in `apps/web/src/app/settings/sharing/`. It is not our code. Ask the Owner. Production proofs for every package wait for a push.

## 3. P1.4 — BUILT (committed locally, not pushed)

All three parts of P1.4b and P1.4a are committed. Record: `build/P1.4.md` (section 6.4 = where it stands).

- Done-when "0 REST 2024-01 writes": met in code. The gateway refuses any Shopify change that is not on the `2026-07` GraphQL API with a named account (`SHOPIFY_LEGACY_WRITE`).
- Done-when "one stock round-trip with compare-and-set proven": proven against a stateful fake. On a real shop it needs a Shopify dev store → **ask the Owner** (a live call).

## 4. Open questions for the Owner (from P1.4)

1. ~~Linked Shopify listings have no stock location~~ **ANSWERED 2026-09-20**: use the shop's location when it has exactly one active one; two or more are refused (`build/P1.4.md` 4.1). Built and committed.
2. **Before a push:** read the production switches `NEXUS_ENABLE_SHOPIFY_REFUND`, `NEXUS_ENABLE_SHOPIFY_ORDER_CANCEL`, `NEXUS_ENABLE_SHOPIFY_SHIP_CONFIRM` (new). After the push, a switch set to `true` sends through the connected Shopify account (`build/P1.4.md` 6.1).
3. **P1.6 delete list** grows with the old Shopify env writers (`build/P1.4.md` 6.3). The Owner allowed production **reads** (Railway `http-requests`) to prove a route has no caller (2026-09-20).

## 4b. P1.6 — BUILT (2026-09-20), committed locally

The Owner approved groups A, B and C of `build/P1.6-delete-list.md`, and picked the API lane for big eBay pushes. Four commits: `7f2d43422` (group A), `8666b9d29` (group B, after moving the Shopify locations discovery to the connected account), `96ed9c65c` (WooCommerce), `cb1677123` (the eBay feed lane + the push-lock gate script). 26 files gone; ratchet still 0; suite at baseline. Record section 8 lists everything. Group D (5 live items) stays and is fixed in later packages.

**P1.7 BUILT (2026-09-20)** — `04166df5d` the push lock refuses an ENDED listing, `ee9fe18ea` eBay verifies before every Add, `986b2862e` Amazon previews every content write. Record `build/P1.7.md`; 14/14 mutation checks. The Amazon flat-file route previews every row too (Owner chose option A, `9e4f2cbf2` + the flat-file commit); it already had the push lock through `prepareRowsForPush`.

**P1.8 BUILT (2026-09-20)** — `314916688`, record `build/P1.8.md`. The nightly run is OFF until the Owner sets `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN=true` and one sandbox account per channel. 🔴 Local test runs now hit two UNAPPLIED migrations from other sessions (`20260919c_shared_warehouses`, `20260919d_ae4_live_sync`): three DB-backed test files fail with "The column (not available) does not exist in the current database".

**Next package: P2.1** (the incoming event ledger), per section 5 of this file (validate before send: Amazon `VALIDATION_PREVIEW` for every content write; eBay `Verify…` before Add; the push lock also blocks `ENDED` listings).

## 5. After P1.4

P1.7 → P1.8 → P2.x → P3.x → **P5.1 before 2026-12-15** → P4.x → P5 → P6.2 / 6.4 / 6.6 / 6.7 / 6.8 → P7 (each drop needs a yes) → P8.

## 6. Commands and traps

- Run API tests from `apps/api`. From the repo root, `DATABASE_URL` resolves to Neon **production**.
- Full-suite baseline: 2 known failing files — `clients/amazon-validation-preview` (5) and `marketplaces/amazon-classifications` (1). A full run under load can time out the PGlite setup; re-run that file alone.
- `grep` in this shell is an `ugrep` function that skips ignored files. Use `/usr/bin/grep`.
- `docs/channel-connections/build/` is caught by the `build/` rule in `.gitignore` → `git add -f`.
- zsh: pass arguments as arrays; do not put `===` in `echo`; quote `--include` patterns.
- Channel client tests stub the gateway with `apps/api/src/test-support/gateway-stubs.ts` (`accountModule`, `ledgerModule`, `asResponse`).
- Shopify: `location { id }` on an inventory level needs the `read_markets_home` scope (the app has `read_markets`). Use `inventoryLevel(locationId:)`.
- Production reads (Railway variables, production DB) are refused by the permission system. Ask the Owner.
