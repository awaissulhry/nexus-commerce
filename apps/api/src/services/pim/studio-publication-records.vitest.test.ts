import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { StudioPublishResult } from '@nexus/shared/studio-publication'

const fixture = vi.hoisted(() => ({ database: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  fixture.database = await formulaDatabase()
  return { default: fixture.database.client }
})

import prisma from '../../db.js'
import { digestPayload } from '../channel-publish-audit.service.js'
import { recordPublicationRequests, settlePublicationRecords, type PublicationRecordContext } from './studio-publication-records.js'

const context: PublicationRecordContext = { reviewId: 'pco-record-review', userId: 'operator', channel: 'AMAZON', marketplace: 'IT', accountId: 'pco-record-account', aliasKey: '' }
const products = ['pco-record-parent', 'pco-record-child']
const items = () => products.map((productId, index) => ({ productId, sku: `SELLER-${index}`, request: { sku: `SELLER-${index}`, attributes: { item_name: [{ value: `Saved ${index}`, language_tag: 'it_IT' }] } } }))
const snapshots = () => prisma.channelListingSnapshot.findMany({ where: { publishEventId: context.reviewId }, orderBy: { channelListingId: 'asc' } })
const attempts = () => prisma.channelPublishAttempt.findMany({ where: { productId: { in: products } }, orderBy: { sku: 'asc' } })
const result = (status: StudioPublishResult['status'], statuses: StudioPublishResult['results'][number]['status'][] = []) => ({
  id: context.reviewId, status, message: 'Provider result', results: statuses.map((state, index) => ({ sku: `SELLER-${index}`, status: state, reference: 'provider-reference', message: state })),
}) satisfies StudioPublishResult
const settle = (value: StudioPublishResult, scope = context) => prisma.$transaction(tx => settlePublicationRecords(tx, scope, value))

beforeAll(async () => {
  await prisma.product.createMany({ data: products.map((id, index) => ({ id, sku: `LOCAL-${index}`, name: `Product ${index}`, basePrice: 10, status: 'DRAFT' })) })
  await prisma.channelConnection.createMany({ data: [{ id: context.accountId, channelType: 'AMAZON', isActive: true }, { id: 'other-record-account', channelType: 'AMAZON', isActive: true }] })
}, 120_000)
beforeEach(async () => {
  await prisma.channelPublishAttempt.deleteMany({ where: { productId: { in: products } } })
  await prisma.channelListing.deleteMany({ where: { productId: { in: products } } })
  await prisma.channelListing.createMany({ data: products.map((productId, index) => ({ id: `pco-record-listing-${index}`, productId, channel: context.channel, marketplace: context.marketplace,
    region: context.marketplace, channelMarket: 'AMAZON_IT', channelConnectionId: context.accountId, aliasKey: '', title: 'Current local state is not the sent payload' })) })
})
afterAll(async () => { await fixture.database?.close() }, 30_000)

it('durably records the exact per-listing intent and awaited audit before the caller can send', async () => {
  const requests = items()
  await recordPublicationRequests(context, requests)
  requests[0].request.attributes.item_name[0].value = 'Changed after capture'
  const saved = await snapshots(), audit = await attempts()
  expect(saved).toHaveLength(2); expect(audit).toHaveLength(2)
  for (const [index, snapshot] of saved.entries()) {
    expect(snapshot).toMatchObject({ channelListingId: `pco-record-listing-${index}`, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', reason: 'publish', publishEventId: context.reviewId,
      capturedBy: context.userId, outcome: 'UNACCEPTED', acceptedAt: null,
      payload: { schemaVersion: 1, kind: 'studio-publication', productId: products[index], channelConnectionId: context.accountId, sku: `SELLER-${index}`, requests: [items()[index].request] } })
    expect(audit[index]).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', sellerId: context.accountId, productId: products[index], sku: `SELLER-${index}`, mode: 'live', outcome: 'pending', submissionId: null,
      payloadDigest: digestPayload([items()[index].request]) })
  }
})

