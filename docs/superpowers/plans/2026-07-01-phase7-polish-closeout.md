# Phase 7 — Best-in-Class Polish & Close-Out — Plan

> **STATUS: AWAITING USER APPROVAL / PRIORITIZATION — do not implement until approved.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Close the remaining audit gaps and the items deferred during Phases 1–6, taking the system from "complete" to "best-in-class." This phase is a **menu** — the items are largely independent; approve the ones you want and in what order.

**Context:** Phases 0–6 are built, reviewed, and in the mergeable PR `inventory-sync-hardening` (rebased on current `main`). This phase is polish + the explicitly-deferred pieces.

---

## Group A — Quick correctness / cleanup (low-risk, high-value; recommend doing now)

**A1 — Remove dead `outbound-sync-phase9` collapse code.** The audit found `detectAndQueueChanges` / the `(listing+syncType)` dedup in `outbound-sync-phase9.service.ts` is never called; Phase 1's coalesce replaced its intent. Delete the dead path (confirm zero callers first). *Small, pure cleanup.*

**A2 — Journal `followMasterQuantity` toggles.** Audit gap: flipping `ChannelListing.followMasterQuantity` leaves no audit trail (only `updatedAt`), so silent drift between master and listing can't be traced. Write a `ChannelListingOverride`/audit row on toggle. *Small; touches the toggle write path.*

**A3 — Docs/runbook refresh.** Consolidate the new flags (`NEXUS_SYNC_ORDERING_V2`, `NEXUS_OVERSELL_CLAMP`, `NEXUS_RESERVATION_RECONCILE`, `NEXUS_OUTBOUND_PRIORITY`, `NEXUS_LATENCY_WATCHDOG`, `NEXUS_EBAY_READBACK`, `NEXUS_RECONCILE_CRON`, `NEXUS_DRIFT_ALERTS`), the new events, the crons + cadences, and the control tower into a single `docs/INVENTORY-SYNC.md` operator runbook. *Docs only.*

## Group B — Deferred control-tower actions (you asked to "manage it all"; recommend doing now)

**B1 — Per-cell resync.** Enrich the control-tower endpoint to expose `channelListingId` per channel cell (add it to the shaper cell + the aggregation query), then wire a per-cell "Resync" action in the grid to the appropriate existing push path (enqueue a fresh `QUANTITY_UPDATE` / the bulk-action `LISTING_SYNC`). *Backend cell enrichment + one UI action.*

**B2 — Per-marketplace suppress/hold.** Add a thin, audited suppress toggle (pause outbound pushes for a listing/marketplace without delisting — likely a `ChannelListing` flag the dispatch checks), and wire a control-tower toggle. *New (small) mutation path + dispatch guard + UI — needs its own careful review since it changes what publishes.*

## Group C — Larger hardening (each substantial; prioritize individually — some are future work)

**C1 — Velocity-aware safety buffer.** Make `stockBuffer` dynamic for fast movers (higher buffer where cross-channel latency risk is real), to absorb the sale→re-sync window probabilistically. *A policy + a job that sets per-listing buffer from sales velocity.*

**C2 — Per-channel allocation/fencing.** Reserve N units per channel for high-risk SKUs (today all channels draw one unfenced pool). *New allocation model + ATP integration — meaningful design work.*

**C3 — Shopify parity.** The Phase-1 re-read, Phase-2 clamp, and Phase-5 read-back were all built eBay+Amazon-first with Shopify deferred (not transacting). When Shopify goes live, extend all three to Shopify. *Blocked on Shopify being live; do it then.*

**C4 — FBA sellable staleness.** Reduce the 0–15min FBA `SELLABLE` staleness (cron-primary today) by leaning on the `FBA_INVENTORY_AVAILABILITY_CHANGES` SQS notification as the primary path. *Touches the FBA inventory ingest.*

---

## Recommendation
Do **Group A** (quick, safe, closes real gaps) + **Group B** (the control-tower actions you wanted) as Phase 7 now. Treat **Group C** as a prioritized backlog — C3 (Shopify) is blocked until Shopify transacts; C1/C2/C4 are each substantial enough to be their own mini-engagement, best sequenced after the baseline data from the deployed Phases 0–6 shows where the real residual risk is.

Each approved item follows the standard task-by-task flow (plan detail → implement → review). B2 (suppress — changes what publishes) and C-items get extra scrutiny.

## Self-Review
- **Coverage:** every remaining spec/audit item + the Phase 4/6 deferrals is listed (A1–A3 cleanup, B1–B2 control-tower actions, C1–C4 hardening).
- **This is a menu, not a monolith** — items are independent; the plan explicitly asks for prioritization rather than assuming all-in.
- **Risk:** Group A is low-risk; B2 + Group C change behavior and each get their own detailed plan + review before implementation.
