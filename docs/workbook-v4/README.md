# Editing workbook v4 — audit, design and gate artifact

2026-09-12. Read-only audit of the shipped v3 product-editing export, followed by a complete
layout design and a **generated sample the Owner approves by opening it**.

Nothing in `apps/` changed. This folder holds the measurement, the specification and the
generator that produced the sample. Implementation is gated on approval of section 9.

| File | What it is |
| --- | --- |
| `README.md` | this document |
| `v4-sample-generator.mjs` | reads a real v3 export, re-emits the same values in the v4 layout |
| `~/Downloads/nexus-product-editing-v4-sample.xlsx` | **the gate artifact** — default column tier |
| `~/Downloads/nexus-product-editing-v4-sample-full.xlsx` | same data, every column, for comparison |

Source measured: `nexus-product-editing (3).xlsx`, exported 2026-09-11T21:57Z — 21 SKUs across
nine destinations (Amazon DE/ES/FR/IT, eBay DE/IT, Shopify GLOBAL, shared Products, Italian content).

---

## 1. What the current file actually is

Every number below was measured from that file, not estimated.

| | Measured |
| --- | ---: |
| Worksheets | 14 |
| Value columns across the nine data sheets | **826** |
| Of those, entirely empty for every SKU in the file | **746 (90%)** |
| Uncompressed XML | **4,843,858 bytes** |
| Header comment shapes and their VML | **1,959,998 bytes (40.5% of the file)** |
| Dictionary + Valid values | 1,446,148 bytes (29.9%) |
| Actual data worksheets | 973,632 bytes (20.1%) |
| Valid values geometry | 214 rows × **1,783 columns**, 14,558 option cells |
| Widest single option list | **1,778** (`team_name`, on a motorcycle jacket) |
| Dictionary rows | 826 |

### 1.1 Ten defects, each with its evidence

**D1 — Nine cells in ten are empty.** 746 of 826 value columns hold nothing for any SKU. The
Shopify sheet has 31 value columns and zero values. An operator opening `Amazon · DE` scrolls past
119 empty columns to reach the 4 that matter.

**D2 — Two fifths of the file is tooltips.** Each column header carries an Excel comment; ExcelJS
writes a comment record plus a legacy VML shape for every one. 338 headers on `Products` alone.
This is pure overhead: the same text is already in the Dictionary sheet.

**D3 — The reference sheets cannot grow.** `Valid values` lays each option out in its own *column*.
Excel stops at 16,384 columns, and `catalog-workbook.ts` throws above 16,379 options. `team_name`
already occupies 1,778 of them. An Amazon browse-node or brand list would fail the export outright.

**D4 — Headers are machine keys in three naming conventions at once.** The `Products` sheet mixes
58 camelCase, 91 snake_case and 19 single-word headers. `chestUnit` sits beside
`apparel_size__height_type`. `fc_shelf_lifeUnit` is both in one key.

**D5 — Measures are encoded two different ways in one file.** 39 channel fields are a single JSON
cell (`{"value":1.2,"unit":"kg"}`); 21 master fields are split `…Value` / `…Unit` column pairs.
Same physical quantity, two contracts, one workbook.

**D6 — The requirement vocabulary collides with itself.** Six distinct strings across 826 rows,
including `Optional` (10 rows) and `optional` (578 rows). Filtering the Dictionary on "Optional"
misses 578 of the 588 optional fields.

| Requirement string | Rows |
| --- | ---: |
| `optional` | 578 |
| `Required when relevant` | 195 |
| `Required` | 39 |
| `Optional` | 10 |
| `bestPractice` | 3 |
| `required for new products` | 1 |

**D7 — Sheet names carry a positional counter, not an identity.** `AMAZON DE 3` is
`${channel} ${marketplace} ${scopes.size + 1}`. Two accounts on the same channel and marketplace
produce `AMAZON DE 3` and `AMAZON DE 4` — indistinguishable. Adding a destination renumbers the
others, so the name is not stable between exports.

**D8 — 153 of 358 distinct fields appear on more than one sheet, with nothing saying which wins.**
`brand` is on seven sheets. `item_name`, `manufacturer`, `condition_type` and 20 others are on five.
The precedence (shared → translation → channel override) is real and correct; the file never states it.

