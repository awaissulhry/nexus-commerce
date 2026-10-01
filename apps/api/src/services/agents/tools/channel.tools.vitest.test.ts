/**
 * MCP.9 — the cross-channel read tools, run through the one door (call-tool.ts) against a real PostgreSQL with the
 * production schema, business-isolation policies and shared-stock doors (PGlite). No mocked query.
 *
 * Proven here: every page is walked with no listing twice and none missed; each filter narrows to exactly the seeded
 * listings it names; a pooled product shows the pool's stock, named as the pool's; eBay price and everything on Etsy
 * say "not checked" and never read as matching; a page that is not the last asks for a filter; a call that has checked
 * its budget of listings hands back a cursor to go on; and a cursor that was changed, or made for other filters,
 * another tool or another business, is refused.
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { MAX_RESULT_BYTES } from '../../../lib/pagination/cursor.js'
import { AMAZON_CONTENT_SOURCE } from '../../channel-drift/amazon-content-compare.js'
import { EBAY_CONTENT_SOURCE } from '../../channel-drift/ebay-content-compare.js'
import { READ_BACKS, SYNC_SCAN_BUDGET, coveredAspects, emptySyncSummary, readinessIssue } from './channel.tools.js'

const A = LEGACY_WORKSPACE_ID
const LENDER = 'ws_mcp9_lender'
const SCAN = 'ws_mcp9_scan'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-mcp9',
    label: 'MCP.9 test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
const everything = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])

type Row = Record<string, any>
interface Answer { ok: boolean; error?: string; data?: { items: Row[]; nextCursor: string | null; total?: number; more?: string; [key: string]: unknown } }

async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<Answer> {
  return (await callTool(who, tool, args)).visible as Answer
}

/** Every page of a list, following nextCursor. */
async function walk(tool: string, args: Record<string, unknown>, limit: number, who?: UserPrincipal) {
  const items: Row[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const answer: Answer = await call(tool, { ...args, limit, ...(cursor ? { cursor } : {}) }, who)
    expect(answer.ok, answer.error).toBe(true)
    expect(answer.data!.items.length).toBeLessThanOrEqual(limit)
    items.push(...answer.data!.items)
    cursor = answer.data!.nextCursor
    pages++
  } while (cursor && pages < 60)
  return { items, pages }
}

const key = (item: Row) => `${item.sku} ${item.channel} ${item.market}`
const keys = (items: Row[]) => items.map(key)
const sorted = (list: string[]) => [...list].sort()

// ── The seed: listing specs in business A ─────────────────────────────────────────────────────────────

interface Spec {
  sku: string
  channel: string
  market: string
  status?: string
  external?: boolean
  quantity?: number | null
  follow?: boolean
  paused?: boolean
  fulfillment?: 'FBA' | 'FBM'
  price?: string
  lastSync?: { status: string; error?: string }
  validation?: string[]
  issues?: Array<{ severity: string; code: string; resolved?: boolean }>
  suppressions?: Array<{ severity: string; text: string; resolved?: boolean }>
  drift?: { count: number; fields: Array<{ field: string; ours: unknown; theirs: unknown; source: string }>; sources: string[] }
}

