# Safe deployment and dictionary correction

The reviewed formula migration and dictionary correction were applied to the isolated local development database at `127.0.0.1:55439/nexus_development`, with target guards and impact evidence. No production migration, product-value correction or live listing write was performed. Field mutation tests used disposable PostgreSQL fixtures and stubbed provider reads.

## Required formula schema migration

`packages/database/prisma/migrations/20260911020000_information_formula_destination/migration.sql` adds account and alias identity to CellFormula and its unique key. It is transactional and changes no Product or ChannelListing values. Existing channel formulas bind to the sole active account or the single active primary account in their workspace. Ambiguous/unavailable accounts stop the transaction rather than guessing.

The [read-only impact capture](evidence/migration-impact.json), generated at the timestamp inside the file, found **zero legacy channel formulas** and **zero unbound channel recovery operations** in the connected workspace. This is a point-in-time observation; rerun before deployment. Historical formula destinations in any other workspace must be reviewed independently.

1. Back up the intended database and inventory pending migrations using the repository's normal migration workflow. This working tree contains unrelated migrations; do not apply all pending work without reviewing it.
2. From `apps/api`, run the read-only preflight: `../../node_modules/.bin/tsx ../../docs/audits/2026-09-11-information/migration-preview.mts`. Verify the database/workspace target and review every proposed destination.
3. Apply the reviewed migration with the repository's normal migration runner in an authorized staging environment, then deploy the matching generated Prisma client/API. Resolve any ambiguous historical destination explicitly before retrying. The migration has disposable-database tests for successful binding and atomic refusal.
4. Run Information account/alias read and save/reload checks in staging before production rollout. The actual local page initially returned HTTP 500 because the new columns were absent. The guarded local migration resolved that integration failure, and the connected smoke test now passes.

Local execution: `node docs/audits/2026-09-11-information/apply-local-migration.mjs` refuses every target except the isolated development clone and applies only this migration. [Before snapshot](evidence/local-formula-before.json) and [result](evidence/local-migration-result.json) record zero formulas and unchanged 338 Product / 999 ChannelListing counts. Re-running recognizes the exact successful migration receipt. This is not a production deployment runner.

Once independent alias formulas exist, reverting to the old unique key is not a safe automatic rollback. Preserve/export the new coordinates and use the reviewed backup/recovery procedure; never collapse them into primary formulas.

## Optional dictionary definitions

The correction procedure is preview-first and definition-only. From `apps/api`:

```sh
../../node_modules/.bin/tsx ../../docs/audits/2026-09-11-information/correct-dictionary.mts --family=REVIEWED_FAMILY_ID
```

Review its definitions, family links, populated products, mappings and fingerprint. Re-run with the same explicit family arguments plus `--apply=REVIEWED_FINGERPRINT` only in an authorized target. A changed dictionary, mapping or saved value invalidates the fingerprint. The transaction adds missing options and optional family attributes without deleting existing ones. Global definition changes affect every family using that definition; selected family arguments constrain the optional additions, not the global definitions. Refresh affected Information queries after applying definitions. The family schema reads the current dictionary; the actual page was reloaded and verified with 200 family facts / 235 contract columns.

The [local preview](evidence/local-dictionary-preview.json) and [applied result](evidence/local-dictionary-result.json) record the reviewed fingerprint and family ID. `--local-development` restricts the correction CLI to the isolated clone. The local transaction changed zero Product values and zero product family assignments. Production correction remains optional and unapplied.

The concrete preview contains one stored `fabric_type` value (`GALE-JACKET`, `Polyester`) and one historical `size` key with null. “Populated rows” in this preview counts key presence, including explicit null. Historical prose remains source-language fallback after the definition becomes localizable. Measurement values, old units, product bags, family assignments and mappings are not rewritten. No product receives a family automatically.

## Translation compatibility

Canonical localized JSON and legacy ProductTranslation data are read through one adoption contract. New supported writes update both where required; explicit canonical null/list/reset wins over older content. No destructive translation migration is required. Preserve mixed-case regional keys in storage; reads and new writes use a normalized locale identity. Older records without source hashes are not invented as newly reviewed content.