it.each([{ accountId: 'other-record-account' }, { marketplace: 'DE' }, { channel: 'EBAY' }, { aliasKey: 'another-alias' }])('refuses a missing exact coordinate without recording any intent (%j)', async wrong => {
  await expect(recordPublicationRequests({ ...context, ...wrong }, items())).rejects.toThrow(/listing|destination/i)
  expect(await snapshots()).toEqual([]); expect(await attempts()).toEqual([])
})

it('does not record a partial family when one requested listing is missing', async () => {
  await prisma.channelListing.delete({ where: { id: 'pco-record-listing-1' } })
  await expect(recordPublicationRequests(context, items())).rejects.toThrow(/listing|destination/i)
  expect(await snapshots()).toEqual([]); expect(await attempts()).toEqual([])
})

it('refuses duplicate product or provider-SKU attribution', async () => {
  await expect(recordPublicationRequests(context, [items()[0], items()[0]])).rejects.toThrow(/duplicate|ambiguous/i)
  await expect(recordPublicationRequests(context, items().map(item => ({ ...item, sku: 'SAME' })))).rejects.toThrow(/duplicate|ambiguous/i)
  expect(await snapshots()).toEqual([])
})

it('reuses the same ordinal only for the same exact request and preserves deterministic rows', async () => {
  await recordPublicationRequests(context, items())
  const before = await snapshots(), beforeAttempts = await attempts()
  await recordPublicationRequests(context, items())
  expect(await snapshots()).toEqual(before); expect(await attempts()).toEqual(beforeAttempts)
  const changed = items(); changed[0].request.attributes.item_name[0].value = 'Different request'
  await expect(recordPublicationRequests(context, changed)).rejects.toThrow(/request|payload/i)
  expect(await snapshots()).toEqual(before); expect(await attempts()).toEqual(beforeAttempts)
})

it('appends ordered mutation requests and refuses gaps or identity changes', async () => {
  await expect(recordPublicationRequests(context, items(), 1)).rejects.toThrow(/order|ordinal|index/i)
  await recordPublicationRequests(context, items())
  const second = items().map(item => ({ ...item, request: { query: 'mutation Exact', variables: { id: item.productId, text: 'Second request' } } }))
  await recordPublicationRequests(context, second, 1)
  for (const [index, snapshot] of (await snapshots()).entries()) {
    expect(snapshot.payload).toMatchObject({ requests: [items()[index].request, second[index].request] })
    expect((await attempts())[index].payloadDigest).toBe(digestPayload([items()[index].request, second[index].request]))
  }
  await expect(recordPublicationRequests(context, second, 3)).rejects.toThrow(/order|ordinal|index/i)
  await expect(recordPublicationRequests(context, second.map(item => ({ ...item, sku: 'CHANGED-' + item.sku })), 2)).rejects.toThrow(/identity|SKU|attribution/i)
})

it('keeps Amazon feed acknowledgement unaccepted and accepts only successful provider SKUs in a partial report', async () => {
  await recordPublicationRequests(context, items())
  await settle(result('SUBMITTED', ['SUBMITTED', 'SUBMITTED']))
  expect((await snapshots()).every(row => row.acceptedAt === null)).toBe(true)
  expect((await attempts()).map(row => row.outcome)).toEqual(['submitted', 'submitted'])
  await settle(result('PARTIAL', ['ACCEPTED', 'FAILED']))
  expect((await snapshots()).map(row => [row.outcome, row.acceptedAt instanceof Date])).toEqual([['ACCEPTED', true], ['FAILED', false]])
  expect((await attempts()).map(row => [row.outcome, row.submissionId])).toEqual([['success', 'provider-reference'], ['failed', 'provider-reference']])
})