const SPECS: Spec[] = [
  { sku: 'MCP9-P01', channel: 'EBAY', market: 'IT', quantity: 5, issues: [{ severity: 'ERROR', code: 'C-100' }],
    drift: { count: 1, fields: [{ field: 'quantity', ours: 5, theirs: 4, source: 'ebay-trading-getitem' }], sources: ['ebay-trading-getitem'] } },
  { sku: 'MCP9-P01', channel: 'SHOPIFY', market: 'GLOBAL', quantity: 5,
    drift: { count: 0, fields: [], sources: ['shopify-inventory-level'] } },
  { sku: 'MCP9-P02', channel: 'EBAY', market: 'IT', quantity: 2,
    issues: [{ severity: 'WARNING', code: 'C-200' }, { severity: 'ERROR', code: 'C-201', resolved: true }] },
  { sku: 'MCP9-P02', channel: 'AMAZON', market: 'DE', quantity: 0, fulfillment: 'FBA', price: '30.00', validation: ['Bullet point too long'],
    drift: { count: 1, fields: [{ field: 'price', ours: 30, theirs: 28, source: 'amazon-merchant-listings-report' }], sources: ['amazon-merchant-listings-report'] } },
  { sku: 'MCP9-P03', channel: 'AMAZON', market: 'IT', status: 'SUPPRESSED', quantity: 4, follow: false,
    suppressions: [{ severity: 'ERROR', text: 'Missing safety information' }, { severity: 'ERROR', text: 'Old problem', resolved: true }] },
  { sku: 'MCP9-P03', channel: 'ETSY', market: 'GLOBAL', quantity: 1, follow: false, lastSync: { status: 'FAILED', error: 'Etsy refused the update' } },
  { sku: 'MCP9-P04', channel: 'EBAY', market: 'IT', quantity: 2, follow: false },
  { sku: 'MCP9-P04', channel: 'EBAY', market: 'DE', quantity: 2, follow: false },
  { sku: 'MCP9-P05', channel: 'EBAY', market: 'IT', quantity: 2, follow: false },
  { sku: 'MCP9-P06', channel: 'SHOPIFY', market: 'GLOBAL', quantity: 1, paused: true, issues: [{ severity: 'INFO', code: 'C-600' }] },
  { sku: 'MCP9-P08', channel: 'SHOPIFY', market: 'GLOBAL', quantity: 2, follow: false, lastSync: { status: 'FAILED', error: 'Shopify refused the update' },
    drift: { count: 0, fields: [], sources: ['shopify-inventory-level'] } },
  { sku: 'MCP9-P07', channel: 'WOOCOMMERCE', market: 'GLOBAL', status: 'DRAFT', external: false,
    issues: [{ severity: 'ERROR', code: 'C-700' }], lastSync: { status: 'FAILED', error: 'Publish refused' } },
  { sku: 'MCP9-P10', channel: 'EBAY', market: 'IT', issues: [{ severity: 'ERROR', code: 'C-110' }] },
  { sku: 'MCP9-P11', channel: 'EBAY', market: 'IT', issues: [{ severity: 'ERROR', code: 'C-111' }] },
  { sku: 'MCP9-P12', channel: 'EBAY', market: 'IT', issues: [{ severity: 'ERROR', code: 'C-112' }] },
  { sku: 'MCP9-POOL', channel: 'EBAY', market: 'IT', quantity: 3 },
]
/** Own warehouse stock in A: [quantity, reserved]. */
const STOCK: Record<string, [number, number]> = { 'MCP9-P01': [5, 0], 'MCP9-P02': [7, 2], 'MCP9-P06': [8, 0] }
/** Readiness rows in A: [sku, channel, market, state]. Only P04 on eBay IT and P10 (warn) are a listing's own. */
const READINESS: Array<[string, string, string, string]> = [
  ['MCP9-P04', 'EBAY', 'IT', 'blocked'],
  ['MCP9-P04', 'EBAY', 'DE', 'ready'],
  ['MCP9-P05', 'AMAZON', 'FR', 'blocked'],
  ['MCP9-P10', 'EBAY', 'IT', 'warn'],
]

const k = (sku: string, channel: string, market: string) => `${sku} ${channel} ${market}`
const ISSUES_ALL = [
  k('MCP9-P01', 'EBAY', 'IT'), k('MCP9-P02', 'EBAY', 'IT'), k('MCP9-P02', 'AMAZON', 'DE'), k('MCP9-P03', 'AMAZON', 'IT'),
  k('MCP9-P03', 'ETSY', 'GLOBAL'), k('MCP9-P04', 'EBAY', 'IT'), k('MCP9-P06', 'SHOPIFY', 'GLOBAL'),
  k('MCP9-P07', 'WOOCOMMERCE', 'GLOBAL'), k('MCP9-P08', 'SHOPIFY', 'GLOBAL'), k('MCP9-P10', 'EBAY', 'IT'), k('MCP9-P11', 'EBAY', 'IT'),
  k('MCP9-P12', 'EBAY', 'IT'),
]
const ISSUES_ERROR = [
  k('MCP9-P01', 'EBAY', 'IT'), k('MCP9-P03', 'AMAZON', 'IT'), k('MCP9-P03', 'ETSY', 'GLOBAL'), k('MCP9-P04', 'EBAY', 'IT'),
  k('MCP9-P07', 'WOOCOMMERCE', 'GLOBAL'), k('MCP9-P08', 'SHOPIFY', 'GLOBAL'), k('MCP9-P10', 'EBAY', 'IT'), k('MCP9-P11', 'EBAY', 'IT'),
  k('MCP9-P12', 'EBAY', 'IT'),
]
const OUT_OF_SYNC: Record<string, string[]> = {
  [k('MCP9-P01', 'EBAY', 'IT')]: ['channel-differs'],
  [k('MCP9-P02', 'EBAY', 'IT')]: ['quantity-behind'],
  [k('MCP9-P02', 'AMAZON', 'DE')]: ['channel-differs'],
  [k('MCP9-P03', 'ETSY', 'GLOBAL')]: ['push-failed'],
  [k('MCP9-P08', 'SHOPIFY', 'GLOBAL')]: ['push-failed'],
  [k('MCP9-POOL', 'EBAY', 'IT')]: ['quantity-behind'],
}

const productIds: Record<string, string> = {}

