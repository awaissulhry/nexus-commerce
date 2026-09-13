import { categorySchemaMarkets } from './categories/category-schema-coordinate.js'
import { workspaceKey } from '@nexus/database/workspace-context'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { resolveChannelConnectionId } from './connection-resolver.service.js'
import { validateAliasWriteTargets } from './pim/listing-alias.service.js'
import { resolveBatch } from './pim/mapping/resolve-batch.service.js'
import { resolveFamilyAxes } from './ebay-family-axes.service.js'
import { axisSynonymKey } from './ebay-theme-axes.js'
import { mappingToken, MappingConflict } from './pim/mapping/revision-token.js'
import { ORDER_RECEIPT } from './ebay-presentation-consumer.service.js'
import { normalizeMarket } from './ebay-image-axis-preference.service.js'

export interface PresentationDestinationInput { productId: string; marketplace: string; accountId?: string; aliasKey?: string }
export interface PresentationDestination { productId: string; marketplace: string; channelConnectionId: string; aliasKey: string }
const bag = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

export async function presentationDestination(input: PresentationDestinationInput): Promise<PresentationDestination> {
  if (!input || typeof input.productId !== 'string' || !input.productId.trim()) throw new MappingConflict('Choose an explicit product')
  if (typeof input.marketplace !== 'string') throw new MappingConflict('Choose an explicit eBay market')
  if (input.aliasKey !== undefined && typeof input.aliasKey !== 'string') throw new MappingConflict('Choose a valid listing')
  const marketplace = normalizeMarket(input.marketplace)
  if (!marketplace || !['IT', 'DE', 'FR', 'ES', 'UK', 'US', 'AU', 'CA'].includes(marketplace)) throw new MappingConflict('Choose a supported eBay market')
  if (input.accountId !== undefined && (typeof input.accountId !== 'string' || !input.accountId.trim())) throw new MappingConflict('Choose a nonempty account')
  const channelConnectionId = await resolveChannelConnectionId('EBAY', input.accountId)
  if (!channelConnectionId) throw new MappingConflict('Connect an eBay account before customizing presentation')
  let product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) throw new MappingConflict('Product not found')
  const visited = new Set<string>()
  while (product.parentId) {
    if (visited.has(product.id) || visited.size >= 5) throw new MappingConflict('The product family needs repair before editing presentation')
    visited.add(product.id)
    product = await prisma.product.findFirst({ where: { id: product.parentId, deletedAt: null }, select: { id: true, parentId: true } })
    if (!product) throw new MappingConflict('Family parent not found')
  }
  const aliasKey = input.aliasKey ?? ''
  if (typeof aliasKey !== 'string') throw new MappingConflict('Choose a valid listing')
  if (aliasKey) await validateAliasWriteTargets([{ productId: product.id, channel: 'EBAY', marketplace, connectionId: channelConnectionId, aliasKey }])
  return { productId: product.id, marketplace, channelConnectionId, aliasKey }
}

/** Snapshot only this family/destination and rule dependencies. Used for read/save/review/CAS.
 * Membership is bound to the selected root listing's ItemID; another adopted listing is a
 * separate destination, even when it shares every SKU. Shared galleries remain market assets. */
