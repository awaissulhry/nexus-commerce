import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { blockingIssues, isPhotoChangeId, type StudioPublishReview, type StudioPublishResult, type StudioPublishScope, type StudioPublishSelection,
  type StudioPublishStoredReview } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { readPublicationFacts, publicationDigest, object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { ensureDraftListings } from './draft-listing.service.js'
import { prepareAmazonPublication, sendAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'
import { withSendQuantities } from './studio-publication-amazon-offer.js'
import { prepareEbayPublication, sendEbayPublication, prepareEbayInventoryPublication, usesEbayInventory, type EbayPublication, type EbayInventoryPublication } from './studio-publication-ebay.js'
import { prepareEbayInventoryChanges } from './studio-publication-ebay-inventory-changes.js'
import { ebayInventoryReads, sendEbayInventoryGroup } from './studio-publication-ebay-inventory.js'
import { readPublicationOverwrite } from './studio-publication-overwrite.js'
import { recordPublicationRequests, settlePublicationRecords } from './studio-publication-records.js'
import { PUBLICATION_KIND as KIND, IN_FLIGHT, OPEN_PUBLICATION, json, publicationSummary, recordContext, storeResult, reconcileEbayReceipt,
  settleStudioPublication, announcePublication, nextPublicationCheck } from './studio-publication-settle.js'
import { readPublicationBaseline } from './studio-publication-baseline.js'
import { sharedListingWarnings } from '../assortment/shared-listing-warning.js'
import { prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { compileSelection, type EbayInventorySend, type PublicationChangePlan } from './studio-publication-selection.js'
import { verifyNewEbayListing } from './studio-publication-ebay-verify.js'

const publishMode = (channel: string) => channel === 'AMAZON' ? getAmazonPublishMode() : channel === 'EBAY' ? getEbayPublishMode() : channel === 'SHOPIFY' ? getShopifyPublishMode() : 'unavailable'
type Prepared = AmazonPublication | EbayPublication | EbayInventoryPublication | EbayInventorySend | { kind: 'shopify'; revision: string; remoteRevision: string | null; initialized: boolean; draft: unknown; products: Array<{ productId: string; sku: string }> }

// Sheet publish parity (step 1) — the result counts; they live with the settle core now (step 2).
export { publicationSummary }

/** The destination of a publication as indexed columns (the same values `changes` keeps). `familyId` is the parent. */
export const publicationColumns = (familyId: string, scope: StudioPublishScope, aliasKey: string) => ({
  kind: KIND, productId: familyId, channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey,
})

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

/**
 * Step 5 (item 3/6) — a review made for a publication batch. `batchId` ties the review to the batch that will send it;
 * `expiresInMs` lets the batch own the review's lifetime (the revision check at submit stays the real guard). With a
 * `batchId`, a review that cannot be sent is kept as a BLOCKED row (never sent, never in flight, never in the history),
 * so the batch can show why; without one, a blocked review is returned unsaved, as before.
 */
export interface PreviewOptions { batchId?: string; expiresInMs?: number }

/**
 * The review of one destination and what decides whether it may be stored: the publication key, a publication at this
 * destination still waiting for its result (D3: one a person marked checked no longer blocks), and whether only photos
 * may be sent. Reads only (the channel too, through the studio transports); it writes nothing.
 */
async function reviewPlan(productId: string, scope: StudioPublishScope, options: { verify?: boolean } = {}) {
  const plan = await buildReview(productId, scope, options)
  const key = publicationDigest([workspaceIdForQuery(), plan.facts.destination.familyId, scope.channel, scope.accountId, scope.marketplace, plan.facts.destination.aliasKey])
  const unresolved = await prisma.bulkOperation.findFirst({ where: { ...OPEN_PUBLICATION, changes: { path: ['publicationKey'], equals: key } }, select: { id: true, userId: true } })
  // P4c — errors that each name a field (an off-list Season value) block that field, not the listing: on a change-only
  // review the photos can still be sent. Any error that names no field blocks the review as before.
  const errors = plan.review.issues.filter(i => i.severity === 'error')
  const photosOnly = errors.length > 0 && errors.every(i => i.field) && !!plan.changePlan && !!plan.review.changes?.some(c => c.selectable && isPhotoChangeId(c.id))
  return { plan, key, unresolved, errors, photosOnly }
}

/** A durable review also owns retries, across API processes and browser reconnects. */
export async function previewStudioPublication(productId: string, scope: StudioPublishScope, userId: string | null, options: PreviewOptions = {}): Promise<StudioPublishReview> {
  if (scope.channel === 'SHOPIFY') {
    // Materialize the existing content model's default draft so remote identity and revision
    // match the subsequent send. This saves only in Nexus; it makes no Shopify mutation.
    const { getContentWorkspace, saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
    const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
    const workspace = await getContentWorkspace(productId, contentScope)
    if (!workspace.initialized) await saveContentWorkspace(productId, contentScope, { draft: workspace.draft, expectedRevision: workspace.revision })
  }
  const { plan, key, unresolved, errors, photosOnly } = await reviewPlan(productId, scope, { verify: true })
  if (options.expiresInMs) plan.review.expiresAt = new Date(Date.now() + options.expiresInMs).toISOString()
  const id = randomUUID()
  const columns = { ...publicationColumns(plan.facts.destination.familyId, scope, plan.facts.destination.aliasKey ?? ''), ...(options.batchId ? { batchId: options.batchId } : {}) }
  // Step 5 — inside a batch a review that cannot be sent is kept, BLOCKED, so the batch can say why. It is never sent.
  const blocked = async (review: StudioPublishReview) => {
    if (!options.batchId) return review
    const kept = { ...review, id }
    await prisma.bulkOperation.create({ data: { id, userId, status: 'BLOCKED', productCount: review.rows.length, changeCount: 0, ...columns,
      completedAt: new Date(), summary: json({ message: blockingIssues(review.issues).map(i => i.message).join('\n') || 'This review cannot be sent.', blocked: true }),
      changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision, review: kept }) } })
    return kept
  }
  // D3 — a publication a person marked checked is closed (`OPEN_PUBLICATION`) and no longer blocks its destination.
  if (unresolved) return blocked({ ...plan.review, ...(unresolved.userId === userId ? { previousPublicationId: unresolved.id } : {}), issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). ${unresolved.userId === userId ? 'Check its status before publishing again.' : 'Ask the colleague who submitted it to check its status.'}` }] })
  if (!plan.prepared || (errors.length && !photosOnly)) return blocked(plan.review)
  const review = { ...plan.review, id, ...(photosOnly ? { photosOnly: true } : {}) }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: plan.review.rows.length, changeCount: 0,
    ...columns,
    expiresAt: new Date(plan.review.expiresAt), changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision,
      changeVersion: plan.changePlan ? 1 : null, changePlan: plan.changePlan, review }) } })
  return review
}

/**
 * MCP full control L3 — the studio's review of one destination, built exactly as `previewStudioPublication` builds it,
 * WITHOUT saving anything: no BulkOperation row (so no review id: nothing to select or submit from it) and no Shopify
 * content save (an uninitialised Shopify document is reviewed as its default draft — the draft that save would store —
 * and no Shopify family draft listing is started). It reads the channel live, as the studio's review does, through the
 * studio transports (the channel gateway). A publication at this destination still waiting for its result is named,
 * whoever submitted it: its result belongs to the business (`publicationResultFor`).
 */
export async function reviewStudioPublication(productId: string, scope: StudioPublishScope): Promise<StudioPublishReview> {
  const { plan, unresolved, photosOnly } = await reviewPlan(productId, scope)
  if (unresolved) return { ...plan.review, previousPublicationId: unresolved.id, issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). Check its status before publishing again.` }] }
  return { ...plan.review, ...(plan.prepared && photosOnly ? { photosOnly: true } : {}) }
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

/**
 * Sheet publish parity T1 — a saved review read back, for a row of the many-product dialog: the review the preview
 * returned, the fields ticked so far, and whether they can still change. The creator only, like every read here. It
 * never returns the exact channel request (the selection route prepares that when the ticks change) and makes no
 * channel read.
 */
export async function studioPublicationStoredReview(productId: string, id: string, userId: string | null, now = new Date()): Promise<StudioPublishStoredReview> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId }, select: { status: true, expiresAt: true, changes: true } })
  const data = object(operation?.changes)
  const stored = object(data.review)
  if (!operation || data.kind !== KIND || data.productId !== productId || !Array.isArray(stored.rows)) throw new WorkspaceScopeError('Publication review not found.', 404)
  const selection = object(data.selection)
  const selectedIds = Array.isArray(selection.selectedIds) ? selection.selectedIds.filter((value): value is string => typeof value === 'string') : null
  const expiresAt = operation.expiresAt?.toISOString() ?? (typeof stored.expiresAt === 'string' ? stored.expiresAt : null)
  return {
    review: { ...(stored as unknown as StudioPublishReview), ...(expiresAt ? { expiresAt } : {}) },
    status: operation.status,
    selectedIds,
    fieldCount: typeof selection.fieldCount === 'number' ? selection.fieldCount : null,
    editable: operation.status === 'PREVIEW' && !!operation.expiresAt && operation.expiresAt.getTime() > now.getTime() && data.changeVersion === 1 && !!data.changePlan,
  }
}

