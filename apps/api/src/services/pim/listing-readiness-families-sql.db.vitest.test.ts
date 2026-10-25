/**
 * Listing readiness, family view — the SQL top level (step 2 of the Listings plan: the load fix) on a real PostgreSQL
 * (PGlite). The page now asks ONE SQL summary for the tiles, totals and the page's family ids, then folds only the page's
 * families. This file holds the previous way as an oracle — every filtered row in memory, folded, filled, ranked and
 * paged in TypeScript — and requires the SQL path to return EXACTLY the same page for a varied business: families and
 * singles, several stores and markets, an alias, languages, pending rows, siblings without a destination (the fill),
 * every state, an unknown stored state, deleted products, search wildcards and every selector. Ids invented.
 * `NEXUS_READINESS_PERF=1` also times both ways on a business of production size.
 *
 * Step 4 (live layer): every sort in both directions, paged; the live sorts (price, stock, status, last sync, problems
 * with channel errors) and the column filters on one destination against the chips' own numbers (`summarizeLive`),
 * and the refusals (no one market; a market with two stores).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
// The live read loads the listing-action engine; its queues stay out of a test.
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import type { Prisma } from '@prisma/client'
import type { ReadinessFamiliesPage, ReadinessScopeState, ReadinessSort } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { inDatabaseReadTransaction } from '../../lib/database-context.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  channelErrorsOf, compareSorted, countStates, describeDestinations, destinationInfos, destinationValue, familiesOf, familiesQuery, familyPageRows, fillNotComputed,
  foldListings, productsOf, readinessFamilies, readinessFamiliesIfChanged, readinessFamilyMembers, readinessFamilyMembersIfChanged, searchScope, storeNamesFor,
  summarizeMembers, type FamilyPageItem, type LightRow, type MemberSummary, type ProductInfo,
} from './listing-readiness-families.service.js'
import { listingReadinessWhere } from './listing-readiness.service.js'
import { attachLive, liveMarketCode, liveScopeOf, readLive, searchProductHits, summarizeLive, type LiveRead } from './listing-readiness-live.service.js'
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
 * Step 4: the families in the request's order, each sort's value computed here from the rows and, for the live sorts,
 * from the chips' own reading (`readLive` + `summarizeLive`); the column filters likewise.
 */