export async function presentationOrderInputs(destination: PresentationDestination, db: Prisma.TransactionClient = prisma) {
  const { productId, marketplace, channelConnectionId, aliasKey } = destination
  const products = await db.product.findMany({ where: { deletedAt: null, OR: [{ id: productId }, { parentId: productId }] }, orderBy: { id: 'asc' } })
  const ids = products.map(p => p.id)
  const listings = await db.channelListing.findMany({ where: { productId: { in: ids }, channel: 'EBAY', marketplace, channelConnectionId, aliasKey }, orderBy: { id: 'asc' } })
  const listing = listings.find(l => l.productId === productId)
  if (!listing) throw new MappingConflict('Create this family’s destination listing before customizing presentation')
  const [memberships, categories, mapping, account, alias, schemas, categoryMappings, closure] = await Promise.all([
    db.sharedListingMembership.findMany({ where: { channelConnectionId, marketplace, itemId: listing.externalListingId ?? '__no_listing__', status: 'ACTIVE' }, orderBy: { id: 'asc' } }),
    db.productCategory.findMany({ where: { productId: { in: ids } }, orderBy: [{ productId: 'asc' }, { categoryId: 'asc' }] }),
    db.marketplace.findUnique({ where: { channel_code: workspaceKey({ channel: 'EBAY', code: marketplace }) }, select: { schemaMapping: true } }),
    db.channelConnection.findUnique({ where: { id: channelConnectionId }, select: { id: true, isActive: true, channelType: true } }),
    aliasKey ? db.productListingAlias.findFirst({ where: { id: aliasKey, productId, channelConnectionId, marketplace, channel: 'EBAY', status: 'ACTIVE' }, select: { id: true, updatedAt: true } }) : null,
    // LX.F2 R-LX-20 — this composed `EBAY_EBAY_IT` for a caller already holding `EBAY_IT` and then
    // matched no row at all; the coordinate authority strips first.
    db.categorySchema.findMany({ where: { channel: 'EBAY', marketplace: { in: categorySchemaMarkets('EBAY', marketplace) } }, orderBy: { id: 'asc' } }),
    db.categoryChannelMapping.findMany({ where: { channel: 'EBAY', marketplace: { in: [marketplace, '*'] } }, orderBy: { id: 'asc' } }),
    db.categoryClosure.findMany({ orderBy: [{ ancestorId: 'asc' }, { descendantId: 'asc' }] }),
  ])
  if (!account?.isActive || account.channelType !== 'EBAY' || (aliasKey && !alias)) throw new MappingConflict('This account or listing is no longer available')
  const members = memberships.length ? await db.product.findMany({ where: { id: { in: memberships.map(m => m.productId).filter((id): id is string => !!id) } }, orderBy: { id: 'asc' } }) : []
  const imageProducts = [...new Set([...ids, ...members.flatMap(m => [m.id, m.parentId].filter((id): id is string => !!id))])]
  const [images, masterImages, themes, valueMaps, sizeScales] = await Promise.all([
    db.listingImage.findMany({ where: { productId: { in: imageProducts }, platform: 'EBAY', mediaType: 'IMAGE', OR: [{ marketplace }, { marketplace: null }] }, orderBy: { id: 'asc' } }),
    db.productImage.findMany({ where: { productId: { in: imageProducts } }, orderBy: { id: 'asc' } }),
    db.ebayDescriptionTheme.findMany({ orderBy: { id: 'asc' } }),
    db.fieldValueMap.findMany({ where: { channel: 'EBAY', marketplace: { in: [marketplace, '*'] } }, orderBy: { id: 'asc' } }),
    db.sizeScaleMap.findMany({ orderBy: { id: 'asc' } }),
  ])
  // Publication receipts are output, never resolution input. Exclude their timestamp too, so
  // a crash after stamping but before checkpointing can safely retry the same reviewed payload.
  const listingInputs = listings.map(({ updatedAt: _at, platformAttributes, ...row }) => {
    const { presentationPush: _stamp, ...attrs } = bag(platformAttributes)
    return { ...row, platformAttributes: attrs }
  })
  const token = mappingToken({ destination, products, listings: listingInputs, memberships, members, categories, mapping, account, alias, schemas, categoryMappings, closure, images, masterImages, themes, valueMaps, sizeScales })
  return { destination, listing, products, memberships, token }
}

export async function readPresentationOrder(input: PresentationDestinationInput) {
  const destination = await presentationDestination(input)
  const before = await presentationOrderInputs(destination)
  const mapped = await resolveBatch({ channel: 'EBAY', marketplace: destination.marketplace, productIds: [destination.productId], channelConnectionId: destination.channelConnectionId, aliasKey: destination.aliasKey, includePresentation: true, fieldKeys: ['descriptionThemeId'], includeCatalogue: false })
  const order = mapped.products[0]?.presentationOrder
  const axes = await resolveFamilyAxes(destination.productId, destination.marketplace, destination)
  const after = await presentationOrderInputs(destination)
  if (after.token !== before.token) throw new MappingConflict('Presentation inputs changed while loading. Reload the current destination')
  return { ...destination, accountId: destination.channelConnectionId, listingId: before.listing.id, externalListingId: before.listing.externalListingId,
    version: before.listing.version, token: before.token, axes: axes.axes, warnings: axes.warnings,
    conflicts: order?.conflicts ?? [], source: order?.rule ? { id: order.rule.id, name: order.rule.name, version: order.rule.version } : null,
    explicitAxes: order?.explicitAxes ?? false, explicitValues: order?.explicitValues ?? [],
    family: before.products.map(p => ({ id: p.id, sku: p.sku })), membershipCount: before.memberships.length,
    publication: 'separate' as const }
}