/** The submitter's status read. It settles through the shared core (`settleStudioPublication`), which the result sweep also runs. */
export async function studioPublicationResult(productId: string, id: string, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication not found.', 404)
  const outcome = await settleStudioPublication(id, { actorUserId: userId })
  if (!outcome) throw new WorkspaceScopeError('Publication not found.', 404)
  return outcome.result
}

/**
 * MCP full control L3 — a publication's result, read in this BUSINESS (row-level security scopes the row), not only by
 * the person who submitted it: the approver of a change Claude asked for and the person who asked may differ, and the
 * settle sweep (`jobs/studio-publication-settle.job.ts`) has no person at all. It settles through the same core as
 * `studioPublicationResult` (`settleStudioPublication`), reading the channel through the gateway, and records in the
 * submitter's name, as the submitter's own read would.
 */
export async function publicationResultFor(id: string): Promise<StudioPublishResult> {
  const outcome = await settleStudioPublication(id, { actorUserId: null })
  if (!outcome) throw new WorkspaceScopeError('Publication not found.', 404)
  return outcome.result
}

/**
 * MCP full control L3 — a publication as it is stored, read in this business (row-level security), whoever submitted it:
 * its product, destination, send time, status and the result recorded so far. A PURE read: it never asks the channel and
 * never settles (`publicationResultFor` and the studio's own read do). Null when there is none.
 */
