# Channel connections — structured plan to finish, ship and prove (2026-09-25)

Owner instruction (2026-09-25): "do it all ASAP according to the structured plan and push it all to
`main`, and then, when everything's done, make sure that it's AAA quality and there are no
inconsistencies at all."

That instruction **approves pushing each reviewed, fully gated package below to `main`** (which
deploys production) with **every new switch OFF**. It does **not** approve: turning any switch ON,
live vendor/channel calls or probes, operator grants, KMS use/rewrap/key retirement, credential or
environment-variable changes, deletions (exact-ten), `prisma migrate resolve`, Finances cutover,
or P7 drops. Each of those still needs its own explicit Owner yes (Phase 4).

## State at hand-over (2026-09-25 ~00:00 UTC)

| Item | Where / value |
|---|---|
| Production | serving `a22f2fc3` (published main `a22f2fc36`), healthy 2026-09-24 23:45:52Z |
| Release branch | `fix/channel-connections-20260922` @ `03ff3b0a0` (+ this doc commit) in `/private/tmp/nexus-channel-connections-20260922` = C9–C11f6c + docs + merge of main `60539940f`. Gate GREEN at 03ff3b0a0 (11,572 API / 4,799 web / 127 security / 328 realPG in 25 suites, zero skips) |
| Main moved since | 11 commits (`60539940f..a22f2fc36`), no new migrations; overlapping file `apps/api/src/lib/database-context.ts` |
| Recovery | `recovery/cx-20260924` @ `64bf38e48` (38c99a7af + main 60539940f + release database tree). NOT gated/rehearsed yet. Superseded `recovery/cx-20260923` @ `fdd368e0c` (0a-based) — do not use |
| Worktrees | release (clean, detached) `/private/tmp/cx-release-20260923` (has a SYNTHETIC root `.env`, never production values); recovery `/private/tmp/cx-recovery-20260923`; production base `/private/tmp/cx-0a-20260923` (detached; move it to the serving build) |
| Lanes (local only) | `fix/cx-contract-coverage` @ `a6b5fefaa` (re-reviewed, approved after nits) · `fix/cx-ebay-price-readback` @ `915b0b4fa` (final fixes not yet re-reviewed) · `fix/cx-amazon-finances` @ `509d8af99` (fixes not yet re-reviewed) · `fix/cx-ebay-order-writer` @ `9e4380c12` (fix round + E3 not yet re-reviewed) · `fix/cx-etsy-receipts` @ `cf032a270` (R1/R2 + E3–E6 not yet reviewed). Lane worktrees `/private/tmp/cx-lane-*` |
| New lane migrations | `20260924a_cx_amazon_finance_identity`, `20260924b_cx_order_line_holds` (both additive; not applied anywhere) |
| Tools | `docs/channel-connections/build/tools/`: `rehearse.sh`, `rehearse-jobs.sh`, `prod-census.mjs` (read-only; kept locally, not in the public repo), `lane-rules.md`, `f6bc_mutations.py` (pattern). Evidence: `/private/tmp/cx-completion-20260922/` |
| Records | `RELEASE-C9-C11F6C.md`, `build/CX-REMAINING.md` (C11f6b, C11f6c, R1), `QUARANTINE-MAINTENANCE.md`, `COMPLETION-MATRIX.md`, `2026-09-22-HANDOVER.md` |
| Blocker | Production READS are refused by the session's auto-mode classifier even after the Owner's chat approval. The Owner must add a Bash permission rule (e.g. allowing `node …/build/tools/prod-census.mjs`) or run it with `! node …`. |

## Phase 0 — start-up (≤ 20 min)

1. `git status` in the release worktree and in `/Users/awais/nexus-commerce` (another session's tree:
   never edit, stash, stage from, push from, or run scripts in it — the rehearsal once ran from the
   wrong cwd; always `cd` explicitly).
2. Read this plan, `RELEASE-C9-C11F6C.md`, `build/CX-REMAINING.md` sections C11f6b/C11f6c/R1,
   `COMPLETION-MATRIX.md` "Latest state", `build/tools/lane-rules.md`.
3. `git fetch origin main`; public `GET /api/health` (build + healthy). Record both with UTC time.
4. Ask the Owner once for the production-read permission rule (see Blocker). Continue without it;
   Phase 2's census waits for it.

