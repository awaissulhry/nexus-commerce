# Images (Media) page rebuild — progress

Branch `feat/images-studio-rebuild` · worktree `/private/tmp/nexus-images-studio` · plan [PLAN.md](PLAN.md)

## Summary
- **P0 measure — done (2026-09-27).** Production counted read-only: [MEASURE.md](MEASURE.md).
- **P1 data spine — LIVE (2026-09-27).** PR #86 merged (squash `f1d8b1b7a`) after CI was green. Deployed: worker
  12:03, scheduler 12:00, API 12:29 UTC. Verified in production (read-only): migration `20260927i_media_plan`
  finished, table `ProductMediaPlan` exists with RLS forced and its policy, `ProductImage.languageTag` and
  `versionGroupId` exist; `/api/health/ready` 200; `GET /media` and `POST /media/ops` answer 401 without a login.
  Nothing on screen changed; no family has a plan yet, so every publisher behaves as before.
- **P2 — publishers read the plan (2026-09-27).** All merged: P2a #90, P2b #92, P2c #93 (eBay Trading), P2d #98
  (eBay Inventory, stock-safe), P2e #95 (Amazon), P2f #99 (Shopify). Nothing changes for a live listing until a family
  is switched onto the plan (P3a) — no family in production is switched yet.
- **P3a — switch one family, with a preview (API).** PR #101 merged 2026-09-27 on the Owner's word (squash `902fbfae1`).
  In production the switch endpoints exist; no screen uses them until P3b is merged, and no family is switched.
- **P3b — the new Media page. MERGED 2026-09-27 (#102, squash `90119fb37`) on the Owner's word; deployed (API build
  `90119fb3`, web on Vercel). No production family is switched yet — the first switch is the Owner's click.**
- **P3c — the Information sheet's "Product media" column on the plan. MERGED 2026-09-27 (#112, `b5291447`); deployed.**
- **P3d — polish and proof. MERGED 2026-09-27 (#115, `200afbaa`); deployed.**
- **First real switch — DONE 2026-09-27 on the Owner's authorization ("You do everything for me and go ahead. I authorize
  you"):** the test family GALE-JACKET, through the production Media page after P3d was live. The preview first (read
  through the app): 6 destinations, 0 errors, 0 warnings; ALT1's 14 photos under "Colore" taken in (12 repeats, +1 per
  colour, as the old publisher sent them); 0 downloads. After the switch the read shows Shared + the 4 alias layers
  exactly as previewed (Common 2, Nero 7, Giallo 7; ALT1 8 + 8), 20 variants, 6 destinations, no unmapped values; the
  page read took 482 ms on the server. Nothing was sent to any channel. Effect to know: the eBay flat-file FULL push now
  refuses this family ("Offers only" still pushes price and quantity); the studio's Publish sends the plan's photos.
- **No Arial (Owner, 2026-09-27):** measured in production on the Media page, a channel view, a tile menu, the photo
  preview and the Information sheet — every text element is Inter or JetBrains Mono, both faces loaded
  (`document.fonts.check`). One real source found and removed: the design-system catalog's synthetic example photos drew
  a `sans-serif` label inside an SVG image (system font = Arial on Windows); they draw no text now and the font guard no
  longer excepts that file. The local test photos and the screenshots below were redrawn without text as well.
- **Scroll fix (Owner, 2026-09-27: "the scroll on the images page is not working. It must not ever happen again"):**
  the studio's tab panel is a fixed-height flex box that hid overflow, and the Media page had no scroll area of its own,
  so the wheel did nothing (measured in production: the page 1245 px tall, 0 px scrollable). Now the Media page and its
  loading state own their scroll; the switch preview renders INSIDE the older tab's scroll area (above it, it squeezed
  the gallery to nothing); the tab panel scrolls a tab that forgets (safety net). Guard test
  `plan-page/planPage.scroll.vitest.test.ts`; rule in `apps/web/CLAUDE.md`. Checked locally: wheel scroll on the page
  and on the preview + gallery; all 11 studio tabs have 0 px extra panel height and no panel scroll bar; 390 px = the
  page is its own scroll box, no sideways page scroll; Tab moves through the photos and the page follows the focus.
