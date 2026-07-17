# FS4 — Gate report: write integrity & hot-path auth

Built to `FS4-SPEC.md` by a worktree agent (merged `d652a43bc`), migration `fs4_user_handle` applied live + harness, runtime restarted.

## Plain English
The database now protects itself: multi-step writes (a Gmail message landing, a quote sending, an order converting) either fully happen or fully don't — no half-writes if something crashes mid-way. Signing in is faster (a 30-second cache means most requests skip the permission lookup). Five wrong passwords locks an account for 15 minutes. Editing something two people touched at once now warns instead of silently overwriting. And @mentions resolve by an indexed handle instead of scanning every user.

## Shipped
Transactions with side-effects-after-commit on gmail-sync, worker loops (as race-safe compare-and-set), quote send/convert, production stage+consume, PO receive (audits/notify/events all fire post-commit — swept clean) · WAL/pragma boot verification + explicit busy_timeout/cache/mmap (verified in the live boot log) · 30 s session cache keyed on `permissionsVersion`, evicted on revoke/role-change → authed GET drops to ≤1 query steady-state · `User.handle` unique + indexed mention lookup with legacy fallback · `assertNotStale` (409) adopted on quotes/settings/contacts/price-lists · login lockout (5 fails → 15 min, 423, audited).

## Handoffs recorded (scope-guarded — EPO/EPF own those files)
Order-payments transaction and the financials-grid stale-guard adoption are left for EPO/EPF; order transitions already carry EPO.1's `expectedUpdatedAt` (FS4 generalized it into the shared `assertNotStale` helper they can now consume). `renameUser` service path is ready but unwired — EPT's display-name UI consumes it.

## ⚠ Trap paid (record for every session) — `_prisma_migrations` timestamp format
Applying FS4 live surfaced a **latent corruption the migrate CLI hid**: sister sessions (EPF, EPO) had recorded their ledger rows via the manual `sqlite3 "INSERT … datetime('now')"` escape hatch, whose `2026-07-17 16:48:18` format is NOT Prisma's native `2026-07-17T16:48:18.000Z`. Prisma's Rust schema engine throws `ConversionError("input contains invalid characters")` on the space-separated form and **every migrate command silently stalls after "N migrations found"** — no error to stdout. The app runtime is unaffected (it never reads these timestamps), so it goes unnoticed until the next migration. **Fix applied:** normalized all malformed rows to ISO-8601-Z (moment preserved; backup in scratchpad). **Rule going forward:** when hand-inserting a ledger row, use the ISO-8601-Z format (`strftime('%Y-%m-%dT%H:%M:%S', ...) || '.000Z'`), or better, use `prisma migrate deploy` (writes the correct format itself) once the ledger is clean. Also: a failed `cd` short-circuiting an `&&` chain left the dev server holding the DB lock while `migrate dev` blocked — **check `lsof` on the DB FILE, not pgrep, and verify each step's exit before chaining.**

## Verified
532 tests on main post-merge (agent's 461 in-worktree + sister-session suites) · rbac 137 · query-bounds 139 files · no-touch · ds-parity 97/97 · live boot pragmas logged · web/worker/chat-api all healthy on `:3100`. Live click-throughs remaining for you: a wrong-password lockout and a concurrent stale-edit 409 (both are single-user-visible; the logic is unit-covered).