**D9 — Column order disagrees with the grid.** `sheet-columns.service.ts` already carries an ordered
group taxonomy (`SHEET_GROUP_ORDER`, `GROUP_WORKFLOW_ORDER`, `FIELD_ORDER_BY_GROUP`) and every field
already carries `group` / `groupOrder`. `WorkbookField` has no `group` property, so the workbook
discards all of it and re-sorts by a hardcoded 13-name list, then requirement rank, then alphabetically.
The same product presents its fields in two different orders in two surfaces.

**D10 — The product editor tops out near 300 SKUs.** A SKU present on all nine destinations carries
**796 attribute rows** — measured: 16,726 values across 21 SKUs. `writeTransferDownload` refuses
above **250,000 attribute outcomes**, so this destination breadth supports about **314 SKUs** per
export, and only by splitting into ZIP parts that each duplicate the full 3.4 MB of reference
material and tooltips.

**D11 — An attribute can be literally named `sku`, and un-escaping it destroys the record.** The
Shopify schema in this very file has an attribute keyed `sku`; v3 exports it as the escaped header
`value:sku` while its Dictionary row stays `sku`. The escape is correct and the v3 reader handles it
by keeping identity columns and field columns in separate namespaces. It is a live trap for anything
that reads the file: the first draft of the v4 generator un-escaped `value:sku` back into the
identity namespace, overwrote the SKU cell with an empty attribute, and **silently dropped the entire
Shopify record**. Caught by a per-sheet record count, not by cell comparison — the lost row simply
stopped existing on both sides of the diff. See Decision 13.

### 1.2 One thing that is not a defect

Data validation *looks* per-cell — ExcelJS reports 19,871 validation entries for 21 rows — but the
written XML coalesces them into 24–78 range elements per sheet. The file is fine. **The cost is
server-side memory**, and it is severe: building the validation model per cell for 10,000 rows ×
120 columns takes **557 MB of heap and 875 ms**, against **0.4 MB and 1 ms** for the identical
result declared at range level.

| Validation model | Entries | Heap | Time |
| --- | ---: | ---: | ---: |
| Per cell (today) | 1,200,000 | 557.3 MB | 875 ms |
| Per range (v4) | 120 | 0.4 MB | 1 ms |

---

## 2. What the v4 workbook is

A workbook is **one task**, not a dump of everything the schema knows. Sheets are destinations,
columns are what this task needs, and the file explains itself without a manual.

### Sheet order

| # | Sheet | Visibility | Contents |
| --- | --- | --- | --- |
| 1 | `Start here` | visible | Dashboard: what is in the file, required-gap counts per sheet with links, how to fill it, colour legend, precedence rule, six protective rules. |
| 2 | `Products` | visible | Shared facts. One row per SKU. |
| 3 | `Content <LANG>` | visible | Translated content, one sheet per language. |
| 4…n | `Amazon · DE · Main` | visible | One sheet per destination — channel, marketplace, account, alias. |
| n+1 | `Dictionary` | visible, protected | One row per emitted column. Normalised vocabulary. |
| n+2 | `Lists` | visible, protected | Valid values, **vertical**, one column per attribute. |
| n+3 | `Nexus workbook` | hidden | Manifest: format, version, export id, header geometry, scope coordinates. |

`Formula examples` is removed. The reader refuses formula cells; a sheet that demonstrates formulas
invites the one mistake the importer rejects.

### Data sheet geometry — three header rows

| Row | Contents |
| --- | --- |
| 1 | **Group band**, merged and coloured: `IDENTITY`, `CONTENT`, `COMPLIANCE AND SAFETY`, `ADVANCED ACTIONS` |
| 2 | **Human label**: `Item name`. Dark red header when the field is required. |
| 3 | **Field key**: `item_name`. Small, grey. This row is the machine contract. |
| 4+ | Data |

Panes freeze at row 3 and after the identity block. Columns carry Excel outline groups, so an
operator collapses `Compliance and safety` and works on content. This is the Amazon flat-file
convention, which every marketplace operator already knows.

