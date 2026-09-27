# Images (Media) page rebuild — PLAN

**Status: APPROVED by the Owner 2026-09-27 ("We can proceed"; all decisions = option A). Work starts with P0 (read-only).**
Date: 2026-09-27 · Branch `feat/images-studio-rebuild` · Worktree `/private/tmp/nexus-images-studio` · Base `972463c08`
Facts and sources: [RESEARCH.md](RESEARCH.md).

---

## Summary

**What is wrong today**
- The Media page shows **one channel, one market, one account, one alias at a time**. To put the same photos
  everywhere you open each one, pick photos, save, and publish — about 60 clicks.
- Your photos are saved in **up to 5 different places**. The Media page and the "Product media" column on the
  Information page read different places, so they can disagree. Only one of them is sent to the channel.
- Aliases are hidden inside a drop-down on each channel page. You cannot see or compare them side by side.
- Etsy has no photo page at all. The old Shopify photo sender always fails.
- Nothing tells the other screens when a photo changes.

**What we will build**
1. **One page for every channel.** Library on the left. The **photo plan** in the middle: a "Common" set and one set
   per colour (or any other option). Below it, **every destination** — each channel × market × account × alias — in
   one table, showing if it follows the plan (🔗) or has its own photos (✎).
2. **Upload once, done.** Drop all files. The page reads the file names and puts each photo in the right colour set
   and position. You check the list and press one button. Every channel follows.
3. **No repeat photos.** A photo lives in exactly one set. Each channel gets its own layout from the plan
   automatically (eBay gallery + colour photos, Amazon MAIN/PT/SWCH per SKU, Shopify variant images, Etsy).
4. **Full control when you want it.** Any set can be changed for one channel (all eBay listings) or for one listing
   (one alias) only. One click puts it back to "follow".
5. **Same data everywhere, live.** The Media page, the "Product media" column and the publishers all use one store
   and one set of rules. A change on one screen shows on the other screen at once.
6. **One "Review & publish".** Shows every destination, what will change, the channel checks, then sends only the
   photos, with honest status (sent → accepted → live).
7. **Photos with text speak the buyer's language.** A size chart or infographic gets one version per language
   (IT, DE, FR, ES…). You place it once; each market gets its own language. Where a channel cannot do that (Amazon
   keeps one photo set per product for all markets; Shopify and Etsy too), the page says so and offers the channel's
   own way (Amazon: a ready "country photos" file for Seller Central, and optionally A+ Content per market).

**Decisions** (details in §10) — D1 layers, D2 new alias start, D3 eBay photo hosting, D5 storage: **agreed by the
Owner 2026-09-27 (all option A)**. D4 languages: **answered by the Owner** → language versions (§4.8).
D6 missing language version → nearest version + warning, D7 Amazon A+ per market as phase P8: **agreed (A)**.

**Order of work** (details in §9): P0 measure → P1 data spine → P2 publishers read the spine → P3 new page +
Information column → P4 upload & bulk tools → P5 Etsy, eBay photo hosting, Amazon country photos, live checks → P6 move old data and
delete old code → P7 hardening → P8 Amazon A+ per market (if D7 = A). One PR per phase.

---

## 1. What the Owner asked for

| # | Requirement (Owner, 2026-09-27) | Where the plan answers it |
|---|---|---|
| R1 | Rebuild the images page of the product studio; make sure everything is there | §5, §8.3 (nothing lost) |
| R2 | Stop "go to each and every channel myself and then upload" | §5.1, §5.5 |
| R3 | Give full control | §4.2 layers, §5.4 channel views |
| R4 | Support aliases "the best way possible" | §4.5 |
| R5 | Make it extremely easy | §5.5 upload, §5.6 publish (the PSIE dialog pattern the Owner liked) |
| R6 | Understand each channel first — eBay main photo, gallery, common photos, per-group photos | §3, RESEARCH §D |
| R7 | Upload photos by group so there are **no repeat images** | §4.1 |
| R8 | Integrated in real time with the Information page's media column | §4.7, §6.4, §5.7 |
| R9 | AAA quality, industry-best approach | §6, §7, §9 exit checks |
| R10 | Research → structured plan → approval of design and UI → build | this document |
| R11 | Europe: infographics and size charts carry text; IT, DE, FR, ES buyers must see their own language | §4.8 |

## 2. Today in one table

| Topic | Today | Problem |
|---|---|---|
| Navigation | One destination per URL, full reload on each switch | R2, R3 |
| Stores | `ProductImage` (library), `ListingImage`, `_productMediaLocales`, `_mediaGalleryDraft`, `_amazonMediaWorkspace`, `_nexusContent`, `imageUrls` | Surfaces disagree; only one ships |
| Aliases | A select inside each workspace; lost on market switch; Shopify/Etsy none | R4 |
| eBay | Common + one axis's sets; repeats allowed; 24/12 in UI, 24/24 in publisher | R7; eBay's API limit is 12 per set |
| Amazon | Per-market drafts, "not inherited by other markets" | Amazon images are global per ASIN — the page tells a story Amazon does not follow |
| Shopify | Groups + assignments inside the Shopify content document | Separate model from everything else |
| Etsy | No page, no publisher in use | Missing |
| Live sync | Only master library writes emit an event; nobody listens | R8 |
| Dead code | ~2,700 + 468 + ~2,300 lines in `_studio/images`, ~17,000 in the legacy tab | Confusing, stale |

## 3. Channel rules the design must follow

| | eBay | Amazon | Shopify | Etsy |
|---|---|---|---|---|
| Where photos belong | SKU / group, per account; **same on every market** for a shared SKU | **ASIN, global** (one set for all markets) | Product media, per store | Listing, per shop |
| Main photo | First common photo = search + gallery photo | MAIN per child ASIN (white background) | Media position 0 | Rank 1 |
| Per option | ONE axis varies photos; first photo of a value = shown when buyer picks it | Each child has its own MAIN + 8 | One image per variant | One photo per option value, one axis, ≤ 20 options |
| Limits | 24 per listing, **12 per value set** | MAIN + PT01–08 + SWCH; PS01–06 by product type | 250 media; 20 MB; 20 MP | 20 photos, 2 videos |
| Size | ≥ 500 px longest side; no CMYK; ≤ 12 MB | ≥ 500 px; ≥ 1000 px for zoom | — | First photo ≥ 635 px; no transparency |
| Aliases | Separate listing = own photos; Inventory API needs its own SKUs | Same ASIN = same photos (alias cannot differ) | none | own listing |
| Updates | Full replace; counts as a revision (250/day) | Up to 24 h; Amazon may prefer another seller's photo | `productSet` files list is the full truth | overwrite per call |
| Photo per language / market | ✅ each market is its own listing (on the Inventory API: needs its own SKU) | ❌ by API (one set per ASIN) · ✅ by hand: Seller Central "Country-Specific Upload" (brand owners) · ✅ A+ Content per market and language by API (Brand Registry) | ❌ product photos cannot change per language or market (alt text can) | ❌ one set per listing |

