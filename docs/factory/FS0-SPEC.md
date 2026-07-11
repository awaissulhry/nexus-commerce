# FS0 — Load harness + baseline (binding spec)

Approved workstream: `FS-FC-PROPOSAL.md` (Owner: "proceed with your recommendation", 2026-07-11). FS0 builds the **measurement substrate** every later FS/FC phase must prove itself against. It changes **zero product behavior**: two scripts + two docs, nothing else.

## Isolation guarantees (non-negotiable)

| Guard | Mechanism |
|---|---|
| Never touches the live DB | Seeder runs ONLY when `FACTORY_DATABASE_URL` contains `scale` AND `FACTORY_ALLOW_DEV_SEED=1` (the gate F1's seed header reserved); refuses a DB that already contains orders |
| Never touches the Owner's server | Measurement runs against `:3199` + `.next-verify` per playbook §10; `:3100` is never bound |
| Fake data never presented as real | Harness DB is a separate gitignored file (`data/scale.db`); synthetic rows carry obviously-synthetic names; playbook rule 5 honored — the live instance never sees a seeded row |
| No live sends | Worker process is NOT started against the harness DB; no GoogleConnection row exists in it |

## Synthetic volumes (the design targets from the proposal, §2)

| Entity | Rows | Shape notes |
|---|---|---|
| Users / roles | 500 (1 OWNER + 499 WORKER) | real system roles via `seedSystemRoles` |
| Parties (+emails) | 800 BRAND/CUSTOMER + 30 SUPPLIER | |
| Conversations | 60,000 | ~2,000 OPEN · 500 SNOOZED (due-scan realism) · rest CLOSED |
| Messages | ~500,000 | most threads 3–15 msgs; one **5,000-message monster thread** (S-4 probe); long-tail threads of 500–1,000 |
| Attachments (metadata) | 30,000 | no bytes on disk |
| Product templates | 20 (+groups/options) | |
| Quotes (+lines) | 60,000 (+~150,000) | realistic state mix for win/loss analytics |
| Orders (+lines) | 50,000 (+~125,000) | states weighted to history (CLOSED/DELIVERED); ~1,500 CONFIRMED · ~800 IN_PRODUCTION · ~300 READY |
| WorkOrders (+stages) | 50,000 (+250,000) | ~1,200 in READY/IN_PROGRESS/BLOCKED (uncapped-board probe, S-6) |
| Materials / lots | 200 / 1,000 | |
| MovementLedger | 1,200,000 | append-only realism (S-2 probe) |
| AuditLog | 800,000 | |
| Invoices / Payments | 30,000 / 60,000 | financials fold probe (S-12) |
| Shipments / tracking events | 40,000 / 160,000 | |
| Notifications | 40,000 | |

Total ≈ 3.4M rows. No `ANALYZE` is run post-seed — the live DB never gets one either; the planner sees what production would see.

## Measurement method

`measure.ts` drives `:3199` over HTTP with a real OWNER session cookie (session row inserted directly; sha256 token per `src/lib/auth/session.ts`), `FACTORY_RBAC_MODE=enforce` so the true guard cost is included. Per route: 2 warm-ups discarded + 20 timed samples, sequential → p50/p95/max + payload size. Plus a 10-way concurrent burst on the three hottest routes (inbox list, production, materials/stock) to expose single-writer/read contention. Route mix = every page's primary API (inbox list/thread incl. monster thread, orders all-states, production, materials/stock, financials + deposits, analytics + counters, quotes, contacts, shipping, search, notifications, users-lite, exports/orders CSV).

SSE (`/api/events`) is deliberately not measured here — its cost model is per-client polling (S-1) and is FS2's before/after target; FS0 records the *design* fact, FS2's gate re-runs this harness with N simulated EventSource clients.

## Deliverables + exit criteria

1. `scripts/scale/seed-scale.ts` + `scripts/scale/measure.ts` (phase-coded headers, gated as above).
2. `docs/factory/FS0-BASELINE.md` — the measured table (route × p50/p95/max × payload), DB file size, seeded-volume manifest, and the §1 cliff list re-ranked by **measured** pain, not predicted.
3. Harness is re-runnable by any later phase in one command each (seed → serve → measure).

**Exit:** baseline table committed; every FS1–FS7/FC gate cites it as its before/after reference.