Columns are ordered by the platform's own group taxonomy, then requirement, then label — the
same order the grid uses.

---

## 3. The thirteen decisions

**Decision 1 — A workbook is a scope pack.** Three column tiers in the export drawer:

| Tier | Columns | Measured on this file |
| --- | --- | ---: |
| Edit what exists | columns holding a value | 80 |
| **Fix and fill (default)** | the above, plus Required, plus Recommended, plus the content spine | **158** |
| Everything | every field the schema defines | 826 |

The middle tier is the default. A destination with nothing stored yet still arrives fillable,
because Required, Recommended and the content spine are always present.

`Required when relevant` is deliberately **not** in the default: 195 such columns exist, only one
holds a value, and they carry 10,310 of the 14,558 option cells — 71% of the reference sheet for
1 useful value. They belong to the Everything tier.

**Decision 2 — Label row and key row are separate.** The operator reads `Item name`; the importer
reads `item_name`. The naming inconsistency of D4 stays where it belongs — in the machine row —
and disappears from the working surface. No wire key changes, so nothing downstream moves.

**Decision 3 — No header comments.** Short guidance becomes the data validation input message,
which is one record per column. Full guidance lives in the Dictionary. This removes 1,959,998 bytes.

**Decision 4 — One data validation per column range, never per cell.** `dataValidations.add('K4:K10003', …)`.
557 MB → 0.4 MB, measured above.

**Decision 5 — `Lists` is vertical.** One column per attribute, options running down. Excel allows
1,048,576 rows, so the 16,379-option ceiling of D3 disappears. Combined with Decision 1 the sheet
drops from 214 lists across 1,783 columns to **29 lists across 29 columns**, widest 394 options.

**Decision 6 — One requirement vocabulary, four values.** `Required`, `Required when relevant`,
`Recommended`, `Optional`. The original string is preserved in the Dictionary's Guidance column, so
nothing is lost.

**Decision 7 — A measure is a number column and a unit column. Always.** `Item weight` accepts
`1.4`; `Item weight unit` is a dropdown of that field's allowed units. Nobody hand-writes
`{"value":1.4,"unit":"kg"}` correctly ten thousand times. D5's split disappears.

**Decision 8 — A list is numbered slot columns.** `Bullet point 1…5`, one entry per column. Slot
count comes from the longest stored list in scope, never a fixed cap.

The recomposition rule is exact and it matters: **trailing blank slots end the list; a blank slot
between two filled ones is a real empty entry.** The live data contains
`["PROTEZIONE…","VENTILAZIONE…","IMPERMEABILE…","","VESTIBILITÀ…"]` — an empty string at position 4.
A naive "drop the blanks" rule silently deletes it.

**Decision 9 — A field that cannot be split keeps one JSON cell, and says so.** Three cases fall
back, each detected per field at export time and named in the Dictionary:

- a stored value does not match its declared type (a legacy scalar under a list field — present in this data);
- the list is longer than 20 entries, beyond a readable number of columns;
- the list ends with an empty string, which blank slots cannot express.

**Decision 10 — One action column per stored field, not per spreadsheet column.** A measure occupies
two columns and a list occupies five, but each is one stored value with one `SET` / `CLEAR` / `INHERIT`.
Blanking every slot and setting `CLEAR` is how an operator stores an empty list.

**Decision 11 — A required cell left empty is visible.** Range-level conditional formatting fills it
pale red. `Start here` counts the gaps per sheet and links straight to them.

**Decision 12 — Identity columns and attribute columns never share a namespace.** The key row on
row 3 keeps the escape: identity reads `sku`, the Shopify attribute reads `value:sku`. The reader
strips `value:` only when resolving a *field*, never when reading an identity. The escape is extended
to cover the new v4 separator, so an attribute whose key contains `#` cannot be mistaken for a
measure or list part. Regression fixture: the Shopify destination in this file.

**Decision 13 — Sheet names are stable identities.** `Amazon · DE · Main`, from channel title,
marketplace and account label, plus the alias when a destination has one. Never a positional index.
Excel's 31-character cap is enforced with a deterministic 4-character suffix on collision. The
manifest remains the matching authority; the name is for people.