## Phase 1 — Package A: C9–C11f6c (ready; ship first)

1. Merge the newest `origin/main` into the release branch (published history only). Resolve
   `database-context.ts` carefully (both sides changed it); read both diffs first.
2. Database gates: policy parity, model ownership, schema + column drift, `@nexus/database` tests.
3. Clean release worktree: `git checkout --detach <release-sha>`; `npx prisma generate` (never while
   tests run); full hook `bash .githooks/pre-push </dev/null` → must exit 0. Keep the log.
4. Recovery: new branch `recovery/cx-20260925` from `38c99a7af`; merge the same `origin/main`;
   `git checkout <release-sha> -- packages/database apps/api/src/services/cx/ingress/ebay-quarantine-maintenance-postgres.vitest.test.ts apps/api/src/test-support/concurrent-database.ts`;
   commit; verify `git diff --exit-code <release-sha> HEAD -- packages/database`; diff vs release =
   only C11f6a/b/c files. Build it and run its full hook.
5. Rehearsal: move `/private/tmp/cx-0a-20260923` to the SERVING build; update the three paths in
   `build/tools/rehearse.sh`; run it and `rehearse-jobs.sh`. Must show: base bootstrap → release
   applies exactly `20260923a..h_cx_*` (out-of-order names are expected: main's `20260924a_a53` is
   already applied) → base refuses → recovery, release, recovery all ready 200 with their exact builds,
   checksums identical, processing held.
6. Push: re-check `git ls-remote origin main`; push the recovery branch (branch only); then from the
   clean release worktree `git push origin <release-sha>:refs/heads/main` (hooks run; never
   `--no-verify`). If main moved meanwhile: stop, re-merge, re-gate.
7. Verify production: Railway deployment SUCCESS (Railway MCP read), `/api/health` + `/ready` 200 with
   the release build, a protected diagnostic GET 401, (read-only, if permitted) `_prisma_migrations`
   has `20260923a..h_cx_*` finished, Etsy shop 57783036 → Motovento, Shopify connected. Record evidence.
8. If the release fails after migrating: `gh workflow run deploy-api.yml --ref recovery/cx-20260925`,
   freeze pushes, never downgrade the database (RELEASE doc §Recovery).

## Phase 2 — Package B: the five lanes

1. Independent re-reviews in parallel (reviewer agents, read-only): ebay-order-writer fix round + E3;
   etsy R1/R2 + E3–E6 (first full review); amazon-finances fix round; ebay-price-readback final fixes.
   Send findings back to the lane agent/branch; repeat until APPROVE. Contract lane is approved.
2. Production census (needs the permission rule; `build/tools/prod-census.mjs`, kept locally, read-only, aggregates
   only). Decisions it feeds:
   - eBay price currency per market: if any non-IT eBay listing follows the master price, **stop and
     ask the Owner** (no FX conversion exists; £ = € number). Otherwise ship.
   - eBay businesses whose default warehouse cannot be resolved → expect `stock_blocked` lines + notices.
   - eBay connections without seller id referenced by recent orders.
   - Finance duplicates / unattributed rows (A5 script stays unexecuted until the Owner approves).
   - eBay deletion-notice volume per day (quarantine growth after Package A).
