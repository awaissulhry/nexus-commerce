/**
 * Listing readiness, family view — the SQL top level (step 2 of the Listings plan: the load fix) on a real PostgreSQL
 * (PGlite). The page now asks ONE SQL summary for the tiles, totals and the page's family ids, then folds only the page's
 * families. This file holds the previous way as an oracle — every filtered row in memory, folded, filled, ranked and
 * paged in TypeScript — and requires the SQL path to return EXACTLY the same page for a varied business: families and
 * singles, several stores and markets, an alias, languages, pending rows, siblings without a destination (the fill),
 * every state, an unknown stored state, deleted products, search wildcards and every selector. Ids invented.
 * `NEXUS_READINESS_PERF=1` also times both ways on a business of production size.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})

import type { Prisma } from '@prisma/client'
import type { ReadinessFamiliesPage, ReadinessScopeState } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  compareRows, countStates, describeDestinations, destinationInfos, familiesOf, familiesQuery, familyPageRows, fillNotComputed, foldListings, productsOf,
  readinessFamilies, readinessFamiliesIfChanged, readinessFamilyMembers, readinessFamilyMembersIfChanged, searchScope, storeNamesFor, summarizeMembers,
  type FamilyPageItem, type LightRow,
} from './listing-readiness-families.service.js'
import { listingReadinessWhere } from './listing-readiness.service.js'
import { attachLive, searchProductHits } from './listing-readiness-live.service.js'
import { scopeStateRank } from './readiness-model.js'
import { weakEtag } from '../../utils/list-etag.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
type Coordinate = [string | null, string | null, string | null, string | null]
const key = (c: Coordinate) => JSON.stringify(c)
const SHARED: Coordinate = [null, null, null, null]
const AMZ_IT_1: Coordinate = ['AMAZON', 'IT', 'pq-a1', null], AMZ_IT_2: Coordinate = ['AMAZON', 'IT', 'pq-a2', null], AMZ_DE: Coordinate = ['AMAZON', 'DE', 'pq-a1', null]
const EBAY_IT: Coordinate = ['EBAY', 'IT', 'pq-e1', null], EBAY_IT_ALIAS: Coordinate = ['EBAY', 'IT', 'pq-e1', 'al2'], SHOPIFY: Coordinate = ['SHOPIFY', 'GLOBAL', 'pq-s1', null]
const COORDINATES = [SHARED, AMZ_IT_1, AMZ_IT_2, AMZ_DE, EBAY_IT, EBAY_IT_ALIAS, SHOPIFY]
const labelOf = (c: Coordinate) => !c[0] ? 'Shared product' : `${c[0]} · ${c[1]} · ${c[2]}${c[3] ? ' · Second listing' : ''}`

const HOUR = 60 * 60 * 1000
const started = Date.now()
/** Recent (an hour ago) or old (two days ago), minus `minutes`, so the oldest and newest checks are distinct. */
const at = (old: boolean, minutes = 0) => new Date(started - (old ? 48 : 1) * HOUR - minutes * 60_000)

interface Row { productId: string; c: Coordinate; language: string; state: string; missing?: unknown[]; note?: string; computedAt?: Date; pendingSince?: Date | null }
const index = ({ productId, c, language, state: s, missing = [], note, computedAt, pendingSince = null }: Row) => ({
  productId, coordinateKey: key(c), channel: c[0], market: c[1], accountId: c[2], aliasId: c[3], language, label: labelOf(c), pct: null, state: s,
  requiredFilled: 0, requiredTotal: 0, missing, note: note ?? null, computedAt: computedAt ?? at(false), pendingSince,
})
const brand = (productId: string) => [{ productId, field: 'brand', label: 'Brand', reason: 'Required and empty', requiredEmpty: true, requiredBy: ['Amazon · IT'] }]
const title = (productId: string) => [{ productId, field: 'item_name', label: 'Title', reason: 'Not translated', kind: 'language-fallback' }]

const LIGHT = { id: true, productId: true, coordinateKey: true, channel: true, market: true, accountId: true, aliasId: true,
  language: true, label: true, state: true, computedAt: true, pendingSince: true } satisfies Prisma.ReadinessIndexSelect