it('never promotes an eBay ACK until the overall result confirms an active listing', async () => {
  await prisma.channelListing.updateMany({ where: { productId: { in: products } }, data: { channel: 'EBAY', channelMarket: 'EBAY_IT' } })
  const ebay = { ...context, channel: 'EBAY' }
  await recordPublicationRequests(ebay, items())
  await settle(result('UNVERIFIED', ['ACCEPTED', 'ACCEPTED']), ebay)
  expect((await snapshots()).every(row => row.acceptedAt === null && row.outcome !== 'ACCEPTED')).toBe(true)
  await settle(result('PARTIAL', ['ACCEPTED', 'FAILED']), ebay)
  expect((await snapshots()).every(row => row.acceptedAt === null)).toBe(true)
  await settle(result('ACCEPTED', ['ACCEPTED', 'ACCEPTED']), ebay)
  expect((await snapshots()).every(row => row.outcome === 'ACCEPTED' && row.acceptedAt instanceof Date)).toBe(true)
})

it.each(['UNVERIFIED', 'FAILED'] as const)('never advances baselines from %s', async status => {
  await recordPublicationRequests(context, items())
  await settle(result(status))
  expect((await snapshots()).every(row => row.acceptedAt === null && row.outcome !== 'ACCEPTED')).toBe(true)
  expect((await attempts()).map(row => row.outcome)).toEqual(status === 'FAILED' ? ['failed', 'failed'] : ['unknown', 'unknown'])
})

it('uses recorded provider SKUs and does not infer acceptance for missing result rows', async () => {
  await recordPublicationRequests(context, items())
  await settle({ ...result('ACCEPTED'), results: [{ sku: 'LOCAL-0', status: 'ACCEPTED', reference: 'wrong-SKU', message: 'Not the submitted identity' }] })
  expect((await snapshots()).every(row => row.acceptedAt === null)).toBe(true)
  await expect(settle({ ...result('ACCEPTED', ['ACCEPTED']), id: 'wrong-review' })).rejects.toThrow(/review/i)
})

it('keeps acceptance timestamps and audit success stable under repeated or stale status polling', async () => {
  await recordPublicationRequests(context, items())
  await settle(result('VERIFIED', ['VERIFIED', 'VERIFIED']))
  const before = await snapshots(), beforeAttempts = await attempts()
  await settle(result('VERIFIED', ['VERIFIED', 'VERIFIED']))
  await settle(result('SUBMITTED', ['SUBMITTED', 'SUBMITTED']))
  await settle(result('UNVERIFIED'))
  expect(await snapshots()).toEqual(before); expect(await attempts()).toEqual(beforeAttempts)
  await recordPublicationRequests(context, items())
  await expect(recordPublicationRequests(context, items(), 1)).rejects.toThrow(/accepted/i)
  expect(await snapshots()).toEqual(before)
})

it('leaves legacy reviews without journals alone', async () => {
  await settle(result('ACCEPTED', ['ACCEPTED', 'ACCEPTED']))
  expect(await snapshots()).toEqual([]); expect(await attempts()).toEqual([])
})

it('rolls back the entire family journal if any awaited audit insert fails', async () => {
  await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" ADD CONSTRAINT "pco_records_failure" CHECK (sku <> \'SELLER-1\')')
  try {
    await expect(recordPublicationRequests(context, items())).rejects.toThrow()
    expect(await snapshots()).toEqual([]); expect(await attempts()).toEqual([])
  } finally { await fixture.database.db.exec('ALTER TABLE "ChannelPublishAttempt" DROP CONSTRAINT "pco_records_failure"') }
})

it('rolls back snapshot acceptance and audits when the operation-result transaction fails', async () => {
  await recordPublicationRequests(context, items())
  const before = await snapshots(), beforeAttempts = await attempts()
  await expect(prisma.$transaction(async tx => {
    await settlePublicationRecords(tx, context, result('ACCEPTED', ['ACCEPTED', 'ACCEPTED']))
    throw new Error('result persistence failed')
  })).rejects.toThrow('result persistence failed')
  expect(await snapshots()).toEqual(before); expect(await attempts()).toEqual(beforeAttempts)
})
