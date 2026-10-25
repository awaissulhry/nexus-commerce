/**
 * Listings live layer, step 3 — PARITY: the SQL state and flags (`liveJoinsSql` + `liveStateSql` + `liveFlagsSql`, what
 * the live tiles and the step-2 SQL summary read) say exactly what the TypeScript says (`readLive`: the product sheet's
 * `destinationSellingStates` per listing, and `liveFlagsOf`), over a table of fact combinations on a real PostgreSQL
 * (PGlite): every channel × listing status × channel id × published × offer hold, with Shopify owners (a family root's
 * status), Nexus's deletes and unlinks (and a publish after them), older Claude close pauses (the raw-SQL presence
 * columns), open and resolved issues and suppressions, drift, failed pushes and stock around the low-stock threshold.
 * Ids invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))

import { Prisma } from '@prisma/client'
import type { ReadinessLiveFlag } from '@nexus/shared/listing-readiness'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { liveCtes, liveFlagsOf, liveFlagsSql, liveJoinsSql, livePresenceColumns, liveStateSql, readLive } from './listing-readiness-live.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const CHANNELS = [['AMAZON', 'IT', 'ps-a1'], ['EBAY', 'IT', 'ps-e1'], ['SHOPIFY', 'GLOBAL', 'ps-s1'], ['ETSY', 'GLOBAL', 'ps-t1'], ['WOOCOMMERCE', 'GLOBAL', 'ps-w1']] as const
const STATUSES = ['DRAFT', 'ACTIVE', 'BUYABLE', 'DISCOVERABLE', 'INACTIVE', 'ENDED', 'ERROR', 'SUPPRESSED', ' active ']
const EXTERNAL = [null, '', 'X-1']
const SHOPIFY_STATUS = ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED', null, 42]
const QUANTITY = [null, 0, 5, 10, 11]
const t0 = new Date('2026-10-01T10:00:00Z'), t1 = new Date('2026-10-02T10:00:00Z'), t2 = new Date('2026-10-03T10:00:00Z')

const products: Array<{ id: string; sku: string; name: string; basePrice: number; status: string; lowStockThreshold: number; parentId?: string; isParent?: boolean }> = []
const listings: Array<Record<string, unknown>> = []
const facts = { issues: [] as Array<Record<string, unknown>>, suppressions: [] as Array<Record<string, unknown>>, drifts: [] as Array<Record<string, unknown>>,
  snapshots: [] as Array<{ listing: string; reason: string; acceptedAt: Date }>, ended: [] as Array<{ listing: string; reason: string | null }> }

function addListing(id: string, productId: string, [channel, marketplace, account]: readonly [string, string, string], i: number, extra: Record<string, unknown> = {}) {
  const shopify = SHOPIFY_STATUS[i % SHOPIFY_STATUS.length]
  listings.push({ id, productId, channel, marketplace, channelConnectionId: account, aliasKey: '', channelMarket: `${channel}_${marketplace}`, region: marketplace,
    platformAttributes: i % 23 === 0 ? ['not', 'an', 'object'] : shopify === null ? {} : { status: shopify, fulfillment_availability: i % 3 ? [] : [{ fulfillment_channel_code: 'AMAZON_EU' }] },
    quantity: QUANTITY[i % QUANTITY.length], syncStatus: i % 8 === 0 ? 'FAILED' : 'IDLE', lastSyncStatus: i % 12 === 0 ? 'failed' : i % 3 === 0 ? 'SUCCESS' : null, ...extra })
  if (i % 7 === 0) facts.issues.push({ listingId: id, code: `E${i}`, severity: 'ERROR', message: 'An error', attributeNames: [], categories: [], fingerprint: `E${i}::` })
  if (i % 11 === 0) facts.issues.push({ listingId: id, code: `R${i}`, severity: 'ERROR', message: 'Resolved', attributeNames: [], categories: [], fingerprint: `R${i}::`, resolvedAt: t1 })
  if (i % 5 === 0) facts.issues.push({ listingId: id, code: `W${i}`, severity: 'warning', message: 'A warning', attributeNames: [], categories: [], fingerprint: `W${i}::` })
  if (i % 13 === 0) facts.suppressions.push({ listingId: id, reasonText: 'Missing main image' })
  if (i % 17 === 0) facts.suppressions.push({ listingId: id, reasonText: 'Old', resolvedAt: t1 })
  if (i % 9 === 0 || i % 10 === 0) facts.drifts.push({ channelListingId: id, channel, marketplace, driftCount: i % 9 === 0 ? 1 : 0, driftedFields: [], lastCheckedAt: t1 })
  if (i % 6 === 0) facts.snapshots.push({ listing: id, reason: i % 24 === 0 ? 'unlink' : 'delete', acceptedAt: t1 })
  if (i % 18 === 0) facts.snapshots.push({ listing: id, reason: 'publish', acceptedAt: t2 })
  if (i % 30 === 0) facts.snapshots.push({ listing: id, reason: 'publish', acceptedAt: t0 })
}

// The single products: one listing each, every combination.
let i = 0
for (const channel of CHANNELS) for (const status of STATUSES) for (const external of EXTERNAL) for (const published of [true, false]) for (const hold of [null, 'sheet-pause', 'etsy-variation-hidden']) {
  const id = `ps-${++i}`
  products.push({ id, sku: id.toUpperCase(), name: id, basePrice: 10, status: 'DRAFT', lowStockThreshold: i % 2 ? 10 : 5 })
  const pinned = channel[0] === 'EBAY' && i % 4 === 0
  addListing(`${id}-l`, id, channel, i, { listingStatus: status, externalListingId: external, isPublished: published,
    offerClosedAt: hold ? t1 : null, offerCloseReason: hold, offerActive: i % 19 !== 0,
    ...(pinned ? { followMasterQuantity: false, quantityOverride: i % 8 === 0 ? 0 : 3 } : {}) })
  if (pinned) facts.ended.push({ listing: `${id}-l`, reason: i % 16 === 0 ? 'channel-file-delete' : 'claude-close' })
}
// Shopify families: the variants read their root's status (and its delete).
const ROOTS: Array<[string, string | null, string | null, boolean]> = [['ACTIVE', 'ACTIVE', 'gid://p/1', true], ['ACTIVE', 'ARCHIVED', 'gid://p/2', true],
  ['DRAFT', 'DRAFT', null, false], ['ENDED', null, 'gid://p/4', true], ['ACTIVE', 'UNLISTED', 'gid://p/5', true], ['ACTIVE', null, 'gid://p/6', true], ['DRAFT', null, null, true]]
ROOTS.forEach(([status, shopify, external, published], f) => {
  const root = `pf-${f}`
  products.push({ id: root, sku: root.toUpperCase(), name: root, basePrice: 10, status: 'DRAFT', lowStockThreshold: 10, isParent: true })
  listings.push({ id: `${root}-l`, productId: root, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'ps-s1', aliasKey: '', channelMarket: 'SHOPIFY_GLOBAL',
    region: 'GLOBAL', listingStatus: status, externalListingId: external, isPublished: published, platformAttributes: shopify ? { status: shopify } : {} })
  if (f === 6) facts.snapshots.push({ listing: `${root}-l`, reason: 'delete', acceptedAt: t1 })
  for (const [v, extra] of [['a', {}], ['b', { offerClosedAt: t1, offerCloseReason: 'sheet-pause' }], ['c', { externalListingId: null, listingStatus: 'DRAFT' }]] as const) {
    const id = `${root}-${v}`
    products.push({ id, sku: id.toUpperCase(), name: id, basePrice: 10, status: 'DRAFT', lowStockThreshold: 10, parentId: root })
    listings.push({ id: `${id}-l`, productId: id, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: 'ps-s1', aliasKey: '', channelMarket: 'SHOPIFY_GLOBAL',
      region: 'GLOBAL', listingStatus: 'ACTIVE', externalListingId: `gid://v/${f}${v}`, isPublished: true, quantity: 3, platformAttributes: { status: 'ACTIVE' }, ...extra })
  }
})

beforeAll(async () => {
  // The raw-SQL presence columns (migration 20260913180000_pr_presence), as the listing-action engine's own test adds them.
  await scoped(() => prisma.channelListing.count())
  await state.db.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMP(3), ADD COLUMN IF NOT EXISTS "endedBy" TEXT, ADD COLUMN IF NOT EXISTS "endedReason" TEXT')
  await scoped(async () => {
    for (const [channelType, , id] of CHANNELS) await prisma.channelConnection.create({ data: { id, channelType, isActive: true, externalAccountId: `seller-${id}` } as never })
    await prisma.product.createMany({ data: products as never })
    for (let at = 0; at < listings.length; at += 500) await prisma.channelListing.createMany({ data: listings.slice(at, at + 500) as never })
    await prisma.listingIssue.createMany({ data: facts.issues as never })
    await prisma.amazonSuppression.createMany({ data: facts.suppressions as never })
    await prisma.channelDrift.createMany({ data: facts.drifts as never })
    await prisma.channelListingSnapshot.createMany({ data: facts.snapshots.map(s => ({ channelListingId: s.listing, channel: 'X', marketplace: 'X', reason: s.reason,
      outcome: 'ACCEPTED', acceptedAt: s.acceptedAt, payload: { evidence: { oldExternalListingId: 'OLD' }, sku: 'OLD-SKU' } })) as never })
    for (const e of facts.ended) await prisma.$executeRawUnsafe('UPDATE "ChannelListing" SET "endedAt" = now(), "endedReason" = $2 WHERE id = $1', e.listing, e.reason)
  })
}, 240_000)
afterAll(async () => { await state.db?.close() })

const FLAGS: readonly ReadinessLiveFlag[] = ['error', 'suppressed', 'outOfSync', 'lowStock']

async function sqlRead(presence: boolean) {
  const flags = liveFlagsSql()
  const rows = await scoped(() => prisma.$queryRaw<Array<{ id: string; state: string } & Record<ReadinessLiveFlag, boolean>>>(Prisma.sql`
    SELECT l.id, ${liveStateSql()} AS state, ${flags.error} AS error, ${flags.suppressed} AS suppressed, ${flags.outOfSync} AS "outOfSync", ${flags.lowStock} AS "lowStock"
      FROM "ChannelListing" l ${liveJoinsSql({ presence })}`))
  return new Map(rows.map(r => [r.id, { state: r.state, flags: FLAGS.filter(f => r[f]) }]))
}

async function tsRead() {
  const live = await scoped(() => readLive(products.map(p => p.id)))
  const out = new Map<string, { state: string; flags: ReadinessLiveFlag[] }>()
  for (const [productId, byKey] of live) for (const entries of byKey.values()) for (const entry of entries) {
    const row = live.facts.rows.get(entry.listingId)!
    out.set(entry.listingId, { state: entry.state, flags: liveFlagsOf(entry, { listingStatus: row.listingStatus, lowStockThreshold: live.facts.products.get(productId)!.lowStockThreshold }) })
  }
  return out
}

describe('the SQL live state and flags = the TypeScript ones', () => {
  it('on every combination (presence columns on: older close pauses read Inactive in both)', async () => {
    expect(await scoped(() => livePresenceColumns())).toBe(true)
    const [sql, ts] = [await sqlRead(true), await tsRead()]
    expect(ts.size).toBe(listings.length)
    expect(sql.size).toBe(listings.length)
    const differences = [...ts].filter(([id, value]) => JSON.stringify(sql.get(id)) !== JSON.stringify(value))
      .map(([id, value]) => ({ id, listing: listings.find(l => l.id === id), ts: value, sql: sql.get(id) }))
    expect(differences).toEqual([])
    // The table is worth its name: every state and every flag occurs, both ways.
    expect(new Set([...ts.values()].map(v => v.state))).toEqual(new Set(['active', 'paused', 'ended', 'draft', 'not_listed', 'unknown']))
    for (const flag of FLAGS) {
      expect([...ts.values()].some(v => v.flags.includes(flag))).toBe(true)
      expect([...ts.values()].some(v => !v.flags.includes(flag))).toBe(true)
    }
    // The cases that make the SQL non-trivial do occur: a delete, a relist after it, an older close pause, a Shopify owner.
    expect(ts.get('ps-1-l')).toBeDefined()
    expect([...ts].filter(([id, v]) => id.startsWith('pf-') && v.state === 'ended').length).toBeGreaterThan(0)
    expect(listings.filter(l => facts.ended.some(e => e.listing === l.id)).some(l => ts.get(l.id as string)!.state === 'paused' && !(l.offerClosedAt))).toBe(true)
  })

  it('the page\'s live CTEs (the tiles and the live filters read them) carry the same state and flags', async () => {
    const ts = await tsRead()
    const view = { presence: true, states: [], flags: [], scope: {} }
    const rows = await scoped(() => prisma.$queryRaw<Array<{ id: string; state: string } & Record<ReadinessLiveFlag, boolean>>>(Prisma.sql`
      WITH src AS (SELECT p.id AS pid, COALESCE(p."parentId", p.id) AS root, NULL::text AS channel, NULL::text AS market, NULL::text AS account, NULL::text AS alias
                     FROM "Product" p WHERE p.id = ANY(${products.map(p => p.id)}::text[])),
      ${liveCtes('src', 't_', true, view)}
      SELECT id, state, error, suppressed, "outOfSync", "lowStock" FROM t_cl`))
    expect(rows.length).toBe(listings.length)
    for (const row of rows) expect({ state: row.state, flags: FLAGS.filter(f => row[f]) }).toEqual(ts.get(row.id))
  })

  it('without the presence columns the SQL still runs; only an older close pause reads otherwise', async () => {
    const [sql, ts] = [await sqlRead(false), await tsRead()]
    const pinned = new Set(facts.ended.map(e => e.listing))
    for (const [id, value] of ts) if (!pinned.has(id)) expect(sql.get(id)).toEqual(value)
  })
})
