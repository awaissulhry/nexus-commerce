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

## Slice 3a — notification verification-token preflight

The shared configuration accessor still resolves the same two variables. A separate pure format check rejects fewer than 32 or more than 80 characters and anything outside `[A-Za-z0-9_-]`, including a trailing newline; it never trims or echoes the secret. Setup returns the clear error before obtaining an app token or making any channel request. Direct destination creation is protected too. Status exposes presence and format validity separately, while retaining its real catalogue reads. The challenge handler still hashes the exact configured string.

Official rule: https://edp.ebay.com/api-docs/sell/notification/resources/destination/methods/createDestination . It maps malformed verification tokens to errorId 195019 and challenge failure separately to 195020. Source checked 2026-09-22.

Proof: malformed-token regressions initially 9 failed / 3 passed. Boundary controls send 32 and 80 allowed characters unchanged through a stub transport; invalid values never reach token or transport. Status tests distinguish a present-invalid token from a valid token, retain the catalogue positive control, and forbid secret disclosure. Existing challenge/routing tests retained. Owner alone changes the production variable.

## Slice 3b — documented order topic, replay preserved

`ORDER_CONFIRMATION` replaces `ITEM_SOLD` in the desired list and primary topic routes. eBay's own release notes name it in 1.6.6 (2025-12-01): https://www.developer.ebay.com/develop/api/notification/release-notes ; the seller topic catalogue describes seller checkout: https://www.developer.ebay.com/develop/api/sell/notification_events . `ITEM_SOLD` remains a legacy replay alias only. `handlerMissing: true` remains: this change cannot enable a subscription that the nightly reconcile intentionally excludes. Runtime subscription code still checks the actual eBay catalogue.

The regression failed before the change and covers both the correct topic and the old replay name. Token preflight mutations (omit character rule; omit minimum length) were each applied, killed, and restored byte for byte. **Application-specific live catalogue remains unmeasured this session**, pending live-call permission and usable signed-in browser API access. Official documentation is not presented as a production measurement.

## Package verification — in progress

API typecheck: passed after building isolated shared/events dependencies. Gateway ratchet: zero EBAY, AMAZON_SP, AMAZON_ADS, SHOPIFY and ETSY violations; zero queue writers outside the owner. Push-lock audit: **one pre-existing violation**, `pim/studio-publication-amazon.ts:164 sendAmazonPublication`. A separate untouched checkout of 7c70556ea reports the identical failure; file SHA-256 matches exactly. No ratchet was changed.

Full API suite with local connections allowed: **11039 passed, 7 failed, 135 skipped**. The same seven failures reproduce on untouched 7c70556ea: five amazon-validation-preview, one amazon-classifications, one database-target root-env premise. The last was checkout setup: the isolated root had no .env. A host/path copy of the real root DATABASE_URL, with username/password removed, satisfies the refusal probe; its 9 tests now pass. No production credential was copied. Six known Amazon failures remain; none of their source or test files was modified. First sandboxed full run was invalid for comparison (localhost EPERM, 28 failures); the unrestricted local run above supersedes it.

Review of the immediate notification setup against eBay's official OpenAPI found additional existing blockers: destination/subscription IDs are in Location headers; destination endpoints are nested under deliveryConfig; subscription payload needs deliveryProtocol HTTPS; enabling uses POST. Reproduction and fixes follow in the next verification slice. Official source: https://developer.ebay.com/api-docs/master/commerce/notification/openapi/3/commerce_notification_v1_oas3.json .

## Verification slice — eBay setup follows the wire contract

Independent transport-level reproductions used eBay's official OpenAPI shapes; all **7 initially failed**. Fixed: Location IDs for destination and subscription creation (empty 201 response); nested deliveryConfig.endpoint normalized into the internal endpoint field; explicit selection excludes verificationToken from diagnostic output; payload.deliveryProtocol is HTTPS and the invented nested includeResourceData object is removed; enabling subscriptions uses POST. A complete-existing-setup control makes exactly three GETs and no writes. The preflight's positive-control fixture now uses the documented empty 201 plus Location too. **48 focused notification tests pass.** No actual eBay call was made.

The real-PostgreSQL race test was also mutation-checked: replace FOR UPDATE with FOR NO KEY UPDATE (one verified source replacement), observe one race test fail, restore original bytes. This proves the test distinguishes the necessary FK-blocking lock from a weaker lock.

Production before release: public `/api/health` HTTP 200, status healthy, serving build **7c70556e**, at 2026-09-22T16:11:19Z. Remote main still **7c70556ea**. These are read-only controls; not proof of this package being deployed.
