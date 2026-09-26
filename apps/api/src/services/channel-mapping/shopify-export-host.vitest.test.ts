/**
 * NCF N7 — the whole loop on a real PostgreSQL (PGlite): Shopify's product CSV is imported (preview → apply), its
 * mapping version activated, and the file written back through that ACTIVE version — the same cells, the use recorded,
 * nothing queued for Shopify.
 */
import { beforeAll, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../pim/readiness-index.service.js', () => ({ produceReadiness: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readShopifyCsv, resolveShopifyCsv } from '../pim/catalog-shopify-csv.js'
import { csvOf, SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS } from '../pim/catalog-transfer-test/shopify-csv-fixtures.js'
import { compareShopifyCsv } from './shopify-export.js'
import { shopifyChannelKeyOf } from './shopify-draft.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let store = ''
beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  store = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', displayName: 'ACME store', isActive: true } })).id
  const product = (sku: string, parentId?: string) => prisma.product.create({ data: { id: `p-${sku}`, sku, name: sku, basePrice: 10, ...(parentId ? { parentId } : { isParent: sku === 'ACME-JACKET' }) } })
  const jacket = await product('ACME-JACKET')
  for (const size of ['S', 'M', 'L']) await product(`ACME-JACKET-${size}`, jacket.id)
  await product('ACME-CAP')
  for (const sku of ['ACME-JACKET', 'ACME-JACKET-S', 'ACME-JACKET-M', 'ACME-JACKET-L', 'ACME-CAP'])
    await prisma.channelListing.create({ data: { productId: `p-${sku}`, channel: 'SHOPIFY', channelConnectionId: store, channelMarket: 'SHOPIFY_GLOBAL', marketplace: 'GLOBAL', region: 'GLOBAL', platformAttributes: {} } })
}), 120_000)

it('imports Shopify’s file, then writes it back through the ACTIVE version: the same cells', () => scoped(async () => {
  const bytes = csvOf(SHOPIFY_CLASSIC_HEADERS, SHOPIFY_SAMPLE_ROWS.map(r => r['Variant SKU'] ? { ...r, 'Variant Compare At Price': r['Variant Compare At Price'] || '99.00' } : r))
  const table = readShopifyCsv(bytes)
  // Nothing is linked yet: both products are link proposals, and nothing is read.
  const first = await resolveShopifyCsv(table)
  expect(first.links.map(l => [l.fileSku, l.proposedSku])).toEqual([['acme-jacket', 'ACME-JACKET'], ['acme-cap', 'ACME-CAP']])
  expect(first.rows).toEqual([])
  // The Owner confirms the links; the preview is staged and applied.
  const read = await resolveShopifyCsv(table, { links: Object.fromEntries(first.links.map(l => [l.fileSku, l.proposedSku])) })
  const { stageTransferJob, applyTransferJob, readTransferJob, transferJobStatus } = await import('../pim/catalog-transfer-jobs.js')
  const job = await stageTransferJob({ rows: read.rows, issues: [], mode: 'update', market: 'GLOBAL', filename: 'products_export_1.csv', userId: null })
  const wait = async (states: string[]) => { let s: ReturnType<typeof transferJobStatus> | null = null
    await vi.waitFor(async () => { const loaded = (await readTransferJob(job.jobId, null))!; expect(states).toContain(loaded.job.status); s = transferJobStatus(loaded) }, { timeout: 60_000, interval: 50 }); return s! }
  const reviewed = await wait(['QUEUED', 'INVALID'])
  expect(reviewed.state).toBe('QUEUED')
  await applyTransferJob(job.jobId, null, reviewed.reviewToken!)
  expect((await wait(['COMPLETED', 'PARTIAL', 'FAILED'])).state).toBe('COMPLETED')
  expect(await prisma.outboundSyncQueue.count()).toBe(0)
  // The version the import made is activated, and the file is written back through it.
  const { activateSet } = await import('./store.js')
  await activateSet(read.mapping!.setId)
  const { exportShopifyCsv } = await import('./shopify-export-host.js')
  const out = await exportShopifyCsv({ setId: read.mapping!.setId, skus: ['ACME-JACKET', 'ACME-CAP'] })
  expect(out.bytes.toString('utf8').includes('\r')).toBe(false)
  expect(out).toMatchObject({ products: 2, variants: 4, refused: [] })
  expect(out.headers).toEqual(expect.arrayContaining(['Handle', 'Title', 'Vendor', 'Type', 'Tags', 'Variant SKU', 'Variant Price', 'Variant Compare At Price', 'Status', 'Option1 Name', 'Option1 Value']))
  const back = readShopifyCsv(out.bytes)
  const cmp = compareShopifyCsv(table, { headers: back.headers, rows: back.records.map(r => back.headers.map(h => r.values[h])) }, shopifyChannelKeyOf)
  expect({ differ: cmp.differ, missing: cmp.missing, extra: cmp.extra }).toEqual({ differ: [], missing: [], extra: [] })
  expect(cmp.compared).toBe(cmp.equal)
  expect(cmp.compared).toBeGreaterThan(40)
  expect(await prisma.channelMappingUse.findMany({ where: { setId: read.mapping!.setId, action: 'EXPORT' }, select: { detail: true } })).toEqual([{ detail: { products: 2, rows: 4, omittedColumns: out.omitted.length, refusedProducts: 0 } }])
}), 180_000)
