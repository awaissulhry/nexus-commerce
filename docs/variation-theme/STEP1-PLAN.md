# VTR step 1 — one data model for variations (APPROVED by the Owner 2026-09-26 ~23:40: D3 (a))

Built on: approved PLAN §3 step 1, D2 (a), the attributes lane's answers (`STEP1-COORDINATION.md`), the writer inventory
(`STEP1-WRITERS.md`, 50+ writers) and the before-picture (14 families, 301 variants on the private copy).

## 1. The model

| Fact | One home | Today |
|---|---|---|
| A family's axes, in order | NEW `Product.variationAxisCodes String[]` on the family root = `CustomAttribute.code`s (stable) | labels in `variationAxes` ("Colore") + a theme text `variationTheme` + eBay `_variationAxes` |
| A variant's value | `categoryAttributes.variations[<attribute code>]` = the option's default label ("Nero") | 3–4 stores, mixed keys (`Color`/`Colore`, `Size`/`Taglia`) |
| The value list, labels per language, synonyms | `AttributeOption` (code, `label`, `metadata.labels`, `synonyms`, `archivedAt`) | nowhere (free text) |
| Shared value order | `AttributeOption.sortOrder` | borrowed from the eBay IT listing (`_axisValueOrder`) |
| Per-family / per-channel order and names | family: NEW `Product.variationValueOrder Json` (attribute code → option codes); channel: the listing, as today (rule 7) | eBay only |

`variationAxes` stays as a mirror (labels, written only by the one writer) so the ~50 readers keep working; readers move to the codes
over steps 2–4. `variationTheme` stops being an axis store: eBay follows the axes (PLAN rule 1).

## 2. One writer — `pim/family-variations.service.ts` (NEW)

`setAxes(familyId, codes, expectedVersion)` and `setValues(familyId, changes[], expectedVersion)`, both in one transaction:
1. normalise: trim; match the text to an option by code, label, `metadata.labels`, synonyms (case- and space-insensitive);
   an unknown value → a new option only when the caller says "add" (the sheet asks: "Save 'X' as a new option");
2. refuse a duplicate combination among INCLUDED variants (today only Generate refuses it);
3. compare-and-set on `Product.version`; bump it;
4. write `variations[code]` + the `variationAxes` mirror; drop legacy/flat copies of the same axis;
5. event + readiness + read cache (today only bulk edit does all three).
Every writer in `STEP1-WRITERS.md` is re-routed to it, one group per pull request, each with its old test passing through the new writer.

## 3. Backfill — report first, then write (ADDITIVE migration)

- Migration: the two new columns only (`variationAxisCodes`, `variationValueOrder`), + `baseline.sql` regenerated.
- Dry run on a private copy, then on production READ-ONLY: per family → axis label → attribute (via the concept; none → a new
  business attribute, placement `shared`); per variant × axis → option (existing, or "to create"); every conflict listed:
  the 1 real value conflict (XXL vs XS), 154 empty slots, 160 variants sharing a combination, 4 families with a theme and no axes.
- Write only after you read the report; conflicts are never resolved silently — they stay as they are and show on the sheet.
- The attributes lane's axis guard (`familyAxisLabels()`) learns the new `variationAxisCodes` field in the same pull request.

## 4. Pull requests (each tested; merge = deploy, needs your word)

| PR | What |
|---|---|
| 1a | migration + the one writer + backfill dry-run tool (no writes) |
| 1b | backfill write (after your OK on the report) |
| 1c–1g | re-route writers: studio + generate + attach · bulk edit + bulk actions · flat files (Amazon, eBay) + import · Amazon/Etsy sync + catalog refresh + auto-detect · organize, duplicate, bulk-variants, create wizard, web server action |
| 1h | eBay follows the axes; `variationTheme` retired as an axis store |

## 5. Decision for the Owner

**D3 — how a variant's value is stored.**
- **(a) Recommended:** keep the default label text ("Nero") under the attribute code; the dictionary option is the source of truth for
  code, labels per language, synonyms and order, and the one writer keeps them in step (a rename updates the option AND every variant
  in one transaction). About 45 readers keep working; nothing a channel receives changes in step 1.
- **(b)** store the option CODE ("black") and translate on read. Cleaner, but every reader and every channel payload changes at once.

**Owner, 2026-09-26 ~23:40: "Okay, I'll do what you want" → D3 (a) approved (label text under the attribute code; the dictionary
option is the source of truth). Added requirement: "I also want the ability to read whatever is currently live on the channel"** →
see `LIVE-READ.md`.

## Production report (read only, 2026-09-26 ~20:00 UTC; `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, pure planner; output kept outside the repo)

- 33 family roots, 321 variants (32 in the legacy business, 1 in a second business).
- Axes resolve: `Colore`→color (26), `Taglia`→size (17), `Color`→color (1), `Size`→size (1). No axis without an attribute.
- **0 store conflicts, 0 empty slots, 0 duplicates, 0 values only in a legacy store** (the local copy is older and dirtier).
- The dictionary has **0 colour and 0 size options** in both businesses → the backfill would create **31 options**:
  colour 21 (Arancia, Bianco, Blu, Giallo, Grigio, Nero, Rosa, Rosso, Verde, and 12 mixed values — see below), size 10
  (XXS, XS, S, M, L, XL, XXL, 3XL, 4XL, 5XL). 388 variant slots would link to them.
- **5 families have a theme text but NO axes:** 1J-EYE5-Y0TW, 3K-HP05-BH9I, **GALE-JACKET**, UD-LVLM-1H8T, xracing.
  GALE-JACKET (legacy business, version 52, last updated 2026-09-22) has the theme text `Colore,Taglia` and `variationAxes = []`
  in production, while the older local copy has both axes. **No ProductEvent in production records an axis change**, so whether
  production ever had them is unknown (the local axes may come from a local fixture). Not a proven loss. Step 1b does not invent
  axes: the Owner sets them (or approves "use the theme text") per family. A second GALE-JACKET (another business, an
  assortment copy, version 3) has neither.
- **Mixed colour values** (colour + gender or garment in one value): `Nero | Donna`, `Nero | Uomo`, `Grigio | Donna`,
  `Grigio | Uomo`, `Grigio Scuro-Giallo-Nero | Donna/Uomo`, `Grigio-Rosso-Nero | Donna/Uomo`, `Crema e Vino | Giacca/Pantaloni`,
  `Nero Neo | Giacca/Pantaloni`. The backfill will not split them; the Owner decides (keep as colour values, or a second axis).