---

## 4. What the sample proves

Generated from the real export, then checked cell by cell against it.

| Check | Default tier | Everything tier |
| --- | ---: | ---: |
| Values compared | 2,398 | 16,726 |
| Non-empty values recovered exactly | **1,094** | **1,094** |
| Mismatches | **0** | **0** |
| Dropped columns that held data | **0** | **0** |
| Records lost | **0** on all 9 sheets | **0** |
| Stored `[]` shown as blank slots | 82 — preserved by the baseline; `CLEAR` empties a list | |

Record counts are compared per sheet, not only cell by cell. That check is what caught D11: a lost
row disappears from both sides of a value diff and looks like agreement.

The checker was proved capable of failing, and re-armed after every change to it. Mutations injected
into the finished sample were all caught: an altered title (`Products/name`), a cleared interior list
slot (`bullet_point#list.2`), and a changed measure unit (`packageWeight` `KILOGRAM` → `XX`). The
same run against the unmutated file reports zero.

### Size, same data, same 21 SKUs

| | v3 today | v4 sample | |
| --- | ---: | ---: | ---: |
| File on disk | 463,424 B | **91,641 B** | −80% |
| Uncompressed XML | 4,843,858 B | **612,157 B** | −87% |
| Header comments + VML | 1,959,998 B | **0** | −100% |
| Relationship files | 184,526 B | 4,759 B | −97% |
| Value columns | 826 | 158 | −81% |
| Empty columns | 746 | 0 | |

The Everything tier of the same data is 395,133 B — still smaller than today's file, while carrying
*more* columns, because measures and lists are split.

### Scale

The v4 layout replicated to real catalogue sizes across all nine destinations, with distinct text on
every row so shared-string deduplication does not flatter the result:

| SKUs | File | Write time | Peak heap |
| ---: | ---: | ---: | ---: |
| 2,000 | 1.19 MB | 0.8 s | 240 MB |
| **10,000** | **5.65 MB** | **4.1 s** | 739 MB |
| 25,000 | 14.07 MB | 10.8 s | 1,849 MB |

**Ten thousand SKUs across nine destinations fit in one 5.65 MB workbook**, inside the existing
10 MB per-file limit, with no ZIP splitting. Against roughly 310 SKUs today.

At 25,000 the file exceeds 10 MB and splits into two parts, and heap reaches 1.85 GB — that is
ExcelJS holding the whole document in memory, and it is the next thing to fix
(`ExcelJS.stream.xlsx.WorkbookWriter`), not a property of the layout.

### What the sample does **not** prove

- It was generated from an exported file, not from the live contracts. Groups are derived by pattern
  matching; production reads the real `col.group` / `field.group`, which already exist.
- Account labels read `Acct wx8j` because the v3 file carries only opaque IDs. Production reads
  `ChannelConnection.accountLabel`.
- No v4 reader exists yet. Round-tripping v4 through preview and apply is section 9, step 3.
- Inherited values are not shown on channel sheets. That needs `catalog-transfer-effects.ts`; see
  question Q6.

---

## 5. Adding channels and marketplaces

The current design gets harder with each destination: another sheet of ~120 mostly-empty columns,
another ~2,300 option cells, another 250 KB of tooltips, and one more positional index shuffling the
sheet names. Four more marketplaces roughly doubles the file and moves nothing useful into it.

Under v4 a new destination costs only what it actually uses:

- its sheet carries the tier's columns, not the schema's;
- its option lists join `Lists` as columns, with no width ceiling;
- its name is derived from its own coordinates, so existing sheets keep their names;
- its group bands come from the channel's own group taxonomy, already returned by
  `field-catalogue.service.ts` with the channel's localised titles.

Nothing about the layout is Amazon-shaped or eBay-shaped. `TRANSFER_CHANNELS` stays the only list
that has to know the channel set.

---

## 6. What the import engine gains, and what it must not lose

**The row contract does not change.** `TransferRow`, `TRANSFER_COLUMNS`, `SET`/`CLEAR`/`INHERIT`,
the planner, the validators, the transactional writer and the audit trail are all untouched. v4 is a
presentation format that decomposes into exactly the same rows v3 produces.

