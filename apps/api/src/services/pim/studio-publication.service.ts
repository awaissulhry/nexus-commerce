import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { StudioPublishReview, StudioPublishResult, StudioPublishScope } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { getShopifyPublishMode } from '../shopify-publish-gate.service.js'
import { readPublicationFacts, publicationDigest, object } from './studio-publication-plan.js'
import { WorkspaceScopeError } from './workspace-destination.js'
import { prepareAmazonPublication, sendAmazonPublication, readAmazonPublication, type AmazonPublication } from './studio-publication-amazon.js'
import { prepareEbayPublication, sendEbayPublication, type EbayPublication } from './studio-publication-ebay.js'

const KIND = 'studio-publication'
const IN_FLIGHT = ['PUBLISHING', 'UNVERIFIED', 'SUBMITTED']
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const publishMode = (channel: string) => channel === 'AMAZON' ? getAmazonPublishMode() : channel === 'EBAY' ? getEbayPublishMode() : channel === 'SHOPIFY' ? getShopifyPublishMode() : 'unavailable'
type Prepared = AmazonPublication | EbayPublication | { kind: 'shopify'; revision: string; remoteRevision: string | null; initialized: boolean; draft: unknown }

async function buildReview(productId: string, scope: StudioPublishScope) {
  const facts = await readPublicationFacts(productId, scope)
  const mode = publishMode(scope.channel)
  const issues = [...facts.issues]
  let prepared: Prepared | null = null
  let locations: StudioPublishReview['locations'], visibility: string | undefined
  try {
    if (scope.channel === 'AMAZON') prepared = await prepareAmazonPublication(facts)
    else if (scope.channel === 'EBAY') prepared = await prepareEbayPublication(facts)
    else if (scope.channel === 'SHOPIFY') {
      if (facts.excluded) throw new Error('This Shopify family has excluded variants. Review the family selection before publishing.')
      const { previewContentSync } = await import('../shopify/content-sync.service.js')
      const preview = await previewContentSync(productId, { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }, true)
      for (const message of preview.errors) issues.push({ severity: 'error', message })
      locations = preview.locations.filter(l => l.isActive).map(({ id, name }) => ({ id, name }))
      if (!locations.length) issues.push({ severity: 'error', message: 'This Shopify store has no active inventory location.' })
      visibility = String(preview.changes.newProductStatus)
      prepared = { kind: 'shopify', revision: preview.revision, remoteRevision: preview.remoteRevision, initialized: preview.initialized, draft: preview.draft }
    } else issues.push({ severity: 'error', message: `${scope.channel === 'ETSY' ? 'Etsy' : scope.channel} does not have a product publication adapter yet. Your saved information is available in the studio.` })
  } catch (error) { issues.push({ severity: 'error', message: error instanceof Error ? error.message : String(error) }) }
  if (mode !== 'live') issues.push({ severity: 'error', message: mode === 'unavailable' ? 'Publication is unavailable for this channel.' : `Live publishing is ${mode === 'gated' ? 'disabled' : `in ${mode} mode`} for this channel. Enable live publishing in the channel configuration to send this product.` })
  const review: StudioPublishReview = {
    id: null, productId, scope, accountLabel: facts.account.displayName, aliasLabel: facts.aliasLabel, mode,
    action: facts.listings.some(l => l.externalListingId) ? 'update' : 'create', excluded: facts.excluded,
    rows: facts.products.map(p => ({ productId: p.id, sku: p.sku,
      title: String(facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.title?.value ?? facts.resolved[0]?.products.find(r => r.productId === p.id)?.cells.item_name?.value ?? p.name ?? p.sku),
      existing: !!facts.listings.find(l => l.productId === p.id)?.externalListingId })),
    issues: [...new Map(issues.map(i => [JSON.stringify(i), i])).values()], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), locations, visibility,
  }
  return { facts, review, prepared, revision: publicationDigest([facts.revision, prepared, mode]) }
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
  const plan = await buildReview(productId, scope)
  if (!plan.prepared || plan.review.issues.some(i => i.severity === 'error')) return plan.review
  const id = randomUUID()
  const key = publicationDigest([workspaceIdForQuery(), plan.facts.destination.familyId, scope.channel, scope.accountId, scope.marketplace, plan.facts.destination.aliasKey])
  const unresolved = await prisma.bulkOperation.findFirst({ where: { status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: key } }, select: { id: true, userId: true } })
  if (unresolved) return { ...plan.review, ...(unresolved.userId === userId ? { previousPublicationId: unresolved.id } : {}), issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). ${unresolved.userId === userId ? 'Check its status before publishing again.' : 'Ask the colleague who submitted it to check its status.'}` }] }
  await prisma.bulkOperation.create({ data: { id, userId, status: 'PREVIEW', productCount: plan.review.rows.length, changeCount: 0,
    expiresAt: new Date(plan.review.expiresAt), changes: json({ kind: KIND, publicationKey: key, productId, scope, revision: plan.revision, review: { ...plan.review, id } }) } })
  return { ...plan.review, id }
}

export async function studioPublicationResult(productId: string, id: string, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication not found.', 404)
  if (data.result) {
    const previous = data.result as StudioPublishResult
    if (operation.status === 'SUBMITTED' && data.scope.channel === 'AMAZON') {
      const reference = previous.results[0]?.reference
      if (reference) {
        const report = await readAmazonPublication(reference, data.scope.accountId, previous.results.map(r => r.sku))
        if (report) {
          const failed = report.results.filter(r => r.failed).length
          const result: StudioPublishResult = { id, status: failed === report.results.length ? 'FAILED' : failed ? 'PARTIAL' : 'ACCEPTED',
            message: failed ? `${failed} products were rejected by Amazon. Review the processing messages before publishing corrected values.` : `Amazon processed feed ${reference}. Storefront visibility is still determined by Amazon.`,
            results: report.results.map(r => ({ sku: r.sku, status: r.failed ? 'FAILED' : 'ACCEPTED', message: r.message, reference })) }
          await prisma.bulkOperation.updateMany({ where: { id, status: 'SUBMITTED' }, data: { status: result.status, completedAt: new Date(), changes: json({ ...data, result }) } })
          return result
        }
      }
    }
    return previous
  }
  return { id, status: operation.status === 'PUBLISHING' ? 'PUBLISHING' : 'FAILED', message: operation.status === 'PUBLISHING' ? 'The channel is processing this publication. Check again for its result.' : 'This review has not been submitted.', results: [] }
}

export async function submitStudioPublication(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishResult> {
  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })
  const data = object(operation?.changes)
  if (!operation || data.kind !== KIND || data.productId !== productId) throw new WorkspaceScopeError('Publication review not found.', 404)
  if (operation.status !== 'PREVIEW') return studioPublicationResult(productId, id, userId)
  if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current saved values again.')
  const plan = await buildReview(productId, data.scope as StudioPublishScope)
  if (plan.revision !== data.revision) throw new WorkspaceScopeError('Saved information, the destination or channel settings changed. Review the current values before publishing.')
  const blockers = plan.review.issues.filter(i => i.severity === 'error')
  if (blockers.length || !plan.prepared) throw new WorkspaceScopeError(blockers.map(i => i.message).join('\n') || 'Publication is unavailable.', 422)
  const input = object(body)
  if (plan.prepared.kind === 'shopify' && !plan.review.locations?.some(l => l.id === input.locationId)) throw new WorkspaceScopeError('Choose an inventory location from this Shopify store.', 400)
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', `studio-publication:${data.publicationKey}`)
    const other = await tx.bulkOperation.findFirst({ where: { id: { not: id }, status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: data.publicationKey } }, select: { id: true } })
    if (other) throw new WorkspaceScopeError('Another publication is in progress or awaits verification. Check its result before sending again.')
    return (await tx.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW' }, data: { status: 'PUBLISHING' } })).count === 1
  })
  if (!claimed) return studioPublicationResult(productId, id, userId)
  let result: StudioPublishResult
  let providerStarted = false
  try {
    const { scope } = plan.facts
    if (publishMode(scope.channel) !== 'live') throw new Error('Live publication was disabled before submission.')
    if (plan.prepared.kind === 'shopify') {
      const contentScope = { accountId: scope.accountId, listingId: scope.listingId, market: scope.marketplace }
      let revision = plan.prepared.revision
      if (!plan.prepared.initialized) {
        const { saveContentWorkspace } = await import('../shopify/content-workspace.service.js')
        const saved = await saveContentWorkspace(productId, contentScope, { draft: plan.prepared.draft, expectedRevision: revision })
        revision = saved.revision
      }
      const { synchronizeContent } = await import('../shopify/content-sync.service.js')
      providerStarted = true
      const sent = await synchronizeContent(productId, contentScope, { expectedRevision: revision, expectedRemoteRevision: plan.prepared.remoteRevision,
        locationId: input.locationId, confirmActive: true })
      result = { id, status: 'VERIFIED', message: `Shopify verified the saved product and variants. Visibility: ${plan.review.visibility}.`, results: plan.review.rows.map(r => ({ sku: r.sku, status: 'VERIFIED', message: 'Verified by Shopify', reference: sent.productId })) }
    } else {
      // Creation stores a correctly attributed draft. Only provider results can establish publication.
      await prisma.channelListing.createMany({ data: plan.facts.products.filter(p => !plan.facts.listings.some(l => l.productId === p.id)).map(p => ({
        productId: p.id, channel: scope.channel, marketplace: scope.marketplace, region: scope.marketplace, channelMarket: `${scope.channel}_${scope.marketplace}`,
        channelConnectionId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '', aliasId: plan.facts.destination.aliasKey, isPublished: false, listingStatus: 'DRAFT',
      })), skipDuplicates: true })
      providerStarted = true
      const reference = plan.prepared.kind === 'amazon' ? await sendAmazonPublication(plan.prepared, scope.accountId) : await sendEbayPublication(plan.prepared, scope.accountId, id)
      const status = plan.prepared.kind === 'amazon' ? 'SUBMITTED' as const : 'ACCEPTED' as const
      if (plan.prepared.kind === 'ebay') await prisma.channelListing.updateMany({ where: { productId: { in: plan.facts.products.map(p => p.id) },
        channel: scope.channel, marketplace: scope.marketplace, channelConnectionId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '' },
        data: { externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE', version: { increment: 1 } } })
      result = { id, status, message: status === 'SUBMITTED' ? `Submitted to Amazon. Feed ${reference} is awaiting processing; the listing is not yet confirmed live.` : `eBay accepted the listing. Item ${reference}.`,
        results: plan.review.rows.map((r, index) => ({ sku: plan.prepared?.kind === 'amazon' ? plan.prepared.feed.messages[index].sku : r.sku, status, reference, message: status === 'SUBMITTED' ? 'Awaiting Amazon processing' : 'Accepted by eBay' })) }
    }
  } catch (error) {
    const refused = !providerStarted || (error as { notSent?: boolean })?.notSent === true
    result = { id, status: refused ? 'FAILED' : 'UNVERIFIED', message: `${refused ? 'Nothing was submitted.' : 'Publication could not be verified. Check the channel before retrying:'} ${error instanceof Error ? error.message : String(error)}`, results: [] }
  }
  await prisma.bulkOperation.update({ where: { id }, data: { status: result.status, completedAt: new Date(), changes: json({ ...data, result }) } })
  return result
}
