/**
 * ONE function for the `CategorySchema` marketplace coordinate (LX.F2, ruling R-LX-20, on LX.F's
 * finding F9).
 *
 * 🔴 The table holds TWO spellings for the same eBay market. Measured on the local catalogue
 * 2026-09-13: `CategorySchema` for EBAY carries **`EBAY_IT` 3 rows** (all active, newest
 * 2026-09-13T05:05:46) and **`IT` 5 rows**, overlapping on product types 177101 / 177104 / 177109,
 * while the authority `Marketplace.code` for EBAY is `DE, ES, FR, IT, UK` and `EBAY_IT` is the only
 * channel-prefixed spelling anywhere in the table. The writer is one line in the Owner-untouchable
 * flat-file family (`routes/ebay-flat-file.routes.ts:548`, `marketplace = 'EBAY_IT'` written verbatim
 * into the row at :647), so it is NOT fixed here — it waits for the Owner's exemption, and until then
 * a reader keyed by `Marketplace.code` must see both spellings or it silently reads no requirements
 * at all for a category that has them.
 *
 * Before this module the rule was written FOUR different ways and two of them were incomplete
 * (`reference_two_column_builders_drift`):
 *   - `pim/channel-specs/index.ts:118` stripped `EBAY_` and read `{ in: [mk, 'EBAY_' + mk] }` — correct;
 *   - `taxonomy/repository.ts:12` (`schemaMarkets`) handled both directions plus UK/GB — correct;
 *   - `ebay-presentation-order.service.ts:57` and `mapping/category-mapping.service.ts:454` read
 *     `{ in: [market, 'EBAY_' + market] }` WITHOUT stripping first, so a caller already holding
 *     `EBAY_IT` asked for `EBAY_EBAY_IT` and missed every `IT` row;
 *   - `pim/schema-sync-bridge.ts:79` used the value verbatim, so it saw exactly one of the two
 *     spellings and never the other.
 *
 * This module has no imports on purpose: it is a leaf, so any reader can use it without pulling a
 * service graph (and the vitest for it needs no database).
 */

/** eBay markets whose two ISO spellings are interchangeable in this table (UK is the authority's code). */
const UK_SPELLINGS = ['UK', 'GB'] as const

const bare = (marketplace: string) => marketplace.trim().toUpperCase().replace(/^EBAY_/, '')

/**
 * The CANONICAL stored coordinate for a (channel, marketplace) pair — what a WRITER should store and
 * what a single-value read should ask for: `Marketplace.code` for eBay and Amazon (so `EBAY_IT` → `IT`,
 * `GB` → `UK`), and the one global coordinate for the store channels.
 */
export function categorySchemaMarket(channel: string, marketplace: string | null | undefined): string | null {
  const ch = channel?.trim().toUpperCase() ?? ''
  if (ch === 'ETSY' || ch === 'SHOPIFY' || ch === 'WOOCOMMERCE') return 'GLOBAL'
  if (!marketplace) return null
  const code = bare(marketplace)
  if (ch === 'EBAY' && code === 'GB') return 'UK'
  return code
}

/**
 * Every spelling a READ must accept for that coordinate, canonical first. Hand it to Prisma as
 * `marketplace: { in: categorySchemaMarkets(channel, market) }`. For a non-eBay channel this is a
 * one-element list, so the call shape is the same everywhere and there is no per-channel branch at
 * the call site.
 */
export function categorySchemaMarkets(channel: string, marketplace: string | null | undefined): string[] {
  const canonical = categorySchemaMarket(channel, marketplace)
  if (!canonical) return []
  const ch = channel?.trim().toUpperCase() ?? ''
  if (ch !== 'EBAY') return [canonical]
  const spellings = UK_SPELLINGS.includes(canonical as typeof UK_SPELLINGS[number]) ? [...UK_SPELLINGS] : [canonical]
  return [...new Set(spellings.flatMap(code => [code, `EBAY_${code}`]))]
}