Limits live in one configuration file in `packages/shared` so a channel change is one edit.

---

## 4. The new model

Four ideas. Everything else follows from them.

### 4.1 Library and sets — "no repeat photos"
- **Library** = every photo and video of the family (parent and children), stored once (existing dedup gate:
  exact copy reused, near-copy asks). A photo in the library that no set uses is **not sent anywhere**.
- **Photos vary by** = one family option (default: Colour when the family has it). Same idea as eBay, Etsy, Shopify.
- **Sets** (ordered; the first photo of a set is its **main photo**):
  - **Common** — photos for every variant (size chart, detail, lifestyle). eBay listing gallery; first = search photo.
  - **One set per value** — e.g. Nero, Giallo. First = the colour's main photo.
  - **Swatch** (optional, one per value) — Amazon SWCH.
  - **Safety (PS01–PS06)** — Amazon only.
  - **Per-SKU sets** (advanced, folded) — one child with different photos. Used by Amazon and Shopify; eBay cannot
    show per-SKU photos in a variation listing, and the page says so.
- **Repeats (D8 = A, Owner 2026-09-27):** a photo never appears twice **inside one gallery** (checked on save; Amazon,
  Shopify and Etsy galleries, which merge sets, keep only the first copy). The **same photo may sit in Common and in a
  colour set on purpose** (e.g. the cover shot is also Nero's main photo — the Owner's 2026-07-27 rule, after the old
  "remove it from the colour set" logic broke GALE-JACKET-ALT2). Dragging **moves**, so nothing repeats by accident;
  **Also use in…** (or ⌥-drag) adds it to a second set; the tile shows "also in Common".

### 4.2 Layers — follow or own (full control)
Each set can be set at three layers. A lower layer follows the one above until you change it.

```
Shared (all channels)
   └── Channel (e.g. all eBay listings, all Amazon accounts)
          └── Listing (one destination: account × market × alias)
```
- Every set on every layer shows its source with the DS `SourceIndicator`: 🔗 **follows Shared**, 🔗 **follows eBay**,
  ✎ **own photos**. One click: **Use own photos** (copies the inherited set so you can edit it) or **Follow again**.
- Overrides are per **set**, not per photo — "Nero on ① Winter uses its own photos" is a sentence you can read.
- Why three layers (D1): Amazon MAIN must be on white while eBay can lead with a lifestyle photo. Set that once on
  the Amazon layer, not once per account and market.

### 4.3 Destinations
| Channel | One destination is | Why |
|---|---|---|
| Amazon | account (seller) — shows the markets it covers: "IT DE FR ES NL BE PL SE IE UK" | photos are global per ASIN |
| eBay | account × market × alias | each listing has its own photos; a note appears when two markets share one SKU (Inventory API) and therefore share photos |
| Shopify | store (account) | one product per store |
| Etsy | shop (account) × alias | one listing per shop |

The list comes from the same coordinates the Matrix page uses (connected accounts × active markets × active aliases ×
family listings). A market you do not list on shows as "Not listed" and takes no space unless you ask for it.

### 4.4 How each channel gets its layout (computed, never stored twice)
With C = Common, V[v] = the set of value v, S[sku] = per-SKU set, W[v] = swatch, P = safety:

| Channel | Layout |
|---|---|
| eBay | Listing gallery = C (≤ 24; first = search photo). Photos vary by the axis. Value v = V[v] (≤ 12; first = shown when a buyer picks v). Inventory API: every SKU of v carries V[v]; the group carries C. Trading API: `PictureDetails` = C, `VariationSpecificPictureSet` per value. |
| Amazon | Each child ASIN: MAIN = first of (S[sku] or V[v]); PT01–PT08 = the rest of that set, then C, cut at 8; SWCH = W[v]; PS01–PS06 = P where the product type allows it, else the Seller Central ZIP. Parent: C[0] only. Single product: MAIN = C[0], PT = rest. |
| Shopify | Product media = C, then V[v1], V[v2]… (each photo once, ≤ 250; position 0 = C[0]). Variant image = first of (S[sku] or V[v]). |
| Etsy | Listing photos = C, then the value sets, first 20 (rank 1 = C[0]). Variation photo per option value = first of V[v]. Videos: first 2 of C. |

What does not fit (e.g. Amazon shows 9, Etsy 20) is **listed by name** in the checks, never cut silently.

### 4.5 Aliases
- Every alias is its own row with its mark and label: **★ Listing 1**, **① Winter**, **② Outlet** — never "Listing 2".
- A new alias **follows** Shared → Channel (D2). One click: **Copy photos from ★ Listing 1**.
- **Compare**: tick 2+ destinations → sets side by side, differences highlighted.
- **eBay duplicate-listings policy:** when two aliases on the same eBay account and market have the same photos and
  the same title, the check shows a note (eBay does not allow identical fixed-price listings by one seller).
- **Amazon:** aliases share the ASIN, so they share photos; the Amazon row says so and offers no alias override.
- **Old shells** (22 `EBAY_LISTING_SHELL` products): their photos move to their adopted alias in P6.

