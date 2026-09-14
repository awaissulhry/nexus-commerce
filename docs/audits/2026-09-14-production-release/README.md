# Production release preflight — September 14, 2026

The requested release promotes the complete development checkout to GitHub main, Railway's `@nexus/api` production service, and Vercel's `nexus-commerce` production project. No development environment variables or database fixtures belong in the production upload.

## Validation before push

- API: 8,947 tests passed, 28 existing skips; 722 test files passed, six skipped. The four live-catalog characterization files run in successive Vitest projects to avoid observing each other's temporary rows.
- Web: 4,447 tests passed, one existing skip; production web and API builds passed. The normal pre-push hook must still pass on the release commit.
- Browser: all 14 control-census surfaces passed, including both Variants states, the mapping dock and Generate modal. Full first/early/settled gesture and geometry checks passed. Focused parity and refused-formula checks passed after correcting virtualized-column measurements and passing the exact refusal reason into the existing SourceIndicator tooltip prop. The full hook remains the push gate.
- A complete custom-format production backup was restored into disposable local PostgreSQL databases. The final fresh restore ran all 15 pending migrations through `prisma migrate deploy`, including the production migration history.
- All 338 products and 977 listings retained identical identity and original-column content hashes before and after migrations. No catalog or listing-ID backfill ran during this preflight.
- The current API's routed Prisma client read full Product and ChannelListing records and a live Matrix with 21 family rows and 20 coordinates from the migrated clone.
- All 433 registered application tables passed the runtime-access audit. Temporary rows proved own-workspace access and denied both other-workspace and nonmember reads for ChannelListingTranslation, ReadinessIndex, and SellerReferenceLabel. Every test row was rolled back.

## Deployment corrections

LX4/LX5 had already been applied to production before the workspace runtime role existed. Their conditional grants had therefore done nothing, and the workspace migration predates those tables. `20260914_runtime_projection_access` converges their grants, membership-aware RLS, and reference guards to the canonical workspace policy generator; it also completes the seller-label cache's isolation. Existing migration checksums are unchanged.

Railway builds the container before its startup command applies migrations through the direct Neon endpoint. The workflow no longer pre-applies migrations while Railway is still building. Railway's configured `/api/health/ready` check must pass before traffic switches, and the GitHub workflow verifies the serving commit.

## Existing deployment conditions

The Vercel production alias `https://nexus-commerce-three.vercel.app` and Railway URL `https://nexusapi-production-b7bb.up.railway.app` were reachable before this release. Vercel lists `app.xavia.it` as an alias, but both public DNS and the local resolver returned NXDOMAIN; Vercel reports a third-party DNS configuration problem. That condition predates this deployment.

The restored production ReadinessIndex and ListingIdentity tables both contained zero rows. Their derived-data and identity backfills require a post-deployment audit against production records. Development's additional products include fixtures and must not be copied wholesale.

The private backup, detailed test logs, migration receipts, and runtime evidence are retained outside the repository under `/private/tmp/nexus-release-20260913`; credentials and production dumps are excluded from version control.

## Control census follow-up

The first push stopped at the census without uploading. Amazon image navigation now uses the existing `sm` Input/Select/Button sizes; Generate uses `sm` inputs, and its SKU-pattern wrapper no longer shrinks vertically inside Field. No shared design-system component changed.

The census now measures the record drawer against the visible global header (AppShell renders it on Studio), recognizes the explicit empty attributed-activity state, and waits for the separate family response before pressing Generate. Variant selection is measured once per logical row across AG's pinned/center fragments, after NexusGrid's deferred pinning and AG's opening animation settle. The entire 43px selection cell must precede identity; selecting rows must still leave channel inclusion unchanged. The full unfiltered census passed with all API writes blocked except the existing dry-run combination preview.

## Hosted install and framework follow-up

The complete development release reached GitHub as `d8677ae9a` after the normal pre-push gate passed. GitHub's clean installation then exposed `postinstall-postinstall`: the helper chooses Yarn merely because `yarnpkg` is installed, despite this repository declaring npm. Removing that Yarn-only helper retains the root `postinstall: patch-package` hook. A separate clean source copy passed `npm ci` with the hosted runner's Node 22.23.2 and npm 10.9.8, including the AG Grid patch.

The hosted audit also reported the framework's [AVIF image optimization vulnerability](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) and [Windows server vulnerability](https://github.com/advisories/GHSA-p293-qw3h-jr36). Web, Factory, and the database package now pin Next.js 16.3.5. The follow-up production dependency audit reports zero critical findings and no Next.js finding; 55 other advisories remain (30 high, 24 moderate, one low), so this is not a claim that the dependency tree has no outstanding advisories.

Next 16.3 removed the numeric Turbopack memory option. Both app configurations retain disabled development filesystem caching and remove the ignored option; the new eviction mechanism requires filesystem caching, so it is not represented as a replacement cap. Automatic generation of app-level agent instruction files is disabled to preserve the maintained repository instructions.

Vercel promotion remains held while the corrected release is validated. A supplemental Product/ChannelListing data backup completed at 13:51 UTC and passed a complete `pg_restore` read without database writes, supplementing the earlier full production backup. The product and listing identity baseline remains 338/977.

## Railway readiness correction

Railway built `d8677ae9a` and successfully applied all 15 migrations, but rejected the container after its five-minute health-check timeout. The prior healthy container continued serving. A read-only production inspection found no long-running SQL or locks; the runtime shared one database connection between workspace transactions, cron tasks, workers, and health diagnostics.

The API now defaults to a bounded pool of eight connections, with an explicit deployment override available through `NEXUS_DATABASE_POOL_MAX` (1–20). Serverless consumers retain the database library's one-connection default. The existing workspace adapter still establishes role and scope with `SET LOCAL` inside every transaction. A new public readiness endpoint checks database access without scanning queue or advertising history; the existing detailed health endpoint remains available. Regression coverage verifies readiness success, database failure, private error handling, and public authorization.

The corrected API suite passed 8,950 tests across 723 files, with 28 existing skips. The readiness and permission suites passed again after moving the probe query into its service; the route architecture ratchet also passed. The local API answered the new readiness route successfully. Hosted cutover and the complete pre-push gate remain required before promotion.

## Product page replacement and content continuity

`/products` mounts `ProductsNextClient`. Historical `/products/[id]/edit` links now redirect to the rebuilt `/edit/studio`, retaining product identity, market, language, account and listing parameters; historical channel and variation tabs map to their studio destinations. The retired editor's form skeleton no longer flashes at the entry point. Eight redirect regressions passed, and a signed-in browser followed the historical GALE editor URL into the studio with `market=IT`, showing 21 family rows and existing Amazon listing titles and ASIN.

A read-only comparison using the migrated production backup verified all 338 populated native product content fields and 2,044 populated channel content fields through the current content resolver, with zero differences. Every listing had a resolvable marketplace/language address. The one populated legacy localized-content value also matched; no retired channel locale bags were present. Master descriptions were empty in the source catalog, while existing descriptions reside on channel listings. Copying channel-specific text into empty shared fields is a separate content-authoring choice, not required to retain those listing descriptions.

CLI uploads now carry a source revision marker generated from GitHub's checkout SHA. Readiness reads that marker for CLI builds and Railway's provided commit for native GitHub builds; tests cover both and reject malformed markers. This prevents a healthy container with unknown or stale provenance from passing the workflow's release check.
