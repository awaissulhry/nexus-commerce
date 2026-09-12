import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { ebayAuthService } from './ebay-auth.service.js'
import { applyVariationOrderToListing } from './ebay-variation-order-apply.service.js'
import { presentationDestination, presentationOrderInputs, readPresentationOrder, type PresentationDestination, type PresentationDestinationInput } from './ebay-presentation-order.service.js'
import { MappingConflict, mappingToken } from './pim/mapping/revision-token.js'
import { callTradingApi, siteIdForMarket } from './ebay-trading-api.service.js'
import { buildDescriptionReviseXml, buildGetItemDescriptionXml, normalizedDescriptionHash, parseDescriptionFromGetItem, LANE_A_SKIP_MESSAGE } from './ebay-description-push.service.js'
import { renderListingDescriptionSafe, resolveDescriptionMode } from './ebay-description-theme.service.js'
import { resolveBatch } from './pim/mapping/resolve-batch.service.js'

const KIND = 'ebay-presentation-publication-v1'
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue
interface Target { destination: PresentationDestination; input: PresentationDestinationInput; token: string; version: number; listingId: string; itemId: string; liveToken?: string; order?: { axes: string[]; values: Record<string, string[]> }; html?: string; themeId?: string; themeVersion?: number; renderedToken?: string; preview: unknown }
interface Outcome { listingId: string; itemId: string; status: string; message?: string; stamped?: boolean }
interface Payload { kind: typeof KIND; operation: 'order' | 'description'; targets: Target[]; outcomes: Outcome[]; reviewExpiresAt: string; attempt?: string }
const payloadOf = (value: unknown) => (value as Payload)?.kind === KIND ? JSON.parse(JSON.stringify(value)) as Payload : null

export async function renderedPresentationDescription(destination: PresentationDestination) {
  const answer = await resolveBatch({ channel: 'EBAY', marketplace: destination.marketplace, productIds: [destination.productId], channelConnectionId: destination.channelConnectionId, aliasKey: destination.aliasKey, fieldKeys: ['title', 'description'], includeCatalogue: false })
  const cells = answer.products[0]?.cells
  const errors = Object.values(cells ?? {}).flatMap(c => c.errors)
  if (errors.length) throw new MappingConflict(errors.join('; '))
  const body = String(cells?.description?.value ?? '')
  if (!body.trim()) throw new MappingConflict('This destination has no description body')
  const mode = await resolveDescriptionMode(prisma, destination.productId, undefined, destination)
  return renderListingDescriptionSafe(prisma, { ...destination, mode, body, title: String(cells?.title?.value ?? '') })
}

/** Separate marketplace review. One target is one named-account root/alias listing, including
 * its explicitly bound ItemID. No product or shared definition is modified by review. */
export async function reviewPresentationPublication(inputs: PresentationDestinationInput[], operation: 'order' | 'description', userId: string | null) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50 || !['order', 'description'].includes(operation)) throw new MappingConflict('Review between one and fifty explicit destinations and choose order or description')
  const targets: Target[] = [], excluded: Outcome[] = [], seen = new Set<string>()
  for (const input of inputs) {
    const destination = await presentationDestination(input)
    const snapshot = await presentationOrderInputs(destination)
    if (seen.has(snapshot.listing.id)) continue
    seen.add(snapshot.listing.id)
    const itemId = snapshot.listing.externalListingId
    if (!itemId || !/^\d+$/.test(itemId)) { excluded.push({ listingId: snapshot.listing.id, itemId: itemId ?? '', status: 'excluded', message: 'This destination has no live ItemID' }); continue }
    const attrs = snapshot.listing.platformAttributes as Record<string, unknown> | null
    if (attrs?.__offerIds && Object.keys(attrs.__offerIds as object).length) { excluded.push({ listingId: snapshot.listing.id, itemId, status: 'inventory-managed', message: LANE_A_SKIP_MESSAGE }); continue }
    const oauthToken = await ebayAuthService.getValidToken(destination.channelConnectionId)
    const target: Target = { destination, input: { ...input, productId: destination.productId, accountId: destination.channelConnectionId }, token: snapshot.token, version: snapshot.listing.version, listingId: snapshot.listing.id, itemId, preview: null }
    if (operation === 'order') {
      const view = await readPresentationOrder(target.input)
      if (view.conflicts.length) throw new MappingConflict(view.conflicts.join('; '))
      target.order = { axes: view.axes.map(a => a.name), values: Object.fromEntries(view.axes.map(a => [a.key, a.values])) }
      const result = await applyVariationOrderToListing(itemId, destination.marketplace, target.order.axes, target.order.values, { oauthToken }, { dryRun: true })
      if (!['dry-run', 'unchanged'].includes(result.status)) { excluded.push({ listingId: target.listingId, itemId, status: result.status, message: result.message }); continue }
      target.liveToken = result.liveToken; target.preview = result
    } else {
      const rendered = await renderedPresentationDescription(destination)
      const got = await callTradingApi('GetItem', buildGetItemDescriptionXml(itemId), { oauthToken, siteId: siteIdForMarket(destination.marketplace) })
      const live = parseDescriptionFromGetItem(got.raw)
      if (live === null) throw new MappingConflict('The current live description could not be verified')
      target.html = rendered.html; target.themeId = rendered.themeId; target.themeVersion = rendered.themeVersion
      target.renderedToken = mappingToken(rendered)
      target.liveToken = normalizedDescriptionHash(live)
      target.preview = { before: live, after: rendered.html, changed: target.liveToken !== normalizedDescriptionHash(rendered.html) }
    }
    if ((await presentationOrderInputs(destination)).token !== snapshot.token) throw new MappingConflict('Inputs changed during publication review')
    targets.push(target)
  }
  const job = await prisma.bulkOperation.create({ data: { userId, status: 'PRESENTATION_REVIEW', productCount: targets.length, changeCount: targets.length, total: targets.length, processed: 0, expiresAt: new Date(Date.now() + 30 * 60_000), changes: json({ kind: KIND, operation, targets, outcomes: excluded, reviewExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }) } })
  return { jobId: job.id, targets: targets.map(t => ({ listingId: t.listingId, itemId: t.itemId, destination: t.destination, version: t.version, preview: t.preview })), excluded, publication: 'separate' }
}

