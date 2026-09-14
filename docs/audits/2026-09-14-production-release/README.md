# Production release preflight — September 14, 2026

The requested release promotes the complete development checkout to GitHub main, Railway's `@nexus/api` production service, and Vercel's `nexus-commerce` production project. No development environment variables or database fixtures belong in the production upload.

## Validation before push

- API: 8,947 tests passed, 28 existing skips; 722 test files passed, six skipped. The four live-catalog characterization files run in successive Vitest projects to avoid observing each other's temporary rows.
- Web: 4,447 tests passed, one existing skip; production web and API builds passed. The normal pre-push hook must still pass on the release commit.
- Browser: full first/early/settled gesture and geometry checks passed. Focused parity and refused-formula checks passed after correcting virtualized-column measurements and passing the exact refusal reason into the existing SourceIndicator tooltip prop. The full hook remains the push gate.
- A complete custom-format production backup was restored into disposable local PostgreSQL databases. The final fresh restore ran all 15 pending migrations through `prisma migrate deploy`, including the production migration history.
- All 338 products and 977 listings retained identical identity and original-column content hashes before and after migrations. No catalog or listing-ID backfill ran during this preflight.
- The current API's routed Prisma client read full Product and ChannelListing records and a live Matrix with 21 family rows and 20 coordinates from the migrated clone.
- All 433 registered application tables passed the runtime-access audit. Temporary rows proved own-workspace access and denied both other-workspace and nonmember reads for ChannelListingTranslation, ReadinessIndex, and SellerReferenceLabel. Every test row was rolled back.

## Deployment corrections

LX4/LX5 had already been applied to production before the workspace runtime role existed. Their conditional grants had therefore done nothing, and the workspace migration predates those tables. `20260914_runtime_projection_access` converges their grants, membership-aware RLS, and reference guards to the canonical workspace policy generator; it also completes the seller-label cache's isolation. Existing migration checksums are unchanged.

Railway builds the container before its startup command applies migrations through the direct Neon endpoint. The workflow no longer pre-applies migrations while Railway is still building. Railway's configured `/api/health` check must pass before traffic switches.

## Existing deployment conditions

The Vercel production alias `https://nexus-commerce-three.vercel.app` and Railway URL `https://nexusapi-production-b7bb.up.railway.app` were reachable before this release. Vercel lists `app.xavia.it` as an alias, but both public DNS and the local resolver returned NXDOMAIN; Vercel reports a third-party DNS configuration problem. That condition predates this deployment.

The restored production ReadinessIndex and ListingIdentity tables both contained zero rows. Their derived-data and identity backfills require a post-deployment audit against production records. Development's additional products include fixtures and must not be copied wholesale.

The private backup, detailed test logs, migration receipts, and runtime evidence are retained outside the repository under `/private/tmp/nexus-release-20260913`; credentials and production dumps are excluded from version control.
