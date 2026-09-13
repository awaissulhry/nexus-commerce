# migrations-pending — NOT a Prisma migrations directory

`prisma migrate deploy` applies **every** folder under `prisma/migrations/`. A migration that must
ship in a *later* release than the one before it therefore cannot live there yet, or the two
collapse into a single deploy (`reference_migrate_deploy_drags_parked_migrations`).

Files here are ready-to-run SQL that is **deliberately not yet a migration**. To land one, move it
into `prisma/migrations/<name>/migration.sql` in the release that should carry it.

## Presence — 20260913180000_pr_presence

Status 2026-09-13T18:48:20.075463+00:00: LOCAL APPLIED at2026-09-13T18:43:58.441Z; verification68/68 and local grants gate0 (two known unrelated RLS gaps). Production NOT APPLIED; folder stays here. Receipt: docs/audits/2026-09-13-presence/measurements/migration-record.md.

Staged 2026-09-13T18:43:30.045Z. Forward SQL adds 14 nullable/defaultless ChannelListing columns and the 21-field ListingIdentity registry, its two indexes, runtime CRUD grants and ENABLE/FORCE workspace RLS policy. No backfill or identity foreign key. Separate rollback refuses any populated presence field or retained identity.

Apply this file alone to local Docker first; verify columns, grants, policy and indexes. Production additive apply is authorized in PR.5's ledger, but the separately reviewed missing workspace prerequisites must be resolved first (docs/audits/2026-09-13-presence/measurements/prerequisite-review.md). Only after both database applies are verified may this folder move into prisma/migrations and schema.prisma declare it. No migrate deploy, enum change, SaleStop table or variationExcluded declaration.
