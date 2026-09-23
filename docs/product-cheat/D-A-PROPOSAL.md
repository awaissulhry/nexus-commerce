# D-A — which attributes are required. DERIVED, NOT APPLIED.

**Generated 2026-09-22 by `apps/api/src/scripts/derive-required-attributes.ts` against `nexus_development`. Nothing was written.**

Derived exactly as [D-A](PLAN.md#part-9--the-decisions-i-need) recommends — *"what a channel
refuses a publish for"* — by asking `getSheetColumns` per coordinate, which is the same
derivation the sheet, readiness and the studio read. No schema JSON was parsed here.

Read **49** cached coordinates of **58**. 9 could not be read.

## 🔴 The denominator, before the proposal

Across those coordinates the channels require **19** distinct fields.

| | |
|---|---|
| have a dictionary attribute → a `FamilyAttribute` row can be written | **5** |
| have **no** dictionary twin → D-A cannot mark them at all | **14** |

🔴 **"5 attributes" is not "channels only require 5 things".** The
14 without a twin are required by a channel and invisible to the family
model. They are a different decision — whether the dictionary should carry them — and they are
listed at the bottom so the gap is a number rather than a surprise.

🔴 **A "0" in the last column means no family declares this attribute today**, so there is no
`FamilyAttribute` row to mark. Those need a family decision first, not a requirement decision.

## Required on more than one channel — candidates for `channels: []` (required everywhere) — 0

| code | label | channels | markets | product types | families |
|---|---|---|---|---|---|

## Required on exactly one channel — candidates for `channels: ['<that one>']` — 5

| code | label | channel | markets | product types | families |
|---|---|---|---|---|---|
| `supplier_declared_dg_hz_regulation` | Supplier declared dg hz regulation | AMAZON | 4 | 16 | 5 |
| `fabric_type` | Fabric composition | AMAZON | 4 | 7 | 2 |
| `color` | Color | AMAZON | 3 | 3 | 2 |
| `material` | Material | AMAZON | 2 | 1 | 1 |
| `size` | Size | AMAZON | 2 | 1 | 2 |

## 🔴 Channel-required fields with NO dictionary attribute — 14

D-A cannot mark these: there is no `CustomAttribute`, so no `FamilyAttribute` row exists to
carry a requirement. Listed because leaving them out would make the proposal above look
complete when it is a fraction.

| key | required by |
|---|---|
| `brand` | AMAZON |
| `bulletPoints_1` | AMAZON |
| `conditionId` | EBAY |
| `country_of_origin` | AMAZON |
| `description` | AMAZON, EBAY, ETSY |
| `design_file_url` | AMAZON |
| `is_supply` | ETSY |
| `name` | AMAZON, EBAY, ETSY |
| `price` | EBAY, ETSY |
| `productType` | AMAZON |
| `quantity` | EBAY, ETSY |
| `taxonomy_id` | ETSY |
| `when_made` | ETSY |
| `who_made` | ETSY |

## ⬜ Coordinates that could not be read

- AMAZON·BE·OUTERWEAR: no coordinate
- AMAZON·NL·OUTERWEAR: no coordinate
- AMAZON·UK·AUTO_ACCESSORY: no coordinate
- AMAZON·UK·COAT: no coordinate
- AMAZON·UK·HELMET: no coordinate
- AMAZON·UK·OUTERWEAR: no coordinate
- AMAZON·UK·PANTS: no coordinate
- AMAZON·UK·SUIT: no coordinate
- EBAY·UK·177106: no coordinate