3. Integrate into the release branch in this order, running database gates + the lane's targeted
   suites after each merge: contract-coverage → ebay-price-readback → amazon-finances →
   ebay-order-writer → etsy-receipts. Conflicts to expect: `scripts/run-real-postgres-tests.mjs`
   (keep every suite, exact counts), `schema.prisma`, `baseline.sql`, `model-ownership.json`,
   `scoped-keys.json`, stock services (order-writer E3 and Etsy R2 both touch cancellation/holds —
   re-run stock-concurrency 10, stock-pool-* and both lanes' suites together), `outbound-sync.service.ts`,
   `ebay-inventory-readback.service.ts` / `ebay-readback.job.ts` (another programme also edits these —
   integrate with published main first). Keep migration names; verify sort order against main's.
4. Full hook in the clean release worktree; new recovery (Package-A release code merged with main +
   final database tree); rehearsal with the Package-A build as the serving base; push; verify.
5. Switches that must remain OFF after Package B: `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING`,
   `NEXUS_ENABLE_EBAY_ORDER_NOTICES`, `NEXUS_ENABLE_ETSY_ORDER_INGEST`,
   `NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON`, `NEXUS_AMAZON_FINANCES_2024_WRITER`,
   `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP`; contract run unchanged. Production-facing in B (state them
   in the release doc): eBay polling writer + exact cancellation restore for ALL channels, Amazon
   order stamping + v0 finance writer changes, eBay price step market/currency + read-back, contract
   run statuses, Etsy read-error wording + listing freshness stamps.

## Phase 3 — remaining engineering (Package C, same discipline)

- P3.3 listing-issues API (own route) + Diagnostics card (design system only; browser-verified 390/1280,
  light/dark, keyboard); the studio pane itself belongs to PES.3 — hand over, do not edit `_studio/`.
- eBay privacy: non-destructive slice (deletion quarantine reason + read-only operator census +
  per-workspace ErasureRequest record/notice). Destructive anonymisation waits for the Owner's
  fiscal-retention answer (A: pseudonymise non-fiscal fields now; B: restrict until retention ends).
- eBay: variation-push price confirmation; quantity-path `offers[0]` lookups; `stock_blocked`
  follow-up (re-deduct after configuration fix, with owner confirmation).
- Amazon/Shopify cancellation retry parity with eBay's unfinished-restore retry.
- P1.8 missing checks (eBay notification reads, Amazon getListingsItem); B2 membership
  `channelConnectionId` backfill (script, not executed).
- Investigate the one-off 57P01 teardown error seen by the Etsy lane in an eBay quarantine realPG suite.

## Phase 4 — activation and live proof (each needs its own Owner yes; prepare exact actions)

Operator grant + KMS verify/rewrap (QUARANTINE-MAINTENANCE procedure); eBay inbound processing +
topic setup; eBay order notices; Etsy portal endpoints + signing secret + ingest/poll switches (T0 is
set on first enable); Amazon Finances amended dry run → census → attribution backfill → boundary flip;
contract run accounts + sandbox data; eBay verification token fix; LWA expiry date; Neon password
rotation; exact-ten deletion; P7 drops after a green week each.

## Phase 5 — AAA quality and zero-inconsistency audit (after every push, and at the end)

"AAA" means these measurable thresholds (COMPLETION-MATRIX quality table), never a blanket claim:
1. Gates: full normal hook green; realPG exact counts, zero skips; profiles-ON ratchet not worse;
   gateway/inbound-ledger/market-currency/stock-lock ratchets at baseline or better.
2. Every new guard has an applied-and-restored mutation killed by an assertion; survivors fixed or
   proven equivalent and recorded.
3. Independent review APPROVE for every slice and one final whole-package review of
   `git diff <main-before>..<main-after>`.
4. UI: design system only, no raw palette, 7:1 contrast gate green, keyboard + focus, 390/1280 widths,
   light/dark, checked in a real browser.
5. Production: Railway SUCCESS, exact serving build, protected routes 401, affected profiles checked,
   no new 5xx in bounded log samples; every claim dated.
6. Consistency sweep (fix every mismatch, commit docs): FINAL-PLAN, PROGRESS, COMPLETION-MATRIX,
   HANDOVER, CX-REMAINING, QUARANTINE-MAINTENANCE, RELEASE docs, NEXT-SESSION-PROMPT agree with code
   and production — per requirement: implemented / deployed / enabled / production-verified; migration
   lists; runner suite counts; a switch table generated from code (`process.env.NEXUS_*` defaults)
   compared with the docs; no stale "built"/"deployed" labels; no contradictions between documents.
7. Report honestly what is proven, what is only local, and what waits for Owner approval.

## Working rules (unchanged)

Isolated worktrees only; stage files by name; commit per slice; one push per reviewed, gated package;
never overlap Prisma generation/build with tests using that client; real PostgreSQL for locks/races/RLS;
red first; never weaken assertions, timeouts, ratchets or hooks; production writes and live channel
calls only with explicit approval; never decrypt or print credentials. The Owner prefers speed now:
post a one-line note per sub-agent report and keep going; if the Owner says slow down, stop at each report.