- **"I still noticed Arial" (Owner, 2026-09-27, screenshot of the switch preview):** measured on the local stack — every
  text run on the page is drawn in Inter (its width equals Inter's, not Arial's). The line "Shared photos would come
  from: …" had no DS size and showed at the browser's 16 px, so it read as a foreign font. The page, the preview and the
  loading state now set `--nds-font-size-base` (13 px); after the fix 0 of 62 (preview) and 0 of 208 (plan page) text
  runs are at 16 px or in a non-DS font. Guarded in the same test file.
- **Library duplicates (Owner, 2026-09-28: "multiple duplicates of the same image … I do not want that to happen ever"):**
  researched and Fix 1 built — one card per picture, copies count as the same photo, family-wide upload check, and the
  four older per-SKU copy writers stop for plan families. Record and next step: [LIBRARY-DUPLICATES.md](LIBRARY-DUPLICATES.md).
- **Next:** P4 (upload dialog with file-name rules, Compare, Review & publish).

## P3d — polish and proof
- **Phone:** under 720 px of page width the destinations table becomes one card per destination (title, markets or API,
  checks, sets with their source, what it would send) — the same pieces as the table, so both say the same thing.
  Measured at 390 px: no sideways page scroll; the library is a drawer; tick + "Add to" works there.
- **Keyboard:** Tab order listed from the page (every stop named; the photo board is 2 stops — one tile and its menu —
  as designed). Found: the library costs 2 stops per photo (about 350 on a 176-photo family before the plan). Fixed with
  a visible "Skip to the photo plan" at the top of the library; it lands on the first photo of the plan.
- **States:** a product with no options says "one gallery for every channel" instead of offering per-SKU photos; a
  destination whose account is paused says so ("reconnect it before publishing"); the open destination's row uses the
  grid's own selected-row paint.