async function seedA() {
  await inside(A, async () => {
    const db = database.client
    const location = await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'A-MAIN', name: 'A main' } })
    for (const sku of [...new Set(SPECS.map((s) => s.sku))]) {
      const product = await db.product.create({ data: { sku, name: `${sku} jacket`, basePrice: '25.00' } })
      productIds[sku] = product.id
      const stock = STOCK[sku]
      if (stock) {
        await db.stockLevel.create({ data: { locationId: location.id, productId: product.id, quantity: stock[0], reserved: stock[1], available: stock[0] - stock[1] } })
      }
    }
    const now = new Date().toISOString()
    for (const s of SPECS) {
      const listing = await db.channelListing.create({
        data: {
          productId: productIds[s.sku],
          channel: s.channel,
          marketplace: s.market,
          region: s.market,
          channelMarket: `${s.channel}_${s.market}`,
          listingStatus: s.status ?? 'ACTIVE',
          externalListingId: s.external === false ? null : `EXT-${s.sku}-${s.channel}-${s.market}`,
          quantity: s.quantity === undefined ? null : s.quantity,
          followMasterQuantity: s.follow ?? true,
          syncPaused: s.paused ?? false,
          fulfillmentMethod: s.fulfillment ?? null,
          price: s.price ?? '25.00',
          lastSyncStatus: s.lastSync?.status ?? null,
          lastSyncError: s.lastSync?.error ?? null,
          validationErrors: s.validation ?? [],
        },
      })
      for (const issue of s.issues ?? []) {
        await db.listingIssue.create({
          data: {
            listingId: listing.id, code: issue.code, severity: issue.severity, message: `${issue.code} needs attention`,
            attributeNames: ['brand'], categories: [], fingerprint: `${issue.code}::brand`, resolvedAt: issue.resolved ? new Date() : null,
          },
        })
      }
      for (const suppression of s.suppressions ?? []) {
        await db.amazonSuppression.create({
          data: { listingId: listing.id, reasonText: suppression.text, severity: suppression.severity, resolvedAt: suppression.resolved ? new Date() : null },
        })
      }
      if (s.drift) {
        await db.channelDrift.create({
          data: {
            channelListingId: listing.id, channel: s.channel, marketplace: s.market, driftCount: s.drift.count,
            driftedFields: s.drift.fields.map((f) => ({ ...f, checkedAt: now })) as never,
            lastCheckedAt: new Date(now),
            checkedBySource: Object.fromEntries(s.drift.sources.map((source) => [source, { at: now, outcome: 'compared', differing: s.drift!.count }])) as never,
          },
        })
      }
    }
    for (const [sku, channel, market, state] of READINESS) {
      await db.readinessIndex.create({
        data: {
          productId: productIds[sku], coordinateKey: JSON.stringify([channel, market, null, null]), channel, market,
          accountId: null, aliasId: null, language: 'it', label: `${channel} · ${market}`, pct: state === 'ready' ? 100 : 40,
          // MCP.12 — as the readiness index writes a row today: the one empty required field is flagged requiredEmpty.
          state, requiredFilled: state === 'ready' ? 5 : state === 'blocked' ? 4 : 5, requiredTotal: 5,
          missing: state === 'ready' ? [] : state === 'blocked'
            ? [{ field: 'brand', label: 'Brand', reason: 'Required value is empty', requiredEmpty: true }]
            : [{ field: 'colour', label: 'Colour', reason: 'it content is missing; showing en fallback.', kind: 'language-fallback' }],
          computedAt: new Date(),
        },
      })
    }
  })
}

/**
 * The lender's pool, written as the superuser with triggers and foreign keys off (a real offer and acceptance are
 * stock-pool-rules' subject): the lender lends L-MAIN, holding 11 of its jacket with 2 reserved; A's MCP9-POOL sells
 * from it. A has no stock of its own for that product.
 */
async function seedPool() {
  const lenderLocation = randomUUID()
  const sourceProduct = randomUUID()
  const catalogLink = randomUUID()
  const grant = randomUUID()
  await database.db.transaction(async (tx) => {
    await tx.query(`SET LOCAL session_replication_role = replica`)
    await tx.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Lender business', 'active', 'mcp9', $1, CURRENT_TIMESTAMP)`, [LENDER])
    await tx.query(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "isActive", "updatedAt") VALUES ($1, $2, 'WAREHOUSE', 'L-MAIN', 'L-MAIN', true, CURRENT_TIMESTAMP)`, [lenderLocation, LENDER])
    await tx.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1, $2, 'L-SRC', 'Lent jacket', 10, CURRENT_TIMESTAMP)`, [sourceProduct, LENDER])
    await tx.query(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1, $2, $3, $4, 11, 2, 9, CURRENT_TIMESTAMP)`, [randomUUID(), LENDER, lenderLocation, sourceProduct])
    await tx.query(`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", status, "updatedAt") VALUES ($1, 'share-mcp9', $2, $3, $4, $5, 'created', 1, 'active', CURRENT_TIMESTAMP)`, [catalogLink, LENDER, sourceProduct, A, productIds['MCP9-POOL']])
    await tx.query(`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", status, version, "createdByUserId", "updatedAt") VALUES ($1, $2, $3, $4, 'active', 1, 'mcp9', CURRENT_TIMESTAMP)`, [grant, LENDER, A, [lenderLocation]])
    await tx.query(`INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", "catalogLinkId", "productId", "sourceProductId", status, "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP)`, [randomUUID(), A, grant, catalogLink, productIds['MCP9-POOL'], sourceProduct])
  })
}

/** Validation messages longer than a listing-issues text may be: 12 of them on each of the first 30 SCAN listings. */
const LONG_ERRORS = Array.from({ length: 12 }, (_, i) => `Rule ${i}: ${'too long '.repeat(40)}`)

/**
 * Business SCAN: more in-sync listings than one call checks, then one whose last push failed. The first 30 carry long
 * validation errors, so a page of their issues is larger than the size limit.
 */
