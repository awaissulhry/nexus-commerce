# Images (Media) page rebuild — progress

Branch `feat/images-studio-rebuild` · worktree `/private/tmp/nexus-images-studio` · plan [PLAN.md](PLAN.md)

## Summary
- **P0 measure — done (2026-09-27).** Production counted read-only: [MEASURE.md](MEASURE.md).
- **P1 data spine — built and tested locally (2026-09-27). Not committed, not pushed.** Nothing on the screen
  changes yet; no channel is called; with no plan rows every existing page and publisher behaves as before.
- **Next:** the Owner's word to commit and open the P1 pull request (the deploy runs the migration in production),
  then P2 (publishers read the plan).

## P1 — what was built
| Piece | File | What it does |
|---|---|---|
| Plan model | `packages/shared/media-plan.ts` | Sets (Common, per value, per SKU, swatch, safety), three layers with follow/own, edit ops (insert, remove, move, reorder, own, follow, axis, swatch). Repeats: never twice in one set; Common + a colour set on purpose (D8). Language versions count as one photo. |
| Channel layouts | `packages/shared/media-plan-channels.ts` | eBay (gallery + one set per value, in the family value order, named per market), Amazon (MAIN/PT01–08/SWCH per child, safety), Shopify (media + variant image), Etsy (20 + variation photo). Language version per market (D6). Checks: limits (block, never cut), too small, no Common, value without photos, unmapped value, Trading URL length, what does not fit (named). |
| File names | `packages/shared/media-plan-files.ts` | Reads set, position and language from a file name; groups language versions. |
| Table | `ProductMediaPlan` + migration `20260927i_media_plan` | One row per layer; revision for compare-and-swap; workspace RLS + grant; `ProductImage.languageTag` (`zxx` default) and `versionGroupId`. |
| API | `services/images/media-plan.service.ts`, `routes/images/media-plan.routes.ts` | `GET /api/products/:id/media` — family, axes (dictionary option keys), library, layers, destinations (Amazon per account; eBay per market × account × alias), each destination's layout and checks. `POST /api/products/:id/media/ops` — edits to one layer, account and alias checked, retried once on a concurrent change. |
| Event | `product.media.changed` | Catalogue entry, SSE bus, browser bridge → invalidation `product-media.changed`. |
| Permissions | `permissions-manifest.ts` | Read: every role that can view products. Edit: `products.images.edit` (Admin, Ops manager) — the Product media column's rule. |
| Backfill | `apps/api/src/scripts/backfill-image-facts.ts` | Fills missing width/height/mime/size and dhash256 (MEASURE: 419 + 214 photos). Dry run by default; `--apply` fills only NULL fields. Not run anywhere yet. |

## P1 — how it was checked
- Unit tests: plan 13, channel layouts 13, file names 6 — all pass. Four deliberate code breaks (value order, cutting
  at 12, the old "remove Common from colour sets", no language pick) were each caught.
- Service tests: 7 pass on PGlite with business profiles on and off, and on a throwaway PostgreSQL 17
  (`scripts/run-real-postgres-tests.mjs`, suite added). With the retry removed on purpose, the real race fails the
  test — so the retry is exercised, not assumed.
- Permission matrix: 60 pass (the new routes grant exactly what `/product-media` grants).
- Typecheck: api, web, shared, events, database — all exit 0.
- Guards: event contract, route-Prisma ratchet, context boundary, gateway ratchet, model ownership, policy parity,
  column drift — all pass.
- Migration: CI's upgrade check on a throwaway PostgreSQL 17 — "the PR's migrations produce the database a fresh
  environment gets" (policies, RLS flags and 1,813 grants identical); `baseline.sql` regenerated (only this change);
  database package tests 55 pass.

## P1 — known limits (by design, handled in later phases)
- Value and axis **names** in the layouts are the Shared ones; each market's own names (value maps, pins) come in P2
  from the same resolver the publishers use.
- A destination counts the variants listed on it; the variation projection's "excluded" flag is added in P2.
- eBay API path (Trading vs Inventory) is not yet known to the read; P2 fills it (it decides the URL-length check).
- Read timing on real data is not measured yet (needs a local copy of a real family); done at the start of P3.
