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
import { prepareEbayPublication, sendEbayPublication, readEbayPublication, type EbayPublication } from './studio-publication-ebay.js'

const KIND = 'studio-publication'
const IN_FLIGHT = ['PUBLISHING', 'UNVERIFIED', 'SUBMITTED']
const RECEIPT_DEADLINE_MS = 30 * 60_000
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const publishMode = (channel: string) => channel === 'AMAZON' ? getAmazonPublishMode() : channel === 'EBAY' ? getEbayPublishMode() : channel === 'SHOPIFY' ? getShopifyPublishMode() : 'unavailable'
type Prepared = AmazonPublication | EbayPublication | { kind: 'shopify'; revision: string; remoteRevision: string | null; initialized: boolean; draft: unknown }

async function reconcileEbayReceipt(data: Record<string, any>, previous: StudioPublishResult): Promise<StudioPublishResult> {
  const reference = previous.results[0]?.reference
  if (!reference || !data.delivery) return previous
  const receipt = await readEbayPublication(reference, data.scope.accountId, data.scope.marketplace)
  if (!receipt) return previous
  const warnings = [...new Set([...(previous.warnings ?? []), ...receipt.warnings])]
  if (!receipt.verified) return { ...previous, warnings, status: 'UNVERIFIED', message: `eBay acknowledged item ${reference}, but its active listing status could not be confirmed. Review the channel messages before publishing again.` }
  // Idempotent recovery after a receipt was stored but the local listing update failed.
  await prisma.channelListing.updateMany({ where: { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey,
    OR: [{ externalListingId: null }, { externalListingId: { not: reference } }, { isPublished: false }, { listingStatus: { not: 'ACTIVE' } }] },
    data: { externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE', version: { increment: 1 } } })
  const projected = await prisma.channelListing.count({ where: { productId: { in: data.delivery.productIds }, channel: 'EBAY',
    marketplace: data.scope.marketplace, channelConnectionId: data.scope.accountId, aliasKey: data.delivery.aliasKey,
    externalListingId: reference, isPublished: true, listingStatus: 'ACTIVE' } })
  if (projected !== new Set(data.delivery.productIds).size) throw new Error('The channel receipt is saved, but a local listing is missing from this destination. Restore its listing before checking again.')
  return { ...previous, status: 'ACCEPTED', warnings, message: `eBay accepted item ${reference} and reports it active.` }
}

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
    } else issues.push({ severity: 'error', message: `Direct publishing to ${scope.channel === 'ETSY' ? 'Etsy' : scope.channel === 'WOOCOMMERCE' ? 'WooCommerce' : scope.channel} is not available yet. Your product changes are saved in the studio.` })
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
  const id = randomUUID()
  const key = publicationDigest([workspaceIdForQuery(), plan.facts.destination.familyId, scope.channel, scope.accountId, scope.marketplace, plan.facts.destination.aliasKey])
  const unresolved = await prisma.bulkOperation.findFirst({ where: { status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: key } }, select: { id: true, userId: true } })
  if (unresolved) return { ...plan.review, ...(unresolved.userId === userId ? { previousPublicationId: unresolved.id } : {}), issues: [...plan.review.issues, { severity: 'error', message: `A previous publication still needs a result (${unresolved.id}). ${unresolved.userId === userId ? 'Check its status before publishing again.' : 'Ask the colleague who submitted it to check its status.'}` }] }
  if (!plan.prepared || plan.review.issues.some(i => i.severity === 'error')) return plan.review
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
    if (operation.status === 'UNVERIFIED' && data.scope.channel === 'EBAY' && previous.results[0]?.reference) {
      const result = await reconcileEbayReceipt(data, previous)
      await prisma.bulkOperation.updateMany({ where: { id, status: 'UNVERIFIED' }, data: { status: result.status, completedAt: result.status === 'ACCEPTED' ? new Date() : null, changes: json({ ...data, result }) } })
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
          await prisma.bulkOperation.updateMany({ where: { id, status: 'SUBMITTED' }, data: { status: result.status, completedAt: new Date(), changes: json({ ...data, result }) } })
          return result
        }
      }
    }
    return previous
  }
  const startedAt = data.startedAt ? new Date(data.startedAt).getTime() : operation.createdAt?.getTime()
  if (operation.status === 'PUBLISHING' && startedAt && Date.now() - startedAt > RECEIPT_DEADLINE_MS) {
    const result: StudioPublishResult = { id, status: 'UNVERIFIED', message: 'The submission did not record a channel receipt within 30 minutes. It may have reached the channel. Check its submission history before retrying; Nexus will not send a duplicate automatically.', results: [] }
    const updated = await prisma.bulkOperation.updateMany({ where: { id, status: 'PUBLISHING' }, data: { status: result.status, changes: json({ ...data, result }) } })
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
  const plan = await buildReview(productId, data.scope as StudioPublishScope)
  if (plan.revision !== data.revision) throw new WorkspaceScopeError('Saved information, the destination or channel settings changed. Review the current values before publishing.')
  const blockers = plan.review.issues.filter(i => i.severity === 'error')
  if (blockers.length || !plan.prepared) throw new WorkspaceScopeError(blockers.map(i => i.message).join('\n') || 'Publication is unavailable.', 422)
  const input = object(body)
  if (plan.prepared.kind === 'shopify' && !plan.review.locations?.some(l => l.id === input.locationId)) throw new WorkspaceScopeError('Choose an inventory location from this Shopify store.', 400)
  data.startedAt = new Date().toISOString()
  data.delivery = { productIds: plan.facts.products.map(p => p.id), aliasKey: plan.facts.destination.aliasKey ?? '' }
  const claimed = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `studio-publication:${data.publicationKey}`)
    const other = await tx.bulkOperation.findFirst({ where: { id: { not: id }, status: { in: IN_FLIGHT }, changes: { path: ['publicationKey'], equals: data.publicationKey } }, select: { id: true } })
    if (other) throw new WorkspaceScopeError('Another publication is in progress or awaits verification. Check its result before sending again.')
    return (await tx.bulkOperation.updateMany({ where: { id, userId, status: 'PREVIEW' }, data: { status: 'PUBLISHING', changes: json(data) } })).count === 1
  })
  if (!claimed) return studioPublicationResult(productId, id, userId)
  let result: StudioPublishResult
  let providerStarted = false
  let receipt: StudioPublishResult | undefined
  const checkpoint = async (value: StudioPublishResult) => {
    receipt = value
    await prisma.bulkOperation.update({ where: { id }, data: { status: value.status, changes: json({ ...data, result: value }) } })
  }
  try {
    const { scope } = plan.facts
    if (publishMode(scope.channel) !== 'live') throw new Error('Live publication was disabled before submission.')
    if ((await readPublicationFacts(productId, scope)).revision !== plan.facts.revision) throw new Error('Saved information changed while this publication was waiting. Review the current values before publishing.')
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
      receipt = result
    } else {
      // Creation stores a correctly attributed draft. Only provider results can establish publication.
      await prisma.channelListing.createMany({ data: plan.facts.products.filter(p => !plan.facts.listings.some(l => l.productId === p.id)).map(p => ({
        productId: p.id, channel: scope.channel, marketplace: scope.marketplace, region: scope.marketplace, channelMarket: `${scope.channel}_${scope.marketplace}`,
        channelConnectionId: scope.accountId, aliasKey: plan.facts.destination.aliasKey ?? '', aliasId: plan.facts.destination.aliasKey, isPublished: false, listingStatus: 'DRAFT',
      })), skipDuplicates: true })
      providerStarted = true
      if (plan.prepared.kind === 'amazon') {
        const reference = await sendAmazonPublication(plan.prepared, scope.accountId)
        result = { id, status: 'SUBMITTED', message: `Submitted to Amazon. Feed ${reference} is awaiting processing; the listing is not yet confirmed live.`,
          results: plan.prepared.feed.messages.map(message => ({ sku: message.sku, status: 'SUBMITTED', reference, message: 'Awaiting Amazon processing' })) }
        await checkpoint(result)
      } else {
        const sent = await sendEbayPublication(plan.prepared, scope.accountId, id)
        result = { id, status: 'UNVERIFIED', warnings: sent.warnings,
          message: `eBay acknowledged item ${sent.reference}. Its active listing status still needs checking.`,
          results: plan.review.rows.map(row => ({ sku: row.sku, status: 'ACCEPTED', reference: sent.reference, message: 'Acknowledged by eBay' })) }
        await checkpoint(result)
        result = await reconcileEbayReceipt(data, result)
      }
    }
  } catch (error) {
    const refused = !providerStarted || (error as { notSent?: boolean })?.notSent === true
    result = receipt ? { ...receipt, status: receipt.status === 'SUBMITTED' ? 'SUBMITTED' : 'UNVERIFIED',
      message: `${receipt.message} Confirmation could not finish: ${error instanceof Error ? error.message : String(error)}` }
      : { id, status: refused ? 'FAILED' : 'UNVERIFIED', message: `${refused ? 'Nothing was submitted.' : 'Publication could not be verified. Check the channel before retrying:'} ${error instanceof Error ? error.message : String(error)}`, results: [] }
  }
  try {
    const stored = await prisma.bulkOperation.updateMany({ where: { id, status: { in: IN_FLIGHT } },
      data: { status: result.status, completedAt: IN_FLIGHT.includes(result.status) ? null : new Date(), changes: json({ ...data, result }) } })
    // A status read may already have recorded a terminal processing report.
    return stored.count ? result : await studioPublicationResult(productId, id, userId)
  } catch (error) {
    if (!receipt) throw error
    // A database outage cannot erase the acknowledgement already returned by the channel.
    // Keep its reference visible without claiming that Nexus recorded the result durably.
    return { ...receipt, status: 'UNVERIFIED', message: `The channel returned a receipt, but Nexus could not record the final result. Keep this reference and check publication status before retrying: ${receipt.results.map(row => row.reference).filter((reference, index, all) => reference && all.indexOf(reference) === index).join(', ')}.` }
  }
}
