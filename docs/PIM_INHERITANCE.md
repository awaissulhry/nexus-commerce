# PIM inheritance model (Phase A.1)

Foundation for the best-in-class enterprise PIM rebuild. Defines the
single read-path for "what's the value of attribute K for product P
on channel C in locale L".

## Why this exists

The catalog has multiple competing override mechanisms today:

- Direct columns on `Product` (`name`, `description`, `bulletPoints`, …)
- `Product.categoryAttributes` JSON for dynamic attributes
- Child Products that inherit from parent via `parentId`
- `ChannelListing` with both the Phase 20 SSOT pattern (`followMasterX`
  flags + `xOverride` columns) and direct columns (`title`, `price`)
- `ChannelListing.platformAttributes` JSON for channel-native fields

Each subsystem reads these differently. The resolver is the single
read-path that callers go through to get the *merged* value.

## Merge precedence

Lowest → highest. Later layers override earlier ones for any given key.

| # | Layer | Source on `ResolvedValue` | When it applies |
|---|---|---|---|
| 1 | Parent `Product.categoryAttributes` | `master` | Resolving a variant child (`product.parentId != null`) |
| 2 | Parent `Product.localizedContent[locale]` | `masterLocale` | Same, with locale set |
| 3 | Parent `Product.localizedContent['en']` | `masterLocale` | Per-key fallback when locale layer didn't supply the key |
| 4 | Variant `Product` own values: `variantAttributes`, `categoryAttributes`, `localizedContent[locale]`, then `en` | `variant` / `variantLocale` | Always (for top-level products, this is layer 1) |
| 5 | `ChannelListing.overrideData` | `channelOverride` | When `channelListing` is supplied |
| 6 | `ChannelListing.titleOverride` / `priceOverride` / etc. | `channelExplicit` | When `followMasterX === false` for that field |

For top-level products (no parent), layers 1-3 are skipped and step 4
becomes the master baseline (`source = 'master'` instead of `'variant'`).

## SSOT-tracked fields

Phase 20 introduced a per-field SSOT toggle for the most-edited
attributes. The resolver respects it:

| Field | Follow flag | Override column |
|---|---|---|
| `title` | `followMasterTitle` | `titleOverride` |
| `description` | `followMasterDescription` | `descriptionOverride` |
| `price` | `followMasterPrice` | `priceOverride` |
| `quantity` | `followMasterQuantity` | `quantityOverride` |
| `bulletPoints` | `followMasterBulletPoints` | `bulletPointsOverride` |

When `followMasterX === true` (the default), the master/variant/locale
value wins. When `followMasterX === false`, the override column wins;
if the override column is null, the resolver falls back to the legacy
direct column (`title`, `price`, …) — covers rows that pre-date the
Phase 20 split.

## API

```ts
import { resolveAttributes } from '@/services/pim/attribute-resolver'

const result = resolveAttributes({
  product,         // ProductLike — the (possibly variant) product
  parent,          // ProductLike | null — required when product.parentId
  channelListing,  // ChannelListingLike | null — optional
  locale: 'it',    // defaults to 'en'
})

// result.title === { value: 'Tuta Apex', source: 'masterLocale', inheritedFrom: 'parent1' }
// result.material === { value: 'Kangaroo', source: 'variant', inheritedFrom: 'v1' }
```

`source` and `inheritedFrom` drive the inheritance UI in Phase B:
gray italic for inherited (anything not `channelExplicit` or
`channelOverride` on a channel tab), bold for own values, with the
"Reset to global" action targeting the `inheritedFrom` entity.

### Convenience wrappers

- `resolveAttributesFlat(input)` — strips provenance, returns plain
  `Record<string, unknown>`. Use in publish payload generators.
- `resolveAttributesBySource(input, sources)` — returns only keys whose
  origin matches one of `sources`. Use for "show diff vs master".

## Locale set

Schema default is `{en, it}` — Xavia primary markets. Additional
locales (`de`, `fr`, `es`) are added by writes, not schema migrations.
The resolver treats any locale key as valid; absence falls back to `en`.

## Out of scope for A.1

- **Caller migration** — existing read paths (edit page, grid, publish
  pipeline) still read direct columns. A.4 wires the first caller in
  behind a feature flag.
- **Write paths** — nothing writes to `localizedContent` or
  `overrideData` until Phase B (Global tab + inheritance UI).
- **Deep merge for nested objects** — current resolver replaces wholesale.
  If we need deep merge (e.g., layered bulletPoint arrays), add it in a
  follow-up with explicit semantics.

## Rollback

Pure-additive schema. To revert:

```sql
DROP INDEX "Product_localizedContent_gin_idx";
DROP INDEX "ChannelListing_overrideData_gin_idx";
ALTER TABLE "Product" DROP COLUMN "localizedContent";
ALTER TABLE "ChannelListing" DROP COLUMN "overrideData";
```

Plus delete `apps/api/src/services/pim/attribute-resolver.ts` and the
test file. No upstream callers depend on the new columns yet.