export async function executePresentationPublication(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } }); const payload = payloadOf(job?.changes)
  if (!job || !payload) return null
  if (job.status === 'PRESENTATION_COMPLETE') return { jobId, outcomes: payload.outcomes }
  const canResume = job.status === 'PRESENTATION_RUNNING' && job.expiresAt && job.expiresAt <= new Date()
  if (!payload.reviewExpiresAt || new Date(payload.reviewExpiresAt) <= new Date() || (!canResume && !['PRESENTATION_REVIEW', 'PRESENTATION_PARTIAL'].includes(job.status))) throw new MappingConflict('Create a fresh presentation publication review, or wait for the current attempt')
  const attempt = randomUUID()
  payload.attempt = attempt
  const claim = await prisma.bulkOperation.updateMany({ where: { id: jobId, userId, status: job.status, changes: { equals: job.changes ?? Prisma.DbNull }, expiresAt: job.expiresAt }, data: { status: 'PRESENTATION_RUNNING', changes: json(payload), expiresAt: new Date(Date.now() + 120_000) } })
  if (claim.count !== 1) throw new MappingConflict('This review is already executing')
  const ownsAttempt = { id: jobId, userId, status: 'PRESENTATION_RUNNING', changes: { path: ['attempt'], equals: attempt } }
  const renew = async () => {
    const lease = await prisma.bulkOperation.updateMany({ where: { ...ownsAttempt, expiresAt: { gt: new Date() } }, data: { expiresAt: new Date(Date.now() + 120_000) } })
    if (lease.count !== 1) throw new MappingConflict('This publication attempt expired or was resumed by another worker')
  }
  for (const target of payload.targets) {
    if (payload.outcomes.some(o => o.listingId === target.listingId && ['applied', 'unchanged', 'superseded'].includes(o.status))) continue
    let outcome: Outcome = { listingId: target.listingId, itemId: target.itemId, status: 'error' }
    try {
      const verify = async () => {
        await renew()
        const current = await presentationOrderInputs(target.destination)
        if (current.token !== target.token || current.listing.version !== target.version || current.listing.externalListingId !== target.itemId) throw new MappingConflict('Listing, family membership or rules changed after review')
        return current
      }
      await verify()
      const oauthToken = await ebayAuthService.getValidToken(target.destination.channelConnectionId)
      if (payload.operation === 'order') {
        const result = await applyVariationOrderToListing(target.itemId, target.destination.marketplace, target.order!.axes, target.order!.values, { oauthToken }, { expectedLiveToken: target.liveToken, beforeWrite: async () => { await verify() } })
        outcome = { ...outcome, status: result.status, message: result.message }
      } else {
        const rendered = await renderedPresentationDescription(target.destination)
        if (mappingToken(rendered) !== target.renderedToken) throw new MappingConflict('Theme, content or gallery changed after review')
        const ctx = { oauthToken, siteId: siteIdForMarket(target.destination.marketplace) }
        const got = await callTradingApi('GetItem', buildGetItemDescriptionXml(target.itemId), ctx)
        const live = parseDescriptionFromGetItem(got.raw)
        if (live === null) throw new MappingConflict('The current live description could not be verified')
        if (normalizedDescriptionHash(live) === normalizedDescriptionHash(target.html!)) outcome.status = 'unchanged'
        else {
          if (normalizedDescriptionHash(live) !== target.liveToken) throw new MappingConflict('Live description changed after review')
          await verify()
          await callTradingApi('ReviseFixedPriceItem', buildDescriptionReviseXml(target.itemId, target.html!), ctx)
          const readback = await callTradingApi('GetItem', buildGetItemDescriptionXml(target.itemId), ctx)
          const delivered = parseDescriptionFromGetItem(readback.raw)
          if (delivered === null || normalizedDescriptionHash(delivered) !== normalizedDescriptionHash(target.html!)) throw new MappingConflict('eBay accepted the revision but read-back did not confirm the reviewed description. Retry this review to check it again')
          outcome.status = 'applied'
        }
      }
      if (['applied', 'unchanged'].includes(outcome.status)) {
        try {
          const current = await verify()
          if (payload.operation === 'description' && mappingToken(await renderedPresentationDescription(target.destination)) !== target.renderedToken) throw new MappingConflict('Description inputs changed during delivery')
          const stamp = { jobId, inputToken: target.token, submittedVersion: target.version, at: new Date().toISOString(), itemId: target.itemId, operation: payload.operation, themeId: target.themeId, themeVersion: target.themeVersion, renderedToken: target.renderedToken }
          const result = await prisma.$transaction(async tx => {
            const locked = await presentationOrderInputs(target.destination, tx)
            if (locked.token !== target.token || locked.listing.version !== target.version) throw new MappingConflict('Inputs changed before the delivery receipt committed')
            const saved = await tx.channelListing.updateMany({ where: { id: target.listingId, version: target.version, platformAttributes: { equals: locked.listing.platformAttributes ?? Prisma.DbNull } }, data: { platformAttributes: json({ ...(locked.listing.platformAttributes as object ?? {}), presentationPush: { ...((locked.listing.platformAttributes as Record<string, unknown> | null)?.presentationPush as object ?? {}), [payload.operation]: stamp } }) } })
            return saved
          }, { isolationLevel: 'Serializable', timeout: 30_000 })
          outcome.stamped = result.count === 1
          if (!outcome.stamped) outcome.status = 'superseded'
        } catch { outcome.status = 'superseded'; outcome.message = 'The reviewed payload was submitted, but newer local work was not marked as submitted' }
      }
    } catch (error) { outcome.message = error instanceof Error ? error.message : String(error) }
    payload.outcomes = [...payload.outcomes.filter(o => o.listingId !== target.listingId), outcome]
    await prisma.bulkOperation.updateMany({ where: ownsAttempt, data: { changes: json(payload), processed: payload.outcomes.filter(o => ['applied', 'unchanged', 'superseded'].includes(o.status)).length } })
  }
  const partial = payload.outcomes.some(o => !['applied', 'unchanged', 'superseded', 'excluded', 'inventory-managed'].includes(o.status))
  await prisma.bulkOperation.updateMany({ where: ownsAttempt, data: { expiresAt: new Date(payload.reviewExpiresAt), status: partial ? 'PRESENTATION_PARTIAL' : 'PRESENTATION_COMPLETE', completedAt: new Date() } })
  return { jobId, outcomes: payload.outcomes }
}

