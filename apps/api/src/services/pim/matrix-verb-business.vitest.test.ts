/**
 * Amazon Business step 5 Part 3 — the bulk B2B verbs (`set-business-price`, `set-business-tiers`) end to end: the real
 * Matrix read, the shared preview, the verb run through the one door (the business price door) and its revert, over a
 * real PostgreSQL in-process (PGlite). Nothing reaches Amazon: the queue is mocked and the send path is not run.
 * Every id, SKU and price is invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: vi.fn(async () => undefined) } }))
vi.mock('../listing-values-events.js', () => ({ announceListingValues: vi.fn() }))

import { MATRIX_COPY, type MatrixVerbParams, type VerbChange, type VerbPreview } from '@nexus/shared/matrix-contract'
import { PREVIEW_WORDS } from '@nexus/shared/matrix-preview'
import type { BusinessPriceSetting } from '@nexus/shared/business-price'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { announceListingValues } from '../listing-values-events.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../categories/seller-offer-audience.service.js'
import { BUSINESS_PRICE_SYNC_TYPE } from './business-price-write.service.js'
import {
  BUSINESS_UNDO_AMAZON_OWN, CHANGED_SINCE_PREVIEW, holdsChange, paramsForChange, restoreWrites, revertMatrixOperation, runMatrixVerb, writeMatrixCells,
  type DoorContext, type VerbCommitResult,
} from './matrix-write.service.js'
import { getMatrixRead } from './matrix.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const IT = 'AMAZON:IT'
const IT_ID = 'APJ6JRA9NG5V4'
const ctx: DoorContext = { productId: 'mvb-p', actor: 'test@example.test', can: () => true }
const TIERS = { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] }
const ids: Record<string, string> = {}

/*
 * The family (all invented): one parent and five variants on Amazon IT at a price of 105.
 *   a  no business price; the nightly check saw Amazon's shopper price at 109 (a first offer waits)
 *   b  an exact business price of 90; the listing's minimum price is 80
 *   c  3 % below the price, with two percent tiers
 *   d  no business price in Nexus — Amazon shows its own of 95 (set outside Nexus)
 *   e  a product type Amazon lists no B2B for (PANTS): held, with the read's sentence
 * Variant a is also on eBay IT (no business price there).
 */
const VARIANTS: Array<{ key: string; type?: string; listing: Record<string, unknown> }> = [
  { key: 'a', listing: { platformAttributes: { amazonBusinessLive: { status: 'MISSING', at: '2026-10-13T04:30:00.000Z', amazonPrice: null, normal: { amazon: 109, nexus: 105 } } } } },
  { key: 'b', listing: { businessPriceRule: 'FIXED', businessPrice: 90, platformAttributes: { attributes: { purchasable_offer: [{ marketplace_id: IT_ID, audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 105 }] }], minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 80 }] }] }] } } } },
  { key: 'c', listing: { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 3, businessTiers: TIERS } },
  { key: 'd', listing: { platformAttributes: { attributes: { purchasable_offer: [
    { marketplace_id: IT_ID, audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 105 }] }] },
    { marketplace_id: IT_ID, audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 95 }] }] },
  ] } } } },
  { key: 'e', type: 'PANTS', listing: {} },
]
const SKU = (k: string) => `TEST-MVB-${k.toUpperCase()}`

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  const amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'b2b', isActive: true, isPrimary: true } as never })).id
  const ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'ebay', isActive: true, isPrimary: true } as never })).id
  await prisma.product.create({ data: { id: 'mvb-p', sku: 'TEST-MVB-P', name: 'p', basePrice: 105, isParent: true, productType: 'OUTERWEAR' } as never })
  const listing = (productId: string, key: string, extra: Record<string, unknown>) => prisma.channelListing.create({ data: {
    productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU', channelConnectionId: amazon,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: `EXT-mvb-${key}`, price: 105, priceOverride: 105, followMasterPrice: false, quantity: 3,
    ...extra,
  } as never })
  ids.p = (await listing('mvb-p', 'p', {})).id
  for (const v of VARIANTS) {
    await prisma.product.create({ data: { id: `mvb-${v.key}`, sku: SKU(v.key), name: v.key, basePrice: 105, parentId: 'mvb-p', ...(v.type ? { productType: v.type } : {}) } as never })
    ids[v.key] = (await listing(`mvb-${v.key}`, v.key, v.listing)).id
  }
  await prisma.channelListing.create({ data: {
    productId: 'mvb-a', channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'EU', channelConnectionId: ebay,
    listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT-mvb-a-ebay', price: 105, quantity: 3,
  } as never })
  await prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: amazon, marketplace: 'IT', productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY,
    labels: { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' },
  } as never })
  // PANTS: Amazon answered for this account, without B2B.
  await prisma.sellerReferenceLabel.create({ data: {
    channel: 'AMAZON', connectionId: amazon, marketplace: 'IT', productType: 'PANTS', fieldKey: OFFER_AUDIENCE_FIELD_KEY,
    labels: { ALL: 'Vendita su Amazon' },
  } as never })
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => { vi.mocked(announceListingValues).mockClear() })

