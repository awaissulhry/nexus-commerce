# FNSKU Labels — Operator Manual

**Page:** `/fulfillment/fnsku-labels`
**Entry points:**
- `/fulfillment/inbound` → "Get FNSKU Labels" button (top-level)
- `/fulfillment/inbound/[shipmentId]` drawer → "FNSKU labels" link (pre-fills queue from shipment items)

This guide covers how to use the FNSKU label designer in production, the
output formats available, and the rules Amazon FBA enforces on labels.

---

## 1. Quick start

1. Open `/fulfillment/fnsku-labels`. The page loads with the default template (4×3in, 3 rows).
2. Add SKUs via one of three tabs in the left panel:
   - **Search** — type SKU or product name; click a result to add.
   - **Paste** — paste a list of SKUs separated by newlines or commas.
   - **Scan** — USB barcode scanner emits keystrokes; or click the camera icon for live scan.
3. The center pane shows a live preview of the selected SKU's label. Use **J/K** (or ↓/↑) to step through.
4. Adjust the template in the right panel — label size, row content, badge text, fonts, sizes.
5. Click one of the export buttons:
   - **Print** — opens a print dialog with one label per page (browser HTML).
   - **PDF (label)** — one label per page at exact label dimensions; ideal for thermal printers.
   - **PDF (A4)** — labels tiled on A4 sheets; print on a regular printer and cut.
   - **SVG** — vector export for designers / outsourced print.
   - **ZPL** — Zebra Programming Language for direct thermal printer drop.

---

## 2. Amazon FBA label requirements

Every unit shipped to FBA must carry a label that includes:

| Field | Required? | Notes |
|---|---|---|
| FNSKU barcode (Code128) | **Yes** | Exactly 10 alphanumeric chars, starts with `X`. Format checked at input + pre-flight. |
| Human-readable FNSKU | **Yes** | Printed under the bars. We auto-shrink so it never ellipsis-truncates. |
| Listing title | **Yes** | Pulled from the destination marketplace's `ChannelListing.title`. |
| Condition | **Yes** | Exact string match required. We expose Amazon's 10 accepted values: New / Used - {Like New, Very Good, Good, Acceptable} / Collectible - {…} / Refurbished. |
| Logo / brand | Optional | Placeholder "LOGO" badge if no URL set. ZPL export uses the text placeholder; PDF/SVG/Print HTML support image URLs. |

**Per-marketplace titles.** The topbar dropdown sets the destination marketplace (IT/DE/FR/ES/NL/BE/PL/SE/IE/UK). Listing titles reload to match the destination's `ChannelListing` row. This matters: shipping a `Galileo Tour Giacca` label to a Spain warehouse when the ES listing reads `Galileo Tour Chaqueta` is technically a label mismatch.

---

## 3. Output formats

### PDF (label mode)
- One label per page, page size = label dimensions exactly.
- Best for thermal label printers (Zebra, Brother, Dymo, Munbyn) with continuous-feed.
- Code128 barcode is vector — no rasterization artifacts.
- Filename: `fnsku-{shipment-X-}{YYYY-MM-DD}-label.pdf`.

### PDF (A4 mode)
- Labels tiled on A4 with configurable margin, gap, and column count.
- Toggle **Crop marks** in the right panel for guillotine alignment ticks.
- Auto-col falls back to the safest number when module width drops below 250µm.
- Max labels per PDF: **5,000**.

### SVG
- Single SVG file with all labels stacked vertically (5mm gap between).
- Uses `<foreignObject>` to embed the label HTML — exact visual parity with the preview.
- Modern browsers, Inkscape, and Affinity Designer handle this cleanly.
- Adobe Illustrator's `foreignObject` support is limited; for that workflow, use the PDF and convert in Acrobat.

