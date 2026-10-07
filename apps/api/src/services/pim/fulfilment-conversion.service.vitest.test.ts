/**
 * Amazon fulfilment conversion (Owner 2026-10-07: "A fulfillment channel change from FBA to FBM or from FBM to FBA must
 * actually reach the channel … make sure that it is certain").
 *
 * Through the Matrix door (`runMatrixVerb`) on a real PostgreSQL with the production schema and business-isolation
 * policies (PGlite); Amazon is faked at the SP-API client (`submitListingPayload`), so every patch Nexus would send is
 * recorded and answered as the test says. Proven here:
 *   - the preview refuses by name (FBA units on hand / reserved / inbound, an active FBA offer, an Amazon-only code, a
 *     draft, every market Inactive, a change already on its way) and tells (markets, skipped markets, the quantity, the
 *     EU single quantity, FBA out of stock until units arrive, Amazon's report);
 *   - FBA → FBM: the exact patch per open market, records SENT, Nexus FBM only on the markets Amazon accepted, the
 *     quantity stored, the product's FBA mark moved (an untyped listing that leaned on it set FBA explicitly first);
 *     Amazon refusing one market names it; refusing all changes nothing; a gated server sends nothing;
 *   - FBM → FBA: Nexus FBA and the waiting quantity pushes cancelled BEFORE the patch; Amazon refusing all puts it back;
 *   - a direct cell write is refused; eBay MCF stays Nexus-only and says so;
 *   - the Matrix's Fulfilment cell shows the newest run; the confirmation job reads the report and confirms, says still
 *     old or not in the report, and rewrites the reported copy; the drift detector's question.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, submit: null as any, onSubmit: null as null | ((o: any) => Promise<void> | void) }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../stock-movement.service.js', async (original) => ({ ...(await original<object>()), recascadeAfterSyncControlChange: vi.fn(async () => ({ ok: 1, noLedger: 0, failed: 0, heldPricesSent: 0 })) }))
vi.mock('../../clients/amazon-sp-api.client.js', () => {
  state.submit = vi.fn()
  return { amazonSpApiClient: { submitListingPayload: state.submit } }
})
vi.mock('../../lib/amazon-sp-client.js', async (original) => ({ ...(await original<object>()), getAmazonSellerId: vi.fn(async () => 'SELLER-FC'), getAmazonRegion: vi.fn(async () => 'eu') }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { MATRIX_COPY, type VerbPreview } from '@nexus/shared/matrix-contract'
import { runMatrixVerb, writeMatrixCells, revertMatrixOperation, type VerbCommitResult } from './matrix-write.service.js'
import { getMatrixRead } from './matrix.service.js'
import { confirmFulfilmentConversions, operatorFbmConversions } from './fulfilment-conversion.service.js'
import { reportedFulfilment } from './matrix-cells.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => state.db.client
const q = async (sql: string, params: unknown[] = []) => (await state.db.db.query(sql, params)).rows as any[]
type Json = Record<string, any>

const IT = 'APJ6JRA9NG5V4', DE = 'A1PA6795UKMFR9'
const ids: Record<string, string> = {}
const accepted = (o: { sku: string }) => ({ success: true, sku: o.sku, status: 'ACCEPTED', rawResponse: { status: 'ACCEPTED', submissionId: `sub-${o.sku}`, issues: [] } })
const sent = () => state.submit.mock.calls.map(([o]: [any]) => ({ sku: o.sku, marketplaceId: o.marketplaceId, sellerId: o.sellerId, value: o.payload.patches[0].value, conversionId: o.conversionId }))

const ctx = (productId: string) => ({ productId, actor: 'person-1', can: () => true })
const preview = async (rowId: string, coordinateKey: string, method: 'FBA' | 'FBM') =>
  inside(() => runMatrixVerb(ctx(ids.parent), { params: { verb: 'set-fulfilment', method }, targets: [{ rowId, coordinateKey }], commit: false })) as Promise<VerbPreview>
const commit = async (p: VerbPreview) =>
  inside(() => runMatrixVerb(ctx(ids.parent), { params: { verb: p.verb }, targets: p.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: p })) as Promise<VerbCommitResult>
const listing = async (id: string) => (await q(`SELECT "fulfillmentMethod", quantity, version, "platformAttributes" FROM "ChannelListing" WHERE id = $1`, [id]))[0]
const mark = async (id: string) => (await q(`SELECT "fulfillmentMethod" FROM "Product" WHERE id = $1`, [id]))[0].fulfillmentMethod
const runs = async (listingIds: string[]) => q(`SELECT marketplace, "toMethod", quantity, status, message, payload, "operatorConfirmed" FROM "FulfilmentConversion" WHERE "channelListingId" = ANY($1) ORDER BY "createdAt", marketplace`, [listingIds])

beforeAll(async () => {
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  await inside(async () => {
    for (const [channel, code, region, currency] of [['EBAY', 'IT', 'EU', 'EUR'], ['AMAZON', 'IT', 'EU', 'EUR'], ['AMAZON', 'DE', 'EU', 'EUR'], ['AMAZON', 'FR', 'EU', 'EUR'], ['AMAZON', 'UK', 'UK', 'GBP']]) {
      await db().marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region, language: 'it', languages: ['it'] } as never })
    }
    const ebay = (await db().channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-FC-EBAY' } })).id
    const amazon = (await db().channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-FC-AMAZON' } })).id
    ids.amazon = amazon
    ids.parent = (await db().product.create({ data: { sku: 'TEST-SKU-FC', name: 'FC jacket', basePrice: 10, isParent: true } })).id
    const child = (sku: string, fulfillmentMethod: string | null) => db().product.create({ data: { sku, name: sku, basePrice: 10, totalStock: 7, parentId: ids.parent, fulfillmentMethod } as never })
    const row = (productId: string, channel: string, marketplace: string, extra: Json = {}) => db().channelListing.create({ data: { productId, channel, marketplace,
      channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: channel === 'EBAY' ? ebay : amazon,
      price: 10, quantity: 2, followMasterQuantity: true, stockBuffer: 1, listingStatus: 'ACTIVE', isPublished: true, externalListingId: `ASIN-${marketplace}`, ...extra } as never })
    // The family's parent listing on UK: it has no offer of its own.
    ids.parentUk = (await row(ids.parent, 'AMAZON', 'UK', { fulfillmentMethod: null })).id
    // A — FBA in Nexus on IT DE (open), FR (Inactive: selling paused), and an untyped UK listing that leans on the FBA mark.
    ids.a = (await child('TEST-SKU-FC-A', 'FBA')).id
    ids.aIt = (await row(ids.a, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA', platformAttributes: { amazonFulfillment: { lead_time_to_ship_max_days: 2 } } })).id
    ids.aDe = (await row(ids.a, 'AMAZON', 'DE', { fulfillmentMethod: 'FBA' })).id
    ids.aFr = (await row(ids.a, 'AMAZON', 'FR', { fulfillmentMethod: 'FBA', offerClosedAt: new Date() })).id
    ids.aUk = (await row(ids.a, 'AMAZON', 'UK', { fulfillmentMethod: null })).id
    // B — FBA on IT and DE: Amazon refuses DE (partial), then everything (refused whole).
    ids.b = (await child('TEST-SKU-FC-B', 'FBA')).id
    ids.bIt = (await row(ids.b, 'AMAZON', 'IT', { fulfillmentMethod: 'FBA' })).id
    ids.bDe = (await row(ids.b, 'AMAZON', 'DE', { fulfillmentMethod: 'FBA' })).id
    // C — FBM on IT DE, and eBay: converted to FBA.
    ids.c = (await child('TEST-SKU-FC-C', 'FBM')).id
    ids.cIt = (await row(ids.c, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM' })).id
    ids.cDe = (await row(ids.c, 'AMAZON', 'DE', { fulfillmentMethod: 'FBM' })).id
    ids.cEbay = (await row(ids.c, 'EBAY', 'IT', { externalListingId: 'TEST-ITEM-FC' })).id
    // D — the refusals: FBA, each with one fact that keeps it FBA.
    ids.reserved = (await child('TEST-SKU-FC-RES', 'FBA')).id
    ids.reservedUk = (await row(ids.reserved, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA' })).id
    ids.inbound = (await child('TEST-SKU-FC-INB', 'FBA')).id
    ids.inboundUk = (await row(ids.inbound, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA' })).id
    ids.remote = (await child('TEST-SKU-FC-RAFN', 'FBA')).id
    ids.remoteUk = (await row(ids.remote, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA', platformAttributes: { fulfillment_availability: [{ fulfillment_channel_code: 'AMAZON_EU_RAFN' }] } })).id
    ids.draft = (await child('TEST-SKU-FC-DRAFT', 'FBA')).id
    ids.draftUk = (await row(ids.draft, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA', listingStatus: 'DRAFT', isPublished: false, externalListingId: null })).id
    ids.onHand = (await child('TEST-SKU-FC-HAND', 'FBA')).id
    ids.onHandUk = (await row(ids.onHand, 'AMAZON', 'UK', { fulfillmentMethod: 'FBA' })).id
    const wh = (await db().stockLocation.create({ data: { type: 'WAREHOUSE', code: 'WH-FC', name: 'FC warehouse' } })).id
    const fbaLoc = (await db().stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon EU FBA' } })).id
    for (const productId of [ids.a, ids.b, ids.c, ids.reserved, ids.inbound, ids.remote, ids.draft, ids.onHand]) await db().stockLevel.create({ data: { locationId: wh, productId, quantity: 7, available: 7 } })
    await db().stockLevel.create({ data: { locationId: fbaLoc, productId: ids.onHand, quantity: 4, available: 4 } })
    await db().fbaInventoryDetail.create({ data: { productId: ids.reserved, sku: 'TEST-SKU-FC-RES', marketplaceId: 'A1F83G8C2ARO7P', fulfillmentCenterId: 'LTN1', condition: 'RESERVED', quantity: 2 } })
    await db().fbaInventoryDetail.create({ data: { productId: null, sku: 'TEST-SKU-FC-INB', marketplaceId: 'A1F83G8C2ARO7P', fulfillmentCenterId: 'LTN1', condition: 'INBOUND', quantity: 5 } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => { state.submit.mockReset().mockImplementation(async (o: any) => { await state.onSubmit?.(o); return accepted(o) }); state.onSubmit = null })

describe('the preview refuses by name and tells what is sent', () => {
  it('FBA → FBM on the Amazon EU group: the open markets, the Inactive one skipped, the quantity, ONE EU quantity, Amazon\'s report; type the method', async () => {
    const p = await preview(ids.a, 'AMAZON:IT', 'FBM')
    expect(p.refusals).toEqual([])
    expect(p.changes).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:EU', cell: 'fulfilment', from: 'FBA', to: 'FBM', note: 'Sends Amazon FBM (DEFAULT) with quantity 6 on IT DE — skips FR (Inactive)' })])
    expect(p.notices).toEqual(expect.arrayContaining([MATRIX_COPY.fulfilmentSent(['IT', 'DE']), MATRIX_COPY.fulfilmentEuQuantity]))
    expect(p).toMatchObject({ confirm: 'type-to-confirm', confirmWord: 'FBM' })
    expect(state.submit).not.toHaveBeenCalled()
  })

  it.each([
    ['FBA units on hand', 'onHand', 'onHandUk', 'Refused — 4 units of FBA stock on hand keep the guard closed'],
    ['FBA units reserved', 'reserved', 'reservedUk', 'Refused — 2 FBA units reserved at Amazon keep the guard closed'],
    ['FBA units inbound (by SKU)', 'inbound', 'inboundUk', 'Refused — 5 FBA units inbound to Amazon keep the guard closed'],
    ['an Amazon-only code', 'remote', 'remoteUk', 'Refused — Remote Fulfilment'],
    ['a draft', 'draft', 'draftUk', 'Not listed on Amazon yet — there is no offer to convert'],
  ])('FBA → FBM refused: %s', async (_name, product, _listing, reason) => {
    const p = await preview(ids[product]!, 'AMAZON:UK', 'FBM')
    expect(p.changes).toEqual([])
    expect(p.refusals).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:UK', reason: expect.stringContaining(reason) })])
  })

  it('the parent, and every market Inactive, are refused', async () => {
    const parent = await preview(ids.parent, 'AMAZON:UK', 'FBM')
    expect(parent.refusals).toEqual([expect.objectContaining({ reason: 'The parent row has no listing of its own' })])
    await inside(() => db().channelListing.update({ where: { id: ids.onHandUk }, data: { offerClosedAt: new Date() } }))
    try {
      const p = await preview(ids.onHand, 'AMAZON:UK', 'FBM')
      expect(p.refusals).toEqual([expect.objectContaining({ reason: 'No open offer to convert here: UK (Inactive)' })])
    } finally { await inside(() => db().channelListing.update({ where: { id: ids.onHandUk }, data: { offerClosedAt: null } })) }
  })

  it('eBay (MCF) stays Nexus-only and says so; nothing is sent', async () => {
    const p = await preview(ids.c, 'EBAY:IT', 'MCF' as never)
    expect(p.changes).toEqual([expect.objectContaining({ coordinateKey: 'EBAY:IT', to: 'MCF' })])
    expect(p.notices).toContain(MATRIX_COPY.fulfilmentNexusOnly)
  })

  it('a direct cell write on an Amazon Fulfilment cell is refused (the conversion runs from the confirmed verb only)', async () => {
    const read = await inside(() => getMatrixRead({ productId: ids.parent, canEditPrice: true }))
    const cell = read.rows.find((r) => r.id === ids.a)!.cells['AMAZON:EU']!
    const out = await inside(() => writeMatrixCells(ctx(ids.parent), [{ rowId: ids.a, coordinateKey: 'AMAZON:EU', cell: 'fulfilment', value: 'FBM', expectedVersion: cell.version }]))
    expect(out.results[0]).toMatchObject({ outcome: 'refused', reason: MATRIX_COPY.fulfilmentViaVerb })
    expect(state.submit).not.toHaveBeenCalled()
  })
})

describe('FBA → FBM', () => {
  it('sends the exact patch per open market, records SENT, then writes Nexus FBM with the quantity sent and moves the product mark', async () => {
    const p = await preview(ids.a, 'AMAZON:IT', 'FBM')
    const out = await commit(p)
    expect(out.results).toEqual([expect.objectContaining({ coordinateKey: 'AMAZON:EU', cell: 'fulfilment', outcome: 'applied' })])
    expect(sent()).toEqual([
      { sku: 'TEST-SKU-FC-A', marketplaceId: IT, sellerId: 'SELLER-FC', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 6, lead_time_to_ship_max_days: 2 }], conversionId: expect.any(String) },
      { sku: 'TEST-SKU-FC-A', marketplaceId: DE, sellerId: 'SELLER-FC', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 6 }], conversionId: expect.any(String) },
    ])
    // FR (Inactive) is never sent; UK is not in the EU group.
    expect((await runs([ids.aIt, ids.aDe, ids.aFr])).map((r) => [r.marketplace, r.toMethod, r.quantity, r.status, r.operatorConfirmed])).toEqual([['IT', 'FBM', 6, 'SENT', true], ['DE', 'FBM', 6, 'SENT', true]])
    expect((await runs([ids.aIt]))[0].payload).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 6, lead_time_to_ship_max_days: 2 }])
    const [it, de, fr, uk] = await Promise.all([listing(ids.aIt), listing(ids.aDe), listing(ids.aFr), listing(ids.aUk)])
    expect([it.fulfillmentMethod, de.fulfillmentMethod, fr.fulfillmentMethod, uk.fulfillmentMethod]).toEqual(['FBM', 'FBM', 'FBA', 'FBA'])
    expect([it.quantity, de.quantity]).toEqual([6, 6])
    expect(it.platformAttributes.fulfillment_availability[0].fulfillment_channel_code).toBe('DEFAULT')
    // The mark moves (no FBA units, no active FBA offer); UK leaned on it, so it is FBA explicitly now.
    expect(await mark(ids.a)).toBe('FBM')

    // The Matrix shows the run; the same change again is "already sent".
    const read = await inside(() => getMatrixRead({ productId: ids.parent, canEditPrice: true }))
    expect(read.rows.find((r) => r.id === ids.a)!.cells['AMAZON:EU']!.fulfilment!.conversion).toMatchObject({ status: 'SENT', to: 'FBM', markets: ['IT', 'DE'] })
    const again = await preview(ids.a, 'AMAZON:IT', 'FBM')
    expect(again.refusals).toEqual([expect.objectContaining({ reason: expect.stringContaining('Already sent to Amazon') })])
  })

  it('Amazon refuses one market: the other is FBM in Nexus, the refused one stays FBA, and the outcome names it', async () => {
    state.submit.mockImplementation(async (o: any) => o.marketplaceId === DE
      ? { success: false, sku: o.sku, error: '8541: The fulfillment channel cannot be changed', rawResponse: { status: 'INVALID', issues: [{ code: '8541', message: 'The fulfillment channel cannot be changed', severity: 'ERROR' }] } }
      : accepted(o))
    const out = await commit(await preview(ids.b, 'AMAZON:IT', 'FBM'))
    expect(out.results[0]).toMatchObject({ outcome: 'applied', reason: expect.stringContaining('Amazon DE refused: Amazon refused it: 8541') })
    expect([(await listing(ids.bIt)).fulfillmentMethod, (await listing(ids.bDe)).fulfillmentMethod]).toEqual(['FBM', 'FBA'])
    expect((await runs([ids.bIt, ids.bDe])).map((r) => [r.marketplace, r.status])).toEqual([['IT', 'SENT'], ['DE', 'REFUSED']])
    expect((await runs([ids.bDe]))[0].message).toContain('8541')
  })

  it('Amazon refuses every market: nothing changes in Nexus, and the run reads REFUSED', async () => {
    // Back to FBA on IT through the opposite conversion first (accepted), then FBM refused everywhere.
    await commit(await preview(ids.b, 'AMAZON:IT', 'FBA'))
    expect([(await listing(ids.bIt)).fulfillmentMethod, (await listing(ids.bDe)).fulfillmentMethod]).toEqual(['FBA', 'FBA'])
    state.submit.mockReset().mockImplementation(async (o: any) => ({ success: false, sku: o.sku, error: 'HTTP 400 — INVALID_INPUT', rawResponse: { errors: [] } }))
    const facts = async () => Promise.all([ids.bIt, ids.bDe].map(async (id) => { const { version: _v, ...rest } = await listing(id); return rest }))
    const before = await facts()
    const out = await commit(await preview(ids.b, 'AMAZON:IT', 'FBM'))
    expect(out.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Nothing changed on Amazon or in Nexus') })
    // Only the claim moved the versions (so the caller's next write reads them); the method, quantity and bag are as before.
    expect(await facts()).toEqual(before)
    const read = await inside(() => getMatrixRead({ productId: ids.parent, canEditPrice: true }))
    expect(read.rows.find((r) => r.id === ids.b)!.cells['AMAZON:EU']!.fulfilment!.conversion).toMatchObject({ status: 'REFUSED', to: 'FBM' })
  })

  it('a second run of the same change (a double click) conflicts at the claim: Amazon gets the patch once', async () => {
    state.submit.mockReset().mockImplementation(async (o: any) => accepted(o))
    const p = await preview(ids.b, 'AMAZON:IT', 'FBM')
    const [one, two] = await Promise.all([commit(p), commit(p)])
    const outcomes = [one.results[0]!.outcome, two.results[0]!.outcome].sort()
    expect(outcomes).not.toEqual(['applied', 'applied'])
    expect(state.submit.mock.calls.length).toBeLessThanOrEqual(2)
    // Back to FBA for the next test, through the opposite conversion.
    if (outcomes.includes('applied')) await commit(await preview(ids.b, 'AMAZON:IT', 'FBA'))
  })

  it('a server whose Amazon publishing is gated sends nothing and says so; Nexus stays FBA', async () => {
    state.submit.mockReset().mockImplementation(async (o: any) => ({ success: true, sku: o.sku, status: 'ACCEPTED', dryRun: true }))
    const out = await commit(await preview(ids.b, 'AMAZON:IT', 'FBM'))
    expect(out.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Amazon publishing is not live on this server') })
    expect((await listing(ids.bIt)).fulfillmentMethod).toBe('FBA')
  })
})

describe('FBM → FBA', () => {
  it('writes Nexus FBA and cancels the waiting quantity pushes BEFORE the patch, which carries no quantity', async () => {
    await inside(() => db().outboundSyncQueue.create({ data: { productId: ids.c, channelListingId: ids.cIt, targetChannel: 'AMAZON', syncStatus: 'PENDING', syncType: 'QUANTITY_UPDATE', payload: { quantity: 6 } } as never }))
    const atSend: Json[] = []
    state.onSubmit = async (o) => {
      atSend.push({ market: o.marketplaceId, listing: (await listing(o.marketplaceId === IT ? ids.cIt : ids.cDe)).fulfillmentMethod,
        waiting: (await q(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncStatus" = 'PENDING'`, [ids.cIt]))[0].n })
    }
    const out = await commit(await preview(ids.c, 'AMAZON:IT', 'FBA'))
    expect(out.results[0]).toMatchObject({ outcome: 'applied' })
    expect(atSend).toEqual([{ market: IT, listing: 'FBA', waiting: 0 }, { market: DE, listing: 'FBA', waiting: 0 }])
    expect(sent().map((x: Json) => x.value)).toEqual([[{ fulfillment_channel_code: 'AMAZON_EU' }], [{ fulfillment_channel_code: 'AMAZON_EU' }]])
    expect(await mark(ids.c)).toBe('FBA')
  })

  it('Amazon refuses every market: Nexus is put back to FBM through the same door, the mark too', async () => {
    await commit(await preview(ids.c, 'AMAZON:IT', 'FBM'))
    expect([(await listing(ids.cIt)).fulfillmentMethod, await mark(ids.c)]).toEqual(['FBM', 'FBM'])
    state.submit.mockReset().mockImplementation(async (o: any) => ({ success: false, sku: o.sku, error: 'HTTP 403 — Unauthorized' }))
    const out = await commit(await preview(ids.c, 'AMAZON:IT', 'FBA'))
    expect(out.results[0]).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('Nexus is back to FBM') })
    expect([(await listing(ids.cIt)).fulfillmentMethod, (await listing(ids.cDe)).fulfillmentMethod, await mark(ids.c)]).toEqual(['FBM', 'FBM', 'FBM'])
  })

  it('the revert of an FBA conversion is the FBM conversion, with fresh checks: refused by name when FBA units arrived since', async () => {
    const out = await commit(await preview(ids.c, 'AMAZON:IT', 'FBA'))
    expect(out.results[0]!.outcome).toBe('applied')
    const fba = (await q(`SELECT id FROM "StockLocation" WHERE code = 'AMAZON-EU-FBA'`))[0].id
    await inside(() => db().stockLevel.create({ data: { locationId: fba, productId: ids.c, quantity: 1, available: 1 } }))
    state.submit.mockClear()
    const back = await inside(() => revertMatrixOperation(ctx(ids.parent), out.operation.id))
    expect(back.results).toEqual([expect.objectContaining({ cell: 'fulfilment', outcome: 'refused', reason: expect.stringContaining('1 units of FBA stock on hand keep the guard closed') })])
    expect(state.submit).not.toHaveBeenCalled()
    expect((await listing(ids.cIt)).fulfillmentMethod).toBe('FBA')
  })
})

describe('confirmation from Amazon\'s merchant listings report', () => {
  it('CONFIRMED rewrites the reported copy; STILL_OLD after 3 reads and 4 h; NOT_IN_REPORT after 3 reads; a failed pull moves nothing', async () => {
    // A's run (FBM on IT DE) is SENT; age it so the 4-hour rule can apply.
    await q(`UPDATE "FulfilmentConversion" SET "sentAt" = now() - interval '5 hours', "createdAt" = now() - interval '5 hours' WHERE "channelListingId" = ANY($1)`, [[ids.aIt, ids.aDe]])
    await q(`UPDATE "ChannelListing" SET "platformAttributes" = jsonb_set(coalesce("platformAttributes", '{}'::jsonb), '{attributes}', '{"fulfillment_availability":[{"fulfillment_channel_code":"AMAZON_EU"}]}'::jsonb) WHERE id = $1`, [ids.aIt])
    const reports: Record<string, Array<{ sku: string; fulfillmentChannel: string | null }>> = {
      [IT]: [{ sku: 'TEST-SKU-FC-A', fulfillmentChannel: 'DEFAULT' }],
      [DE]: [{ sku: 'TEST-SKU-FC-A', fulfillmentChannel: 'AMAZON_EU' }],
    }
    const fetchCatalog = vi.fn(async (mp: string) => reports[mp] ?? [])
    const first = await inside(() => confirmFulfilmentConversions({ fetchCatalog }))
    expect(fetchCatalog.mock.calls.map(([mp]) => mp).sort()).toEqual([DE, IT].sort())
    expect(first.confirmed).toBeGreaterThanOrEqual(1)
    const a = await runs([ids.aIt, ids.aDe])
    expect(a.map((r) => [r.marketplace, r.status]).sort()).toEqual([['DE', 'SENT'], ['IT', 'CONFIRMED']])
    expect(reportedFulfilment((await listing(ids.aIt)).platformAttributes)).toBe('MFN')
    // DE still reports AMAZON_EU: STILL_OLD on the third read (and > 4 h since it was sent).
    await inside(() => confirmFulfilmentConversions({ fetchCatalog }))
    await inside(() => confirmFulfilmentConversions({ fetchCatalog }))
    const de = (await runs([ids.aDe]))[0]
    expect(de.status).toBe('STILL_OLD')
    expect(de.message).toBe('Amazon still reports FBA (AMAZON_EU) — check Seller Central → Manage Inventory')
    const read = await inside(() => getMatrixRead({ productId: ids.parent, canEditPrice: true }))
    expect(MATRIX_COPY.conversion(read.rows.find((r) => r.id === ids.a)!.cells['AMAZON:EU']!.fulfilment!.conversion!)).toBe('Amazon still reports FBA — check Seller Central')

    // A pull that fails moves nothing.
    const before = await runs([ids.aDe])
    const failed = await inside(() => confirmFulfilmentConversions({ fetchCatalog: async () => { throw new Error('QuotaExceeded') } }))
    expect(failed.pullsFailed).toBeGreaterThan(0)
    expect(await runs([ids.aDe])).toEqual(before)

    // A SKU missing from the report three times: NOT_IN_REPORT.
    await q(`UPDATE "FulfilmentConversion" SET status = 'SENT', "reportPulls" = 0 WHERE "channelListingId" = $1`, [ids.aDe])
    const empty = vi.fn(async () => [])
    for (let i = 0; i < 3; i++) await inside(() => confirmFulfilmentConversions({ fetchCatalog: empty }))
    expect((await runs([ids.aDe]))[0]).toMatchObject({ status: 'NOT_IN_REPORT', message: expect.stringContaining('does not list TEST-SKU-FC-A') })
  })

  it('the drift detector\'s question: the newest conversion of the pair is to FBM and was not refused', async () => {
    const converted = await inside(() => operatorFbmConversions([{ sku: 'TEST-SKU-FC-A', marketplaceId: IT }, { sku: 'TEST-SKU-FC-B', marketplaceId: IT }, { sku: 'TEST-SKU-FC-B', marketplaceId: DE }, { sku: 'TEST-SKU-FC-C', marketplaceId: IT }]))
    // A: FBM sent (IT confirmed, DE not in the report — still the operator's). B: the newest runs to FBM were refused or
    // never sent. C: the newest is to FBA.
    expect([...converted].sort()).toEqual([`TEST-SKU-FC-A|${DE}`, `TEST-SKU-FC-A|${IT}`])
  })
})