/* ── helpers ─────────────────────────────────────────────────────────────────────────────────── */

const variants = ['a', 'b', 'c', 'd', 'e']
const targets = (keys: readonly string[], key = IT) => keys.map((k) => ({ rowId: `mvb-${k}`, coordinateKey: key }))
const preview = (params: MatrixVerbParams, keys: readonly string[] = variants, extra: Array<{ rowId: string; coordinateKey: string }> = [], door: DoorContext = ctx) =>
  scoped(() => runMatrixVerb(door, { params, targets: [...targets(keys), ...extra], commit: false })) as Promise<VerbPreview>
/** The page's commit: `{ verb }` and the preview it showed. */
const commit = (p: VerbPreview) =>
  scoped(() => runMatrixVerb(ctx, { params: { verb: p.verb } as MatrixVerbParams, targets: p.changes.map((c) => ({ rowId: c.rowId, coordinateKey: c.coordinateKey })), commit: true, preview: p })) as Promise<VerbCommitResult>
const revert = (id: string) => scoped(() => revertMatrixOperation(ctx, id))
const change = (p: VerbPreview, k: string) => p.changes.find((c) => c.rowId === `mvb-${k}`)
const refusal = (p: VerbPreview, k: string, key = IT) => p.refusals.find((r) => r.rowId === `mvb-${k}` && r.coordinateKey === key)?.reason
const stored = (k: string) => scoped(async () => {
  const r = await prisma.channelListing.findUnique({ where: { id: ids[k] }, select: { version: true, businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true } })
  return { version: r!.version, rule: r!.businessPriceRule, percent: r!.businessPricePercent == null ? null : Number(r!.businessPricePercent), price: r!.businessPrice == null ? null : Number(r!.businessPrice), tiers: r!.businessTiers ?? null }
})
const businessRows = (k: string) => scoped(() => prisma.outboundSyncQueue.findMany({ where: { channelListingId: ids[k], syncType: BUSINESS_PRICE_SYNC_TYPE }, orderBy: { createdAt: 'asc' }, select: { syncStatus: true } }))
const cellsOf = async (k: string) => (await scoped(() => getMatrixRead({ productId: 'mvb-p', canEditPrice: true }))).rows.find((r) => r.id === `mvb-${k}`)!.cells[IT]!
/** A person's own write of one B2B price (the pop-up's road), between a preview and its Apply; `noop` = it was already so. */
const setByHand = async (k: string, setting: BusinessPriceSetting | null) => {
  const cells = await cellsOf(k)
  const r = await scoped(() => writeMatrixCells(ctx, [{ rowId: `mvb-${k}`, coordinateKey: IT, cell: 'businessPrice', value: setting, expectedVersion: cells.version, expectedListingId: cells.listingId! }]))
  expect(['applied', 'noop']).toContain(r.results[0]!.outcome)
}
const exact = (price: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'FIXED', percent: null, price, tiers })
const pct = (percent: number, tiers: BusinessPriceSetting['tiers'] = null): BusinessPriceSetting => ({ rule: 'PERCENT_OFF', percent, price: null, tiers })

/* ── set-business-price ──────────────────────────────────────────────────────────────────────── */

