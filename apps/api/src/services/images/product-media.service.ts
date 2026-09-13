import { normalizeLanguage } from '../pim/content-language.js'
import { resolveContent } from '../pim/content-resolver.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { mediaObject, readMediaCollection, productMediaSaveSchema, productMediaCopySchema, resolveMediaCollection, writeMediaCollection,
  type ProductMediaAsset, type ProductMediaCollection, type ProductMediaQuery, type ProductMediaWorkspace } from '@nexus/shared/product-media'
import prisma from '../../db.js'
import { resolveWorkspaceDestination, WorkspaceScopeError } from '../pim/workspace-destination.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Input = ProductMediaQuery & { productId: string }
type Tx = Prisma.TransactionClient
const productSelect = { workspaceId: true, translations: true, id: true, parentId: true, name: true, sku: true, version: true, localizedContent: true } as const

export async function validateProductMediaDestination(input: Input) {
  if (input.scope === 'MASTER') return
  const destination = await resolveWorkspaceDestination({ productId: input.productId, channel: input.scope, marketplace: input.market, accountId: input.accountId, listingId: input.listingId, aliasKey: input.aliasKey })
  if ((input.listingId && !destination.listing) || (destination.listing && destination.listing.productId !== input.productId)) throw new WorkspaceScopeError('Choose the listing for this product to edit its media.', 422)
}

async function snapshot(input: Input, tx: Tx) {
  input = { ...input, locale: normalizeLanguage(input.locale) }
  const product = await tx.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: productSelect })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const [parent, files, listing] = await Promise.all([
    product.parentId ? tx.product.findFirst({ where: { id: product.parentId, deletedAt: null }, select: productSelect }) : null,
    tx.productImage.findMany({ where: { productId: { in: [product.id, ...(product.parentId ? [product.parentId] : [])] } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    input.scope === 'MASTER' ? null : tx.channelListing.findFirst({ where: { id: input.listingId, productId: product.id, channel: input.scope, marketplace: input.market, channelConnectionId: input.accountId,
      ...(input.listingId ? {} : { aliasKey: input.aliasKey }) }, select: { id: true, version: true, platformAttributes: true } }),
  ])
  if (input.listingId && !listing) throw new WorkspaceScopeError('The selected listing destination is no longer available.')
  const assets: ProductMediaAsset[] = files.map(file => ({ id: file.id, type: file.mediaType || 'IMAGE', url: file.url,
    preview: file.mediaType === 'IMAGE' ? file.url : file.posterUrl, alt: file.alt ?? '', mimeType: file.mimeType,
    width: file.width, height: file.height, durationSec: file.durationSec, fileSize: file.fileSize }))
  const isChannel = input.scope !== 'MASTER'
  const content = isChannel ? mediaObject(listing?.platformAttributes)._productMediaLocales : product.localizedContent
  const resolved = resolveMediaCollection({ locale: input.locale, own: content,
    shared: isChannel ? product.localizedContent : undefined, parent: parent?.localizedContent,
    ownIds: files.filter(file => file.productId === product.id).map(file => file.id),
    parentIds: files.filter(file => file.productId === parent?.id).map(file => file.id) })
  const { productId, ...context } = input
  const workspace: ProductMediaWorkspace = { ...resolved, productId, context, title: String(resolveContent({ product: product as any, parent: parent as any, field: 'title', address: { requested: input.locale === 'und' ? PRIMARY_CONTENT_LOCALE : input.locale } }).value ?? product.sku), assets,
    missingAssetIds: resolved.collection.items.filter(item => !assets.some(asset => asset.id === item.assetId)).map(item => item.assetId),
    revision: hash([[input.productId, input.scope, input.market, input.locale, input.accountId ?? null, input.listingId ?? null, input.aliasKey ?? null], product, parent, listing, files.map(file => [file.id, file.updatedAt, file.url, file.alt, file.sortOrder])]) }
  return { workspace, product, parent, listing, files }
}

export async function readProductMedia(input: Input) {
  await validateProductMediaDestination(input)
  return (await snapshot(input, prisma)).workspace
}

export async function saveProductMedia(input: Input, body: unknown) {
  const { expectedRevision, collection } = productMediaSaveSchema.parse(body)
  await validateProductMediaDestination(input)
  try {
    return await prisma.$transaction(async tx => {
      const state = await snapshot(input, tx)
      const { workspace } = state
      if (workspace.revision !== expectedRevision) throw new WorkspaceScopeError('Media changed since this editor opened. Reload the gallery before applying your changes.')
      const known = new Set(workspace.assets.map(asset => asset.id))
      if (collection?.items.some(item => !known.has(item.assetId))) throw new WorkspaceScopeError('A selected file is no longer in this product’s media library. Reload the gallery.', 422)
      return persistCollection(input, state, collection, tx)
    }, { isolationLevel: 'Serializable' })
  } catch (error) { throw mediaConflict(error) }
}

async function persistCollection(input: Input, { workspace, product, listing }: Awaited<ReturnType<typeof snapshot>>, collection: ProductMediaCollection | null, tx: Tx) {
  if (input.scope !== 'MASTER' && !listing) {
    if (!collection) return workspace
    await tx.channelListing.create({ data: { productId: product.id, channel: input.scope, marketplace: input.market, region: input.market,
      channelMarket: `${input.scope}_${input.market}`, channelConnectionId: input.accountId, aliasKey: input.aliasKey ?? '', aliasId: input.aliasKey || null,
      listingStatus: 'DRAFT', isPublished: false, platformAttributes: { _productMediaLocales: writeMediaCollection({}, input.locale, collection) } as Prisma.InputJsonValue } })
    return (await snapshot(input, tx)).workspace
  }
  const result = listing ? await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version, productId: product.id, channel: input.scope, marketplace: input.market, channelConnectionId: input.accountId },
    data: { version: { increment: 1 }, platformAttributes: { ...mediaObject(listing.platformAttributes),
      _productMediaLocales: writeMediaCollection(mediaObject(listing.platformAttributes)._productMediaLocales, input.locale, collection) } as Prisma.InputJsonValue } })
    : await tx.product.updateMany({ where: { id: product.id, version: product.version, deletedAt: null }, data: {
      version: { increment: 1 }, localizedContent: writeMediaCollection(product.localizedContent, input.locale, collection) as Prisma.InputJsonValue } })
  if (result.count !== 1) throw new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.')
  return (await snapshot(input, tx)).workspace
}

