# Cross-market value localization (VL-series)

## The problem
Constrained (dropdown) attribute values differ per market — "Waterproof" shows
as "Impermeabile" (IT), "Wasserdicht" (DE). The operator should pick ONCE in
English; each market should get its correct value, dynamically, with override.

## Key finding — Amazon and eBay differ fundamentally
- **Amazon:** enum WIRE values are **canonical English codes, identical across
  markets** (`water_resistance_level` wire = `waterproof`/`water_resistant`/… sent
  to every market). Only `enumNames` localize the DISPLAY, and Amazon auto-shows
  the local word per market. → Amazon needs only an **English operator dropdown
  that stores the canonical wire**; NO per-market value mapping.
- **eBay:** aspect VALUES are **localized wire per market** (you literally send
  "Impermeabile" to eBay-IT). → eBay needs a real **value dictionary** (English
  canonical → per-market value).

## What shipped
| Phase | Capability |
|-------|-----------|
| VL.1 | `CategorySchemaService.getEnglishEnumLabels` (en_US schema, 24h cache) → wire→English; `master-schema` attaches `optionLabels`. Master enum dropdown shows English + stores the canonical wire. Pure extractor: `categories/enum-labels.ts`. |
| VL.2 | `getLocalizedEnumLabels` (cached schemas, no fetch) → `localizedByMarket`; Master tab per-market display preview ("IT → Impermeabile · DE → Wasserdicht"). |
| VL.3 | `ebay-value-map.service.seedEbayValueMaps` + `POST /api/pim/value-maps/seed-ebay`: AI-translate a product's eBay aspect SELECTION values per market → English → seed `FieldValueMap` (EBAY, `aspect_<EnglishName>`, fromValue=English, toValue=localized), review-gated. |
| VL.4 | verifier (`pim-enum-labels.test`), governance via the channel-generic `/pim/value-maps` console, this doc. |

## Endpoints
- `GET /api/products/:id/master-schema` → enum attrs carry `optionLabels` (English) + `localizedByMarket` (preview).
- `POST /api/pim/value-maps/seed-ebay` `{ productId, marketplaces? }` → seed the eBay dictionary (review-gated).
- `GET/PUT/DELETE /api/pim/value-maps` (FM.4) → review/override (all channels).

## How it resolves
- **Amazon:** master stores the canonical wire → sent to every market → Amazon
  localizes the display. No transform needed; the master dropdown is English.
- **eBay:** the eBay rule's `valueMap` transform + the EBAY `FieldValueMap`
  (English → market value) resolve in `resolve-channel-field`; applied when the
  channel value is built (preview now; the live write rides the FM.7 cascade gate).

## Governance / accuracy
- Amazon labels are **official** (en_US `enumNames`). eBay maps are **AI-seeded**
  (confidence `AI_*`, `reviewedAt=null`) → review/override in the value-maps
  console; per-market override wins. English markets (UK/GB) are identity (trusted).

## Constraints honored
- Master stays channel-agnostic (stores the canonical). **ZERO flat-file editor
  changes** — flat-files read the resolved values. English operator UI.
