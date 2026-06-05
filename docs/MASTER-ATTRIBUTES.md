# Master Attributes (MA-series)

## Why
The mapping engine (FM/BM series) maps channel fields **from** master attributes.
The Master tab's attributes used to be a free key/value bag with no schema, so
the master was thin and channel listings stayed empty no matter how good the
mapping was. The MA-series makes the master a **rich, schema-driven SSOT** and
bootstraps it from the data already published on the Amazon parent.

## What shipped
| Phase | Capability |
|-------|-----------|
| MA.1 | Per-productType master attribute **schema** |
| MA.2 | **Schema-driven Master tab** editor (typed, grouped, required-first, searchable + completeness header + custom escape hatch) |
| MA.3 | **Import from Amazon parent** (reverse-map bootstrap) |
| MA.4 | **Completeness** governance (overall + required + missing-required chips) |
| MA.5 | **AI gap-fill** for empty attributes |

## How it works

### Schema (MA.1) — `services/pim/master-schema.service.ts`
`getMasterAttributeSchema(productId)` = the category attributes from
`field-registry.getAvailableFields` (which unfolds the cached Amazon
`CategorySchema`, across the product's Amazon markets) **∪** the distinct
`categoryAttributes.*` sources the product's mapping rules already reference (so
master keys line up with what the channels read). Master key = the
`categoryAttributes` key. Required-first, then alpha.
`GET /api/products/:id/master-schema`.

### Rich tab (MA.2) — `tabs/_shared/MasterAttributesEditor.tsx`
Renders the schema as typed fields (select for `allowedValues`, number, text)
bound to the **same `categoryAttributes` bag** — so the existing
MasterGlobalSections flush/dirty machinery (`PATCH /global` → `mergeTechnical`)
is unchanged. Off-schema keys remain editable under "Custom attributes"
(`TechAttrsEditor`).

### Import (MA.3) — `services/pim/reverse-mapping.service.ts`
`proposeImportFromChannel` **inverts** the resolved mapping rules: reads the
parent's Amazon `ChannelListing.platformAttributes` and proposes writing each
value UP to the master at the rule's `source`. Non-invertible transforms
(`valueMap`/`sizeScale`/`template`/`translate`/`unit`/`numberFormat`) are
skipped + flagged; conflicts (master already has a value) are skip-by-default.
`POST /api/products/:id/master/import-from-channel {channel, marketplace}` →
reviewed in `ImportFromAmazonModal` → applied via `PATCH /global`
(`categoryAttributes` + `localizedContent`, both partial-safe merges).

**The flow:** Mapping tab → **Auto-map** (BM) defines the rules → Master tab →
**Import from Amazon** reverses them to fill the master from what's already live.

### Completeness (MA.4) — `services/pim/master-completeness.service.ts`
`computeMasterCompleteness(schema, values)` → overall % + required filled/total
+ missing-required list + per-group counts (a variant inherits the parent's
master values). `GET /api/products/:id/master/completeness`. Surfaced as the
editor's "N/M filled · K required missing" header + clickable missing-required
chips (jump to field via search) + a "✓ All required attributes filled" state.

### AI fill (MA.5) — `services/pim/master-ai-fill.service.ts`
`suggestMasterAttributes` makes one batched LLM call (reuses the budget-capped
`getProvider` + `parseAiJson`) to infer the still-empty schema attributes from
the title/description/known attributes. Select attributes are constrained to
their `allowedValues`; low confidence is dropped; kill-switch-aware.
`POST /api/products/:id/master/ai-fill`. The Master tab's "Suggest with AI"
opens a review panel (high-confidence accepted by default); Apply writes through
the existing flush. Review-gated — no AI value is written without operator
accept.

## Endpoints
- `GET  /api/products/:id/master-schema`
- `POST /api/products/:id/master/import-from-channel` `{ channel, marketplace }`
- `GET  /api/products/:id/master/completeness`
- `POST /api/products/:id/master/ai-fill`

## Verifier tests
- `pim-master-schema.test.ts` — `buildMasterAttributes` (key strip, type map, required-first, mapping-source union)
- `pim-reverse-mapping.test.ts` — `readChannelValue` (Amazon wrapped shape)
- `pim-master-completeness.test.ts` — `computeMasterCompleteness`
- `parseAiJson` covered by `pim-mapping-suggest-ai.test.ts`

## Deferred
- **`/products` "master completeness" grid column + "incomplete masters"
  filter.** Needs the products-list API to compute per-product completeness
  (cache the per-productType schema once, count filled per product). Deferred to
  avoid a hot-path perf regression; the per-product completeness signal is on
  the Master tab today and available via the completeness endpoint.
