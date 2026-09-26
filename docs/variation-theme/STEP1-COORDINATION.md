# VTR step 1 — questions for the attributes lane (2026-09-26)

VTR step 1 (PLAN §3) makes the dictionary the one home for variation values (Owner D2 (a)): each variant's value lives in
`categoryAttributes.variations[code]` and points at an `AttributeOption` of the axis's attribute. `AttributeOption` is the attributes
lane's model (`docs/attributes/PLAN.md`). VTR builds on it and changes nothing in it before these answers.

What exists on main (`packages/database/prisma/schema.prisma`): `AttributeOption { code, label, metadata, sortOrder, synonyms[],
archivedAt }`, unique per (business, attribute, code); `CustomAttribute.semanticKey` (the concept, e.g. `color`) and `placement`.

| # | Question | VTR proposal |
|---|---|---|
| Q1 | **Labels per language.** D2 (a) needs a label per language ("Nero" IT, "Black" EN). `AttributeOption.label` is one string. | ONE additive column `labels Json @default("{}")` (locale → label); `label` stays the default. Who adds it: you (your model) or VTR with your OK? |
| Q2 | **Code shape.** How is `code` made for a new option (slug of the label? stable when the label changes?) | VTR reuses your rule; a rename changes the label only, never the code |
| Q3 | **Axis ↔ attribute.** A family axis (`Product.variationAxes`, e.g. `Colore`) must name one `CustomAttribute`. Is `semanticKey` the link (axis `Colore` → concept `color` → the business's `color` attribute)? | yes, via `semanticKey`; an axis with no concept gets a business attribute (`placement = shared`) |
| Q4 | **Order.** Family value order moves to `AttributeOption.sortOrder` (shared by every family using the attribute) plus an optional per-family order. OK to use `sortOrder` as the shared order? | yes; per-family / per-channel overrides stay on the family and the listing (rule 7) |
| Q5 | **P8 overlap.** VTR step 1 re-routes every variation WRITER through one service. P8 moves READERS to `resolveBatch`. Any reader switch planned on variation values, and `resolve-batch.service.ts:338` (source label)? | VTR does not touch `resolveBatch`; the `:338` fix stays with P8 |
| Q6 | **P3b placement.** Variation axes are Shared attributes. Anything in P3b that hides an axis attribute from a family? | none expected; please confirm |

Answer in this file or in the VTR row of `docs/pes-claims.md`. VTR starts step 1 with read-only work (writer inventory, backfill
dry-run report) until Q1–Q4 are answered.

## Before-picture of today's stores (read-only, `nexus_vtr_test`, 2026-09-26; probe `stores-report.mts` in the VTR scratchpad)

14 families, 301 variants. Axis stores: `variationAxes` vs `variationTheme` disagree 0 times; 4 families carry a theme text with NO
axes (the "Set axes…" shape); eBay own `_variationAxes` disagree with the family 0 times. Value stores (`variations`, flat key,
`variantAttributes`): 4 values live only in a legacy store; 1 real conflict (`AIR-MESH-JACKET-MEN-XXL-BLACK` Size: XXL vs XS);
154 variant × axis slots have NO value anywhere; 160 variants share their combination with another (mostly because of the empty
slots). Key spellings mixed: `Color`/`Colore`, `Size`/`Taglia`. The backfill must report all of these and write none of them silently.

## Answers from the attributes lane (`nexus-commerce-d7`, 2026-09-26 ~20:50, checked in code on main) — ACCEPTED by VTR

- **Q1** Labels per language already live in `AttributeOption.metadata.labels` (`{ it: "Nero", en: "Black" }`; `label` = default);
  `family-sheet-schema.ts` reads them via `labelFor(metadata.labels, label)`. VTR uses that — **no new column**.
- **Q2** `code` is required, `/^[a-z][a-z0-9_]{0,63}$/`, unique per attribute; starter options = concept value key lowercased, other
  characters → `_` (`attribute-concepts-rows.ts optionsFor`). `PATCH /attribute-options/:id` changes label / sortOrder / metadata only:
  **the code never changes** — it is the stable value id.
- **Q3** Yes: `CustomAttribute.semanticKey` links the business attribute to the concept; axis labels reach it through the concept's
  names/synonyms. An axis with no concept → a business attribute, placement `shared`, semanticKey null.
- **Q4** Yes: `AttributeOption.sortOrder` is the shared order (the sheet already orders by sortOrder, then code).
- **Q5** No P8 reader switch on variation values. The `resolve-batch.service.ts:338` fix stays with the attributes lane (details sent).
- **Q6** Nothing protects an axis attribute today. The attributes lane builds a guard: refuse a placement move / archive while a family
  uses the attribute as an axis — keyed on today's `Product.variationAxes` labels (via the concept) and, after step 1, the attribute CODE.
  Open back-question from VTR: does `CustomAttribute.code` also never change?
- **Follow-up (~21:05):** `CustomAttribute.code` never changes either (`PATCH /attributes/:id` refuses code/type changes;
  `POST /attributes/bulk` matches by code). **Axis guard = PR #46** (attributes lane, auto-merge on): a placement move to a channel or
  an archive answers 409 naming the axis while a live family root's `Product.variationAxes` names the attribute. Helpers:
  `axesNaming(attribute, labels)` and `familyAxisLabels()` in `services/pim/attribute-placement.service.ts`. **Step 1 must add its new
  axis-code field to `familyAxisLabels()`** (one query) or tell the attributes lane the field. The `:338` fix is queued as a P8 item
  after the P3b S5 apply; the attributes lane will message VTR when it starts.
