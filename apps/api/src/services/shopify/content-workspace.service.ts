import { hasVariationMappingOverride } from '@nexus/shared/variation-mapping'
import { resolveVariationCategory } from '../pim/variation-theme-facts.js'
import { storedVariationValues } from '../pim/stored-variation-projection.js'
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'
import { getVariationRule, parseMappingWithWarnings } from '../pim/schema-mapping.service.js'
import { resolveVariationProjection } from '../pim/variation-rules.service.js'
import { limitsFor, vocabularyFor } from '../pim/family-projection-limits.js'
import { parseVariationMapping, variationMappingOrder } from '@nexus/shared/variation-mapping'
import { marketLanguages } from '../pim/market-languages.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { emptyShopifyContent, shopifyContentSchema, inspectShopifyContent, resolveShopifyContent, type ShopifyContent, type ContentVariant } from '@nexus/shared/shopify-content'
import { resolveWorkspaceDestination, WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { nativeListingValue } from './native-listing-value.js'
import { readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { applyListingMediaContent } from './listing-media-content.js'
import { listingSheetValues } from './listing-sheet-values.js'

/** Stable family keys in the explicitly selected order; omissions remain omitted. */
export function shopifyAxisOrder(familyAxes: string[], variationMapping: unknown): string[] {
  if (!hasVariationMappingOverride(variationMapping)) return familyAxes
  return parseVariationMapping(variationMapping).entries.flatMap(entry => {
    const key = familyAxes.find(key => canonicalVariantAxis(key) === canonicalVariantAxis(entry.axisKey))
    return key ? [key] : []
  })
}

export function applyShopifyVariationProjection(draft: ShopifyContent, projection: ReturnType<typeof resolveVariationProjection>): ShopifyContent {
  const included = projection.axes.filter(a => a.included)
  return { ...draft, axes: included.map(a => a.familyKey), optionNames: Object.fromEntries(included.map(a => [a.familyKey, a.channelName])) }
}

export const CONTENT_KEY = '_nexusContent'
export const PUBLISH_KEY = '_nexusContentPublish'
export const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
export type ContentScope = { accountId?: string; listingId?: string; market?: string }

export async function contentDestination(productId: string, scope: ContentScope) {
  const destination = await resolveWorkspaceDestination({ productId, accountId: scope.accountId, listingId: scope.listingId, channel: 'SHOPIFY', marketplace: scope.market ?? 'GLOBAL' })
  // Child editor routes deliberately resolve to one family document.
  return destination
}

export async function readContent(tx: Prisma.TransactionClient, destination: WorkspaceDestination, storeLocales?: ShopifyStoreSchema['locales'], storeSchema?: ShopifyStoreSchema) {
  const family = await tx.product.findFirst({ where: { id: destination.familyId, deletedAt: null }, select: {
    id: true, sku: true, name: true, description: true, brand: true, productType: true, basePrice: true, totalStock: true, variationAxes: true,
    parentId: true, isParent: true, isMaster: true, updatedAt: true, categoryAttributes: true,
    children: { where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, sku: true, basePrice: true, totalStock: true, variantAttributes: true, categoryAttributes: true, updatedAt: true } },
    images: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, url: true, alt: true, mediaType: true } },
  } })
  if (!family || family.parentId) throw new WorkspaceScopeError('The product family is unavailable or nested. Resolve the family hierarchy first.', 422)
  const market = await tx.marketplace.findFirst({ where: { channel: 'SHOPIFY', code: destination.marketplace }, select: { channel: true, code: true, language: true, languages: true, schemaMapping: true } })
  const languages = marketLanguages('SHOPIFY', destination.marketplace, market ? [market] : [])
  const loadedListings = await tx.channelListing.findMany({ include: { translations: true, product: { include: { translations: true, parent: { include: { translations: true } } } } }, where: { productId: { in: [family.id, ...family.children.map(c => c.id)] }, channel: 'SHOPIFY', marketplace: destination.marketplace, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' } })
  const storedListings = loadedListings.map(listing => ({ ...listing, languages }))
  const listings = storeSchema ? listingSheetValues(storedListings, family.id, destination.accountId, storeSchema) : storedListings
  const listing = listings.find(l => l.productId === family.id) ?? null
  if (destination.listing?.productId === family.id && destination.listing.id !== listing?.id) throw new WorkspaceScopeError('This listing changed destination. Reload it.')
  const pa = object(listing?.platformAttributes)
  let draft: ShopifyContent
  if (pa[CONTENT_KEY] !== undefined) {
    const parsed = shopifyContentSchema.safeParse(pa[CONTENT_KEY])
    if (!parsed.success) throw new WorkspaceScopeError('The saved Shopify content document cannot be read. It has been preserved.', 422)
    draft = parsed.data
  } else {
    draft = emptyShopifyContent(shopifyAxisOrder(family.variationAxes, listing?.variationMapping))
    if (storeLocales) { draft.defaultLocale = storeLocales.find(l => l.primary)?.locale ?? draft.defaultLocale; draft.locales = storeLocales.filter(l => l.primary || l.published).map(l => l.locale) }
    draft.assets = family.images.filter(i => i.mediaType === 'IMAGE' && i.url.startsWith('https://')).map(i => ({ id: i.id, url: i.url, alt: i.alt ?? '', translations: {} }))
    draft.groups = [{ id: 'family-gallery', name: 'Family gallery', assetIds: draft.assets.map(a => a.id), featuredId: draft.assets[0]?.id ?? null }]
    draft.assignments[0].gallery = { mode: 'replace', groupIds: ['family-gallery'], featuredId: null }
  }
  const category = await resolveVariationCategory('SHOPIFY', destination.marketplace, family.id, listing ? { ...listing, platformAttributes: pa } : null)
  const storedRule = getVariationRule(parseMappingWithWarnings(market?.schemaMapping).mapping, category)
  const projection = resolveVariationProjection({ coordinate: { channel: 'SHOPIFY', market: destination.marketplace, accountId: destination.accountId, aliasKey: destination.aliasKey ?? '', label: 'Shopify' },
    family: { familyAxes: family.variationAxes, axisLabels: {}, productVersion: 0, productTheme: null, childIds: family.children.map(c => c.id) },
    listing: listing ? { ...listing, platformAttributes: pa } : null,
    rule: storedRule ? { label: storedRule.rule.label ?? 'Channel variations', category: storedRule.scope === 'category' ? category : null, mapping: storedRule.rule.axes } : null,
    schema: {}, limits: limitsFor('SHOPIFY'), vocabulary: vocabularyFor('SHOPIFY') })
  draft = applyShopifyVariationProjection(draft, projection)
  const publish = object(pa[PUBLISH_KEY])
  const mediaFiles = await tx.productImage.findMany({ where: { productId: { in: [family.id, ...family.children.map(c => c.id)] } }, select: { id: true, productId: true, url: true, mediaType: true, alt: true, updatedAt: true } })
  draft = applyListingMediaContent(draft, family.id, listings, mediaFiles)
  const products = family.children.length ? family.children : [family]
  const variants: ContentVariant[] = products.map(p => {
    const offer = listings.find(l => l.productId === p.id)
    const price = offer && !offer.followMasterPrice ? offer.priceOverride ?? offer.price ?? p.basePrice : p.basePrice
    const stock = offer && !offer.followMasterQuantity ? offer.quantityOverride ?? offer.quantity ?? p.totalStock : p.totalStock
    const compareAtPrice = nativeListingValue(offer, 'compareAtPrice')
    return { id: p.id, sku: String(nativeListingValue(offer, 'sku', p.sku) ?? ''), options: { ...object('variantAttributes' in p ? p.variantAttributes : {}), ...storedVariationValues({ categoryAttributes: p.categoryAttributes, variantAttributes: 'variantAttributes' in p ? p.variantAttributes : {} }, family.variationAxes) }, price: String(price), ...(compareAtPrice !== undefined ? { compareAtPrice: compareAtPrice === null ? null : String(compareAtPrice) } : {}), stock: Math.max(0, stock - (offer?.stockBuffer ?? 0)), shopifyVariantId: publish.variantIds?.[p.id] ?? null }
  })
  const revision = digest([family, market?.schemaMapping, mediaFiles, listings.map(l => [l.id, l.version, l.platformAttributes, l.priceOverride, l.quantityOverride, l.price, l.quantity, l.followMasterPrice, l.followMasterQuantity, l.stockBuffer])])
  const errors = inspectShopifyContent(draft, variants)
  if (!family.children.length && (family.isParent || family.isMaster)) errors.push('This family has no sellable child products. Add its variants before publishing.')
  return { family, listing, listings, variants, draft, revision, storedDocumentRevision: digest(pa[CONTENT_KEY]), publish, errors, destination }
}

export function publicContent(data: Awaited<ReturnType<typeof readContent>>) {
  const { family, variants, draft, revision, publish, errors, destination, listing } = data
  return { productId: family.id, name: family.name, sku: family.sku, variants, draft, revision, errors, initialized: object(listing?.platformAttributes)[CONTENT_KEY] !== undefined,
    sourceAssets: family.images.filter(i => i.mediaType === 'IMAGE').map(i => ({ id: i.id, url: i.url, alt: i.alt ?? '', translations: {} })),
    preview: variants.map(v => ({ variantId: v.id, ...resolveShopifyContent(draft, v) })),
    destination: { accountId: destination.accountId, listingId: listing?.id ?? null, market: destination.marketplace },
    publication: { status: publish.status ?? 'NOT_PUBLISHED', productId: publish.productId ?? (draft.target === 'linked-product' ? listing?.externalListingId : null) ?? null, lastVerifiedAt: publish.lastVerifiedAt ?? null, error: publish.error ?? null, contentHash: publish.contentHash ?? null },
  }
}

export async function getContentWorkspace(productId: string, scope: ContentScope) {
  const destination = await contentDestination(productId, scope)
  const schema = await readShopifyMappingSchema(destination.accountId)
  return prisma.$transaction(async tx => publicContent(await readContent(tx, destination, schema.locales, schema)), { isolationLevel: 'RepeatableRead' })
}

export async function saveContentWorkspace(productId: string, scope: ContentScope, input: unknown) {
  const { draft: raw, expectedRevision } = object(input)
  const parsed = shopifyContentSchema.safeParse(raw)
  if (!parsed.success || typeof expectedRevision !== 'string') throw new WorkspaceScopeError(parsed.success ? 'The observed revision is required.' : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 400)
  const destination = await contentDestination(productId, scope)
  const schema = await readShopifyMappingSchema(destination.accountId)
  try {
    return await prisma.$transaction(async tx => {
      const current = await readContent(tx, destination, schema.locales, schema)
      if (current.revision !== expectedRevision) throw new WorkspaceScopeError('The family, variants or listing changed. Your edits are preserved; reload before saving.')
      if (current.publish.status === 'PUBLISHING' && Date.now() - Date.parse(current.publish.lastCheckpointAt ?? current.publish.startedAt) < 20 * 60_000) throw new WorkspaceScopeError('Shopify synchronisation is in progress. Wait for its result before saving.')
      if (JSON.stringify(parsed.data.axes) !== JSON.stringify(current.draft.axes) || JSON.stringify(parsed.data.optionNames ?? {}) !== JSON.stringify(current.draft.optionNames ?? {})) throw new WorkspaceScopeError('Option names and order are managed in Information → Variation Theme. Reload this content document after changing them.', 422)
      // Drafts may contain unresolved assignments; publishing is blocked until every conflict is resolved.
      const platformAttributes = { ...object(current.listing?.platformAttributes), [CONTENT_KEY]: parsed.data } as Prisma.InputJsonValue
      if (current.listing) {
        const saved = await tx.channelListing.updateMany({ where: { id: current.listing.id, version: current.listing.version }, data: { platformAttributes, version: { increment: 1 } } })
        if (saved.count !== 1) throw new WorkspaceScopeError('Another save overlapped this one. Reload before retrying.')
      } else {
        await tx.channelListing.create({ data: { productId: current.family.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', marketplace: destination.marketplace, region: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', aliasId: destination.aliasKey, platformAttributes, isPublished: false } })
      }
      return publicContent(await readContent(tx, destination, schema.locales, schema))
    }, { isolationLevel: 'Serializable', timeout: 20_000 })
  } catch (error) {
    if (['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')) throw new WorkspaceScopeError('Another save overlapped this one. Reload before retrying.')
    throw error
  }
}