describe('set-business-price — the preview says per row what is set and what is skipped, and why', () => {
  it('% below the price: each row\'s new B2B price in the grid\'s words; the parent, eBay and a market without B2B skipped with the reason', async () => {
    const p = await preview({ verb: 'set-business-price', mode: 'percent', percent: 5 }, variants, [{ rowId: 'mvb-p', coordinateKey: IT }, { rowId: 'mvb-a', coordinateKey: 'EBAY:IT' }])
    expect(p.verb).toBe('set-business-price')
    // A first business offer: Amazon's shopper price is not Nexus's, so it waits — said on the line (#602).
    expect(change(p, 'a')).toMatchObject({ cell: 'businessPrice', from: null, to: pct(5), fromLabel: '—', toLabel: '€99.75 · −5%', note: PREVIEW_WORDS.businessFirstWaits('€109.00', '€105.00') })
    expect(change(p, 'b')).toMatchObject({ from: exact(90), to: pct(5), fromLabel: '€90.00', toLabel: '€99.75 · −5%' })
    expect(change(p, 'b')!.note).toBeUndefined()
    // The quantity discounts stay as they are.
    expect(change(p, 'c')).toMatchObject({ from: pct(3, TIERS), to: pct(5, TIERS), fromLabel: '€101.85 · −3%', toLabel: '€99.75 · −5%' })
    // Amazon's own business price is replaced — and an undo cannot bring it back: said before Apply.
    expect(change(p, 'd')).toMatchObject({ from: null, to: pct(5), note: PREVIEW_WORDS.businessReplacesAmazon('€95.00') })
    expect(refusal(p, 'e')).toBe(MATRIX_COPY.absentBusiness('PANTS'))
    expect(refusal(p, 'p')).toBe('The parent row has no listing of its own')
    expect(refusal(p, 'a', 'EBAY:IT')).toBe(PREVIEW_WORDS.businessAmazonOnly)
    expect(p.confirm).toBe('none')
  })

  it('bounds first: an exact price above the price, or below the listing\'s minimum price, is refused with Amazon\'s rule', async () => {
    const above = await preview({ verb: 'set-business-price', mode: 'exact', price: 120 }, ['a', 'b'])
    expect(above.changes).toEqual([])
    expect(refusal(above, 'a')).toBe('The business price EUR 120.00 is above the normal price EUR 105.00: Amazon would not show it to business buyers.')
    const below = await preview({ verb: 'set-business-price', mode: 'exact', price: 75 }, ['a', 'b'])
    expect(refusal(below, 'b')).toBe('The business price EUR 75.00 is below this listing\'s minimum price EUR 80.00: Amazon refuses it.')
    expect(change(below, 'a')).toMatchObject({ to: exact(75), toLabel: '€75.00' })
  })

  it('change an exact price by %: only exact prices move; a percent rule, none, or Amazon\'s own price is skipped with a sentence', async () => {
    const p = await preview({ verb: 'set-business-price', mode: 'change', percent: -10 })
    expect(p.changes.map((c) => c.rowId)).toEqual(['mvb-b'])
    expect(change(p, 'b')).toMatchObject({ from: exact(90), to: exact(81), fromLabel: '€90.00', toLabel: '€81.00' })
    expect(refusal(p, 'c')).toBe(PREVIEW_WORDS.businessPercentFollows('3%'))
    expect(refusal(p, 'a')).toBe(PREVIEW_WORDS.businessNothingToChange)
    expect(refusal(p, 'd')).toBe(PREVIEW_WORDS.businessNothingToChange)
    // −15 % takes it under the minimum price: refused, never sent.
    expect(refusal(await preview({ verb: 'set-business-price', mode: 'change', percent: -15 }, ['b']), 'b')).toBe('The business price EUR 76.50 is below this listing\'s minimum price EUR 80.00: Amazon refuses it.')
    // A cut of 30 % or more asks for the typed word.
    expect((await preview({ verb: 'set-business-price', mode: 'percent', percent: 30 }, ['a'])).confirmWord).toBe('APPLY')
  })

  it('remove: only where Nexus keeps one; Amazon\'s own business price (set outside Nexus) is skipped, never deleted', async () => {
    const p = await preview({ verb: 'set-business-price', mode: 'remove' })
    expect(change(p, 'b')).toMatchObject({ from: exact(90), to: null, toLabel: '—', note: PREVIEW_WORDS.businessRemoved })
    expect(change(p, 'c')).toMatchObject({ from: pct(3, TIERS), to: null, note: PREVIEW_WORDS.businessRemovedWithTiers })
    expect(refusal(p, 'a')).toBe(PREVIEW_WORDS.businessNothingToRemove)
    expect(refusal(p, 'd')).toBe(PREVIEW_WORDS.businessAmazonOwn('€95.00'))
  })

  it('without products.price.edit every row is refused by name', async () => {
    const p = await preview({ verb: 'set-business-price', mode: 'percent', percent: 5 }, ['a', 'b'], [], { ...ctx, can: (perm) => perm !== 'products.price.edit' })
    expect(p.changes).toEqual([])
    expect(p.refusals.map((r) => [r.kind, r.reason])).toEqual([['permission', PREVIEW_WORDS.businessPricePermission], ['permission', PREVIEW_WORDS.businessPricePermission]])
  })
})

