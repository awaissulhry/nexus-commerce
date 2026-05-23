# Images tab — operator guide

Everything you can do from the **Images** tab on the per-product editor (`/products/[id]/edit` → **Images**). Written for catalog operators + their teammates; companion to [`amazon-image-upload.md`](./amazon-image-upload.md) which covers the publish pipeline in depth.

> **Where to take screenshots.** Each section heads with a path through the UI. Capture screenshots of those views as you read and drop them into this doc beneath the matching section. The ASCII sketches give you a layout reference for what should be in frame.

---

## Big picture

The Images tab is **one place to manage all images for one product across every channel + every variant + every marketplace**. You set images once at the right level of specificity (master → group → variant → marketplace); the resolver figures out what goes where at publish time.

```
Product (parent SKU)
 ├─ Master gallery       ← canonical images, one source of truth
 │
 ├─ Amazon
 │   ├─ All Markets
 │   ├─ IT  ┐
 │   ├─ DE  │  per-marketplace overrides
 │   ├─ FR  │
 │   ├─ ES  │
 │   └─ UK  ┘
 │
 ├─ eBay (one gallery + per-color sets)
 │
 └─ Shopify (pool + variant assignments)
```

If a cell isn't explicitly overridden, it **inherits** from the parent scope. The cascade always falls through to the master gallery — so a single MAIN image at master level reaches every variant on every channel automatically.

---

## Layout

```
┌─ Product header ────────────────────────────────────────────────────┐
│ XAVIA GALE Giacca Da Moto…       [Matrix] [Datasheet] [Save] [...]  │
│ GALE-JACKET · B0F7J163XJ         18 variants                        │
│ Master Data │ Images │ Matrix │ Analytics │ Ads │ Amazon │ …        │
└─────────────────────────────────────────────────────────────────────┘
┌─ Images tab ──────────────────────────────────┬─ Readiness sidebar ─┐
│ Master │ Amazon 75% │ eBay 67% │ Shopify 67% │ Master      100%     │
│                                              │ Has MAIN     ✓       │
│  [ active panel renders here ]               │ 3+ images    ✓       │
│                                              │ Alt on MAIN  ✓       │
│                                              │ ≥ 1000 px    ✓       │
│                                              │                      │
│                                              │ Amazon       33%     │
│                                              │ …                    │
└──────────────────────────────────────────────┴──────────────────────┘
```

