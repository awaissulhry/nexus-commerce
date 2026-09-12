import type { Prisma } from '@prisma/client'
import { buildImagePatches, type AmazonMediaPlanItem, type AmazonMediaReceipt, type AmazonMediaRun } from '@nexus/shared/amazon-media'
import prisma from '../../db.js'
import { WorkspaceScopeError, type WorkspaceDestination } from '../pim/workspace-destination.js'
import { amazonMediaClient } from './amazon-media-client.js'
import { amazonMediaDestination, assertNoActiveMediaRun, desiredAmazonImages, mutateAmazonMedia, readAmazonMedia, refreshAmazonMedia } from './amazon-media-workspace.service.js'

const json = (value: unknown) => value as Prisma.InputJsonValue
export async function readAmazonMediaRun(destination: WorkspaceDestination, id: string): Promise<AmazonMediaRun> {
  const run = await prisma.amazonMediaRun.findFirst({ where: { id, productId: destination.productId, listingId: destination.listing!.id,
    accountId: destination.accountId, marketplace: destination.marketplace } })
  if (!run) throw new WorkspaceScopeError('This image review does not belong to the selected listing destination.', 404)
  return { id: run.id, status: run.status, createdAt: run.createdAt.toISOString(), revision: run.revision,
    items: run.plan as unknown as AmazonMediaPlanItem[], receipts: run.receipts as unknown as AmazonMediaReceipt[] }
}
export async function createAmazonMediaReview(destination: WorkspaceDestination, revision: string, listingIds: string[], actorId: string | null) {
  const current = await readAmazonMedia(destination)
  if (current.revision !== revision) throw new WorkspaceScopeError('The saved gallery changed. Reload before reviewing publication.')
  await assertNoActiveMediaRun(current)
  if (!listingIds.length || listingIds.length > 200 || new Set(listingIds).size !== listingIds.length || listingIds.some(id => !current.items.some(i => i.id === id)))
    throw new WorkspaceScopeError('Choose between 1 and 200 distinct SKUs in this listing destination.', 422)
  // Resolve credential attribution before queuing. Nothing is submitted here.
  await amazonMediaClient(destination.accountId, destination.marketplace)
  const run = await prisma.amazonMediaRun.create({ data: { productId: destination.productId, listingId: destination.listing!.id, accountId: destination.accountId,
    marketplace: destination.marketplace, revision, actorId, status: 'REVIEW_QUEUED', plan: [],
    receipts: listingIds.map(listingId => ({ listingId, status: 'NOT_SENT' })) } })
  return readAmazonMediaRun(destination, run.id)
}
export async function approveAmazonMediaRun(destination: WorkspaceDestination, id: string, revision: string) {
  const run = await readAmazonMediaRun(destination, id)
  if (run.status !== 'REVIEW' || run.revision !== revision || Date.now() - Date.parse(run.createdAt) > 15 * 60_000)
    throw new WorkspaceScopeError('This review expired or has already been submitted. Build a fresh review.')
  if (!run.items.length || run.items.some(i => i.issues.length)) throw new WorkspaceScopeError('Resolve every blocking issue in this review before publishing.', 422)
  if (!run.items.some(i => i.patches.length)) throw new WorkspaceScopeError('There are no image changes to publish.', 422)
  const workspace = await mutateAmazonMedia(destination, revision, async (current, pa, tx) => {
    await assertNoActiveMediaRun(current, tx)
    const claimed = await tx.amazonMediaRun.updateMany({ where: { id, status: 'REVIEW' }, data: { status: 'QUEUED' } })
    if (claimed.count !== 1) throw new WorkspaceScopeError('This image review has already been submitted.')
    return { ...pa, _amazonMediaActiveRun: id }
  })
  // The approval changes only the local lock, so bind the worker to that exact
  // post-approval revision. A worker cannot claim QUEUED until this write lands.
  await prisma.amazonMediaRun.update({ where: { id }, data: { revision: workspace.revision, status: 'READY' } })
  return readAmazonMediaRun(destination, id)
}

/** Durable worker. A write is recorded as SENDING before the remote call. A
 * crashed/ambiguous write is never replayed; the operator reads Amazon first. */
