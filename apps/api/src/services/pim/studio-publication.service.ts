import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { blockingIssues, isPhotoChangeId, type StudioPublishReview, type StudioPublishResult, type StudioPublishScope, type StudioPublishSelection } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { readPublicationFacts, publicationDigest, object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { STILL_DRAFT_LISTING } from '@nexus/shared/push-lock'
import { ensureDraftListings } from './draft-listing.service.js'
import { prepareAmazonPublication, sendAmazonPublication, readAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'
import { prepareEbayPublication, sendEbayPublication, readEbayPublication, prepareEbayInventoryPublication, usesEbayInventory, type EbayPublication, type EbayInventoryPublication } from './studio-publication-ebay.js'
import { prepareEbayInventoryChanges } from './studio-publication-ebay-inventory-changes.js'
import { ebayInventoryReads, sendEbayInventoryGroup } from './studio-publication-ebay-inventory.js'
import { readPublicationOverwrite } from './studio-publication-overwrite.js'
import { recordPublicationRequests, settlePublicationRecords, type PublicationRecordContext } from './studio-publication-records.js'
import { readPublicationBaseline } from './studio-publication-baseline.js'
import { sharedListingWarnings } from '../assortment/shared-listing-warning.js'
import { prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { compileSelection, type EbayInventorySend, type PublicationChangePlan } from './studio-publication-selection.js'
import { verifyNewEbayListing } from './studio-publication-ebay-verify.js'

const KIND = 'studio-publication'
const IN_FLIGHT = ['PUBLISHING', 'UNVERIFIED', 'SUBMITTED']
const RECEIPT_DEADLINE_MS = 30 * 60_000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const publishMode = (channel: string) => channel === 'AMAZON' ? getAmazonPublishMode() : channel === 'EBAY' ? getEbayPublishMode() : channel === 'SHOPIFY' ? getShopifyPublishMode() : 'unavailable'
type Prepared = AmazonPublication | EbayPublication | EbayInventoryPublication | EbayInventorySend | { kind: 'shopify'; revision: string; remoteRevision: string | null; initialized: boolean; draft: unknown; products: Array<{ productId: string; sku: string }> }

const recordContext = (id: string, data: Record<string, any>, userId: string | null): PublicationRecordContext => ({
  reviewId: id, userId, channel: data.scope.channel, marketplace: data.scope.marketplace,
  accountId: data.scope.accountId, aliasKey: data.delivery?.aliasKey ?? '',
})

/**
 * Channels whose accepted SKU turns its still-draft row into a live listing here: Amazon only. eBay
 * Trading does it in `reconcileEbayReceipt` with the ItemID. Shopify's synchronisation writes every
 * delivered row itself, with the Shopify ids and the status Shopify verified (ACTIVE, or INACTIVE for a
 * Shopify draft), so promoting here could only overrule an honest INACTIVE.
 */
const PROMOTE_ON_ACCEPTANCE = new Set(['AMAZON'])

/**
 * The rows whose SKU the channel accepted in this publication — per SKU, as the settled records say —
 * become published, ACTIVE and unpaused, but only while they are still drafts (DRAFT, unpublished,
 * no channel id). A live listing is never one, so an operator's own pause on it is never undone.
 * Returns the rows it promoted.
 */
async function promoteAcceptedDrafts(tx: Prisma.TransactionClient, context: PublicationRecordContext): Promise<string[]> {
  if (!PROMOTE_ON_ACCEPTANCE.has(context.channel)) return []
  const accepted = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', outcome: 'ACCEPTED',
    channel: context.channel, marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } },
  select: { channelListingId: true } })
  if (!accepted.length) return []
  const destination = { channel: context.channel, marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey, ...STILL_DRAFT_LISTING }
  const drafts = await tx.channelListing.findMany({ where: { id: { in: accepted.map(row => row.channelListingId) }, ...destination }, select: { id: true } })
  if (!drafts.length) return []
  const ids = drafts.map(row => row.id)
  await tx.channelListing.updateMany({ where: { id: { in: ids }, ...destination },
    data: { isPublished: true, listingStatus: 'ACTIVE', syncPaused: false, version: { increment: 1 } } })
  return ids
}

