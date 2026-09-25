import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import prisma from '../../db.js'
import { digestPayload } from '../channel-publish-audit.service.js'

export interface PublicationRecordContext {
  reviewId: string
  userId: string | null
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
}

export interface PublicationRequestItem {
  productId: string
  /** The identity sent to the provider, which need not equal Product.sku. */
  sku: string
  request: unknown
}

interface PublicationJournal {
  schemaVersion: 1
  kind: 'studio-publication'
  productId: string
  channelConnectionId: string
  sku: string
  requests: Prisma.JsonValue[]
}

const idsFor = (workspaceId: string, reviewId: string, listingId: string) => {
  const key = createHash('sha256').update(JSON.stringify([workspaceId, reviewId, listingId])).digest('hex')
  return { snapshot: `pco-snapshot-${key}`, attempt: `pco-attempt-${key}` }
}
const lockReview = (tx: Prisma.TransactionClient, context: PublicationRecordContext) =>
  tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `publication-records:${context.reviewId}`)

function journalOf(value: Prisma.JsonValue, context: PublicationRecordContext): PublicationJournal {
  const journal = value as unknown as PublicationJournal | null
  if (!journal || journal.kind !== 'studio-publication' || journal.schemaVersion !== 1
    || journal.channelConnectionId !== context.accountId || typeof journal.productId !== 'string'
    || typeof journal.sku !== 'string' || !Array.isArray(journal.requests)) throw new Error('The publication journal has conflicting destination or identity attribution.')
  return journal
}

function exactRequest(value: unknown): Prisma.JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('A publication request must be JSON serializable.')
  return JSON.parse(encoded) as Prisma.JsonValue
}

/** Awaited before provider mutation: a request journal and its audit either both land or neither does. */
export async function recordPublicationRequests(context: PublicationRecordContext, items: PublicationRequestItem[], requestIndex = 0): Promise<void> {
  if (!Number.isSafeInteger(requestIndex) || requestIndex < 0) throw new Error('The publication request index must be a non-negative integer.')
  if (!items.length) throw new Error('No listing request was provided for this publication.')
  if (new Set(items.map(item => item.productId)).size !== items.length || new Set(items.map(item => item.sku)).size !== items.length) throw new Error('Duplicate product or provider SKU makes the publication attribution ambiguous.')
  const requests = items.map(item => ({ ...item, request: exactRequest(item.request) }))
  await prisma.$transaction(async tx => {
    await lockReview(tx, context)
    const listings = await tx.channelListing.findMany({ where: { productId: { in: requests.map(item => item.productId) }, channel: context.channel,
      marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey }, select: { id: true, productId: true, workspaceId: true } })
    if (listings.length !== requests.length || requests.some(item => listings.filter(listing => listing.productId === item.productId).length !== 1)) throw new Error('An exact destination listing is missing or ambiguous; nothing was sent.')
    for (const item of requests) {
      const listing = listings.find(row => row.productId === item.productId)!
      const ids = idsFor(listing.workspaceId, context.reviewId, listing.id)
      const previous = await tx.channelListingSnapshot.findUnique({ where: { id: ids.snapshot } })
      let journal: PublicationJournal = { schemaVersion: 1, kind: 'studio-publication', productId: item.productId, channelConnectionId: context.accountId, sku: item.sku, requests: [] }
      if (previous) {
        journal = journalOf(previous.payload, context)
        if (previous.publishEventId !== context.reviewId || previous.channel !== context.channel || previous.marketplace !== context.marketplace || previous.aliasKey !== context.aliasKey
          || journal.productId !== item.productId || journal.sku !== item.sku) throw new Error('The publication journal identity or destination changed.')
        if (requestIndex < journal.requests.length) {
          if (digestPayload(journal.requests[requestIndex]) !== digestPayload(item.request)) throw new Error('This publication request ordinal already records a different payload.')
          continue
        }
        if (previous.outcome === 'ACCEPTED' || previous.acceptedAt) throw new Error('Accepted publication requests cannot be changed or extended.')
      }
      if (requestIndex !== journal.requests.length) throw new Error('Publication requests must be recorded in ordinal order without gaps.')
      journal = { ...journal, requests: [...journal.requests, item.request] }
      const payload = journal as unknown as Prisma.InputJsonValue
      if (previous) await tx.channelListingSnapshot.update({ where: { id: ids.snapshot }, data: { payload } })
      else await tx.channelListingSnapshot.create({ data: { id: ids.snapshot, channelListingId: listing.id, channel: context.channel, marketplace: context.marketplace,
        aliasKey: context.aliasKey, reason: 'publish', publishEventId: context.reviewId, capturedBy: context.userId, outcome: 'UNACCEPTED', payload } })
      await tx.channelPublishAttempt.upsert({ where: { id: ids.attempt }, create: { id: ids.attempt, channel: context.channel, marketplace: context.marketplace,
        sellerId: context.accountId, productId: item.productId, sku: item.sku, mode: 'live', outcome: 'pending', payloadDigest: digestPayload(journal.requests) },
      update: { payloadDigest: digestPayload(journal.requests) } })
    }
  })
}

/** Called in the operation-result transaction. A receipt ACK alone is never a content baseline. */
export async function settlePublicationRecords(tx: Prisma.TransactionClient, context: PublicationRecordContext, result: StudioPublishResult): Promise<void> {
  if (result.id !== context.reviewId) throw new Error('The provider result belongs to another publication review.')
  await lockReview(tx, context)
  const rows = await tx.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId, reason: 'publish', channel: context.channel,
    marketplace: context.marketplace, aliasKey: context.aliasKey, payload: { path: ['channelConnectionId'], equals: context.accountId } } })
  for (const row of rows) {
    if (row.outcome === 'ACCEPTED' || row.acceptedAt) continue
    const journal = journalOf(row.payload, context)
    const matches = result.results.filter(item => item.sku === journal.sku)
    if (matches.length > 1) throw new Error('The provider result has ambiguous duplicate SKU outcomes.')
    const receipt = matches[0]
    const accepted = !!receipt && ['ACCEPTED', 'VERIFIED'].includes(receipt.status)
      && (result.status === 'ACCEPTED' || result.status === 'VERIFIED' || (context.channel === 'AMAZON' && result.status === 'PARTIAL' && receipt.status === 'ACCEPTED'))
    const failed = !accepted && (result.status === 'FAILED' || receipt?.status === 'FAILED')
    const acknowledged = !failed && !!receipt?.reference && ['SUBMITTED', 'ACCEPTED', 'VERIFIED'].includes(receipt.status)
    const outcome = accepted ? 'ACCEPTED' : failed ? 'FAILED' : acknowledged ? 'SUBMITTED' : 'UNKNOWN'
    await tx.channelListingSnapshot.update({ where: { id: row.id }, data: { outcome, ...(accepted ? { acceptedAt: new Date() } : {}) } })
    await tx.channelPublishAttempt.update({ where: { id: idsFor(row.workspaceId, context.reviewId, row.channelListingId).attempt }, data: {
      outcome: accepted ? 'success' : failed ? 'failed' : acknowledged ? 'submitted' : 'unknown',
      ...(receipt?.reference ? { submissionId: receipt.reference } : {}), errorMessage: failed ? receipt?.message ?? result.message : null,
    } })
  }
}
