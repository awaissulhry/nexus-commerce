#!/usr/bin/env node
/**
 * AE.1 + AE.3 — run the tests that need a REAL, multi-connection PostgreSQL, for the pre-push hook.
 *
 * WHY A REAL SERVER
 * The normal test database (PGlite behind one connection) queues every transaction. Two things cannot
 * be tested there:
 *   · `stock-concurrency.vitest.test.ts` (AE.1) — simultaneous stock writes lose nothing. A race cannot
 *     happen on one connection, so the test would pass whether or not the code is safe.
 *   · `stock-transfer-concurrency.vitest.test.ts` (MCP full control 08 S2, 2026-10-01) — a transfer racing sales
 *     commits both movements together: no reader sees units in flight, and a failed arrival loses nothing.
 *   · `stock/stock-reconcile-concurrency.vitest.test.ts` (MCP full control 08 S6, 2026-10-01) — Claude's count
 *     reconcile racing sales: the variance is applied once, every sale counts, nothing goes below zero.
 *   · `stock/stock-source-tool-postgres.vitest.test.ts` (MCP full control 08 S8, 2026-10-02) — Claude's switch to
 *     another business's lent stock by SKU: owner only, the listing follows the pool, undo switches back.
 *   · `supply/receive-concurrency.vitest.test.ts` (MCP full control 08 S10, 2026-10-02) — two identical receives through
 *     the inbound receive route at once add the stock once: each line is locked while it is read and moved.
 *   · `supply/po-transition-concurrency.vitest.test.ts` (MCP full control 08 S9, 2026-10-02) — a PO transition is a
 *     compare-and-set: concurrent sends e-mail the supplier once; a send and a cancel cannot both happen.
 *   · `copy-run.vitest.test.ts` (AE.3, R-AE-16) — a first copy end to end through the real catalog
 *     transfer engine, whose apply holds a transaction while it checkpoints on a second connection.
 *   · `stock-pool-concurrency.vitest.test.ts` (shared stock, plan 2026-09-19) — two businesses selling the
 *     same units at the same moment through their own writers and the pool doors: one winner, no lost
 *     update, and a control that removes the door's lock and must break.
 *   · `stock-pool-e2e.vitest.test.ts` (shared stock) — the switches end to end through the real services,
 *     cascade and pool worker; the worker runs on several connections at once.
 *   · `stock-pool-sku-e2e.vitest.test.ts` (shared stock by SKU, 2026-10-01) — connect by the same SKU with no
 *     product share, every listing kind, and the worker woken by the database's LISTEN/NOTIFY within 2 s of a sale.
 *   · `listing-end-times.vitest.test.ts` (shared stock step 3) — "Fixed number until …" and "Paused
 *     until …" end to end: the Sync Control route and Excel import, the end-time job, the real writer and
 *     cascade, and the database triggers that clear an end time with its mode.
 *   · `order-stock-once-postgres.vitest.test.ts` (hotfix 2026-09-26) — an order line's stock is taken once:
 *     re-reads of shipped orders, an oversold line taken once stock arrives, surplus holds, the reconcile, races.
 *   · `stock-pool-orders.vitest.test.ts` (shared stock step 4) — orders through the doors: the real eBay
 *     ingest, holds / take out / give back, cancellations, the returns route, the guard and the repair job.
 *   · `stock-model-postgres.vitest.test.ts` (stock model 2026-09-26) — one stock model across channels: a
 *     shipped order whose stock work died healed by the next poll and the reconcile, per-product totals,
 *     hold identity across own ↔ shared stock switches, one shortfall class, and a poll, a reconcile, a
 *     cancellation and a stock-page release racing on one order.
 *   · `assortment/sync.vitest.test.ts` (shared stock step 6, AE.4) — live product sync: the capture
 *     trigger, the worker through the real transfer engine, overrides and "Follow again", images, SKU
 *     holds, new variations, retries, no chains, and the delay measured with the real LISTEN/NOTIFY.
 *   · `assortment/copy-unknown-market.vitest.test.ts` (AE.3, 2026-09-21) — a first copy into a business
 *     that sells NOWHERE YET: the column model reads Marketplace and ChannelListing, so only a real server
 *     can show that the reference market belongs to the SHARING business and that the receiving profile,
 *     which has no Marketplace row, must not be refused by the strict check.
 *   · `assortment/copy-inherited-attribute.vitest.test.ts` (AE.3, 2026-09-29) — a Link copy whose variations
 *     inherit an attribute the receiving family keeps off the master sheet: only the REAL column model shows
 *     that such a variation has no column there, and that its inherited row must link, not be refused.
 *   · `category-tree-concurrency.vitest.test.ts` (2026-09-26) — concurrent category moves, creates, membership
 *     replacements and Categories workspace commands serialize on the business's category-tree lock.
 *   · `fiscal-numbering-postgres.vitest.test.ts` (MCP full control #14, 2026-10-01) — invoice and credit-note numbers:
 *     the counter's ON CONFLICT target must be its real key, and a forced race numbers 1…N with no duplicate or gap;
 *     two businesses numbering the same year at the same moment each get their own series (plan O2).
 *   · `services/identity/identity-foreign-postgres.vitest.test.ts` (MCP full control I5, 2026-10-01) — the SECURITY DEFINER
 *     function that tells a business which of its own channel ids another business holds: as the runtime login, with
 *     members and non-members, it must name nothing it may not and answer no id the caller does not hold.
 *   · `services/identity/identity-merge-postgres.vitest.test.ts` (MCP full control I11, 2026-10-01) — merging a duplicate
 *     product while a stock writer or an order line reaches it: the merge waits on the product row and then refuses.
 *   · `refunds/refund-cap-postgres.vitest.test.ts` (MCP full control 07, 2026-10-02) — two refunds of two returns of one
 *     order at the same moment never exceed what the order paid (forced race on the order's row lock).
 *   · `services/identity/channel-item-claim-postgres.vitest.test.ts` (MCP full control I12, 2026-10-02) — the trigger that
 *     claims a seller-owned channel id for one listing, under two businesses writing it at the same moment.
 *   · `routes/mcp-cross-business-postgres.vitest.test.ts` (MCP.8, 2026-09-30) — Claude's connection for one business
 *     never reaches another: the /mcp route, the Approvals and Connected apps routes and every tool, run as the
 *     restricted runtime login, so row-level security holds exactly as it does in production.
 *   · `services/automation-state-two-business-postgres.vitest.test.ts` (MCP full control R1, 2026-10-01) — the ads
 *     automation dial and halt, the fleet halt and the review mailer pause are one row PER BUSINESS under row security:
 *     a halt in one business never stops another, and the legacy business keeps its old row id.
 *   · `services/advertising/bid-brain/live-postgres.vitest.test.ts` (bid brain BB-6, 2026-10-08) — the live bid brain: one
 *     writer per campaign through the real write gate under row security, a person's bid held, give-back restored.
 *   · `services/advertising/bid-brain/plans-postgres.vitest.test.ts` (bid brain BB-7, 2026-10-08) — an owned campaign's hourly
 *     plan carried out by the brain: placements inside the CPC ceiling, Min-bid floors with the anti-flap, the bids given back;
 *     AB-2: the stop recipe — lanes at 0 % and down only during a stop, everything given back exactly when it lifts.
 *   · `services/advertising/bid-brain/hook-postgres.vitest.test.ts` (bid brain BB-10, 2026-10-08) — the auto-undo hook: the
 *     run-completed event in the outbox, holds and releases, and the hold after an approved undo of a brain change.
 *   · `services/advertising/brain/enrollment-postgres.vitest.test.ts` (one brain AB-1, 2026-10-08) — a product's brain: its
 *     tables under row security, the campaign → product resolver, the bids lever adopting and driving BidBrainEnrollment,
 *     the Owner's overrides (exclude, lock, levels, settings), the per-campaign tool kept in step with them, and two changes
 *     on one version (one wins).
 *   · `services/advertising/brain/read-map-postgres.vitest.test.ts` (one brain AB-3, 2026-10-08) — the ads-brain map on a GALE
 *     IT shape: each lever's owner from what is set up and from the action log, the clashes and the gaps, the setup.
 *   · `services/advertising/brain/gate-levers-postgres.vitest.test.ts` (one brain AB-5, 2026-10-08) — one owner per lever at
 *     the real write gate: a product's brain owns a lever (refuses another engine's change through the real write paths),
 *     OBSERVE refuses nothing, the Owner's lock holds the brain too, an exclusion and another business are judged as before.
 *   · `services/advertising/brain/engine-skips-postgres.vitest.test.ts` (one brain AB-6, 2026-10-08) — every engine leaves a
 *     lever another owner holds before it asks: a rule's budget action a named skip counted in its refusal record, a
 *     budget schedule and a pool leave the brain's campaign; the Owner's lock the same; nothing enrolled and another
 *     business as before.
 *   · `services/advertising/brain/negatives-postgres.vitest.test.ts` (one brain AB-10, 2026-10-08) — the negatives module: its log
 *     under row security, the day logged in shadow, AUTO through the one negative write service and the real gate (owned →
 *     written as the brain, the revive queued; not owned → nothing, the gate refuses the brain's actor), PROPOSE as one plan.
 *   · `services/advertising/brain/terms-postgres.vitest.test.ts` (one brain AB-9, 2026-10-08) — the term ledger and the market
 *     arbiter in shadow: its two tables under row security, one decision per term of an enrolled product, two siblings on
 *     one term → one lead, a rerun changes nothing, the read view's money hidden, nothing at Amazon.
 *   · `services/advertising/brain/native-rules-postgres.vitest.test.ts` (one brain AB-4, 2026-10-08) — Amazon's own rules on
 *     brain campaigns: the snapshot table under row security, the daily read only while the brain is live or a product is
 *     enrolled, each rule on a brain campaign a clash in the map, and a lever refused AUTO where Amazon's rule acts on it.
 *   · `services/advertising/brain/budget-shadow-postgres.vitest.test.ts` (one brain AB-7, 2026-10-08) — the money shadow: its
 *     log table under row security, one product's plan (envelope, pace, brake, portfolio cap, campaign budgets) logged on change
 *     and once a budget day, one base move a day from the day's logged opening, nothing written at Amazon, the money view's dry
 *     run and its money hidden without the permission.
 *   · `services/advertising/ams-grain-postgres.vitest.test.ts` (bid brain BB-16, 2026-10-08) — the Marketing Stream at ad group ×
 *     placement grain: its tables under row security, the row-count guard per business, one record on eight connections
 *     added once, twenty records on one new row all added, and a redelivery waiting on the first delivery's lock adding nothing.
 *   · `services/advertising/brain/budget-live-postgres.vitest.test.ts` (one brain AB-8, 2026-10-08) — the money writer through
 *     the real write gate: nothing enrolled writes nothing (the bid brain's LIVE campaigns keep their budgets); OBSERVE logs,
 *     PROPOSE asks once, AUTO queues the base moves and the ladder's rung past the ceiling as the brain and writes the cap;
 *     the next day gives the ladder back; the Owner's lock, cap amount and the spend floor win; the value cap refuses.
 *   · `services/advertising/brain/state-postgres.vitest.test.ts` (one brain AB-12, 2026-10-08) — the state lever: its log
 *     table under row security; a long stock-out logged in shadow; at AUTO the brain's pause through the real status path and
 *     write gate (owned → one queued status write; not owned, excluded or locked → refused, nothing written); a person's pause
 *     held; the resume back to ENABLED with the stop's memory untouched; an archive only ever asked through the approval queue.
 *   · `services/advertising/brain/hours-postgres.vitest.test.ts` (one brain AB-13, 2026-10-08) — the brain's hourly research,
 *     painting and proposal: its table under row security, nothing done with no product enrolled, OBSERVE stored in shadow,
 *     PROPOSE one approval with the research and the grid, a rejection leaving the plan as it was, an approval saving the
 *     painted week as a new version as the approver (the Owner's locked hour kept), a stale approval not run, the view.
 *   · `services/advertising/brain/harvest-postgres.vitest.test.ts` (one brain AB-11, 2026-10-08) — the harvest module: its
 *     table under row security; shadow rows at OBSERVE; the pair asked of a person and a new campaign through
 *     create-ad-campaign at PROPOSE; an approved pair written whole (keyword + source negatives, the excluded campaign left);
 *     at AUTO the brain's pair through the real write gate, a gate refusal writing neither half, a failed negative retried;
 *     the judgement after the window proposing the undo, the undo approved; the view's money hidden; another business none.
 *   · `services/agents/change-plan-postgres.vitest.test.ts` (MCP full control C6, 2026-10-01) — a 200-step change plan:
 *     a stopped worker resumes, two workers at once run every step exactly once, a stale step is skipped.
 *   · `services/advertising/ads-claude-bulk-postgres.vitest.test.ts` (MCP full control A7, 2026-10-02) — an approved
 *     bulk bid change and an engine write on one target: when the drain claims both at once, exactly one wins.
 *   · `services/stock/stock-cases-postgres.vitest.test.ts` (Step 3 cases, 2026-10-07) — sealed cases × units per case
 *     never exceed the units: sales at once, a case count racing a sale, a case-size change racing a sale.
 *   · `services/fba-inbound/fba-send-postgres.vitest.test.ts` (Step 4 Send to FBA, 2026-10-07) — a double-click on
 *     "Create plan" through the route makes one plan and one set of holds; two cancels release each hold once; "Mark
 *     shipped" twice moves the units once; "Mark shipped" racing a sale keeps units, holds and sealed cases right.
 *   · `services/advertising/bid-brain/shadow-postgres.vitest.test.ts` (bid brain BB-3, 2026-10-07) — the shadow bid brain's
 *     loaders (a decayed evidence aggregate, DISTINCT ON reads) and its run under row security: it decides allowlisted
 *     IT/DE keywords, stores only changes and a daily snapshot, brakes on a halt or stale data, and writes nothing else.
 *   · `services/advertising/bid-brain/lag-curve-postgres.vitest.test.ts` (bid brain BB-15, 2026-10-08) — the attribution lag
 *     curve's table under row security and its fit's raw SQL, and the nowcast's grouped evidence aggregate: with the switch
 *     off or no curve the brain decides as before; in shadow byte for byte, with the difference named in the why.
 * Both therefore SKIP unless given a multi-connection server, which means a normal suite run verifies
 * nothing. This script supplies one.
 *
 * WHAT IT DOES
 *   1. Docker unavailable, or no PostgreSQL 17 image on this machine → prints a named SKIP and exits 0.
 *      It never pulls an image during a push.
 *   2. Starts ONE container on a random 127.0.0.1 port, data on tmpfs, removed on exit (also on Ctrl-C).
 *      Each test file creates and drops its own randomly named database in it. The files run ONE AFTER
 *      ANOTHER: each applies the generated policies, which create a server-wide role, and two files doing
 *      that at once fail with "duplicate key value violates unique constraint pg_authid_rolname_index"
 *      (measured 2026-09-17: the second suite then skipped every test).
 *   3. Runs the suites with that server. DATABASE_URL points at a dead port, so no un-mocked client can
 *      reach a shared database, and REDIS_URL too, because apps/api/.env names a production Redis.
 *   4. Exit 0 only if vitest exits 0 AND, for EVERY suite, its own file reports exactly the expected
 *      number of passed tests, none skipped and none failed. Counts are read per file from vitest's JSON
 *      report, so one suite's passes can never cover for another's skips. A suite that skipped measured
 *      nothing: that is a failure here, not a pass.
 *
 * PARTS (CI, 2026-09-30)
 *   In one CI job the suites took about 10.5 minutes (median of 15 runs, 2026-09-29): the longest step of every
 *   deploy. `--part N/M` runs one of M parts, so M jobs run side by side. The split is the API shards' split
 *   (scripts/ci/api-test-plan.mjs): longest suite first, each to the lightest part, by the times in
 *   scripts/ci/real-postgres-durations.json. Part 1 starts with a head start for the steps only it runs
 *   (PART_ONE_HEAD_START), so the jobs, not only their suites, end together.
 *   The same commit gives the same split on every machine, so the M jobs together run every suite once.
 *   Before any container starts, the split is checked. A suite in no part or in two, a suite listed twice,
 *   a suite whose name or expected count changed, or an empty part is REFUSED. Each suite keeps its "expect".
 *   CI takes M from the size of its matrix and records what each part passed (--record); db-security then
 *   checks that the parts together passed every suite once. A matrix that loses a part cannot stay green.
 *
 *   node scripts/run-real-postgres-tests.mjs                     # production-equivalent owner by default
 *   node scripts/run-real-postgres-tests.mjs --owner production   # as a non-superuser owner, production's rights
 *   node scripts/run-real-postgres-tests.mjs --required           # CI: missing Docker or image FAILS instead of skipping
 *   node scripts/run-real-postgres-tests.mjs --part 1/2           # CI: one of two parts (see PARTS)
 *   node scripts/run-real-postgres-tests.mjs --part 1/2 --list    # print that part's files and expected counts; no Docker
 *   node scripts/run-real-postgres-tests.mjs --record <file>      # after a pass: write each suite's file and passed count, as --list does
 *   node scripts/run-real-postgres-tests.mjs --write-durations    # after a whole run: average its times into those --part uses
 *   node scripts/run-real-postgres-tests.mjs --self-test          # the split check refuses planted faults (a static gate)
 *   node scripts/run-real-postgres-tests.mjs --suites '[{"name":"x","file":"src/…","expect":1}]'   # harness use
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shards } from './ci/api-test-plan.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = `${ROOT}/apps/api`
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const SUITES = flag('--suites') ? JSON.parse(flag('--suites')) : [
  { name: 'Shopify colour sync (durable debounce, rollback, claims and stale completion)', file: 'src/services/shopify/colour-products/sync-postgres.vitest.test.ts', expect: 11 },
  { name: 'disposable database teardown (autovacuum retried, a leaked connection fails at once)', file: 'src/test-support/concurrent-database.vitest.test.ts', expect: 3 },
  { name: 'saved listing issues (account and profile isolation, live keyset pages)', file: 'src/services/cx/listing-issues-postgres.vitest.test.ts', expect: 7 },
  { name: 'inbound receipt identity (simultaneous delivery and profile isolation)', file: 'src/services/cx/ingress/receipt-postgres.vitest.test.ts', expect: 8 },
  { name: 'retained inbound history (archive/replay races and database deletion guards)', file: 'src/services/cx/ingress/archive-postgres.vitest.test.ts', expect: 14 },
  { name: 'durable eBay receipt claims and atomic domain commit', file: 'src/services/cx/ingress/ebay-claims-postgres.vitest.test.ts', expect: 15 },
  { name: 'fenced manual eBay replay (clock skew, claims and concurrent operators)', file: 'src/services/cx/ingress/ebay-replay-postgres.vitest.test.ts', expect: 7 },
  { name: 'private eBay admission and recovery (ownership, quarantine, handoff and transfer races; order notices routed by seller id)', file: 'src/services/cx/ingress/ebay-admission-postgres.vitest.test.ts', expect: 39 },
  { name: 'eBay deletion review after acknowledgement (worker claims, first payload, RLS, atomic notices, races)', file: 'src/services/cx/ingress/ebay-erasure-review-postgres.vitest.test.ts', expect: 119 },
  { name: 'eBay deletion quarantine and read-only operator census (authority, retention, migration)', file: 'src/services/cx/ingress/ebay-deletion-quarantine-postgres.vitest.test.ts', expect: 11 },
  { name: 'private quarantine maintenance and inventory (roles, CAS, audit, snapshots and handoff races)', file: 'src/services/cx/ingress/ebay-quarantine-maintenance-postgres.vitest.test.ts', expect: 33 },
  { name: 'cold quarantine verification (closed snapshots, private body door, concurrent changes and CLI)', file: 'src/services/cx/ingress/ebay-quarantine-verification-postgres.vitest.test.ts', expect: 12 },
  { name: 'operator quarantine rewrap (audited CAS, closed transactions across KMS, contention and CLI)', file: 'src/services/cx/ingress/ebay-quarantine-rewrap-postgres.vitest.test.ts', expect: 7 },
  { name: 'mixed-version eBay rollout (held admission and atomic activation)', file: 'src/services/cx/ingress/ebay-rollout-postgres.vitest.test.ts', expect: 9 },
  { name: 'stored eBay execution (claims, holds, warnings, selection and worker integration)', file: 'src/services/cx/ingress/ebay-processing-postgres.vitest.test.ts', expect: 17 },
  { name: 'atomic grant versions (reconnect, rollback, inspection and concurrent replacement)', file: 'src/services/cx/grant-version-postgres.vitest.test.ts', expect: 10 },
  { name: 'eBay seller grant fence (cross-record reconnects and fresh committed reads)', file: 'src/services/cx/ebay-identity-postgres.vitest.test.ts', expect: 10 },
  { name: 'credential maintenance races (rotation, backfill, rollback and shared-account isolation)', file: 'src/services/cx/credential-writers-postgres.vitest.test.ts', expect: 12 },
  { name: 'transactional eBay revocation and unresolved owner warnings', file: 'src/services/cx/revocation-postgres.vitest.test.ts', expect: 25 },
  { name: 'durable webhook claims and retention', file: 'src/services/cx/ingress/claims.vitest.test.ts', expect: 22 },
  { name: 'one owner per inbound row type (eBay leases × processing claims, retention archive)', file: 'src/services/cx/ingress/inbound-ownership-postgres.vitest.test.ts', expect: 13 },
  { name: 'redelivery identity and bounded inbound retention (binding, reconnects, payload expiry by UPDATE)', file: 'src/services/cx/ingress/inbound-redelivery-retention-postgres.vitest.test.ts', expect: 7 },
  { name: 'transactional event producers and duplicate consumers', file: 'src/services/event-durability.vitest.test.ts', expect: 5 },
  { name: 'Etsy shop routing (backfill, ownership and identity namespaces)', file: 'src/services/etsy/ingress-routing-postgres.vitest.test.ts', expect: 5 },
  { name: 'Etsy receipt ingest (one writer: S1 per-product holds, whole-receipt take, partial notice, R5 dispositions, H1 activation, webhook defer/refusals, fair polling, lease, freshness)', file: 'src/services/etsy/etsy-order-ingest-postgres.vitest.test.ts', expect: 61 },
  { name: 'guarded connection delete (fresh counts and FK race)', file: 'src/services/connection-delete-concurrency.vitest.test.ts', expect: 2 },
  { name: 'Amazon Finances dry run and order attribution on the base schema (A2, A5; A3/A4 held)', file: 'src/services/amazon-finances-base-postgres.vitest.test.ts', expect: 9 },
  { name: 'stock race test (AE.1)', file: 'src/services/stock-concurrency.vitest.test.ts', expect: 10 },
  { name: 'a transfer racing sales is one transaction (08 S2 F8: no units in flight, a failed arrival loses nothing)', file: 'src/services/stock-transfer-concurrency.vitest.test.ts', expect: 4 },
  { name: 'a stock count reconciled by Claude while sales land (08 S6: the variance once, every sale counted, never below zero)', file: 'src/services/stock/stock-reconcile-concurrency.vitest.test.ts', expect: 3 },
  { name: 'set-stock-source end to end (08 S8: preview per listing, a non-owner refused, the owner switches to the lent stock and undo switches back, other business not found)', file: 'src/services/stock/stock-source-tool-postgres.vitest.test.ts', expect: 4 },
  { name: 'a purchase order moves once (08 S9: five sends at once, one e-mail; a send racing a cancel, one wins)', file: 'src/services/supply/po-transition-concurrency.vitest.test.ts', expect: 3 },
  { name: 'one receive per arrival through the route (08 S10: five identical receives add the stock once; two different ones end at one)', file: 'src/services/supply/receive-concurrency.vitest.test.ts', expect: 3 },
  { name: 'an order line is taken once (re-reads, oversold lines, surplus holds and splits, reconcile, races; Amazon FBM, Shopify, MCF)', file: 'src/services/order-stock-once-postgres.vitest.test.ts', expect: 21 },
  { name: 'one stock model across channels (crash heal, multi-line totals, cancellation after shipment, races)', file: 'src/services/stock-model-postgres.vitest.test.ts', expect: 51 },
  { name: 'assortment copy test (AE.3)', file: 'src/services/assortment/copy-run.vitest.test.ts', expect: 8 },
  { name: 'shared stock race test (pool doors)', file: 'src/services/stock-pool/stock-pool-concurrency.vitest.test.ts', expect: 6 },
  { name: 'shared stock end to end (switches, worker, cascade)', file: 'src/services/stock-pool/stock-pool-e2e.vitest.test.ts', expect: 9 },
  { name: 'shared stock by SKU end to end (no product share: connect by SKU, every listing, real-time wake under 2 s, D1 SKU lock, disconnect)', file: 'src/services/stock-pool/stock-pool-sku-e2e.vitest.test.ts', expect: 7 },
  { name: 'listing end times (Sync Control, the job, the database rule)', file: 'src/services/listing-end-times.vitest.test.ts', expect: 25 },
  { name: 'shared stock orders (sales, holds, cancellations, returns, repair, stock pages)', file: 'src/services/stock-pool/stock-pool-orders.vitest.test.ts', expect: 24 },
  { name: 'transactional eBay order writer (atomic lines and stock, shortfalls, races, locks, attribution)', file: 'src/services/ebay-order-writer-postgres.vitest.test.ts', expect: 35 },
  { name: 'eBay mixed own and pool stock (global Product locks, durable cancellation retries)', file: 'src/services/ebay-order-pool-postgres.vitest.test.ts', expect: 12 },
  { name: 'eBay ORDER_CONFIRMATION execution (held until switched on; seller checked; one read, own account, atomic receipt)', file: 'src/services/cx/ingress/ebay-order-processing-postgres.vitest.test.ts', expect: 20 },
  { name: 'an eBay order notice racing the poll on one order (own and pool stock, both arrival orders, one notice per line): one order, each line once, stock once', file: 'src/services/cx/ingress/ebay-order-notice-race-postgres.vitest.test.ts', expect: 5 },
  { name: 'eBay order notice run now (a kick and the minute sweep at once: one claim, one read, one write; holds, other business, a job through runWorkspaceJob under row security, sweep fallback)', file: 'src/workers/ebay-order-notice-postgres.vitest.test.ts', expect: 6 },
  { name: 'order cancellation gives back what the order took at ingest, never shipped units (eBay, Amazon FBM/FBA, Shopify; markers, races, re-run, owner notice)', file: 'src/services/order-cancellation/order-cancellation-postgres.vitest.test.ts', expect: 17 },
  { name: 'invoice and credit-note numbers (counter conflict key; sequential, and a forced race gives 1…N with no duplicate or gap; two businesses each number their own series)', file: 'src/services/fiscal-numbering-postgres.vitest.test.ts', expect: 6 },
  { name: 'refund cap under a forced race (two returns of one order: what was paid is never exceeded)', file: 'src/services/refunds/refund-cap-postgres.vitest.test.ts', expect: 2 },
  { name: 'live product sync (AE.4: capture, worker, overrides, images, SKU, variations, listener)', file: 'src/services/assortment/sync.vitest.test.ts', expect: 16 },
  { name: 'shared copy into a business with no marketplace (AE.3)', file: 'src/services/assortment/copy-unknown-market.vitest.test.ts', expect: 3 },
  { name: 'Link copy: variations inherit an attribute with no column in the receiving business (AE.3)', file: 'src/services/assortment/copy-inherited-attribute.vitest.test.ts', expect: 3 },
  { name: 'media plan layers (images rebuild P1: edits to one layer, compare-and-swap retry under a real race, account, alias and Amazon market checks)', file: 'src/services/images/media-plan.service.vitest.test.ts', expect: 22 },
  { name: 'product media pop-up save (Lane C: one save bound by expect; two pop-ups on one set or one list, one wins; a gallery save is announced)', file: 'src/services/images/media-popup-save.vitest.test.ts', expect: 4 },
  { name: 'price door race (product sheet Step 2.2 Gate 2, A-17 retry)', file: 'src/services/pim/price-door-concurrency.vitest.test.ts', expect: 13 },
  { name: 'draft listings race (product sheet create path step 2: two concurrent first saves create one set)', file: 'src/services/pim/draft-listing-postgres.vitest.test.ts', expect: 2 },
  { name: 'publication batch races (sheet publish parity step 5: two senders claim once, cancel vs send, two batches from one set of reviews)', file: 'src/services/pim/publication-batch-postgres.vitest.test.ts', expect: 3 },
  { name: 'mixed Publish lifecycle children (build shape v2 P6: two resumes of one batch, and two runs past the header, never send a Status change or Delete twice)', file: 'src/services/pim/publication-batch-lifecycle-postgres.vitest.test.ts', expect: 2 },
  { name: 'live listings race (step 7: two recorders, or a draft creator and a recorder, leave one live row)', file: 'src/services/pim/live-listing-postgres.vitest.test.ts', expect: 2 },
  { name: 'first theme save race (product sheet create path step 4: two concurrent version-0 saves, one draft, one 409)', file: 'src/services/pim/family-projection-postgres.vitest.test.ts', expect: 1 },
  { name: 'eBay price read-back dedupe (JSON-path key, classes, 24 h, per business)', file: 'src/services/ebay-price-readback-postgres.vitest.test.ts', expect: 4 },
  { name: 'master-price currency refusal (own transaction, caller rollback and commit)', file: 'src/services/master-price-currency-postgres.vitest.test.ts', expect: 3 },
  { name: 'pending readiness vs a concurrent rebuild (attributes P2)', file: 'src/services/pim/readiness-pending-race.vitest.test.ts', expect: 2 },
  { name: 'transaction commit conflict (real adapter error, fresh snapshot and committed effects)', file: 'src/lib/database-context-postgres.vitest.test.ts', expect: 1 },
  { name: 'one sheet operation = one transaction (250 rows, one readiness rebuild, row savepoints, RLS, two operations at once)', file: 'src/services/products/bulk-save-postgres.vitest.test.ts', expect: 5 },
  { name: 'platform batch saves (SQL budget, per-unit receipts, rollback, content, formulas, runtime RLS and same-token race)', file: 'src/services/products/bulk-save-platform.vitest.test.ts', expect: 14 },
  { name: 'qualified content receipts (final pairs after the real producer, producer failure, restarted attempts, a Name B race, unit rollback)', file: 'src/services/pim/content-version-receipts-postgres.vitest.test.ts', expect: 5 },
  { name: 'eBay family clear (21 and 105 rows within 15 statements a row, a forced sibling race, savepoint and attempt rollback, runtime RLS)', file: 'src/services/products/ebay-family-clear-postgres.vitest.test.ts', expect: 5 },
  { name: 'product cache batch writes (exact values, parents, deletion, full rollback, runtime RLS and retry races)', file: 'src/services/product-read-cache-batch.vitest.test.ts', expect: 7 },
  { name: 'category tree races (moves, creates, memberships and workspace commands serialize on the tree lock)', file: 'src/services/category-tree-concurrency.vitest.test.ts', expect: 5 },
  { name: 'Amazon Ads drift closes on evidence, per profile (structural reconcile under row security)', file: 'src/services/advertising/ads-structural-reconcile-postgres.vitest.test.ts', expect: 1 },
  { name: 'automation brakes per business (ads dial and halt, fleet halt, review mailer pause, the breaker / target ACOS / halt Claude tunes, and the R16 engine switches: one business never stops another; legacy ids kept)', file: 'src/services/automation-state-two-business-postgres.vitest.test.ts', expect: 5 },
  { name: 'the live bid brain (BB-6: an owned campaign gets exactly the brain\'s writes and a shadow one none, a rerun writes nothing, another engine refused by the gate, a stop and a person pass, the person\'s bid held, engines leave it, give-back restores the snapshot and AB-2 the strategy a stop switched, LIVE needs the approver\'s code)', file: 'src/services/advertising/bid-brain/live-postgres.vitest.test.ts', expect: 6 },
  { name: 'an owned campaign\'s hourly plan through the brain (BB-7: placements once inside the CPC ceiling, rank-defend leaves it, the receipt; a Min-bid hour floors every keyword with one anti-flap entry; the hour after gives the bids back in one write; the floors\' memory and a hand-back given back by rank-defend; op shadow refused without memory; light ticks; out of stock and back, a refused give-back, a plan switched off during its floor; a stop declared during a Min-bid hour stays, a second owner\'s stop outlives the first; op shadow refused while a give-back waits; the second owner\'s stop takes the mark at its own floor when the first lifts, and the retail guard lifts it once it no longer flags the campaign; a Min-bid hour zeroes every placement in the same tick, the serving hour sets the lanes again, a give-back brings the LIVE-time placements back; AB-2: a monthly-cap stop on an up-and-down campaign at 900 % top of search zeroes the lanes and switches to down only in the same tick, 60¢ → 3¢, the lift gives the bids, lanes and strategy back exactly, another engine may not touch the strategy, a campaign not owned and a shadow ceiling get nothing; a second stop the same UTC day keeps down only until the next day; a person\'s own strategy during a stop is a hold the brain leaves until it ends; with the switch off the stop owner\'s restore (or a person\'s Restore) gives the lanes and strategy back; op shadow, approved, puts them back and clears them; op live is refused while a memory is still owed; a give-back whose placement write is refused keeps the saved lanes, says so, and runs again)', file: 'src/services/advertising/bid-brain/plans-postgres.vitest.test.ts', expect: 19 },
  { name: 'the bid brain\'s auto-undo hook (BB-10: one run-completed event per run that wrote, with each bid\'s action-log row; hold and release, the later end wins; a held campaign gets no raise; a brain change an approved undo put back pins its keyword and holds its campaign 7 days; an AUTO undo of a brain cut stays through the next ticks)', file: 'src/services/advertising/bid-brain/hook-postgres.vitest.test.ts', expect: 4 },
  { name: '"New attribute" race (sheet pop-up A3: two creates of one name leave one attribute and one family link)', file: 'src/services/pim/own-axis-attribute-postgres.vitest.test.ts', expect: 1 },
  { name: 'Shopify sheet draft saves racing (Lane B: one winner per cell, nothing lost, a refused save is not in the draft)', file: 'src/services/shopify/channel-sheet-race-postgres.vitest.test.ts', expect: 2 },
  { name: 'Shopify sheet root-creation proof (one action across 1,000-cell requests; business, account, family, alias and actor bounds; recreated roots; current cell state; expiry; refusal, rollback and a forced first-create race; lost answer)', file: 'src/services/shopify/channel-sheet-root-proof-postgres.vitest.test.ts', expect: 18 },
  { name: 'Claude for one business never reaches another (MCP.8: every tool with the other business\'s ids, header and query, membership, role, revocation, approvals, tool policy, one URL per business and the same SKU in both, trust levels, Pause and activity, shared accounts, canary scan)', file: 'src/routes/mcp-cross-business-postgres.vitest.test.ts', expect: 26 },
  { name: 'identity: own channel ids another business holds, named only to its members (MCP full control I5: no probe, deleted and ASIN ignored, runtime-only EXECUTE, audit check #2)', file: 'src/services/identity/identity-foreign-postgres.vitest.test.ts', expect: 8 },
  { name: 'identity: a merge against a concurrent stock write or order (MCP full control I11: the merge waits and refuses, two merges of one duplicate — one wins)', file: 'src/services/identity/identity-merge-postgres.vitest.test.ts', expect: 5 },
  { name: 'a 200-step change plan (MCP full control C6: one approval, a stopped worker resumed, two workers at once, each step exactly once, a stale step skipped)', file: 'src/services/agents/change-plan-postgres.vitest.test.ts', expect: 2 },
  { name: 'identity: one channel item, two businesses, the same moment (MCP full control I12: report mode both succeed with one claim; enforce mode one wins)', file: 'src/services/identity/channel-item-claim-postgres.vitest.test.ts', expect: 2 },
  { name: 'Claude\'s approved bulk bid change and an engine write on one target (MCP full control A7: both queued, one claim wins, the other waits for it)', file: 'src/services/advertising/ads-claude-bulk-postgres.vitest.test.ts', expect: 2 },
  { name: 'Sells from: a sale takes stock from the first listed location with enough (Step 2)', file: 'src/services/stock/sale-location-postgres.vitest.test.ts', expect: 6 },
  { name: 'sealed cases under concurrency (Step 3: ten sales at once end at floor(units / case size), a case count racing a sale, a case size replaced while a sale runs)', file: 'src/services/stock/stock-cases-postgres.vitest.test.ts', expect: 3 },
  { name: 'Send to FBA races (Step 4: a double-click on Send to Amazon sends the draft once with one set of holds, cancel releases the holds once, Mark shipped twice moves once, Mark shipped racing a sale keeps units and sealed cases right, two Add to draft at once make one draft and two sends hold once)', file: 'src/services/fba-inbound/fba-send-postgres.vitest.test.ts', expect: 5 },
  { name: 'the ads brain map (AB-3: each lever\'s owner on a GALE IT shape from what is set up and from the action log — the brain and a market rule clash on LIVE campaigns, auto-bid\'s writes as evidence, a person\'s budget, an old write left out; one campaign; the market\'s products; clashes and the gaps — a keyword blocked where it is targeted, a harvest rule with no destination, a keyword two products bid on; setup — engines held off with their fix, a product LIVE one campaign at a time but not enrolled)', file: 'src/services/advertising/brain/read-map-postgres.vitest.test.ts', expect: 4 },
  { name: 'one owner per lever at the real write gate (AB-5: nothing enrolled — every automatic write as before; a product\'s brain owns budgets, state, negatives and harvest — a rule\'s budget raise, keyword pause, negative retire, new negative and new keyword refused through the real write paths, naming the lever and the brain, nothing left behind; the brain, a person and the safety owners pass, another product\'s campaign and the keyword bids as before; OBSERVE refuses nothing; the Owner\'s lock refuses the brain too, a person passes, the lock holds a shared campaign, ending it frees the lever; another business with nothing enrolled as before; an excluded campaign as before)', file: 'src/services/advertising/brain/gate-levers-postgres.vitest.test.ts', expect: 7 },
  { name: 'engines leave a lever a product\'s brain owns before they ask (AB-6: nothing enrolled — a rule\'s budget action writes as before; GALE\'s budgets owned — the rule\'s action on its campaign a named skip, nothing written, BRAIN_OWNED:budgets counted, MISANO\'s written; a budget schedule enters its window on MISANO\'s campaign only and its line says so; a live pool keeps GALE\'s budget and shares the rest; the Owner\'s lock the same in its words (OWNER_LOCKED:budgets), ended frees it; another business as before)', file: 'src/services/advertising/brain/engine-skips-postgres.vitest.test.ts', expect: 6 },
  { name: 'the negatives module (AB-10: its log table under row security; nothing enrolled — nothing decided, nothing written; the jacket in shadow — its playbook set in every keyword and auto ad group, the waste term exact where it served, the home\'s term isolated, a rule\'s negative over a term that converted where it stands revived, never the brand, the protected term or the shared campaign, nothing at Amazon, a rerun changes nothing; AUTO owned — each add written as the brain through the one negative write service and the real gate with its audit row, the revive queued, a rerun writes nothing; not owned — an excluded campaign takes nothing, the gate refuses the brain\'s negatives actor on another product\'s campaign, OBSERVE only logs; PROPOSE — one change plan waiting for a person, a rerun asks nothing again; the negatives view — the day decided now, every entity against the limit, the log, the market\'s logs, money hidden without the ad-spend permission; another business sees nothing)', file: 'src/services/advertising/brain/negatives-postgres.vitest.test.ts', expect: 7 },
  { name: 'the term ledger and the market arbiter in shadow (AB-9: its two tables under row security; nothing enrolled — the tick decides and writes nothing; the enrolled jacket — one decision per term: targeted, harvest candidate with its own exact destination, negate candidate past the pooled test and the spend gate, brand and protected terms PROTECTED, a keyword blocked in its own ad group targeted with the clash, too little evidence watched, the shared campaign\'s terms no product\'s; two siblings on one term → one lead by profit per click, the other capped at 0.8 × its bid; nothing at Amazon; a rerun changes nothing, an order turns a negate candidate to watch, a term that left is removed; the terms view — stored, by state, the market, a dry run stored nowhere, every amount hidden without the ad-spend permission; both levers OFF → not due, the prune still runs; another business sees nothing)', file: 'src/services/advertising/brain/terms-postgres.vitest.test.ts', expect: 6 },
  { name: 'Amazon\'s own rules on brain campaigns (AB-4: the snapshot table under row security; no read while the bid brain is not live and no product is enrolled; the LIVE campaign, then every campaign of the enrolled product read once, archived and another product\'s left out, another business reads none; each rule on a brain campaign a clash and a writer of its lever, one elsewhere apart, setup says what was read; ending an adopted OBSERVE where Amazon runs the bids is refused by name and changes nothing, a budget rule does not refuse bids, back to a known strategy it passes)', file: 'src/services/advertising/brain/native-rules-postgres.vitest.test.ts', expect: 7 },
  { name: 'the money shadow (AB-7: the log table under row security; nothing planned with no product enrolled; the ads-brain money view plans a product before it is enrolled — its envelope, pace, brake, portfolio-cap plan and campaign budgets, a step bounded around the day\'s logged opening — and stores nothing; enrolled, one row, a rerun none (one base move a day), the next day a change, the day after a snapshot, the Owner\'s cap a change, nothing at Amazon; the plan beside the logged one, the market split, every amount hidden without the ad-spend permission; the 30-day prune also with nothing watched, budgets OFF not planned, another business nothing)', file: 'src/services/advertising/brain/budget-shadow-postgres.vitest.test.ts', expect: 6 },
  { name: 'the Marketing Stream at ad group × placement grain (BB-16: both tables under row security — invisible to another business, refused without one, forced, policy and reference guard; the same Amazon ids in two businesses are two rows and the row-count guard counts one business\'s rows, its capped-day mark the capped business\'s alone; one record delivered on eight connections at once adds once; twenty different records on one new row at once all add, one row created; a redelivery waiting on the uncommitted first delivery adds nothing, a different record waiting adds)', file: 'src/services/advertising/ams-grain-postgres.vitest.test.ts', expect: 5 },
  { name: 'the money writer (AB-8: nothing enrolled — nothing planned, asked or written, the money actor refused on the bid brain\'s LIVE campaigns, their budgets unchanged; OBSERVE logs only; PROPOSE asks one request a day for the campaigns and one for the cap, a rerun none; AUTO through the real gate queues the base moves and a rung past the day-move ceiling as the brain with its evidence and writes the monthly cap, others untouched, a rerun writes and logs nothing, a rule\'s same rung refused; the next day the ladder goes back to its base, Amazon\'s cap usage read; the Owner\'s lock, his cap amount and the spend floor win; a cap above the value cap is held before any write and said once a month, the person\'s own portfolio path refused above it too; six runs asking one request at once make one; the caps\' usage read once at a full slot for a product at PROPOSE / AUTO, never at a 15-minute tick or at OBSERVE; another business nothing)', file: 'src/services/advertising/brain/budget-live-postgres.vitest.test.ts', expect: 9 },
  { name: 'the state lever (AB-12: the log table under row security; nothing decided with nothing enrolled; JACKET out of stock with a purchase order due in 10 days logged as a SHADOW pause, nothing queued; at AUTO the brain\'s pause through the real status path and gate — one queued status write as the brain, its memory logged, the stop\'s memory untouched, the excluded campaign left alone, a rerun writes nothing; the brain\'s state writer refused where no brain owns the lever; a person\'s pause held; stock back, the pause resumed to ENABLED with only the status written; the Owner\'s lock refuses the brain in his words; a dead campaign asked for archiving through the real approval queue once, never archived; another business decides and sees nothing; the ads-brain view state stores nothing; a resume refused at dispatch waits 24 hours, then lands)', file: 'src/services/advertising/brain/state-postgres.vitest.test.ts', expect: 12 },
  { name: 'the brain\'s hourly research, painting and proposal (AB-13: its table under row security — invisible to another business, refused without one, forced, policy and reference guard; nothing enrolled → nothing read, stored or asked; OBSERVE → researched from the stored hours and daily reports, painted (Min bid at night where nothing converts and the spend is real), stored in shadow, nothing asked or written, not due again the same day; PROPOSE with one hour locked → one approval request carrying the research, the grid, the expected effect and the lock, the plan unchanged, a second ask refused; rejected → the plan exactly as it was, REJECTED; approved → the painted week saved as a new version as the approver, the locked hour kept, the members\' schedules too, recorded for undo through set-hourly-bid-plan, the next research paints nothing more; the Owner\'s edit after the painting → the approval not run, his edit kept; the view with money hidden without ad-spend money; another business nothing)', file: 'src/services/advertising/brain/hours-postgres.vitest.test.ts', expect: 9 },
  { name: 'the harvest module (AB-11: its table under row security; nothing enrolled — nothing decided; OBSERVE — one SHADOW harvest per candidate with its exact destination, start bid and sources, the excluded campaign left, the glove\'s new campaign, nothing at Amazon, a rerun only stamps; PROPOSE under the live ceiling — the pair asked of a person, the new campaign asked through create-ad-campaign; approved — the keyword and both source negatives as one change set carrying the approval, DONE, judged after 7 days + 72 h, not run twice; AUTO — the brain\'s pair through the real gate as its actor, a source off the allowlist refuses its negative so neither half is written, a failed negative leaves it HALF_DONE and the next run completes it; judged WORSE after the window — the undo asked of a person, approved: the keyword paused and the negatives retired; the harvest view with its money hidden; another business nothing)', file: 'src/services/advertising/brain/harvest-postgres.vitest.test.ts', expect: 8 },
  { name: 'a product\'s brain (AB-1: its tables under row security; the campaign → product resolver on real rows; enrolling adopts the bids lever, keeps own campaigns in shadow with an adopted OBSERVE and writes no campaign row; adopted brakes hold, ending one is a big door that runs only on its approved basis; an excluded or bids-locked campaign leaves the bid brain and the per-campaign tool refuses it; an exclusion wins on a shared LIVE campaign; the tool\'s op shadow is kept as a campaign choice; settings campaign > product > default with the warning never above the maximum; two changes on one version, one wins; refusals, a weaker outer transaction included, change nothing; a product lock holds a campaign set to AUTO by hand; an exclusion on a campaign at a brain floor waits, held; bids OBSERVE takes the own campaigns back to shadow, a HELD one included, and names the campaigns it does not reach; give-back always runs once a product is enrolled — archived campaign, deleted family root, plain; a stop\'s saved settings still owed make a named skip of the product\'s AUTO, and its shadow step gives them back)', file: 'src/services/advertising/brain/enrollment-postgres.vitest.test.ts', expect: 16 },
  { name: 'the shadow bid brain (BB-3: allowlisted IT/DE keywords only, no write path, changes and a daily snapshot stored, halt and stale-data brakes, 30-day prune, one business; BB-4: why, what-if, diff; BB-5: a TACoS target with its band from the family\'s sales; BB-8: overrides from their sources, the bids going back; BB-9: a rule\'s bid action on an owned campaign stored as the brain\'s input and obeyed)', file: 'src/services/advertising/bid-brain/shadow-postgres.vitest.test.ts', expect: 9 },
  { name: 'the bid brain\'s lag curve and nowcast (BB-15: the curve table under row security, fitted from nightly copies and the 1d/7d seed, rewritten by a rerun, none in another business; before any curve shadow and on decide exactly as off; with it shadow keeps every decision byte for byte and names the nowcast\'s difference in the why; on ends the window yesterday and decides what the shadow named; the read tool\'s calibration view)', file: 'src/services/advertising/bid-brain/lag-curve-postgres.vitest.test.ts', expect: 5 },
]
const IMAGES = ['pgvector/pgvector:pg17', 'postgres:17', 'postgres:17-alpine']
const DEAD = 'postgresql://nobody@127.0.0.1:1/real_pg_no_stray_writes_test'
const DURATIONS = join(ROOT, 'scripts', 'ci', 'real-postgres-durations.json')

/** Measured wall milliseconds per suite file; used only to balance --part. A suite with no entry counts as 1 s. */
function measured() {
  return existsSync(DURATIONS) ? JSON.parse(readFileSync(DURATIONS, 'utf8')).files ?? {} : {}
}

