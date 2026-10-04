import { nativeFieldValueError, normalizeShopifyWeight, type NativeEdit } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ContentVariant } from '@nexus/shared/shopify-content'
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { storedChannelState } from '../pim/channel-value-mutation.js'
import type { ResolvedCell } from '../pim/mapping/resolve-batch.service.js'

/**
 * S1 item 5 (product sheet consistency, Owner decisions 10 + 11) — the Shopify information a NEW variant takes from its
 * Shared product. The sheet shows these values inherited on a new row; until now Publish sent only typed values, so a
 * new Shopify variant was created without them. Now `productSet` creates the variant with them, and the value is checked
 * after the create (`listingInformationDraft`).
 *
 * Only a variant Shopify does not hold yet (no recorded Shopify variant id, no Shopify variant with its SKU) and only a
 * field its listing stores no value for (a typed or cleared value keeps its own path). A product already on Shopify does
 * not receive Shared changes here: the sheet marks that difference (`channel-sheet-projection.ts`).
 */
export const INHERITED_INFORMATION_FIELDS = ['barcode', 'cost', 'countryCodeOfOrigin', 'harmonizedSystemCode', 'weight'] as const
export type InheritedInformationField = typeof INHERITED_INFORMATION_FIELDS[number]
/** Per Nexus variant id: each value in Shopify Information's wire form (text; a weight is its JSON in Shopify's unit code). */
export type InheritedInformationValues = Record<string, Partial<Record<InheritedInformationField, string>>>
export interface InheritedInformationReview { productId: string; label: string; type: string; locale: string; value: string; shared: true }
export interface InheritedInformation { values: InheritedInformationValues; problems: string[]; review: InheritedInformationReview[] }

export const noInheritedInformation = (): InheritedInformation => ({ values: {}, problems: [], review: [] })
const isInherited = (id: string): id is InheritedInformationField => (INHERITED_INFORMATION_FIELDS as readonly string[]).includes(id)
/** A mapping that failed or was skipped: the value that would ship is unknown (`resolve-batch.service.ts`, the same test). */
const UNCHECKED = /^(expr (?:failed|skipped)|Conflicting variant attributes)/

export interface InheritedCandidate { productId: string; sku: string; fields: Array<{ id: InheritedInformationField; key: string; label: string; type: string }> }

/** A resolved Shared value in the wire form Shopify Information validates and sends; null when there is nothing to send. */
export function inheritedWireValue(field: InheritedInformationField, value: unknown): string | null {
  if (value == null || value === '') return null
  if (field === 'weight') {
    const weight = normalizeShopifyWeight(value)
    return typeof weight === 'string' ? weight : JSON.stringify(weight)
  }
  if (typeof value === 'string') return value.trim() === '' ? null : value
  // A number (a cost) is sent as its decimal text; a list or a record is passed on as JSON for the validator to refuse.
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

/**
 * Pure: the resolver's answer for the candidates, as values to send plus the problems that hold Publish (SKU + label +
 * reason). A product the resolver did not answer for is a problem, never a skipped variant.
 */
export function inheritedInformationFromCells(candidates: InheritedCandidate[], resolved: Array<{ productId: string; cells: Record<string, Pick<ResolvedCell, 'status' | 'value' | 'warnings'>> }>, locale: string): InheritedInformation {
  const out = noInheritedInformation()
  for (const candidate of candidates) {
    const product = resolved.find(p => p.productId === candidate.productId)
    if (!product) { out.problems.push(`${candidate.sku}: Nexus could not read this variant's Shared values for Shopify. Reload and publish again.`); continue }
    for (const field of candidate.fields) {
      const cell = product.cells[field.key]
      if (!cell || cell.status !== 'mapped') continue
      const unchecked = (cell.warnings ?? []).find(warning => UNCHECKED.test(warning))
      if (unchecked) { out.problems.push(`${candidate.sku}: ${field.label}: ${unchecked}`); continue }
      const value = inheritedWireValue(field.id, cell.value)
      if (value === null) continue
      const error = nativeFieldValueError(field.id as NativeEdit['field'], value)
      if (error) { out.problems.push(`${candidate.sku}: ${field.label}: ${error}`); continue }
      ;(out.values[candidate.productId] ??= {})[field.id] = value
      out.review.push({ productId: candidate.productId, label: field.label, type: field.type, locale, value, shared: true })
    }
  }
  return out
}

/** The variants and fields that inherit (see the module note). Pure. */
export function inheritedCandidates(input: { variants: Pick<ContentVariant, 'id' | 'sku' | 'shopifyVariantId'>[]; listings: Array<{ productId: string; [key: string]: unknown }>
  schema: ShopifyStoreSchema; accountId: string; remoteSkus?: string[] }): InheritedCandidate[] {
  const specs = shopifyProductSpec(input.schema, input.accountId).fields.filter(spec => spec.shopifyField && !spec.shopifyField.definition && isInherited(spec.shopifyField.id) && !spec.readOnlyReason)
  const remote = new Set(input.remoteSkus ?? [])
  return input.variants.filter(variant => !variant.shopifyVariantId && !remote.has(variant.sku)).map(variant => {
    const listing = input.listings.find(l => l.productId === variant.id)
    const fields = specs.filter(spec => !listing || storedChannelState(listing, spec.channelStore, [...new Set([spec.masterKey ?? spec.key, spec.key])]).state !== 'stored')
      .map(spec => ({ id: spec.shopifyField!.id as InheritedInformationField, key: spec.key, label: spec.shopifyField!.label, type: spec.shopifyField!.type }))
    return { productId: variant.id, sku: variant.sku, fields }
  }).filter(candidate => candidate.fields.length > 0)
}

/**
 * One resolver call for every candidate (the same resolver the sheet and the review read). A resolver failure holds
 * Publish with its reason; it never leaves the values out quietly.
 */
export async function resolveInheritedInformation(input: { accountId: string; marketplace: string; aliasKey?: string | null; schema: ShopifyStoreSchema
  variants: Pick<ContentVariant, 'id' | 'sku' | 'shopifyVariantId'>[]; listings: Array<{ productId: string; [key: string]: unknown }>; remoteSkus?: string[] }): Promise<InheritedInformation> {
  const candidates = inheritedCandidates(input)
  if (!candidates.length) return noInheritedInformation()
  const locale = input.schema.locales.find(l => l.primary)?.locale ?? ''
  try {
    // Loaded on use, as the studio loads the Shopify sync: the resolver's import graph is large.
    const { resolveBatch } = await import('../pim/mapping/resolve-batch.service.js')
    const result = await resolveBatch({ channel: 'SHOPIFY', marketplace: input.marketplace, channelConnectionId: input.accountId, aliasKey: input.aliasKey ?? '',
      productIds: candidates.map(c => c.productId), fieldKeys: [...new Set(candidates.flatMap(c => c.fields.map(f => f.key)))], includeCatalogue: false })
    return inheritedInformationFromCells(candidates, result.products, locale)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...noInheritedInformation(), problems: [`Nexus could not read the Shared barcode, cost, country of origin, HS code and weight for the new Shopify variants (${reason}). Nothing was sent; try again.`] }
  }
}
