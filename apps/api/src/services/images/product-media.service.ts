import { normalizeLanguage } from '../pim/content-language.js'
import { resolveContent } from '../pim/content-resolver.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { AMAZON_ALIAS_PHOTOS, followsMainListingPhotos, mediaObject, readMediaCollection, productMediaSaveSchema, productMediaCopySchema, resolveMediaCollection, writeMediaCollection,
  type ProductMediaAsset, type ProductMediaCollection, type ProductMediaQuery, type ProductMediaWorkspace } from '@nexus/shared/product-media'
import prisma from '../../db.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from '../pim/workspace-destination.js'
import { isOnMediaPlan, MEDIA_PLAN_REFUSAL } from './media-plan-switch.js'
import { DraftListingError, ensureDraftListings } from '../pim/draft-listing.service.js'
import { publishListingEvent } from '../listing-events.service.js'
import { logger } from '../../utils/logger.js'
import { addLibraryPhotos, isLegacyPhotoId, legacyImageUrls, legacyPhotoItems, matchLibraryPhoto } from './listing-photos.service.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Input = ProductMediaQuery & { productId: string }
type Tx = Prisma.TransactionClient
const productSelect = { workspaceId: true, translations: true, id: true, parentId: true, name: true, sku: true, version: true, localizedContent: true } as const

/** The checked address: `input` names its listing by the listing row's id from here on. */
export async function validateProductMediaDestination(input: Input): Promise<Input> {
  if (input.scope === 'MASTER') return input
  const destination = await resolveWorkspaceDestination({ productId: input.productId, channel: input.scope, marketplace: input.market, accountId: input.accountId, listingId: input.listingId, aliasKey: input.aliasKey })
  let listing: { id: string; productId: string; aliasKey: string } | null = destination.listing
  // Owner 2026-10-05 — an alias is named by its ALIAS ID. An older address sends it as `listingId`: the resolver links it to
  // the family root's listing of that alias, so a variant's address names the variant's own listing of the same alias.
  if (listing && input.listingId && listing.productId !== input.productId && listing.aliasKey && listing.aliasKey === input.listingId)
    listing = await prisma.channelListing.findFirst({ where: { productId: input.productId, channel: input.scope, marketplace: input.market, channelConnectionId: destination.accountId, aliasKey: listing.aliasKey },
      select: { id: true, productId: true, aliasKey: true } })
  if ((input.listingId && !listing) || (listing && listing.productId !== input.productId)) throw new WorkspaceScopeError('Choose the listing for this product to edit its media.', 422)
  // The snapshot reads the listing row by its id, never the raw alias id no listing has.
  return listing?.id && input.listingId && listing.id !== input.listingId ? { ...input, listingId: listing.id } : input
}