/**
 * THE ORACLE — the family view as it was computed before the SQL summary (every filtered row in memory), with step 1's
 * two rules (`checked`, and no fill for a `listingIds` selection). The page's words go through the same `familyPageRows`.
 */
async function inMemoryFamilies(query: Record<string, unknown>): Promise<ReadinessFamiliesPage> {
  const input = familiesQuery(query)
  const cutoff = new Date(Date.now() - 24 * HOUR)
  return inDatabaseReadTransaction(prisma, async () => {
    const parts: Prisma.ReadinessIndexWhereInput[] = [await listingReadinessWhere({ ...query, state: undefined }, null)]
    // The search as the members and the Fix window read it (step 3: the phrase OR each term exactly on the ids).
    if (input.q) parts.push(searchScope(await searchProductHits(input.q)))
    const rows: LightRow[] = await prisma.readinessIndex.findMany({ where: parts.length === 1 ? parts[0] : { AND: parts }, select: LIGHT })
    const products = await productsOf(rows.map(r => r.productId))
    const infos = destinationInfos(rows)
    const destinations = describeDestinations(infos.values(), await storeNamesFor(infos.values()))
    const order = new Map(destinations.map((d, i) => [d.key, i]))
    const families = [...familiesOf(foldListings(rows).values(), id => products.get(id)?.parentId).entries()].map(([rootId, family]) => {
      if (!input.listingIds) fillNotComputed(family)
      const root = products.get(rootId) ?? { id: rootId, sku: '', name: null, parentId: null, isParent: false }
      const members = summarizeMembers(family, rootId, root.isParent || family.size > 1, id => products.get(id), input.state)
      const listings = members.flatMap(m => m.listings)
      return { id: rootId, root, members, listings, matchingCount: members.filter(m => m.matches).length, pending: listings.some(l => l.pending),
        state: listings.reduce<ReadinessScopeState>((s, l) => scopeStateRank(s) <= scopeStateRank(l.state) ? s : l.state, 'ready') }
    })
    const all = families.flatMap(f => f.listings)
    const shown = families.filter(f => f.matchingCount > 0).sort((a, b) => compareRows({ ...a.root, state: a.state }, { ...b.root, state: b.state }))
    const page: FamilyPageItem[] = shown.slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
    const times = rows.map(r => r.computedAt.getTime())
    // The live layer's post-step (step 3), off: the same null live fields and the pasted-list summary.
    return attachLive({
      page: input.page, pageSize: input.pageSize, total: shown.length, listingCount: all.length, productCount: families.reduce((n, f) => n + f.members.length, 0),
      stats: { ...countStates(all), all: all.length }, destinations,
      computedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
      checked: { latest: times.length ? new Date(Math.max(...times)).toISOString() : null, olderThanDay: all.filter(l => !l.filled && l.computedAt! < cutoff).length },
      pendingCount: families.filter(f => f.pending).length,
      rows: await familyPageRows(page, order, infos),
    } as ReadinessFamiliesPage, { query: input, live: false, rowProducts: new Map() })
  })
}

/** Both ways, same query: the SQL path must equal the oracle, field for field. */
async function same(query: Record<string, unknown>) {
  const [sql, memory] = await scoped(async () => [await readinessFamilies(query, null), await inMemoryFamilies(query)])
  expect(sql).toEqual(memory)
  return sql
}

let listingL1 = '', listingL2 = ''
/** Each test reads the whole result many times, both ways: more than the default 10 s on a loaded machine. */
const SLOW = 60_000