interface OracleFamily { id: string; root: ProductInfo; members: MemberSummary[]; listings: FamilyPageItem['listings']; matchingCount: number; pending: boolean; state: ReadinessScopeState }
async function inMemoryResult(query: Record<string, unknown>, live = false) {
  const input = familiesQuery(query)
  const parts: Prisma.ReadinessIndexWhereInput[] = [await listingReadinessWhere({ ...query, state: undefined }, null)]
  // The search as the members and the Fix window read it (step 3: the phrase OR each term exactly on the ids).
  if (input.q) parts.push(searchScope(await searchProductHits(input.q)))
  const where = parts.length === 1 ? parts[0] : { AND: parts }
  const rows: LightRow[] = await prisma.readinessIndex.findMany({ where, select: LIGHT })
  const products = await productsOf(rows.map(r => r.productId))
  const infos = destinationInfos(rows)
  const destinations = describeDestinations(infos.values(), await storeNamesFor(infos.values()))
  const order = new Map(destinations.map((d, i) => [d.key, i]))
  const families: OracleFamily[] = [...familiesOf(foldListings(rows).values(), id => products.get(id)?.parentId).entries()].map(([rootId, family]) => {
    if (!input.listingIds) fillNotComputed(family)
    const root = products.get(rootId) ?? { id: rootId, sku: '', name: null, parentId: null, isParent: false }
    const members = summarizeMembers(family, rootId, root.isParent || family.size > 1, id => products.get(id), input.state)
    const listings = members.flatMap(m => m.listings)
    return { id: rootId, root, members, listings, matchingCount: members.filter(m => m.matches).length, pending: listings.some(l => l.pending),
      state: listings.reduce<ReadinessScopeState>((s, l) => scopeStateRank(s) <= scopeStateRank(l.state) ? s : l.state, 'ready') }
  })
  // Step 4: each family's sort value.
  const fields = new Map<string, Set<string>>()
  if (input.sort === 'problems') {
    for (const row of await prisma.readinessIndex.findMany({ where, select: { productId: true, coordinateKey: true, missing: true } })) {
      const root = products.get(row.productId)?.parentId ?? row.productId
      if (!fields.has(root)) fields.set(root, new Set())
      for (const entry of Array.isArray(row.missing) ? row.missing as Array<{ field?: unknown }> : []) fields.get(root)!.add(`${row.coordinateKey}\u0000${typeof entry.field === 'string' ? entry.field : ''}`)
    }
  }
  const memberIds = (f: OracleFamily) => f.members.map(m => m.product.id)
  const read: LiveRead | null = live ? await readLive(families.flatMap(memberIds), liveScopeOf(input)) : null
  const oneMarket = live && input.channel && input.channel !== 'SHARED' && input.marketplace
  const accounts = oneMarket ? [...new Set((await prisma.readinessIndex.findMany({ where: { channel: input.channel, market: input.marketplace, aliasId: null }, select: { accountId: true } })).map(r => r.accountId))] : []
  const key = oneMarket && (input.accountId || accounts.length <= 1) ? JSON.stringify([input.channel, liveMarketCode(input.marketplace), input.accountId ?? accounts[0] ?? null, null]) : null
  const value = (f: OracleFamily): number | null => {
    switch (input.sort) {
      case 'checked': { const times = f.listings.flatMap(l => l.computedAt ? [l.computedAt.getTime()] : []); return times.length ? Math.min(...times) : null }
      case 'problems': return (fields.get(f.id)?.size ?? 0) + (read ? memberIds(f).reduce((n, id) => n + channelErrorsOf(read, id), 0) : 0)
      case 'price': case 'stock': case 'status': case 'synced': return read && key ? destinationValue(input.sort, memberIds(f), key, read) : null
      default: return null
    }
  }
  // A live sort without the live layer (or one destination) keeps today's order, as the SQL does.
  const sort: ReadinessSort = ['price', 'stock', 'status', 'synced'].includes(input.sort) && !(read && key) ? 'state' : input.sort
  const dir = sort === input.sort ? input.dir : 'asc'
  // Step 4's column filters, on the one destination and with the live layer only.
  const c = input.columns
  const passes = (f: OracleFamily) => {
    if (!read || !key) return true
    const ids = memberIds(f)
    const counted = ids.filter(id => read.facts.products.get(id)?.parentId)
    const entries = (id: string) => read.get(id)?.get(key) ?? []
    if (c.priceMin !== undefined || c.priceMax !== undefined) {
      const prices = (counted.length ? counted : ids).flatMap(entries).map(e => e.price).filter((p): p is number => p !== null)
      if (!prices.some(p => (c.priceMin === undefined || p >= c.priceMin) && (c.priceMax === undefined || p <= c.priceMax))) return false
    }
    if (c.qtyMin !== undefined || c.qtyMax !== undefined) {
      const qty = summarizeLive(ids, key, read).quantity
      if (qty === null || (c.qtyMin !== undefined && qty < c.qtyMin) || (c.qtyMax !== undefined && qty > c.qtyMax)) return false
    }
    if (c.channelId) {
      const text = c.channelId.toLowerCase()
      if (!ids.flatMap(entries).some(e => [e.externalId, e.externalParentId].some(id => id?.toLowerCase().includes(text)))) return false
    }
    return true
  }
  const kept = families.filter(passes)
  const facts = (f: OracleFamily) => ({ ...f.root, state: f.state, value: value(f) })
  const shown = kept.filter(f => f.matchingCount > 0).sort((a, b) => compareSorted(facts(a), facts(b), sort, dir))
  return { input, rows, products, infos, destinations, order, families: kept, shown }
}