/**
 * Amazon's processing report names no ASIN, so a promoted row reads its own from Amazon once the promotion has
 * COMMITTED — never inside the transaction, and without holding up the status response. A row Amazon has not made
 * visible yet is retried by the ASIN sweep (`amazon-asin-fill.job.ts`).
 */
function fillPromotedAsins(listingIds: string[]) {
  void import('../amazon/listing-asin-fill.service.js')
    .then(({ fillAmazonListingAsins }) => fillAmazonListingAsins(listingIds))
    .catch(error => logger.warn('studio publication: ASIN read after promotion failed; the ASIN sweep retries it', { error: error instanceof Error ? error.message : String(error) }))
}

/**
 * Round 5 (2026-10-01) — the drafts that just went live: the price changes their publication did not carry (a following
 * draft's rule price that is not the master price, a sale) were kept in Nexus as held rows; the price door sends each
 * ONCE now (`sendHeldPrices`). Loaded here, not at the top: the door's module loads the outbound queue. Never throws.
 */
async function heldPricesAfterGoLive(listingIds: string[], userId: string | null) {
  try {
    const { sendHeldPrices } = await import('./channel-price-write.service.js')
    await sendHeldPrices({ listingIds, actor: userId ?? 'publish', cause: 'publish' })
  } catch (error) {
    logger.warn('studio publication: held prices not sent after go-live; the next resume or price change sends them', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Receipt and accepted baseline move together; legacy operations never acquire an invented send record. */
async function storeResult(id: string, data: Record<string, any>, userId: string | null, result: StudioPublishResult, statuses: string[]) {
  let promoted: string[] = []
  const stored = await prisma.$transaction(async tx => {
    const stored = await tx.bulkOperation.updateMany({ where: { id, status: { in: statuses } },
      data: { status: result.status, completedAt: IN_FLIGHT.includes(result.status) ? null : new Date(), changes: json({ ...data, result }) } })
    if (stored.count && data.captureVersion === 1) {
      const context = recordContext(id, data, userId)
      await settlePublicationRecords(tx, context, result)
      promoted = await promoteAcceptedDrafts(tx, context)
    }
    return stored
  })
  if (promoted.length) {
    fillPromotedAsins(promoted)
    // Round 5 — a price change the publication did not carry (a following draft's rule price, a sale), kept in Nexus
    // while the row was a draft, is sent once now that it is live. Never throws.
    await heldPricesAfterGoLive(promoted, userId)
  }
  return stored
}

async function reconcileEbayReceipt(data: Record<string, any>, previous: StudioPublishResult, userId: string | null): Promise<StudioPublishResult> {
  const reference = previous.results[0]?.reference
  if (!reference || !data.delivery) return previous
  const receipt = await readEbayPublication(reference, data.scope.accountId, data.scope.marketplace)
  if (!receipt) return previous
  const warnings = [...new Set([...(previous.warnings ?? []), ...receipt.warnings])]
  if (!receipt.verified) return { ...previous, warnings, status: 'UNVERIFIED', message: `eBay acknowledged item ${reference}, but its active listing status could not be confirmed. Review the channel messages before publishing again.` }
  // Idempotent recovery after a receipt was stored but the local listing update failed.
  const destination = { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey }
  const live = { externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE', version: { increment: 1 } } as const
  // A still-draft becomes the live listing and loses the pause that kept it inert. It runs first: once promoted, a row
  // no longer matches the second write, so no row is bumped twice. Any other row keeps its own pause.
  const drafts = (await prisma.channelListing.findMany({ where: { ...destination, ...STILL_DRAFT_LISTING }, select: { id: true } })).map(row => row.id)
  await prisma.channelListing.updateMany({ where: { ...destination, ...STILL_DRAFT_LISTING }, data: { ...live, syncPaused: false } })
  await prisma.channelListing.updateMany({ where: { ...destination,
    OR: [{ externalListingId: null }, { externalListingId: { not: reference } }, { isPublished: false }, { listingStatus: { not: 'ACTIVE' } }] },
    data: live })
  // Round 5 — a held price change the publication did not carry is sent once the drafts are live (only those still held
  // rows whose listing is live now are sent; a second reconcile finds none left). Never throws.
  if (drafts.length) await heldPricesAfterGoLive(drafts, userId)
  const projected = await prisma.channelListing.count({ where: { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey,
    externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE' } })
  if (projected !== new Set(data.delivery.productIds).size) throw new Error('The channel receipt is saved, but a local listing is missing from this destination. Restore its listing before checking again.')
  return { ...previous, status: 'ACCEPTED', warnings, message: `eBay accepted item ${reference} and reports it active.` }
}

/**
 * Publish without surprises (audit P1/P9) — what a refused prepare step tells the review. The eBay builder names EVERY
 * problem it found (`issues`) and the notes it made on the way (`notes`); "sending is off" (`gateOnly`) is already the
 * review's one gate message, so it adds nothing but its notes. Any other refusal is one message, as before.
 */
function refusalIssues(error: unknown): StudioPublishReview['issues'] {
  const found = error as { issues?: unknown; notes?: unknown; gateOnly?: unknown } | null
  const notes = Array.isArray(found?.notes) ? (found!.notes as string[]).map(message => ({ severity: 'warning' as const, message })) : []
  if (Array.isArray(found?.issues)) return [...(found!.issues as StudioPublishReview['issues']), ...notes]
  if (found?.gateOnly === true) return notes
  return [{ severity: 'error', message: error instanceof Error ? error.message : String(error) }, ...notes]
}

/** The one sentence a review shows when this server does not send to the channel (audit P9: it was said twice for eBay). */
const gateMessage = (channel: string, mode: string) => mode === 'unavailable' ? 'Publication is unavailable for this channel.'
  : `Sending is off: publishing to ${channel === 'EBAY' ? 'eBay' : channel === 'AMAZON' ? 'Amazon' : channel === 'SHOPIFY' ? 'Shopify' : channel} is ${mode === 'gated' ? 'turned off' : `in ${mode} mode`} on this server. Every check above ran; nothing will be sent until live publishing is turned on.`

/**
 * `verify` (the preview only): a NEW eBay listing whose own checks pass is checked by eBay too (VerifyAddFixedPriceItem,
 * which creates nothing), so its problems are in this review, not at the send. The send runs eBay's check again.
 */
async function buildReview(productId: string, scope: StudioPublishScope, options: { verify?: boolean } = {}) {
  const facts = await readPublicationFacts(productId, scope)
  const mode = publishMode(scope.channel)
  const issues = [...facts.issues]
  // Sharing studio step 5 — the same shared product already live on this channel in the other business (a warning).
  issues.push(...await sharedListingWarnings(facts.parent.id, scope.channel, scope.marketplace))
  const existingProducts = new Set(facts.listings.filter(listing => listing.externalListingId).map(listing => listing.productId))
  let prepared: Prepared | null = null
  let changePlan: PublicationChangePlan | null = null
  let baselineRevision: string | null = null
  let locations: StudioPublishReview['locations'], visibility: string | undefined
  try {
    if (scope.channel === 'AMAZON') prepared = await prepareAmazonPublication(facts)
    else if (scope.channel === 'EBAY') {
      prepared = usesEbayInventory(facts) ? await prepareEbayInventoryPublication(facts) : await prepareEbayPublication(facts)
      if (prepared.kind === 'ebay') for (const message of prepared.notices ?? []) issues.push({ severity: 'warning', message })
    }
    else if (scope.channel === 'SHOPIFY') {
      if (facts.excluded) throw new Error('This Shopify family has excluded variants. Review the family selection before publishing.')
      const { previewContentSync } = await import('../shopify/content-sync.service.js')
      const preview = await previewContentSync(productId, { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }, true)
      if (preview.remote || facts.listings.some(listing => listing.externalListingId))
        issues.push({ severity: 'error', message: 'Change-only publishing for existing Shopify products is not available yet. Shopify remains gated while its linked products are prepared.' })
      for (const message of preview.errors) issues.push({ severity: 'error', message })
      locations = preview.locations.filter(l => l.isActive).map(({ id, name }) => ({ id, name }))
      if (!locations.length) issues.push({ severity: 'error', message: 'This Shopify store has no active inventory location.' })
      visibility = String(preview.changes.newProductStatus)
      const products = facts.products.map(product => {
        const variants = preview.variants.filter(variant => variant.id === product.id)
        if (variants.length > 1 || (!variants.length && product.id !== facts.parent.id)) throw new Error(`${product.sku}: the Shopify variant identity is unavailable.`)
        // A grouped parent is a family content owner; sellable variants use the SKU actually sent by the native publisher.
        return { productId: product.id, sku: variants[0]?.sku ?? product.sku }
      })
      prepared = { kind: 'shopify', revision: preview.revision, remoteRevision: preview.remoteRevision, initialized: preview.initialized, draft: preview.draft, products }
    } else issues.push({ severity: 'error', message: `Direct publishing to ${scope.channel === 'ETSY' ? 'Etsy' : scope.channel === 'WOOCOMMERCE' ? 'WooCommerce' : scope.channel} is not available yet. Your product changes are saved in the studio.` })
    if (prepared && prepared.kind !== 'shopify') {
      // An Inventory listing is reviewed and sent by its owner alone (`prepareEbayInventoryChanges` addresses every change
      // to it), so its baseline is the owner's. Judged against all included products, a family failed every review.
      const owner = prepared.kind === 'ebay-inventory' ? prepared.owner.productId : null
      const baselineFacts = owner ? { ...facts, products: facts.products.filter(product => product.id === owner) } : facts
      const baseline = await readPublicationBaseline(baselineFacts, prepared.products)
      baselineRevision = baseline.revision
      changePlan = prepared.kind === 'amazon' ? await prepareAmazonChanges(facts, prepared, baseline.values)
        : prepared.kind === 'ebay-inventory' ? prepareEbayInventoryChanges({ owner: prepared.owner, ours: prepared.ours, live: prepared.live, destination: prepared.destination, baselineValues: baseline.values })
        : await prepareEbayChanges(facts, prepared as EbayPublication, baseline.values)
      if (changePlan.kind === 'amazon-changes') for (const product of changePlan.products) {
        if (product.newListing === false) existingProducts.add(product.productId)
      }
      if (changePlan.kind === 'amazon-changes' && changePlan.changes.some(change => change.field === 'variation_theme' && change.status !== 'SAME'
        && existingProducts.has(change.productId)))
        issues.push({ severity: 'warning', field: 'variation_theme', message: 'Changing a live variation theme can regroup its variants. Review the variation relationships before publishing.' })
    }
  } catch (error) { issues.push(...refusalIssues(error)) }
  // Audit P1 — eBay's own check, only once Nexus's checks found nothing that blocks (else eBay would name the same gaps again).
  if (options.verify && prepared?.kind === 'ebay' && !prepared.itemId && mode === 'live' && !issues.some(issue => issue.severity === 'error'))
    issues.push(...await verifyNewEbayListing(prepared, scope.accountId))
  if (mode !== 'live') issues.push({ severity: 'error', message: gateMessage(scope.channel, mode) })
  const overwrite = await readPublicationOverwrite(facts)
  const review: StudioPublishReview = {
    id: null, productId, scope, accountLabel: facts.account.displayName, aliasLabel: facts.aliasLabel, mode,
    action: existingProducts.size ? 'update' : 'create', excluded: facts.excluded,
    changes: changePlan?.changes, skipped: facts.skipped,
    rows: facts.products.map(p => ({ productId: p.id, sku: p.sku,
      title: String(facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.title?.value ?? facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.item_name?.value ?? p.name ?? p.sku),
      existing: existingProducts.has(p.id) })),
    issues: [...new Map(issues.map(i => [JSON.stringify(i), i])).values()], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), locations, visibility, overwrite,
  }
  return { facts, review, prepared, changePlan, revision: publicationDigest([facts.revision, changePlan ?? prepared, baselineRevision, mode, overwrite]) }
}

/** A durable review also owns retries, across API processes and browser reconnects. */
export async function previewStudioPublication(productId: string, scope: StudioPublishScope, userId: string | null): Promise<StudioPublishReview> {
  if (scope.channel === 'SHOPIFY') {
    // Materialize the existing content model's default draft so remote identity and revision
    // match the subsequent send. This saves only in Nexus; it makes no Shopify mutation.
    const { getContentWorkspace, saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
    const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
    const workspace = await getContentWorkspace(productId, contentScope)
    if (!workspace.initialized) await saveContentWorkspace(productId, contentScope, { draft: workspace.draft, expectedRevision: workspace.revision })
  }
  const plan = await buildReview(productId, scope, { verify: true })
  const id = randomUUID()
  const key = publicationDigest([workspaceIdForQuery(), plan.facts.destination.familyId, scope.channel, scope.accountId, scope.marketplace, plan.facts.destination.aliasKey])
  const unresolved = await prisma.bulkOperation.findFirst({ where: { status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: key } }, select: { id: true, userId: true } })
  if (unresolved) return { ...plan.review, ...(unresolved.userId === userId ? { previousPublicationId: unresolved.id } : {}), issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). ${unresolved.userId === userId ? 'Check its status before publishing again.' : 'Ask the colleague who submitted it to check its status.'}` }] }
  // P4c — errors that each name a field (an off-list Season value) block that field, not the listing: on a change-only
  // review the photos can still be sent. Any error that names no field blocks the review as before.
  const errors = plan.review.issues.filter(i => i.severity === 'error')
  const photosOnly = errors.length > 0 && errors.every(i => i.field) && !!plan.changePlan && !!plan.review.changes?.some(c => c.selectable && isPhotoChangeId(c.id))
  if (!plan.prepared || (errors.length && !photosOnly)) return plan.review
  const review = { ...plan.review, id, ...(photosOnly ? { photosOnly: true } : {}) }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: plan.review.rows.length, changeCount: 0,
    expiresAt: new Date(plan.review.expiresAt), changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision,
      changeVersion: plan.changePlan ? 1 : null, changePlan: plan.changePlan, review }) } })
  return review
}

/** The exact wire preview is compiled from the saved review. No channel reads or writes occur here. */
export async function previewStudioPublicationSelection(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishSelection> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') throw new WorkspaceScopeError('This publication has already started. Check its result.')
  if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current values again.')
  if (data.changeVersion !== 1 || !data.changePlan) throw new WorkspaceScopeError('Refresh the review to choose the fields to publish.')
  const ids = object(body).selectedIds
  if (!Array.isArray(ids) || ids.length > 50_000 || ids.some(id => typeof id !== 'string' || id.length > 2_000))
    throw new WorkspaceScopeError('Choose valid fields from this review.', 400)
  if (object(data.review).photosOnly === true && !ids.every(value => isPhotoChangeId(value as string)))
    throw new WorkspaceScopeError('Other fields of this listing have problems (listed in the review). Choose only photos, or fix them first.', 422)
  let compiled: ReturnType<typeof compileSelection>
  try { compiled = compileSelection(data.changePlan, ids, id) }
  catch (error) { throw new WorkspaceScopeError(error instanceof Error ? error.message : String(error), 400) }
  const selection = { ...compiled.selection, token: randomUUID() }
  const stored = await prisma.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW', changes: { equals: operation.changes! } },
    data: { changeCount: selection.fieldCount, changes: json({ ...data, selection, selectionDigest: publicationDigest(compiled) }) } })
  if (stored.count !== 1) throw new WorkspaceScopeError('The selection changed in another request. Review your selection again.')
  return selection
}

export async function studioPublicationResult(productId: string, id: string, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication not found.', 404)
  if (data.result) {
    const previous = data.result as StudioPublishResult
    if (operation.status === 'UNVERIFIED' && data.scope.channel === 'EBAY' && data.inventory !== true && previous.results[0]?.reference) {
      const result = await reconcileEbayReceipt(data, previous, userId)
      await storeResult(id, data, userId, result, ['UNVERIFIED'])
      return result
    }
    if (operation.status === 'SUBMITTED' && data.scope.channel === 'AMAZON') {
      const reference = previous.results[0]?.reference
      if (reference) {
        const report = await readAmazonPublication(reference, data.scope.accountId, previous.results.map(r => r.sku))
        if (report) {
          const failed = report.results.filter(r => r.failed).length
          const result: StudioPublishResult = { id, status: failed === report.results.length ? 'FAILED' : failed ? 'PARTIAL' : 'ACCEPTED',
            message: failed ? `${failed} products were rejected by Amazon. Review the processing messages before publishing corrected values.` : `Amazon processed feed ${reference}. Storefront visibility is still determined by Amazon.`,
            results: report.results.map(r => ({ sku: r.sku, status: r.failed ? 'FAILED' : 'ACCEPTED', message: r.message, reference })) }
          await storeResult(id, data, userId, result, ['SUBMITTED'])
          return result
        }
      }
    }
    return previous
  }
  const startedAt = data.startedAt ? new Date(data.startedAt).getTime() : operation.createdAt?.getTime()
  if (operation.status === 'PUBLISHING' && startedAt && Date.now() - startedAt > RECEIPT_DEADLINE_MS) {
    const result: StudioPublishResult = { id, status: 'UNVERIFIED', message: 'The submission did not record a channel receipt within 30 minutes. It may have reached the channel. Check its submission history before retrying; Nexus will not send a duplicate automatically.', results: [] }
    const updated = await storeResult(id, data, userId, result, ['PUBLISHING'])
    return updated.count ? result : studioPublicationResult(productId, id, userId)
  }
  return { id, status: operation.status === 'PUBLISHING' ? 'PUBLISHING' : 'FAILED', message: operation.status === 'PUBLISHING' ? 'The channel is processing this publication. Check again for its result.' : 'This review has not been submitted.', results: [] }
}

export async function submitStudioPublication(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') return studioPublicationResult(productId, id, userId)
  if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current saved values again.')
  const originalChanges = json(operation.changes)
  const input = object(body)
  const sparse = ['AMAZON', 'EBAY'].includes(data.scope?.channel)
  if (sparse && (data.changeVersion !== 1 || !data.changePlan)) throw new WorkspaceScopeError('Refresh this review to choose the fields to publish.')
  if (sparse && (typeof input.selectionToken !== 'string' || input.selectionToken !== data.selection?.token))
    throw new WorkspaceScopeError('Review the exact selected changes before publishing. This selection token is missing or stale.', 400)
  const plan = await buildReview(productId, data.scope as StudioPublishScope)
  if (plan.revision !== data.revision) throw new WorkspaceScopeError('Saved information, the destination, channel settings or content-read evidence changed. Review the current values before publishing.')
  // A photos-only selection is not blocked by other fields' problems (P4c); everything else is, as before.
  const blockers = sparse ? blockingIssues(plan.review.issues, data.selection?.selectedIds) : plan.review.issues.filter(i => i.severity === 'error')
  if (blockers.length || !plan.prepared) throw new WorkspaceScopeError(blockers.map(i => i.message).join('\n') || 'Publication is unavailable.', 422)
  if (sparse) {
    if (!plan.changePlan) throw new WorkspaceScopeError('The change-only review is unavailable. Refresh the review.')
    const compiled = compileSelection(plan.changePlan, data.selection.selectedIds, id)
    if (publicationDigest(compiled) !== data.selectionDigest) throw new WorkspaceScopeError('The selected payload changed. Review the exact changes again.')
    if (!compiled.prepared || !compiled.selection.fieldCount || !compiled.selection.products.length)
      throw new WorkspaceScopeError('No fields are selected. Nothing will be sent.', 400)
    plan.prepared = compiled.prepared
  }
  if (!sparse && plan.review.overwrite?.requiresConfirmation && input.confirmOverwrite !== true) throw new WorkspaceScopeError('Confirm the overwrite warning for this review before publishing.', 400)
  if (plan.prepared.kind === 'shopify' && !plan.review.locations?.some(l => l.id === input.locationId)) throw new WorkspaceScopeError('Choose an inventory location from this Shopify store.', 400)
  data.confirmOverwrite = !sparse && plan.review.overwrite?.requiresConfirmation === true && input.confirmOverwrite === true
  data.startedAt = new Date().toISOString()
  data.delivery = { productIds: plan.prepared.products.map(p => p.productId), aliasKey: plan.facts.destination.aliasKey ?? '' }
  // An Inventory receipt names its group, not a Trading ItemID: a later status read must not re-verify it as one.
  data.inventory = plan.prepared.kind === 'ebay-inventory-send'
  data.captureVersion = 1
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `studio-publication:${data.publicationKey}`)
    const other = await tx.bulkOperation.findFirst({ where: { id: { not: id }, status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: data.publicationKey } }, select: { id: true } })
    if (other) throw new WorkspaceScopeError('Another publication is in progress or awaits verification. Check its result before sending again.')
    return (await tx.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW', changes: { equals: originalChanges } }, data: { status: 'PUBLISHING', changes: json(data) } })).count === 1
  })
  if (!claimed) {
    const latest = await prisma.bulkOperation.findFirst({ where: { id, userId } })
    if (latest?.status === 'PREVIEW') throw new WorkspaceScopeError('The selection changed while waiting to publish. Review the selected changes again.')
    return studioPublicationResult(productId, id, userId)
  }
  let result: StudioPublishResult
  let providerStarted = false
  let receipt: StudioPublishResult | undefined
  const context = recordContext(id, data, userId)
  const checkpoint = async (value: StudioPublishResult) => {
    receipt = value
    await prisma.$transaction(async tx => {
      await tx.bulkOperation.update({ where: { id }, data: { status: value.status, changes: json({ ...data, result: value }) } })
      await settlePublicationRecords(tx, context, value)
    })
  }
  // Journal FKs name only this destination. These drafts never establish channel presence. The one creator
  // (`ensureDraftListings`) starts exactly the delivered products that have no row here (`family: false`).
  const ensureDrafts = () => prisma.$transaction(tx => ensureDraftListings(tx, { channel: plan.facts.scope.channel, market: plan.facts.scope.marketplace,
    accountId: plan.facts.scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '', productIds: data.delivery.productIds, family: false }))
  try {
    const { scope } = plan.facts
    if (publishMode(scope.channel) !== 'live') throw new Error('Live publication was disabled before submission.')
    if ((await readPublicationFacts(productId, scope)).revision !== plan.facts.revision) throw new Error('Saved information changed while this publication was waiting. Review the current values before publishing.')
    if (plan.prepared.kind === 'shopify') {
      const shopify = plan.prepared
      const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
      let revision = plan.prepared.revision
      if (!plan.prepared.initialized) {
        const { saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
        const saved = await saveContentWorkspace(productId, contentScope, { draft: plan.prepared.draft, expectedRevision: revision })
        revision = saved.revision
      }
      const { synchronizeContent } = await import('../shopify/content-sync.service.js')
      let requestIndex = 0
      let journal = Promise.resolve()
      const sent = await synchronizeContent(productId, contentScope, { expectedRevision: revision, expectedRemoteRevision: plan.prepared.remoteRevision,
        locationId: input.locationId, confirmActive: true }, request => {
          const index = requestIndex++
          // The publisher may start independent mutations together. Their durable ordinals remain ordered.
          journal = journal.then(async () => {
            if (index === 0) await ensureDrafts()
            await recordPublicationRequests(context, shopify.products.map(p => ({ ...p, request })), index)
            providerStarted = true
          })
          return journal
        })
      result = { id, status: 'VERIFIED', message: `Shopify verified the saved product and variants. Visibility: ${plan.review.visibility}.`, results: shopify.products.map(r => ({ sku: r.sku, status: 'VERIFIED', message: 'Verified by Shopify', reference: sent.productId })) }
      receipt = result
    } else {
      // Creation stores a correctly attributed draft. Only provider results can establish publication.
      await ensureDrafts()
      providerStarted = true
      if (plan.prepared.kind === 'amazon') {
        const amazon = plan.prepared
        const reference = await sendAmazonPublication(amazon, scope.accountId, request => recordPublicationRequests(context, request.feed.messages.map(message => {
          const products = amazon.products.filter(product => product.sku === message.sku)
          if (products.length !== 1) throw new Error(`The exact product for Amazon seller SKU ${message.sku} could not be recorded.`)
          return { productId: products[0].productId, sku: message.sku, request: { feedType: request.feedType, marketplaceIds: request.marketplaceIds, header: request.feed.header, message,
            intentVersion: 1, writes: amazon.fieldWrites?.[products[0].productId] ?? [] } }
        })))
        result = { id, status: 'SUBMITTED', message: `Submitted to Amazon. Feed ${reference} is awaiting processing; the listing is not yet confirmed live.`,
          results: plan.prepared.feed.messages.map(message => ({ sku: message.sku, status: 'SUBMITTED', reference, message: 'Awaiting Amazon processing' })) }
        await checkpoint(result)
      } else if (plan.prepared.kind === 'ebay-inventory-send') {
        // PE P3.4 — one whole-group PUT built from the fresh live group; journal first, read back after. No offer is touched.
        const inventory = plan.prepared
        const receipt = await sendEbayInventoryGroup({ destination: inventory.destination, groupKey: inventory.groupKey, group: inventory.group, items: inventory.items,
          expectedRevision: inventory.expectedRevision, fields: inventory.fields, reads: ebayInventoryReads(scope.accountId, scope.marketplace, inventory.destination.itemId),
          beforeSend: request => recordPublicationRequests(context, inventory.products.map(p => ({ ...p, request: { ...request, intentVersion: 1, writes: inventory.fieldWrites[p.productId] ?? [] } }))) })
        result = { id, status: receipt.verified ? 'VERIFIED' : 'UNVERIFIED', warnings: receipt.warnings,
          message: receipt.verified ? 'eBay applied the change to this Inventory listing, and the read-back matches.'
            : 'eBay accepted the change, but the read-back did not confirm every field. Check the listing before publishing again.',
          results: inventory.products.map(row => ({ sku: row.sku, status: receipt.verified ? 'VERIFIED' : 'ACCEPTED', reference: receipt.reference,
            message: receipt.verified ? 'Read back from eBay' : 'Accepted by eBay; the read-back differs' })) }
        await checkpoint(result)
      } else {
        const ebay = plan.prepared as EbayPublication
        const sent = await sendEbayPublication(ebay, scope.accountId, id,
          request => recordPublicationRequests(context, ebay.products.map(p => ({ ...p, request: { ...request, intentVersion: 1, writes: ebay.fieldWrites?.[p.productId] ?? [] } }))))
        result = { id, status: 'UNVERIFIED', warnings: sent.warnings,
          message: `eBay acknowledged item ${sent.reference}. Its active listing status still needs checking.`,
          results: ebay.products.map(row => ({ sku: row.sku, status: 'ACCEPTED', reference: sent.reference, message: 'Acknowledged by eBay' })) }
        await checkpoint(result)
        result = await reconcileEbayReceipt(data, result, userId)
      }
    }
  } catch (error) {
    const refused = !providerStarted || (error as { notSent?: boolean })?.notSent === true
    result = receipt ? { ...receipt, status: receipt.status === 'SUBMITTED' ? 'SUBMITTED' : 'UNVERIFIED',
      message: `${receipt.message} Confirmation could not finish: ${error instanceof Error ? error.message : String(error)}` }
      : { id, status: refused ? 'FAILED' : 'UNVERIFIED', message: `${refused ? 'Nothing was submitted.' : 'Publication could not be verified. Check the channel before retrying:'} ${error instanceof Error ? error.message : String(error)}`, results: [] }
  }
  try {
    const stored = await storeResult(id, data, userId, result, IN_FLIGHT)
    // A status read may already have recorded a terminal processing report.
    return stored.count ? result : await studioPublicationResult(productId, id, userId)
  } catch (error) {
    if (!receipt) throw error
    // A database outage cannot erase the acknowledgement already returned by the channel.
    // Keep its reference visible without claiming that Nexus recorded the result durably.
    return { ...receipt, status: 'UNVERIFIED', message: `The channel returned a receipt, but Nexus could not record the final result. Keep this reference and check publication status before retrying: ${receipt.results.map(row => row.reference).filter((reference, index, all) => reference && all.indexOf(reference) === index).join(', ')}.` }
  }
}