### 4.6 Upload and file-name rules
- File names are read with a small rule set (same idea as Amazon's `ASIN.MAIN.jpg`, Akeneo naming conventions):
  - a value name or its channel synonym (`nero`, `black`, `giallo`, `yellow`) → that value's set;
  - a SKU → that SKU's set; `common`, `size-chart`, `detail` → Common; `swatch`/`swch` → swatch; `ps01`… → safety;
  - a number → position (`-01`, `_2`, `main` = 1);
  - a language code or name (`-it`, `_DE`, `fr`, `espanol`, `deutsch`) → that language's version (§4.8); files with
    the same name apart from the language become versions of one photo.
  - Unknown → Common, shown clearly so one click fixes it.
- The rules live in `packages/shared` (pure, tested) and are shown in the upload dialog.

### 4.7 One store, one set of rules (the real-time answer)
- **One table** holds every layer's sets (§6.1). **One resolver** in `packages/shared` turns layers into the
  resolved sets and each channel's layout. The Media page, the "Product media" column, the row thumbnails and all
  four publishers use that resolver. They cannot disagree, because there is nothing else to read.
- Every write sends **one event** (`product.media.changed`); every screen that shows photos listens (§6.4).

### 4.8 Languages and markets (size charts, infographics)
- Every library photo has a **language**: *No text* (default), *one language* (IT, DE, FR, ES, EN, NL, PL, SV…), or
  *Several languages* (one image with IT/DE/FR/ES on it). Standard codes: `zxx` no text, `mul` several, `it`, `de`…
  (the current Amazon draft already uses `zxx`).
- The same picture in different languages = **versions of one photo**: "Size chart — IT · DE · FR · ES". In a set
  you place it **once**; its position is the same in every market, and the no-repeat rule counts it once.
- Each destination takes the version for its market's language (from the existing market-language table:
  IT→it, DE→de, FR→fr, ES→es, UK/IE→en, NL→nl, BE→nl+fr, PL→pl, SE→sv).
- Version missing → D6. Recommended: show the nearest version — English, then the several-languages version, then
  the business's main language — with a warning such as "eBay ES: size chart has no Spanish version — shows Italian".

