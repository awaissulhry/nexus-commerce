# FS4 — Write integrity & hot-path auth (binding spec)

Closes the FS-workstream items deferred from FS1: C-3 (non-transactional multi-step writes), S-9 (per-request 3-level session join + minute-cadence sliding writes), S-10 (mention resolution scans all users), S-17 (fire-and-forget pragmas), plus login lockout and the generalization of EPO.1's optimistic-concurrency precedent. No time estimates.

## Changes

1. **Transactions (C-3).** `$transaction` around every multi-step write sequence the FS0 audit flagged: gmail-sync `upsertMessage` (conversation upsert + message create + work-semantics patch), worker snooze-wake and follow-up loops (per-conversation), quote send (version freeze + state + outbound message + conversation bump), convert (order + lines + quote update), order payments (payment + WO unblock), stage finish + material consume, PO receive (movements + state), team-service already-transactional paths verified. Short transactions only (WAL discipline); the worker's long loops wrap per-item, never per-batch.
2. **Pragma hardening (S-17).** Boot-time verification: read back `journal_mode` — if not WAL, log loudly and refuse mutating routes (a silently-non-WAL DB under two processes is corruption-adjacent); explicit `busy_timeout=5000` PRAGMA (not just adapter option), `cache_size=-64000` (64 MB), `mmap_size` tuned; one place (`db.ts`), asserted by a boot log line the gate report quotes.
3. **Session hot path (S-9).** Per-process TTL cache (30 s) for `validateSessionToken` keyed `tokenHash:permissionsVersion-of-user` — the existing rbac cache pattern extended one layer down. Revocation semantics: permission changes already bump `permissionsVersion` (cache-busting); explicit logout/revoke also deletes from the local cache; the residual ≤30 s window for cross-process revocation is accepted and documented (single-web-process reality). Sliding-expiry write stays throttled as-is. Target: authed GET = ≤1 DB query steady-state (measured on the harness).
4. **Mention lookup (S-10).** `User.handle String? @unique` (additive), derived at user create/rename (`first.last` collision-suffixed), backfilled in-migration; `resolveMentions` becomes indexed lookups over the parsed handles with the legacy full-scan as fallback ONLY when a handle misses (typo tolerance), bounded.
5. **Optimistic concurrency.** EPO.1 shipped `expectedUpdatedAt` on order transitions (D-6) — FS4 promotes it to a shared helper (`assertNotStale(model, id, expectedUpdatedAt)` → 409 "changed elsewhere") and adopts it on: quote PATCH (deposit/dates/state), settings config PATCH, contacts PATCH, price-list entry writes. UI surfaces already know the 409-refresh pattern from EPO.
6. **Login lockout.** The schema's dormant `failedLoginCount`/`lockedUntil` become real: 5 consecutive failures → 15-minute lock (423 with remaining-time message; audit `login.locked`), counter reset on success; lock state surfaced in Team page's member row (owner visibility). Rate-limit by user, not IP (single-site reality).

## Test plan
Unit: stale-guard helper, handle derivation/collisions, lockout state machine. Harness: concurrent-writer scenario (web mutations + worker ticks hammering 60 s) — zero user-facing SQLITE_BUSY, zero partial writes (post-run invariant sweep); authed-GET query-count probe before/after (expect 3→1). Gates: full check suite + parity (no money paths touched) + live click-through (login lockout + a 409 stale edit).

## Rollback
Single revert; migration additive (`User.handle` nullable). Transactions are behavior-preserving on success paths.