async function snapshot(input: Input, tx: Tx) {
  input = { ...input, locale: normalizeLanguage(input.locale) }
  const product = await tx.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: productSelect })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const [parent, files, listing] = await Promise.all([
    product.parentId ? tx.product.findFirst({ where: { id: product.parentId, deletedAt: null }, select: productSelect }) : null,
    tx.productImage.findMany({ where: { productId: { in: [product.id, ...(product.parentId ? [product.parentId] : [])] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    input.scope === 'MASTER' ? null : tx.channelListing.findFirst({ where: { id: input.listingId, productId: product.id, channel: input.scope, marketplace: input.market, channelConnectionId: input.accountId,
      ...(input.listingId ? {} : { aliasKey: input.aliasKey }) }, select: { id: true, version: true, channel: true, aliasKey: true, externalListingId: true, platformAttributes: true } }),
  ])
  if (input.listingId && !listing) throw new WorkspaceScopeError('The selected listing destination is no longer available.')
  // Owner 2026-10-05 — an Amazon alias on the Main listing's product page (no ASIN yet, or the same ASIN) shows the Main
  // listing's photos (one photo set per product): its list is read from this product's Main listing on the same account and
  // market, read-only (a save or a copy onto it is refused; a reset only clears its own older list). An alias on its own
  // ASIN keeps its own list.
  const aliasKey = listing ? listing.aliasKey : input.aliasKey
  const main = input.scope === 'AMAZON' && aliasKey ? await tx.channelListing.findFirst({ where: { productId: product.id, channel: input.scope, marketplace: input.market,
    channelConnectionId: input.accountId, aliasKey: '' }, select: { id: true, version: true, channel: true, aliasKey: true, externalListingId: true, platformAttributes: true } }) : null
  const followsMain = followsMainListingPhotos({ channel: input.scope, aliasKey, asin: listing?.externalListingId, mainAsin: main?.externalListingId })
  const assets: ProductMediaAsset[] = files.map(file => ({ id: file.id, type: file.mediaType || 'IMAGE', url: file.url,
    preview: file.mediaType === 'IMAGE' ? file.url : file.posterUrl, alt: file.alt ?? '', mimeType: file.mimeType,
    width: file.width, height: file.height, durationSec: file.durationSec, fileSize: file.fileSize }))
  // Owner 2026-10-05 — Product media is the one photo source: an eBay listing with no Product media saved still sends its
  // old Image URLs list, so the editor shows THAT list, with the sheet cell's ids (`legacyPhotoItems`, own files first):
  // a library photo by its id, any other address by its `url:` id (an asset of its own until a save adds it).
  const legacy = listing?.channel === 'EBAY' ? legacyImageUrls(listing.platformAttributes) : undefined
  const old = legacy && legacyPhotoItems(legacy, files, product.id)
  if (old) assets.push(...old.outside.map(photo => ({ id: photo.id, type: 'IMAGE', url: photo.url, preview: photo.url, alt: '' })))
  const isChannel = input.scope !== 'MASTER'
  const content = isChannel ? mediaObject((followsMain ? main : listing)?.platformAttributes)._productMediaLocales : product.localizedContent
  const resolved = old ? { collection: { version: 1 as const, items: old.items }, source: 'locale' as const, hasOverride: true } : resolveMediaCollection({ locale: input.locale, own: content,
    shared: isChannel ? product.localizedContent : undefined, parent: parent?.localizedContent,
    ownIds: files.filter(file => file.productId === product.id).map(file => file.id),
    parentIds: files.filter(file => file.productId === parent?.id).map(file => file.id) })
  const { productId, ...context } = input
  const workspace: ProductMediaWorkspace = { ...resolved, productId, context, title: String(resolveContent({ product: product as any, parent: parent as any, field: 'title', address: { requested: input.locale === 'und' ? PRIMARY_CONTENT_LOCALE : input.locale } }).value ?? product.sku), assets,
    missingAssetIds: resolved.collection.items.filter(item => !assets.some(asset => asset.id === item.assetId)).map(item => item.assetId),
    revision: hash([[input.productId, input.scope, input.market, input.locale, input.accountId ?? null, input.listingId ?? null, input.aliasKey ?? null], product, parent, listing, files.map(file => [file.id, file.updatedAt, file.url, file.alt, file.sortOrder]),
      ...(followsMain ? [main] : [])]), ...(followsMain ? { readOnly: AMAZON_ALIAS_PHOTOS } : {}) }
  return { workspace, product, parent, listing, files }
}

export async function readProductMedia(input: Input) {
  return (await snapshot(await validateProductMediaDestination(input), prisma)).workspace
}

/**
 * A saved list is told to every open screen — the same live event the photo plan sends (Lane C, Owner D2 = a, 2026-09-28) —
 * keyed by the family root, so every sheet of the family reads its cells again. Sent only after the commit, and it never
 * turns a committed save into a failure: an event that cannot be sent is logged; open screens read it on their next load.
 */
function announce(rootId: string | null) {
  if (!rootId) return
  try {
    publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'GALLERY', ts: Date.now() })
  } catch (error) {
    logger.warn('[product-media] saved, but the live update could not be sent', { productId: rootId, reason: error instanceof Error ? error.message : String(error) })
  }
}

export async function saveProductMedia(input: Input, body: unknown) {
  if (await isOnMediaPlan(input.productId)) throw new WorkspaceScopeError(MEDIA_PLAN_REFUSAL, 409)
  const { expectedRevision, collection } = productMediaSaveSchema.parse(body)
  input = await validateProductMediaDestination(input)
  let rootId: string | null = null
  try {
    const saved = await prisma.$transaction(async tx => {
      const state = await snapshot(input, tx)
      rootId = state.product.parentId ?? state.product.id
      const { workspace } = state
      if (workspace.readOnly && collection) throw new WorkspaceScopeError(workspace.readOnly, 422)
      if (workspace.revision !== expectedRevision) throw new WorkspaceScopeError('Media changed since this editor opened. Reload the gallery before applying your changes.')
      if (workspace.readOnly) return clearOwnList(input, state, tx)
      const known = new Set(workspace.assets.map(asset => asset.id))
      if (collection?.items.some(item => !known.has(item.assetId))) throw new WorkspaceScopeError('A selected file is no longer in this product’s media library. Reload the gallery.', 422)
      return persistCollection(input, state, collection, tx)
    }, { isolationLevel: 'Serializable' })
    announce(rootId)
    return saved
  } catch (error) { throw mediaConflict(error) }
}

async function persistCollection(input: Input, { workspace, product, listing }: Awaited<ReturnType<typeof snapshot>>, collection: ProductMediaCollection | null, tx: Tx) {
  if (input.scope !== 'MASTER' && !listing) {
    if (!collection) return workspace
    // Product-sheet create path, step 5 — the first media save on a coordinate with no listing starts its draft (the
    // family's parent and variants, `ensureDraftListings`, the one creator) in this transaction, then saves the gallery
    // on the product's new row.
    const started = await ensureDraftListings(tx, { channel: input.scope, market: input.market, accountId: input.accountId ?? null, aliasKey: input.aliasKey ?? '',
      productIds: [product.id], family: true }).catch(error => { throw error instanceof DraftListingError ? new WorkspaceScopeError(error.message, error.statusCode) : error })
    const own = started.find(row => row.productId === product.id)!
    const written = await tx.channelListing.updateMany({ where: { id: own.id, version: own.version }, data: { version: { increment: 1 },
      platformAttributes: { _productMediaLocales: writeMediaCollection({}, input.locale, collection) } as Prisma.InputJsonValue } })
    if (written.count !== 1) throw new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.')
    return (await snapshot(input, tx)).workspace
  }
  // Owner 2026-10-05 — a saved photo of an old eBay Image URLs list joins this row's library (`addLibraryPhotos`, by its
  // address from this snapshot) and is saved by its new id; two addresses of one photo keep the first.
  if (collection?.items.some(item => isLegacyPhotoId(item.assetId))) {
    const urlOf = new Map(workspace.assets.map(asset => [asset.id, asset.url]))
    const added = await addLibraryPhotos(tx, { productId: product.id, urls: collection.items.flatMap(item => isLegacyPhotoId(item.assetId) ? [urlOf.get(item.assetId)!] : []) })
    const items: ProductMediaCollection['items'] = []
    for (const item of collection.items) {
      const assetId = isLegacyPhotoId(item.assetId) ? added.get(urlOf.get(item.assetId)!)!.id : item.assetId
      if (!items.some(existing => existing.assetId === assetId)) items.push({ ...item, assetId })
    }
    collection = { ...collection, items }
  }
  // Owner 2026-10-05 — one list at a time, the last save wins: a save or a reset on an eBay listing removes its old Image
  // URLs list (a reset then follows the shared list). The old list applied to every language, so the list that replaces it
  // does too ('und'; review 2026-10-05: a save in the 'de' view of the IT sheet left Italian on the Shared list).
  const { imageUrls: _old, ...attributes } = mediaObject(listing?.platformAttributes)
  const locale = listing?.channel === 'EBAY' && legacyImageUrls(listing.platformAttributes) ? 'und' : input.locale
  const result = listing ? await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version, productId: product.id, channel: input.scope, marketplace: input.market, channelConnectionId: input.accountId },
    data: { version: { increment: 1 }, platformAttributes: { ...(listing.channel === 'EBAY' ? attributes : mediaObject(listing.platformAttributes)),
      _productMediaLocales: writeMediaCollection(mediaObject(listing.platformAttributes)._productMediaLocales, locale, collection) } as Prisma.InputJsonValue } })
    : await tx.product.updateMany({ where: { id: product.id, version: product.version, deletedAt: null }, data: {
      version: { increment: 1 }, localizedContent: writeMediaCollection(product.localizedContent, input.locale, collection) as Prisma.InputJsonValue } })
  if (result.count !== 1) throw new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.')
  return (await snapshot(input, tx)).workspace
}

