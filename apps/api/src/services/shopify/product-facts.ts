import { nativeFieldValueError, type NativeEdit } from '@nexus/shared/shopify-information'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { storedChannelState } from '../pim/channel-value-mutation.js'
import type { ChannelFieldSpec } from '../pim/channel-specs/types.js'
import type { ResolvedCell } from '../pim/mapping/resolve-batch.service.js'

/**
 * Wave 2 item 5 + D3 (Owner decision 11) — the product-level facts Nexus sends to Shopify, read by the SAME resolver the
 * sheet shows them with: the brand (Shopify's vendor) and the product type on every synchronization, and the theme
 * template when Nexus creates the product. Before, the sheet showed the resolver's value (rules, value maps, transforms)
 * while `productSet` sent the stored value else the raw `brand` / `shopify_product_type`, and every create sent "nexus"
 * whatever the listing held.
 *
 *   - the listing's own value wins (typed, imported, or cleared — a cleared theme template is '', the store's default);
 *   - else one `resolveBatch` call for the family's main product answers (vendor and product type from Shared, the theme
 *     template from its default rule, "nexus");
 *   - a resolver that fails, or a value Shopify would refuse, holds Publish with its reason — never a quiet fallback.
 * The values are part of the review's remote revision, and the review lists the resolved ones as Shared.
 */
export const PRODUCT_FACT_FIELDS = ['vendor', 'productType', 'templateSuffix'] as const
export type ProductFactField = typeof PRODUCT_FACT_FIELDS[number]
export interface ProductFactReview { productId: string; label: string; type: string; locale: string; value: string; shared?: true }
export interface ShopifyProductFacts {
  /** Shopify's wire text; '' = no value (no vendor, no product type, the store's default template). */
  vendor: string
  productType: string
  /** Sent only when Nexus creates the product; on a product Shopify holds it is not sent (and reads ''). */
  templateSuffix: string
  /** The values the resolver supplied (not the listing's own), for the review: "Brand · en: Xavia [Shared]". */
  review: ProductFactReview[]
  /** Reasons Publish is held (SKU-less: the facts belong to the product). */
  problems: string[]
}

/** A mapping that failed or was skipped: the value that would ship is unknown (the same test as `inherited-information.ts`). */
const UNCHECKED = /^(expr (?:failed|skipped)|Conflicting variant attributes)/

const specs = (): Array<ChannelFieldSpec & { id: ProductFactField }> => {
  const fields = shopifyProductSpec().fields
  return PRODUCT_FACT_FIELDS.map(id => ({ ...fields.find(field => field.shopifyField?.id === id)!, id }))
}

/** The listing's own value of a fact, or undefined when it stores none (a cleared one is stored, as ''). */
function storedFact(listing: unknown, spec: ChannelFieldSpec): string | undefined {
  const state = storedChannelState((listing ?? {}) as Record<string, unknown>, spec.channelStore, [...new Set([spec.masterKey ?? spec.key, spec.key])])
  return state.state === 'stored' ? factWireValue(state.value) : undefined
}

/** A fact in Shopify's wire form: text as it is, a number as its text, nothing as ''. */
export function factWireValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

const failureSentence = (newProduct: boolean, reason: string) =>
  `Nexus could not read the Shared brand${newProduct ? ', product type and theme template' : ' and product type'} for Shopify (${reason}). Nothing was sent; try again.`

/**
 * PURE. The facts from the listing and the resolver's cells for the main product (`resolved` null = no resolver answer;
 * `failure` = the resolver failed, with its reason).
 */
export function productFactsFrom(input: { familyId: string; listing: unknown; newProduct: boolean; locale: string
  resolved: { cells: Record<string, Pick<ResolvedCell, 'status' | 'value' | 'warnings' | 'mappingErrors'>> } | null; failure?: string | null }): ShopifyProductFacts {
  const out: ShopifyProductFacts = { vendor: '', productType: '', templateSuffix: '', review: [], problems: [] }
  if (input.failure) out.problems.push(failureSentence(input.newProduct, input.failure))
  for (const spec of specs()) {
    // The theme template is sent only when Nexus creates the product.
    if (spec.id === 'templateSuffix' && !input.newProduct) continue
    const label = spec.shopifyField!.label
    const stored = storedFact(input.listing, spec)
    if (stored !== undefined) { out[spec.id] = stored; continue }
    if (input.failure) continue
    const cell = input.resolved?.cells[spec.key]
    if (!cell) { out.problems.push(`${label}: Nexus could not read its Shared value for Shopify. Nothing was sent; reload and try again.`); continue }
    const unchecked = (cell.warnings ?? []).find(warning => UNCHECKED.test(warning)) ?? cell.mappingErrors?.[0]
    if (unchecked) { out.problems.push(`${label}: ${unchecked}`); continue }
    const value = cell.status === 'mapped' ? factWireValue(cell.value) : ''
    const error = value ? nativeFieldValueError(spec.id as NativeEdit['field'], value) : null
    if (error) { out.problems.push(`${label}: ${error}`); continue }
    out[spec.id] = value
    // The theme template's "nexus" is the channel's default rule, not a Shared value: it is listed without the Shared tag.
    if (value) out.review.push({ productId: input.familyId, label, type: spec.shopifyField!.type, locale: input.locale, value, ...(spec.id !== 'templateSuffix' ? { shared: true as const } : {}) })
  }
  return out
}

/** The facts the listing stores no value for: the ones the resolver must answer. */
export const factFieldsToResolve = (listing: unknown, newProduct: boolean) =>
  specs().filter(spec => (spec.id !== 'templateSuffix' || newProduct) && storedFact(listing, spec) === undefined)

/**
 * One resolver call for the family's main product (the same resolver the sheet and the review read). A failure holds
 * Publish with its reason. `newProduct`: Shopify does not hold the product yet (the theme template is sent).
 */
export async function resolveShopifyProductFacts(input: { familyId: string; accountId: string; marketplace: string; aliasKey?: string | null
  listing: unknown; newProduct: boolean; locale: string }): Promise<ShopifyProductFacts> {
  const pending = factFieldsToResolve(input.listing, input.newProduct)
  if (!pending.length) return productFactsFrom({ ...input, resolved: null })
  try {
    // Loaded on use, as `inherited-information.ts` loads it: the resolver's import graph is large.
    const { resolveBatch } = await import('../pim/mapping/resolve-batch.service.js')
    const result = await resolveBatch({ channel: 'SHOPIFY', marketplace: input.marketplace, channelConnectionId: input.accountId, aliasKey: input.aliasKey ?? '',
      productIds: [input.familyId], fieldKeys: pending.map(spec => spec.key), includeCatalogue: false })
    return productFactsFrom({ ...input, resolved: result.products.find(product => product.productId === input.familyId) ?? null })
  } catch (error) {
    return productFactsFrom({ ...input, resolved: null, failure: error instanceof Error ? error.message : String(error) })
  }
}