- **Top tab strip** — `Master · Amazon · eBay · Shopify`. The colored chip on each non-master tab shows the readiness score (e.g. `Amazon 75%`).
- **Active panel** — fills the body. Layout depends on which sub-tab is selected.
- **Readiness sidebar** — always visible on the right. Lists which quality / coverage checks pass per channel.
- **Save / Discard / Publish** — global header buttons. See [Save vs Publish](#save-vs-publish-vs-discard) below.

---

## Save vs Publish vs Discard

These three buttons run very different jobs. Use the right one for the intent.

| Action | Where | What it does |
|---|---|---|
| **Save** | Top header (sticky) | Commits all your pending edits (cell assignments, alt overrides, drag-drops, scoped uploads, bulk apply) to the Nexus database. Amazon doesn't know yet — this is local commit. |
| **Discard** | Top header (next to Save) | Wipes all pending edits without writing to the database. The matrix reverts to last-saved state. |
| **Publish** | Amazon publish bar inside the panel | Reads saved Nexus state → builds JSON_LISTINGS_FEED → submits to Amazon SP-API. Per-marketplace (Publish IT / Publish all markets). |

> **Workflow.** Edit → see your changes immediately → **Save** → **Publish** when ready. If you Save but skip Publish, Amazon still serves the old images until next Publish.

A pending counter in the header shows how many unsaved changes you have. The Save button only enables when that count > 0.

---

## Master sub-tab

The master gallery is the **source of truth**. Every channel cell falls back to a master image of the matching type if no override exists.

```
┌─ Master gallery ────────────── 21 images ─── [Select] [Type ▾] [Upload]
│                                            [Upload to variant…]
│                                            [From library] [Generate]
│                                            [Apply to children]
│
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ │ MAIN │ │ MAIN │ │ MAIN │ │LIFEST│ │LIFEST│
│ │ ⭐ ☐ │ │   ☐ │ │   ☐ │ │   ☐ │ │   ☐ │   ← ★ = primary (PG.4)
│ │ jpg  │ │ jpg  │ │ jpg  │ │ jpg  │ │ jpg  │
│ │ 2250 │ │ 500  │ │ 75   │ │ 2000 │ │ 2000 │
│ │ 1.2M │ │ 240K │ │ 21K  │ │ 980K │ │ 1.1M │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘
│ ┌──────┐ …
│
│ • Drag images to reorder. Position 1 = default for all channels.
│ • Use the ··· menu to copy any image into a channel panel.
│ • Drop image files anywhere on the grid to upload.
└──────────────────────────────────────────────────────────────────────
```

### Header bar buttons

| Button | What it does |
|---|---|
| **Select** | Toggle bulk selection mode. Cmd+A selects all; click individual cards to add. With ≥ 2 selected, drag carries the whole set. |
| **Type ▾** | Default image type for the next upload (`MAIN / ALT / LIFESTYLE / SWATCH / DIAGRAM`). |
| **Upload** | File picker. Uploads as the chosen type. Dedup gate (IE.1) catches exact + near-duplicate uploads. |
| **Upload to variant…** | Opens [ScopeUploadModal](#scope-upload-modal-variant-targeted). Pre-tags the upload with `Color = Giallo` (or any axis value) + channels. |
| **From library** | Opens the [DAM picker](#dam-library-picker). Pulls existing assets — no re-upload. |
| **Generate lifestyle** | AI-generates a new lifestyle image via Imagen 3 from a text prompt. |
| **Apply to children** | Parent-only. Mirrors the gallery onto every child SKU's gallery. |

### Per-card affordances (hover)

```
┌────────────┐
│ ⭐         ⋯  │   ← top-left: ⭐ set primary  /  top-right: ⋯ menu
│ ☐          │   ← top-left (on hover/select): selection checkbox
│   IMAGE    │
│            │   ← click anywhere on card body: open lightbox
│            │   ← drag from anywhere on card: reorder / drop on cell
│ MAIN       │   ← type pill
│ 2250×2250  │   ← dimensions + filesize on hover
└────────────┘
```

| Affordance | What it does |
|---|---|
| **Card click** | Opens the lightbox at this image. ←/→ to navigate, Esc to close. |
| **Card drag** | Reorders the gallery if dropped on another card. Drops on a channel cell assign that image. |
| **★ button** | Toggle "primary" — the hero shown in the `/products` list, datasheet thumbnail, etc. At most one primary per product. |
| **☐ checkbox** | Add to selection. Once multiple are selected, the bulk action bar appears with "apply to channel" CTAs. |
| **⋯ menu** | Edit alt text · Use in Amazon / eBay / Shopify / all channels · **Apply to…** (IE.12 bulk-apply modal) · Delete |

### Lightbox

Opens on card click. Shows:

- Full-size image with prev/next arrows
- Dimensions + file size + mime type
- Alt text + type editor
- "Where this image is used" — list of channel cells, variants, marketplaces
- Crop & rotate editor (IR.4 — saved as a derivative ProductImage)
- AI vision panel — runs Gemini Vision to flag white-background, frame-fill %, text-overlay, off-center scoring

---

## Amazon sub-tab — the Color × Slot matrix

This is where most of the work happens. One row per **variant group value** (default: by Color), one column per **Amazon slot** (MAIN, PT01..PT08, SWCH).

```
┌─ Amazon ─ [All] [IT] [DE] [FR] [ES] [UK]                    Group by [Color ▾]
│
│ ┌─ Live on Amazon IT (refreshed 2h ago) ───────────────── ⌃ collapse ─┐
│ │ B0F7J163XJ  [img][img][img]…                                       │
│ │ Refresh                                                            │
│ └────────────────────────────────────────────────────────────────────┘
│
│ ┌─ Stale banner (only when stale rows exist) ────────────────────────┐
│ │ ⚠ 3 ASINs have stale images on Amazon IT [Re-publish stale]        │
│ └────────────────────────────────────────────────────────────────────┘
│
│ ┌─ Filter bar ───────────────────────────────────────────────────────┐
│ │ Color: [Nero] [Giallo]    Status [All ▾]   [Presets ▾]  [Clear]    │
│ └────────────────────────────────────────────────────────────────────┘
│
│       MAIN   PT01   PT02   PT03   PT04   PT05   PT06   PT07   PT08   SWCH   ⋯
│ Nero  [🔗]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]
│ Giallo[🎯]   [🔗]   [🔗]   [🔗]   [🔗]   [🔗]   [+ ]   [+ ]   [+ ]   [+ ]
│ All   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]   [+ ]
│
│ ┌─ Publish bar ──────────────────────────────────────────────────────┐
│ │ Publish: [IT] [DE] [FR] [ES] [UK]  [Publish all markets] [Preview] │
│ │                                                       [Export ZIP ▾]│
│ │                                                                    │
│ │ Recent jobs                                                        │
│ │ ✓ Amazon IT · Done · 2h ago · 18 ok                                │
│ │ ✓ Amazon DE · Done · 2h ago · 18 ok                                │
│ └────────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────────
```

### Marketplace tabs (top)

`All Markets · IT · DE · FR · ES · UK` — switch which marketplace's overrides you're editing. Italics + a small dot indicate marketplaces that already have published images. **All Markets** writes `scope=PLATFORM` rows (applies to every market); a specific marketplace writes `scope=MARKETPLACE` rows.

### Live on channel strip (IE.5 + IA.8)

Above the matrix. Shows what Amazon is currently serving for each ASIN on each marketplace.

- Click the header to **collapse** / expand (state persists per-channel in your browser).
- Per-marketplace row of thumbnails with timestamps.
- **Refresh** button per row → fetches via SP-API `GetListingsItem`.
- ⚠ amber border on thumbs that **differ** from your Nexus state — click for a side-by-side diff modal.
- **Drag a live thumb onto any matrix cell** → assigns that URL as a pending override. Useful when you want to mirror what Amazon already has.

### Stale banner (IA.5)

Only appears when at least one ASIN has stale images on the current marketplace. "Stale" = master image was updated after the last successful publish, so Amazon is still serving the old version even though Nexus shows the new one.

- One-click **Re-publish stale** filters the feed to just those ASINs.
- IA.4 validation still runs first.

### Filter bar (IE.11 + IE.13)

| Element | What it does |
|---|---|
| **Color/Size chips** | Multi-select. Click "Giallo" to hide every other color's row. Empty selection = show all. |
| **Status ▾** | `All / Empty / Inherited / Override`. Dims cells that don't match the chosen status. |
| **Presets ▾** | Save current filters as a named preset (e.g. "QC review queue", "Empty cells only"). Bookmark-style; persists per-browser. |
| **Clear** | Resets all filters. |
| URL persist | `?img.values=Giallo,Nero&img.status=empty` — share filtered views via link. |

### The matrix grid

Each row = one variant-group value (e.g., Nero, Giallo). Each column = one Amazon slot. Each cell = the image that **would publish** for that combo.

**Cell badges:**

| Visual | Meaning |
|---|---|
| `🔗` dashed border | **Inherited from master gallery** (IE.3 auto-seed). Master MAIN populates every Color's MAIN cell by default. |
| `∀` solid border | **Inherited from a wider scope** — All Markets / All Colors. |
| `🎯` solid blue border | **Explicit override** at this exact scope. Your variant-specific image. |
| Red outline | Image is **below the Amazon 1000 px minimum**. |
| Amber ring | **Pending unsaved change**. |
| Green dot | **Published** to Amazon. |
| Red dot | **Publish error** — hover for Amazon's verbatim message. |
| `⚪` (MAIN only) | White-background check via AI vision. Green = good, red = needs fixing. |

### Cell actions

| Gesture | What it does |
|---|---|
| **Click cell** | Open lightbox at this image. |
| **Click `+` (empty)** | Open ImagePickerModal — pick from master gallery or upload new. |
| **Drag from master → cell** | Assigns master image to this cell (creates pending upsert). Save commits. |
| **Drag cell → cell (same matrix)** | Move or swap (see [Drag rules](#drag-and-drop-rules)). |
| **Drag from Live strip → cell** | Assigns the live URL as a pending upsert. |
| **Drag desktop file → cell** | Uploads as a new master, then assigns to cell. |
| **Hover: ↺** | "Revert to master" — drops the override; cell falls back to inherited (IE.17). |
| **Hover: Change** | Opens the picker to replace this cell's image. |

### Row actions (⋯)

Each row has a `⋯` menu with:
- **Publish by ASIN / SKU** — submit just this variant
- **Copy row** → IT / DE / FR / ES / UK — duplicate this row's slot assignments to another marketplace
- **Clear all slots** — drops all pending changes for this row

### Publish bar

Lives at the bottom of the Amazon sub-tab.

| Button | What it does |
|---|---|
| **Publish [Market]** | Submits the JSON_LISTINGS_FEED for one marketplace. Runs the IA.4 validator first — refuses on hard fails. |
| **Publish all markets** | Loops through every Amazon market sequentially. |
| **Preview** | Opens [PublishPreviewModal](#pre-publish-preview-modal-ia2) — see what would publish before clicking submit. |
| **Export ZIP ▾** | Per-market ZIP downloads + "All markets" (per-market folders). Honors the IA.4 validator. |

Recent jobs list below shows the last 3 submissions with status badges.

### Pre-publish preview modal (IA.2)

Click **Preview** before publishing to see exactly what the publisher will send:

```
┌─ Publish preview — Amazon IT ──────────────────────────────────────┐
│ Variants: 18/18 with ASIN · 17/18 with MAIN  ⚠ 1 missing MAIN     │
│ axis: Color                                                       │
│                                                                   │
│ ⚠ Validation                                                      │
│   MAIN_MISSING · GALE-JACKET-GIALLO-3XL · ASIN needs MAIN before  │
│                                            publish                │
│                                                                   │
│ SKU              ASIN        Attributes      MAIN PT01 PT02 …Cover│
│ GALE-NERO-S      B0AAA…      Color: Nero …   [▦]  [▦]  [▦]  9/10  │
│ GALE-NERO-M      B0AAB…      Color: Nero …   [▦]  [▦]  [▦]  9/10  │
│ GALE-GIALLO-XS   B0AAH…      Color: Giallo…  [▦]  [▦]  [▦]  9/10  │
│ GALE-GIALLO-3XL  B0AAO…      Color: Giallo…  [⚠]  [▦]  [▦]  9/10  │
│                                                                   │
│                                          [Close] [Publish to IT]  │
└───────────────────────────────────────────────────────────────────┘
```

- **Headline coverage** — `18/18 with ASIN · 17/18 with MAIN` so problems jump out.
- **Validation banner** — red for hard fails (block publish), amber for soft warnings (informational).
- **Per-ASIN table** — every variant × every slot. Empty MAIN highlights the row red. Click a cell for the source drill-down (variant override / group inheritance / product fallback).
- **Publish button** — disabled when any hard fail exists. Confirms publish using the same plan the table shows.

### Validation rules (IA.4)

**Hard fails** (block publish):

| Code | Meaning |
|---|---|
| `MAIN_MISSING` | An ASIN has no MAIN image. Amazon rejects the listing. |
| `IMAGE_TOO_SMALL` | Resolved image's long edge < 1000 px. |
| `URL_INVALID` | Resolved URL is missing or malformed. |

**Soft warnings** (publish allowed, surfaced for awareness):

| Code | Meaning |
|---|---|
| `SWCH_MISSING_ON_COLOR` | A color variant has no swatch — Amazon's color picker UI shows less rich previews. |
| `TOO_FEW_IMAGES` | Fewer than 3 filled slots on an ASIN. |
| `MAIN_NOT_WHITE_BG` | Vision analysis flagged the MAIN as non-white-background. |

The same validator runs in:
- The publish endpoint (refuses on hard fails)
- The preview modal (shows them upfront)
- The ZIP exporter (skips blocked ASINs with reasons in the toast)

---

## eBay sub-tab

Two sections, both ordered:

```
┌─ eBay ──── 67% ready ──────────────────────────────────────────────┐
│
│ Gallery (up to 24)                                  [Copy from master]
│ ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐                          [Copy from Amazon]
│ │★1│ │ 2│ │ 3│ │ 4│ │ 5│  Position 1 = main listing image
│ └──┘ └──┘ └──┘ └──┘ └──┘
│
│ Color sets (one set per color, up to 12 each)
│ ┌─ Nero ─────────────┐
│ │ ┌──┐ ┌──┐ ┌──┐    │
│ │ │  │ │  │ │  │    │
│ │ └──┘ └──┘ └──┘    │
│ └────────────────────┘
│ ┌─ Giallo ───────────┐
│ │ ┌──┐ ┌──┐ ┌──┐    │
│ │ └──┘ └──┘ └──┘    │
│ └────────────────────┘
│
│ Publish bar
│ [Publish to eBay]   [Buyer preview]
└────────────────────────────────────────────────────────────────────
```

- **Gallery** — ordered list, drag-drop to reorder. Position 1 is the main listing image shown in search results.
- **Color sets** — eBay's `VariationSpecificPictureSet`. Each color variant carries its own set of images that appear when buyers select the color swatch.
- **Quick sync** — buttons to mirror from master gallery or Amazon Color×Slot matrix in one click.

---

## Shopify sub-tab

```
┌─ Shopify ──── 67% ready ──────────────────────────────────────────┐
│
│ Pool (up to 250)                                   [Copy from master]
│ ┌──┐ ┌──┐ ┌──┐ …
│ │★1│ │ 2│ │ 3│  Position 1 = featured image
│ └──┘ └──┘ └──┘
│
│ Variant assignments
│ Variant            Image
│ Nero · S           [thumb]   ← drag pool image here
│ Nero · M           [thumb]
│ Giallo · S         [thumb]
│ …
│
│ [Publish to Shopify]
└───────────────────────────────────────────────────────────────────
```

- **Pool** — all product images. Drag to reorder. Position 1 is the featured image.
- **Variant assignments** — each Shopify variant points to one pool image (Shopify's `variant.image_id`). Drag a pool image onto a variant row to assign.

---

## Scope upload modal (variant-targeted) (IE.10)

Opens from the master gallery's **Upload to variant…** button. Lets you tag an upload with its scope before it hits the database.

```
┌─ Upload 3 images ──────────────────────────────────────────────────┐
│ Where does this image apply?                                       │
│                                                                    │
│  ● Master (all variants, all markets)                              │
│  ○ Color    [Giallo ▾]                                             │
│  ○ Color+Size  [Giallo ▾] [XL ▾]                                  │
│  ○ Marketplace only  [Amazon IT ▾]                                 │
│                                                                    │
│ Image type: [LIFESTYLE ▾]                                          │
│ Channels:   ☑ Amazon  ☑ eBay  ☑ Shopify                            │
│                                                                    │
│ ✓ XV-GALE-GIALLO-MAIN.jpg → Giallo · MAIN                          │
│ ✓ XV-GALE-GIALLO-PT01.jpg → Giallo · PT01                          │
│ ⚠ jacket-v3.jpg           → [unscoped ▾]                           │
│                                                                    │
│                                          [Cancel] [Upload 3 files] │
└────────────────────────────────────────────────────────────────────┘
```

Submitting:
1. Uploads each file as a master `ProductImage`
2. For each selected channel, creates **pending ListingImage upserts** at the chosen scope
3. Amazon slot picked from image type (MAIN→MAIN, SWATCH→SWCH, others→next-free PT)

Save commits the whole batch atomically.

---

## Bulk apply modal (IE.12)

Right-click any master image → **Apply to…** opens a target picker.

```
┌─ Apply image to multiple variants ─────────────────────────────────┐
│  [thumbnail]   LIFESTYLE                                           │
│                2000×2000                                           │
│                                                                    │
│ Color values: ☑ Nero  ☑ Giallo  ☐ Bianco   (Color: 2/3 selected)   │
│ [All] [None]                                                       │
│                                                                    │
│ Amazon slot: [MAIN] [PT01] [PT02] [PT03] [PT04] …                  │
│              chosen: PT01                                          │
│                                                                    │
│ Marketplace: [All Markets] [IT] [DE] [FR] [ES] [UK]                │
│              chosen: All Markets                                   │
│                                                                    │
│ ⓘ 18 cells will be queued (12 new, 6 replacing existing)           │
│                                                                    │
│                                  [Cancel] [Queue 18 cells]         │
└────────────────────────────────────────────────────────────────────┘
```

- Multi-select variant values
- Pick the Amazon slot (default mapped from image type)
- Pick marketplace (All or specific)
- Live preview shows how many cells will be created vs replaced
- Save to commit the whole batch

Replaces the manual "drag 18 times" pattern with one modal submit.

---

## DAM library picker (IR.7 + IE.7)

Opens from **From library**. Browses `/marketing/content` DAM assets without re-uploading.

```
┌─ DAM library ─ [search box] ────────────────────────────────  ✕   ┐
│ Scope  [Brand: Xavia ✕]  [Type: Jacket ✕]                          │
│ Folder [Any ▾]   Tags [studio] [lifestyle] [detail]                │
│                                                                    │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                          │
│ │    │ │    │ │    │ │    │ │    │ │    │                          │
│ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                          │
│ ┌────┐ …                                                           │
│                                                                    │
│ Click an asset → imports into master gallery                       │
└────────────────────────────────────────────────────────────────────
```

- **Scope chips** at top default to the current product's brand + productType — surfaces "same brand, same category" assets first.
- Clicking an asset creates a `ProductImage` referencing the existing Cloudinary `publicId` — no re-upload, no extra cost.

---

## Drag and drop rules

Drag works from anywhere on the card (master gallery) or cell (channel matrix). Drop semantics depend on source + target:

| Source | Target | Action |
|---|---|---|
| Master card | Master card | **Reorder** (insertion-bar shows where it lands). |
| Master card | Channel cell | **Assign** master image to that cell (pending upsert). |
| Master multi-select (≥ 2 selected) | Channel cell | **Fan into slots** — first lands at target, rest fill next-free slots in order (MAIN→PT01..PT08→SWCH). |
| Channel cell | Channel cell (filled) | **Swap** — both cells exchange images. |
| Channel cell | Channel cell (empty) | **Move** — target gets the image, source clears. |
| Live strip thumb | Channel cell | **Assign** — uses the live URL. Source unchanged (live strip is read-only Amazon state). |
| Desktop file | Master gallery | **Upload** new master image. |
| Desktop file | Channel cell | **Upload + assign** — creates master + pending upsert in one step. |

After every drag a brief **Undo** banner appears for ~6 seconds:

```
Moved image — save to commit, discard or undo to revert    [Undo]
```

- **Undo** reverts just that drag (atomic restore of pending state).
- **Discard** wipes all pending (not just the drag).
- **Save** commits the post-drag state.

---

## How variant → ASIN mapping works (the cascade)

When you click **Publish**, the backend walks every child SKU (ASIN) of the parent and, for each slot, picks the **first matching** ListingImage row across 9 precedence levels:

| # | Scope | Means |
|---|---|---|
| 1 | exact variant × marketplace | "Giallo-XL ASIN's MAIN on Amazon IT" |
| 2 | exact variant × all-Amazon | "Giallo-XL ASIN's MAIN on every Amazon market" |
| 3 | exact variant × global | "Giallo-XL ASIN's MAIN on every channel" |
| 4 | group (Color=Giallo) × marketplace | "Color=Giallo's MAIN on Amazon IT" |
| 5 | group × all-Amazon | "Color=Giallo's MAIN on every Amazon market" |
| 6 | group × global | "Color=Giallo's MAIN on every channel" |
| 7 | product-level × marketplace | "Product MAIN on Amazon IT" |
| 8 | product-level × all-Amazon | "Product MAIN on every Amazon market" |
| 9 | product-level × global | "Master gallery MAIN" |

So when you set `Color=Giallo, slot=MAIN, image X`, every child ASIN with `variantAttributes.Color = "Giallo"` gets image X at MAIN on the marketplace(s) you chose. Other colors fall through to product-level / master.

**This means:**
- Set common images at master level → reaches everyone
- Override for a specific color → only that color gets it
- Override for a specific ASIN (use "Group by ASIN" in the matrix) → only that ASIN gets it
- All while keeping the underlying common images intact for everyone else

---

## Common workflows

### "I shot 9 photos of the Giallo jacket. Put them on all Giallo ASINs across all markets."

1. Master gallery → **Upload to variant…** → drop the 9 files
2. Scope: `Color = Giallo`, channels: ☑ Amazon ☑ eBay ☑ Shopify, type: LIFESTYLE
3. **Upload 9 files** → masters created + 27 pending channel rows (9 × 3 channels)
4. **Save**
5. Amazon panel → **Preview** to verify each ASIN's plan
6. **Publish all markets**
7. Receipt drill-down → confirm 18/18 accepted

### "I have 6 Giallo ASINs, want same images for 5, different for 1."

1. Set the common images at the **Color=Giallo group** level (drag into Giallo MAIN, PT01… in the matrix)
2. Group by → switch to **ASIN** (or SKU) in the matrix
3. Find the odd ASIN's row → drop the different image onto its MAIN
4. Save → Preview → Publish
5. The exact-variant row beats the group row in the cascade (level 1 > level 4)

### "I just changed a master image. Get it onto Amazon."

1. Edit the master image in the gallery (re-upload, swap, etc.)
2. Switch to Amazon tab → marketplace tab → **stale banner appears**
3. Click **Re-publish stale** → submits only affected ASINs
4. Receipt confirms

### "Drop 6 lifestyle shots into Giallo's slots in one gesture."

1. Master gallery → Cmd+click the 6 lifestyle shots → multi-select
2. Drag the multi-set onto **Giallo PT01** in the Amazon matrix
3. They fan: PT01, PT02, PT03, PT04, PT05, PT06 — all Giallo cells filled
4. Save → Publish

### "Check what Amazon actually has right now."

1. Amazon panel → **Live on channel** strip
2. Click **Refresh** on the marketplace row
3. Thumbnails populate from SP-API `GetListingsItem`
4. ⚠ markers on cells where Amazon's image differs from your Nexus state → click for diff modal
5. Either **Adopt into master** (Nexus matches Amazon) or **Republish to fix** (Amazon matches Nexus)

### "Download a ZIP for Seller Central's bulk upload."

1. Amazon panel → publish bar → **Export ZIP ▾**
2. Pick a marketplace OR **All markets (one ZIP)** for per-market folders
3. Browser downloads `amazon-it-GALE-JACKET-2026-05-23.zip`
4. Open Seller Central → Inventory → **Manage Images** → bulk-upload tab
5. Drag the ZIP onto the page
6. Filename convention `{ASIN}.{SLOT}.{ext}` matches Amazon's spec — they resolve automatically

The ZIP runs the same validator as Publish; blocked ASINs are skipped with reasons in the toast.

### "An ASIN got rejected. What now?"

1. Amazon publish bar → **Recent jobs** → click chevron on the rejected row
2. Per-SKU receipt table appears with Amazon's verbatim error code + message
3. Fix the underlying issue (replace too-small image, fix white background, etc.)
4. Click **Retry N rejected** — submits only the rejected ASINs; accepted ones stay untouched

---

## Readiness sidebar

Right rail of the Images tab. Tracks coverage per channel.

```
Master                100%
  Has MAIN              ✓
  3+ images             ✓
  Alt text              ✓
  ≥ 1000 px             ✓

Amazon                 75%
  MAIN slot assigned    ✓
  MAIN has white bg     ⚠
  MAIN ≥ 1000 px        ✓
  MAIN aspect 1:1       ⚠
  SWCH for colors       ⚠
  All ASINs linked      ✓

eBay                   67%
  3+ gallery images     ✓
  Min 500 px            ✓
  Main aspect 1:1       ⚠

Shopify                33%
  Featured image set    ✓
  Variant images        ⚠
  Featured aspect 4:5   ⚠
```

A score < 100 % means there's at least one warning. The sidebar feeds the readiness percentage chip on the channel tab strip.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Cmd+S` | Save pending changes |
| `Cmd+A` | Select all in master gallery |
| `Esc` | Close lightbox / clear selection |
| `←` / `→` | Lightbox navigate |
| Tab / Shift+Tab | Move focus across panel controls |
| Arrow keys in matrix | Move focus between cells (ARIA grid) |
| Enter / Space on cell | Open lightbox (filled) or picker (empty) |

---

## Glossary

- **Master gallery** — Canonical images, scope = product-wide. Each row is a `ProductImage` in the DB.
- **Listing image** — Channel-specific assignment (`ListingImage` row). References a master via `sourceProductImageId` or holds its own URL.
- **Scope** — `GLOBAL` (all channels) / `PLATFORM` (one channel, all marketplaces) / `MARKETPLACE` (one marketplace).
- **Variant group** — `(variantGroupKey, variantGroupValue)` pair on a ListingImage. E.g., `(Color, Giallo)` covers every Giallo variant.
- **Cascade** — The 9-level resolution from variant-specific → group → product-level, each at marketplace → all-channel → global scope.
- **Effective URL** (IE.6) — At publish time, prefer `master.url` over `listingImage.url` when the row links to a master. Lets master re-uploads propagate without per-row backfill.
- **Receipt** (IA.3) — Per-SKU outcome from Amazon's processing report. Surfaced in publish history drill-down.
- **Stale** (IA.5) — `master.updatedAt > listingImage.publishedAt` on a `PUBLISHED` row. Banner offers one-click re-publish.
- **Blocker** (IA.11) — Explicit "empty" override (ListingImage with `url=''`) that suppresses the cascade. Used by drag-move to clear inherited source cells.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Drag doesn't fire from the photo area | (already fixed in IA.15) | If on an older deploy, refresh. |
| Page blinks after every edit | (already fixed in IA.12) | Same. |
| Cell shows old image after drag | (already fixed in IA.10) | Same. |
| Publish refuses with `VALIDATION_FAILED` | Hard fail surfaced in IA.4 — open Preview to see the issue list. | Fix the cause (add MAIN, replace too-small image, fix URL). |
| Some ASINs rejected by Amazon | Verbatim error codes in the receipt drill-down. | Address per code; **Retry N rejected** to re-submit only failures. |
| ZIP smaller than expected | Some ASINs skipped — toast lists reasons. | Fix the blocking issues, re-export. |
| Live strip thumbs empty | Cron hasn't run for this market OR SP-API creds wrong. | Click **Refresh** on the row; check API logs if it still fails. |
| Stale banner doesn't clear | Re-publish hasn't completed yet. | Wait for the publish job's status to flip to DONE. Banner auto-clears on reload. |

---

## Where to dig deeper (developers)

- Publish pipeline + Amazon spec: [`/docs/amazon-image-upload.md`](./amazon-image-upload.md)
- Resolver: `apps/api/src/services/images/amazon-image-feed.service.ts`
- Validator: `apps/api/src/services/images/amazon-publish-validator.service.ts`
- ZIP exporter: `apps/api/src/services/images/amazon-image-zip.service.ts`
- Live snapshot: `apps/api/src/services/images/amazon-live-images.service.ts`
- Stale detection: `apps/api/src/services/images/amazon-stale.service.ts`
- Frontend workspace: `apps/web/src/app/products/[id]/edit/tabs/images/`

---

## Suggested screenshot capture list

For each section above, capture and embed a screenshot directly under the heading:

1. **Layout** — full Images tab with one panel active and the readiness sidebar visible
2. **Master sub-tab header** — Upload / Upload-to-variant / From library / Generate buttons + a few cards
3. **Master card hover** — showing ★, ⋯, ☐, type pill, dimensions
4. **Lightbox** — full-screen view with crop/rotate + AI panel
5. **Amazon panel** — marketplace tabs + live strip + filter bar + matrix + publish bar (one screen)
6. **Live strip expanded** — at least one marketplace row with thumbnails + the Refresh button
7. **Stale banner** — when present
8. **Cell badges** — close-up of one row showing 🔗 inherited, 🎯 override, `+` empty
9. **PublishPreviewModal** — coverage table with one MAIN-missing row highlighted
10. **Validation banner** — preview modal with hard fails listed
11. **Publish receipt drill-down** — expanded row in ImagePublishHistory showing per-SKU outcomes
12. **ScopeUploadModal** — IE.10 modal mid-edit
13. **BulkApplyModal** — IE.12 modal with preview count
14. **DAM picker** — IE.7 with scope chips active
15. **Drag in progress** — IA.16 drop indicator visible on a matrix cell
16. **Undo banner** — IA.19 right after a drag
17. **eBay panel** — gallery + color sets
18. **Shopify panel** — pool + variant assignments
19. **Readiness sidebar** — full sidebar with one warning visible
20. **ZIP download menu** — IA.7 dropdown with marketplace options

Place each screenshot directly beneath its section header. The doc reads top-to-bottom for an operator new to the workspace.
