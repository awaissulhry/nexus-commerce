# migrations-pending — NOT a Prisma migrations directory

`prisma migrate deploy` applies **every** folder under `prisma/migrations/`. A migration that must
ship in a *later* release than the one before it therefore cannot live there yet, or the two
collapse into a single deploy (`reference_migrate_deploy_drags_parked_migrations`).

Files here are ready-to-run SQL that is **deliberately not yet a migration**. To land one, move it
into `prisma/migrations/<name>/migration.sql` in the release that should carry it.

## Listing aliases — PES.5-ii

The historical `20260901d_pes5_ii_drop_legacy_alias_keys.sql` is superseded by
`prisma/migrations/20260915_pes5_ii_enable_listing_aliases/migration.sql`. The
September 15 migration accounts for the later workspace and aliasKey changes,
preserves nullable-account uniqueness, and completes the cutover authorized for
the GALE import. Use the recorded forward migration, not the historical parked SQL.

## Presence — 20260913180000_pr_presence

Promoted into `prisma/migrations/20260913180000_pr_presence` for the complete development release authorized on 2026-09-13. The forward migration and guarded rollback now have one source of truth there. Production deployment must follow the rehearsal of the workspace prerequisites included in that release.

The historical local apply and verification are recorded in `docs/audits/2026-09-13-presence/measurements/migration-record.md`; that receipt does not establish production status. Forward SQL adds 14 nullable/defaultless ChannelListing columns and the ListingIdentity registry, indexes, runtime grants, and workspace RLS. It performs no product or listing identity backfill.
