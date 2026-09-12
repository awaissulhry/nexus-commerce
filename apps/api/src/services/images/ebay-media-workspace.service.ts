import { resolveFamilyAxes } from '../ebay-family-axes.service.js'
import { englishEbayAspectLabel } from '../ebay-aspect-names.js'
import { loadEbaySpec } from '../pim/channel-specs/index.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { ebayMediaDraftSchema, galleryKey, inspectMediaDraft, type EbayMediaAsset, type EbayMediaDraft, type EbayMediaAxis } from '@nexus/shared/ebay-media'
import prisma from '../../db.js'
import { axisSynonymKey } from '../ebay-theme-axes.js'
import { resolveWorkspaceDestination, WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'

/** A draft only. Existing publishers must not interpret it as live image evidence. */
export const EBAY_MEDIA_DRAFT_KEY = '_mediaGalleryDraft'
const storedSchema = z.object({ version: z.literal(1), axis: z.string().nullable(), galleries: z.array(z.object({
  axis: z.string().nullable(), value: z.string().nullable(), images: z.array(z.object({
    url: z.string(), label: z.string(), width: z.number().nullable(), height: z.number().nullable(),
  })),
})) })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const ebayGalleryWhere = (productId: string) => ({
  productId, scope: 'PLATFORM' as const, platform: 'EBAY', marketplace: null,
  variationId: null, amazonSlot: null, mediaType: 'IMAGE',
})

export interface MediaGalleryContext {
  destination: WorkspaceDestination
  axes: EbayMediaAxis[]
  axesVerified: boolean
}

async function read(tx: Prisma.TransactionClient, productId: string, context: MediaGalleryContext) {
  const { destination, axes, axesVerified } = context
  const product = await tx.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, imageAxisPreference: true } })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const listing = destination.listing ? await tx.channelListing.findFirst({ where: {
    id: destination.listing.id, productId, channel: 'EBAY', marketplace: destination.marketplace,
    channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '',
  }, select: { id: true, version: true, platformAttributes: true } }) : null
  if (destination.listing && !listing) throw new WorkspaceScopeError('The selected listing changed destination. Reload before continuing.')
  // Recheck alias status inside the write transaction, not just at route entry.
  if (destination.aliasKey && !await tx.productListingAlias.findFirst({ where: {
    id: destination.aliasKey, productId: destination.familyId, channel: 'EBAY', marketplace: destination.marketplace,
    channelConnectionId: destination.accountId, status: 'ACTIVE',
  }, select: { id: true } })) throw new WorkspaceScopeError('This listing alias is no longer active.')
  const [rows, master] = await Promise.all([
    tx.listingImage.findMany({ where: ebayGalleryWhere(productId), orderBy: { id: 'asc' } }),
    tx.productImage.findMany({ where: { productId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
  ])
  const pa = object(listing?.platformAttributes)
  const stored = pa[EBAY_MEDIA_DRAFT_KEY] === undefined ? null : storedSchema.safeParse(pa[EBAY_MEDIA_DRAFT_KEY])
  if (stored && !stored.success) throw new WorkspaceScopeError('This listing has a gallery draft that could not be read. It has been preserved; saving is unavailable.', 422)
  const assets: EbayMediaAsset[] = []
  const byUrl = new Map<string, EbayMediaAsset>()
  const add = (asset: EbayMediaAsset) => {
    const found = byUrl.get(asset.url)
    if (found) return found.id
    assets.push(asset); byUrl.set(asset.url, asset); return asset.id
  }
  for (const row of master) if (row.mediaType === 'IMAGE') add({ id: `product:${row.id}`, url: row.url,
    label: row.alt || `Product image ${assets.length + 1}`, width: row.width, height: row.height, origin: 'product' })
  // Shared assignments are source material. Saving a listing draft never edits them.
  for (const row of rows) add({ id: `saved:${hash(row.url)}`, url: row.url, label: row.altOverride || row.filename || `Saved image ${assets.length + 1}`,
    width: row.width, height: row.height, origin: 'saved-gallery' })
  const galleries = new Map<string, EbayMediaDraft['galleries'][number]>()
  galleries.set(galleryKey({ axis: null, value: null }), { axis: null, value: null, assetIds: [] })
  if (stored?.success) {
    for (const gallery of stored.data.galleries) galleries.set(galleryKey(gallery), { axis: gallery.axis, value: gallery.value,
      assetIds: gallery.images.map(image => add({ ...image, width: image.width ?? null, height: image.height ?? null, id: `saved:${hash(image.url)}`, origin: 'saved-gallery' })) })
  } else if (Array.isArray(pa.imageUrls)) {
    // An explicitly empty listing gallery is meaningful; never refill it from another scope.
    const urls = pa.imageUrls.filter((url): url is string => typeof url === 'string')
    galleries.get(galleryKey({ axis: null, value: null }))!.assetIds = urls.map((url, index) => add({
      id: `saved:${hash(url)}`, url, label: `Listing image ${index + 1}`, width: null, height: null, origin: 'saved-gallery',
    }))
  } else {
    for (const row of [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
      const group = { axis: row.variantGroupKey, value: row.variantGroupValue }
      const key = galleryKey(group)
      if (!galleries.has(key)) galleries.set(key, { ...group, assetIds: [] })
      galleries.get(key)!.assetIds.push(byUrl.get(row.url)!.id)
    }
  }
  const globalAxis = product.imageAxisPreference
  const inheritedAxis = globalAxis && globalAxis !== '__shared__' ? axes.find(a => axisSynonymKey(a.name) === axisSynonymKey(globalAxis))?.name ?? null : null
  const preference = stored?.success ? stored.data.axis : typeof pa._imageAxis === 'string' ? pa._imageAxis : inheritedAxis
  const draft: EbayMediaDraft = { axis: preference === '__shared__' ? null : preference, galleries: [...galleries.values()] }
  // Display wording is deliberately absent: translating a label never renames a gallery.
  // Listing attributes/version and dynamic variation evidence all participate in conflict checks.
  const revision = hash([productId, destination.accountId, destination.marketplace, destination.listing?.id ?? null,
    listing, stored?.success ? null : [product.imageAxisPreference, rows], axesVerified, axes.map(({ name, key, values }) => ({ name, key, values }))])
  return { productId, assets, draft, revision, listing, inherited: !stored, rows }
}

export async function readEbayMediaGallery(productId: string, context: MediaGalleryContext) {
  return prisma.$transaction(tx => read(tx, productId, context), { isolationLevel: 'RepeatableRead' })
}

export async function saveEbayMediaGallery(productId: string, input: unknown, context: MediaGalleryContext) {
  const parsed = ebayMediaDraftSchema.safeParse((input as { draft?: unknown } | null)?.draft)
  const expectedRevision = (input as { expectedRevision?: unknown } | null)?.expectedRevision
  if (!parsed.success || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))
    throw new WorkspaceScopeError('A valid gallery and its observed revision are required.', 400)
  if (!context.destination.listing) throw new WorkspaceScopeError('Choose a listing before saving its gallery.', 422)
  try {
    return await prisma.$transaction(async tx => {
      const current = await read(tx, productId, context)
      if (current.revision !== expectedRevision) throw new WorkspaceScopeError('This listing or its variation groups changed after you opened it. Your edits are still here. Reload before trying again.')
      const draft = parsed.data
      const axes = context.axes
      const knownAxes = new Set([...axes.map(a => a.name), ...current.draft.galleries.flatMap(g => g.axis ? [g.axis] : []), ...(current.draft.axis ? [current.draft.axis] : [])])
      if (draft.axis !== null && !knownAxes.has(draft.axis)) throw new WorkspaceScopeError('This variation grouping is not available for the selected listing.', 422)
      for (const gallery of draft.galleries) {
        if (gallery.axis === null || !gallery.assetIds.length || current.draft.galleries.some(g => galleryKey(g) === galleryKey(gallery))) continue
        if (!axes.some(a => a.name === gallery.axis && a.values.includes(gallery.value ?? '')))
          throw new WorkspaceScopeError('A new gallery does not match a verified variation value. Reload the gallery context before saving.', 422)
      }
      const check = inspectMediaDraft(draft, current.assets, Object.fromEntries(axes.map(a => [a.name, a.label])))
      if (check.problems.length) throw new WorkspaceScopeError(check.problems.join(' '), 422)
      const byId = new Map(current.assets.map(a => [a.id, a]))
      const stored: z.infer<typeof storedSchema> = { version: 1, axis: draft.axis, galleries: draft.galleries.map(g => ({ axis: g.axis, value: g.value,
        images: g.assetIds.map(id => { const { url, label, width, height } = byId.get(id)!; return { url, label, width, height } }),
      })) }
      const listing = current.listing!
      const result = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version,
        productId, channel: 'EBAY', marketplace: context.destination.marketplace, channelConnectionId: context.destination.accountId, aliasKey: context.destination.aliasKey ?? '',
      }, data: { platformAttributes: { ...object(listing.platformAttributes), [EBAY_MEDIA_DRAFT_KEY]: stored } as Prisma.InputJsonValue, version: { increment: 1 } } })
      if (result.count !== 1) throw new WorkspaceScopeError('This listing changed during the save. Reload before trying again.')
      return read(tx, productId, context)
    }, { isolationLevel: 'Serializable', timeout: 20_000 })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2034') throw new WorkspaceScopeError('Another save overlapped this one. Your edits are still here. Reload before trying again.')
    throw error
  }
}

