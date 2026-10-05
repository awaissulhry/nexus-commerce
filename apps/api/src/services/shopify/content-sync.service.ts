import { readShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import { assertListingContentReviewed } from '../pim/publish-review-gate.js'
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
import { publishContent, readRemoteProduct, shortId, type ShopifyRemoteProduct } from './content-publisher.js'
import { nativeListingValue } from './native-listing-value.js'
import { assertPublishAllowed, isStillDraftListing, type PushLockListing, type PushRefusal } from '@nexus/shared/push-lock'
import { graphqlRootField } from '../gateway/graphql-root-field.js'
import { isOnMediaPlan } from '../images/media-plan-switch.js'
import { noInheritedInformation, resolveInheritedInformation, type InheritedInformation } from './inherited-information.js'
import { resolveShopifyProductFacts, type ShopifyProductFacts } from './product-facts.js'
import { readShopifyCreateChoice } from './create-status.js'
import { SHOPIFY_CREATE_NOT_LISTED, type ShopifyCreateStatus } from '@nexus/shared/listing-actions'

function pushRefused(listing: PushLockListing, refusal: PushRefusal) {
  const intent = listing as PushLockListing & { presenceIntentAt?: Date | string | null; presenceIntentBy?: string | null }
  const sentence = intent.presenceIntent === 'ENDED'
    ? `This listing was deliberately ended${intent.presenceIntentAt ? ` on ${new Date(intent.presenceIntentAt).toISOString()}` : ''}${intent.presenceIntentBy ? ` by ${intent.presenceIntentBy}` : ''}. Relist it before sending changes.`
    : refusal.sentence
  return Object.assign(new WorkspaceScopeError(sentence, 409), { code: refusal.code, refusal: { ...refusal, sentence } })
}

/** PE P4.0 — `productSet` deletes the variants and options it does not name, so the whole-product publisher may only
 *  rewrite a product Nexus created: never the "linked-product" target, and never a listing tied to another product id. */
function wholeProductRefusal(data: { draft: { target?: string }; publish: Record<string, unknown>; listings: { externalListingId?: string | null }[] }) {
  const own = typeof data.publish.productId === 'string' ? shortId(data.publish.productId) : null
  if (data.draft.target !== 'linked-product' && data.listings.every(l => !l.externalListingId || l.externalListingId === own)) return null
  return new WorkspaceScopeError('This Shopify product was not created by Nexus. Nexus does not rewrite a store product as a whole; its changes go through Publish, which sends only the changed fields. Nothing was sent.', 409)
}

/**
 * `options.createStatus` (Wave 2 D4): Publish passes its own create status (the Status column's choice, or "New listings
 * start as"; null when Publish holds the product itself). Without it — the Media tab's "Create reviewed product", the
 * listing wizard — a product Shopify does not hold yet is created with the Status column's choice too, and Not listed
 * creates nothing (`SHOPIFY_CREATE_NOT_LISTED`). A stored Shopify status never decides a create.
 */
export async function previewContentSync(productId: string, scope: ContentScope, remote = false, options: { createStatus?: ShopifyCreateStatus | null } = {}) {
  const destination = await contentDestination(productId, scope)
  const cachedSchema = await readShopifyMappingSchema(destination.accountId)
  const data = await prisma.$transaction(tx => readContent(tx, destination, cachedSchema.locales, cachedSchema), { isolationLevel: 'RepeatableRead' })
  // Publish's lock (every caller here is an operator's send): a paused still-draft may be sent; any other pause refuses.
  for (const listing of data.listings) {
    const refusal = assertPublishAllowed(listing)
    if (refusal) throw pushRefused(listing, refusal)
  }
  const identity = `${data.listing?.workspaceId ?? 'nexus'}:${data.family.id}${destination.aliasKey ? ':' + destination.aliasKey : ''}`
  let shopify: ShopifyRemoteProduct | null = null, locations: { id: string; name: string; isActive: boolean }[] = [], domain: string | null = null
  let informationDraft: ShopifyLinkedDraft | null = null
  let translationDraft: ShopifyLinkedDraft | null = null
  let informationOverrides: Array<ReturnType<typeof listingInformationOverrideReview>[number] & { shared?: true }> = []
  let inherited: InheritedInformation = noInheritedInformation()
  let productFacts: ShopifyProductFacts | null = null
  let createStatus: ShopifyCreateStatus | null = null
  if (remote) {
    const admin = await shopifyAdmin(destination.accountId); domain = admin.domain
    const schema = await readLinkedStoreSchema(admin.graphql)
    shopify = await readRemoteProduct(admin.graphql, data.publish.productId ?? (data.draft.target === 'linked-product' ? data.listing?.externalListingId : null), identity)
    validateListingInformationOverrides(data.listings, destination.accountId, schema, !shopify)
    informationOverrides = listingInformationOverrideReview(data.listings, destination.accountId, schema)
    // S1 item 5 — what a NEW variant takes from Shared (barcode, cost, country, HS code, weight): sent when Shopify creates
    // it, listed with the typed values (marked Shared), and a value Shopify would refuse holds Publish with its reason.
    inherited = await resolveInheritedInformation({ accountId: destination.accountId, marketplace: destination.marketplace, aliasKey: destination.aliasKey, schema,
      variants: data.variants, listings: data.listings, remoteSkus: shopify?.variants?.nodes.map(variant => variant.sku) ?? [] })
    data.errors.push(...inherited.problems)
    informationOverrides = [...informationOverrides, ...inherited.review]
    // Wave 2 item 5 + D3 — brand, product type (and, for a create, the theme template) as the resolver reads them.
    productFacts = await resolveShopifyProductFacts({ familyId: data.family.id, accountId: destination.accountId, marketplace: destination.marketplace,
      aliasKey: destination.aliasKey, listing: data.listing, newProduct: !shopify, locale: schema.locales.find(l => l.primary)?.locale ?? data.draft.defaultLocale })
    data.errors.push(...productFacts.problems)
    informationOverrides = [...informationOverrides, ...productFacts.review]
    // Wave 2 D4 — a product Shopify does not hold yet is created with the Status column's choice: its stored Shopify
    // status is not sent, so the review does not list it.
    if (!shopify) {
      informationOverrides = informationOverrides.filter(entry => entry.type !== 'status')
      if ('createStatus' in options) createStatus = options.createStatus ?? null
      else {
        const choice = await readShopifyCreateChoice(data.family.id, destination)
        // Nexus still holds a Shopify id Shopify no longer answers for: created again as a Draft (never exposed unasked).
        createStatus = choice.onShopify ? 'DRAFT' : choice.status
        if (!choice.onShopify && !choice.status) data.errors.push(SHOPIFY_CREATE_NOT_LISTED)
      }
    }
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
  // The inherited values are part of what the operator reviews; a review without any keeps its earlier revision.
  const inheritedReview = Object.keys(inherited.values).length || inherited.problems.length ? [{ values: inherited.values, problems: inherited.problems }] : []
  // Wave 2 — what the create or the synchronization will send for the product's own facts, and a create's status, are
  // part of what the operator reviews: a change of either after the review refuses the send ("changed after the preview").
  const factsReview = productFacts ? [{ facts: { vendor: productFacts.vendor, productType: productFacts.productType, templateSuffix: productFacts.templateSuffix, problems: productFacts.problems }, ...(!shopify ? { createStatus } : {}) }] : []
  // A product Shopify holds keeps its own status path (the stored status, applied by a synchronization).
  const storedStatus = String(nativeListingValue(data.listing, 'status', 'DRAFT'))
  return { ...publicContent(data), identity, domain, locations, remote: shopify, remoteRevision: remote ? digest([shopify, informationDraft, translationDraft, ...inheritedReview, ...factsReview]) : null, informationDraft, translationDraft, informationOverrides,
    inheritedInformation: inherited.values, productFacts,
    changes: { variants: data.variants.map(v => ({ ...v, resolved: resolveShopifyContent(data.draft, v) })), metafieldDefinitions: data.draft.fields, reusableEntries: data.draft.metaobjects.length,
      // A new product: the status it is created with (null = nothing is created: the Status column says Not listed).
      newProductStatus: remote && !shopify ? createStatus : storedStatus,
      requiresActiveConfirmation: !!shopify && shopify.status !== 'DRAFT' || (remote && !shopify ? createStatus === 'ACTIVE' : ['ACTIVE', 'ARCHIVED'].includes(storedStatus)),
      preservesUnmanagedMedia: true, preservesUnmanagedMetafields: true },
  }
}

/** Same path for the editor, wizard and scheduled sync. The request must name its observed local and remote revisions. */
export async function synchronizeContent(productId: string, scope: ContentScope, body: unknown,
  beforeMutation?: (request: { query: string; variables: Record<string, unknown> }) => Promise<void>) {
  const input = object(body)
  const linkedDestination = await contentDestination(productId, scope)
  const linkedListing = await prisma.channelListing.findFirst({ where: { productId: linkedDestination.familyId, channel: 'SHOPIFY', marketplace: linkedDestination.marketplace, channelConnectionId: linkedDestination.accountId, aliasKey: linkedDestination.aliasKey ?? '' } })
  const refusal = assertPublishAllowed(linkedListing)
  if (refusal && linkedListing) throw pushRefused(linkedListing, refusal)
  const linkedIssue = shopifyInformationPublicationIssue(linkedListing?.platformAttributes)
  if (linkedIssue) throw new WorkspaceScopeError(linkedIssue, 422)
  if (typeof input.expectedRevision !== 'string' || typeof input.expectedRemoteRevision !== 'string' || typeof input.locationId !== 'string') throw new WorkspaceScopeError('Review the saved content and Shopify destination, then choose an inventory location.', 400)
  // D7 / R-LX-7 — one review verdict for every channel: an unreviewed machine
  // draft must not reach a Shopify translation any more than an Amazon payload.
  await assertListingContentReviewed({ productId: linkedDestination.familyId, channel: 'SHOPIFY', marketplace: linkedDestination.marketplace, accountId: linkedDestination.accountId })
  // Publish names the create status it reviewed; every other caller reads the Status column (`previewContentSync`).
  const chosen = input.createStatus === 'ACTIVE' || input.createStatus === 'DRAFT' ? input.createStatus as ShopifyCreateStatus : undefined
  const preview = await previewContentSync(productId, scope, true, chosen ? { createStatus: chosen } : {})
  if (preview.revision !== input.expectedRevision || preview.remoteRevision !== input.expectedRemoteRevision) throw new WorkspaceScopeError('Nexus or Shopify changed after the preview. Refresh the review before synchronising.')
  if (preview.errors.length) throw new WorkspaceScopeError(preview.errors.join('\n'), 422)
  if (preview.changes.requiresActiveConfirmation && input.confirmActive !== true) throw new WorkspaceScopeError('This synchronisation applies the saved status and sales channels to this listing. Review and explicitly approve that destination first.', 422)
  const destination = await contentDestination(productId, scope)
  const storeSchema = await readShopifyMappingSchema(destination.accountId)
  const runId = randomUUID()
  const current = await prisma.$transaction(async tx => {
    const data = await readContent(tx, destination, storeSchema.locales, storeSchema)
    const informationIssue = shopifyInformationPublicationIssue(data.listing?.platformAttributes)
    if (informationIssue) throw new WorkspaceScopeError(informationIssue, 422)
    if (data.revision !== input.expectedRevision || !data.listing) throw new WorkspaceScopeError('Save the content and refresh the preview before synchronising.')
    for (const listing of data.listings) {
      const refusal = assertPublishAllowed(listing)
      if (refusal) throw pushRefused(listing, refusal)
    }
    const wholeProduct = wholeProductRefusal(data)
    if (wholeProduct) throw wholeProduct
    // The product type Shopify would receive (`product-facts.ts`): the listing's own, else the resolver's.
    if (/^gid:\/\/shopify\//i.test(String(preview.productFacts?.productType ?? '').trim()))
      throw new WorkspaceScopeError('The Shopify product type holds a Shopify category id (gid://…). That is a data error: set the category in its own field and a plain product type, then publish. Nothing was sent.', 422)
    if (data.listing.syncLocked) throw new WorkspaceScopeError('Synchronisation is locked for this listing.', 422)
    if (data.publish.status === 'PUBLISHING' && Date.now() - Date.parse(data.publish.lastCheckpointAt ?? data.publish.startedAt) < 20 * 60_000) throw new WorkspaceScopeError('A Shopify synchronisation is already running for this family.')
    const publication = { ...data.publish, status: 'PUBLISHING', runId, startedAt: new Date().toISOString(), error: null, locationId: input.locationId }
    const saved = await tx.channelListing.updateMany({ where: { id: data.listing.id, version: data.listing.version }, data: { version: { increment: 1 }, platformAttributes: { ...object(data.listing.platformAttributes), [PUBLISH_KEY]: publication } as Prisma.InputJsonValue } })
    if (saved.count !== 1) throw new WorkspaceScopeError('Another request started synchronisation. Reload its result.')
    return data
  }, { isolationLevel: 'Serializable' })
  const listingId = current.listing!.id
  // Read before anything is sent: the checkpoint below stamps the Shopify product id on the family row mid-delivery,
  // so "was it still a draft" must be answered from this snapshot, not from the rows at the end.
  const stillDrafts = new Set(current.listings.filter(isStillDraftListing).map(listing => listing.id))
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
    const { graphql: send } = await shopifyAdmin(destination.accountId)
    const graphql: typeof send = async <T>(query: string, variables: Record<string, unknown> = {}) => {
      if (graphqlRootField(query).mutation) await beforeMutation?.({ query, variables })
      return send<T>(query, variables)
    }
    const listing = current.listing!
    // Verify existing field baselines before product publication changes any of them.
    const reviewedInformation = preview.informationDraft ? await buildLinkedPlan(graphql, preview.informationDraft) : null
    const reviewedTranslations = preview.translationDraft ? await buildLinkedPlan(graphql, preview.translationDraft) : null
    const result = await publishContent(graphql, { identity: preview.identity,
      title: listing.followMasterTitle ? current.family.name : listing.titleOverride ?? listing.title ?? current.family.name,
      description: listing.followMasterDescription ? current.family.description ?? '' : listing.descriptionOverride ?? listing.description ?? current.family.description ?? '',
      // Wave 2 item 5 + D3 — the reviewed facts (`product-facts.ts`): what the sheet shows is what Shopify receives.
      vendor: preview.productFacts!.vendor, productType: preview.productFacts!.productType,
      ...(!preview.remote ? { templateSuffix: preview.productFacts!.templateSuffix } : {}),
      tags: nativeListingValue(listing, 'tags') as string[] | undefined, content: current.draft, variants: current.variants,
      // Images rebuild P2f — a media-plan family's gallery is exactly the plan: managed media the plan dropped are removed.
      reconcileGallery: await isOnMediaPlan(current.family.id) || current.listings.some(l => Object.keys(object(object(l.platformAttributes)._productMediaLocales)).length > 0),
      managedMediaIds: current.publish.status !== 'VERIFIED' && Array.isArray(current.publish.managedMediaIds) ? current.publish.managedMediaIds : Object.values(object(current.publish.mediaIds)).filter((id): id is string => typeof id === 'string'),
      galleryOperation: current.publish.galleryOperation,
      locationId: input.locationId, remote: preview.remote, confirmActive: input.confirmActive === true,
      variantFacts: preview.inheritedInformation,
    }, checkpoint)
    const informationSource = { accountId: destination.accountId, familyId: current.family.id, productId: result.productId, variantIds: result.variantIds, listings: current.listings }
    if (!preview.informationDraft) {
      // New products need their reviewed category before constrained metafields can be written.
      const initial = await listingInformationDraft(graphql, informationSource, await readLinkedStoreSchema(graphql))
      const category = initial.nativeEdits?.find(e => e.field === 'category')
      if (category) { await applyNativeEdit(graphql, category, runId); await checkpoint({ categoryInitialized: true }) }
    }
    // S1 item 5 (e) — a product created here: the values its variants took from Shared are checked with the typed ones.
    const informationDraft = preview.informationDraft ?? await listingInformationDraft(graphql, { ...informationSource, inherited: preview.inheritedInformation }, await readLinkedStoreSchema(graphql))
    // New listings (Owner 2026-10-04), Wave 2 D4 — a product Shopify did not hold yet is created with the Status column's
    // choice (Publish's, or read by the review): ACTIVE (one status edit after the create), or DRAFT (as created; no status
    // edit). A stored Shopify status never decides a create.
    const createStatus = !preview.remote ? preview.changes.newProductStatus as ShopifyCreateStatus | null : null
    if (createStatus) {
      // Status is the product's own field (a variant has none): Publish's choice replaces any stored one.
      informationDraft.nativeEdits = (informationDraft.nativeEdits ?? []).filter(edit => edit.field !== 'status')
      if (createStatus === 'ACTIVE') informationDraft.nativeEdits.push({ ownerId: result.productId, productId: result.productId,
        ownerLabel: String(listing.title ?? current.family.name ?? 'Product'), field: 'status', value: 'DRAFT', nextValue: 'ACTIVE' })
    }
    // A product created in this operation has newly allocated exact owner IDs. Existing products
    // keep the baselines included in the reviewed remote revision, including absent metafields.
    const information = reviewedInformation ?? await buildLinkedPlan(graphql, informationDraft)
    // S1 item 5 (e) — an existing product's NEW variants: the reviewed plan above predates their Shopify ids, so the values
    // they took from Shared are checked now that Shopify has created them. A variant Shopify already held is never touched.
    const heldBefore = new Set(preview.remote?.variants?.nodes.map(variant => variant.id) ?? [])
    const createdHere = Object.fromEntries(Object.entries(preview.inheritedInformation).filter(([id]) => result.variantIds[id] && !heldBefore.has(result.variantIds[id])))
    const inheritedDraft = preview.informationDraft && Object.keys(createdHere).length
      ? await listingInformationDraft(graphql, { ...informationSource, listings: [], inherited: createdHere }, await readLinkedStoreSchema(graphql)) : null
    const inheritedEdits = inheritedDraft?.nativeEdits?.length ? (await buildLinkedPlan(graphql, inheritedDraft)).nativeEdits ?? [] : []
    const nativeEdits = [...(information.nativeEdits ?? []), ...inheritedEdits]
    await checkpoint({ informationDraft: inheritedEdits.length ? { ...informationDraft, nativeEdits: [...(informationDraft.nativeEdits ?? []), ...inheritedEdits] } : informationDraft, informationCompleted: 0 })
    for (let offset = 0; offset < information.changes.length; offset += 25) {
      await applyLinkedBatch(graphql, information.changes.slice(offset, offset + 25), await readLinkedStoreSchema(graphql))
      await checkpoint({ informationCompleted: Math.min(offset + 25, information.changes.length) })
    }
    for (const [index, edit] of nativeEdits.entries()) {
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
    const listingStatus = isPublished ? 'ACTIVE' : 'INACTIVE'
    await prisma.$transaction(async tx => {
      for (const variant of current.variants) {
        const existing = await tx.channelListing.findFirst({ where: { productId: variant.id, channel: 'SHOPIFY', marketplace: destination.marketplace, channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' } })
        const platformAttributes = { ...object(existing?.platformAttributes), nexusFamilyId: current.family.id, variantId: result.variantIds[variant.id].split('/').at(-1), inventoryItemId: result.inventoryItemIds[variant.id].split('/').at(-1), shopifyProductId: result.productId.split('/').at(-1), inventoryLocationId: input.locationId } as Prisma.InputJsonValue
        const mapping = { platformAttributes, externalListingId: result.productId.split('/').at(-1), platformProductId: result.productId.split('/').at(-1), isPublished, listingStatus }
        // A still-draft this delivery made real loses the pause that kept it inert; any other row keeps its own.
        if (existing) await tx.channelListing.update({ where: { id: existing.id }, data: { ...mapping, ...(stillDrafts.has(existing.id) ? { syncPaused: false } : {}), version: { increment: 1 } } })
        else await tx.channelListing.create({ data: { ...mapping, productId: variant.id, channel: 'SHOPIFY', marketplace: destination.marketplace, channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '', aliasId: destination.aliasKey } })
      }
      const parent = await tx.channelListing.findUniqueOrThrow({ where: { id: listingId } })
      // New listings — the status Shopify verified for a product created with Publish's choice, kept on the family row as
      // the engine's status change keeps it (the Status column reads Active, or Inactive "Draft in Shopify").
      await tx.channelListing.update({ where: { id: listingId }, data: { version: { increment: 1 }, isPublished, listingStatus, ...(stillDrafts.has(listingId) ? { syncPaused: false } : {}), platformAttributes: { ...object(parent.platformAttributes), nexusFamilyId: current.family.id, inventoryLocationId: input.locationId,
        ...(createStatus ? { status: verifiedProduct.status } : {}) } as Prisma.InputJsonValue } })
    }, { isolationLevel: 'Serializable' })
    await checkpoint({ ...result, error: null })
    return { success: true, ...result, message: `Verified ${current.variants.length} native Shopify variants. Storefront theme verification is a separate review.` }
  } catch (error) {
    const failure = syncFailure(error, current.publish.status)
    await checkpoint(failure.checkpoint).catch(() => {})
    throw failure.error
  }
}

/**
 * How a failed synchronisation is reported. A refusal raised BEFORE any Shopify write (`notSent`, e.g. the family-identity
 * field check) sent nothing: the listing keeps its earlier publication state and the refusal says only what to do — it
 * used to read "Nothing was submitted. Synchronisation is unverified. Some Shopify steps may have completed; …", which
 * contradicted itself (Lane B's development-store proof, 2026-09-28). Anything else may have reached Shopify: unverified.
 */
export function syncFailure(error: unknown, previousStatus: unknown): { checkpoint: Record<string, unknown>; error: Error } {
  const message = error instanceof Error ? error.message : String(error)
  if ((error as { notSent?: boolean } | null)?.notSent === true) {
    return { checkpoint: { status: previousStatus ?? null, error: message }, error: Object.assign(new WorkspaceScopeError(message, 422), { notSent: true }) }
  }
  return {
    checkpoint: { status: 'UNVERIFIED', error: message },
    error: new WorkspaceScopeError(`Synchronisation is unverified. Some Shopify steps may have completed; refresh the remote review before retrying. ${message}`, 502),
  }
}