// Part 1 also runs the postgres job's one-off steps (ci.yml): durability off and the image pull ~4 s, RBAC coverage
// ~8 s, the migration upgrade check ~11 s, the database package ~9 s (medians of 15 CI runs, 2026-09-29). Their 32 s
// are 5 % of the 630 s the suites took in the same runs (median), so part 1 starts the split with 32/630 of the
// suites' total. A share, not seconds: the stored times are local, and a refresh on a faster or slower machine
// scales them all. Moving a step between parts, or a step that becomes much slower, means changing this number.
const PART_ONE_HEAD_START = 32 / 630

/** `count` parts of `suites`, balanced by `weights`, part 1 with its head start; each part keeps the SUITES order. */
function split(suites, count, weights) {
  const files = suites.map((suite) => suite.file)
  const headStart = PART_ONE_HEAD_START * files.reduce((sum, file) => sum + (weights[file] ?? 1000), 0) // 1 s: as shards()
  return shards(files, count, weights, [headStart]).map((bin) => suites.filter((suite) => bin.files.includes(suite.file)))
}

/** What is wrong with `parts` as a split of `suites`: every suite must be in exactly one part, unchanged. */
function checkParts(suites, parts) {
  const problems = []
  const same = (a, b) => a.name === b.name && a.file === b.file && a.expect === b.expect
  for (const [i, part] of parts.entries()) if (part.length === 0) problems.push(`part ${i + 1}/${parts.length} has no suites`)
  // One line per suite file. A file listed twice is placed once per copy, so its placement says nothing more:
  // the duplicate is the fault, and its line names the parts it reached.
  for (const file of new Set(suites.map((suite) => suite.file))) {
    const copies = suites.filter((suite) => suite.file === file).length
    const where = parts.flatMap((part, i) => part.filter((s) => s.file === file).map(() => i + 1))
    const distinct = [...new Set(where)]
    const named = distinct.length > 1 ? `parts ${distinct.join(' and ')}` : `part ${distinct[0]}`
    if (copies > 1) problems.push(`listed ${copies} times in SUITES${where.length ? ` (placed in ${named})` : ''}: ${file}`)
    else if (where.length === 0) problems.push(`in no part: ${file}`)
    else if (where.length > 1) problems.push(`in ${where.length} places (${named}): ${file}`)
  }
  for (const suite of parts.flat()) {
    const listed = suites.find((s) => s.file === suite.file)
    if (!listed) problems.push(`in a part but not in SUITES: ${suite.file}`)
    else if (!same(listed, suite)) problems.push(`name or expected count changed on the way: ${suite.file}`)
  }
  return [...new Set(problems)]
}