export async function getPresentationPublication(jobId: string, userId: string | null) {
  const job = await prisma.bulkOperation.findFirst({ where: { id: jobId, userId } })
  const payload = payloadOf(job?.changes)
  return job && payload ? { jobId, status: job.status, expiresAt: payload.reviewExpiresAt, operation: payload.operation, targets: payload.targets.map(t => ({ listingId: t.listingId, itemId: t.itemId, destination: t.destination, version: t.version, preview: t.preview })), outcomes: payload.outcomes } : null
}

/** Product-scoped status compares the exact rendered inputs with the reviewed delivery receipt.
 * Legacy unscoped stamps cannot establish parity for a named account/alias. */
export async function readPresentationDescription(input: PresentationDestinationInput) {
  const destination = await presentationDestination(input)
  const before = await presentationOrderInputs(destination)
  const rendered = await renderedPresentationDescription(destination)
  const after = await presentationOrderInputs(destination)
  if (before.token !== after.token) throw new MappingConflict('Description inputs changed while loading')
  const stamp = ((before.listing.platformAttributes as Record<string, unknown> | null)?.presentationPush as Record<string, any> | undefined)?.description
  const stale = !stamp || stamp.itemId !== before.listing.externalListingId || stamp.submittedVersion !== before.listing.version || stamp.renderedToken !== mappingToken(rendered)
  return { ...destination, listingId: before.listing.id, productId: input.productId, rootProductId: destination.productId, version: before.listing.version,
    html: rendered.html, themeId: rendered.themeId, themeVersion: rendered.themeVersion, warnings: rendered.warnings,
    stale, reasons: stale ? [stamp ? 'The selected listing’s content, theme or gallery differs from its reviewed delivery' : 'No reviewed delivery is recorded for this account and listing'] : [],
    ...(stamp?.at ? { stampedAt: stamp.at } : {}), galleryScope: 'Shared product/market assets; presentation preferences belong to the selected listing' }
}