function mediaConflict(error: unknown) {
  return ['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')
    ? new WorkspaceScopeError('Media changed while saving. Reload the gallery before retrying.') : error
}

/** Copy a typed gallery, including localized accessibility metadata. Never delete target files. */
export async function copyProductMedia(input: Input, body: unknown) {
  const command = productMediaCopySchema.parse(body)
  const sourceInput = { productId: command.source.productId, ...command.source.context }
  await validateProductMediaDestination(input)
  await validateProductMediaDestination(sourceInput)
  try {
    return await prisma.$transaction(async tx => {
      const source = await snapshot(sourceInput, tx), target = await snapshot(input, tx)
      if (source.workspace.revision !== command.source.expectedRevision || target.workspace.revision !== command.expectedRevision) {
        throw new WorkspaceScopeError('A source or destination gallery changed. Refresh the sheet before copying again.')
      }
      if (source.workspace.missingAssetIds.length) throw new WorkspaceScopeError('The source gallery contains unavailable files. Review it before copying.', 422)
      const files = [...target.files], items: ProductMediaCollection['items'] = []
      for (const item of source.workspace.collection.items) {
        const file = source.files.find(file => file.id === item.assetId)!
        let local = files.find(candidate => candidate.id === file.id)
          ?? files.find(candidate => !items.some(item => item.assetId === candidate.id) && candidate.mediaType === file.mediaType && (candidate.url === file.url || (!!file.contentHash && candidate.contentHash === file.contentHash)))
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
  } catch (error) { throw mediaConflict(error) }
}