describe('set-business-price — Apply runs through the one door; Undo puts back only what still holds', () => {
  let opId = ''

  it('Apply: stored through the business price door, one business send queued per listing, announced as businessPrice, each cell named at the version it was checked at', async () => {
    const before = { a: await stored('a'), b: await stored('b'), d: await stored('d') }
    const p = await preview({ verb: 'set-business-price', mode: 'percent', percent: 7 }, ['a', 'b', 'd'])
    expect(p.changes).toHaveLength(3)
    const out = await commit(p)
    opId = out.operation.id
    expect(out.operation).toMatchObject({ verb: 'set-business-price', applied: 3, refused: 0 })
    for (const k of ['a', 'b', 'd'] as const) {
      const o = out.results.find((r) => r.rowId === `mvb-${k}`)!
      expect(o).toMatchObject({ cell: 'businessPrice', outcome: 'applied', writtenAt: before[k].version, version: before[k].version + 1 })
      expect(await stored(k)).toEqual({ version: before[k].version + 1, rule: 'PERCENT_OFF', percent: 7, price: null, tiers: null })
      // The send goes the business price door's own way (a BUSINESS_PRICE_UPDATE row; the send path holds a first offer).
      expect((await businessRows(k)).at(-1)).toEqual({ syncStatus: 'PENDING' })
    }
    expect(vi.mocked(announceListingValues)).toHaveBeenCalledWith(expect.arrayContaining([ids.a]), ['businessPrice'], 'business-price')
    const op = await scoped(() => prisma.bulkOperation.findUnique({ where: { id: opId } }))
    expect(op).toMatchObject({ status: 'COMPLETED' })
    expect((op!.changes as { kind: string; verb: string }).verb).toBe('set-business-price')
  })

  it('Undo: a cell changed since keeps its newer value; Amazon\'s own price is never put back as none; the rest is put back', async () => {
    // Someone set a's B2B price by hand after the run.
    await setByHand('a', exact(100))
    const queuedD = (await businessRows('d')).length
    const out = await revert(opId)
    const at = (k: string) => out.results.filter((r) => r.rowId === `mvb-${k}`)
    expect(at('a')).toEqual([expect.objectContaining({ outcome: 'conflict', reason: MATRIX_COPY.changedSince })])
    expect(await stored('a')).toMatchObject({ rule: 'FIXED', price: 100 })
    expect(at('b')).toEqual([expect.objectContaining({ cell: 'businessPrice', outcome: 'applied' })])
    expect(await stored('b')).toMatchObject({ rule: 'FIXED', price: 90, percent: null })
    // d: before the run Amazon held its own business price and Nexus none — a revert to "none" would delete it at Amazon.
    expect(at('d')).toEqual([expect.objectContaining({ outcome: 'refused', reason: BUSINESS_UNDO_AMAZON_OWN })])
    expect(await stored('d')).toMatchObject({ rule: 'PERCENT_OFF', percent: 7 })
    expect(await businessRows('d')).toHaveLength(queuedD)
    expect(out.operation).toMatchObject({ applied: 1, refused: 2 })
  })

  it('changed since the preview: a row whose B2B price moved after the preview is refused and keeps its value; the other row applies', async () => {
    await setByHand('b', exact(90))
    await setByHand('a', exact(100))
    const p = await preview({ verb: 'set-business-price', mode: 'change', percent: -10 }, ['a', 'b'])
    expect(p.changes.map((c) => [c.rowId, c.to])).toEqual([['mvb-a', exact(90)], ['mvb-b', exact(81)]])
    await setByHand('b', exact(95))
    const out = await commit(p)
    expect(out.results.find((r) => r.rowId === 'mvb-b')).toMatchObject({ outcome: 'refused', reason: CHANGED_SINCE_PREVIEW })
    expect(await stored('b')).toMatchObject({ rule: 'FIXED', price: 95 })
    expect(out.results.find((r) => r.rowId === 'mvb-a')).toMatchObject({ outcome: 'applied' })
    expect(await stored('a')).toMatchObject({ rule: 'FIXED', price: 90 })
  })

  it('a preview whose tiers moved since (same B2B price) is refused too — it would write the old tiers back', async () => {
    await setByHand('b', exact(90))
    const p = await preview({ verb: 'set-business-price', mode: 'exact', price: 88 }, ['b'])
    await setByHand('b', exact(90, TIERS))
    const out = await commit(p)
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'refused', reason: CHANGED_SINCE_PREVIEW })])
    expect(await stored('b')).toMatchObject({ price: 90, tiers: TIERS })
  })

  it('remove, chosen on purpose: the business offer goes (its removal queued for Amazon); Undo brings it back', async () => {
    await setByHand('c', pct(3, TIERS))
    const p = await preview({ verb: 'set-business-price', mode: 'remove' }, ['c'])
    const out = await commit(p)
    expect(out.results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(await stored('c')).toMatchObject({ rule: null, percent: null, price: null, tiers: null })
    expect((await businessRows('c')).at(-1)).toEqual({ syncStatus: 'PENDING' })
    const back = await revert(out.operation.id)
    expect(back.results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(await stored('c')).toMatchObject({ rule: 'PERCENT_OFF', percent: 3, tiers: TIERS })
  })
})