const publication = { available: false as const,
  reason: 'Saving stores a gallery draft for this listing in Nexus. Publishing this draft is unavailable; saving does not update or verify live eBay images.' }

/** Resolve the listing and its axes before reading or saving its gallery draft. */
export async function ebayMediaWorkspace(productId: string, input: { market?: string; accountId?: string; listingId?: string }, method: 'GET' | 'PUT', body?: unknown) {
  const { market, accountId, listingId } = input
  let destination = await resolveWorkspaceDestination({ productId, channel: 'EBAY', marketplace: market ?? '', accountId, listingId })
  if (destination.listing && destination.listing.productId !== productId) throw new WorkspaceScopeError('Open Media on the selected listing’s product.', 409)
  const coordinate = { channel: 'EBAY', marketplace: destination.marketplace, channelConnectionId: destination.accountId }
  const [aliases, allListings] = await Promise.all([
    prisma.productListingAlias.findMany({ where: { ...coordinate, productId: destination.familyId, status: 'ACTIVE' }, orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { id: true, label: true } }),
    prisma.channelListing.findMany({ where: { ...coordinate, productId }, orderBy: { id: 'asc' }, select: { id: true, aliasKey: true, externalListingId: true, platformAttributes: true } }),
  ])
  const listings = ['', ...aliases.map(a => a.id)].flatMap(aliasKey => allListings.filter(l => l.aliasKey === aliasKey).map(l => ({
    id: l.id, aliasKey, label: aliasKey === '' ? 'Primary listing' : aliases.find(a => a.id === aliasKey)!.label, externalListingId: l.externalListingId,
  })))
  // An unselected destination can resolve only its unambiguous primary, never an arbitrary alias.
  if (!destination.listing) {
    const primary = listings.filter(l => l.aliasKey === '')
    if (primary.length === 1) destination = await resolveWorkspaceDestination({ productId, channel: 'EBAY', marketplace: destination.marketplace, accountId: destination.accountId, listingId: primary[0].id })
  }
  const selected = listings.find(l => l.id === destination.listing?.id)
  if (destination.listing && !selected) throw new WorkspaceScopeError('This listing is no longer available. Reload the listing selection.')
  const warnings: string[] = []
  let axes: EbayMediaAxis[] = []
  let axesVerified = false
  const labelByName = new Map<string, string>()
  try {
    const pa = allListings.find(l => l.id === selected?.id)?.platformAttributes as Record<string, unknown> | null
    const categoryId = typeof pa?.categoryId === 'string' || typeof pa?.categoryId === 'number' ? String(pa.categoryId) : ''
    const spec = await loadEbaySpec(destination.marketplace, categoryId ? [categoryId] : [])
    for (const field of spec.fields) if (field.englishLabel) labelByName.set(field.label, field.englishLabel)
  } catch { warnings.push('Category label metadata is unavailable. Known English names are used; unrecognized field names are retained verbatim.') }
  const label = (name: string) => labelByName.get(name) ?? englishEbayAspectLabel(name) ?? name
  if (selected) try {
    const resolved = await resolveFamilyAxes(destination.familyId, destination.marketplace, { channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' })
    axes = resolved.axes.map(({ name, key, values }) => ({ name, key: key || axisSynonymKey(name), label: label(name), values }))
    axesVerified = true
    warnings.push(...resolved.warnings)
  } catch {
    warnings.push('Variation groups could not be verified for this listing. Existing galleries remain available; new groups are unavailable until this read succeeds.')
  }
  const context = { destination, axes, axesVerified }
  const data = method === 'GET' ? await readEbayMediaGallery(productId, context) : await saveEbayMediaGallery(productId, body, context)
  const names = [...axes.map(a => a.name), ...data.draft.galleries.flatMap(g => g.axis ? [g.axis] : []), ...(data.draft.axis ? [data.draft.axis] : [])]
  const axisLabels = Object.fromEntries(names.map(name => [name, label(name)]))
  const otherImageCount = await prisma.listingImage.count({ where: { productId, platform: 'EBAY', NOT: ebayGalleryWhere(productId) } })
  return { productId, assets: data.assets, revision: data.revision, draft: data.draft, axes, axisLabels, warnings, otherImageCount, publication,
    destination: { accountId: destination.accountId, marketplace: destination.marketplace, listingId: selected?.id ?? null, aliasKey: selected?.aliasKey ?? null,
      label: selected?.label ?? 'Choose a listing', listings, inherited: data.inherited } }
}
