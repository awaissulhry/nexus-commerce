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
| 0a | Parent legacy columns (`name`→`title`, `description`→`description`, `bulletPoints`, `keywords`, `brand`, `manufacturer`, `basePrice`) | `masterColumn` | `synthesize=true` (default) AND `locale='en'` AND parent exists |
| 1 | Parent `Product.categoryAttributes` | `master` | Resolving a variant child (`product.parentId != null`) |
| 2 | Parent `Product.localizedContent[locale]` | `masterLocale` | Same, with locale set |
| 3 | Parent `Product.localizedContent['en']` | `masterLocale` | Per-key fallback when locale layer didn't supply the key |
| 0b | Variant legacy columns (same set as 0a) | `masterColumn` | `synthesize=true` AND `locale='en'`; for top-level products this is the master layer too |
| 4 | Variant `Product` own values: `variantAttributes`, `categoryAttributes`, `localizedContent[locale]`, then `en` | `variant` / `variantLocale` | Always (for top-level products, this is layer 1) |
| 5 | `ChannelListing.overrideData` | `channelOverride` | When `channelListing` is supplied |
| 6 | `ChannelListing.titleOverride` / `priceOverride` / etc. | `channelExplicit` | When `followMasterX === false` for that field |

For top-level products (no parent), layers 0a–3 are skipped and 0b/4
become the master baseline (`source = 'master'` instead of `'variant'`).

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

## A.4 — Legacy-column synthesis (compat layer)

Many Product attributes still live in legacy columns (`Product.name`,
`Product.description`, `bulletPoints`, etc.) rather than `localizedContent`
or `categoryAttributes`. Migrating those writes is a Phase B+ effort.

To unblock Phase B without waiting, the resolver synthesizes from
legacy columns when JSONB doesn't supply a key. Controlled by the
`synthesize` option on `ResolveInput`:

```ts
resolveAttributes({ product, parent, synthesize: true })  // default
resolveAttributes({ product, parent, synthesize: false }) // strict JSONB only
```

**Rules:**
- Fires only when `locale === 'en'` (the default). Non-en queries that
  lack their per-locale slot surface as "missing translation" in the
  UI — they don't get English text mislabeled.
- Lowest-precedence layer for each entity. Any JSONB layer (parent or
  variant, master or locale, channel override) overrides it.
- Variant column synthesis still beats parent JSONB — matches "variant
  overrides parent" semantics elsewhere.
- Empty arrays count as "no data" so a variant with `bulletPoints: []`
  falls back to parent (or doesn't synthesize at all).
- Source label: `'masterColumn'`. `inheritedFrom` is `<productId>:<columnName>`
  so the UI can deep-link to the exact field.

**Synthesis map** (locked in A.4):

| Resolver key | Legacy column |
|---|---|
| `title` | `Product.name` |
| `description` | `Product.description` |
| `bulletPoints` | `Product.bulletPoints` |
| `keywords` | `Product.keywords` |
| `brand` | `Product.brand` |
| `manufacturer` | `Product.manufacturer` |
| `basePrice` | `Product.basePrice` |

**Removal path:** when shadow telemetry (A.2) shows zero `masterColumn`
hits for a given key over a period, that column's writes have fully
migrated to JSONB. Remove the entry from `SYNTHESIS_MAP` in a Phase B
or C sub-phase; drop the legacy column in a follow-up migration.

## Out of scope for A.1–A.4

- **Caller migration** — existing read paths (edit page, grid, publish
  pipeline) still read direct columns. Phase B starts flipping them
  onto the resolver.
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
