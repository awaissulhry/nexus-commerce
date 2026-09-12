# migrations-pending — NOT a Prisma migrations directory

`prisma migrate deploy` applies **every** folder under `prisma/migrations/`. A migration that must
ship in a *later* release than the one before it therefore cannot live there yet, or the two
collapse into a single deploy (`reference_migrate_deploy_drags_parked_migrations`).

Files here are ready-to-run SQL that is **deliberately not yet a migration**. To land one, move it
into `prisma/migrations/<name>/migration.sql` in the release that should carry it.
