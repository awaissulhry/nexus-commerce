# Production prerequisite review — PR.5

The additive Presence migration is approved by the Owner's latest terminal instruction. This review identifies a **newly measured broader prerequisite**: the existing workspace migrations perform data assignment and replace indexes. The original PR.5 brief requires an Owner answer for any non-additive change, backfill or data change. No production write has been attempted.

## Evidence

Both connections used `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and rolled back; script exit 0. Exact SQL, parameters, per-query timestamps and sanitized results: [prerequisite-preflight.json](prerequisite-preflight.json). Executable scratch script: `/private/tmp/nexus-pr5-presence/prerequisite-preflight.mjs`.

| Reading | Local Docker | Production, direct Neon connection |
| --- | --- | --- |
| Host | `127.0.0.1:55439/nexus_development` | `ep-purple-river-altf6t3y.c-3.eu-central-1.aws.neon.tech/neondb` |
| Database time | 2026-09-13T18:36:32.515Z | 2026-09-13T18:36:33.120Z |
| Product / ChannelListing positive controls | 356 / 1003 | 338 / 977 |
| GALE-JACKET version | 59 | 51 |
| Workspace / Membership / runtime role | present / present / present | absent / absent / absent |
| Active existing owners | 1 | 1 |
| Existing AccountSettings | 1 | 0 |
| Active members eligible for migration | 3 | 1 |
| ChannelConnection rows | 17 | 15 |
| OAuthSession rows | 2 | 0 |
| Scoped assignments / live scoped invitations | 0 / 0 | 0 / 0 |
| Unresolved Prisma failures | 0 | 0 |

Local totals changed since the original Wave 0 snapshot while other approved fixture lanes ran. The original M1–M7 measurements remain timestamped observations, not overwritten with new denominators.

## Exact existing SQL and scope

1. `packages/database/prisma/migrations/20260908_amazon_media_workspace/migration.sql`: creates the currently missing `AmazonMediaRun` table and its two indexes. The workspace isolation migration requires this table. An a/b-only apply would fail.
2. `packages/database/prisma/migrations/20260908a_business_workspaces/migration.sql`: creates the workspace/account substrate, copies one active member and its existing roles into the legacy workspace on current production, assigns 15 connection rows, inserts missing AccountSettings, assigns non-system roles, copies live invitations, writes WorkspaceAudit, and expires unscoped OAuth sessions (current production count 0).
3. `packages/database/prisma/migrations/20260908b_workspace_data_isolation/migration.sql`: assigns `nexus_legacy_workspace` as the existing-row value for **407** added workspace columns, alters **409** tables, replaces natural-key indexes, adds the runtime role/grants and **409** RLS policies, and adds reference/account-route triggers and route data. A constant-column-default assignment is still a backfill semantically, despite avoiding UPDATE statements.
4. Presence SQL: `/private/tmp/nexus-pr5-presence/migration.sql`, to be staged at `packages/database/prisma/migrations-pending/20260913180000_pr_presence/migration.sql` after the latest W1.1–W1.6 statuses are DONE. Adds **14 nullable/defaultless ChannelListing columns**, **21 ListingIdentity fields**, two indexes, its runtime CRUD grants and ENABLE/FORCE RLS policy. No business-data backfill. `productId` and all retained-identity references have no FK.

All 163 unconditional DROP INDEX targets in b exist on production; one required table is missing (AmazonMediaRun above). These are read-only prerequisite checks, **not** a successful migration rehearsal or a deployment compatibility claim.

SHA256 a: `938ec034a1fe34601c4610b590411355a1b8c4d5c90431cbec45bcf129dcdbd9`.
SHA256 b: `2d81aec43005907b95f71e206e4983b42a8bebdfd38b6d8dad9c8447e9a48686`.

## Decision and remaining work

Recommendation: handle the three workspace prerequisites as a separately reviewed database operation, with an isolated rehearsal before any production apply. Keep the Presence migration itself additive and free of backfills. Do not run `prisma migrate deploy`: it would apply unrelated pending folders too. Do not install a policy without the workspace tables or remove its predicates to make it compile.

**Scope clarification for the Owner:** does the latest instruction also authorize this specific broader workspace migration (existing-record assignment and index/RLS changes), in addition to the additive Presence migration already approved? This clarification is required by the original brief's explicit STOP rule for non-additive/backfill/data changes. Until answered, production is NOT APPLIED; authorized Presence staging/local work continues when the W1 gate closes.

M5 remains PENDING-OWNER: the eBay out-of-stock preference is a fact that approval cannot supply. No preference is inferred or changed.

Readiness rider: b changes future workspaceId defaults to the session setting and makes these columns NOT NULL. A safe production rollout must also prove the deployed application supplies the workspace context; bypass-RLS ownership alone does not satisfy a NOT NULL default. No deployed-runtime compatibility claim follows from the successful read-only preflight.

Presence local apply subsequently succeeded at2026-09-13T18:43:58.441Z with68/68 verification checks; see [migration record](migration-record.md). This does not change the pending broader production-scope question.