- **Switch, safer (found checking the test family's preview in production, read only):** the old eBay publisher sent the
  builder rows of every spelling of the listing's axis ("Color" and "Colore"), merged per value in position order with
  repeated photos dropped. The switch left the second spelling out (the test family's ALT1 alias: 14 photos). It now takes
  them in exactly as the publisher sent them, and says so in the preview; rows under a different axis are still left out
  and named. Tested (a deliberate break of the rule fails the test).
- **Screenshots** (local stack, anonymised data; "Not HTTPS" tags are the local http photo server):
  [desktop](screens/p3-media-page-desktop.jpg) · [phone](screens/p3-media-page-phone.jpg) ·
  [Information sheet column](screens/p3-sheet-product-media.jpg).

## P3c — the "Product media" column on the plan
| Piece | File | What it does |
|---|---|---|
| Row gallery (shared) | `packages/shared/media-plan-channels.ts` `rowGallery` | Parent row = Common; a variant = its own SKU set, else its value's set, then the Common photos it does not already show; each photo in the sheet language's version. Same resolver as the channel layouts. |
| Sheet read (API) | `media-plan.service.ts` `sheetMediaPlan`, `studio-sheet.service.ts` | For a switched family the cell reads the plan (never the older gallery store): master sheet = Shared; channel sheet = that listing's layers. One extra read (the plan rows) for a family not on the plan. Each row carries `productMediaSet` (the set it edits, how many SKUs share it); a variant's Common photos come `muted`. |
| Cell editor | `_studio/media/PlanSetDialog.tsx` | Enter / F2 / double-click opens the Media page's own set editor (`PlanBoard` + `LibraryPanel`) limited to the row's set and Common; a variant has "Nero · all 3 SKUs" / "This SKU only" (makes or drops the SKU's own set). Saves at once, Undo, "Open the Media page". |
| Copy, paste, fill | `_studio/media/planCellTransfer.ts`, `useMediaCellActions.ts` | A plan cell copies its own set; paste and the fill handle give the target row's set exactly those photos on the sheet's layer (`replace`). Rows sharing a set write it once. The older gallery clipboard and the plan clipboard refuse each other with one sentence. In-cell drag reorder is off for plan rows (the editor reorders). |
| Live | `productMediaColumn.tsx` | The sheet refreshes the family's cells on `product-media.changed` (the Media page, another tab or person). |
| Shared rule | `packages/shared/media-plan.ts` | On Shared a per-SKU set can be dropped (`follow sku:…`) — the SKU shows its value's photos again; its undo is a follow too. |
| DS | `MediaStripItem.muted` | Dashed frame + faded image + "· shared" in the tooltip; mirrored to Factory. |

**Checked (local throwaway stack):** the sheet shows the parent's 3 Common photos and each variant's set + muted Common;
Enter opens the editor on a Nero row; "This SKU only" made the SKU's own set (server read confirms); the fill handle from
a Giallo row onto a Nero row replaced Nero's set while the Nero-M row kept its own SKU set; a change made outside the
sheet showed in the cell within 3.5 s. Clipboard paste could not be driven in the automated browser (the grid's paste
needs clipboard permission); the fill handle runs the same write path. Tests: shared 41, API media-plan 13 (sheet view
on real rows: parent, variant, German version, alias layer), sheet-reading API suites 39 files / 417 tests (five fakes
gained an empty plan table; the query-count guard holds), web studio 161 files / 2,129 tests, static gates 59/59.

## P3b — the Media page (what was built)
| Piece | File | What it does |
|---|---|---|
| Route | `_studio/images/ImagesTabRoute.tsx`, `plan-page/MediaPlanRoute.tsx` | A family on the plan gets the new page on every scope (its older tools refuse it since P2b). A family not on the plan keeps today's tools; on the product scope the switch preview sits above them; on a channel scope one line says where to start it. |
| Switch preview | `plan-page/SwitchPanel.tsx` | `GET /media/switch-preview`: per destination, where its photos come from today, what the plan would send (first photos), and its checks; the seed's report lines. "Start using the photo plan" posts the preview's revision; a stale preview reloads. Nothing is sent to any channel. |
| Page | `plan-page/MediaPlanPage.tsx` | Toolbar (Photos vary by, Show as, Undo/Redo ⌘Z ⌘⇧Z), library beside the Shared plan (a drawer under 1180 px of page width), the destinations table, and one destination's channel view. The studio's channel chips filter the table; a chosen listing opens its view. |
| Library | `plan-page/LibraryPanel.tsx` | Search, filter (unused, in use, size/address problem, has text), where each photo is used ("Nero · main", "Common · 2"), language versions, drag onto a set, or tick + "Add to ▾" (sets and swatches). A set's ＋ Add turns the library into "Adding to Nero". "Upload and edit…" opens today's library tools in place (upload with the duplicate check, edit, delete, videos) until P4's upload dialog. |
| Plan board | `plan-page/PlanBoard.tsx` + DS `MediaBoard` | Common, one row per value in the family order, safety, per-SKU rows (folded), swatches (Amazon). Drag = move, Alt-drag / "Also use in" = copy (the tile says "also in Common"), M = main, Delete = remove from the set, Space + arrows = move by keyboard. Below Shared each row shows Follows Shared / Follows the channel / Own photos with "Use own photos" / "Follow again". |
| Destinations | `plan-page/DestinationsTable.tsx` | One row per destination: where each set comes from and its count, what it would send, checks (to fix / warnings / ready), variants listed. |
| Channel view | `plan-page/ChannelView.tsx` | Edit "this listing only" or "all listings of the channel"; Copy photos from ▾ another destination; Follow the channel (or Shared) for all sets; buyer preview (eBay gallery + value picker, Amazon slots per SKU group, Shopify media + variant images, Etsy photos + option photos); the checks in full. |
| State | `plan-page/useMediaPlan.ts`, `plan-page/model.ts` | One read; each edit moves the page at once (the shared edit rules applied locally, so a refusal is the server's own sentence), then `POST /media/ops`; edits are sent in order. Layouts and checks are computed in the browser by the SAME shared function the publishers use (`projectMediaDestination`). Live refresh on `product-media.changed` (never during a drag or a save); our own saves' echoes are skipped. Save state goes to the studio header. |
| Undo (API + shared) | `packages/shared/media-plan.ts`, `media-plan.service.ts` | New op `replace` (with `expect`) and `inverseMediaOps(before, after)`; every `POST /media/ops` answer carries its `undo` ops, bound to what the layer holds now — an undo after someone else's change to that set is refused and changes nothing. Redo is the undo's own undo. Shared may drop its axis choice (the family default applies). |
| One projection | `packages/shared/media-plan-channels.ts` | `projectMediaDestination` — the API read, the switch preview and the page all call it (moved out of the API service; behaviour unchanged, API tests pass). |
| DS | `MediaBoard`, `MediaCard compact` | Catalog, changelog, DS-GAPS entry; mirrored to Factory. |

## P3b — how it was checked
- Local throwaway stack only: PostgreSQL 17 container on 127.0.0.1 (schema from `bootstrap-fresh-database.mjs`),
  owner login from `bootstrap-owner.ts`, local API HTTP only (no worker, no scheduler), `next dev` with
  `NEXT_PUBLIC_API_URL` = the local API, no `.env` in the worktree. Anonymised families TEST-JACKET (Colour × Size, 9
  variants, old eBay builder rows, alias "Winter" with its own draft) and TEST-GLOVE (library only), labelled
  placeholder photos served from 127.0.0.1 (http, so every eBay check also says "not on HTTPS" — honest).
- On screen: the switch preview, the switch, the page (desktop dark and light), M = main, Space/arrows/Space move from
  Nero into Common, ⌘Z restores it (screen = server read, revision advanced), a library photo dropped on Safety, an
  Alt-drag copy from Common into Nero ("also in Common"), a change made outside the page appearing within 2 s (streams
  on; they are off by default against a local API), 390 px (no page sideways scroll; the library becomes a drawer;
  tick + Add to works there) and 1024 px.
- Tests: shared 15 (plan) — undo round trips on every layer, refusal after a later change; API media-plan 20 (new: the
  answer's undo restores the alias layer and a stale undo is refused); page model 6. Deliberate breaks were each
  caught (no axis undo, no `expect`, copy-from always replacing, wrong "main" label, no language-version rule).
- Typecheck: api, web clean; factory's 338 existing errors are its ungenerated database client, none in the DS.
- Guards: raw primitives, DS conformance, token guard, DS fork drift, api-guard, shadow tokens, i18n, CSS ratchets,
  DS-GAPS append-only, route-Prisma, event contract — all pass.

## P3b — known limits (by design, later steps)
- Uploading stays in today's library tools ("Upload and edit…"); the file-name upload dialog is P4. Compare,
  Review & publish are P4; channel status (read-back) is P5, so the table shows no live status yet.
- The destinations table scrolls sideways inside its own box on a phone; it does not turn into cards yet (P3d).
- Value and axis names on the page are the Shared ones; publishers already send each market's own names.

## P2 — what each channel does for a family on the plan
| Channel | Sends | Safety |
|---|---|---|
| eBay Trading (28 of 36 eBay destinations) | `PictureDetails` = Common in order; one `VariationSpecificPictureSet` per value in family order, named with the listing's own value (pins, value maps) under its axis name; explicit order kept for number-like values | any blocking check refuses the send with its reason; 12 per value |
| eBay Inventory (8) | group `imageUrls` = Common; "Variation pictures" row: each SKU's value set via `inventory_item` PUT + `aspectsImageVariesBy` | quantity read fresh before each write and echoed; a move in the window is reported; unknown item fields refuse; first real send = one listing with the Owner's word |
| Amazon (1 account, 32 families) | the photo review asks Amazon for each SKU's plan slots (MAIN, PT01–08, SWCH); new listings in the studio feed get plan slots; existing listings get no image attributes from the feed | review bound to the plan's revisions (a plan edit after review blocks approval); blocking plan problems refuse the review |
| Shopify (0 listings today) | content document gallery = plan media in order, one photo per variant; gallery reconcile on | blocking checks refuse; Nexus's 50-per-gallery rule is a check |
| Older paths | refuse plan families with one sentence (legacy Amazon feed, legacy eBay publishes, eBay flat-file full push, schedules, older editors) | — |

**Known limits (by design, later steps):** linked (existing) Shopify products do not sync photos from the plan yet —
their older sheet-gallery sync refuses plan families; Etsy publishing is P5; the page read still shows Shared value
names (the publishers already use each market's own names).

## P2a — publisher helper (not yet merged)
- `mediaLayoutFor(...)`: the layout one destination must receive, computed by the same loader and projection as the
  page; `null` when the family is not switched. The publisher passes the channel's own value and axis names and the
  variants in its review. Returns the plan revisions the layout was read from (a publisher binds its review to them).
- `isMediaSwitched(productId)`: a family is switched once it has a Shared layer.
- Destinations now drop variants the listing's variation setup excludes, and know each eBay listing's API (Trading or
  Inventory) from the same marker the publisher uses (moved to `pim/ebay-listing-model.ts`, re-exported unchanged).
- eBay sets carry `productIds`; Shopify keeps 3D models under both stored spellings.
- Tests: shared 316 pass; service 11 pass (a deliberate break of the exclusion rule fails the test); eBay publication
  suites 58 pass after the marker move; api and web typecheck clean.

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
