# P3 — the Media page and the Information column (slice plan)

Written 2026-09-27 after P2 (all publishers read the plan). Design: [PLAN.md](PLAN.md) §5 (approved). This file only
orders the work and records one change to the approved plan.

## Summary
- **Change to the plan (safer):** the approved plan said a family is moved onto the plan "lazily, on first open". A
  family on the plan changes which photos its publishers send, so the move is now an **explicit, per-family step with a
  preview**: "Start using the photo plan" shows, per destination, what the plan would send next to what the family's
  current photo sources hold, and changes nothing on any channel. Publishing stays a separate click.
- Four slices, one PR each: **P3a** switch a family (seed + preview + switch) · **P3b** the page (library, plan,
  destinations, channel views, checks, live refresh) · **P3c** the Information column on the plan · **P3d** polish
  (keyboard, phone/desktop, light/dark, empty/error states, screenshots).
- UI checks run against a **local API on a throwaway database** seeded with an anonymised family — never the
  production API (hard rule 3). Merging P3 PRs needs the Owner's word per PR (the P2 standing OK does not cover P3).

## Measured before P3a (production, read only, 2026-09-27)
Of the 697 legacy eBay builder rows, **515 sit on the 22 old `EBAY_LISTING_SHELL` products** (the extra eBay listings,
e.g. GALE-JACKET-ALT1..3) and only 182 on real family roots. Axis keys are "Color" (421) and "Colore" (126). No row
links to a library photo (`sourceProductImageId` is empty); the shell rows' URLs are in no product library. 18 shells
are still unadopted (4 were adopted as aliases).

**Owner decision (2026-09-27): make the remaining shells aliases** — with the existing, reviewed adoption script
(`apps/api/scripts/pes5-adopt-shells.mts`, ruling "adopt all 22, end nothing": zero eBay calls, reversible), dry run
first, production write only with the Owner's word. Their photos move with the switch below: imported into the master
family's library (deduplicated) and written as that alias's own Listing layer.

## P3a — switch a family onto the plan
- `seedMediaPlan(productId)`: builds the Shared layer from the family's best current curation, in this order:
  1. the previous edit page's eBay builder rows (`ListingImage`, eBay, PLATFORM: Default rows → Common; per-value rows
     → value sets keyed by dictionary option; case twins merged in their order; unmatched values listed);
  2. otherwise the eBay media draft (`_mediaGalleryDraft`) of the primary listing;
  3. otherwise the library order (`ProductImage.sortOrder`) as Common.
  A destination whose own current source differs gets a Listing layer holding exactly that, so it keeps its photos:
  an alias with its own draft, and **every adopted shell alias — its old builder rows, their URLs imported into the
  master library** (download through the safe fetcher, deduplicated by content hash, the original URL kept).
  Amazon stays on the Shared layer; the preview names every Amazon slot that would change.
- `GET /products/:id/media/switch-preview`: per destination — the layout the plan would send, the current source it
  replaces, and the differences by name. `POST /products/:id/media/switch`: writes the layers in one transaction
  (refused if the preview's revision changed).
- The Media page shows the preview for a family not yet on the plan; the older workspaces stay reachable until P6.

## P3b — the page
PLAN.md §5.1–5.4, §5.8 on the design system: library (search, filter, in-use tags, language versions), photo plan
(Common, value sets, swatch, safety, per-SKU fold; drag, "Add to ▾", "Also use in…", make main, remove), destinations
table (🔗/✎ per set, checks, status), channel views with buyer preview, "Show as" market, live refresh on
`product-media.changed`. Writes through `POST /media/ops`; Undo from the returned inverse ops.

## P3c — the Information column
The "Product media" cell reads the resolved row gallery from the plan and edits through the same set editor component;
copy/paste/fill write the target row's set; refresh on `product-media.changed`.

## P3d — polish and proof
Keyboard walk-through, 390 px and 1440 px, light and dark, empty/error/slow states, screenshots in the PR.