export async function readStoredPublication(id: string): Promise<{ productId: string; scope: StudioPublishScope; startedAt: string | null
  status: string; result: StudioPublishResult | null } | null> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id }, select: { status: true, changes: true } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND) return null
  return { productId: String(data.productId), scope: data.scope as StudioPublishScope, startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
    status: operation.status, result: data.result ? data.result as StudioPublishResult : null }
}

type BuiltReview = Awaited<ReturnType<typeof buildReview>>
/**
 * Step 5 — a publication whose send this caller owns: the review row moved PREVIEW → PUBLISHING here, and nobody else
 * will send it. The submit is three parts so a batch can share them (`claimPublication` → `deliverPublication` →
 * `finishPublication`); `submitStudioPublication` runs the three in order, exactly as it always did.
 */
export interface ClaimedPublication {
  productId: string
  id: string
  userId: string | null
  data: Record<string, any>
  input: Record<string, any>
  plan: BuiltReview & { prepared: Prepared }
  destinationRow: ReturnType<typeof publicationColumns> & { batchId: string | null }
}
export interface DeliveredPublication { result: StudioPublishResult; receipt?: StudioPublishResult }

/** Check the review and claim its send. Returns the stored result instead when it was already started or claimed. */
export async function claimPublication(productId: string, id: string, body: unknown, userId: string | null): Promise<{ result: StudioPublishResult } | { claim: ClaimedPublication }> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') return { result: await studioPublicationResult(productId, id, userId) }
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
    const other = await tx.bulkOperation.findFirst({ where: { id: { not: id }, ...OPEN_PUBLICATION, changes: { path: ['publicationKey'], equals: data.publicationKey } }, select: { id: true } })
    if (other) throw new WorkspaceScopeError('Another publication is in progress or awaits verification. Check its result before sending again.')
    // The destination columns again: a review saved before the columns existed gains them when it is sent.
    // Step 2 — a publication sent from now on is swept: `checkCount` 0 marks it as the new code's, and the first look is
    // its 30-minute receipt deadline. Rows from before this step keep both null and are never swept.
    const submittedAt = new Date(data.startedAt)
    return (await tx.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW', changes: { equals: originalChanges } }, data: { status: 'PUBLISHING',
      submittedAt, checkCount: 0, nextCheckAt: nextPublicationCheck({ channel: data.scope.channel, status: 'PUBLISHING', inventory: false, reference: false,
        checkCount: 0, submittedAt, now: submittedAt }).nextCheckAt,
      ...publicationColumns(plan.facts.destination.familyId, data.scope, data.delivery.aliasKey), changes: json(data) } })).count === 1
  })
  if (!claimed) {
    const latest = await prisma.bulkOperation.findFirst({ where: { id, userId } })
    if (latest?.status === 'PREVIEW') throw new WorkspaceScopeError('The selection changed while waiting to publish. Review the selected changes again.')
    return { result: await studioPublicationResult(productId, id, userId) }
  }
  const destinationRow = { ...publicationColumns(plan.facts.destination.familyId, data.scope, data.delivery.aliasKey), batchId: operation.batchId ?? null }
  announcePublication(id, destinationRow, data, 'PUBLISHING')
  return { claim: { productId, id, userId, data, input, plan: plan as ClaimedPublication['plan'], destinationRow } }
}

