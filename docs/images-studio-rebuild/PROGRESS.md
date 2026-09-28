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
- **Scroll fix LIVE (#121, `e79ee631d`, 2026-09-28):** checked in production on GALE-JACKET — the wheel scrolls the
  Media page (354 of 484 px), text 13 px, no extra panel scroll. Found after it: the Redo tooltip (hidden) made the page
  15 px wider, so it could slide sideways → **#122 MERGED** (`ad253f4c8`) puts the tab's tooltips in a portal (0 px overflow) and sets
  `overflow-x: hidden`.
- **First real eBay photo send — blocked, nothing sent (2026-09-28):** the production review of GALE-JACKET eBay IT
  "IT-GALE-JACKET" shows the colour sets already equal on eBay (Nero 7, Giallo 7: same Cloudinary URLs) and the 2
  gallery photos the same pictures (eBay hosts copies). But 21 "Season contains an unaccepted value" issues (Nexus
  "Tutte le stagioni", eBay's list "Tutte le stagione") block every send — even photos only. P4c changes that rule.
- **Library duplicates (Owner, 2026-09-28: "multiple duplicates of the same image … I do not want that to happen ever"):**
  researched; Fix 1 **MERGED #123** (`03db635e2`) — one card per picture, copies count as the same photo, family-wide upload check, and the
  four older per-SKU copy writers stop for plan families. Record and next step: [LIBRARY-DUPLICATES.md](LIBRARY-DUPLICATES.md).
- **P4 — in progress:** plan [P4-PLAN.md](P4-PLAN.md). P4a Compare MERGED #125 (`aea9ee33f`); P4b Upload photos MERGED #126 (`5b24fef76`); P4c Review & publish photos MERGED #128 (`a9f254060`, live on the API 2026-09-28 00:33 UTC); P4d Export ZIP for Seller Central MERGED #129 (`c8fd585b5`), live and checked in production (below).
- **What is left in this session:** [NEXT-PLAN-2026-09-28.md](NEXT-PLAN-2026-09-28.md) — W1 done; W2 aliases MERGED #130 (`0be048ee6`); W3 the first eBay photo send DONE (below); W4a same photo MERGED #132 (`d82a285b1`); W4b language versions = PR (below); W4c the fill for GALE-JACKET waits for the Owner's word.

## W4b — Language versions of one photo (2026-09-28, library duplicates Fix 2 part 2)
- **The page:** photos with the same template and other text (dHash-256 17–26 with aHash ≤ 6 — a size chart per
  language) show **"Similar to <photo> — language versions?"**. The window (now "Same photo, or language versions?")
  has a choice **The same photo | Language versions of one photo**; for versions, each photo gets its language (a guess
  from its own tag or its name, "size-chart-es"), the sentence names the sets that show both today and which one they
  keep (the business's main language), and **Make them language versions** stays off until both languages are chosen
  and differ. The photo window gains **Language of the text in this photo**, the list of its versions with **Leave its
  versions**, and **Add a language version of this photo** (for photos without fingerprints).
- **Undo, for every library answer:** "same photo", "language versions" and "not the same" now go into the page's own
  Undo/Redo (↶ ↷, ⌘Z ⌘⇧Z) beside the plan edits — found testing: the message's Undo closed after 10 s, before a person
  could press it. The message's Undo runs the same entry.
- **Server:** `POST …/media/library/lookalikes` gains `versions` (2–20 photos, each with its language), `undo-versions`
  and `leave-versions`. Joining collapses every set that held two versions to one — the main-language photo, or a copy
  of it — in every layer (Shared, channels, listings, aliases), in one transaction at the revisions read
  (`collapseVersionsInPlan`, shared); photos already in a group bring the group along; refused: the same language twice,
  a version without text, two copies of one photo. The undo restores each photo's language and group and each layer,
  refused when a photo or a set changed after it. Leaving a group changes no set; a group of one ends. A photo's own
  language change is refused when its versions already have that language.
- **Checked on the local stack:** "Similar to … — language versions?" on both cards; the window's sentence ("…will
  keep Nero 1 (IT, the main language): ① Winter: Nero; Shared: Nero; Shared: TEST-JACKET-NERO-M"); after the join the
  Nero sets show Nero 1 only and both cards "IT · DE"; the toolbar Undo after the message had closed restored both sets
  and cleared the group; Redo and Undo again; the refused language change shows its sentence; keyboard (Enter opens,
  Escape returns focus to the link).
- **Tests:** shared 1 (the collapse keeps the main language, else the first), identity (the versions band), service 4 on
  the real schema (the suggestion, refusals, join across Shared + alias and its undo, the language guard, leave, a stale
  undo refused), page model 1. Eight deliberate breaks, each caught. Profiles ON: pass.

## W3 — The first real eBay photo send (2026-09-28, the Owner's "go ahead")
- **Listing:** GALE-JACKET on eBay IT, alias ① IT-GALE-JACKET (Trading API). Nothing else was sent — not the main
  listing (Inventory API), not the other aliases, not Amazon.
- **Before:** Review & publish from that listing's own view checked it alone: Ready; "Gallery: will be replaced ·
  Colour sets: same on eBay"; "Other fields of this listing have problems; only photos are sent" (the 21 off-list Season
  values, P4c); the revision note. The way back (eBay's two gallery addresses — eBay-hosted copies of the same two
  pictures) was recorded outside the repo. A fresh check just before the send said the same.
- **Sent about 01:58 UTC:** "Sent — eBay accepted it."
- **Verified:** a new review — gallery SAME, colour sets SAME; the live read (eBay GetItem, 01:59:27 UTC) — the gallery is
  the two Nexus photos (Common: main, then the second); the buyer page on ebay.it — custom label IT-GALE-JACKET, the
  first two gallery photos are the Nexus Common set, title and price unchanged.
- **Seen:** ① IT-GALE-JACKET and ★ Main listing show the same photos, so the W2 check warns about eBay's duplicate-listings
  rule. The Owner decides whether the titles differ enough.

## W4a — Same photo at two addresses (2026-09-28, library duplicates Fix 2 part 1)
- **The page:** a library card whose picture has a look-alike at another address shows **"Looks like <photo>"**; the
  filter **"Looks like another photo"** lists them. The link (or "Compare them" in the photo window) opens **"Same photo?"**
  (`plan-page/SamePhotoDialog.tsx`): both photos side by side (on a phone too), their source (Amazon image / Nexus
  upload), size and where each is used; **Keep** one (default: a Nexus upload over an Amazon image, then the one in more
  sets, then the larger); one sentence says which photo sets change. **Same photo — keep …** · **Not the same** · Cancel.
  Done: a message with **Undo**; later, the photo window lists "X was marked the same photo as this one" with
  **Separate it** (the copy is its own photo again; photo sets do not change). Nothing is deleted; nothing is sent.
- **The rule:** aHash ≤ 6 AND dHash-256 ≤ 16 — the "same picture" band of the upload gate's IE.13 calibration
  (`DHASH256_SAME_PICTURE_THRESHOLD`). 17–26 (same template, other text: a size chart per language) is not suggested
  here; language versions are W4b. Not suggested: language versions of one photo, pairs answered "not the same", videos,
  photos without fingerprints.
- **Server:** `POST /products/:id/media/library/lookalikes` — `same` / `undo-same` / `separate` / `distinct` /
  `undo-distinct` (permission `products.images.edit`). `markSamePhoto` replaces the copy (and its own copies) by the kept
  photo in EVERY layer of the family — Shared, each channel, each listing, alias layers included — in one transaction,
  each layer saved only at the revision it was read (`replaceAssetInPlan`, shared: where the set already shows the kept
  photo, the copy is dropped). The answer carries the undo: per layer, the ops that put it back, each bound to what the
  layer holds after the merge; an undo after someone changed one of those sets is refused and changes nothing. Refused:
  two languages of one photo ("keep both, as language versions"), a photo already joined, a photo not in the family.
- **Data:** additive migration `20260928a_images_same_photo` — `ProductImage.sameAsImageId` (self link, SetNull when the
  kept photo is deleted) and `distinctFromIds TEXT[]`; `baseline.sql` regenerated (only these lines); drift, model
  ownership and policy parity pass. The library identity joins a merged row to its kept photo (one card, the kept one).
- **Checked on the local stack** (two test photos given one fingerprint): "Looks like" on both cards; the window's
  sentence "…show Common 2 detail instead: eBay IT · Test eBay · ① Winter: Common; Shared: Safety" and the server after
  the merge (the ① Winter alias layer and Shared changed, the library 16 → 15 cards); Undo (15 → 16); Separate it (the
  sets stay); keyboard (Enter opens, Tab reaches both previews, both Keep choices and the three buttons, Escape returns
  focus to the link); light and dark; 390 px (two columns of 150 px, no sideways scroll).
- **Found and fixed on the way:** the photo window said "stored 1 more time (copies on other SKUs)" for a merged photo.
- **Tests:** shared 2 (the swap, and a copy or version counted as the kept photo); identity 2 (join, card choice, the
  band, exclusions); service 6 on the real schema (the read's suggestion, refusals, merge across Shared + channel + alias
  and its undo, a stale undo refused, Separate, "not the same"); page model 1; permission matrix. Nine deliberate breaks,
  each caught. Profiles ON: pass.
- **Next:** W4c fills the fingerprints in production (the Owner's word): until then production shows no suggestion,
  because the Amazon rows have none.

## W2 — Aliases on the Media page (2026-09-28)
The Owner: "it is very important that the image manager supports aliases, especially for eBay". Five gaps against
PLAN §4.5 and §11, closed in one PR:
- **A1 — one alias mark.** `AliasMark` (new DS primitive, mirrored in Factory) carries ★ (main listing) and ①②③ (aliases),
  moved out of the Information sheet's channel band. The API read gives each destination `listingMark` — only when its
  account and market hold more than one listing of the family. The Media page shows it in the destinations table, the
  phone cards, the channel view title, Compare, Upload "One listing", Copy from and Review & publish.
- **A2 — an eBay Inventory alias is refused.** Found in the code: Nexus addresses an Inventory listing by the family's
  parent SKU (its group) and SKUs — the main listing's. On an alias, a send would write the main listing's photos. Now:
  a blocking check `inventory-alias` (first in the list, shared projection), a refusal in
  `prepareEbayInventoryPublication` before anything is read, and the live read returns "cannot read this alias". In
  production today no alias is on the Inventory API (GALE-JACKET: the main listing is Inventory, its 4 aliases Trading).
- **A3 — eBay duplicate listings.** Two eBay listings on one account and market with the same photos (gallery and value
  sets, copies count as the same photo) each get a warning that names the other and asks to check the titles
  (`duplicateListingChecks`, shared).
- **A4 — revisions.** Each ready eBay line in Review & publish says "Sending is one revision of this listing. eBay allows
  250 revisions of a listing per calendar day" (eBay Trading API ReviseItem / ReviseFixedPriceItem reference).
- **A5 — one destination.** "Review & publish" in a channel view checks that destination only, with "Check all N
  destinations"; the toolbar button checks all. An unsaved eBay review shows the error that names no field first (only
  that kind blocks a photos-only send, P4c) — before this, an Inventory alias showed "Category is required".
- **Found and fixed on the way:** a long reason in Review & publish did not wrap (it ran 591 px past the window).
- **Checked on the local stack** (TEST-JACKET: ★ Main listing, ① Winter, ② Outlet (Inventory), ③ Outlet 2 — the last two
  made through the app's own alias route): the marks in the table, cards and titles; the Inventory alias's reason first
  in its checks and in Review & publish; the duplicate warning on ★, ② and ③ (same photos), not on ① (own photos);
  one line from a channel view, five after "Check all"; Enter opens and Escape returns the focus to the button that
  opened it; light and dark; 390 px (no sideways scroll, the header buttons wrap).
- **Tests:** shared 22 (the Inventory-alias check and its order; duplicate listings by account, market and copies);
  API media-plan (listingMark ★ ①, the alias check), live read 7, the publisher refusal 1; page model and publish model
  25. Eight deliberate breaks, each caught. Profiles ON: the only failing file is the known
  `studio-publication-database` (in `profiles-on-baseline.ci.json`). Typecheck shared, api, web clean; Factory's 338
  old errors, none in the DS; static gates 59/59.
- **Seen, not changed (outside this task):** the app's left navigation is taller than the window, so the whole frame can
  slide up when a script scrolls an element into view (normal wheel and Tab do not move it).

## P4d — Export ZIP for Seller Central (Amazon)
- **LIVE 2026-09-28** (#129, squash `c8fd585b5`, merged 00:46 UTC on the Owner's word; API, worker and scheduler
  redeployed by 01:14 UTC; Vercel production done). **Production proof, read only, through the app** (Owner's word;
  preview only, nothing downloaded, nothing changed), the test family GALE-JACKET, account XAVIA RACING, markets DE ES
  FR IT SE: All photos DE/ES/FR 164 files · 19 ASINs, IT 182 files · 21 ASINs, no errors, no warnings; SE nothing,
  "Left out — 21 SKUs", each "its Amazon SE listing has no ASIN yet" (the SE drafts); Safety images: none (the plan's
  Safety set is empty); Country photos: none on any market (no photo has language versions); the API language is
  German (DE is the account's first market). Found: "has a Italian version" → now "has a version in Italian" (the fix PR after #129).
  **Size, measured** (Owner's word, one real download, read only): IT All photos (182 files, photos 2,000–2,250 px)
  stops at the limit in about 2 s — "This ZIP would be larger than 100 MB, the most Nexus makes in one ZIP. No ZIP was
  saved." Nothing reached the Downloads folder. So the open risk in P4-PLAN § P4d is real for this family: All photos
  needs a streamed ZIP (next step, the Owner decides).
- **Open:** the Amazon channel view → **Export ZIP for Seller Central**. One window (`plan-page/AmazonZipDialog.tsx`):
  **Market** (the account's markets), **What to export** (All photos · Safety images · Country photos), what the ZIP
  holds and in which language, **Where to upload it** (Seller Central's own names), then the list: every file
  `ASIN.SLOT.jpg` by ASIN with its photo, what to fix first, warnings, and the SKUs left out with the exact reason.
  "Nothing is sent to Amazon."
- **Server:** shared pure `planAmazonArchive` (`packages/shared/media-plan-archive.ts`); service
  `media-plan-archive.service.ts` (preview; the ZIP bound to the preview by a digest, checked before and after the
  downloads); one JPEG engine `jpeg-archive.ts`, shared with the older safety export (safe fetcher, each photo once,
  4 at a time, real JPEG on white, all or nothing). Decisions and limits: [P4-PLAN.md](P4-PLAN.md) § P4d "Built
  differently".
- **Checked on the local stack** (TEST-JACKET; fake ASINs B0FXJ…; IT and DE tie on 10 listings, so the API language is
  German): the window equals a curl of the preview for IT and DE × 3 kinds (DE All photos: 23 files, 4 ASINs, 6 SKUs
  left out, 1 error "Small 400 px … needs 500 px"; IT Country photos: 7 files, the Italian size chart; DE Country photos:
  none, "the API already sends the German versions"). Download on the local stack always refuses, by design — the safe
  fetcher does not download `http://127.0.0.1` photos — and the window says so: "Size chart IT (B0FXJKTPAR PT02): Use a
  public HTTP(S) source URL without embedded credentials or a custom port. No ZIP was saved." The success path is proven
  by the service test (a real ZIP of real JPEGs, download faked). Keyboard: Enter opens; Tab = ✕ → Market → What to
  export (arrows move the choice) → Close → Download; focus stays inside; Escape closes and focus returns to the button.
  Light and dark; 390 px (controls stack, no sideways scroll); fonts Inter and JetBrains Mono only, no text at 16 px.
- **Tests:** shared plan 6, service 12, engine 4, older export +1 (a plan family is refused), web model 6 + transport 4.
  27 deliberate breaks (each guard removed in turn): 27 caught. Static gates 59/59. Image suites: API 249, web 380.

## P4c — Review & publish photos
- **The rule that blocked GALE-JACKET's photos, changed:** a change-only review whose errors all name a field (an
  off-list Season value) is now saved with `photosOnly`; a selection of photo fields only (`pictures`, `Pictures`,
  `variationPictures`) is sent, any other selection is refused (422, "Choose only photos, or fix them first"). An error
  that names no field (account, paused listing, the photo plan's own checks) still blocks everything. One shared rule,
  `blockingIssues` (`packages/shared/src/studio-publication.ts`), used by preview, selection, submit and the studio's
  Publish window (which now ticks only photo rows on such a review and says why the others are locked).
- **The window** (`plan-page/PublishPhotosDialog.tsx`, toolbar **Review & publish**, also from the upload's Done): every
  destination is checked against its channel first — eBay (Trading and Inventory) by the studio publication review of
  that listing (a fresh read of eBay), Amazon by an image run's review (image attributes only, one run per account through
  its first listed market). Each line: Ready / No change / Fix first / Not here, and what would change ("Gallery: will be
  replaced · Colour sets: same on eBay"; "3 SKUs · 7 photo slots change"). Only ticked, ready destinations are sent, one
  at a time, each with its channel's answer (eBay read-back; Amazon receipts). Shopify is not sent here (its publish is
  the whole product); Etsy is P5. "Only photos are sent. Titles, prices and stock are not touched."
- **Change to the plan:** no new `/media/publish/*` server orchestrator — the window drives the channels' existing
  review → selection → submit routes, which already hold the plan-revision binding, the idempotency and the read-back.
- **Checked:** server tests 30 (2 new: a field error does not block a photos-only send and refuses any other field; an
  error without a field still blocks — a deliberate break of the submit rule fails the test); shared rule 3; page model
  4; studio web suite 164 files / 2,144 tests. Local stack (test channels have no logins, test listings are not live):
  every line says why it cannot be sent (Amazon: no ASIN yet; eBay: Category required) — the real send is the first
  production proof, with the Owner's word per send.

## P4b — Upload photos
- **Open:** toolbar **Upload photos**, the **U** key, or files dropped anywhere on the page (a dashed outline shows the
  drop). One window (`plan-page/UploadDialog.tsx`): one summary line, "Put them in" (Shared / one channel / one
  listing, radios that wrap), then one line per file: preview, name and what decided its set, **Set** (sets and
  swatches), **Position** (blank = end), **Language**, **Status**. A list, not a grid: every choice is a Tab stop in order,
  and the lines stack on a phone with their labels.
- **Reading the names** (`uploadModel.ts`, shared `parseMediaFileName`): a value's label or its dictionary code
  ("black" finds Nero), a SKU, ps01–06, main/pt01/numbers (a camera number like 0042 is not a position), the
  language. Files that differ only by language are **versions of one photo**, placed once (the main language).
- **Uploading:** one file at a time through the existing upload route and its duplicate check. The file's name labels
  the photo. Same bytes → "Already in the library" (that photo is used). Looks like a library photo → "Use that photo"
  (default) or "Upload anyway"; a file in **another language** than the photo it looks like is uploaded as its version on
  its own (the IT and DE size charts look alike — found testing). Another SKU's copy of a picture (#123) places the card.
- **New write:** `PATCH /products/:id/media/library` — each new photo's language, and the version groups (a new
  version can join a photo already in the library). Refuses versions in one language, a version with no text, and a
  photo of another family; permission `products.images.edit`; event `product.media.changed` (layer `LIBRARY`).
- **Place:** the library write, one fresh read, then one plan edit. The button says what happens: "Place 8 files", and
  beside it "Nero 2 · Giallo 1 · Common 1 · 3 language versions · 1 swatch". Done: "N files placed (M new in the library).
  K destinations follow them. Nothing was sent to a channel." with **Undo**, then "Remove the M new photos from the
  library". **Cancel** removes the photos the window added; so does leaving the page or closing the tab.
- **Checked on the local stack** (a local stand-in for Cloudinary's upload API in `.local-p3b/`, untracked): 8 files
  → Nero at positions 1 and 5, Giallo at the end, the size chart in Common once with IT/DE/FR/ES versions, the Nero
  swatch; Undo restored every set; Cancel, "Remove", and leaving the page each left 0 uploads behind. Keyboard (U opens,
  Tab reaches every choice), 390 px (lines stack, footer wraps, no sideways scroll). Tests: upload model 4, library
  endpoint 3 (real schema), permission matrix.

## P4a — Compare
- Toolbar **Compare**: one chip per destination; each set one block, each chosen destination one line (source, count,
  photos in position order, each in its market's language version). Each line is compared with the first destination
  that uses the set: extra photos outlined, missing ones named ("Lacks …"), "Other order". Safety is Amazon's; per-SKU
  sets Amazon's and Shopify's (shown only when a chosen destination has one).
- Model `compareDestinations` (`plan-page/model.ts`), dialog `plan-page/CompareDialog.tsx`, DS `Modal` + `FilterChip` +
  `SourceIndicator` + `Thumbnail` + `Tag`. A first version in the DS data grid cut rows and hid columns inside the
  dialog; the list layout reads better and stacks on a phone.
- Checked on the local stack: TEST-JACKET (Amazon, eBay IT, eBay IT "Winter" with its own sets) → "4 of 6 sets differ",
  Winter's Common "+1 · −2, Lacks Common 2 detail, Size chart IT"; keyboard (Enter opens, Tab reaches each chip, Space
  ticks, the summary updates, Escape closes and focus returns to Compare); dark; 390 px (lines stack, no sideways
  scroll). Test: model 7 (a deliberate break of the version rule fails it).

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
