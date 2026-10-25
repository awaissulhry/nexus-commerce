/**
 * Listings live layer, step 3 — end to end on a real PostgreSQL (PGlite): `readLive` batching (a fixed number of
 * queries whatever the number of products), `attachLive` on the families and members pages (chips' live summaries,
 * GB/UK twins, extra chips for listings that match no readiness destination with their notes, the live tiles), the
 * Listing window's "On the channel" section, a caller without `listings.view`, and the search by ASIN, eBay Item ID,
 * channel SKU, listing-customization SKU and many SKUs pasted at once. Ids invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, queries: [] as string[], counting: false }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  // Every query the client runs outside a transaction (model operations and raw queries), counted while `counting` is on.
  const record = (name: string) => { if (state.counting) state.queries.push(name) }
  const client = state.db.client
  const counted = new Proxy(client, { get(target: any, property: string | symbol) {
    const value = Reflect.get(target, property, target)
    if (typeof property !== 'string') return value
    if (property.startsWith('$query') || property.startsWith('$execute')) return (...args: unknown[]) => { record(`$.${property}`); return value.apply(target, args) }
    if (!property.startsWith('$') && value && typeof value === 'object') return new Proxy(value, { get(delegate: any, method: string | symbol) {
      const fn = Reflect.get(delegate, method, delegate)
      return typeof fn === 'function' ? (...args: unknown[]) => { record(`${property}.${String(method)}`); return fn.apply(delegate, args) } : fn
    } })
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { default: counted }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { readinessDetail, readinessFamilies, readinessFamiliesIfChanged, readinessFamilyMembers, readinessFamilyMembersIfChanged } from './listing-readiness-families.service.js'
import { readLive, resolveSearchTokens } from './listing-readiness-live.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const key = (c: (string | null)[]) => JSON.stringify(c)
const SHARED = [null, null, null, null], AMAZON_IT = ['AMAZON', 'IT', 'lv-a1', null], AMAZON_UK = ['AMAZON', 'UK', 'lv-a1', null], EBAY_IT = ['EBAY', 'IT', 'lv-e1', null]
const ALIAS_OLD = ['AMAZON', 'IT', 'lv-a1', 'lv-al-old'], OLD_ACCOUNT = ['AMAZON', 'IT', 'lv-old', null], NO_MARKET = ['EBAY', 'DEFAULT', 'lv-e1', null], NO_ACCOUNT = ['EBAY', 'IT', null, null]
const computedAt = new Date('2026-10-25T08:00:00Z')
const index = (productId: string, c: (string | null)[], s = 'ready', extra: Record<string, unknown> = {}) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language: 'it',
  label: c[0] ? `${c[0]} · ${c[1]}` : 'Shared product', pct: null, state: s, requiredFilled: 0, requiredTotal: 0, missing: [], note: null, computedAt, ...extra,
})
const listing = (id: string, productId: string, [channel, marketplace, account]: (string | null)[], extra: Record<string, unknown> = {}) => ({
  id, productId, channel, marketplace, channelConnectionId: account, aliasKey: '', channelMarket: `${channel}_${marketplace}`, region: marketplace,
  listingStatus: 'ACTIVE', isPublished: true, ...extra,
})

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'lv-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'seller-a1' } as never })
  await prisma.channelConnection.create({ data: { id: 'lv-e1', channelType: 'EBAY', isActive: true, externalAccountId: 'seller-e1' } as never })
  await prisma.channelConnection.create({ data: { id: 'lv-old', channelType: 'AMAZON', isActive: false, displayName: 'Old store', externalAccountId: 'seller-old' } as never })
  for (const [channel, code, currency] of [['AMAZON', 'IT', 'EUR'], ['AMAZON', 'UK', 'GBP'], ['EBAY', 'IT', 'EUR']])
    await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency, language: 'it', isActive: true } as never })
  await prisma.product.create({ data: { id: 'lv-root', sku: 'LV', name: 'Live Parka', basePrice: 10, isParent: true, status: 'DRAFT', amazonAsin: 'B0PARENT' } })
  for (const [id, sku] of [['lv-v1', 'LV-M'], ['lv-v2', 'LV-L'], ['lv-v3', 'LV-XL']]) await prisma.product.create({ data: { id, sku, name: `Variant ${sku}`, basePrice: 10, parentId: 'lv-root', status: 'DRAFT' } })
  await prisma.product.create({ data: { id: 'lv-solo', sku: 'LV-SOLO', name: 'Solo gloves', basePrice: 10, status: 'DRAFT' } })
  await prisma.productListingAlias.create({ data: { id: 'lv-al-old', productId: 'lv-root', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'lv-a1', label: 'Old title', status: 'ARCHIVED', sku: 'LV-ALIAS' } })
  await prisma.readinessIndex.createMany({ data: [
    ...['lv-root', 'lv-v1', 'lv-v2', 'lv-v3', 'lv-solo'].map(id => index(id, SHARED)),
    ...['lv-root', 'lv-v1', 'lv-v2', 'lv-v3'].flatMap(id => [index(id, AMAZON_IT, id === 'lv-v1' ? 'blocked' : 'ready'), index(id, AMAZON_UK)]),
    index('lv-solo', EBAY_IT),
  ] as never })
  await prisma.channelListing.createMany({ data: [
    listing('lv-l-root', 'lv-root', AMAZON_IT, { externalListingId: 'B0PARENT' }),
    listing('lv-l-v1', 'lv-v1', AMAZON_IT, { externalListingId: 'B0V1', externalParentId: 'B0PARENT', quantity: 15, price: 49.9, channelSku: 'LV-M-AMZ' }),
    listing('lv-l-v2', 'lv-v2', AMAZON_IT, { externalListingId: 'B0V2', externalParentId: 'B0PARENT', quantity: 2, price: 45 }),
    listing('lv-l-v1-gb', 'lv-v1', ['AMAZON', 'GB', 'lv-a1'], { externalListingId: 'B0V1', quantity: 40 }),
    listing('lv-l-v1-uk', 'lv-v1', AMAZON_UK, { externalListingId: 'B0V1', quantity: 40 }),
    listing('lv-l-v1-alias', 'lv-v1', AMAZON_IT, { externalListingId: 'B0V1', aliasKey: 'lv-al-old', aliasId: 'lv-al-old', quantity: 99 }),
    listing('lv-l-solo', 'lv-solo', EBAY_IT, { externalListingId: '225500001111' }),
    listing('lv-l-solo-noacc', 'lv-solo', NO_ACCOUNT, { externalListingId: '225500002222' }),
    listing('lv-l-solo-default', 'lv-solo', NO_MARKET, { externalListingId: '225500003333' }),
    listing('lv-l-solo-old', 'lv-solo', OLD_ACCOUNT, { externalListingId: 'B0SOLO' }),
  ] as never })
  await prisma.listingIssue.createMany({ data: [
    { listingId: 'lv-l-v2', code: 'SUPPRESSED', severity: 'ERROR', message: 'Missing main image', attributeNames: ['main_product_image_locator'], categories: ['suppression'], source: 'amazon-suppression', fingerprint: 'S::' },
    { listingId: 'lv-l-v2', code: '18027', severity: 'WARNING', message: 'Your title is long', attributeNames: ['item_name'], categories: [], fingerprint: 'W::' },
  ] })
  await prisma.amazonSuppression.create({ data: { listingId: 'lv-l-v2', reasonCode: 'MISSING_IMAGE', reasonText: 'Missing main image', source: 'sp-api-poll', suppressedAt: new Date('2026-10-24T09:00:00Z') } })
  await prisma.channelDrift.create({ data: { channelListingId: 'lv-l-v2', channel: 'AMAZON', marketplace: 'IT', driftCount: 1, lastCheckedAt: computedAt,
    driftedFields: [{ field: 'price', ours: 45, theirs: 44.5, source: 'amazon-merchant-listings-report', checkedAt: '2026-10-24T03:00:00.000Z' }] } })
  await prisma.syncAttempt.createMany({ data: Array.from({ length: 12 }, (_, k) => ({ listingId: 'lv-l-v1', status: k === 11 ? 'FAILED' : 'SUCCESS', source: 'cron',
    attemptedAt: new Date(Date.UTC(2026, 9, 20, k)), error: k === 11 ? 'Throttled' : null })) })
}), 120_000)
afterAll(async () => { await state.db?.close() })

const counting = async <T>(work: () => Promise<T>) => {
  state.queries = []; state.counting = true
  try { return { result: await work(), queries: [...state.queries] } } finally { state.counting = false }
}

describe('readLive', () => {
  it('reads a page in a fixed number of queries, whatever the number of products', async () => {
    const one = await counting(() => scoped(() => readLive(['lv-v1'])))
    const all = await counting(() => scoped(() => readLive(['lv-root', 'lv-v1', 'lv-v2', 'lv-v3', 'lv-solo'])))
    expect(one.queries).toContain('$.$queryRaw')
    expect(all.queries.length).toBe(one.queries.length)
    expect(all.queries.length).toBeLessThanOrEqual(7)
    if (process.env.NEXUS_LIVE_QUERIES === '1') console.log('[live queries]', all.queries)
    // The family root comes along (a variant's Shopify owner); a GB listing reads on the UK destination.
    expect(one.result.facts.products.has('lv-root')).toBe(true)
    expect(all.result.get('lv-v1')!.get(key(AMAZON_UK))!.map(l => l.listingId).sort()).toEqual(['lv-l-v1-gb', 'lv-l-v1-uk'])
    expect(all.result.get('lv-v2')!.get(key(AMAZON_IT))![0]).toMatchObject({ state: 'active', externalId: 'B0V2', externalParentId: 'B0PARENT', currency: 'EUR',
      channelErrorCount: 1, channelWarningCount: 1, suppressed: true, outOfSync: ['channel-differs'], url: 'https://www.amazon.it/dp/B0V2', fulfillment: 'FBM' })
  })
})

describe('the families page', () => {
  it('chips carry the live summary; twins are reported; listings that match no destination get extra chips with notes', async () => {
    const page = await scoped(() => readinessFamilies({}, null, { live: true }))
    expect(page.rows.map(r => r.id)).toEqual(['lv-root', 'lv-solo'])
    const [family, solo] = page.rows
    const chip = (row: typeof family, c: (string | null)[]) => row.chips.find(x => x.destinationKey === key(c))!
    expect(chip(family, SHARED).live).toBeNull()
    expect(chip(family, AMAZON_IT).live).toEqual({ state: 'mixed', listed: 2, notListed: 1, byState: { active: 2 }, externalId: 'B0PARENT', url: 'https://www.amazon.it/dp/B0PARENT',
      priceMin: 45, priceMax: 49.9, currency: 'EUR', quantity: 17, fulfillment: 'FBM', channelErrorCount: 1, suppressedCount: 1, outOfSyncCount: 1, syncFailedCount: 0,
      lastSyncedAt: null, duplicates: 0 })
    expect(chip(family, AMAZON_UK).live).toMatchObject({ state: 'mixed', listed: 1, notListed: 2, byState: { active: 2 }, duplicates: 1, quantity: null, currency: 'GBP' })
    // The archived customization: an extra chip, readiness "Not set up" (absent), its listing live.
    expect(chip(family, ALIAS_OLD)).toMatchObject({ state: 'absent', counts: { absent: 1 }, issueCount: 0, live: { state: 'mixed', listed: 1, notListed: 2, byState: { active: 1 } } })
    expect(family.chips.map(c => c.destinationKey)).toEqual([key(SHARED), key(AMAZON_IT), key(AMAZON_UK), key(ALIAS_OLD)])
    expect(solo.chips.map(c => c.destinationKey)).toEqual([key(SHARED), key(EBAY_IT), key(OLD_ACCOUNT), key(NO_MARKET), key(NO_ACCOUNT)])
    expect(chip(solo, EBAY_IT).live).toMatchObject({ state: 'active', listed: 1, externalId: '225500001111', url: 'https://www.ebay.it/itm/225500001111' })
    // Readiness is untouched: states, tiles, order.
    expect(family.state).toBe('blocked')
    expect(page.stats.all).toBe(14)
    // The extra destinations follow the readiness ones, each with why Nexus does not check it.
    expect(page.destinations.slice(4).map(d => [d.key, d.label, d.note?.split(',')[0]])).toEqual([
      [key(ALIAS_OLD), 'Amazon IT · Old title · Xavia', 'This listing customization is archived'],
      [key(OLD_ACCOUNT), 'Amazon IT · Old store', 'This account is not connected any more'],
      [key(NO_MARKET), 'eBay · Store …lv-e1', 'No market is recorded for this listing'],
      [key(NO_ACCOUNT), 'eBay IT', 'No account is recorded for this listing'],
    ])
    expect(page.destinations.slice(0, 4).every(d => !('note' in d))).toBe(true)
    expect(page.unmatchedListings).toBe(4)
    expect(page.liveStats).toEqual({ listings: 10, active: 10, paused: 0, draft: 0, ended: 0, unknown: 0, notListed: 4, error: 1, suppressed: 1, outOfSync: 1, lowStock: 1 })
  })

  it('the page filters narrow the live layer too; a language filter shows no extra chips', async () => {
    const it = await scoped(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT' }, null, { live: true }))
    expect(it.rows.map(r => r.id)).toEqual(['lv-root'])
    expect(it.rows[0].chips.map(c => c.destinationKey)).toEqual([key(AMAZON_IT), key(ALIAS_OLD)])
    expect(it.liveStats).toMatchObject({ listings: 4, notListed: 1 })
    const italian = await scoped(() => readinessFamilies({ language: 'it' }, null, { live: true }))
    expect(italian.rows[1].chips.map(c => c.destinationKey)).toEqual([key(SHARED), key(EBAY_IT)])
    expect(italian.unmatchedListings).toBe(0)
  })

  it('without listings.view: every live field is null and no chip is added', async () => {
    const page = await scoped(() => readinessFamilies({}, null))
    expect(page.liveStats).toBeNull()
    expect(page.unmatchedListings).toBeUndefined()
    expect(page.destinations.length).toBe(4)
    expect(page.rows[0].chips.map(c => c.live)).toEqual([null, null, null])
    expect(page.rows[1].chips.length).toBe(2)
  })
})

describe('the members page', () => {
  it('each member chip has its own listing and its summary; twins leave no single listing', async () => {
    const members = await scoped(() => readinessFamilyMembers('lv-root', {}, null, { live: true }))
    expect(members.rows.map(r => r.id)).toEqual(['lv-root', 'lv-v1', 'lv-v2', 'lv-v3'])
    const [root, v1, , v3] = members.rows
    const chip = (row: typeof v1, c: (string | null)[]) => row.chips.find(x => x.destinationKey === key(c))!
    expect(chip(root, AMAZON_IT).listing).toMatchObject({ listingId: 'lv-l-root', externalId: 'B0PARENT' })
    expect(chip(v1, AMAZON_IT)).toMatchObject({ listing: { listingId: 'lv-l-v1', state: 'active', price: 49.9 }, live: { state: 'active', listed: 1, notListed: 0, byState: { active: 1 } } })
    expect(chip(v1, AMAZON_UK)).toMatchObject({ listing: null, live: { duplicates: 1, listed: 1, byState: { active: 2 } } })
    expect(chip(v1, ALIAS_OLD)).toMatchObject({ state: 'absent', listing: { listingId: 'lv-l-v1-alias', quantity: 99 } })
    expect(chip(v3, AMAZON_IT)).toMatchObject({ listing: null, live: { state: 'not_listed', listed: 0, notListed: 1, byState: {} } })
    expect(chip(v3, SHARED)).toMatchObject({ live: null, listing: null })
    const off = await scoped(() => readinessFamilyMembers('lv-root', {}, null))
    expect(off.rows[1].chips.map(c => [c.live, c.listing])).toEqual([[null, null], [null, null], [null, null]])
  })
})

describe('the Listing window', () => {
  it('"On the channel": the summary, the channel\'s messages word for word, suppressions, what differs, sync attempts', async () => {
    const detail = await scoped(() => readinessDetail({ productId: 'lv-root', family: '1', destination: key(AMAZON_IT) }, null, { live: true }))
    const channel = detail.channel!
    expect(channel.summary).toMatchObject({ state: 'mixed', listed: 2, notListed: 1 })
    expect(channel.listings.map(l => [l.productId, l.sku, l.live.listingId])).toEqual([['lv-root', 'LV', 'lv-l-root'], ['lv-v1', 'LV-M', 'lv-l-v1'], ['lv-v2', 'LV-L', 'lv-l-v2']])
    const v2 = channel.listings[2]
    expect(v2.messages.map(m => [m.severity, m.code, m.message, m.source])).toEqual([['error', 'SUPPRESSED', 'Missing main image', 'amazon-suppression'], ['warning', '18027', 'Your title is long', 'listings-api']])
    expect(v2.suppressions).toEqual([{ id: expect.any(String), reasonCode: 'MISSING_IMAGE', reasonText: 'Missing main image', severity: 'ERROR', source: 'sp-api-poll', suppressedAt: '2026-10-24T09:00:00.000Z' }])
    expect(v2.differs).toEqual([{ field: 'price', nexus: '45', channel: '44.5', foundAt: '2026-10-24T03:00:00.000Z' }])
    expect(v2.lastPublish).toBeNull()
    const attempts = channel.listings[1].syncAttempts!
    expect(attempts.length).toBe(10)
    expect(attempts[0]).toEqual({ at: '2026-10-20T11:00:00.000Z', status: 'FAILED', source: 'cron', durationMs: null, error: 'Throttled' })
    expect(typeof channel.readAt).toBe('string')
  })
  it('an extra chip opens too; Shared and a caller without listings.view get no channel section', async () => {
    const orphan = await scoped(() => readinessDetail({ productId: 'lv-solo', destination: key(NO_ACCOUNT) }, null, { live: true }))
    expect(orphan.channel!.listings.map(l => l.live.externalId)).toEqual(['225500002222'])
    expect((await scoped(() => readinessDetail({ productId: 'lv-root', destination: key(SHARED) }, null, { live: true }))).channel).toBeNull()
    expect((await scoped(() => readinessDetail({ productId: 'lv-root', family: '1', destination: key(AMAZON_IT) }, null))).channel).toBeNull()
  })
})

describe('search', () => {
  const found = async (q: string) => {
    const page = await scoped(() => readinessFamilies({ q }, null))
    return { rows: page.rows.map(r => [r.id, r.matchingCount]), search: page.search }
  }
  it('one term also finds a channel id exactly: an ASIN, an eBay Item ID, a channel SKU, a customization SKU', async () => {
    expect((await found('b0v2')).rows).toEqual([['lv-root', 1]])
    expect((await found('225500001111')).rows).toEqual([['lv-solo', 1]])
    expect((await found('B0PARENT')).rows).toEqual([['lv-root', 4]])
    expect((await found('lv-m-amz')).rows).toEqual([['lv-root', 1]])
    expect((await found('LV-ALIAS')).rows).toEqual([['lv-root', 4]])
    // Today's phrase search is unchanged: "LV-" is inside the variants' and the single product's SKUs, not the root's ("LV").
    expect((await found('LV-')).rows).toEqual([['lv-root', 3], ['lv-solo', 1]])
    expect((await found('b0v2')).search).toBeUndefined()
  })
  it('many terms pasted at once: each matched exactly, the unmatched ones listed in the person\'s spelling', async () => {
    const pasted = await found('lv-m LV-SOLO NOPE-1  NOPE-2')
    expect(pasted.rows).toEqual([['lv-root', 1], ['lv-solo', 1]])
    expect(pasted.search).toEqual({ tokens: 4, unmatched: ['NOPE-1', 'NOPE-2'] })
    expect((await found('B0V1,B0V2')).search).toEqual({ tokens: 2, unmatched: [] })
    // A name with a space is a phrase, not a list.
    const phrase = await found('live parka')
    expect(phrase.rows).toEqual([['lv-root', 4]])
    expect(phrase.search).toBeUndefined()
    expect((await scoped(() => resolveSearchTokens('B0V1 b0v1 NOPE'))).unmatched).toEqual(['NOPE'])
  })
})

describe('the live filters, in the page\'s SQL', () => {
  const ask = async (query: Record<string, unknown>, live = true) => {
    const page = await scoped(() => readinessFamilies(query, null, { live }))
    return { ids: page.rows.map(r => r.id), total: page.total, all: page.stats.all, listings: page.liveStats?.listings ?? null }
  }
  it('channel states: ANY of them; Not listed = a destination with no listing (or only a removed one)', async () => {
    expect(await ask({ live: 'active' })).toMatchObject({ ids: ['lv-root', 'lv-solo'], total: 2 })
    expect(await ask({ live: 'paused,ended' })).toMatchObject({ ids: [], total: 0, all: 0, listings: 0 })
    expect(await ask({ live: 'paused,active' })).toMatchObject({ total: 2 })
    // The parka family has variations not listed on Amazon IT and UK; the gloves are listed everywhere they are checked.
    expect(await ask({ live: 'not_listed' })).toMatchObject({ ids: ['lv-root'], total: 1 })
    expect(await ask({ live: 'draft,not_listed' })).toMatchObject({ ids: ['lv-root'] })
  })
  it('flags: ALL of them on the same listing; with a state, both', async () => {
    // Suppressed: only the parka. Every tile follows the narrowed result (the readiness tiles too).
    expect(await ask({ flags: 'suppressed' })).toEqual({ ids: ['lv-root'], total: 1, all: 12, listings: 6 })
    expect(await ask({ flags: 'error,lowStock,outOfSync,suppressed' })).toMatchObject({ ids: ['lv-root'] })
    expect(await ask({ live: 'paused', flags: 'suppressed' })).toMatchObject({ ids: [], total: 0 })
    expect(await ask({ live: 'not_listed', flags: 'suppressed' })).toMatchObject({ ids: [], total: 0 })
    // Two flags on two different listings of one family do not make a match.
    await scoped(async () => {
      await prisma.channelListing.update({ where: { id: 'lv-l-v2' }, data: { quantity: 50 } })
      await prisma.channelListing.update({ where: { id: 'lv-l-v1' }, data: { quantity: 3 } })
    })
    try {
      expect(await ask({ flags: 'lowStock' })).toMatchObject({ ids: ['lv-root'] })
      expect(await ask({ flags: 'lowStock,suppressed' })).toMatchObject({ ids: [], total: 0 })
    } finally {
      await scoped(async () => {
        await prisma.channelListing.update({ where: { id: 'lv-l-v2' }, data: { quantity: 2 } })
        await prisma.channelListing.update({ where: { id: 'lv-l-v1' }, data: { quantity: 15 } })
      })
    }
  })
  it('paging counts the narrowed result; a caller without listings.view has the live filters ignored', async () => {
    const second = await scoped(() => readinessFamilies({ live: 'active', page: '2' }, null, { live: true }))
    expect(second).toMatchObject({ total: 2, rows: [] })
    expect(await ask({ flags: 'suppressed', live: 'paused' }, false)).toEqual({ ids: ['lv-root', 'lv-solo'], total: 2, all: 14, listings: null })
    // Unknown values are dropped, never refused.
    expect(await ask({ live: 'bogus', flags: 'nope' })).toMatchObject({ total: 2 })
  })
})

describe('the ETag with the live layer', () => {
  it('answers 304 while nothing changed, never after a listing, a channel message or the permission changed', async () => {
    const families = (held: string | null, live = true) => scoped(() => readinessFamiliesIfChanged({}, null, tag => tag === held, { live }))
    const first = await families(null)
    expect(first.page).not.toBeNull()
    expect(await families(first.etag)).toEqual({ etag: first.etag, page: null })
    // The same data without listings.view is another answer.
    expect((await families(first.etag, false)).etag).not.toBe(first.etag)
    // A listing's price changes: a new answer.
    await scoped(() => prisma.channelListing.update({ where: { id: 'lv-l-solo' }, data: { price: 19.9 } }))
    const priced = await families(first.etag)
    expect(priced.page).not.toBeNull()
    // A channel message opens on a listing: a new answer again.
    await scoped(() => prisma.listingIssue.create({ data: { id: 'lv-issue-new', listingId: 'lv-l-solo', code: '1', severity: 'ERROR', message: 'New', attributeNames: [], categories: [], fingerprint: 'N::' } }))
    try {
      const flagged = await families(priced.etag)
      expect(flagged.page).not.toBeNull()
      expect(flagged.page!.liveStats!.error).toBe(2)
      // The open family's members answer the same way.
      const members = (held: string | null) => scoped(() => readinessFamilyMembersIfChanged('lv-root', {}, null, tag => tag === held, { live: true }))
      const open = await members(null)
      expect((await members(open.etag)).page).toBeNull()
      await scoped(() => prisma.amazonSuppression.updateMany({ where: { listingId: 'lv-l-v2' }, data: { resolvedAt: new Date() } }))
      expect((await members(open.etag)).page).not.toBeNull()
    } finally {
      await scoped(async () => {
        await prisma.listingIssue.delete({ where: { id: 'lv-issue-new' } })
        await prisma.amazonSuppression.updateMany({ where: { listingId: 'lv-l-v2' }, data: { resolvedAt: null } })
      })
    }
  })
})
