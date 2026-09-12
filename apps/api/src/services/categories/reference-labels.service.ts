import { loadAmazonSpec } from '../pim/channel-specs/index.js'
import { resolveChannelConnectionId } from '../connection-resolver.service.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import prisma from '../../db.js'
import { cachedBrowseNodeLabels } from './browse-node-labels.service.js'

type Labels = Record<string, Record<string, string>>
const shippingCache = new TtlCache<Promise<Record<string, string>>>({ ttlMs: 5 * 60_000, maxEntries: 100 })

/** Saved taxonomy paths remain usable when the external taxonomy service is unavailable. */
export async function cachedCategoryLabels(channel: string, marketplace: string, productType: string): Promise<Labels> {
  const mappings = await prisma.categoryChannelMapping.findMany({
    where: { channel, marketplace: { in: channel === 'EBAY' ? [marketplace] : [marketplace, '*'] }, channelCategoryId: productType, channelCategoryPath: { not: null } },
    select: { marketplace: true, channelCategoryPath: true },
  })
  const exact = mappings.filter(mapping => mapping.marketplace === marketplace)
  const names = [...new Set((channel === 'EBAY' || exact.length ? exact : mappings).map(mapping => mapping.channelCategoryPath?.trim()).filter((name): name is string => !!name))]
  // Conflicting saved labels are not a license to pick an arbitrary category name.
  return names.length === 1 ? { [channel === 'EBAY' ? 'categoryId' : 'productType']: { [productType]: names[0] } } : {}
}

/** Seller-specific names are deliberately kept out of the shared category-schema cache. */
async function shippingTemplateLabels(marketplace: string, productType: string, connectionId: string, refresh = false): Promise<Record<string, string>> {
  const key = JSON.stringify([workspaceIdForQuery(), connectionId, marketplace, productType])
  const hit = shippingCache.get(key)
  if (hit && !refresh) return hit
  const pending = (async () => {
    const { amazonSellerSpec } = await import('./seller-schema.service.js')
    const spec = await amazonSellerSpec(connectionId, marketplace, productType, refresh)
    const field = spec.fields.find(field => field.key === 'merchant_shipping_group')
    return Object.fromEntries(Object.entries(field?.optionLabels ?? {}).filter(([id]) => field?.options?.includes(id) && !field.deprecatedOptions?.includes(id)))
  })().catch(error => { shippingCache.delete(key); throw error })
  shippingCache.set(key, pending)
  return pending
}

/** Shared by display lookup and writes, scoped to the verified seller account. */
export async function sellerShippingTemplateLabels(input: { marketplace: string; productType: string; accountId?: string; refresh?: boolean }): Promise<Record<string, string>> {
  const connectionId = await resolveChannelConnectionId('AMAZON', input.accountId)
  if (!connectionId) throw new Error('Shipping templates are unavailable for this seller')
  return shippingTemplateLabels(input.marketplace, input.productType, connectionId, input.refresh)
}

/** Label metadata only: no product/listing writes, schema refreshes, or changes to allowed values. */
export async function amazonReferenceLabels(input: { marketplace: string; productType: string; accountId?: string; shipping: boolean; browseNodeIds?: string[] }) {
  const spec = await loadAmazonSpec(input.marketplace, input.productType, input.accountId)
  const labels: Labels = Object.fromEntries(spec.fields.filter(field => field.optionLabels && field.key !== 'merchant_shipping_group').map(field => [field.key, field.optionLabels!]))
  const unavailable: string[] = []
  const missingNodes = (input.browseNodeIds ?? []).filter(id => !labels.recommended_browse_nodes?.[id] || labels.recommended_browse_nodes[id] === id)
  if (missingNodes.length) {
    try {
      const names = await cachedBrowseNodeLabels(input.marketplace, missingNodes)
      labels.recommended_browse_nodes = { ...labels.recommended_browse_nodes, ...names }
      labels.browseNodeId = { ...labels.browseNodeId, ...names }
      if (missingNodes.some(id => !names[id])) unavailable.push('browseNodes')
    } catch { unavailable.push('browseNodes') }
  }
  if (labels.recommended_browse_nodes) labels.browseNodeId = { ...labels.recommended_browse_nodes, ...labels.browseNodeId }
  if (input.shipping) {
    // Seller-owned choices come from this exact account’s product-type definition.
    try {
      const names = await sellerShippingTemplateLabels(input)
      labels.merchant_shipping_group = names
      labels.shippingTemplate = names
      if (!Object.keys(names).length) unavailable.push('shippingTemplate')
    } catch { unavailable.push('shippingTemplate') }
  }
  return { labels, unavailable }
}
