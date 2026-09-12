import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { amazonImageSlots, amazonSafetyImageSlots, amazonManagedImageSlots, amazonSlotsForSection, amazonMediaDraftSchema, effectiveImageSlots, inspectAmazonImages,
  type AmazonMediaWorkspace, type AmazonMediaAsset, type AmazonMediaObservation, type AmazonMediaDraft } from '@nexus/shared/amazon-media'
import prisma from '../../db.js'
import { resolveWorkspaceDestination, WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { amazonMediaClient, amazonVariationAttributes, marketValue, mediaObject } from './amazon-media-client.js'

export const AMAZON_MEDIA_KEY = '_amazonMediaWorkspace'
export const mediaHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const storedSchema = z.object({ version: z.literal(1), draft: amazonMediaDraftSchema, assets: z.array(z.object({
  id: z.string(), url: z.string(), label: z.string(), width: z.number().nullable(), height: z.number().nullable(), origin: z.enum(['product', 'saved-gallery']),
})) })
export type AmazonMediaInput = { productId: string; market?: string; accountId?: string; listingId?: string }
export async function listAmazonMediaDestinations(input: AmazonMediaInput) {
  const destination = await resolveWorkspaceDestination({ productId: input.productId, accountId: input.accountId, channel: 'AMAZON', marketplace: input.market ?? '' })
  const coordinate = { channel: 'AMAZON', marketplace: destination.marketplace, channelConnectionId: destination.accountId }
  const [aliases, listings] = await Promise.all([
    prisma.productListingAlias.findMany({ where: { ...coordinate, productId: destination.familyId, status: 'ACTIVE' }, select: { id: true, label: true } }),
    prisma.channelListing.findMany({ where: { ...coordinate, productId: input.productId }, select: { id: true, aliasKey: true } }),
  ])
  return { listings: listings.filter(l => !l.aliasKey || aliases.some(a => a.id === l.aliasKey)).map(l => ({ id: l.id, label: l.aliasKey ? aliases.find(a => a.id === l.aliasKey)!.label : 'Primary listing' })) }
}
export async function amazonMediaDestination(input: AmazonMediaInput) {
  let destination = await resolveWorkspaceDestination({ ...input, channel: 'AMAZON', marketplace: input.market ?? '' })
  if (!destination.listing) {
    const rows = await prisma.channelListing.findMany({ where: { productId: input.productId, channel: 'AMAZON', marketplace: destination.marketplace,
      channelConnectionId: destination.accountId, aliasKey: '' }, select: { id: true }, take: 2 })
    if (rows.length !== 1) throw new WorkspaceScopeError('Choose an attributed Amazon listing to open its market gallery.', 422)
    destination = await resolveWorkspaceDestination({ productId: input.productId, channel: 'AMAZON', marketplace: destination.marketplace,
      accountId: destination.accountId, listingId: rows[0].id })
  }
  if (destination.listing!.productId !== input.productId) throw new WorkspaceScopeError('Open Images on the selected listing’s product.')
  return destination
}

export async function readAmazonMedia(destination: WorkspaceDestination, tx: Prisma.TransactionClient = prisma): Promise<AmazonMediaWorkspace> {
  const productId = destination.productId
  const coordinate = { channel: 'AMAZON', marketplace: destination.marketplace, channelConnectionId: destination.accountId }
  const aliasKey = destination.aliasKey ?? ''
  const [root, market, aliases, familyListings, masters, markets] = await Promise.all([
    tx.channelListing.findFirst({ where: { ...coordinate, id: destination.listing!.id, productId, aliasKey }, include: { product: true } }),
    tx.marketplace.findFirst({ where: { channel: 'AMAZON', code: destination.marketplace, isActive: true } }),
    tx.productListingAlias.findMany({ where: { ...coordinate, productId: destination.familyId, status: 'ACTIVE' }, orderBy: { position: 'asc' }, select: { id: true, label: true } }),
    tx.channelListing.findMany({ where: { ...coordinate, OR: [{ productId }, { product: { parentId: productId, deletedAt: null } }] }, include: { product: true }, orderBy: { id: 'asc' } }),
    tx.productImage.findMany({ where: { mediaType: 'IMAGE', OR: [{ productId }, { product: { parentId: productId, deletedAt: null } }] }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    tx.marketplace.findMany({ where: { channel: 'AMAZON', isActive: true }, orderBy: { code: 'asc' }, select: { code: true, name: true } }),
  ])
  if (!root || root.product.deletedAt || !market) throw new WorkspaceScopeError('This listing destination is no longer available.')
  if (aliasKey && !aliases.some(a => a.id === aliasKey)) throw new WorkspaceScopeError('This listing alias is no longer active.')
  const rows = familyListings.filter(l => l.aliasKey === aliasKey && !l.product.deletedAt)
  const pa = mediaObject(root.platformAttributes)
  const parsed = pa[AMAZON_MEDIA_KEY] === undefined ? null : storedSchema.safeParse(pa[AMAZON_MEDIA_KEY])
  if (parsed && !parsed.success) throw new WorkspaceScopeError('This listing’s saved media could not be read. It has been preserved; editing is unavailable.', 422)
  const assets: AmazonMediaAsset[] = []
  const assetIds = new Map<string, string>()
  const add = (asset: AmazonMediaAsset) => {
    const found = assets.find(a => a.id === asset.id || a.url === asset.url)
    const id = found?.id ?? asset.id
    assetIds.set(asset.id, id)
    if (!found) assets.push(asset)
    return id
  }
  for (const m of masters) add({ id: `product:${m.id}`, url: m.url, label: m.alt || `Product image ${m.sortOrder + 1}`, width: m.width, height: m.height, origin: 'product' })
  for (const asset of parsed?.success ? parsed.data.assets : []) add({ ...asset, width: asset.width ?? null, height: asset.height ?? null, origin: 'saved-gallery' })
  const draft: AmazonMediaDraft = parsed?.success ? parsed.data.draft : { common: {}, items: {} }
  for (const slots of [draft.common, ...Object.values(draft.items)]) for (const assignment of Object.values(slots)) if (assignment) assignment.assetId = assetIds.get(assignment.assetId) ?? assignment.assetId
  const warnings: string[] = []
  const items = rows.map(row => {
    const attrs = mediaObject(row.platformAttributes); const values = mediaObject(attrs.attributes)
    const skuValues = [attrs.sellerSku, attrs.seller_sku, attrs.sku, attrs.item_sku, mediaObject(row.flatFileSnapshot).item_sku].filter((v): v is string => typeof v === 'string' && !!v.trim())
    const skus = [...new Set(skuValues)]
    const sku = skus.length === 1 ? skus[0] : skus.length === 0 && !aliasKey ? row.product.sku : ''
    const theme = row.variationTheme ?? marketValue(values.variation_theme, market!.marketplaceId!)
    const attributes = amazonVariationAttributes(values, theme, market!.marketplaceId!)
    const local = mediaObject(row.product.variantAttributes)
    for (const axis of (theme ?? '').split('/').filter(Boolean)) if (typeof local[axis.toLowerCase()] === 'string' && !attributes[axis.toLowerCase()]) attributes[axis.toLowerCase()] = local[axis.toLowerCase()]
    if (!parsed) {
      const slots: AmazonMediaDraft['common'] = {}
      for (const slot of amazonImageSlots) {
        const url = marketValue(values[slot.attribute] ?? attrs[slot.attribute], market!.marketplaceId!)
        if (url) slots[slot.code] = { assetId: add({ id: `saved:${mediaHash(url)}`, url, label: `${sku || row.id} · ${slot.label}`, width: null, height: null, origin: 'saved-gallery' }), language: 'und' }
      }
      if (Object.keys(slots).length) draft.items[row.id] = slots
    }
    if (!sku) warnings.push(`${row.product.sku}: the alias needs an unambiguous Amazon seller SKU before publication.`)
    return { id: row.id, productId: row.productId, sku, asin: row.externalListingId || row.platformProductId,
      label: row.product.name || row.product.sku, parent: row.product.isParent,
      productType: typeof attrs.productType === 'string' ? attrs.productType : row.product.productType, theme, attributes }
  })
  const observations = mediaObject(pa._amazonMediaObservations) as Record<string, AmazonMediaObservation>
  for (const [id, observation] of Object.entries(observations)) if (rows.some(row => row.id === id) && !observation.error) {
    for (const [code, url] of Object.entries(observation.slots)) add({ id: `saved:${mediaHash(url)}`, url,
      label: `${items.find(i => i.id === id)?.sku || 'Amazon'} · ${code}`, width: null, height: null, origin: 'saved-gallery' })
  }
  const label = aliasKey ? aliases.find(a => a.id === aliasKey)!.label : 'Primary listing'
  // Every relevant listing and source participates in CAS. Remote checks do not
  // change the draft fingerprint, but refreshing context invalidates old reviews.
  const revision = mediaHash([rows.map(r => {
    const { _amazonMediaObservations: _observations, ...attributes } = mediaObject(r.platformAttributes)
    return [r.id, r.version, r.externalListingId, r.platformProductId, attributes, r.variationTheme, r.flatFileSnapshot, r.product.sku, r.product.variantAttributes]
  }), assets, market.language, aliasKey, Object.entries(observations).map(([id, o]) => [id, o.error, o.theme, o.attributes, o.productType, o.supported])])
  return { productId, revision, draft, assets, items, warnings, observations, markets: markets.map(m => ({ code: m.code, label: m.name })), activeRunId: typeof pa._amazonMediaActiveRun === 'string' ? pa._amazonMediaActiveRun : null,
    languages: [...new Set([market.language.toLowerCase().split(/[-_]/)[0], ...(destination.marketplace === 'CA' ? ['en', 'fr'] : destination.marketplace === 'BE' ? ['fr', 'nl', 'de'] : [])])],
    destination: { accountId: destination.accountId, marketplace: destination.marketplace, listingId: root.id, aliasKey, label,
      listings: familyListings.filter(l => l.productId === productId && (!l.aliasKey || aliases.some(a => a.id === l.aliasKey))).map(l => ({ id: l.id, label: l.aliasKey ? aliases.find(a => a.id === l.aliasKey)!.label : 'Primary listing' })) } }
}

export async function mutateAmazonMedia(destination: WorkspaceDestination, revision: string, apply: (current: AmazonMediaWorkspace, attributes: Record<string, any>, tx: Prisma.TransactionClient) => Promise<Record<string, unknown>>, observationOnly = false) {
  try {
    return await prisma.$transaction(async tx => {
      const current = await readAmazonMedia(destination, tx)
      if (current.revision !== revision) throw new WorkspaceScopeError('The saved gallery or listing context changed. Reload and review before continuing.')
      const row = await tx.channelListing.findUniqueOrThrow({ where: { id: current.destination.listingId } })
      const next = await apply(current, mediaObject(row.platformAttributes), tx)
      const result = await tx.channelListing.updateMany({ where: { id: row.id, version: row.version, channelConnectionId: destination.accountId, marketplace: destination.marketplace },
        data: { platformAttributes: next as Prisma.InputJsonValue, version: { increment: observationOnly ? 0 : 1 } } })
      if (result.count !== 1) throw new WorkspaceScopeError('Another request changed this listing. Reload before continuing.')
      return readAmazonMedia(destination, tx)
    }, { isolationLevel: 'Serializable', timeout: 20_000 })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034') throw new WorkspaceScopeError('Another request changed this listing. Reload before continuing.')
    throw error
  }
}

export async function saveAmazonMedia(destination: WorkspaceDestination, revision: string, input: unknown) {
  const parsed = amazonMediaDraftSchema.safeParse(input)
  if (!parsed.success) throw new WorkspaceScopeError('A valid Amazon gallery draft is required.', 400)
  return mutateAmazonMedia(destination, revision, async (current, pa, tx) => {
    await assertNoActiveMediaRun(current, tx)
    const draft = parsed.data
    if (Object.keys(draft.items).some(id => !current.items.some(i => i.id === id))) throw new WorkspaceScopeError('An image override belongs to another listing destination.', 422)
    for (const slots of [draft.common, ...Object.values(draft.items)]) for (const [code, assignment] of Object.entries(slots)) {
      if (!amazonManagedImageSlots.some(s => s.code === code) || (assignment && !current.assets.some(a => a.id === assignment.assetId))) throw new WorkspaceScopeError('An image or slot is unavailable in this product’s source library.', 422)
      if (assignment && !['und', 'zxx', ...current.languages].includes(assignment.language)) throw new WorkspaceScopeError('Choose an image language supported by this market.', 422)
    }
    const used = new Set([draft.common, ...Object.values(draft.items)].flatMap(s => Object.values(s).flatMap(a => a ? [a.assetId] : [])))
    return { ...pa, [AMAZON_MEDIA_KEY]: { version: 1, draft, assets: current.assets.filter(a => used.has(a.id)) } }
  })
}
export async function assertNoActiveMediaRun(current: AmazonMediaWorkspace, tx: Prisma.TransactionClient = prisma) {
  if (!current.activeRunId) return
  const run = await tx.amazonMediaRun.findUnique({ where: { id: current.activeRunId }, select: { status: true } })
  if (run && ['QUEUED', 'READY', 'SUBMITTING'].includes(run.status)) throw new WorkspaceScopeError('An Amazon image submission is running. Wait for its receipt before editing or publishing again.')
}
export async function refreshAmazonMedia(destination: WorkspaceDestination, revision: string) {
  const current = await readAmazonMedia(destination)
  if (current.revision !== revision) throw new WorkspaceScopeError('Reload the saved gallery before checking Amazon.')
  await assertNoActiveMediaRun(current)
  const client = await amazonMediaClient(destination.accountId, destination.marketplace)
  const observations: Record<string, AmazonMediaObservation> = {}
  for (const item of current.items) {
    try { observations[item.id] = await client.observe(item) }
    catch (error) { observations[item.id] = { checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Amazon could not be checked.',
      asin: null, productType: null, theme: null, attributes: {}, slots: {}, catalog: [], catalogError: 'Not checked', supported: [], issues: [] } }
  }
  return mutateAmazonMedia(destination, revision, async (_current, pa) => ({ ...pa, _amazonMediaObservations: observations }), true)
}
export function desiredAmazonImages(workspace: AmazonMediaWorkspace, listingId: string) {
  const effective = effectiveImageSlots(workspace.draft, listingId)
  const slots = Object.fromEntries(Object.entries(effective).filter(([code]) => !amazonSafetyImageSlots.some(slot => slot.code === code)))
  const problems = inspectAmazonImages(slots, workspace.assets, workspace.languages)
  const desired = Object.fromEntries(Object.entries(slots).flatMap(([slot, value]) => {
    const asset = value && workspace.assets.find(a => a.id === value.assetId)
    return asset ? [[slot, asset.url]] : []
  }))
  return { desired, problems }
}

export async function copyAmazonMarketGallery(destination: WorkspaceDestination, revision: string, input: {
  sourceMarket: string; sourceListingId: string; sourceGalleryId: string; sourceRevision: string; targetGalleryId: string; section?: 'gallery' | 'safety' | 'all'
}) {
  const sourceDestination = await amazonMediaDestination({ productId: destination.productId, accountId: destination.accountId, market: input.sourceMarket, listingId: input.sourceListingId })
  if (sourceDestination.marketplace === destination.marketplace) throw new WorkspaceScopeError('Choose a different source market.', 400)
  return mutateAmazonMedia(destination, revision, async (current, pa, tx) => {
    await assertNoActiveMediaRun(current, tx)
    const source = await readAmazonMedia(sourceDestination, tx)
    if (source.revision !== input.sourceRevision) throw new WorkspaceScopeError('The source market gallery changed. Reload the copy preview.')
    if (input.sourceGalleryId !== 'common' && !source.items.some(i => i.id === input.sourceGalleryId)) throw new WorkspaceScopeError('Choose a gallery in the source listing.', 422)
    if (input.targetGalleryId !== 'common' && !current.items.some(i => i.id === input.targetGalleryId)) throw new WorkspaceScopeError('Choose a gallery in the destination listing.', 422)
    const slots = input.sourceGalleryId === 'common' ? source.draft.common : effectiveImageSlots(source.draft, input.sourceGalleryId)
    const copied = { ...(input.targetGalleryId === 'common' ? current.draft.common : current.draft.items[input.targetGalleryId] ?? {}) }
    const assets = [...current.assets]
    for (const slot of !input.section || input.section === 'all' ? amazonManagedImageSlots : amazonSlotsForSection(input.section)) {
      const assignment = slots[slot.code]
      const asset = assignment && source.assets.find(a => a.id === assignment.assetId)
      if (assignment && !asset) throw new WorkspaceScopeError('An image in the source gallery is unavailable.', 422)
      if (!asset || !assignment) { copied[slot.code] = null; continue }
      const id = `saved:${mediaHash(asset.url)}`
      if (!assets.some(a => a.id === id)) assets.push({ ...asset, id, origin: 'saved-gallery' })
      copied[slot.code] = { assetId: id, language: assignment.language === 'zxx' ? 'zxx' : 'und' }
    }
    const draft = input.targetGalleryId === 'common' ? { ...current.draft, common: copied }
      : { ...current.draft, items: { ...current.draft.items, [input.targetGalleryId]: copied } }
    const used = new Set([draft.common, ...Object.values(draft.items)].flatMap(s => Object.values(s).flatMap(a => a ? [a.assetId] : [])))
    return { ...pa, [AMAZON_MEDIA_KEY]: { version: 1, draft, assets: assets.filter(a => used.has(a.id)) } }
  })
}