### ZPL II (thermal printer direct)
- Zebra Programming Language II text output. Drop onto a printer queue (USB, LPR, network share) — no rasterization, the printer's firmware draws the bars and glyphs.
- Default 203 dpi (covers most installed Zebras like ZD220/ZD420). 300 dpi available via API.
- **Logo URL not supported in v1** — falls back to "LOGO" text placeholder. Image-to-`^GF` conversion is on the FN.9 roadmap.
- One `^XA` / `^XZ` pair per label; printer feeds continuously between.
- Filename: `fnsku-{shipment-X-}{YYYY-MM-DD}-203dpi.zpl`.

---

## 4. Keyboard shortcuts

Press **`?`** to open the in-app overlay. Skipped while typing in an input.

| Key | Action |
|---|---|
| **j** / **↓** | Move to next SKU |
| **k** / **↑** | Move to previous SKU |
| **Del** / **Backspace** | Remove selected SKU |
| **/** | Focus search input |
| **⌘P** / **Ctrl+P** | Print (HTML preview) |
| **⌘D** / **Ctrl+D** | Download PDF (label) |
| **⌘⇧D** / **Ctrl+Shift+D** | Download PDF (A4) |
| **?** | Toggle shortcuts overlay |
| **Esc** | Close overlay |

---

## 5. Templates

Templates persist label configurations (size, layout, rows, scales, font, condition, sheet layout). Stored in `FnskuLabelTemplate` table.

- **Save** — saves the current template config under a name.
- **Save (overwrite)** — updates the active template's config.
- **Duplicate** (copy icon) — forks the active template as `"{name} (copy)"`.
- **Set default** (star icon) — marks the active template as the auto-load on page open. Backend clears other defaults in a transaction.
- **Delete** (trash icon) — removes the active template.

The dropdown shows `★ Name (WxHmm)` for visual scan — default star prefix plus label dimensions in mm.

---

## 6. Multi-select + drag-to-reorder

- Per-row checkboxes select individual items.
- "Select all" button selects every queued SKU.
- "Delete" bulk action removes selected items (with confirm).
- Drag the grip handle (left of each row) to reorder. **Queue order = PDF page order**, so reorder to group labels logically (by color, size, family) before printing.

---

## 7. Pre-flight checks

Before generating a PDF, the page enforces:

1. **Label count cap** — max 5,000 labels per generation. Above that → blocked with explicit message.
2. **Missing listing title** — confirm dialog listing the SKUs without titles. Amazon FBA requires the title on every label.
3. **Malformed FNSKU** — confirm dialog listing FNSKUs that don't match `^X[A-Z0-9]{9}$`. Detects ASIN paste mistakes (`B0…`) with a tailored hint.

---

## 8. Barcode scannability

We render Code128 with a **10-module quiet zone** on both sides (spec compliance). The topbar surfaces an amber warning chip when the current settings would produce a module width below **250µm** (the GS1 recommended minimum) or barcode width below **20mm**.

Common causes:
- Label size too small (under 50mm wide).
- Right-column split percent too narrow (under 25%).
- A4 column count too high (the sidebar caps this automatically).

**Quick test:** print one label, scan with your handheld scanner AND with the iPhone camera app (Code128 support is built-in). If either fails, increase barcode width % or label width.

---

## 9. Thermal printer recommendations

| Printer | DPI | Notes |
|---|---|---|
| **Zebra ZD220** | 203 | Entry-level, fits 4×3in labels at 102mm width. Direct ZPL drop via USB. |
| **Zebra ZD420** | 203 or 300 | Better autocalibration; 300 dpi version produces sharper FNSKU text. |
| **Brother QL-820NWB** | 300 (effective ~203 for label width) | Network/Bluetooth. Excellent for warehouse stations. Use PDF (label) — Brother doesn't speak ZPL natively. |
| **Munbyn ITPP941** | 203 | Cheap, plug-and-play USB. Use PDF (label). |
| **Generic laser printer** | 600+ | Use PDF (A4) with crop marks; cut with a guillotine. Slow per-label but no thermal printer needed. |

For ZPL: connect via USB or `lpr -P <printer>`. Most Zebras default to USB raw mode.

---

## 10. Inbound → labels handoff

When you click **"FNSKU labels"** from an inbound shipment drawer, the URL gets `?shipmentId=` appended. The labels page:

1. Fetches the shipment via `GET /fulfillment/inbound/:id`.
2. Seeds the queue with each item's SKU + `quantityExpected` (duplicates coalesced).
3. Enriches via the FNSKU lookup pipe (SP-API → DB cache).
4. Shows a green "Shipment X" chip in the topbar.

Click the × on the chip to detach (clears the query param so refresh doesn't re-import). The shipment context drives the export filename: `fnsku-shipment-INB123-2026-05-23-label.pdf`.

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Scanner rejects the printed barcode | Module width < 250µm | Increase barcode width % or label size. Check topbar chip. |
| Listing title doesn't match Amazon's | Wrong destination marketplace | Change the topbar dropdown to the destination market. |
| FNSKU field shows amber "Looks like an ASIN" | Pasted an ASIN (`B0…`) instead of FNSKU | Re-paste the actual FNSKU (starts with `X`). |
| Re-fetch overwrites a manually-typed FNSKU | This is fixed — manually-edited FNSKUs are locked | If you see this, clear the field then re-fetch. |
| PDF download takes ages | Large job (>500 labels) | Check the topbar "X.X MB" indicator — bytes are streaming. Wait. |
| Italian attributes show `—` | DB stores them under `Color/Size/Gender` not `Colore/Taglia/Genere` (or vice versa) | We handle both. If you still see dashes, the `variantAttributes` JSON on the Product row is empty — fix in `/products/[id]/edit`. |
| Crop marks don't show | A4 mode only | Switch to A4 and tick the "Crop marks" checkbox. |
| Logo missing in ZPL output | Not yet supported in ZPL | Use PDF/SVG for now; ZPL image support is on the roadmap. |

---

## 12. Audit history

| Phase | Commit | Date | What |
|---|---|---|---|
| FN.1 | `5c5a60c9` | 2026-05-23 | Code128 quiet zones, manual-edit lock, row + size-box overflow shrink, badge cap, title auto-shrink, logo placeholder unified, Italian attr aliases |
| FN.2 | `f74960e7` | 2026-05-23 | FNSKU format validation + pre-flight, per-marketplace listing titles, typed Condition dropdown, module-width warning chip |
| FN.3 | `1c73e4ae` | 2026-05-23 | Inbound → labels pre-fill via `?shipmentId=`; "FNSKU labels" link in InboundDrawer |
| FN.4 | `6d90193b` | 2026-05-23 | 5000-label cap, Clear-all confirm, timestamped filenames, versioned localStorage, streaming PDF via PassThrough, live MB indicator |
| FN.5 | `f60f4f3c` | 2026-05-23 | Item thumbnails, auto-select on add, Scan tab (USB + camera), keyboard shortcuts, multi-select bulk delete, drag-to-reorder |
| FN.6 | `09571722` | 2026-05-23 | Set-as-default star, Duplicate template button, dropdown info density |
| FN.7 | `ac83dc0c` | 2026-05-23 | SVG export, ZPL II encoder (203 dpi), crop-marks toggle for A4 |
| FN.8 | (this commit) | 2026-05-23 | Visual parity audit across all presets + edge cases; caught + fixed pdfkit `lineBreak:false`-with-width wrap bug; operator manual |

---

## 13. What's not yet supported (FN.9 + future)

- Logo image embedding in ZPL (would need `^GF` graphic field encoding from PNG/JPG).
- Preview-PDF-in-tab before downloading (currently goes straight to download).
- Lot/serial line for GPSR compliance on motorcycle helmet recalls (tie to the `Lot` model).
- Auto-fit-N-sheets — distribute item quantities to exactly fill N A4 sheets.
- Dropping the dead `ProductVariation.fnsku` column from the schema (FNSKU lives on `Product`).

Ask in `#fulfillment-eng` if you need any of these prioritized.