async function inMemoryFamilies(query: Record<string, unknown>): Promise<ReadinessFamiliesPage> {
  const cutoff = new Date(Date.now() - 24 * HOUR)
  return inDatabaseReadTransaction(prisma, async () => {
    const { input, rows, destinations, order, infos, families, shown } = await inMemoryResult(query)
    const all = families.flatMap(f => f.listings)
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

/** Step 4 — the live order: every page of the SQL path (live on) in sequence equals the oracle's whole order. */
async function sameOrder(query: Record<string, unknown>, pageSize = 50) {
  const expected = await scoped(() => inDatabaseReadTransaction(prisma, async () => (await inMemoryResult({ ...query, pageSize: String(pageSize) }, true)).shown.map(f => f.id)))
  const seen: string[] = []
  for (let page = 1; page === 1 || seen.length < expected.length; page++) {
    const answer = await scoped(() => readinessFamilies({ ...query, page: String(page), pageSize: String(pageSize) }, null, { live: true }))
    expect(answer.total).toBe(expected.length)
    if (!answer.rows.length) break
    seen.push(...answer.rows.map(r => r.id))
  }
  expect(seen).toEqual(expected)
  expect(new Set(seen).size).toBe(seen.length)
  return expected
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

  // Step 4: the generated families' listings on Amazon IT (Xavia) and DE — prices, quantities, syncs, selling states,
  // open channel errors — and what the live sorts and column filters must leave out or flag: listings under a
  // customization (alias), another store's listing on the same market, twins on one market ("IT" and "it": a quantity
  // nobody can pick), and a family root's own listing beside its variations'.
  let r = 7
  const pick = (n: number) => { r = (r * 1103515245 + 12345) % 2147483648; return Math.floor(r / 65536) % n }
  const STATUS = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ENDED', 'INACTIVE', 'DRAFT']
  const channelListings: Array<Record<string, unknown>> = [], issues: Array<Record<string, unknown>> = []
  let n = 0
  const add = (productId: string, parentId: string | undefined, extra: Record<string, unknown> = {}) => {
    const id = `pq-cl-${++n}`, status = STATUS[pick(STATUS.length)]
    channelListings.push({ id, productId, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'IT', channelConnectionId: 'pq-a1', aliasKey: '',
      listingStatus: status, isPublished: status !== 'DRAFT', externalListingId: status === 'DRAFT' ? null : `B0PQ${String(n).padStart(5, '0')}`,
      externalParentId: parentId ? `B0PQP${parentId.slice(4).toUpperCase()}` : null, price: pick(6) ? 10 + pick(40) + pick(100) / 100 : null,
      quantity: pick(5) ? pick(25) : null, followMasterPrice: pick(3) > 0, lastSyncedAt: pick(4) ? new Date(started - pick(900) * 60_000) : null,
      lastSyncStatus: ['SUCCESS', 'FAILED', 'PENDING', null][pick(4)], ...extra })
    if (!pick(4)) issues.push({ listingId: id, code: `E${n}`, severity: 'ERROR', message: 'An error', attributeNames: [], categories: [], fingerprint: `E${n}::` })
    if (!pick(9)) issues.push({ listingId: id, code: `F${n}`, severity: 'ERROR', message: 'Another error', attributeNames: [], categories: [], fingerprint: `F${n}::` })
    if (!pick(7)) issues.push({ listingId: id, code: `W${n}`, severity: 'WARNING', message: 'A warning', attributeNames: [], categories: [], fingerprint: `W${n}::` })
    if (!pick(12)) issues.push({ listingId: id, code: `R${n}`, severity: 'ERROR', message: 'Resolved', attributeNames: [], categories: [], fingerprint: `R${n}::`, resolvedAt: at(false) })
  }
  for (const p of [...generated, ...variants] as Array<{ id: string; parentId?: string }>) {
    if (!pick(5)) continue
    add(p.id, p.parentId)
    if (!pick(20)) add(p.id, p.parentId, { marketplace: 'it', channelMarket: 'AMAZON_it' })
    if (!pick(8)) add(p.id, p.parentId, { aliasKey: 'pq-alias', price: 0.5, quantity: 999 })
    if (!pick(8)) add(p.id, p.parentId, { channelConnectionId: 'pq-a2', price: 0.75, quantity: 888 })
    if (!pick(3)) add(p.id, p.parentId, { marketplace: 'DE', channelMarket: 'AMAZON_DE' })
  }
  await prisma.channelListing.createMany({ data: channelListings as never })
  await prisma.listingIssue.createMany({ data: issues as never })
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

describe('step 4: the server sorts, in both directions, paged', () => {
  it('state, name, problems and checked return exactly the oracle\'s page (rows, order, tiles), on every page', async () => {
    for (const sort of ['state', 'name', 'problems', 'checked']) for (const dir of ['asc', 'desc']) {
      const first = await same({ sort, dir })
      await same({ sort, dir, page: '2' })
      // A filter and a state tile keep the order rule.
      if (dir === 'desc') await same({ sort, dir, channel: 'AMAZON', state: 'notChecked', pageSize: '100' })
      if (sort === 'state' && dir === 'asc') expect(first.rows.map(r => r.id)).toEqual((await same({})).rows.map(r => r.id))
    }
    // Desc is not asc reversed: the ties stay name → SKU → id, ascending.
    const asc = await same({ sort: 'name', dir: 'asc', pageSize: '200' }), desc = await same({ sort: 'name', dir: 'desc', pageSize: '200' })
    expect(desc.rows.map(r => r.id)).not.toEqual([...asc.rows].reverse().map(r => r.id))
    expect(new Set(desc.rows.map(r => r.id))).toEqual(new Set(asc.rows.map(r => r.id)))
  }, SLOW * 4)

  it('the live sorts read the chips\' own numbers on the one destination (price, stock, status, last sync), paged and stable', async () => {
    const xavia = { channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1' }
    for (const sort of ['price', 'stock', 'status', 'synced', 'problems']) for (const dir of ['asc', 'desc']) {
      const order = await sameOrder({ ...xavia, sort, dir })
      expect(order.length).toBeGreaterThan(50)
    }
    // Amazon DE has one store: no store needs naming. With a state tile.
    await sameOrder({ channel: 'AMAZON', marketplace: 'DE', sort: 'price', dir: 'desc' })
    await sameOrder({ ...xavia, sort: 'stock', state: 'blocked' })
    // Problems with the live layer count the channel's open errors too: on /listings, every listing of the family.
    await sameOrder({ sort: 'problems', dir: 'desc' }, 100)
  }, SLOW * 4)

  it('a live sort is refused without one market, or on a market with two stores and none named; ignored without listings.view', async () => {
    for (const query of [{ sort: 'price' }, { sort: 'stock', channel: 'AMAZON' }, { sort: 'status', marketplace: 'IT' }, { sort: 'synced', channel: 'SHARED', marketplace: 'IT' }]) {
      await expect(scoped(() => readinessFamilies(query, null, { live: true }))).rejects.toThrow('Choose one market to sort by price, stock, status or last sync')
    }
    await expect(scoped(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT', sort: 'price' }, null, { live: true }))).rejects.toThrow('Choose one store')
    await expect(scoped(() => readinessFamilies({ sort: 'cheapest' }, null))).rejects.toThrow('Sort by state, name')
    await expect(scoped(() => readinessFamilies({ sort: 'name', dir: 'up' }, null))).rejects.toThrow('Sort asc or desc')
    // Without listings.view the price is not read: today's order, exactly.
    const plain = await same({ channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1', sort: 'price', dir: 'desc' })
    expect(plain.rows.map(r => r.id)).toEqual((await same({ channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1' })).rows.map(r => r.id))
  }, SLOW)

  it('the open family\'s members follow the sort, the parent\'s own listing first', async () => {
    const byName = await scoped(() => readinessFamilyMembers('pq-r1', { sort: 'name', dir: 'desc', limit: '20' }, null))
    expect(byName.rows.map(r => r.sku)).toEqual(['STORM', 'STORM-XL', 'STORM-M', 'STORM-L'])
    const byState = await scoped(() => readinessFamilyMembers('pq-r1', { limit: '20' }, null))
    expect(byState.rows[0].isParentListing).toBe(true)
    const desc = await scoped(() => readinessFamilyMembers('pq-r1', { sort: 'state', dir: 'desc', limit: '20' }, null))
    expect(desc.rows.slice(1).map(r => r.state)).toEqual([...byState.rows.slice(1).map(r => r.state)].sort((a, b) => scopeStateRank(b) - scopeStateRank(a)))
    // A live sort on one destination: each variation's own price, a missing price last.
    const family = (await scoped(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1', pageSize: '200' }, null))).rows.find(f => f.variantCount >= 3)!
    const priced = await scoped(() => readinessFamilyMembers(family.id, { channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1', sort: 'price', limit: '20' }, null, { live: true }))
    const prices = priced.rows.filter(r => !r.isParentListing).map(r => r.chips.find(c => c.live)?.live?.priceMin ?? null)
    const known = prices.filter((p): p is number => p !== null)
    expect(known).toEqual([...known].sort((a, b) => a - b))
    expect(prices.slice(known.length).every(p => p === null)).toBe(true)
  }, SLOW)
})

describe('step 4: the column filters on one destination', () => {
  const xavia = { channel: 'AMAZON', marketplace: 'IT', accountId: 'pq-a1' }
  it('price, quantity and channel id keep the families the chips\' numbers say, and every tile follows them', async () => {
    const all = await sameOrder(xavia, 200)
    const full = await scoped(() => readinessFamilies(xavia, null, { live: true }))
    for (const filters of [{ priceMin: '20' }, { priceMax: '25.5' }, { qtyMin: '10' }, { qtyMin: '5', qtyMax: '20' }, { channelId: 'b0pqp' }, { priceMin: '15', qtyMin: '1', channelId: 'B0PQ' }]) {
      const kept = await sameOrder({ ...xavia, ...filters, sort: 'name' }, 200)
      expect(kept.length).toBeLessThan(all.length)
      expect(kept.length).toBeGreaterThan(0)
      const narrowed = await scoped(() => readinessFamilies({ ...xavia, ...filters }, null, { live: true }))
      expect(narrowed.stats.all).toBeLessThan(full.stats.all)
      expect(narrowed.liveStats!.listings).toBeLessThanOrEqual(full.liveStats!.listings)
    }
    // A wildcard is a character, not a pattern.
    expect(await sameOrder({ ...xavia, channelId: '%' }, 200)).toEqual([])
    expect(await sameOrder({ ...xavia, channelId: '_' }, 200)).toEqual([])
  }, SLOW * 3)

  it('ignored elsewhere (no one destination, no listings.view); refused when they are not numbers', async () => {
    expect((await scoped(() => readinessFamilies({ priceMin: '20' }, null, { live: true }))).total).toBe((await scoped(() => readinessFamilies({}, null, { live: true }))).total)
    expect((await scoped(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT', qtyMax: '1' }, null, { live: true }))).total)
      .toBe((await scoped(() => readinessFamilies({ channel: 'AMAZON', marketplace: 'IT' }, null, { live: true }))).total)
    await same({ ...xavia, priceMin: '20', channelId: 'B0PQ' })
    for (const [query, message] of [[{ priceMin: 'ten' }, 'Enter the lowest price as a number'], [{ qtyMax: '-1' }, 'Enter the highest quantity as a number'],
      [{ priceMin: '30', priceMax: '20' }, 'The lowest price is above the highest'], [{ qtyMin: '9', qtyMax: '2' }, 'The lowest quantity is above the highest']] as const) {
      await expect(scoped(() => readinessFamilies(query, null, { live: true }))).rejects.toThrow(message)
    }
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
    // Step 4: another order or another column filter is another answer.
    expect((await ask({ q: 'storm', sort: 'name' })).etag).not.toBe(first.etag)
    expect((await ask({ q: 'storm', sort: 'name', dir: 'desc' })).etag).not.toBe((await ask({ q: 'storm', sort: 'name' })).etag)

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
