# CX cleanup — 2026-09-22

Scope: Amazon, eBay, Etsy. P8 deferred; Shopify is connected per Owner.

## Slice 1 — guarded dead connection delete

`DELETE /api/admin/connection-dependents/:id` requires `adminPurge`. It deletes one explicit ID only. The service locks the named row in the current business profile with PostgreSQL `FOR UPDATE`, checks that it is not active/primary/connected/degraded and holds no encrypted, generic or legacy credentials, then counts all Prisma-derived dependents through the SAME transaction and calls `isSafeToDelete()` again. ReadCommitted sees a FK writer that committed while the lock waited. Incomplete counts or cascading dependents return 409; missing/foreign rows return 404. No channel call. SetNull history survives, with the count returned.

Proof: 40 focused tests pass (including existing report tests); 15 service tests first failed because deletion did not exist. Two real PostgreSQL tests pass, none skipped, through the scoped client and RLS: empty row actually deleted; an in-flight ConnectionScope insert makes deletion wait, then refuse, with both rows retained. Added to the existing real-PostgreSQL push runner. Three mutations applied (exactly one replacement each), killed by the focused suite, and original bytes restored: omit safe verdict; ignore incomplete counts; ignore legacy refresh token.

Commands: `npm test -- src/services/connection-delete.vitest.test.ts src/services/connection-dependents.vitest.test.ts src/routes/connection-delete.vitest.test.ts` from apps/api; `node scripts/run-real-postgres-tests.mjs --suites '[{"name":"connection delete","file":"src/services/connection-delete-concurrency.vitest.test.ts","expect":2}]'` from root.

Production deletion has NOT run. Owner must confirm exact IDs after a fresh complete report. Prior production measurement supplied by Owner: 13 eBay rows; 11 with destroyedTotal 0; live primary cmr4aaqb… destroys 15 (13 EbayCampaign); cmt142bli… destroys 1 ConnectionScope and unlinks 2079 ConnectionEvent. Those two are protected. Fresh browser report currently unmeasured: Chrome blocks API navigation with ERR_BLOCKED_BY_CLIENT, and the browser's page evaluator does not provide fetch. The signed-in app DOM positively confirms Xavia Racing.

Release starts from 7c70556ea, verified as remote main. Other session's pes/phase-0 branch and dirty tree are untouched. One package push only after full gates; no deployment yet.

Independent review found the canonical encrypted credential column missing from the initial guard. Added a failing regression (1 failed / 15 passed), then the encrypted-credential refusal. The reviewer found no further required RLS, permission, or race issues.

## Slice 2 — legacy eBay token presence

The report selects both refreshToken and ebayRefreshToken and reports their combined presence. Neither value is returned. Regression first measured 1 failed (legacy column) and 2 passed (generic and empty controls); all 3 pass after the fix. This is presence in these two columns only, not a credential-validity probe or decryption of credentialsEnc.