const expected = (suites) => suites.reduce((sum, suite) => sum + suite.expect, 0)

// Proves the check refuses each kind of bad split, on the real list. A static gate (scripts/ci/run-static-gates.mjs).
if (args.includes('--self-test')) {
  const weights = measured()
  const failures = []
  for (const count of [1, 2, 3, 4]) {
    const problems = checkParts(SUITES, split(SUITES, count, weights))
    if (problems.length) failures.push(`the real split into ${count} was refused: ${problems.join('; ')}`)
  }
  if (JSON.stringify(split(SUITES, 2, weights)) !== JSON.stringify(split(SUITES, 2, weights))) failures.push('two splits of one list differ')
  const [one, two] = split(SUITES, 2, weights)
  const doubled = [...SUITES, SUITES[0]]
  const planted = {
    'a suite listed twice': [doubled, [one, two]],
    'a suite in no part': [SUITES, [one, two.slice(1)]],
    'a suite in both parts': [SUITES, [one, [...two, one[0]]]],
    'a suite twice in one part': [SUITES, [[...one, one[0]], two]],
    'a changed expected count': [SUITES, [[{ ...one[0], expect: one[0].expect + 1 }, ...one.slice(1)], two]],
    'a suite not in SUITES': [SUITES, [[...one, { ...one[0], file: `${one[0].file}.planted` }], two]],
    'an empty part': [SUITES.slice(0, 1), split(SUITES.slice(0, 1), 2, weights)],
  }
  for (const [fault, [suites, parts]] of Object.entries(planted)) if (checkParts(suites, parts).length === 0) failures.push(`not refused: ${fault}`)
  // A duplicate is placed once per copy; the refusal still names it on ONE line.
  const lines = checkParts(doubled, split(doubled, 2, weights)).filter((p) => p.endsWith(`: ${SUITES[0].file}`))
  if (lines.length !== 1) failures.push(`a suite listed twice gave ${lines.length} lines, not 1: ${lines.join(' | ')}`)
  if (failures.length) { console.error(`❌ real-PostgreSQL split self-test:\n${failures.map((f) => `  ${f}`).join('\n')}`); process.exit(1) }
  console.log(`✓ real-PostgreSQL split self-test: splits into 1–4 parts hold all ${SUITES.length} suites once; ${Object.keys(planted).length} planted faults refused`)
  process.exit(0)
}