/**
 * Owner 2026-10-05 — a reset on a listing that shows the Main listing's photos (an Amazon alias) clears its own older list,
 * every language of it: it is never shown or sent, and it would keep its photos "in use".
 */
async function clearOwnList(input: Input, state: Awaited<ReturnType<typeof snapshot>>, tx: Tx) {
  const { listing } = state
  if (!listing || mediaObject(listing.platformAttributes)._productMediaLocales === undefined) return state.workspace
  const { _productMediaLocales: _old, ...attributes } = mediaObject(listing.platformAttributes)
  const result = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version }, data: { version: { increment: 1 }, platformAttributes: attributes as Prisma.InputJsonValue } })
  if (result.count !== 1) throw new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.')
  return (await snapshot(input, tx)).workspace
}

function mediaConflict(error: unknown) {
  return ['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')
    ? new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.') : error
}

/** Copy a typed gallery, including localized accessibility metadata. Never delete target files. */
export async function copyProductMedia(input: Input, body: unknown) {
  if (await isOnMediaPlan(input.productId)) throw new WorkspaceScopeError(MEDIA_PLAN_REFUSAL, 409)
  const command = productMediaCopySchema.parse(body)
  input = await validateProductMediaDestination(input)
  const sourceInput = await validateProductMediaDestination({ productId: command.source.productId, ...command.source.context })
  let rootId: string | null = null
  try {
    const copied = await prisma.$transaction(async tx => {
      const source = await snapshot(sourceInput, tx), target = await snapshot(input, tx)
      rootId = target.product.parentId ?? target.product.id
      if (target.workspace.readOnly) throw new WorkspaceScopeError(target.workspace.readOnly, 422)
      if (source.workspace.revision !== command.source.expectedRevision || target.workspace.revision !== command.expectedRevision) {
        throw new WorkspaceScopeError('A source or destination gallery changed. Refresh the sheet before copying again.')
      }
      if (source.workspace.missingAssetIds.length) throw new WorkspaceScopeError('The source gallery contains unavailable files. Review it before copying.', 422)
      const files = [...target.files], items: ProductMediaCollection['items'] = []
      for (const item of source.workspace.collection.items) {
        // Owner 2026-10-05 — a photo of the source's old eBay Image URLs list is not in a library yet: it is copied by its
        // address (a target library photo at the same address or the same Cloudinary photo, else a new target file).
        const legacy = isLegacyPhotoId(item.assetId) ? source.workspace.assets.find(asset => asset.id === item.assetId)! : undefined
        const file = legacy ? { id: legacy.id, url: legacy.url, alt: '', publicId: null, mediaType: 'IMAGE', posterUrl: null, durationSec: null, width: null, height: null,
          mimeType: null, fileSize: null, contentHash: null, sourceAssetId: null } : source.files.find(file => file.id === item.assetId)!
        let local = files.find(candidate => candidate.id === file.id)
          ?? files.find(candidate => !items.some(item => item.assetId === candidate.id) && candidate.mediaType === file.mediaType && (candidate.url === file.url || (!!file.contentHash && candidate.contentHash === file.contentHash)))
          ?? (legacy ? matchLibraryPhoto(legacy.url, files.filter(candidate => !items.some(item => item.assetId === candidate.id)), target.product.id) : undefined)
        if (!local) {
          local = await tx.productImage.create({ data: {
            productId: target.product.id, type: 'ALT', isPrimary: false,
            sortOrder: Math.max(-1, ...files.filter(f => f.productId === target.product.id).map(f => f.sortOrder)) + 1,
            url: file.url, alt: file.alt, publicId: file.publicId, mediaType: file.mediaType, posterUrl: file.posterUrl,
            durationSec: file.durationSec, width: file.width, height: file.height, mimeType: file.mimeType, fileSize: file.fileSize,
            contentHash: file.contentHash, sourceAssetId: file.sourceAssetId,
          } })
          files.push(local)
        }
        // Different source references may resolve to one existing target file.
        if (items.some(existing => existing.assetId === local.id)) throw new WorkspaceScopeError('Two source items resolve to the same destination file. Review this gallery before copying.', 422)
        items.push({ ...item, assetId: local.id, alt: item.alt ?? file.alt ?? '' })
      }
      if (files.length !== target.files.length && (input.scope !== 'MASTER' || input.locale !== 'und')) {
        // Adding library references for one coordinate must not replace other languages' fallback galleries.
        let content = mediaObject(target.product.localizedContent)
        const ownIds = target.files.filter(file => file.productId === target.product.id).map(file => file.id)
        const parentIds = target.files.filter(file => file.productId === target.parent?.id).map(file => file.id)
        if (!readMediaCollection(content, 'und')) {
          if (!ownIds.length && target.parent) {
            for (const locale of Object.keys(mediaObject(target.parent.localizedContent))) {
              const inherited = readMediaCollection(target.parent.localizedContent, locale)
              if (inherited && !readMediaCollection(content, locale)) content = writeMediaCollection(content, locale, inherited)
            }
          }
          if (!readMediaCollection(content, 'und')) content = writeMediaCollection(content, 'und', resolveMediaCollection({ locale: 'und', own: target.product.localizedContent, parent: target.parent?.localizedContent, ownIds, parentIds }).collection)
        }
        target.product.localizedContent = content as Prisma.JsonObject
        if (input.scope !== 'MASTER') {
          const updated = await tx.product.updateMany({ where: { id: target.product.id, version: target.product.version, deletedAt: null }, data: { localizedContent: content as Prisma.InputJsonValue, version: { increment: 1 } } })
          if (updated.count !== 1) throw new WorkspaceScopeError('The destination product changed. Refresh before copying again.')
        }
      }
      return persistCollection(input, target, { version: 1, items }, tx)
    }, { isolationLevel: 'Serializable', timeout: 30000 })
    announce(rootId)
    return copied
  } catch (error) { throw mediaConflict(error) }
}