export async function processAmazonMediaRun(id: string) {
  const initial = await prisma.amazonMediaRun.findUnique({ where: { id } })
  if (!initial || !['REVIEW_QUEUED', 'READY'].includes(initial.status)) return
  const reviewing = initial.status === 'REVIEW_QUEUED'
  const claimed = await prisma.amazonMediaRun.updateMany({ where: { id, status: initial.status }, data: { status: reviewing ? 'REVIEWING' : 'SUBMITTING' } })
  if (claimed.count !== 1) return
  const plan = initial.plan as unknown as AmazonMediaPlanItem[]
  const receipts = initial.receipts as unknown as AmazonMediaReceipt[]
  let stopped = false
  try {
    const destination = await amazonMediaDestination({ productId: initial.productId, accountId: initial.accountId, market: initial.marketplace, listingId: initial.listingId })
    const client = await amazonMediaClient(initial.accountId, initial.marketplace)
    for (const receipt of receipts) {
      const current = await readAmazonMedia(destination)
      if (current.revision !== initial.revision) throw new WorkspaceScopeError('The saved gallery or listing context changed. Build a fresh review.')
      const item = current.items.find(i => i.id === receipt.listingId)
      if (!item) throw new Error('A selected SKU no longer belongs to this listing destination.')
      if (reviewing) {
        const { desired, problems } = desiredAmazonImages(current, item.id)
        const entry: AmazonMediaPlanItem = { listingId: item.id, sku: item.sku, asin: item.asin ?? '', productType: item.productType ?? '', desired,
          before: {}, patches: [], changes: [], issues: [...problems] }
        try {
          const observed = await client.observe(item)
          entry.asin = observed.asin!; entry.productType = observed.productType!; entry.before = observed.slots
          const unsupported = Object.keys(desired).filter(code => !observed.supported.includes(code))
          if (unsupported.length) entry.issues.push(`Amazon’s current product type does not allow: ${unsupported.join(', ')}.`)
          const diff = buildImagePatches(desired, observed.slots, observed.supported, client.marketplaceId)
          Object.assign(entry, diff)
          if (!entry.issues.length && entry.patches.length) {
            const validation = await client.patch(item.sku, entry.productType, entry.patches, true)
            if (validation.status !== 'VALID') entry.issues.push('Amazon did not confirm a valid validation preview.')
            for (const issue of validation.issues ?? []) if (issue.severity === 'ERROR') entry.issues.push(`${issue.code}: ${issue.message}`)
          }
        } catch (error) { entry.issues.push(error instanceof Error ? error.message : 'Amazon validation is unavailable.') }
        plan.push(entry)
      } else {
        const entry = plan.find(p => p.listingId === item.id)!
        if (stopped) { receipt.message = 'Not submitted after a preceding failure. Review the remaining SKUs again.'; continue }
        try {
          if (entry.sku !== item.sku || (item.asin && entry.asin !== item.asin)) throw new Error('The reviewed seller SKU or ASIN changed.')
          const observed = await client.observe(item)
          if (observed.asin !== entry.asin || observed.productType !== entry.productType || entry.changes.some(c => !observed.supported.includes(c.slot))) throw new Error('Amazon’s listing identity or supported slots changed. Review again.')
          if (JSON.stringify(Object.entries(observed.slots).sort()) !== JSON.stringify(Object.entries(entry.before).sort())) throw new Error('Amazon images changed since the review. Read Amazon and build a fresh review.')
          if (!entry.patches.length) { receipt.status = 'UNCHANGED'; continue }
          // Credential state is rechecked for each effect, not just at job start.
          const writer = await amazonMediaClient(initial.accountId, initial.marketplace)
          if ((await readAmazonMedia(destination)).revision !== initial.revision) throw new Error('The listing changed while Amazon was being checked. Build a fresh review.')
          receipt.status = 'SENDING'
          await prisma.amazonMediaRun.update({ where: { id }, data: { receipts: json(receipts) } })
          const response = await writer.patch(entry.sku, entry.productType, entry.patches, false)
          receipt.status = response.status === 'ACCEPTED' ? 'ACCEPTED' : response.status === 'INVALID' ? 'REJECTED' : 'UNKNOWN'
          if (typeof response.submissionId === 'string') receipt.submissionId = response.submissionId
          receipt.message = (response.issues ?? []).map((i: any) => `${i.severity} ${i.code}: ${i.message}`).join('; ')
          if (receipt.status !== 'ACCEPTED') stopped = true
        } catch (error) {
          receipt.status = receipt.status === 'SENDING' ? 'UNKNOWN' : 'NOT_SENT'
          receipt.message = error instanceof Error ? error.message : 'Amazon submission outcome is unknown.'
          stopped = true
        }
      }
      await prisma.amazonMediaRun.update({ where: { id }, data: { plan: json(plan), receipts: json(receipts) } })
    }
    if (reviewing) for (const entry of plan) {
      if (plan.some(other => other.listingId !== entry.listingId && other.sku && other.sku === entry.sku)) entry.issues.push('Two selected listings resolve to the same seller SKU. Reconcile their identities before publishing.')
      if (entry.asin && plan.some(other => other.listingId !== entry.listingId && other.asin === entry.asin
        && JSON.stringify(Object.entries(other.desired).sort()) !== JSON.stringify(Object.entries(entry.desired).sort())))
        entry.issues.push('Selected offers share this ASIN but specify different image galleries. Amazon has one catalog gallery per ASIN and market; choose consistent images for these offers.')
    }
    await prisma.amazonMediaRun.update({ where: { id }, data: { status: reviewing ? 'REVIEW' : receipts.some(r => r.status === 'UNKNOWN') ? 'UNKNOWN' : 'COMPLETE', plan: json(plan), receipts: json(receipts) } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The operation could not be completed.'
    for (const receipt of receipts) if (receipt.status === 'SENDING' || receipt.status === 'NOT_SENT') {
      if (receipt.status === 'SENDING') receipt.status = 'UNKNOWN'
      receipt.message = message
    }
    await prisma.amazonMediaRun.update({ where: { id }, data: { status: reviewing ? 'REVIEW_FAILED' : 'UNKNOWN', plan: json(plan), receipts: json(receipts) } })
  }
}

export async function processPendingAmazonMediaRuns() {
  // Never retry a process that died around PATCH. Preserve its receipt, and mark
  // the uncertainty instead of claiming rejection or success.
  const stale = await prisma.amazonMediaRun.findMany({ where: { status: { in: ['QUEUED', 'SUBMITTING', 'REVIEWING'] }, updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, take: 10 })
  for (const run of stale) {
    const receipts = run.receipts as unknown as AmazonMediaReceipt[]
    for (const receipt of receipts) if (receipt.status === 'SENDING') { receipt.status = 'UNKNOWN'; receipt.message = 'The worker stopped before confirming Amazon’s response. Check Amazon before trying again.' }
    await prisma.amazonMediaRun.updateMany({ where: { id: run.id, updatedAt: run.updatedAt }, data: { status: run.status === 'REVIEWING' ? 'REVIEW_FAILED' : 'UNKNOWN', receipts: json(receipts) } })
  }
  const pending = await prisma.amazonMediaRun.findMany({ where: { status: { in: ['REVIEW_QUEUED', 'READY'] } }, orderBy: { createdAt: 'asc' }, take: 2, select: { id: true } })
  for (const run of pending) await processAmazonMediaRun(run.id)
  // Read back recent submissions even after the browser closes. Never re-submit
  // from this path, including UNKNOWN outcomes. Show the observation timestamp.
  const recent = await prisma.amazonMediaRun.findMany({ where: { status: { in: ['COMPLETE', 'UNKNOWN'] }, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) } }, orderBy: { createdAt: 'desc' }, take: 20 })
  let checks = 0
  for (const run of recent) {
    if (checks >= 2) break
    try {
      const destination = await amazonMediaDestination({ productId: run.productId, accountId: run.accountId, market: run.marketplace, listingId: run.listingId })
      const current = await readAmazonMedia(destination)
      if (current.activeRunId !== run.id) continue
      const latestCheck = Math.max(0, ...Object.values(current.observations).map(o => Date.parse(o.checkedAt)))
      if (Date.now() - latestCheck < 2 * 60_000) continue
      checks++
      await refreshAmazonMedia(destination, current.revision)
    } catch { /* Keep the previous timestamp; an unavailable read never proves live state. */ }
  }
}
