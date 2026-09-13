# Presence migration record — 2026-09-13T18:47:41.781817+00:00

**LOCAL APPLIED and VERIFIED. PRODUCTION NOT APPLIED.** Repository schema/client declaration remains held by the explicit both-database sequencing rule; no full W2-SCHEMA-APPLIED or AT-WAVE-4 gate is claimed.

Forward SQL: `packages/database/prisma/migrations-pending/20260913180000_pr_presence/migration.sql`.
Rollback: sibling `migration.rollback.sql` (separate Owner approval required; never executed on either application DB).
SHA256: `12c5bad77d4933f7b39350d37bd7d3513027fd6943810caf70e96c55d7dd2d4d`.

| Step | Host / target | Time UTC | Result |
| --- | --- | --- | --- |
| Stage | Local repository, migrations-pending | 2026-09-13T18:43:30.045Z | Latest M1 + all W1.1–W1.6 gates DONE |
| Apply | `127.0.0.1:55439/nexus_development`, Docker `nexus-development-postgres-20260908` | 2026-09-13T18:43:58.441Z | SQL committed, exit0 |
| Verify | Same local DB | 2026-09-13T18:44:48.779Z | 68/68 checks, exit0 |
| Grants gate | Same local DB | 2026-09-13T18:44Z | exit0; 0 new violations; 2 existing baseline RLS gaps |
| Production | `ep-purple-river-altf6t3y.c-3.eu-central-1.aws.neon.tech/neondb` | preflight2026-09-13T18:36:33.120Z | NOT APPLIED; separate prerequisite scope pending |

Local checks prove all14 ChannelListing fields nullable/defaultless with correct types/precision; all21 ListingIdentity fields, required defaults and no FKs; ENABLE and FORCE RLS with the exact workspace/active-membership predicates in USING and WITH CHECK; one policy for nexus_workspace_runtime; actual runtime SELECT with355 Product rows as positive control; CRUD privileges; valid unique coordinate/external-id index with ordinary NULL semantics; valid product-coordinate read index;0 retained identity rows and0 newly stated listing rows at apply verification. GALE version59 remained the positive control.

[Apply receipt](local-apply.json), [verification SQL/results](verify-schema-local.json), [required grants-gate output](table-grants-local.log), [28-check isolated SQL/rollback rehearsal](rehearse-presence.json).

The first verifier run returned66/68 because `pg` decoded PostgreSQL catalog `name[]` as a string. Casting catalog names to text[] corrected the instrument; the two actual indexes already matched the exact required columns. SQL/index requirements were not changed. Final68/68 is an independent read-only rerun. The grants gate's negative control reported both missing-grant and missing-policy violations for its temporary table, rolled it back, and confirmed it absent. Product passed as its real control. ListingIdentity is not yet in repository schema and therefore is not judged by the schema-derived grants census; the direct verification above covers it. Existing ChannelListingTranslation and ReadinessIndex policy gaps remain attributed in that gate; no baseline was changed.

## Authorization and continuation

The Owner's terminal instruction “I'll go with⡀your recommendations, so please get it⠂ ⠈all done.” is recorded verbatim, including original line breaks, in the ledger as additive Presence apply approval. That same approval is not requested again.

The missing production workspace prerequisite is now measured as a broader assignment/backfill/index/policy migration, with a missing AmazonMediaRun dependency. [Exact scope and SQL paths](prerequisite-review.md). The original brief requires a separate answer for any non-additive/backfill/data change; scope clarification is pending. Production has not been written.

The prompt's local-continuation instruction is satisfied by preserving the applied local schema and marking production NOT APPLIED. It does not produce a false both-database receipt: the prompt also explicitly requires both databases verified before repository declaration/moving the folder. These operations remain ready to execute after the prerequisite is resolved. No prisma generate or API tsc is claimed for an undeclared model.

M5 is still PENDING-OWNER: account identity + actual on/off reading of eBay's out-of-stock preference. No answer inferred from migration approval.

No backfill, production/channel write, commit, event/Etsy/SaleStop table, ETSY enum, snapshot nullability change, queue FK change, or variationExcluded declaration. Only the staged additive Presence SQL was applied locally.