| Channel | What each market gets |
|---|---|
| eBay | ✅ **Its own language version** — each market is its own listing. If IT and DE share one SKU on the Inventory API they must share photos; the check says so, and the fix is a market SKU for DE (P0 counts how many). |
| Amazon | **By API: one version for all markets** (photos belong to the ASIN). Default: the several-languages version if there is one, else the account's main market language; changeable on the Amazon row. **Country photos:** Seller Central's "Country-Specific Upload" (brand owners) shows a different photo per country for the same ASIN. It has no API, so the page builds **one ready ZIP per country** (files named `ASIN.PT03.jpg`, like today's safety-image ZIP) for you to upload — about 3 clicks per country. **A+ Content** (API, per market and language, Brand Registry) can carry localized size charts and infographics automatically — optional phase P8 (D7). |
| Shopify | One version: the store's main language. Shopify cannot change product photos per language or market; alt text is translated per language. |
| Etsy | One version: the shop's language. |

- A market that needs a **different set** (not only another language) still uses the listing layer (§4.2).
- The Information sheet's "Product media" column follows the sheet's language: a DE sheet shows the German versions.

### 4.9 eBay: the two sections, the order, and the axis
**What the buyer sees** (eBay's own rules):
1. **Common photos** — the listing opens on common photo 1 (also the search photo); the gallery shows the common
   photos in their order.
2. **Axis photos** — when the buyer clicks a value of the picture axis (e.g. Colour = Nero), eBay shows Nero's photos,
   Nero photo 1 first. A value with no photos shows eBay's "no picture available" — the check blocks that.

**What Nexus sends, in exactly the order on screen:**
| Path | Common | Axis photos |
|---|---|---|
| Trading API (listings with an ItemID) | `PictureDetails.PictureURL` = Common, in order | one `VariationSpecificPictureSet` per value = that value's set, in order |
| Inventory API (SKU groups) | `inventoryItemGroup.imageUrls` = Common, in order | every SKU of the value: `product.imageUrls` = that value's set, in order; `aspectsImageVariesBy` = the axis |

**Order guarantee (tested, not hoped):**
- Order is stored once (the set's array). Nothing on the way may sort, de-duplicate or re-index it: the projection
  is a pure function, and a test runs "screen order = payload order" for both paths and every channel.
- Repeat rules (§4.1, D8) are enforced when you edit, never by silently dropping a photo at publish time — the
  2026-07-27 incident was exactly that.
- After each publish the read-back (GetItem / group + items) compares the live order with ours; any difference shows
  in the status column as "Order differs on eBay" with a one-click re-send.
- Limits are checked before sending (24 common, 12 per value); nothing is cut silently.

**Assign by axis, fast:**
- "Photos vary by" lists the family's variation axes (Colour, Size, Material…), taken from the **variation theme**
  (the VTR model), not guessed from free text.
- One row per axis value, in the family's value order; photos go in by drag, by "Add to ▾" on a selection, by file
  name (§4.6), or by "Copy from ▾" another value.
- **Axis identification done right:** a value set is keyed by the value's stable option code from the variation
  theme's dictionary, not by its display text — so renaming "nero" → "Nero" keeps the photos. Each market gets its
  own value name from the channel value map (eBay IT "Nero", eBay DE "Schwarz"), so the right photos land on the right
  colour in every market. Values that exist on a listing but not in the family (or the reverse) are listed by name.
- Carried over from the previous edit page's eBay builder (study in §7.2): common row pinned first, one row per
  value, position 1 marked ★ Main, drag between rows = move ("Also use in…" adds it to a second set, D8), "set as main",
  and "remove the main photo" asks before promoting the next one. Full list and the old faults: §7.2.

---

## 5. UI design (for approval)

Built only from the Nexus design system (`MediaCard`, `MediaGallery`, `MediaStrip`, `Thumbnail`, `FileDropzone`,
`DataGrid`, `Modal`, `Drawer`, `MetricStrip`, `SourceIndicator`, `ChangeReview`, `JobProgress`, `Banner`,
`EmptyState`, `SegmentedControl`, `Listbox`, `Tag`, `Pill`, `Button`). Semantic `--nds-*` tokens only. Dense,
everything visible, no "More ⋯" menus for daily actions.

### 5.1 The page — all destinations (default)

The studio scope bar stays. On this page the channel chips **filter** the destination table (like the Matrix page);
choosing one listing opens its channel view (§5.4). Nothing reloads the page.

```
Media · GALE-JACKET · 18 variants                                                          Saved ✓ just now
[⤒ Upload photos]  [Auto-assign by file name]  [Compare]  Photos vary by [Colour ▾]  Show as [All markets ▾]  [Review & publish · 4]
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
LIBRARY · 42                     │ PHOTO PLAN · Shared — every channel follows this unless it has its own
[Search…] [All ▾]  Unused 3      │
┌────┬────┬────┐                 │  Set                   Photos · first photo = main photo                Count
│ ▣  │ ▣  │ ▣  │ drag onto a set │  Common · all 18       [★1][2][3][4 🌐 IT DE FR ES]  ＋                 4  eBay ≤24
│ ▣  │ ▣  │ ▣✓ │ or select and   │  Nero · 9 SKUs         [★1][2][3][4][5][6]  ＋                          6  eBay ≤12
│ ▣  │ ▣  │ ▣  │ press "Add to"  │  Giallo · 9 SKUs       [★1][2][3]  ＋                                   3
│ …              │                 │  Swatch                Nero [▪]   Giallo [▪]                             Amazon
│ "In use" tag   │                 │  Safety (PS)           [1][2]  ＋                                        Amazon 2/6
│ on every photo │                 │  ▸ Per-SKU photos (0)
│ a set uses     │                 │
│                │                 │ WHERE THE PHOTOS GO            Common  Nero   Giallo  Checks     Channel status
│                │                 │  Amazon · Xavia                  🔗      🔗     🔗      ✓          Live · 2 d ago
│                │                 │    IT DE FR ES NL BE PL SE IE UK · one set per ASIN
│                │                 │  eBay IT · Xavia · ★ Listing 1   🔗      ✎ 5    🔗      ⚠ 1        Different on eBay
│                │                 │  eBay IT · Xavia · ① Winter      ✎ 4     🔗     🔗      ✓          Not published
│                │                 │  eBay DE · Xavia · ★ Listing 1   🔗      🔗     🔗      ✓          Live · 5 d ago
│                │                 │  Shopify · xavia.it              🔗      🔗     🔗      ✓          Live · 1 d ago
│                │                 │  Etsy · XaviaShop                🔗      🔗     🔗      ⚠ 21 > 20  Not listed
│                │                 │  🔗 follows Shared · 🔗e follows eBay · ✎ own photos — click a row to open it
```
- Library: drag a photo onto a set, or select several and press **Add to ▾** (Common / Nero / …). Each photo shows
  where it is used ("Nero · main", "Common 3") and its size; problems (too small, not white) show as a `Tag`.
- A photo with language versions shows them (🌐 IT DE FR ES; a missing one in grey). Click it to see, add or replace
  a version. **Show as** switches the whole page to what one market sees (e.g. "Show as eBay DE").
- Set row: drag to reorder; drag between rows to move; ★ on the first photo; hover → **Make main**, **Remove from
  set**, **Open**. `＋` opens the library picker for that set.
- Destination table: one row per destination; a cell per set shows 🔗/✎ and the count; **Checks** opens the list of
  problems for that row; **Channel status** is what the channel really shows (read-back), not what we sent.

### 5.2 Keyboard and accessibility
- Arrow keys move between photos and rows; **Space** picks up a photo, arrows move it, **Space** drops it (the DS
  reorder contract); **M** make main; **Delete** removes from the set (never from the library); **⌘Z / ⌘⇧Z** undo /
  redo; **U** upload. Every drag has a keyboard and a button equivalent.
- All controls labelled; focus visible; contrast checked in light and dark; the table becomes stacked cards under
  1180 px, the library becomes a drawer.

### 5.3 Saving
- Every edit saves at once (autosave), like the master gallery today — nothing goes to a channel until you publish.
  The header shows **Saved ✓ / Saving… / Not saved — Retry**. Each save has **Undo** (toast + ⌘Z).
- If someone else changed the same set, the page reloads that set and tells you; your change is re-applied when it
  still fits, otherwise shown so you can do it again.

### 5.4 Channel views (one destination — click a row)
A panel under the table (or full width when the scope bar is on one listing). It always shows the channel's own
words and slots, a **buyer preview**, and the checks.

**eBay**
```
← All destinations   eBay IT · Xavia · ① Winter            [Copy photos from ▾]  [Follow Shared for all sets]
Photos vary by: Colour (from Shared)
Gallery — common photos (4 / 24) · first photo = search photo            ✎ own photos     [Follow again]
  [★1][2][3][4]  ＋
Nero (6 / 12) · first photo shows when a buyer picks Nero                🔗 follows Shared [Use own photos]
  [★1][2][3][4][5][6]
Giallo (3 / 12)                                                          🔗 follows Shared [Use own photos]
  [★1][2][3]
BUYER PREVIEW  [Search result] [Listing page]   Colour: (Nero) Giallo
CHECKS  ✓ 13 photos ≥ 500 px   ✓ no repeats   ⚠ Nero photo 3 is 480 px — eBay needs 500 px
```
**Amazon**
```
← All destinations   Amazon · Xavia — applies to IT DE FR ES NL BE PL SE IE UK (one photo set per ASIN)
              MAIN  PT01  PT02  PT03  PT04  PT05  PT06  PT07  PT08  SWCH
Nero (9 SKUs) [N1]  [N2]  [N3]  [N4]  [N5]  [N6]  [C1]  [C2]  [C3]  [▪]    🔗 follows Shared
Giallo (9)    [G1]  [G2]  [G3]  [C1]  [C2]  [C3]  [C4]   —     —    [▪]    🔗 follows Shared
▸ per SKU (open to see all 18 ASINs)
Safety PS01–PS06  [S1][S2] → sent where the product type allows it · [Export ZIP for Seller Central]
Photos sent by API (every market): language [Several languages ▾]
Country photos for Seller Central (brand owners):  [DE ZIP · 3 photos] [FR ZIP · 3] [ES ZIP · 2 · 1 missing]
CHECKS  ⚠ Nero MAIN is not on a white background → [Use a different main photo for Amazon]
        ⚠ Nero: 1 common photo does not fit (Amazon shows 9): "detail-zip.jpg"
```
Editing a slot here creates an Amazon-layer copy of that set (✎), so Shared stays as it is.

**Shopify** — product media in order (C, then each colour), variant image per variant, alt text; the Shopify
metafields and metaobjects editor that lives in today's Shopify content page stays as it is, opened from the
Shopify row's **Content & metafields** button (only its photo part moves here).

**Etsy** — 20 photos in order, one photo per colour option, video (2), transparency and 635 px checks.

### 5.5 Upload photos (the main time saver)
One small dialog (the PSIE pattern: defaults for every choice, one table, a counted button).
```
Add 18 files                                                                                           ✕
18 files · 16 new · 1 already in the library · 1 looks like a photo you have
Put them in:  (•) Shared — every channel     ( ) One channel [eBay ▾]     ( ) One listing [eBay IT · ① Winter ▾]
┌───────┬──────────────────────┬────────────┬──────┬──────────┬────────────────────────────────────────┐
│ Photo │ File                 │ Set        │ Pos. │ Language │ Status                                 │
│ ▣     │ gale-nero-01.jpg     │ Nero ▾     │ 1    │ No text ▾│ New                                    │
│ ▣     │ gale-nero-02.jpg     │ Nero ▾     │ 2    │ No text ▾│ New                                    │
│ ▣     │ gale-giallo-01.jpg   │ Giallo ▾   │ 1    │ No text ▾│ New                                    │
│ ▣     │ size-chart-it.jpg    │ Common ▾   │ end  │ IT ▾     │ New · version of "size chart"          │
│ ▣     │ size-chart-de.jpg    │ Common ▾   │ end  │ DE ▾     │ New · version of "size chart"          │
│ ▣     │ gale-nero-03.jpg     │ Nero ▾     │ 3    │ No text ▾│ Looks like photo 12 · [Use photo 12 ▾] │
└───────┴──────────────────────┴────────────┴──────┴──────────┴────────────────────────────────────────┘
⚠ Size chart: no FR or ES version yet — FR and ES show the Italian one until you add them (D6).
                          [Cancel]   [Place 18 files · Nero 9 · Giallo 7 · Common: size chart (IT, DE)]
```
Done: **"18 files placed (16 new in the library). 6 destinations follow them. Nothing was sent to a channel."** [Undo] [Review & publish]
[Done]. Dropping files anywhere on the page opens the same dialog; dropping onto a set pre-fills that set.

### 5.6 Review & publish
```
Publish photos                                                                                           ✕
Destinations 6 · With changes 4 · Ready 3 · Needs a fix 1
┌───┬──────────────────────────────┬────────────────────────────────────┬──────────────┬───────────────┐
│ ☑ │ Amazon · Xavia (all markets) │ Nero: 2 new, order changed · 9 SKUs│ ✓ Ready      │ up to 24 h    │
│ ☑ │ eBay IT · ★ Listing 1        │ Gallery: 1 new                     │ ✓ Ready      │ 1 revision    │
│ ☐ │ eBay IT · ① Winter           │ Nero photo 3 is too small          │ ⚠ Fix first  │               │
│ ☑ │ Shopify · xavia.it           │ 2 new photos, 9 variant images     │ ✓ Ready      │               │
└───┴──────────────────────────────┴────────────────────────────────────┴──────────────┴───────────────┘
Only photos are sent. Titles, prices and stock are not touched.
                                               [Cancel]   [Publish photos to 3 destinations · skip 1]
```
Then one progress list: **Sent → Accepted → Live (checked on the channel)** or **Failed** with the channel's own
reason and **Retry**. The same results appear in the destination table's status column and in Activity.

### 5.7 The Information page's "Product media" column
- Same data, same editor. The cell shows the row's resolved photos: on a child row, its colour set then the common
  photos (common photos dimmed, tooltip "Nero · shared by 9 SKUs, then 4 common photos").
- Editing from a child row asks nothing extra: it edits **Nero** (all 9 SKUs), with a switch **Only this SKU** that
  makes a per-SKU set. On the parent row it edits **Common**. On a channel sheet it edits that layer.
- Enter/F2 opens the **same set editor component** the Media page uses (one component, not a copy). Copy, paste and
  fill-handle keep working (they write the target row's set).
- The column shows the versions for the sheet's language (an IT sheet shows the Italian size chart).
- Changes appear on the other screen at once (§6.4).

### 5.8 States
Loading (skeleton, "Still loading…" after 4 s with Retry), empty ("No photos yet — drop files here"), no axis
("This product has no options — one gallery"), read error (the server's own sentence + Try again), channel not
connected (row says so, no controls), account needs reconnect (row warning, publish refused with the reason).

---

## 6. Data and API

### 6.1 New table `ProductMediaPlan` (additive migration)
```prisma
model ProductMediaPlan {
  id                  String   @id @default(cuid())
  workspaceId         String
  productId           String   // family root (parent) or single product
  layer               String   // 'SHARED' | 'CHANNEL' | 'LISTING'
  channel             String   @default("")   // '' on SHARED
  marketplace         String   @default("")   // '' unless LISTING; 'GLOBAL' for Amazon/Shopify listings
  channelConnectionId String   @default("")   // '' unless LISTING
  aliasKey            String   @default("")   // '' = primary listing
  plan                Json     // validated by packages/shared media-plan schema (v1)
  revision            Int      @default(1)
  updatedById         String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  @@unique([workspaceId, productId, layer, channel, marketplace, channelConnectionId, aliasKey])
  @@index([workspaceId, productId])
}
```
- `plan` v1: `{ version: 1, axis?, sets: { common?, values?: {value: Item[]}, skus?: {childId: Item[]},
  swatches?: {value: assetId}, safety? } }`. **A missing key = follow the layer above; a present key (even `[]`) =
  own.** `Item = { assetId }`.
- Classified in `model-ownership.json` (hard rule 5), workspace RLS, migration + `check:drift` + baseline regen.
- Account-restricted members can only write LISTING rows of accounts they may use (checked in the API with the
  existing destination resolver).
- `ProductImage` gains two additive columns for §4.8: `languageTag` (`zxx` default, `mul`, or a language code) and
  `versionGroupId` (versions of one photo share it). A set item points at any version; the resolver picks the version
  for each destination's language.
- Alt text stays per photo per language in the library (one place), used by Shopify, Etsy and eBay where supported.
- Later (P5) `ChannelMediaAsset`: cached channel copies — eBay EPS URL per account, Shopify file id per store, Etsy
  image id per listing — keyed by photo hash, so a photo is uploaded to a channel once.

### 6.2 Shared logic (`packages/shared/media-plan/`, pure, unit-tested)
`schema.ts` (zod) · `limits.ts` (all channel limits) · `resolve.ts` (layers → resolved sets + provenance) ·
`project-{ebay,amazon,shopify,etsy}.ts` (§4.4) · `languages.ts` (market → language, version choice, fallback) ·
`checks.ts` (sizes, counts, white MAIN, transparency, CMYK, eBay URL length, repeats, empty common, value without
photos, alias duplicate note, missing language versions, markets sharing an eBay SKU) · `filenames.ts` (§4.6) ·
`ops.ts` (move / add / remove / reorder / own / follow, with inverse ops for Undo).

### 6.3 Endpoints
- `GET /api/products/:id/media` — **one read for the whole page**: family (axis, values, variants), library (with
  usage), layers, destinations, resolved sets, per-destination layout + checks, channel status. Target < 800 ms for
  an 18-variant family (today's master read takes ~6 s; measured in P0 and fixed).
- `POST /api/products/:id/media/ops` `{ baseRevision?, ops[] }` — applies small operations to the latest plan in one
  transaction, re-checks the no-repeat rule, returns the new state + undo ops. Operations on different sets never
  conflict with each other.
- Uploads keep `POST /products/:id/images` (dedup gate) — then one `ops` call assigns them.
- `POST /api/products/:id/media/publish/preview` `{ destinations[] }` → per-destination changes + checks;
  `POST …/publish/submit` → runs; `GET …/publish/:runId` → progress.
- The old per-destination endpoints stay until P6, reading the new store.

### 6.4 Real-time
- New event `product.media.changed { productId, rootProductId, layerKey | null, reason: 'library' | 'plan' |
  'publish', revision }` in `packages/events/catalog.ts` (hard rule 8), sent after every plan write, library write and
  publish result.
- Added to the listing bus → SSE → BroadcastChannel `nexus:invalidations` as a new `product-media` type.
- Listeners: the Media page (quiet refresh; never while you are dragging), the Information sheet adapters (refresh
  only the rows of that family), the catalog thumbnails (`ProductReadCache.imageUrl`). Same-tab changes also send a
  local invalidation, so the other panel updates instantly.
- The narrow `revision` per plan row replaces today's whole-row hash, which ends the false conflicts between photo
  saves and sheet cell edits.

---

## 7. Publishing, per channel
All calls go through the channel gateway (hard rule 4) and respect each channel's publish switch.

| Channel | How | Notes |
|---|---|---|
| Amazon | The existing `AmazonMediaRun` (observe → diff → validation preview → PATCH), fed by the Amazon layout; **one run per account** using one listed market as the selector | Read-back on a second market proves the global rule for our account (P2 proof). PS via product-type schema where writable, else ZIP. Country photos: ZIP per country for Seller Central (P5). A+ per market: P8 if D7 = A. |
| eBay | Studio publication with the **photos-only selection** ("Listing pictures" + "Variation pictures" already exist in its review), fed by the eBay layout | Fix its cap to 12 per value set. Trading and Inventory listings both covered. D3: upload to eBay Picture Services once per account via the Media API (variation photos are not copied to EPS by eBay; after a sale they cannot change otherwise). |
| Shopify | The existing content sync, photo part only (`fileCreate` → `productSet` files + variant file), fed by the Shopify layout | Reuses files by id; `productSet` list is the full truth, so the layout must be complete. Store's main language version; alt text per language via translations. |
| Etsy | **New**: `uploadListingImage` (binary) + `updateVariationImages`, through the gateway, behind the Etsy publish switch | Uses the unused `listing-write.service.ts` functions. |

### 7.1 ZIP exports (Amazon safety images and country photos)
The Owner asked to reuse the previous edit page's ZIP export. Code study 2026-09-27 — two exports exist:
- **A. Previous edit page** — "Export ZIP ▾" (one market or "All markets", a preview of files per market, "Include
  safety images"): `routes/images/amazon-images.routes.ts:432-509`, `services/images/amazon-image-zip.service.ts`,
  web `tabs/images/amazon/{AmazonPublishBar,ExportPreviewModal,AmazonPanel}.tsx`. The UI is unreachable since the
  edit page moved to the studio; the API is still mounted. No tests.
- **B. Studio safety export** — "Export PS images": `services/images/amazon-media-safety-export.service.ts`, pure plan
  `planAmazonSafetyExport` in `packages/shared/amazon-media.ts`, 9 route tests.

**Decision: keep A's experience, run it on B's engine.** A's screen and flow come back (per-market preview with
counts, blocked items with reasons, one ready ZIP per market). A's engine does not, because the study found real
faults in it:
1. It reads the old `ListingImage` store with no guard → can export photos that are not the ones you see.
2. One ASIN per SKU for every market and account; two SKUs on one ASIN silently overwrite each other's file.
3. Writes `.webp` and mislabels unknown or HTML error responses as `.jpg` (Amazon rejects both).
4. Can emit slot names Seller Central cannot map (`IMG01`), and drops PS images for a minute after a cache miss.
5. Only IT/DE/FR/ES/UK; BE, NL, PL, SE, IE, TR fail.
6. Blocks a whole ASIN for rules that do not apply to a country upload; a "DE ZIP" repeats every inherited photo.
7. Sequential downloads, no dedupe, no deadline, no 1,000-file / 1 GB caps; "All markets" is re-zipped in the browser.
8. Partial archives by default and the reasons never reach you; one response header can grow past its size limit.
9. Downloads bypass the safe fetcher (no private-IP / redirect protection).

B already does it right: per-market ASIN from the listing, same-ASIN conflict check, every file converted to a real
JPEG (white background, rotation fixed), each photo downloaded once, 4 at a time, safe fetcher, all-or-nothing with
the exact reason, and a revision check so the ZIP matches what you saw.

**Build (P5):** a shared pure `planAmazonArchive({kind: 'safety' | 'country', market, languages, …})` with the file
naming (`ASIN.SLOT.jpg`), the slot allow-list (MAIN, PT01–08, SWCH, PS01–06), and limits (1,000 files); one archive
service used by both kinds (streamed, file cap, deadline fix, JPEG quality ~92–95); a `country-export` route beside
`safety-export`; the previous page's preview as one DS component for both kinds. A **country ZIP holds only the
localized photos** for that market (not the global ones), and the dialog names the exact Seller Central tool
("Image Manager → Country-Specific Upload"), because an upload through the normal bulk upload would replace the global
photos. A's service and routes are removed in P6.

### 7.2 Previous eBay builder — behaviours to keep, faults to leave behind
Code study 2026-09-27: `tabs/images/ebay/EbayPanel.tsx`, `tabs/images/ChannelImageGrid.tsx`,
`tabs/images/ImagePickerModal.tsx`, and its later form in the eBay flat-file drawer
(`ebay-flat-file/EbayFlatFileImageModal.tsx`, `imageBuckets.pure.ts`). Its 697 rows are today's real curation.

**Keep (all of it):** Common row pinned first, then one row per value · numbered positions, 1 = ★ Main · red "No main
photo" on a row with an empty position 1 · drag from the library strip, drag cell to cell, "set as main" · removing
the Main asks first and shows which photo becomes Main · click to enlarge · picker with "upload new" · dense
renumbering on every edit · refuse (with the reason) any action that would pass the limit · an explicit "one shared
gallery" mode (no per-colour photos) · axis warnings above the grid, never inside a row · unmatched values listed by
name · per-market axis choice · "Copy this set to…" · a live strip per value · cells inherited from Common shown faded.

**Leave behind (faults found in the code):**
1. Changing the axis threw away unsaved edits.
2. Rows saved under a synonym ("Colore" vs "Color") were invisible, never deleted, yet still published — old and new
   photos mixed in one set.
3. Values stored but not shown were still published.
4. "Nero" and "nero" were two rows in the editor but one set at publish, with photos interleaved out of order.
5. A drag between rows could create a 13th photo that was not visible and was cut at publish.
6. Market and media type were ignored when loading and saving.
7. The axis choice was saved globally while publishers read the per-market choice, so they could disagree.
8. The publishers sort all rows by position across sets (no tie-break); the Trading shell lane interleaves sets
   (Nero 1, Giallo 1, Nero 2…) in shared mode; a value with no set silently falls back to that SKU's own images
   (first 6); common is cut to 12 without a word; the read-back checks membership, not order, in Italian only.

**Axis identification (the part the Owner said needed work):** a value set is keyed by the variation theme's
**attribute code + option code** (VTR dictionary: e.g. `color` + `black`), never by display text. Text is matched to an
option once (trim, case, accents, spaces, labels per language and synonyms — `optionForValue`); a value that has no
option is listed by name and blocks publishing for that listing until it is mapped. At publish, each market's axis name
comes from the variation projection (`channelName`) and each value's name from the channel value (`channelAxisValues`:
pin or value map), so eBay IT gets "Nero" and eBay DE gets "Schwarz". The 547 legacy value rows migrate the same way
(case twins merged in their own order; unmatched values listed for the Owner).

**Limits (eBay documentation):** up to 24 photos per listing (Common); up to 12 per variation value. Checked before
sending, never cut. The P2 proof confirms 24 Common photos on the Inventory path, because today's Inventory publisher
cuts the group to 12; if eBay refuses 24 there, the limit becomes 12 for that path (one line in `limits.ts`).

**A value with no photos:** eBay shows "no picture available" for it, so the review **blocks** that listing until
every value has at least one photo, and offers "Use Common photo 1 for Giallo" as a one-click fix (recommendation,
Owner delegated 2026-09-27).

Nothing is published without the Review & publish click. Every real-channel proof in P2/P5 uses the XAVIA test family
(or GALE-JACKET) and needs the Owner's word per run.

---

## 8. Moving old data and removing old code

### 8.1 Migration (P6, dry run first)
**P0 measured (MEASURE.md):** the real curation is the previous edit page's eBay builder — 697 `ListingImage` rows on
31 Xavia families — plus 327 eBay `imageUrls` and 4 `_mediaGalleryDraft`. The other stores are empty in production.
One backfill function per family reads today's stores and writes plan rows, using **the same precedence the
publishers use today**, so a migrated family sends exactly what it sends now:
1. Master `_productMedia` → SHARED. 2. eBay `_mediaGalleryDraft` → eBay LISTING rows. 3. `_amazonMediaWorkspace`
(per market) → Amazon LISTING row (markets that differ are listed for the Owner to pick one — Amazon only keeps one).
4. `_productMediaLocales` per listing → LISTING rows (collapsed to a CHANNEL row when all listings agree).
5. Shopify `_nexusContent` media groups → Shopify LISTING row. 6. `ListingImage` (incl. the 22 shells) → the matching
layer / adopted alias. 7. Per-language collections in `_productMediaLocales` → language versions of one photo when
only the language differs; listing-layer sets when the sets really differ (P0 shows which).
- **Parity proof:** for every family, the new layouts are compared with what each publisher would send today.
  The dry run must show 0 differences (or a named list the Owner accepts) before anything is written.
- A family is switched when its SHARED row exists. Until then, publishers read the old stores (no flag, no dark code).
  The Owner's word is needed before the production backfill runs.

### 8.2 Removed after the switch (one release later)
`_studio/images/{channel,plan,publish,local}/**`, `amazon/*`, `ebay/*`, the media part of `shopify/*`,
`_studio/media/ProductMediaDialog.tsx` (replaced by the shared set editor), the legacy `edit/tabs/images/**` tree,
the legacy publishers (`/amazon-images/publish`, `/ebay-images/publish`, the `/shopify-images/publish` stub, the
scheduled image publish job), and the old JSON keys. `ListingImage` stays read-only until the eBay flat file and the
description themes read the new resolver (they are listed in §11).

### 8.3 Nothing lost — capability checklist
| Today | In the rebuild |
|---|---|
| Upload with dedup, near-duplicate review | Same gate, inside the upload dialog |
| Viewer, alt text, type, crop/rotate/flip (new derived photo), push to DAM, DAM import, AI lifestyle scene, find duplicates, videos | Library panel (same functions, same routes) |
| Set hero / reorder / delete / apply to children | Sets (main = first), drag, remove, SKU sets |
| eBay common + variation galleries, axis, copy from, buyer preview, review | eBay channel view + layers + checks |
| Amazon slots, common + per SKU, apply to SKUs (fill/replace/inherit/clear), copy from market, check Amazon, review & publish, PS ZIP | Amazon channel view; copy-from-market is no longer needed (one set per ASIN); bulk verbs on SKU sets |
| Shopify groups/assignments, variant preview, alt text, sync | Sets + Shopify layout + channel view; metafields editor unchanged |
| Sheet column: strip, reorder, copy/paste/fill, dialog, per-language alt | Same column on the new store, same editor as the Media page |
| Publish history, schedule (dead today) | Status column + Activity; scheduling is out of scope (the cron is off) |

---

## 9. Phases (one PR each; typecheck + area tests + screenshots before each PR)

| Phase | What | Exit check |
|---|---|---|
| **P0 Measure** (read-only) ✅ 2026-09-27 | Count each store in production per business; languages used; aliases and shells; families where stores disagree; Amazon markets whose drafts differ | ✅ `MEASURE.md` — 0 per-language sets, curation = 697 eBay `ListingImage` rows, 4 aliases, eBay IT only |
| **P1 Data spine** 🟡 built + tested locally 2026-09-27, not committed (PROGRESS.md) | Table + migration (incl. `ProductImage.languageTag`/`versionGroupId`), shared schema/resolver/projections/languages/checks/ops/filenames, `GET /media`, `POST /media/ops`, event + bus + invalidation type; backfill scripts (dry run) for the missing `dhash256` (214 Motovento photos) and width/height (419 photos) | Unit tests for every channel layout, language choice and rule; `check:drift`; typecheck all changed workspaces; no UI change |
| **P2 Publishers read the spine** | Amazon run, eBay studio publication, Shopify sync read the resolver when a family has a plan; eBay cap 12; publish preview/submit | Parity tests (new vs today: 0 differences); one real proof per channel on the test family with the Owner's word |
| **P3 New page + column** | Media page (§5.1–5.4, 5.7, 5.8) incl. language versions and "Show as", shared set editor, live refresh, lazy migration of a family on first open | Screenshots light/dark/narrow; keyboard walk-through; the column and the page update each other live; Owner eyeball |
| **P4 Upload & bulk** | Upload dialog with file-name rules (set, position, language), Add-to, Compare, Undo/Redo, Review & publish dialog | Scenario: 18 files incl. a size chart in 4 languages → 6 destinations in under 10 clicks; eBay DE shows the German chart |
| **P5 Etsy, eBay hosting, country photos, live status** | Etsy publisher; EPS upload per account (D3); `ChannelMediaAsset`; Amazon country ZIPs for Seller Central; read-back per channel for the status column | Real proofs with the Owner's word; one country upload tested on the test family |
| **P6 Migrate + delete** | Backfill (dry run → Owner's word → run), shells' photos, remove old code and stores | Parity report 0; `grep` shows no reader of old keys |
| **P7 Hardening** | Playwright flows, performance on a 100-variant family, accessibility audit, docs | All green; docs updated |
| **P8 Amazon A+ per market** (only if D7 = A) | A+ Content documents per market and language through the SP-API A+ Content API, carrying the localized size chart and infographics | One market proven on the test family with the Owner's word |

DS gaps (e.g. a multi-row photo board with keyboard move between rows) are added to the design system, exported,
catalogued, logged in `.claude/DS-GAPS.md`, and mirrored to `apps/factory` (AGENTS.md).

---

## 10. Decisions for the Owner

| # | Question | Option A | Option B | Status |
|---|---|---|---|---|
| **D1** | How many override layers? | **3: Shared → Channel → Listing** | 2: Shared → Listing, plus a "copy to all eBay listings" button | ✅ **A** — agreed 2026-09-27 |
| **D2** | A new alias starts with… | **Following Shared/Channel** + one-click "Copy from ★ Listing 1" | A copy of ★ Listing 1's photos | ✅ **A** — agreed 2026-09-27 |
| **D3** | eBay photo hosting | **Upload to eBay Picture Services once per account** (Media API), cached | Keep sending our own URLs | ✅ **A** — agreed 2026-09-27 |
| **D4** | Photos per language | ~~Remove~~ | ~~Keep per-language sets~~ | ✅ **Answered by the Owner 2026-09-27:** size charts and infographics need their language per market → **language versions of one photo** (§4.8); whole different sets per market stay possible through the listing layer |
| **D5** | Storage | **New table `ProductMediaPlan`** | Keep JSON inside each listing row | ✅ **A** — agreed 2026-09-27 |
| **D6** | A market's language version is missing | **Show the nearest version** (English → several languages → main language) and warn | Leave the photo out for that market and warn | ✅ **A** — agreed 2026-09-27 |
| **D7** | Amazon A+ Content per market (localized size chart and infographics under the description, by API; needs Brand Registry) | **Add as phase P8** after the main rebuild | Not in this programme | ✅ **A** — agreed 2026-09-27 |
| **D8** | May the same photo be in Common **and** in a colour set on eBay (e.g. the cover is also Nero's main photo)? | **Yes, on purpose only:** dragging moves by default; "Also use in…" (or ⌥-drag) adds it to a second set; the tile shows "also in Common"; never twice inside one gallery | **No, never:** a photo lives in exactly one set | ✅ **A** — agreed 2026-09-27 |

**Owner direction 2026-09-27 (with the go):**
- **Reuse the ZIP export of the previous edit page** for the safety-image ZIP and the new country-photo ZIPs; check it
  for issues and perfect it (§7.1).
- **eBay has two sections and the order must always be right** (§4.9): the common photos come first on the listing
  page; clicking a colour shows that colour's photos. **Assigning photos by axis must be fast**; the previous edit
  page's eBay builder did this well and needed better axis identification (§4.9).

The no-repeat rule (§4.1) is taken from the Owner's words ("so that there are no repeat images") and is not listed as
a decision. It reverses the current eBay page's "reuse is intentional".

## 11. Risks and open points
- **Amazon one run per account:** we assume a PATCH on one market sets all markets (Amazon's documented global rule).
  P2 proves it with a read-back on a second market before the UI relies on it.
- **Amazon per-market drafts that differ today:** only one can survive (P0 counts them; the Owner picks).
- **eBay aliases on the Inventory API need their own SKUs.** Aliases without one are shown as "cannot publish photos
  — needs its own SKU" (same honesty as Amazon Media today).
- **eBay revisions:** every photo publish is a revision (250 per listing per day) — shown in the review.
- **Amazon country photos** are a Seller Central tool for brand owners, with no API. Whether a later API publish of
  the global set leaves the country photos in place is not documented — tested once on the test family (P5) before
  the page promises it. If the account is not the brand owner, only the global set applies and the page says so.
- **eBay markets that share SKUs** (Inventory API) cannot have different language versions; P0 counts them.
- **Touches outside the Media page** (named here so nothing is a surprise): the Information sheet column
  (`_studio/media/*`, the sheet adapters — the sheet-toolbar lane `feat/sheet-toolbar-rebuild` works nearby; we
  coordinate), studio publication eBay/Amazon, Shopify content sync, the eBay flat file's `image_1..6` and its image
  modal (flat-file editors: no-touch rule lifted 2026-09-24 — confirmed again before P6), eBay description-theme
  galleries, `ProductReadCache.imageUrl`.
- **Local dev hits production** unless `NEXT_PUBLIC_API_URL` is set (hard rule 3). All UI checks run against a local
  API and database; real-channel proofs run only with the Owner's word.

## 12. Out of scope
Scheduled photo publishing (cron is off), Amazon A+ content beyond localized size charts and infographics (P8), channel video publishing beyond Shopify/Etsy (later),
bulk photo editing across many products (the products list keeps its own tools), AI colour detection for file
assignment (possible later add-on to §4.6).