Reader changes, all inside `readCatalogWorkbook`:

| Change | Detail |
| --- | --- |
| Version `4` | Manifest gains `headerRows`, `labelRow`, `keyRow`, `firstDataRow`. `2` and `3` keep working unchanged, so baselines in flight are safe. |
| Header row is row 3 | Read keys from `keyRow`, data from `firstDataRow`. Rows 1–2 are presentation and are never parsed. |
| `#part` suffixes | `weight#measure.value` + `weight#measure.unit` recompose to one `{value, unit}`. `bullet#list.1…n` recompose with the trailing-blank rule of Decision 8. |
| Actions are per field | One `action:<field>` column governs every column of that field. |
| Escapes survive | `value:` on the key row is stripped only to resolve a field, never to read an identity. Extended to keys containing `#`. |
| Tier is recorded on the baseline | An omitted column must never read as a deletion. |

That last row is the one correctness risk, and the mechanism already exists and is already exercised:
the `input.fields` path in `exportCatalogTransfer` omits columns today, and `readCatalogWorkbook`
emits rows only for headers present in the sheet. v4 records *which* tier produced the file so the
review can say "these 668 columns were not in this export" rather than leaving it implicit.

Untouched by this work: the legacy import wizard, both flat-file editors and their routes, price,
stock and publication.

---

## 7. Files this would change

| File | Change |
| --- | --- |
| `catalog-workbook.ts` | v4 writer; v4 branch in the reader |
| `catalog-workbook-format.ts` | palette, three-row header helper, group bands |
| `catalog-workbook-scopes.ts` | sheet naming, tier selection, group carry-through |
| `catalog-transfer-export.ts` | pass `col.group` / `field.group` and the tier into `WorkbookField` |
| `catalog-editor-workbook.ts` | record the tier on the baseline |
| `catalog-transfer.routes.ts` | accept the tier on the export request |
| `ProductTransferDrawer.tsx` | the three-tier selector replaces "All / visible attributes" |
| `packages/shared/catalog-transfer.ts` | **no change** |

---

## 8. Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Default column tier | **Fix and fill** (158 columns here). Everything stays available and labelled as large. |
| Q2 | Account label in sheet names | `ChannelConnection.accountLabel`, falling back to the last four characters of the id. Confirm the label is stable. |
| Q3 | Slot cap for lists | 20 columns, then fall back to a JSON cell. |
| Q4 | Remove `Formula examples` | Yes — the reader refuses formulas. |
| Q5 | `Lists` visible or hidden | Visible and protected. Operators copy from it. |
| Q6 | Show inherited values greyed on channel sheets | Recommended, but only where `catalog-transfer-effects.ts` actually resolves the value for **that** coordinate. Where it cannot resolve, leave the cell blank — never display a parent value as if it were the resolved one. |
| Q7 | 25,000-SKU heap | Move the writer to `ExcelJS.stream.xlsx.WorkbookWriter` as a follow-up, measured separately. |

## 9. Build sequence, once approved

1. **Format and layout.** Three-row header, group bands, range validation, vertical `Lists`, compact
   Dictionary, `Start here`, sheet naming. Golden-file tests against the sample in this folder.
2. **Encoding.** Measure and list splitting, the fallback rules of Decision 9, per-field actions.
   Round-trip tests over the real legacy shapes found here: `[]`, an interior empty string, a scalar
   stored under a list type, and the Shopify attribute named `sku`.
3. **Reader.** Version `4`, `#part` recomposition, tier on the baseline. v2 and v3 regression tests
   stay green. Producer and consumer land in one change.
4. **Tiers and drawer.** Column tiers end to end, with the column count shown before download.
5. **Scale.** Streaming writer, then re-measure 2,000 / 10,000 / 25,000 against a real database.

Acceptance is the existing gate, unchanged: an untouched v4 export must propose **zero** mutations —
including inherited fields, named aliases, translations, legacy typed values and parent references.
Add one gate this audit earned: **compare record counts per sheet, not only values.** A dropped row
is invisible to a value diff.
