import { languageTag } from '../pim/market-languages.js'
import { amazonImageSlots, type AmazonMediaItem, type AmazonMediaObservation, type AmazonMediaPatch } from '@nexus/shared/amazon-media'
import prisma from '../../db.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAccessToken, assertWritable } from '../cx/token.service.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

export const mediaObject = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
export function marketValue(value: unknown, marketplaceId: string): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const rows = value.filter(v => v && typeof v === 'object' && (!v.marketplace_id || v.marketplace_id === marketplaceId))
  if (rows.length !== 1) return null
  const v = rows[0].value ?? rows[0].name ?? rows[0].media_location
  return typeof v === 'string' ? v : null
}
export function amazonVariationAttributes(attributes: Record<string, unknown>, theme: string | null, marketplaceId: string, definedAxes?: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  // Amazon's theme names use slash-delimited attribute names. Do not invent axes
  // from product titles, arbitrary attributes or colour/size heuristics.
  for (const axis of definedAxes ?? (theme ?? '').split('/').filter(Boolean)) {
    const key = axis.toLowerCase()
    const raw = attributes[key]
    const value = marketValue(raw, marketplaceId)
    if (value !== null) result[key] = value
    else if (Array.isArray(raw)) {
      const selected = raw.filter(v => v && typeof v === 'object' && (!v.marketplace_id || v.marketplace_id === marketplaceId))
      // Compound size attributes are category-specific. Retain their named
      // values rather than guessing a universal size/color mapping.
      if (selected.length === 1) {
        const entries = Object.entries(selected[0]).filter(([k]) => !['marketplace_id', 'language_tag'].includes(k))
        if (entries.length) result[key] = entries.map(([k, v]) => k === 'value' ? String(v) : `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
      }
    }
  }
  return result
}

export async function amazonMediaClient(accountId: string, marketplace: string) {
  const [account, market] = await Promise.all([
    prisma.channelConnection.findUnique({ where: { id: accountId } }),
    prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace, isActive: true } }),
  ])
  if (!account || account.channelType !== 'AMAZON' || !account.isActive || !account.externalAccountId)
    throw new WorkspaceScopeError('The selected Amazon account has no verified seller identity.', 422)
  if (!market?.marketplaceId || !['EU', 'NA', 'FE'].includes(market.region))
    throw new WorkspaceScopeError('The selected market needs its Amazon marketplace ID and region.', 422)
  await assertWritable(accountId)
  const region = market.region.toLowerCase()
  const envSeller = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID
  if (account.managedBy === 'env' && (!account.isPrimary || account.externalAccountId !== envSeller || amazonSpApiClient.region !== region))
    throw new WorkspaceScopeError('The configured Amazon credentials do not belong to this account and region.', 422)
  if (account.managedBy !== 'env' && account.region?.toLowerCase() !== region)
    throw new WorkspaceScopeError('This Amazon connection is not configured for the selected region.', 422)
  const sellerId = account.externalAccountId
  const marketplaceId = market.marketplaceId
  async function request(path: string, query: Record<string, string>, method = 'GET', body?: unknown) {
    const token = account!.managedBy === 'env' ? await amazonSpApiClient.getAccessToken() : await getAccessToken(accountId)
    const url = new URL(`https://sellingpartnerapi-${region}.amazon.com${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    // Never automatically retry PATCH: a dropped response has an unknown outcome.
    const response = await fetch(url, { method, signal: AbortSignal.timeout(25_000), headers: {
      'x-amz-access-token': token, 'Content-Type': 'application/json',
    }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json() as Record<string, any>
    if (!response.ok) throw new Error(`Amazon ${response.status}: ${Array.isArray(data.errors) ? data.errors.map((e: any) => `${e.code}: ${e.message}`).join('; ') : 'Request failed'}`)
    return data
  }
  const listingPath = (sku: string) => `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`
  const schemas = new Map<string, Promise<string[]>>()
  function supportedSlots(productType: string) {
    if (!schemas.has(productType)) schemas.set(productType, (async () => {
      const definition = await request(`/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
        marketplaceIds: marketplaceId, sellerId, requirements: 'LISTING_PRODUCT_ONLY', requirementsEnforced: 'ENFORCED', locale: languageTag('en', 'US'),
      })
      const resource = new URL(definition.schema?.link?.resource)
      if (resource.protocol !== 'https:' || !/(^|\.)amazonaws\.com$/.test(resource.hostname)) throw new Error('Amazon returned an unrecognized schema location.')
      const response = await fetch(resource, { signal: AbortSignal.timeout(25_000), redirect: 'error' })
      if (!response.ok) throw new Error('Amazon product type requirements could not be downloaded.')
      const schema = await response.json() as Record<string, any>
      return amazonImageSlots.filter(slot => {
        const prop = schema.properties?.[slot.attribute]
        return prop && prop.readOnly !== true && prop.editable !== false && prop.items?.readOnly !== true && prop.items?.editable !== false
      }).map(slot => slot.code)
    })())
    return schemas.get(productType)!
  }
  async function observe(item: AmazonMediaItem): Promise<AmazonMediaObservation> {
    if (!item.sku) throw new Error('This listing has no unambiguous seller SKU. Set its Amazon SKU before checking or publishing.')
    const data = await request(listingPath(item.sku), { marketplaceIds: marketplaceId, includedData: 'summaries,attributes,issues,productTypes,relationships' })
    if (data.sku !== item.sku) throw new Error('Amazon returned a different seller SKU.')
    const summary = data.summaries?.find((s: any) => s.marketplaceId === marketplaceId)
    if (!summary?.asin) throw new Error('Amazon did not confirm an ASIN for this SKU in the selected market.')
    if (item.asin && item.asin !== summary.asin) throw new Error('Amazon reports a different ASIN for this seller SKU. Reconcile the listing identity first.')
    const productType = data.productTypes?.find((s: any) => s.marketplaceId === marketplaceId)?.productType ?? summary.productType
    if (typeof productType !== 'string') throw new Error('Amazon did not return this listing’s product type.')
    const attrs = mediaObject(data.attributes)
    const relationships = data.relationships?.find((r: any) => r.marketplaceId === marketplaceId)?.relationships
    const themes = Array.isArray(relationships) ? relationships.filter((r: any) => r.type === 'VARIATION' && r.variationTheme).map((r: any) => r.variationTheme) : []
    const relationshipTheme = themes.length === 1 ? themes[0] : null
    const theme = relationshipTheme?.theme ?? marketValue(attrs.variation_theme, marketplaceId)
    const definedAxes = Array.isArray(relationshipTheme?.attributes) && relationshipTheme.attributes.every((a: unknown) => typeof a === 'string') ? relationshipTheme.attributes : undefined
    const slots = Object.fromEntries(amazonImageSlots.flatMap(slot => {
      const value = marketValue(attrs[slot.attribute], marketplaceId)
      if (attrs[slot.attribute] !== undefined && value === null && Array.isArray(attrs[slot.attribute]) && attrs[slot.attribute].some((v: any) => !v.marketplace_id || v.marketplace_id === marketplaceId))
        throw new Error(`Amazon returned an ambiguous ${slot.code} image contribution. It has not been treated as empty.`)
      return value ? [[slot.code, value]] : []
    }))
    const supported = await supportedSlots(productType)
    let catalog: AmazonMediaObservation['catalog'] = []; let catalogError: string | null = null
    try {
      const response = await request(`/catalog/2022-04-01/items/${encodeURIComponent(summary.asin)}`, { marketplaceIds: marketplaceId, includedData: 'images' })
      const images = response.images?.find((s: any) => s.marketplaceId === marketplaceId)?.images
      if (!Array.isArray(images)) throw new Error('Amazon did not return catalog images for this market.')
      const bySlot = new Map<string, AmazonMediaObservation['catalog'][number]>()
      for (const i of images) if (typeof i.variant === 'string' && typeof i.link === 'string') {
        const prior = bySlot.get(i.variant)
        if (!prior || (i.width ?? 0) * (i.height ?? 0) > prior.width * prior.height) bySlot.set(i.variant, { slot: i.variant, url: i.link, width: i.width ?? 0, height: i.height ?? 0 })
      }
      catalog = [...bySlot.values()]
    } catch (error) { catalogError = error instanceof Error ? error.message : 'Catalog images could not be checked.' }
    return { checkedAt: new Date().toISOString(), error: null, asin: summary.asin, productType, theme,
      attributes: amazonVariationAttributes(attrs, theme, marketplaceId, definedAxes), slots, catalog, catalogError, supported,
      issues: (Array.isArray(data.issues) ? data.issues : []).map((i: any) => ({ code: String(i.code), message: String(i.message), severity: String(i.severity) })) }
  }
  async function patch(sku: string, productType: string, patches: AmazonMediaPatch[], preview: boolean) {
    return request(listingPath(sku), { marketplaceIds: marketplaceId, ...(preview ? { mode: 'VALIDATION_PREVIEW' } : {}) }, 'PATCH', { productType, patches })
  }
  return { observe, patch, marketplaceId, sellerId }
}