beforeAll(() => scoped(async () => {
  await prisma.channelConnection.create({ data: { id: 'pq-a1', channelType: 'AMAZON', isActive: true, accountLabel: 'Xavia', externalAccountId: 'pq-seller-1' } as never })
  await prisma.channelConnection.create({ data: { id: 'pq-a2', channelType: 'AMAZON', isActive: true, displayName: 'Gale', externalAccountId: 'pq-seller-2' } as never })
  await prisma.channelConnection.create({ data: { id: 'pq-e1', channelType: 'EBAY', isActive: true, displayName: 'Xavia eBay', externalAccountId: 'pq-ebay-1' } as never })
  await prisma.productFamily.create({ data: { id: 'fam-1', code: 'JACKETS', label: 'Jackets' } })
  const product = (id: string, sku: string, name: string, extra: Record<string, unknown> = {}) => ({ id, sku, name, basePrice: 10, status: 'DRAFT', ...extra })
  await prisma.product.createMany({ data: [
    product('pq-r1', 'STORM', 'Storm Parka', { isParent: true, familyId: 'fam-1' }),
    product('pq-dead', 'DEAD', 'Dead parent', { isParent: true, deletedAt: new Date() }),
    product('pq-r2', 'STORM-2', 'STORM PARKA', { isParent: true }),
    product('pq-r3', 'ZEPH', 'Zephyr jacket', { isParent: true }),
    product('pq-s1', 'SOLO', 'alpha gloves'),
    product('pq-s2', 'CITTA', 'Città boots'),
    product('pq-s3', 'X_1', 'X_1 visor', { gtin: '0123456789012' }),
    product('pq-s4', 'XA1', 'XA1 visor'),
    product('pq-s5', 'BETA%', 'beta helmet', { familyId: 'fam-1' }),
    product('pq-del', 'GONE', 'Deleted thing', { deletedAt: new Date() }),
    product('pq-gp', 'GRAND', 'Grand family', { isParent: true }),
    // Upper-case letters beyond ASCII: JavaScript lower-cases them, so must the SQL order.
    product('pq-s6', 'ELAN', 'Élan boots'), product('pq-s7', 'AREA', 'àrea gloves'), product('pq-s8', 'UBER', 'Über vest'), product('pq-s9', 'ECRU', 'écru scarf'),
  ] })
  // Three levels (a parent that has a parent): each product belongs to the family of its own parent only.
  await prisma.product.create({ data: product('pq-mid', 'MIDDLE', 'Middle level', { isParent: true, parentId: 'pq-gp' }) as never })
  await prisma.product.create({ data: product('pq-leaf', 'LEAF', 'Leaf level', { parentId: 'pq-mid' }) as never })
  await prisma.product.createMany({ data: [
    product('pq-r1-m', 'STORM-M', 'Storm Parka M', { parentId: 'pq-r1', ean: '8001234567890' }),
    product('pq-r1-l', 'STORM-L', 'Storm Parka L', { parentId: 'pq-r1' }),
    product('pq-r1-x', 'STORM-XL', 'Storm Parka XL', { parentId: 'pq-r1', upc: '777000111222' }),
    product('pq-r2-a', 'STORM-2-A', 'Storm two A', { parentId: 'pq-r2' }),
    product('pq-r3-a', 'ZEPH-A', 'Zephyr A', { parentId: 'pq-r3' }),
    product('pq-r3-b', 'ZEPH-B', 'Zephyr B', { parentId: 'pq-r3' }),
    product('pq-dead-v', 'ORPH', 'Orphan variant', { parentId: 'pq-dead' }),
  ] })
  await prisma.productReadCache.create({ data: { id: 'pq-r1', sku: 'STORM', name: 'Storm Parka', status: 'DRAFT', imageUrl: 'https://img.test/storm.jpg', photoCount: 3,
    syncChannels: [], channelKeys: [], rollupChannelKeys: [], categoryIds: [], createdAt: at(false), updatedAt: at(false) } as never })
  const rows: Row[] = [
    { productId: 'pq-r1', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-r1', c: SHARED, language: 'de', state: 'ready' },
    { productId: 'pq-r1', c: AMZ_IT_1, language: 'it', state: 'ready', computedAt: at(true, 5) },
    { productId: 'pq-r1-m', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-r1-m', c: SHARED, language: 'de', state: 'warn', missing: title('pq-r1-m') },
    { productId: 'pq-r1-m', c: AMZ_IT_1, language: 'it', state: 'blocked', missing: brand('pq-r1-m') }, { productId: 'pq-r1-m', c: AMZ_IT_1, language: 'de', state: 'ready', computedAt: at(true, 30) },
    { productId: 'pq-r1-m', c: AMZ_DE, language: 'de', state: 'warn', missing: title('pq-r1-m') },
    { productId: 'pq-r1-m', c: EBAY_IT, language: 'it', state: 'ready', pendingSince: at(false) },
    { productId: 'pq-r1-l', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-r1-l', c: SHARED, language: 'de', state: 'ready' },
    { productId: 'pq-r1-l', c: AMZ_IT_1, language: 'it', state: 'notComputed' },
    { productId: 'pq-r1-l', c: EBAY_IT_ALIAS, language: 'it', state: 'absent', note: 'Category metadata is incomplete: JACKETS' },
    { productId: 'pq-r1-l', c: EBAY_IT, language: 'it', state: 'ready' },
    { productId: 'pq-r1-x', c: SHARED, language: 'it', state: 'ready', computedAt: at(true, 90) }, { productId: 'pq-r1-x', c: SHARED, language: 'de', state: 'ready', computedAt: at(true, 1) },
    { productId: 'pq-r2', c: SHARED, language: 'it', state: 'ready' },
    { productId: 'pq-r2-a', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-r2-a', c: AMZ_IT_2, language: 'it', state: 'blocked', missing: brand('pq-r2-a') },
    { productId: 'pq-r3-a', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-r3-a', c: SHOPIFY, language: 'it', state: 'ready' },
    { productId: 'pq-r3-b', c: SHARED, language: 'it', state: 'ready', computedAt: at(false, 59) },
    { productId: 'pq-s1', c: AMZ_IT_2, language: 'it', state: 'absent', note: 'Category metadata is incomplete: GLOVES' },
    { productId: 'pq-s2', c: SHARED, language: 'it', state: 'checks-passed' },
    { productId: 'pq-s3', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-s4', c: SHARED, language: 'it', state: 'warn' },
    { productId: 'pq-s5', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-s5', c: SHARED, language: 'de', state: 'ready' },
    { productId: 'pq-s5', c: AMZ_DE, language: 'de', state: 'ready', pendingSince: at(false, 3) },
    { productId: 'pq-del', c: SHARED, language: 'it', state: 'blocked' },
    { productId: 'pq-dead-v', c: SHARED, language: 'it', state: 'warn' }, { productId: 'pq-dead-v', c: AMZ_IT_1, language: 'it', state: 'ready' },
    ...['pq-s6', 'pq-s7', 'pq-s8', 'pq-s9'].map(productId => ({ productId, c: SHARED, language: 'it', state: 'warn' })),
    { productId: 'pq-gp', c: SHARED, language: 'it', state: 'ready' }, { productId: 'pq-mid', c: SHARED, language: 'it', state: 'warn' },
    { productId: 'pq-mid', c: AMZ_DE, language: 'de', state: 'ready' }, { productId: 'pq-leaf', c: SHARED, language: 'it', state: 'blocked' },
  ]
  // A generated business on top: 110 families or singles, names that collide case-insensitively (the SKU decides), random
  // destinations, languages and states, old checks and pending marks — so three pages of 50 and the fill all matter.
  let seed = 11
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n }
  const STATES = ['ready', 'ready', 'ready', 'warn', 'blocked', 'absent', 'notComputed', 'ready', 'warn']
  const generated: Array<Record<string, unknown>> = [], variants: Array<Record<string, unknown>> = []
  for (let i = 0; i < 110; i++) {
    const root = `pq-g${String(i).padStart(2, '0')}`, count = rand(4)
    const name = i % 7 === 0 ? 'gen shared name' : `${i % 2 ? 'Gen' : 'gen'} item ${String.fromCharCode(97 + rand(26))}${i}`
    generated.push(product(root, `G-${String(200 - i).padStart(3, '0')}`, i % 7 === 0 && i % 2 ? name.toUpperCase() : name, { isParent: count > 0 }))
    const members = [root, ...Array.from({ length: count }, (_, v) => `${root}-${v}`)]
    for (const id of members.slice(1)) variants.push(product(id, `G-${String(200 - i).padStart(3, '0')}-${id.slice(-1)}`, `Gen variant ${id}`, { parentId: root }))
    let any = false
    for (const [m, id] of members.entries()) {
      if (m === 0 && count > 0 && !rand(3)) continue // some parents have no rows of their own
      for (const c of COORDINATES) {
        if (rand(2)) continue
        for (const language of c === SHARED ? ['it', 'de'] : rand(3) ? ['it'] : ['it', 'de']) {
          if (language === 'de' && rand(2)) continue
          any = true
          rows.push({ productId: id, c, language, state: !rand(25) ? 'unknown-state' : STATES[rand(STATES.length)], missing: rand(3) ? [] : brand(id),
            computedAt: at(!rand(4), rand(600)), pendingSince: rand(15) ? null : at(false) })
        }
      }
    }
    if (!any) rows.push({ productId: root, c: SHARED, language: 'it', state: 'ready', computedAt: at(false, i) })
  }
  await prisma.product.createMany({ data: generated as never })
  await prisma.product.createMany({ data: variants as never })
  await prisma.readinessIndex.createMany({ data: rows.filter((row, i, all) => all.findIndex(o => o.productId === row.productId && key(o.c) === key(row.c) && o.language === row.language) === i).map(index) })
  const listing = (productId: string, c: Coordinate) => prisma.channelListing.create({ data: { productId, channel: c[0]!, channelMarket: `${c[0]}_${c[1]}`, region: c[1]!, marketplace: c[1]!,
    channelConnectionId: c[2], aliasKey: c[3] ?? '' } as never, select: { id: true } })
  listingL1 = (await listing('pq-r1-m', AMZ_IT_1)).id
  listingL2 = (await listing('pq-r1-l', EBAY_IT_ALIAS)).id
}), 120_000)
afterAll(async () => { await state.db?.close() })

describe('the SQL top level returns exactly what the in-memory fold returned', () => {
  it('every page, at every page size (rows, order, tiles, totals, destinations, checked times)', async () => {
    const first = await same({})
    expect(first.total).toBeGreaterThan(100)
    expect(first.stats.notComputed).toBeGreaterThan(0)
    expect(first.pendingCount).toBeGreaterThan(0)
    expect(first.checked.olderThanDay).toBeGreaterThan(0)
    expect(first.destinations.map(d => d.label)).toEqual(['Shared', 'Amazon DE', 'Amazon IT · Gale', 'Amazon IT · Xavia', 'eBay IT', 'eBay IT · Second listing', 'Shopify'])
    // Two blocked families named alike but for the case ("Storm Parka", "STORM PARKA"): the SKU decides, as in compareRows.
    expect((await same({ q: 'storm parka' })).rows.map(r => [r.id, r.state])).toEqual([['pq-r1', 'blocked'], ['pq-r2', 'blocked']])
    for (const page of ['2', '3', '4']) await same({ page })
    for (const page of ['1', '2']) await same({ page, pageSize: '100' })
    await same({ pageSize: '200' })
  }, SLOW)

  it('every state tile, on more than one page where it has one', async () => {
    for (const s of ['blocked', 'warn', 'notComputed', 'absent', 'ready', 'notChecked']) {
      const page = await same({ state: s })
      expect(page.total).toBeGreaterThan(0)
      if (page.total > 50) await same({ state: s, page: '2' })
    }
  }, SLOW)

  it('channel, market, store and language filters, alone and with a state', async () => {
    for (const query of [{ channel: 'AMAZON' }, { channel: 'SHARED' }, { channel: 'EBAY' }, { channel: 'shopify' }, { marketplace: 'IT' }, { market: 'de' },
      { accountId: 'pq-a2' }, { language: 'de' }, { channel: 'AMAZON', marketplace: 'IT' }, { channel: 'AMAZON', state: 'notComputed' },
      { language: 'de', state: 'notChecked' }, { channel: 'ETSY' }]) await same(query)
  }, SLOW)

  it('search: a variant, a family by its root, a barcode, wildcards, a root without rows, a deleted parent, many hits, none', async () => {
    for (const q of ['storm-l', 'STORM PARKA', '80012345', '7770001', '01234567', 'X_1', 'BETA%', '%', '_', 'zephyr', 'orphan', 'dead parent', 'gen', 'città', 'middle', 'grand', 'leaf', 'nothing like it']) {
      await same({ q })
      await same({ q, state: 'notChecked' })
    }
    expect((await same({ q: 'storm-l' })).rows.map(r => [r.id, r.matchingCount])).toEqual([['pq-r1', 1]])
    expect((await same({ q: 'zephyr' })).rows.map(r => r.id)).toEqual(['pq-r3'])
    // Prisma's `contains` never escaped `_` or `%` (`X_1` also finds `XA1`); the SQL search keeps exactly that behaviour.
    expect((await same({ q: 'X_1' })).rows.map(r => r.id)).toEqual(['pq-s4', 'pq-s3'])
    expect((await same({ q: 'BETA%' })).rows.map(r => r.id)).toEqual(['pq-s5'])
    await same({ q: 'gen', page: '2' })
    // àrea < écru < Élan < Über: lower-cased, then compared code point by code point.
    expect((await same({ productIds: 'pq-s6,pq-s7,pq-s8,pq-s9' })).rows.map(r => r.id)).toEqual(['pq-s7', 'pq-s9', 'pq-s6', 'pq-s8'])
    // A middle-level hit brings its own rows, never its variants: it is not a family's own product.
    expect((await same({ q: 'middle' })).rows.map(r => [r.id, r.matchingCount])).toEqual([['pq-gp', 1]])
  }, SLOW)

  it('selectors: product IDs, SKUs, a product family, listings (no fill), nothing found', async () => {
    await same({ productIds: 'pq-s1,pq-r1-m,pq-g05' })
    await same({ skus: '["STORM-L","SOLO","G-090"]' })
    await same({ familyId: 'fam-1' })
    await same({ familyId: 'fam-1', state: 'notComputed' })
    const listings = await same({ listingIds: `${listingL1},${listingL2}` })
    // Two listings selected: two listings counted, never their siblings' destinations as "not checked".
    expect(listings).toMatchObject({ listingCount: 2, productCount: 2, total: 1, stats: { blocked: 1, absent: 1, notComputed: 0, all: 2 } })
    await same({ listingIds: `${listingL1},${listingL2}`, state: 'notComputed' })
    await same({ listingIds: 'pq-no-such-listing' })
    await same({ productIds: 'pq-del' })
  }, SLOW)
})

describe('ETag: an unchanged poll is answered without building the page', () => {
  it('the tag keeps list-etag.ts\'s form: W/"<signals>.<filter hash>", a missing signal written 0', () => {
    expect(weakEtag([3, null])).toBe('W/"3.0.00000000"')
    expect(weakEtag([1, 2], { b: 1, a: 2 })).toBe(weakEtag([1, 2], { a: 2, b: 1 }))
    expect(weakEtag([1, 2], { a: 1 })).not.toBe(weakEtag([1, 2], { a: 2 }))
  })

  const ask = (query: Record<string, unknown>, held?: string) => scoped(() => readinessFamiliesIfChanged(query, null, tag => tag === held))

  it('the same answer gets the same tag and no page; a new check, a rename, a pending mark or another query gets a new tag', async () => {
    const storm = { q: 'storm' }
    const first = await ask(storm)
    expect(first.etag).toMatch(/^W\/".+"$/)
    expect(first.page).toEqual(await scoped(() => readinessFamilies(storm, null)))
    expect(await ask(storm, first.etag!)).toEqual({ etag: first.etag, page: null })
    expect((await ask({ q: 'storm', state: 'warn' })).etag).not.toBe(first.etag)
    expect((await ask({ q: 'storm', page: '2' })).etag).not.toBe(first.etag)

    // A check outside the result changes nothing; one inside does.
    await scoped(() => prisma.readinessIndex.updateMany({ where: { productId: 'pq-s4' }, data: { computedAt: new Date() } }))
    expect((await ask(storm, first.etag!)).page).toBeNull()
    await scoped(() => prisma.readinessIndex.updateMany({ where: { productId: 'pq-r2-a' }, data: { computedAt: new Date() } }))
    const checked = await ask(storm, first.etag!)
    expect(checked.etag).not.toBe(first.etag)
    expect(checked.page).not.toBeNull()

    // The root's name (shown, and the row order) is part of the answer.
    await scoped(() => prisma.product.update({ where: { id: 'pq-r2' }, data: { name: 'STORM PARKA renamed' } }))
    const renamed = await ask(storm, checked.etag!)
    expect(renamed.etag).not.toBe(checked.etag)
    expect(renamed.page!.rows.find(r => r.id === 'pq-r2')!.name).toBe('STORM PARKA renamed')
    await scoped(() => prisma.product.update({ where: { id: 'pq-r2' }, data: { name: 'STORM PARKA' } }))

    const all = await ask({})
    expect((await ask({}, all.etag!)).page).toBeNull()
    await scoped(() => prisma.readinessIndex.updateMany({ where: { productId: 'pq-s3' }, data: { pendingSince: new Date() } }))
    expect((await ask({}, all.etag!)).page).not.toBeNull()
  }, SLOW)

  it('members: the same tag and no page when nothing changed; the answer is the members page', async () => {
    const first = await scoped(() => readinessFamilyMembersIfChanged('pq-r1', {}, null, () => false))
    expect(first.page).toEqual(await scoped(() => readinessFamilyMembers('pq-r1', {}, null)))
    expect(await scoped(() => readinessFamilyMembersIfChanged('pq-r1', {}, null, tag => tag === first.etag))).toEqual({ etag: first.etag, page: null })
    await scoped(() => prisma.product.create({ data: { id: 'pq-r1-new', sku: 'STORM-XXL', name: 'Storm Parka XXL', basePrice: 10, status: 'DRAFT', parentId: 'pq-r1' } }))
    const added = await scoped(() => readinessFamilyMembersIfChanged('pq-r1', {}, null, tag => tag === first.etag))
    expect(added.page?.variantCount).toBe(4)
  }, SLOW)
})

it.skipIf(process.env.NEXUS_READINESS_PERF !== '1')('a business of production size: the SQL top level against the in-memory fold (timing printed)', async () => {
  const families = 300, variants = 3, coordinates: Coordinate[] = [SHARED, ...['IT', 'DE', 'FR', 'ES'].map((m): Coordinate => ['AMAZON', m, 'pq-a1', null]),
    EBAY_IT, SHOPIFY, ['ETSY', 'GLOBAL', 'pq-t1', null], EBAY_IT_ALIAS]
  await scoped(async () => {
    const products = Array.from({ length: families }, (_, f) => [{ id: `pf-${f}`, parentId: null as string | null }, ...Array.from({ length: variants }, (_, v) => ({ id: `pf-${f}-${v}`, parentId: `pf-${f}` }))]).flat()
    await prisma.product.createMany({ data: products.filter(p => !p.parentId).map(p => ({ id: p.id, sku: p.id.toUpperCase(), name: `Perf ${p.id}`, basePrice: 10, status: 'DRAFT', isParent: true })) })
    await prisma.product.createMany({ data: products.filter(p => p.parentId).map(p => ({ id: p.id, sku: p.id.toUpperCase(), name: `Perf ${p.id}`, basePrice: 10, status: 'DRAFT', parentId: p.parentId })) })
    const missing = (id: string) => Array.from({ length: 6 }, (_, i) => ({ productId: id, field: `field_${i}`, label: `Field ${i}`, reason: 'Required and empty — a sentence of ordinary length', requiredEmpty: true }))
    const rows = products.flatMap(p => coordinates.map(c => index({ productId: p.id, c, language: 'it', state: (p.id.length * 7 + c.length) % 3 ? 'blocked' : 'ready', missing: missing(p.id) })))
    for (let i = 0; i < rows.length; i += 2000) await prisma.readinessIndex.createMany({ data: rows.slice(i, i + 2000) })
  })
  // Production's tables carry planner statistics (autovacuum); a freshly filled PGlite has none until ANALYZE.
  await state.db.db.exec('ANALYZE')
  await scoped(async () => {
    const rows = await prisma.readinessIndex.count()
    // eslint-disable-next-line no-console
    console.log(`[readiness perf sql] ${rows} index rows in all, ${families} families of ${variants + 1} products added`)
  })
  for (const query of [{}, { page: '3' }, { q: 'perf', page: '2' }]) {
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now()
      const sql = await scoped(() => readinessFamilies(query, null))
      const t1 = performance.now()
      const memory = await scoped(() => inMemoryFamilies(query))
      const t2 = performance.now()
      const hit = await scoped(() => readinessFamiliesIfChanged(query, null, () => true))
      const t3 = performance.now()
      expect(hit.page).toBeNull()
      if (run === 0) expect(sql).toEqual(memory)
      // eslint-disable-next-line no-console
      console.log(`[readiness perf sql] ${JSON.stringify(query)} run ${run + 1}: SQL ${(t1 - t0).toFixed(0)} ms, in memory ${(t2 - t1).toFixed(0)} ms, unchanged (304) ${(t3 - t2).toFixed(0)} ms — ${sql.rows.length} rows of ${sql.total}, ${sql.listingCount} listings`)
    }
  }
}, 600_000)