/* ── set-business-tiers ─────────────────────────────────────────────────────────────────────── */

describe('set-business-tiers — the same quantity discounts on each listing, the B2B price kept', () => {
  const FIXED_TIERS = { type: 'fixed' as const, levels: [{ minQty: 3, value: 85 }, { minQty: 10, value: 82 }] }

  it('set: the price stays; no business price → skipped; fixed prices on a percent price, or a tier under the minimum price → refused (Amazon\'s rules)', async () => {
    await setByHand('b', exact(90))
    await setByHand('c', pct(3))
    // d keeps the run's 7 % from above: none again (Nexus has kept one for it since, so it is no longer Amazon's own).
    await setByHand('d', null)
    const percent = await preview({ verb: 'set-business-tiers', mode: 'set', tiers: TIERS }, ['b', 'c', 'd', 'e'])
    expect(change(percent, 'b')).toMatchObject({ cell: 'businessTiers', from: exact(90), to: exact(90, TIERS), fromLabel: '—', toLabel: '2+ −3% · 5+ −5%' })
    expect(change(percent, 'c')).toMatchObject({ from: pct(3), to: pct(3, TIERS) })
    expect(refusal(percent, 'd')).toBe(PREVIEW_WORDS.businessNeedsPrice)
    expect(refusal(percent, 'e')).toBe(MATRIX_COPY.absentBusiness('PANTS'))
    const fixed = await preview({ verb: 'set-business-tiers', mode: 'set', tiers: FIXED_TIERS }, ['b', 'c'])
    expect(change(fixed, 'b')).toMatchObject({ to: exact(90, FIXED_TIERS), toLabel: '3+ €85.00 · 10+ €82.00' })
    expect(refusal(fixed, 'c')).toContain('Fixed quantity prices go with an exact business price')
    const deep = await preview({ verb: 'set-business-tiers', mode: 'set', tiers: { type: 'percent', levels: [{ minQty: 2, value: 20 }] } }, ['b'])
    expect(refusal(deep, 'b')).toBe('A quantity discount reaches EUR 72.00, below this listing\'s minimum price EUR 80.00: Amazon refuses it.')
  })

  it('Apply and Undo: the tiers are written with the price as it is; Undo takes them off again; remove without tiers is skipped', async () => {
    await setByHand('b', exact(90))
    const out = await commit(await preview({ verb: 'set-business-tiers', mode: 'set', tiers: TIERS }, ['b']))
    expect(out.results).toEqual([expect.objectContaining({ cell: 'businessTiers', outcome: 'applied' })])
    expect(await stored('b')).toMatchObject({ rule: 'FIXED', price: 90, tiers: TIERS })
    expect((await revert(out.operation.id)).results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(await stored('b')).toMatchObject({ rule: 'FIXED', price: 90, tiers: null })
    expect(refusal(await preview({ verb: 'set-business-tiers', mode: 'remove' }, ['b']), 'b')).toBe(PREVIEW_WORDS.businessNoTiers)
  })
})

/* ── the pure parts ─────────────────────────────────────────────────────────────────────────── */

describe('paramsForChange / holdsChange / restoreWrites — the business verbs', () => {
  const ch = (to: unknown, cell: VerbChange['cell'] = 'businessPrice'): VerbChange => ({ rowId: 'r', sku: 'S', coordinateKey: IT, cell, from: null, to, fromLabel: '', toLabel: '' })
  const business = (over: Record<string, unknown> = {}) => ({ rule: 'FIXED', percent: null, exact: 90, tiers: null, price: 90, normalPrice: 105, minPrice: null, maxPrice: null, currency: 'EUR', warnings: [], held: null, send: null, live: null, reported: null, ...over }) as never

  it('a carried change re-runs as the rule it writes (a change by % as its exact price); the tiers as those tiers, or none', () => {
    expect(paramsForChange('set-business-price', ch(pct(5)))).toEqual({ verb: 'set-business-price', mode: 'percent', percent: 5 })
    expect(paramsForChange('set-business-price', ch(exact(81)))).toEqual({ verb: 'set-business-price', mode: 'exact', price: 81 })
    expect(paramsForChange('set-business-price', ch(null))).toEqual({ verb: 'set-business-price', mode: 'remove' })
    expect(paramsForChange('set-business-tiers', ch(exact(90, TIERS), 'businessTiers'))).toEqual({ verb: 'set-business-tiers', mode: 'set', tiers: TIERS })
    expect(paramsForChange('set-business-tiers', ch(exact(90), 'businessTiers'))).toEqual({ verb: 'set-business-tiers', mode: 'remove' })
    expect(paramsForChange('set-business-price', ch({ rule: 'PERCENT_OFF', percent: '5' }))).toBeNull()
    expect(paramsForChange('set-business-tiers', ch(null, 'businessTiers'))).toBeNull()
  })

  it('holdsChange: the whole setting the run wrote is still the one kept', () => {
    const cells = (b: unknown) => ({ business: b }) as never
    expect(holdsChange(ch(exact(90)), cells(business()))).toBe(true)
    expect(holdsChange(ch(exact(91)), cells(business()))).toBe(false)
    expect(holdsChange(ch(null), cells(business({ rule: null, exact: null, price: null })))).toBe(true)
    expect(holdsChange(ch(exact(90)), cells(undefined))).toBe(false)
  })

  it('restoreWrites never writes none over Amazon\'s own business price; it does over a listing that had none at all', () => {
    const live = { business: business({ rule: 'PERCENT_OFF', percent: 7, exact: null }) } as never
    const amazonOwn = { business: business({ rule: null, exact: null, price: null, reported: { price: 95 } }) } as never
    const none = { business: business({ rule: null, exact: null, price: null }) } as never
    expect(restoreWrites('r', IT, amazonOwn, live)).toEqual([])
    expect(restoreWrites('r', IT, none, live)).toEqual([{ kind: 'cell', cell: 'businessPrice', value: null }])
  })
})