/** The checks every delivery makes first: publishing is still live, and the saved values did not change since the claim. */
export async function checkDeliveryStillValid(claim: ClaimedPublication): Promise<void> {
  const { scope } = claim.plan.facts
  if (publishMode(scope.channel) !== 'live') throw new Error('Live publication was disabled before submission.')
  if ((await readPublicationFacts(claim.productId, scope)).revision !== claim.plan.facts.revision) throw new Error('Saved information changed while this publication was waiting. Review the current values before publishing.')
}

/**
 * Journal FKs name only this destination. These drafts never establish channel presence. The one creator
 * (`ensureDraftListings`) starts exactly the delivered products that have no row here (`family: false`).
 */
export const ensureClaimDrafts = (claim: ClaimedPublication) => prisma.$transaction(tx => ensureDraftListings(tx, { channel: claim.plan.facts.scope.channel,
  market: claim.plan.facts.scope.marketplace, accountId: claim.plan.facts.scope.accountId, aliasKey: claim.plan.facts.destination.aliasKey ?? '',
  productIds: claim.data.delivery.productIds, family: false }))

/** Store the channel's receipt as the publication's status, with its records; the sweep's first look comes with it. */
export async function checkpointPublication(claim: ClaimedPublication, value: StudioPublishResult): Promise<void> {
  const { id, userId, data, destinationRow } = claim
  // Step 2 — the receipt also sets the sweep's first look: an Amazon feed in 2 minutes, an eBay item read back the same.
  const check = nextPublicationCheck({ channel: data.scope.channel, status: value.status, inventory: data.inventory === true,
    reference: !!value.results[0]?.reference, checkCount: 0, submittedAt: new Date(data.startedAt), now: new Date() })
  await prisma.$transaction(async tx => {
    await tx.bulkOperation.update({ where: { id }, data: { status: value.status, summary: json(publicationSummary(value)), nextCheckAt: check.nextCheckAt,
      changes: json({ ...data, result: value }) } })
    await settlePublicationRecords(tx, recordContext(id, data, userId), value)
  })
  if (value.status !== 'PUBLISHING') announcePublication(id, destinationRow, data, value.status)
}

/** Send a claimed publication to its channel. Never throws: a failure becomes the result (FAILED when nothing was sent). */
export async function deliverPublication(claim: ClaimedPublication): Promise<DeliveredPublication> {
  const { productId, id, userId, data, input, plan } = claim
  let result: StudioPublishResult
  let providerStarted = false
  let receipt: StudioPublishResult | undefined
  const context = recordContext(id, data, userId)
  const checkpoint = async (value: StudioPublishResult) => {
    receipt = value
    await checkpointPublication(claim, value)
  }
  const ensureDrafts = () => ensureClaimDrafts(claim)
  try {
    const { scope } = plan.facts
    await checkDeliveryStillValid(claim)
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
        // Amazon sheet gaps — a reviewed fulfilment root goes with the stock job's quantity now; the journal keeps the offer sent.
        const amazon = await withSendQuantities(plan.prepared, { marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '' })
        const reference = await sendAmazonPublication(amazon, scope.accountId, request => recordPublicationRequests(context, request.feed.messages.map(message => {
          const products = amazon.products.filter(product => product.sku === message.sku)
          if (products.length !== 1) throw new Error(`The exact product for Amazon seller SKU ${message.sku} could not be recorded.`)
          const offer = amazon.offers?.[products[0].productId]
          return { productId: products[0].productId, sku: message.sku, request: { feedType: request.feedType, marketplaceIds: request.marketplaceIds, header: request.feed.header, message,
            intentVersion: 1, writes: amazon.fieldWrites?.[products[0].productId] ?? [], ...(offer ? { offer } : {}) } }
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
  return { result, receipt }
}

/** Store the delivered result once (the settle core's compare-and-set) and return what the caller should show. */
export async function finishPublication(claim: ClaimedPublication, delivered: DeliveredPublication): Promise<StudioPublishResult> {
  const { productId, id, userId, data } = claim
  const { result, receipt } = delivered
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

export async function submitStudioPublication(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishResult> {
  const claimed = await claimPublication(productId, id, body, userId)
  if ('result' in claimed) return claimed.result
  return finishPublication(claimed.claim, await deliverPublication(claimed.claim))
}