async function seedScan() {
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, 'Scan business', 'active', 'mcp9', $1, CURRENT_TIMESTAMP)`, [SCAN])
  await inside(SCAN, async () => {
    const db = database.client
    const product = await db.product.create({ data: { sku: 'SCAN-1', name: 'Scan jacket', basePrice: '9.00' } })
    const market = (i: number) => `M${String(i).padStart(4, '0')}`
    const pinned = (m: string) => ({
      productId: product.id, channel: 'EBAY', marketplace: m, region: m, channelMarket: `EBAY_${m}`, listingStatus: 'ACTIVE',
      externalListingId: `EXT-SCAN-${m}`, quantity: 1, followMasterQuantity: false,
    })
    await db.channelListing.createMany({
      data: Array.from({ length: SYNC_SCAN_BUDGET + 5 }, (_, i) => ({ ...pinned(market(i)), validationErrors: i < 30 ? LONG_ERRORS : [] })),
    })
    await db.channelListing.create({ data: { ...pinned('Z999'), lastSyncStatus: 'FAILED', lastSyncError: 'eBay said no' } })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  await seedA()
  await seedPool()
  await seedScan()
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

// ── listing-issues ───────────────────────────────────────────────────────────────────────────────────

describe('MCP.9 — listing-issues', () => {
  it('walks every page with no listing twice and none missed, in one order', async () => {
    const whole = await call('listing-issues', { limit: 100 })
    expect(whole.data!.total).toBe(ISSUES_ALL.length)
    expect(whole.data!.nextCursor).toBeNull()
    expect(sorted(keys(whole.data!.items))).toEqual(sorted(ISSUES_ALL))
    for (const limit of [1, 3, 4]) {
      const { items, pages } = await walk('listing-issues', {}, limit)
      expect(keys(items)).toEqual(keys(whole.data!.items))
      expect(pages).toBe(Math.ceil(ISSUES_ALL.length / limit))
    }
  })

  it('filters by channel, market, SKU prefix, product and severity', async () => {
    const eBay = (await walk('listing-issues', { channel: 'ebay' }, 2)).items
    expect(sorted(keys(eBay))).toEqual(sorted(ISSUES_ALL.filter((x) => x.includes(' EBAY '))))
    const de = (await walk('listing-issues', { market: 'de' }, 5)).items
    expect(keys(de)).toEqual([k('MCP9-P02', 'AMAZON', 'DE')])
    const prefix = (await walk('listing-issues', { sku: 'mcp9-p1' }, 2)).items
    expect(sorted(keys(prefix))).toEqual(sorted([k('MCP9-P10', 'EBAY', 'IT'), k('MCP9-P11', 'EBAY', 'IT'), k('MCP9-P12', 'EBAY', 'IT')]))
    // A SKU's `_` and `%` are characters, not wildcards.
    expect((await call('listing-issues', { sku: 'MCP9_P' })).data!.items).toEqual([])
    expect((await call('listing-issues', { sku: '%' })).data!.total).toBe(0)
    const one = (await walk('listing-issues', { productId: productIds['MCP9-P03'] }, 5)).items
    expect(sorted(keys(one))).toEqual(sorted([k('MCP9-P03', 'AMAZON', 'IT'), k('MCP9-P03', 'ETSY', 'GLOBAL')]))

    const errors = (await walk('listing-issues', { severity: 'ERROR' }, 3)).items
    expect(sorted(keys(errors))).toEqual(sorted(ISSUES_ERROR))
    expect(errors.flatMap((item) => item.issues.map((issue: Row) => issue.severity))).toSatisfy((all: string[]) => all.every((s) => s === 'error'))
    const warnings = (await walk('listing-issues', { severity: 'warning' }, 3)).items
    expect(sorted(keys(warnings))).toEqual(sorted([k('MCP9-P02', 'EBAY', 'IT'), k('MCP9-P02', 'AMAZON', 'DE'), k('MCP9-P10', 'EBAY', 'IT')]))
    const info = (await walk('listing-issues', { severity: 'info' }, 3)).items
    expect(keys(info)).toEqual([k('MCP9-P06', 'SHOPIFY', 'GLOBAL')])
  })

  it('says what is wrong, from each source, and leaves resolved issues out', async () => {
    const items = (await call('listing-issues', { limit: 100 })).data!.items
    const at = (sku: string, channel: string, market: string) => items.find((item) => key(item) === k(sku, channel, market))!
    expect(at('MCP9-P01', 'EBAY', 'IT').issues).toEqual([expect.objectContaining({ from: 'channel', severity: 'error', code: 'C-100', attributes: ['brand'] })])
    expect(at('MCP9-P02', 'EBAY', 'IT').issues.map((i: Row) => i.code)).toEqual(['C-200'])
    expect(at('MCP9-P02', 'AMAZON', 'DE').issues).toEqual([{ from: 'validation', severity: 'warning', message: 'Bullet point too long' }])
    expect(at('MCP9-P03', 'AMAZON', 'IT').issues).toEqual([expect.objectContaining({ from: 'suppression', severity: 'error', message: 'Missing safety information' })])
    expect(at('MCP9-P03', 'ETSY', 'GLOBAL').issues).toEqual([expect.objectContaining({ from: 'sync', severity: 'error', message: 'Etsy refused the update' })])
    expect(at('MCP9-P04', 'EBAY', 'IT').issues).toEqual([{
      from: 'readiness', severity: 'error', message: 'Blocked for EBAY · IT (it): 4 of 5 required values filled; 1 required value is empty.', missing: ['Brand'],
    }])
    expect(at('MCP9-P10', 'EBAY', 'IT').issues.find((i: Row) => i.from === 'readiness')).toEqual({
      from: 'readiness', severity: 'warning', message: 'Warnings for EBAY · IT (it): 5 of 5 required values filled.', untranslated: ['Colour'],
    })
    // MCP.12 — draft and linked, never "published": P07 is a Woo draft with no channel id, P01 an eBay listing with one.
    expect(at('MCP9-P07', 'WOOCOMMERCE', 'GLOBAL')).toMatchObject({ status: 'DRAFT', draft: true, linked: false })
    expect(at('MCP9-P01', 'EBAY', 'IT')).toMatchObject({ status: 'ACTIVE', draft: false, linked: true })
    for (const item of items) expect(item).not.toHaveProperty('published')
    // Errors first, whatever order the sources were read in.
    expect(at('MCP9-P07', 'WOOCOMMERCE', 'GLOBAL').issues.map((i: Row) => i.from).sort()).toEqual(['channel', 'sync'])
    expect(at('MCP9-P10', 'EBAY', 'IT').issues.map((i: Row) => i.severity)).toEqual(['error', 'warning'])
  })
})

describe('MCP.12 — a readiness issue lists what its count counts', () => {
  // The shape of a real Amazon DE row (development data, 2026-09-30): 7 of 10 filled, 3 required fields empty and
  // flagged, then GPSR findings and optional fields shown in another language. The old tool listed the first eight of
  // all of them as "missing" beside "7 of 10 required values filled".
  const fallback = (field: string, label: string) => ({ field, label, kind: 'language-fallback', reason: 'de content is missing; showing it fallback.' })
  const row = {
    state: 'blocked', label: 'Amazon · DE', language: 'de', requiredFilled: 7, requiredTotal: 10,
    missing: [
      { ...fallback('description', 'Product Description'), requiredEmpty: true },
      { ...fallback('fabric_type', 'Fabric Type'), requiredEmpty: true },
      { ...fallback('bulletPoints_1', 'Bullet 1'), requiredEmpty: true },
      { field: 'gpsr_manufacturer_reference', label: 'Manufacturer’s Email or Electronic Address', reason: 'GPSR: registered manufacturer email missing' },
      { field: 'gpsr_safety_attestation', label: 'Safety Attestation', reason: 'GPSR: no safety documentation' },
      ...Array.from({ length: 11 }, (_, i) => fallback(`extra_${i}`, `Extra ${i + 1}`)),
    ],
  }

  it('names exactly the empty required fields under missing, and the rest apart, each cut list counted', () => {
    const issue = readinessIssue(row)
    expect(issue.message).toBe('Blocked for Amazon · DE (de): 7 of 10 required values filled; 3 required values are empty.')
    expect(issue.missing).toEqual(['Product Description', 'Fabric Type', 'Bullet 1'])
    expect(issue.missing).toHaveLength(row.requiredTotal - row.requiredFilled)
    expect(issue).not.toHaveProperty('moreMissing')
    expect(issue.otherIssues).toEqual([
      'Manufacturer’s Email or Electronic Address: GPSR: registered manufacturer email missing',
      'Safety Attestation: GPSR: no safety documentation',
    ])
    expect(issue.untranslated).toEqual(Array.from({ length: 8 }, (_, i) => `Extra ${i + 1}`))
    expect(issue.moreUntranslated).toBe(3)
  })

  it('a long required list is cut to eight and says how many more', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ field: `f${i}`, label: `Field ${i + 1}`, requiredEmpty: true }))
    const issue = readinessIssue({ ...row, requiredFilled: 1, requiredTotal: 12, missing: many })
    expect(issue.missing).toHaveLength(8)
    expect(issue.moreMissing).toBe(3)
    expect(issue.message).toBe('Blocked for Amazon · DE (de): 1 of 12 required values filled; 11 required values are empty.')
  })

  it('a row written before requiredEmpty existed says which ones are not recorded, and never guesses', () => {
    const legacy = readinessIssue({ ...row, missing: [{ field: 'brand', label: 'Brand', reason: 'Required value is empty' }] })
    expect(legacy.message).toBe('Blocked for Amazon · DE (de): 7 of 10 required values filled; 3 required values are empty. Which ones are empty is not recorded on this row yet.')
    expect(legacy).not.toHaveProperty('missing')
    expect(legacy.otherIssues).toEqual(['Brand: Required value is empty'])
    const partly = readinessIssue({ ...row, missing: [{ field: 'brand', label: 'Brand', requiredEmpty: true }] })
    expect(partly.message).toContain('3 required values are empty. 2 of them are not named: this row does not record which.')
    expect(partly.missing).toEqual(['Brand'])
  })
})

describe('MCP.12 — an empty out-of-sync page says what it checked', () => {
  it('a listing no read-back ever looked at is not passed off as in sync', async () => {
    const answer = await call('out-of-sync-listings', { sku: 'MCP9-P05' })
    expect(answer.data!.items).toEqual([])
    expect(answer.data!.summary).toBe(
      'Checked 1 live listing: none is out of sync by what Nexus has recorded. Not one of them has ever been read back from its channel, so no channel value was compared: this proves nothing about what the channels show.',
    )
  })

  it('a listing that was read back says so', async () => {
    const answer = await call('out-of-sync-listings', { sku: 'MCP9-P01', channel: 'SHOPIFY' })
    expect(answer.data!.items).toEqual([])
    expect(answer.data!.summary).toMatch(/^Checked 1 live listing: none is out of sync by what Nexus has recorded\. Every one of them has been read back/)
  })

  it('a page with items carries no summary; nothing checked, part read and a reason filter are said', async () => {
    expect((await call('out-of-sync-listings', { limit: 100 })).data).not.toHaveProperty('summary')
    expect((await call('out-of-sync-listings', { sku: 'NO-SUCH-SKU' })).data!.summary).toBe('No live listing matches these filters, so none was checked.')
    expect(emptySyncSummary(4, 1, false)).toBe(
      'Checked 4 live listings: none is out of sync by what Nexus has recorded. 1 of them has never been read back from its channel, so no channel value was compared for it.',
    )
    expect(emptySyncSummary(4, 3, true, 'push-failed')).toBe(
      'Checked 4 live listings from where this call started: none is out of sync for push-failed by what Nexus has recorded. 3 of them have never been read back from their channel, so no channel value was compared for them.',
    )
  })
})

// ── channel-price-stock ──────────────────────────────────────────────────────────────────────────────

describe('MCP.9 — channel-price-stock', () => {
  it('walks every listing once, and filters by channel, SKU and product', async () => {
    const whole = await call('channel-price-stock', { limit: 100 })
    expect(whole.data!.total).toBe(SPECS.length)
    expect(sorted(keys(whole.data!.items))).toEqual(sorted(SPECS.map((s) => k(s.sku, s.channel, s.market))))
    const { items, pages } = await walk('channel-price-stock', {}, 4)
    expect(keys(items)).toEqual(keys(whole.data!.items))
    expect(pages).toBe(Math.ceil(SPECS.length / 4))
    expect(sorted(keys((await walk('channel-price-stock', { channel: 'AMAZON' }, 1)).items)))
      .toEqual(sorted([k('MCP9-P02', 'AMAZON', 'DE'), k('MCP9-P03', 'AMAZON', 'IT')]))
    expect(keys((await walk('channel-price-stock', { sku: 'MCP9-POOL' }, 5)).items)).toEqual([k('MCP9-POOL', 'EBAY', 'IT')])
    expect((await call('channel-price-stock', { sku: 'MCP9_P' })).data!.total).toBe(0)
    expect((await call('out-of-sync-listings', { sku: '%' })).data!.items).toEqual([])
    expect(sorted(keys((await walk('channel-price-stock', { productId: productIds['MCP9-P01'] }, 5)).items)))
      .toEqual(sorted([k('MCP9-P01', 'EBAY', 'IT'), k('MCP9-P01', 'SHOPIFY', 'GLOBAL')]))
  })

  it('a pooled product shows the pool’s stock, named as the pool’s, and follows it', async () => {
    const [pooled] = (await call('channel-price-stock', { sku: 'MCP9-POOL' })).data!.items
    expect(pooled.stock).toMatchObject({ sellsFrom: 'pool', lender: 'Lender business', onHand: 11, reserved: 2, available: 9 })
    expect(pooled.stock.note).toMatch(/^Pooled: sells from Lender business's shared stock/)
    expect(pooled.quantity).toEqual({ listed: 3, intended: 9, mode: 'follow', followsStock: true, buffer: 0 })
  })

  it('an own-stock product shows its warehouse, and price and quantity come with their controls', async () => {
    const items = (await call('channel-price-stock', { sku: 'MCP9-P02' })).data!.items
    const eBay = items.find((item) => item.channel === 'EBAY')!
    expect(eBay.stock).toEqual({ sellsFrom: 'own', onHand: 7, reserved: 2, available: 5, fbaOnHand: 0 })
    expect(eBay.quantity).toMatchObject({ listed: 2, intended: 5, mode: 'follow' })
    const amazon = items.find((item) => item.channel === 'AMAZON')!
    expect(amazon.price).toEqual({ listed: 30, sale: null, master: 25, followsMaster: true, override: null, rule: 'FIXED', currency: null, masterCurrency: 'EUR' })
    expect(amazon.quantity).toMatchObject({ intended: null, mode: 'fba' })
    const paused = (await call('channel-price-stock', { sku: 'MCP9-P06' })).data!.items[0]
    expect(paused.quantity).toMatchObject({ listed: 1, intended: null, mode: 'paused' })
  })

  it('needs listings, pricing and inventory rights', async () => {
    const noPricing = principal(A, [FEATURES.aiRun, FEATURES.listingsView, FEATURES.inventoryView])
    await expect(callTool(noPricing, 'channel-price-stock', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(callTool(noPricing, 'listing-issues', {})).resolves.toBeTruthy()
  })
})

// ── out-of-sync-listings ─────────────────────────────────────────────────────────────────────────────

describe('MCP.9 — out-of-sync-listings', () => {
  it('finds exactly the listings out of sync, with why, over every page', async () => {
    const whole = await call('out-of-sync-listings', { limit: 100 })
    expect(whole.data!.nextCursor).toBeNull()
    expect(Object.fromEntries(whole.data!.items.map((item) => [key(item), item.reasons]))).toEqual(OUT_OF_SYNC)
    for (const limit of [1, 2]) {
      const { items } = await walk('out-of-sync-listings', {}, limit)
      expect(keys(items)).toEqual(keys(whole.data!.items))
    }
  })

  it('filters by reason, channel and market', async () => {
    const reasons = async (reason: string) => sorted(keys((await walk('out-of-sync-listings', { reason }, 1)).items))
    expect(await reasons('channel-differs')).toEqual(sorted([k('MCP9-P01', 'EBAY', 'IT'), k('MCP9-P02', 'AMAZON', 'DE')]))
    expect(await reasons('push-failed')).toEqual(sorted([k('MCP9-P03', 'ETSY', 'GLOBAL'), k('MCP9-P08', 'SHOPIFY', 'GLOBAL')]))
    expect(await reasons('quantity-behind')).toEqual(sorted([k('MCP9-P02', 'EBAY', 'IT'), k('MCP9-POOL', 'EBAY', 'IT')]))
    expect(sorted(keys((await walk('out-of-sync-listings', { channel: 'EBAY', market: 'IT' }, 2)).items)))
      .toEqual(sorted([k('MCP9-P01', 'EBAY', 'IT'), k('MCP9-P02', 'EBAY', 'IT'), k('MCP9-POOL', 'EBAY', 'IT')]))
  })

  it('the pooled product is behind the pool, not its own empty shelf', async () => {
    const [pooled] = (await call('out-of-sync-listings', { sku: 'MCP9-POOL' })).data!.items
    expect(pooled.quantity).toEqual({ listed: 3, intended: 9, mode: 'follow' })
  })

  it('eBay price and everything on Etsy say "not checked", never that they match', async () => {
    const answer = await call('out-of-sync-listings', { limit: 100 })
    const at = (sku: string, channel: string, market: string) => answer.data!.items.find((item) => key(item) === k(sku, channel, market))!
    const eBay = at('MCP9-P01', 'EBAY', 'IT')
    expect(eBay.differs).toEqual([expect.objectContaining({ field: 'quantity', aspect: 'quantity', nexus: 5, channel: 4 })])
    expect(eBay.readBack).toEqual([expect.objectContaining({ by: 'eBay GetItem', covers: ['quantity'], outcome: 'compared' })])
    expect(eBay.notChecked.price).toMatch(/^not checked: eBay prices are compared only into a product-level health log/)
    expect(eBay.notChecked.content).toMatch(/^not checked yet/)
    expect(eBay.notChecked.quantity).toBeUndefined()

    const etsy = at('MCP9-P03', 'ETSY', 'GLOBAL')
    expect(Object.keys(etsy.notChecked).sort()).toEqual(['content', 'price', 'quantity'])
    for (const reason of Object.values(etsy.notChecked)) expect(reason).toMatch(/^not checked: Etsy (quantity|price|content) is not read back into Nexus$/)
    expect(etsy.readBack).toEqual([])
    expect(etsy.push).toMatchObject({ status: 'FAILED', error: 'Etsy refused the update' })

    // Shopify's read-back looked at this listing, but its quantity arm skips a pinned listing: price checked, quantity not.
    const pinned = at('MCP9-P08', 'SHOPIFY', 'GLOBAL')
    expect(pinned.readBack).toEqual([expect.objectContaining({ by: 'Shopify inventory level', outcome: 'compared' })])
    expect(pinned.notChecked).toEqual({
      quantity: 'not checked: Shopify inventory level skips a pinned quantity',
      content: 'not checked: Shopify content is not read back into Nexus',
    })

    const fba = at('MCP9-P02', 'AMAZON', 'DE')
    expect(fba.notChecked.quantity).toMatch(/Amazon holds FBA stock/)
    expect(fba.differs).toEqual([expect.objectContaining({ field: 'price', aspect: 'price', nexus: 30, channel: 28 })])

    expect(answer.data!.neverChecked).toMatchObject({
      ETSY: { quantity: expect.stringMatching(/^not checked/), price: expect.stringMatching(/^not checked/), content: expect.stringMatching(/^not checked/) },
      EBAY: { price: expect.stringMatching(/^not checked/) },
      SHOPIFY: { content: expect.stringMatching(/^not checked/) },
    })
    expect(answer.data!.neverChecked).not.toHaveProperty('AMAZON')
    expect(JSON.stringify(answer)).not.toMatch(/in sync|in-sync|matches/i)
  })

  it('a call that checked its budget of listings hands back a cursor to go on', async () => {
    const who = everything(SCAN)
    const first = await call('out-of-sync-listings', { limit: 5 }, who)
    expect(first.data!.items).toEqual([])
    expect(first.data!.nextCursor).toBeTruthy()
    expect(first.data!.more).toBe(`Checked ${SYNC_SCAN_BUDGET} listings from where this call started; more remain. Call again with cursor set to nextCursor to keep looking.`)
    const second = await call('out-of-sync-listings', { limit: 5, cursor: first.data!.nextCursor }, who)
    expect(second.data!.items.map((item) => [item.market, item.reasons])).toEqual([['Z999', ['push-failed']]])
    expect(second.data!.nextCursor).toBeNull()
    expect(second.data!).not.toHaveProperty('more')
  })

  it('names every read-back that writes ChannelDrift, so no covered aspect is reported "not read back"', () => {
    const SRC = fileURLToPath(new URL('../../../', import.meta.url))
    const constants: Record<string, string> = { AMAZON_CONTENT_SOURCE, EBAY_CONTENT_SOURCE }
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [])
    const written = new Set<string>()
    let calls = 0
    for (const file of files(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/recordChannelReadback\(\{[^}]*?\bsource:\s*(?:'([^']+)'|([A-Z_]+))/g)) {
        calls++
        written.add(match[1] ?? constants[match[2]] ?? `unresolved ${match[2]}`)
      }
    }
    expect(calls).toBeGreaterThanOrEqual(5)
    expect([...written].sort()).toEqual(Object.keys(READ_BACKS).sort())
    expect(coveredAspects('ETSY')).toEqual([])
    expect(coveredAspects('EBAY')).toEqual(['quantity', 'content'])
  })
})

// ── Every list: the size cap and the cursor ──────────────────────────────────────────────────────────

describe('MCP.9 — a page that is not the last asks for a filter; a bad cursor is refused', () => {
  it('each list says how many match and how to narrow, and the last page does not', async () => {
    const issues = await call('listing-issues', { limit: 2 })
    expect(issues.data!.more).toBe(`${ISSUES_ALL.length} listings match; this page has 2. To narrow, add channel, market, sku or severity; to go on, call again with cursor set to nextCursor.`)
    const prices = await call('channel-price-stock', { limit: 2 })
    expect(prices.data!.more).toMatch(new RegExp(`^${SPECS.length} listings match; this page has 2\\. To narrow, add channel, market or sku`))
    const sync = await call('out-of-sync-listings', { limit: 2 })
    expect(sync.data!.more).toMatch(/^More listings may match; this page has 2\. To narrow, add channel, market, sku or reason/)
    expect(await call('listing-issues', { limit: 100 })).not.toHaveProperty('data.more')
  })

  it('a page above the size limit is cut and says so, and walking it still returns every listing once', async () => {
    const who = everything(SCAN)
    const first = await call('listing-issues', { limit: 100 }, who)
    expect(first.data!.total).toBe(31)
    const shown = first.data!.items.length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(31)
    expect(Buffer.byteLength(JSON.stringify(first.data!.items))).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(first.data!.more).toBe(`31 listings match; this page has ${shown} (cut from 31 to stay within the size limit). To narrow, add channel, market, sku or severity; to go on, call again with cursor set to nextCursor.`)
    // Twelve issues, ten shown, each text cut to the text limit.
    expect(first.data!.items[0].issues).toHaveLength(10)
    expect(first.data!.items[0].moreIssues).toBe(2)
    expect(first.data!.items[0].issues[0].message).toHaveLength(300)
    expect(first.data!.items[0].issues[0].message.endsWith('…')).toBe(true)

    const { items, pages } = await walk('listing-issues', {}, 100, who)
    expect(new Set(keys(items)).size).toBe(31)
    expect(items).toHaveLength(31)
    expect(pages).toBeGreaterThan(1)
  })

  it('refuses a page size above 100 before the tool runs', async () => {
    await expect(callTool(everything(), 'listing-issues', { limit: 101 })).rejects.toBeInstanceOf(ToolAccessError)
  })

  it('refuses a changed cursor, and one made for other filters, another tool or another business', async () => {
    const cursor = (await call('listing-issues', { channel: 'EBAY', limit: 1 })).data!.nextCursor!
    const scanCursor = (await call('out-of-sync-listings', { limit: 5 }, everything(SCAN))).data!.nextCursor!
    const refusals = [
      await call('listing-issues', { channel: 'EBAY', cursor: 'not-a-cursor' }),
      await call('listing-issues', { channel: 'EBAY', cursor: cursor.slice(0, -3) + (cursor.endsWith('AAA') ? 'BBB' : 'AAA') }),
      await call('listing-issues', { channel: 'AMAZON', cursor }),
      await call('channel-price-stock', { channel: 'EBAY', cursor }),
      await call('out-of-sync-listings', { limit: 5, cursor: scanCursor }),
    ]
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false)
      expect(refusal.error).toMatch(/was called wrongly — cursor: this cursor is not valid for this list.*Call again without cursor/)
    }
    // The same cursor, with the filters it was made for, is fine.
    expect((await call('listing-issues', { channel: 'EBAY', cursor })).ok).toBe(true)
  })
})
