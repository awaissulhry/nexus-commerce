# Product sheet reliability release — 2026-09-15

## Fixed

- Listing edits avoid rebuilding readiness for unrelated accounts and markets.
- Unsaved formulas and unconfirmed edits stay protected when closing a record, changing scope, leaving the page or preparing publication.
- Publish retains provider receipts and uncertain outcomes for reconciliation. Amazon message correlation and eBay duplicate/stale-review handling no longer invent a safe retry or confirmed delivery.
- Cell history follows the selected field, language, account and alias and records source previous values.
- Variation themes display a readable summary in the drawer and use the dedicated sheet editor for changes.

## Validation and release path

Before release, the combined API and product-studio/shared-grid selections passed 3,509 tests, with two existing conditional skips. API/web typechecks, token checks, raw-control checks and the API production build passed. The local drawer and formula protections were checked in the browser at desktop/mobile sizes and in light/dark themes. The repository's pre-push hook supplies the remaining release checks, including authenticated editor gates and the web production build.

Push the reviewed commits to `main`. The existing Deploy API workflow builds and uploads that checkout to Railway, carries the full commit SHA in `apps/api/.release-sha`, and waits for the public readiness route to identify that build. Vercel deploys the web application from the same GitHub commit. Successful release verification requires the production Vercel target and Railway readiness build to match the pushed commit, along with successful CI and production HTTP checks.

No schema, migration, dependency or environment-variable change is part of this release. Deployment does not submit or revise marketplace listings. Controlled live save timing, provider processing and full field read-back remain separate measurements; mocked transport tests do not establish them.

## Rollback

The verified preceding production application commit is `5fa63d310bc56f1f9fabc372537f650161ea0341`. The API deployment is `d7339fde-eec6-4b7f-9ff0-6c0909ce154c`; the corresponding Vercel deployment is `dpl_2xfjztPwXe5n7m8V3hND9daPX9Gw`. Preserve these references until the new build is healthy.

If the release fails readiness, introduces request failures, or causes a confirmed data-integrity regression, restore both providers to those preceding deployments and verify API health and the web application. This release adds no migration to undo. Preserve saved product changes and publication receipts; never replay an uncertain marketplace submission as part of rollback.

Detailed evidence: [autosave and publication diagnosis](2026-09-15-product-sheet-autosave-diagnosis.md), [additional Graphify findings](2026-09-15-product-sheet-graphify-follow-up.md).
