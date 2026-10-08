/**
 * set-listing-stock — the Matrix's "Set fulfilment…" and "Retry" for Claude (actions set-fulfilment and retry-sync), run
 * through the one door (call-tool.ts) on the Matrix door (`runMatrixVerb`, `revertMatrixOperation`), against a real
 * PostgreSQL with the production schema and business-isolation policies (PGlite). The job queue is faked.
 *
 * Proven here (Amazon fulfilment conversion, 2026-10-07): a fulfilment change lands on an Amazon EU market's whole group
 * (AMAZON:EU) and is SENT to Amazon — one Listings Items patch per open market, the SP-API client faked — after a person
 * approved the preview, which says what is sent where; the dry run sends nothing; revert-listing-change sends the
 * opposite conversion. FBA → FBM is refused while FBA units are on hand and while an active FBA offer remains — in the
 * preview and again at the run, nothing sent or written. Only Amazon coordinates and FBA/FBM are offered.
 * Retry sends the newest failed push again, refuses a push that only reads as failed (skipped), and has no undo.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ db: null as any, enqueue: null as any, submit: null as any }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../../lib/queue.js', () => {
  state.enqueue = vi.fn(async () => undefined)
  return { outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: state.enqueue }
})
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../stock-movement.service.js', async (original) => ({ ...(await original<object>()), recascadeAfterSyncControlChange: vi.fn(async () => ({ ok: 1, noLedger: 0, failed: 0, heldPricesSent: 0 })) }))
// Amazon is faked: every patch is answered ACCEPTED, and recorded.
vi.mock('../../../clients/amazon-sp-api.client.js', () => {
  state.submit = vi.fn(async (o: { sku: string }) => ({ success: true, sku: o.sku, status: 'ACCEPTED', rawResponse: { status: 'ACCEPTED', submissionId: 'sub-1', issues: [] } }))
  return { amazonSpApiClient: { submitListingPayload: state.submit } }
})
vi.mock('../../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: vi.fn(async () => 'SELLER-T2'), getAmazonRegion: vi.fn(async () => 'eu') }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { FULFILMENT_SENT, RETRY_SENDS_AGAIN, fulfilmentWords } from './listing-stock.tools.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-t2-asker')
const approver = person('u-t2-approver')
type Json = Record<string, any>
const db = () => state.db.client
const listingRow = async (id: string) => (await state.db.db.query(`SELECT "fulfillmentMethod", quantity, version FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]
const productMark = async (id: string) => (await state.db.db.query(`SELECT "fulfillmentMethod" FROM "Product" WHERE id = $1`, [id])).rows[0].fulfillmentMethod

const dryRun = async (args: Json) => (await inside(() => callTool(claude, 'set-listing-stock', args))).raw as Json
const runApproved = async (args: Json, preview: Json) =>
  (await inside(() => executeTool(approver, 'set-listing-stock', args, { approvedPreview: JSON.parse(JSON.stringify(preview)), via: 'claude' }))).raw as Json

const ids: Record<string, string> = {}

beforeAll(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  await inside(async () => {
    for (const [channel, code, region, currency] of [['EBAY', 'IT', 'EU', 'EUR'], ['AMAZON', 'IT', 'EU', 'EUR'], ['AMAZON', 'DE', 'EU', 'EUR'], ['AMAZON', 'UK', 'UK', 'GBP']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region, language: 'it', languages: ['it'] } as never })
    }
    const ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-T2-EBAY' } })).id
    const amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-T2-AMAZON' } })).id
    ids.parent = (await db().product.create({ data: { sku: 'TEST-SKU-T2', name: 'T2 jacket', basePrice: 10, isParent: true } })).id
    const child = (sku: string, fulfillmentMethod: string) => db().product.create({ data: { sku, name: sku, basePrice: 10, totalStock: 7, parentId: ids.parent, fulfillmentMethod } as never })
    ids.fbm = (await child('TEST-SKU-T2-M', 'FBM')).id
    ids.fba = (await child('TEST-SKU-T2-L', 'FBA')).id
    ids.offer = (await child('TEST-SKU-T2-S', 'FBA')).id
    const listing = (productId: string, channel: string, marketplace: string, extra: Json = {}) => db().channelListing.create({ data: { productId, channel, marketplace,
      channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: channel === 'EBAY' ? ebay : amazon,
      price: 10, quantity: 5, followMasterQuantity: true, listingStatus: 'ACTIVE', isPublished: true, ...extra } as never })
    ids.fbmIt = (await listing(ids.fbm, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM' })).id
    ids.fbmDe = (await listing(ids.fbm, 'AMAZON', 'DE', { fulfillmentMethod: 'FBM' })).id
    ids.fbmUk = (await listing(ids.fbm, 'AMAZON', 'UK', { fulfillmentMethod: 'FBM' })).id
    ids.fbmEbay = (await listing(ids.fbm, 'EBAY', 'IT', { externalListingId: 'TEST-ITEM-T2' })).id
    ids.fbaIt = (await listing(ids.fba, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA' })).id
    ids.fbaDe = (await listing(ids.fba, 'AMAZON', 'DE', { fulfillmentMethod: 'FBA' })).id
    ids.offerUk = (await listing(ids.offer, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA' })).id
    ids.offerRow = (await db().offer.create({ data: { channelListingId: ids.offerUk, fulfillmentMethod: 'FBA', sku: 'TEST-SKU-T2-S-FBA', isActive: true } })).id
    // Own stock the FBM listings follow, in a warehouse that is not IT-MAIN; FBA units at Amazon for the FBA variation.
    const wh = (await db().stockLocation.create({ data: { type: 'WAREHOUSE', code: 'WH-T2', name: 'T2 warehouse' } })).id
    const fbaLoc = (await db().stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA' } })).id
    for (const productId of [ids.fbm, ids.fba, ids.offer]) await db().stockLevel.create({ data: { locationId: wh, productId, quantity: 7, available: 7 } })
    await db().stockLevel.create({ data: { locationId: fbaLoc, productId: ids.fba, quantity: 3, available: 3 } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)

describe('set-listing-stock set-fulfilment', () => {
  const sent = () => state.submit.mock.calls.map(([o]: [any]) => ({ sku: o.sku, marketplaceId: o.marketplaceId, value: o.payload.patches[0].value, path: o.payload.patches[0].path, conversion: typeof o.conversionId === 'string' }))
  const records = async (listingIds: string[]) => (await state.db.db.query(`SELECT marketplace, "fromMethod", "toMethod", quantity, status, "operatorConfirmed", origin FROM "FulfilmentConversion" WHERE "channelListingId" = ANY($1) ORDER BY "createdAt", marketplace`, [listingIds])).rows

  it('FBM → FBA on an EU market lands on the EU group, is SENT to Amazon per market after the yes, and reverts by the opposite conversion', async () => {
    state.submit.mockClear()
    const args = { productId: ids.fbm, action: 'set-fulfilment', method: 'FBA', targets: [{ rowId: ids.fbm, coordinateKey: 'AMAZON:IT' }] }
    const preview = await dryRun(args)
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.preview).toMatchObject({ verb: 'set-fulfilment', changes: [{ coordinateKey: 'AMAZON:EU', cell: 'fulfilment', from: 'FBM', to: 'FBA',
      note: 'Sends Amazon FBA (adds AMAZON_EU, no quantity; removes DEFAULT) on IT DE — out of stock until Amazon receives units' }] })
    expect(preview.preview.summary).toBe('TEST-SKU-T2: set-fulfilment — 1 change on AMAZON:EU.')
    const warning = preview.preview.warning as string
    expect(warning).toContain('Amazon EU: this covers')
    expect(warning).toContain(FULFILMENT_SENT)
    expect(warning).toContain('Sent to Amazon on IT DE')
    expect(warning).toContain('shows out of stock on Amazon until Amazon receives units')
    expect(warning).toContain('TEST-SKU-T2-M on AMAZON:EU: Sends Amazon FBA (adds AMAZON_EU, no quantity; removes DEFAULT) on IT DE')
    // The dry run sent nothing and changed nothing.
    expect(state.submit).not.toHaveBeenCalled()
    expect((await listingRow(ids.fbmIt)).fulfillmentMethod).toBe('FBM')

    const ran = await runApproved(args, preview.preview)
    expect(ran.ok, ran.error).toBe(true)
    expect(sent()).toEqual([
      { sku: 'TEST-SKU-T2-M', marketplaceId: 'APJ6JRA9NG5V4', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'AMAZON_EU' }], conversion: true },
      { sku: 'TEST-SKU-T2-M', marketplaceId: 'A1PA6795UKMFR9', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'AMAZON_EU' }], conversion: true },
    ])
    expect([(await listingRow(ids.fbmIt)).fulfillmentMethod, (await listingRow(ids.fbmDe)).fulfillmentMethod, (await listingRow(ids.fbmUk)).fulfillmentMethod]).toEqual(['FBA', 'FBA', 'FBM'])
    expect(await productMark(ids.fbm)).toBe('FBA')
    expect((await records([ids.fbmIt, ids.fbmDe])).map((r: any) => [r.marketplace, r.fromMethod, r.toMethod, r.quantity, r.status, r.operatorConfirmed, r.origin]).sort())
      .toEqual([['DE', 'FBM', 'FBA', null, 'SENT', true, 'matrix-verb'], ['IT', 'FBM', 'FBA', null, 'SENT', true, 'matrix-verb']])

    state.submit.mockClear()
    const tool = getTool('set-listing-stock')!
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'revert-listing-change', args: { productId: ids.parent, operationId: ran.data.operationId } })
    const back = await inside(() => callTool(claude, 'revert-listing-change', undo.args))
    const reverted = (await inside(() => executeTool(approver, 'revert-listing-change', undo.args, { approvedPreview: (back.raw as Json).preview, via: 'claude' }))).raw as Json
    expect(reverted.ok, reverted.error).toBe(true)
    // The revert is the opposite conversion, sent: FBM with the quantity the listings follow (7 at WH-T2).
    expect(sent().map((x: any) => [x.marketplaceId, x.value])).toEqual([
      ['APJ6JRA9NG5V4', [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }]],
      ['A1PA6795UKMFR9', [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }]],
    ])
    expect([(await listingRow(ids.fbmIt)).fulfillmentMethod, (await listingRow(ids.fbmDe)).fulfillmentMethod]).toEqual(['FBM', 'FBM'])
    expect([(await listingRow(ids.fbmIt)).quantity, (await listingRow(ids.fbmDe)).quantity]).toEqual([7, 7])
    expect(await productMark(ids.fbm)).toBe('FBM')
    expect((await records([ids.fbmIt, ids.fbmDe])).filter((r: any) => r.origin === 'matrix-revert').map((r: any) => [r.marketplace, r.toMethod, r.quantity, r.status]).sort())
      .toEqual([['DE', 'FBM', 7, 'SENT'], ['IT', 'FBM', 7, 'SENT']])
  })

  it('FBA → FBM is refused while FBA units are on hand; nothing is sent or written', async () => {
    state.submit.mockClear()
    const before = [await listingRow(ids.fbaIt), await listingRow(ids.fbaDe)]
    const refused = await dryRun({ productId: ids.fba, action: 'set-fulfilment', method: 'FBM', targets: [{ rowId: ids.fba, coordinateKey: 'AMAZON:DE' }] })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('3 units of FBA stock on hand keep the guard closed') })
    expect([await listingRow(ids.fbaIt), await listingRow(ids.fbaDe)]).toEqual(before)
    expect(state.submit).not.toHaveBeenCalled()
  })

  it('FBA → FBM is refused while an active FBA offer remains — in the preview, and again at the run', async () => {
    state.submit.mockClear()
    const args = { productId: ids.offer, action: 'set-fulfilment', method: 'FBM', targets: [{ rowId: ids.offer, coordinateKey: 'AMAZON:UK' }] }
    expect(await dryRun(args)).toMatchObject({ ok: false, error: expect.stringContaining('an active FBA offer keeps the guard closed') })

    await inside(() => db().offer.update({ where: { id: ids.offerRow }, data: { isActive: false } }))
    const preview = await dryRun(args)
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.preview.changes).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:UK', from: 'FBA', to: 'FBM', note: 'Sends Amazon FBM (adds DEFAULT, quantity 7; removes AMAZON_EU) on UK' })])
    expect(preview.preview.warning).toContain('TEST-SKU-T2-S on AMAZON:UK: Sends Amazon FBM (adds DEFAULT, quantity 7; removes AMAZON_EU) on UK. Once Amazon accepts, Nexus manages the merchant quantity from then on.')

    // The offer comes back before the person's yes runs: refused whole, nothing sent or written.
    await inside(() => db().offer.update({ where: { id: ids.offerRow }, data: { isActive: true } }))
    const before = await listingRow(ids.offerUk)
    const ran = await runApproved(args, preview.preview)
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('Nothing changed; ask Claude again') })
    expect(ran.error).toContain('an active FBA offer')
    expect(await listingRow(ids.offerUk)).toEqual(before)
    expect(await productMark(ids.offer)).toBe('FBA')
    expect(state.submit).not.toHaveBeenCalled()
  })

  it('offers Amazon\'s FBA and FBM only, on Amazon coordinates only, and a method only with set-fulfilment', async () => {
    const target = (coordinateKey: string) => [{ rowId: ids.fbm, coordinateKey }]
    expect(await dryRun({ productId: ids.fbm, action: 'set-fulfilment', method: 'FBM', targets: target('EBAY:IT') }))
      .toMatchObject({ ok: false, error: expect.stringContaining('set-fulfilment changes Amazon listings only') })
    expect(await dryRun({ productId: ids.fbm, action: 'set-fulfilment', targets: target('AMAZON:IT') }))
      .toMatchObject({ ok: false, error: expect.stringContaining('set-fulfilment needs a method: FBA or FBM.') })
    expect(await dryRun({ productId: ids.fbm, action: 'set-follow', method: 'FBA', targets: target('AMAZON:IT') }))
      .toMatchObject({ ok: false, error: expect.stringContaining('A method is given with set-fulfilment only.') })
    await expect(dryRun({ productId: ids.fbm, action: 'set-fulfilment', method: 'MCF', targets: target('AMAZON:IT') })).rejects.toThrow('expected one of "FBA"|"FBM"')
  })
})

describe('set-listing-stock retry-sync', () => {
  it('sends the newest failed push again as approved; a push cannot be called back', async () => {
    const row = await inside(() => db().outboundSyncQueue.create({ data: { productId: ids.fbm, channelListingId: ids.fbmEbay, targetChannel: 'EBAY', syncStatus: 'FAILED',
      syncType: 'QUANTITY_UPDATE', payload: { quantity: 5 }, errorMessage: 'eBay refused the call', retryCount: 3 } as never }))
    const args = { productId: ids.fbm, action: 'retry-sync', targets: [{ rowId: ids.fbm, coordinateKey: 'EBAY:IT' }] }
    const preview = await dryRun(args)
    expect(preview.ok, preview.error).toBe(true)
    expect(preview.preview.changes).toEqual([expect.objectContaining({ coordinateKey: 'EBAY:IT', cell: 'syncState', from: 'failed', to: 'queued', note: 'eBay refused the call' })])
    expect(preview.preview.warning).toBe(`${RETRY_SENDS_AGAIN} TEST-SKU-T2-M on EBAY:IT: its failed quantity push is sent again.`)

    state.enqueue.mockClear()
    const ran = await runApproved(args, preview.preview)
    expect(ran.ok, ran.error).toBe(true)
    expect(await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: row.id } }))).toMatchObject({ syncStatus: 'PENDING', retryCount: 0, errorMessage: null, isDead: false })
    expect(state.enqueue).toHaveBeenCalledWith(null, 'sync-job', expect.objectContaining({ queueId: row.id, syncType: 'QUANTITY_UPDATE' }), expect.anything())
    expect(getTool('set-listing-stock')!.undo!.request(ran.change)).toEqual({ refusal: expect.stringContaining('cannot be called back') })
  })

  it('a push that only reads as failed (skipped) is not offered: Retry sends failed or dead pushes only', async () => {
    await inside(() => db().outboundSyncQueue.create({ data: { productId: ids.fbm, channelListingId: ids.fbmUk, targetChannel: 'AMAZON', syncStatus: 'SKIPPED',
      syncType: 'QUANTITY_UPDATE', payload: { quantity: 5 }, errorMessage: 'guard-held' } as never }))
    const refused = await dryRun({ productId: ids.fbm, action: 'retry-sync', targets: [{ rowId: ids.fbm, coordinateKey: 'AMAZON:UK' }] })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to retry on this coordinate') })
  })
})

describe('fulfilmentWords', () => {
  it('FBM: what is sent, then Nexus manages the merchant quantity', () => {
    expect(fulfilmentWords({ sku: 'S1', coordinateKey: 'AMAZON:EU', method: 'FBM', note: 'Sends Amazon FBM (adds DEFAULT, quantity 4; removes AMAZON_EU) on IT DE — skips FR (Inactive)' }))
      .toBe('S1 on AMAZON:EU: Sends Amazon FBM (adds DEFAULT, quantity 4; removes AMAZON_EU) on IT DE — skips FR (Inactive). Once Amazon accepts, Nexus manages the merchant quantity from then on.')
  })

  it('FBA: no quantity from then on, out of stock until Amazon receives units', () => {
    expect(fulfilmentWords({ sku: 'S1', coordinateKey: 'AMAZON:UK', method: 'FBA', note: null }))
      .toBe('S1 on AMAZON:UK: Sends Amazon FBA. Once Amazon accepts, Nexus sends no quantity: the quantity is Amazon\'s FBA units, and the offer shows out of stock until Amazon receives units.')
  })
})