// Which suites THIS run owns. Checked before Docker, so a bad split fails even where Docker is missing.
const partArg = args.includes('--part') ? /^(\d+)\/(\d+)$/.exec(flag('--part') ?? '') : null
const part = partArg ? { index: Number(partArg[1]), count: Number(partArg[2]) } : null
if (args.includes('--part') && !(part && part.index >= 1 && part.index <= part.count)) {
  console.error(`❌ --part must look like n/m (part n of m, e.g. 1/2), got ${flag('--part') ?? 'nothing'}`)
  process.exit(1)
}
const record = flag('--record')
if (args.includes('--record') && !(record && !record.startsWith('--'))) {
  console.error(`❌ --record needs a file to write, got ${record ?? 'nothing'}`)
  process.exit(1)
}
if (args.includes('--write-durations') && (part || flag('--suites'))) {
  console.error('❌ --write-durations needs a whole run of SUITES (no --part, no --suites): times from a part would change the split the other parts read')
  process.exit(1)
}
const parts = split(SUITES, part?.count ?? 1, measured())
const problems = checkParts(SUITES, parts)
if (problems.length) {
  console.error(`❌ real-PostgreSQL tests REFUSED — the split does not run every suite exactly once:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  process.exit(1)
}
const RUN = parts[(part?.index ?? 1) - 1]
if (args.includes('--list')) {
  for (const suite of RUN) console.log(`${suite.file}\t${suite.expect}`)
  process.exit(0)
}
if (part) console.log(`real-PostgreSQL part ${part.index}/${part.count}: ${RUN.length} of ${SUITES.length} suites, ${expected(RUN)} of ${expected(SUITES)} expected passes`)

const docker = (...cmd) => execFileSync('docker', cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim()

function skip(reason) {
  console.log(`⚠ real-PostgreSQL tests SKIPPED — ${reason}. They prove no stock update is lost under concurrency and that a shared-product copy completes end to end; run them where Docker is available.`)
  // In CI, or with --required, a skip measured nothing and must fail (docs/ci-plan.md §2.3).
  process.exit(args.includes('--required') || process.env.CI === 'true' ? 1 : 0)
}

try { docker('info', '--format', '{{.ServerVersion}}') } catch { skip('Docker is not available here') }
const image = IMAGES.find((name) => { try { docker('image', 'inspect', name); return true } catch { return false } })
if (!image) skip(`no PostgreSQL 17 image on this machine (docker pull ${IMAGES[0]})`)

const name = `nexus-real-pg-${process.pid}`
const reportDir = mkdtempSync(join(tmpdir(), 'nexus-real-pg-'))
let started = false
let preserveEvidence = false
const stop = () => {
  if (started) {
    started = false
    try { docker('stop', name) } catch { /* already gone */ }
  }
  if (!preserveEvidence) rmSync(reportDir, { recursive: true, force: true })
}
process.on('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(130) })

try {
  docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '--tmpfs', '/var/lib/postgresql/data', image)
  started = true
  const port = docker('port', name, '5432/tcp').split('\n')[0].split(':').pop()
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    try { docker('exec', name, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'); ready = true } catch { spawnSync('sleep', ['0.5']) }
  }
  if (!ready) { console.error('❌ real-PostgreSQL tests: the throwaway PostgreSQL did not become ready in 30 s'); process.exit(1) }
  // --owner production: the suites connect as a NON-superuser that bypasses row security — the rights
  // production's migration role was measured with (neondb_owner: rolsuper false, rolbypassrls true) — so
  // every door, trigger and policy is created and run without a superuser (shared stock plan risk 8).
  const owner = flag('--owner') ?? 'production'
  if (!['superuser', 'production'].includes(owner)) { console.error(`❌ --owner must be superuser or production, not ${owner}`); process.exit(1) }
  const user = owner === 'production' ? 'nexus_owner' : 'postgres'
  if (owner === 'production') {
    for (let i = 0; i < 20; i++) {
      try { docker('exec', name, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE ROLE nexus_owner LOGIN NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE'); break }
      catch (error) { if (i === 19) throw error; spawnSync('sleep', ['0.5']) }
    }
    console.log('real-PostgreSQL tests run as nexus_owner (NOSUPERUSER BYPASSRLS CREATEDB CREATEROLE)')
  }

  const reportPath = join(reportDir, 'report.json')
  const run = spawnSync('npx', ['vitest', 'run', ...RUN.map((suite) => suite.file), '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`], {
    cwd: API,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_TEST_CONCURRENT_PG_URL: `postgresql://${user}@127.0.0.1:${port}/postgres`,
      DATABASE_URL: DEAD,
      DIRECT_URL: DEAD,
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    // 15 minutes. At 10 the CI step ran 9 m 41 s – 9 m 58 s on most runs of 2026-09-28 (database start included), so
    // a slow runner timed out with no test failed: one PR check and one deploy that day. The job's own 20-minute limit
    // still holds, and a real hang still ends the run.
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  let report = null
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { /* judged below as "no report" */ }

  // A suite's wall time: its tests plus the import and setup before them. The suites run one after another, so
  // this is the time from the previous suite's end to its own; vitest's per-file time leaves out the import and
  // setup, a third of the run measured 2026-09-30 (186 of 558 s). The time is on each ✓ line, so a CI log shows how
  // even the parts really are. Only --write-durations, after a whole local run, changes the times the split reads.
  const wall = new Map()
  let previousEnd = report?.startTime ?? 0
  for (const result of [...(report?.testResults ?? [])].sort((a, b) => a.startTime - b.startTime)) {
    wall.set(resolve(result.name), Math.max(0, Math.round(result.endTime - previousEnd)))
    previousEnd = result.endTime
  }

  const verdicts = RUN.map((suite) => {
    const file = report?.testResults?.find((result) => resolve(result.name) === resolve(API, suite.file))
    const statuses = file?.assertionResults?.map((test) => test.status) ?? []
    const count = (status) => statuses.filter((s) => s === status).length
    const passed = count('passed'), failed = count('failed'), skipped = statuses.length - passed - failed
    const ok = file?.status === 'passed' && passed === suite.expect && failed === 0 && skipped === 0
    const detail = file ? `${passed} passed, ${failed} failed, ${skipped} skipped; suite ${file.status}` : 'not in the report'
    const ms = wall.get(resolve(API, suite.file)) ?? 0
    return { suite, ok, ms, passed, line: `${suite.name}: ${detail} (expected ${suite.expect} passed; ${(ms / 1000).toFixed(1)} s)` }
  })

  if (run.status === 0 && report && verdicts.every((v) => v.ok)) {
    for (const v of verdicts) console.log(`✓ ${v.line}`)
    console.log(`✓ real-PostgreSQL tests passed (throwaway PostgreSQL, ${image})${part ? ` — part ${part.index}/${part.count}, ${RUN.length} suites, ${expected(RUN)} passes` : ''}`)
    if (record) {
      // The same lines as --list, so db-security can compare the parts' records with the whole list.
      writeFileSync(record, verdicts.map((v) => `${v.suite.file}\t${v.passed}\n`).join(''))
      console.log(`✓ recorded ${verdicts.length} passed suites in ${record}`)
    }
    if (args.includes('--write-durations')) {
      // One run is not enough: local times move with the machine's load. On 2026-09-30 the same 55 suites took 558 s,
      // then 331 s, and a split from one run was 58/42 by the other's times; from both averaged, 51/49 by either.
      // So a refresh averages this run with the stored times, the stored ones scaled to this run's total: the newest
      // run weighs half, the one before a quarter, and so on. A suite new to the file takes this run's time.
      const stored = measured()
      const known = verdicts.filter((v) => stored[v.suite.file] > 0)
      const scale = known.reduce((sum, v) => sum + v.ms, 0) / (known.reduce((sum, v) => sum + stored[v.suite.file], 0) || 1)
      const time = (v) => (stored[v.suite.file] > 0 ? Math.round((v.ms + stored[v.suite.file] * scale) / 2) : v.ms)
      const files = Object.fromEntries(verdicts.map((v) => [v.suite.file, time(v)]).sort(([a], [b]) => a.localeCompare(b)))
      const note = 'Per-suite wall time (ms), import and setup included, from whole local real-PostgreSQL runs; only used to balance --part. Each --write-durations refresh averages its run with the stored times, so the newest run weighs half. measuredAt is the UTC time of the last refresh.'
      writeFileSync(DURATIONS, `${JSON.stringify({ '//': note, measuredAt: `${new Date().toISOString().slice(0, 16)}Z`, files }, null, 2)}\n`)
      console.log(`✓ wrote ${verdicts.length} suite times to ${relative(ROOT, DURATIONS)} (${known.length} averaged with the stored times)`)
    }
    process.exit(0)
  }
  console.error(`❌ real-PostgreSQL tests FAILED${part ? ` (part ${part.index}/${part.count})` : ''} — vitest exit ${run.status}${report ? '' : '; no JSON report was written'}`)
  for (const v of verdicts) console.error(`${v.ok ? '  ✓' : '  ✗'} ${v.line}`)
  preserveEvidence = true
  writeFileSync(join(reportDir, 'output.log'), output)
  for (const file of report?.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') console.error(`FAILED TEST: ${assertion.fullName}\n${(assertion.failureMessages ?? []).join('\n')}`)
    }
  }
  console.error(`Full local test evidence retained at ${reportDir}`)
  // A disposable database's teardown logs the backends that blocked its DROP on one line (concurrent-database.ts).
  for (const line of output.split('\n').filter((l) => l.includes('[real-pg] '))) console.error(line)
  // Hook failures can leave every assertion green and JSON's file.message empty.
  // Surface the actual failure before ordinary application/Redis log noise.
  const hookFailure = output.indexOf('Failed Suites')
  if (hookFailure >= 0) console.error(output.slice(hookFailure).split('\n').slice(0, 40).join('\n'))
  console.error(output.split('\n').filter((l) => /FAIL|AssertionError|Error:|expected|skipped/.test(l)).slice(0, 40).join('\n'))
  process.exit(1)
} finally {
  stop()
}
