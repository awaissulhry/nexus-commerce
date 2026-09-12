import { readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { listingInformationDraft, listingInformationTranslations, listingInformationOverrideReview, validateListingInformationOverrides } from './listing-information-plan.js'
import { readLinkedStoreSchema } from './linked-products-gateway.js'
import { buildLinkedPlan, applyLinkedBatch } from './linked-products.service.js'
import { applyNativeEdit } from './information-gateway.js'
import type { ShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { shopifyInformationPublicationIssue } from './linked-state-guard.js'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { inspectShopifyContent, resolveShopifyContent } from '@nexus/shared/shopify-content'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { contentDestination, readContent, publicContent, object, digest, CONTENT_KEY, PUBLISH_KEY, type ContentScope } from './content-workspace.service.js'
import { shopifyAdmin } from './admin-client.js'
import { publishContent, readRemoteProduct, type ShopifyRemoteProduct } from './content-publisher.js'
import { nativeListingValue } from './native-listing-value.js'

export async function previewContentSync(productId: string, scope: ContentScope, remote = false) {
  const destination = await contentDestination(productId, scope)
  const cachedSchema = await readShopifyMappingSchema(destination.accountId)
  const data = await prisma.$transaction(tx => readContent(tx, destination, cachedSchema.locales, cachedSchema), { isolationLevel: 'RepeatableRead' })
  const identity = `${data.listing?.workspaceId ?? 'nexus'}:${data.family.id}${destination.aliasKey ? ':' + destination.aliasKey : ''}`
  let shopify: ShopifyRemoteProduct | null = null, locations: { id: string; name: string; isActive: boolean }[] = [], domain: string | null = null
  let informationDraft: ShopifyLinkedDraft | null = null
  let translationDraft: ShopifyLinkedDraft | null = null
  let informationOverrides: ReturnType<typeof listingInformationOverrideReview> = []
  if (remote) {
    const admin = await shopifyAdmin(destination.accountId); domain = admin.domain
    const schema = await readLinkedStoreSchema(admin.graphql)
    shopify = await readRemoteProduct(admin.graphql, data.publish.productId ?? (data.draft.target === 'linked-product' ? data.listing?.externalListingId : null), identity)
    validateListingInformationOverrides(data.listings, destination.accountId, schema, !shopify)
    informationOverrides = listingInformationOverrideReview(data.listings, destination.accountId, schema)
    if (shopify) {
      const source = { accountId: destination.accountId, familyId: data.family.id, productId: shopify.id, variantIds: data.publish.variantIds ?? {}, listings: data.listings }
      informationDraft = await listingInformationDraft(admin.graphql, source, schema)
      translationDraft = await listingInformationTranslations(admin.graphql, source, schema)
    }
    const response = await admin.graphql(`query NexusLocations { locations(first:250) { nodes { id name isActive } pageInfo { hasNextPage } } shopLocales { locale primary published } }`)
    if (response.locations.pageInfo.hasNextPage) throw new WorkspaceScopeError('The location list is incomplete; choose a location after reconciling it.', 422)
    locations = response.locations.nodes.filter((l: any) => l.isActive)
    if (response.shopLocales.find((l: any) => l.primary)?.locale !== data.draft.defaultLocale) data.errors.push('The document’s default language must match the Shopify store’s primary language.')
    for (const locale of data.draft.locales) if (!response.shopLocales.some((l: any) => l.locale === locale && l.published)) data.errors.push(`Shopify language ${locale} is not published in this store.`)
  }
  return { ...publicContent(data), identity, domain, locations, remote: shopify, remoteRevision: remote ? digest([shopify, informationDraft, translationDraft]) : null, informationDraft, translationDraft, informationOverrides,
    changes: { variants: data.variants.map(v => ({ ...v, resolved: resolveShopifyContent(data.draft, v) })), metafieldDefinitions: data.draft.fields, reusableEntries: data.draft.metaobjects.length,
      newProductStatus: nativeListingValue(data.listing, 'status', 'DRAFT'), requiresActiveConfirmation: !!shopify && shopify.status !== 'DRAFT' || ['ACTIVE', 'ARCHIVED'].includes(String(nativeListingValue(data.listing, 'status', 'DRAFT'))), preservesUnmanagedMedia: true, preservesUnmanagedMetafields: true },
  }
}

/** Same path for the editor, wizard and scheduled sync. The request must name its observed local and remote revisions. */
export async function synchronizeContent(productId: string, scope: ContentScope, body: unknown) {
  const input = object(body)
  const linkedDestination = await contentDestination(productId, scope)
  const linkedListing = await prisma.channelListing.findFirst({ where: { productId: linkedDestination.familyId, channel: 'SHOPIFY', marketplace: linkedDestination.marketplace, channelConnectionId: linkedDestination.accountId, aliasKey: linkedDestination.aliasKey ?? '' }, select: { platformAttributes: true } })
  const linkedIssue = shopifyInformationPublicationIssue(linkedListing?.platformAttributes)
  if (linkedIssue) throw new WorkspaceScopeError(linkedIssue, 422)
  if (typeof input.expectedRevision !== 'string' || typeof input.expectedRemoteRevision !== 'string' || typeof input.locationId !== 'string') throw new WorkspaceScopeError('Review the saved content and Shopify destination, then choose an inventory location.', 400)
  const preview = await previewContentSync(productId, scope, true)
  if (preview.revision !== input.expectedRevision || preview.remoteRevision !== input.expectedRemoteRevision) throw new WorkspaceScopeError('Nexus or Shopify changed after the preview. Refresh the review before synchronising.')
  if (preview.errors.length) throw new WorkspaceScopeError(preview.errors.join('\n'), 422)
  if (preview.changes.requiresActiveConfirmation && input.confirmActive !== true) throw new WorkspaceScopeError('This changes a live or archived product, or applies a saved Active/Archived status. Review and explicitly approve that destination first.', 422)
  const destination = await contentDestination(productId, scope)
  const storeSchema = await readShopifyMappingSchema(destination.accountId)
  const runId = randomUUID()
  const current = await prisma.$transaction(async tx => {
    const data = await readContent(tx, destination, storeSchema.locales, storeSchema)
    const informationIssue = shopifyInformationPublicationIssue(data.listing?.platformAttributes)
    if (informationIssue) throw new WorkspaceScopeError(informationIssue, 422)
    if (data.revision !== input.expectedRevision || !data.listing) throw new WorkspaceScopeError('Save the content and refresh the preview before synchronising.')
    if (data.listing.syncPaused || data.listing.syncLocked) throw new WorkspaceScopeError('Synchronisation is paused or locked for this listing.', 422)
    if (data.publish.status === 'PUBLISHING' && Date.now() - Date.parse(data.publish.lastCheckpointAt ?? data.publish.startedAt) < 20 * 60_000) throw new WorkspaceScopeError('A Shopify synchronisation is already running for this family.')
    const publication = { ...data.publish, status: 'PUBLISHING', runId, startedAt: new Date().toISOString(), error: null, locationId: input.locationId }
    const saved = await tx.channelListing.updateMany({ where: { id: data.listing.id, version: data.listing.version }, data: { version: { increment: 1 }, platformAttributes: { ...object(data.listing.platformAttributes), [PUBLISH_KEY]: publication } as Prisma.InputJsonValue } })
    if (saved.count !== 1) throw new WorkspaceScopeError('Another request started synchronisation. Reload its result.')
    return data
  }, { isolationLevel: 'Serializable' })
  const listingId = current.listing!.id
  const checkpoint = async (patch: Record<string, unknown>) => {
    await prisma.$transaction(async tx => {
      const row = await tx.channelListing.findUnique({ where: { id: listingId } })
      const pa = object(row?.platformAttributes), state = object(pa[PUBLISH_KEY])
      if (!row || state.runId !== runId || digest(pa[CONTENT_KEY]) !== current.storedDocumentRevision) throw new Error('The content publication changed ownership. Read back Shopify before retrying.')
      const saved = await tx.channelListing.updateMany({ where: { id: listingId, version: row.version }, data: { version: { increment: 1 }, platformAttributes: { ...pa, [PUBLISH_KEY]: { ...state, ...patch, lastCheckpointAt: new Date().toISOString() } } as Prisma.InputJsonValue,
        ...(typeof patch.productId === 'string' && (!row.externalListingId || preview.remote?.status === 'ACTIVE') ? { externalListingId: patch.productId.split('/').at(-1), platformProductId: patch.productId.split('/').at(-1) } : {}) } })
      if (saved.count !== 1) throw new Error('A concurrent listing update interrupted the publication checkpoint. Read back Shopify before retrying.')
    }, { isolationLevel: 'Serializable' })
  }
  try {
    const { graphql } = await shopifyAdmin(destination.accountId)
    const listing = current.listing!
    // Verify existing field baselines before product publication changes any of them.
    const reviewedInformation = preview.informationDraft ? await buildLinkedPlan(graphql, preview.informationDraft) : null
    const reviewedTranslations = preview.translationDraft ? await buildLinkedPlan(graphql, preview.translationDraft) : null
    const result = await publishContent(graphql, { identity: preview.identity,
      title: listing.followMasterTitle ? current.family.name : listing.titleOverride ?? listing.title ?? current.family.name,
      description: listing.followMasterDescription ? current.family.description ?? '' : listing.descriptionOverride ?? listing.description ?? current.family.description ?? '',
      vendor: String(nativeListingValue(listing, 'vendor', current.family.brand) ?? ''),
      productType: String(nativeListingValue(listing, 'productType', object(current.family.categoryAttributes).shopify_product_type) ?? ''),
      tags: nativeListingValue(listing, 'tags') as string[] | undefined, content: current.draft, variants: current.variants,
      reconcileGallery: current.listings.some(l => Object.keys(object(object(l.platformAttributes)._productMediaLocales)).length > 0),
      managedMediaIds: current.publish.status !== 'VERIFIED' && Array.isArray(current.publish.managedMediaIds) ? current.publish.managedMediaIds : Object.values(object(current.publish.mediaIds)).filter((id): id is string => typeof id === 'string'),
      galleryOperation: current.publish.galleryOperation,
      locationId: input.locationId, remote: preview.remote, confirmActive: input.confirmActive === true,
    }, checkpoint)
    const informationSource = { accountId: destination.accountId, familyId: current.family.id, productId: result.productId, variantIds: result.variantIds, listings: current.listings }
    if (!preview.informationDraft) {
      // New products need their reviewed category before constrained metafields can be written.
      const initial = await listingInformationDraft(graphql, informationSource, await readLinkedStoreSchema(graphql))
      const category = initial.nativeEdits?.find(e => e.field === 'category')
      if (category) { await applyNativeEdit(graphql, category, runId); await checkpoint({ categoryInitialized: true }) }
    }
    const informationDraft = preview.informationDraft ?? await listingInformationDraft(graphql, informationSource, await readLinkedStoreSchema(graphql))
    // A product created in this operation has newly allocated exact owner IDs. Existing products
    // keep the baselines included in the reviewed remote revision, including absent metafields.
    const information = reviewedInformation ?? await buildLinkedPlan(graphql, informationDraft)
    await checkpoint({ informationDraft, informationCompleted: 0 })
    for (let offset = 0; offset < information.changes.length; offset += 25) {
      await applyLinkedBatch(graphql, information.changes.slice(offset, offset + 25), await readLinkedStoreSchema(graphql))
      await checkpoint({ informationCompleted: Math.min(offset + 25, information.changes.length) })
    }
    for (const [index, edit] of (information.nativeEdits ?? []).entries()) {
      await applyNativeEdit(graphql, edit, runId)
      await checkpoint({ informationCompleted: information.changes.length + index + 1 })
    }
    const translations = reviewedTranslations ?? await buildLinkedPlan(graphql, await listingInformationTranslations(graphql, { accountId: destination.accountId, familyId: current.family.id, productId: result.productId, variantIds: result.variantIds, listings: current.listings }, await readLinkedStoreSchema(graphql)))
    for (const [index, edit] of (translations.nativeEdits ?? []).entries()) {
      await applyNativeEdit(graphql, edit, runId)
      await checkpoint({ translationsCompleted: index + 1 })
    }
    // Information overrides can change status after product creation/publication. Record the
    // verified final status, and retain exact variant identities for drafts as well as live products.
    const verifiedProduct = await readRemoteProduct(graphql, result.productId, preview.identity)
    if (!verifiedProduct) throw new WorkspaceScopeError('The synchronized Shopify product could not be read back.', 502)
    const isPublished = verifiedProduct.status === 'ACTIVE'
    await prisma.$transaction(async tx => {
      for (const variant of current.variants) {
        const existing = await tx.channelListing.findFirst({ where: { productId: variant.id, channel: 'SHOPIFY', marketplace: destination.marketplace, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' } })
        const platformAttributes = { ...object(existing?.platformAttributes), nexusFamilyId: current.family.id, variantId: result.variantIds[variant.id].split('/').at(-1), inventoryItemId: result.inventoryItemIds[variant.id].split('/').at(-1), shopifyProductId: result.productId.split('/').at(-1), inventoryLocationId: input.locationId } as Prisma.InputJsonValue
        const mapping = { platformAttributes, externalListingId: result.productId.split('/').at(-1), platformProductId: result.productId.split('/').at(-1), isPublished }
        if (existing) await tx.channelListing.update({ where: { id: existing.id }, data: { ...mapping, version: { increment: 1 } } })
        else await tx.channelListing.create({ data: { ...mapping, productId: variant.id, channel: 'SHOPIFY', marketplace: destination.marketplace, channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', aliasId: destination.aliasKey } })
      }
      const parent = await tx.channelListing.findUniqueOrThrow({ where: { id: listingId } })
      await tx.channelListing.update({ where: { id: listingId }, data: { version: { increment: 1 }, isPublished, platformAttributes: { ...object(parent.platformAttributes), nexusFamilyId: current.family.id, inventoryLocationId: input.locationId } as Prisma.InputJsonValue } })
    }, { isolationLevel: 'Serializable' })
    await checkpoint({ ...result, error: null })
    return { success: true, ...result, message: `Verified ${current.variants.length} native Shopify variants. Storefront theme verification is a separate review.` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await checkpoint({ status: 'UNVERIFIED', error: message }).catch(() => {})
    throw new WorkspaceScopeError(`Synchronisation is unverified. Some Shopify steps may have completed; refresh the remote review before retrying. ${message}`, 502)
  }
}