export interface PresentationOrderChange { axes?: string[] | null; values?: Record<string, string[] | null>; reset?: boolean }
export function changePresentationOrder(attrs: unknown, change: PresentationOrderChange, axes: Array<{ name: string; key: string; values: string[] }>) {
  if (!change || typeof change !== 'object' || Array.isArray(change) || !Object.keys(change).length || Object.keys(change).some(k => !['axes', 'values', 'reset'].includes(k)) || (change.reset !== undefined && typeof change.reset !== 'boolean')) throw new MappingConflict('Choose an order change or reset')
  const next = { ...bag(attrs) }
  if (change.reset) { delete next._variationAxes; delete next._axisValueOrder; delete next._axisSortOrder; return next }
  const dimensions = new Set(axes.map(a => a.key))
  if (change.axes !== undefined) {
    if (change.axes === null) delete next._variationAxes
    else {
      if (!Array.isArray(change.axes) || change.axes.some(a => typeof a !== 'string') || change.axes.length !== dimensions.size || new Set(change.axes.map(axisSynonymKey)).size !== dimensions.size || change.axes.some(a => !dimensions.has(axisSynonymKey(a)))) throw new MappingConflict('Reorder the existing axes without adding or removing dimensions')
      next._variationAxes = change.axes
    }
  }
  if (change.values !== undefined) {
    if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values)) throw new MappingConflict('Choose value orders by axis')
    const values = { ...bag(next._axisValueOrder) }, legacy = { ...bag(next._axisSortOrder) }
    const seen = new Set<string>()
    for (const [name, order] of Object.entries(change.values)) {
      const key = axisSynonymKey(name), axis = axes.find(a => a.key === key)
      if (!axis || seen.has(key)) throw new MappingConflict('Choose each existing axis once')
      seen.add(key)
      if (order !== null && (!Array.isArray(order) || order.some(v => typeof v !== 'string') || order.length !== axis.values.length || new Set(order).size !== axis.values.length || order.some(v => !axis.values.includes(v)))) throw new MappingConflict('Reorder the existing buyer-facing values without adding or removing values')
      for (const source of [values, legacy]) for (const stored of Object.keys(source)) if (axisSynonymKey(stored) === key) delete source[stored]
      if (order !== null) values[key] = order
    }
    if (Object.keys(values).length) next._axisValueOrder = values; else delete next._axisValueOrder
    if (Object.keys(legacy).length) next._axisSortOrder = legacy; else delete next._axisSortOrder
  }
  return next
}

export type PresentationOrderSave = PresentationDestinationInput & { expectedVersion: number; expectedToken: string; change: PresentationOrderChange }

export async function preparePresentationOrder(input: PresentationOrderSave) {
  if (typeof input.accountId !== 'string' || !input.accountId.trim()) throw new MappingConflict('Save to the account observed when loading this destination')
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.expectedToken !== 'string' || !input.expectedToken) throw new MappingConflict('Reload the current destination before saving')
  const view = await readPresentationOrder(input)
  if (view.token !== input.expectedToken || view.version !== input.expectedVersion) throw new MappingConflict('This listing, rule or family changed. Reload before saving the order')
  return view
}

/** Shared guarded writer. Mapping composes names and order in this transaction; no second order writer. */
export async function writePresentationOrderInTransaction(tx: Prisma.TransactionClient, input: PresentationOrderSave,
  view: Awaited<ReturnType<typeof readPresentationOrder>>, userId: string | null, axisNameLabels?: Record<string, string>, variationAxes?: string[]) {
  const destination: PresentationDestination = { productId: view.productId, marketplace: view.marketplace, channelConnectionId: view.channelConnectionId, aliasKey: view.aliasKey }
    const current = await presentationOrderInputs(destination, tx)
    if (current.token !== input.expectedToken || current.listing.version !== input.expectedVersion) throw new MappingConflict('The reviewed destination changed before saving')
    const attrs = changePresentationOrder(current.listing.platformAttributes, input.change, view.axes)
    if (axisNameLabels) attrs._axisNameLabels = axisNameLabels
    if (variationAxes) { attrs._variationAxes = variationAxes; attrs._variationAxesMode = 'override' }
    attrs[ORDER_RECEIPT] = { version: input.expectedVersion + 1, savedAt: new Date().toISOString(), publication: 'separate' }
    const saved = await tx.channelListing.updateMany({ where: { id: current.listing.id, version: input.expectedVersion, platformAttributes: { equals: current.listing.platformAttributes ?? Prisma.DbNull } }, data: { platformAttributes: attrs as Prisma.InputJsonValue, version: { increment: 1 } } })
    if (saved.count !== 1) throw new MappingConflict('Another change won this listing. Reload before saving')
    await tx.bulkOperation.create({ data: { userId, status: 'COMPLETED', productCount: 1, changeCount: 1, total: 1, processed: 1, completedAt: new Date(), changes: JSON.parse(JSON.stringify({ kind: 'presentation-order-save-v1', destination, listingId: current.listing.id, expectedVersion: input.expectedVersion, expectedToken: input.expectedToken, before: current.listing.platformAttributes, after: attrs })) } })
}

export async function savePresentationOrder(input: PresentationOrderSave, userId: string | null) {
  const view = await preparePresentationOrder(input)
  await prisma.$transaction(tx => writePresentationOrderInTransaction(tx, input, view, userId), { isolationLevel: 'Serializable', timeout: 30_000 })
  return readPresentationOrder(input)
}
