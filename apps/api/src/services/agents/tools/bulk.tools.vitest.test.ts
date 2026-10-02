/**
 * MCP.10 — the two bulk change tools, run only through the doors a person or Claude uses (callTool,
 * runOrQueueTool, decideApproval, and Claude's runToolForClaude), against a real PostgreSQL with the
 * production schema (PGlite). The product bulk writer, the master price service and the queue rows are real;
 * nothing Amazon-specific is stood in, and nothing is sent to any marketplace from here.
 *
 * Proven: a preview changes nothing we can count; 251 products, a missing permission and another business's
 * product are refused; an approved price change goes through the master price service and queues exactly the
 * price pushes the preview listed, held as long as the preview says; an approved attribute change is stored and
 * queues nothing at all; an approval is worked out again when it runs; over MCP both tools are only ever queued.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// As db.ts wraps it: inside a transaction, `prisma.x` is that transaction's client.
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})
// The writer's side work that this file does not test, stood in as the writer's own PGlite tests stand it in:
// no Redis, and the read cache and readiness rebuild left out.
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn(), refreshInTransaction: vi.fn() } }))
vi.mock('../../pim/readiness-index.service.js', async () => (await import('../../../test-support/readiness-module-mock.js')).readinessModuleMock(vi.fn()))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { getTool } from '../tool-registry.js'
import { runToolForClaude } from '../../mcp/mcp-tool-call.js'
import { checkStaleness } from '../../agent-fleet/approval-inbox.service.js'
import type { McpPrincipal } from '../../mcp/mcp-auth.js'
import { MASTER_PRICE_HOLD_MS, NEXUS_ONLY, REFUSED_NOT_IN_FAMILY, REFUSED_PER_LANGUAGE } from './bulk.tools.js'
import { executedMeaning } from './approval.tools.js'
import { clearSheetColumnCache } from '../../pim/sheet-columns.service.js'

const A = LEGACY_WORKSPACE_ID
const B = 'mcp10_bulk_bravo'
/**
 * Each test runs the real product writer two or three times and reads every row it could touch: about 0.6 s
 * alone, but past the 10 s default when the whole API suite shares the machine. The catalogue suites' 30 s.
 */
const DB_TEST_TIMEOUT = 30_000
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function person(permissions: string[], workspaceId = A): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-mcp10',
    label: 'Bulk tester',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'app',
  }
}
const PRICER = person(['ai.run', F.productsPriceEdit, F.productsBulkRun])
const EDITOR = person(['ai.run', F.productsEdit, F.productsBulkRun])
const PRICER_NO_BULK = person(['ai.run', F.productsPriceEdit, F.productsEdit])
const BULK_NO_EDIT = person(['ai.run', F.productsBulkRun, F.productsPriceEdit])
/** MCP.12 — follows an approval as Claude does (approval-status needs ai.view). */
const FOLLOWER = person(['ai.run', 'ai.view', F.productsPriceEdit, F.productsEdit, F.productsBulkRun])
const statusOf = async (approvalId: string) => ((await callTool(FOLLOWER, 'approval-status', { approvalId })).visible as any).data

const claude: McpPrincipal = {
  ...person(['ai.run', F.productsPriceEdit, F.productsEdit, F.productsBulkRun]),
  via: 'claude',
  workspace: business(A),
  oauthGrantId: 'grant-mcp10',
  business: { id: A, name: 'Alpha bulk business' },
}

const ids = { p1: '', p2: '', p3: '', p4: '', p5: '', b1: '' }
const listing = { amazonIt: '', ebayIt: '', amazonDe: '', ebayUk: '', amazonFr: '', p2AmazonIt: '' }

/** With business profiles on, as in production: another business's rows are then out of reach. */
async function profilesOn<T>(work: () => Promise<T>): Promise<T> {
  const before = process.env.NEXUS_WORKSPACES_ENABLED
  process.env.NEXUS_WORKSPACES_ENABLED = '1'
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = before
  }
}

/** Everything a change could touch, in both businesses: row counts, and the rows themselves. */
async function measure() {
  const one = (workspaceId: string) => inside(workspaceId, async () => {
    const db = database.client
    return {
      counts: {
        product: await db.product.count(),
        channelListing: await db.channelListing.count(),
        outboundSyncQueue: await db.outboundSyncQueue.count(),
        outboundApiCallLog: await db.outboundApiCallLog.count(),
        auditLog: await db.auditLog.count(),
        bulkOperation: await db.bulkOperation.count(),
        productEvent: await db.productEvent.count(),
        agentApproval: await db.agentApproval.count(),
        channelListingOverride: await db.channelListingOverride.count(),
      },
      products: await db.product.findMany({
        orderBy: { sku: 'asc' },
        select: { sku: true, basePrice: true, categoryAttributes: true, version: true, updatedAt: true, cascadedFields: true },
      }),
      listings: await db.channelListing.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, price: true, masterPrice: true, version: true, updatedAt: true, lastSyncStatus: true, overrideData: true },
      }),
    }
  })
  return JSON.parse(JSON.stringify({ A: await one(A), B: await one(B) }))
}

const basePrice = (id: string, workspaceId = A) =>
  inside(workspaceId, async () => Number((await database.client.product.findUniqueOrThrow({ where: { id } })).basePrice))
const attributes = (id: string, workspaceId = A) =>
  inside(workspaceId, async () => (await database.client.product.findUniqueOrThrow({ where: { id } })).categoryAttributes as Record<string, unknown>)
const queueRows = () =>
  inside(A, () => database.client.outboundSyncQueue.findMany({ orderBy: { createdAt: 'asc' } }))

async function preview(who: UserPrincipal, tool: string, args: Record<string, unknown>) {
  try {
    return (await callTool(who, tool, args)).visible
  } catch (error) {
    if (error instanceof ToolAccessError) return { refused: error }
    throw error
  }
}

/** Queue a change as a person in the app would, and hand back the approval. */
async function queue(who: UserPrincipal, tool: string, args: Record<string, unknown>) {
  const run = await inside(A, () => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
  return inside(A, () => runOrQueueTool(tool, args, who, run.id))
}

const approve = (approvalId: string, who: UserPrincipal) => inside(A, () => decideApproval(approvalId, 'approve', who))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_OAUTH_ISSUER', 'https://web.example.test')
  vi.stubEnv('NEXUS_AI_KILL_SWITCH', '')
  const db = database.client
  const owner = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
  await db.workspace.create({ data: { id: B, name: 'Bravo bulk business', createdByUserId: owner.id, creationKey: randomUUID() } })

  await inside(A, async () => {
    for (const [channel, code, currency] of [['AMAZON', 'IT', 'EUR'], ['AMAZON', 'DE', 'EUR'], ['AMAZON', 'FR', 'EUR'], ['EBAY', 'IT', 'EUR'], ['EBAY', 'UK', 'GBP']]) {
      await db.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'it', languages: ['it'], marketplaceId: `TEST_${channel}_${code}` } as never })
    }
    await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'bulk-amazon', isActive: true, externalAccountId: 'SELLER-TEST-A' } as never })
    await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'bulk-ebay', isActive: true, externalAccountId: 'EBAY-TEST-A' } as never })
    const group = await db.attributeGroup.create({ data: { code: 'mcp10', label: 'Specifications' } })
    const fit = await db.customAttribute.create({ data: { code: 'fit', label: 'Fit', groupId: group.id, type: 'select' } })
    const protection = await db.customAttribute.create({ data: { code: 'protection_level', label: 'Protection level', groupId: group.id, type: 'select', validation: { optionMode: 'strict' } } })
    for (const [attributeId, code] of [[fit.id, 'slim'], [fit.id, 'regular'], [protection.id, 'level_1'], [protection.id, 'level_2']]) {
      await db.attributeOption.create({ data: { attributeId, code, label: code } })
    }
    // MCP.12 — translatable text in the family: the writer keeps it per language, so this tool may not set it.
    const careNote = await db.customAttribute.create({ data: { code: 'care_note', label: 'Care note', groupId: group.id, type: 'text', localizable: true } })
    const jackets = await db.productFamily.create({ data: { code: 'mcp10-jackets', label: 'Jackets' } })
    for (const attributeId of [fit.id, protection.id, careNote.id]) await db.familyAttribute.create({ data: { familyId: jackets.id, attributeId, channels: [] } })

    ids.p1 = (await db.product.create({ data: { sku: 'BULK-A-1', name: 'Bulk jacket one', basePrice: '10.00', familyId: jackets.id, categoryAttributes: { lining_note: 'Mesh', fit: 'regular' } } })).id
    ids.p2 = (await db.product.create({ data: { sku: 'BULK-A-2', name: 'Bulk jacket two', basePrice: '20.00', familyId: jackets.id, categoryAttributes: { fit: 'regular' } } })).id
    ids.p3 = (await db.product.create({ data: { sku: 'BULK-A-3', name: 'Bulk jacket three', basePrice: '0.50', familyId: jackets.id } })).id
    ids.p4 = (await db.product.create({ data: { sku: 'BULK-A-4', name: 'Bulk jacket four', basePrice: '40.00', familyId: jackets.id, categoryAttributes: { fit: 'regular' } } })).id
    // MCP.12 — a key saved as null, as `waterproofRating` is on real products: the product holds no value for it.
    ids.p5 = (await db.product.create({ data: { sku: 'BULK-A-5', name: 'Bulk jacket five', basePrice: '50.00', familyId: jackets.id, categoryAttributes: { fit: 'regular', waterproofRating: null } } })).id

    const make = (productId: string, channel: string, marketplace: string, data: Record<string, unknown>) =>
      db.channelListing.create({ data: { productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, ...data } as never })
    // BULK-A-1: one listing for each thing the master price service can do with it.
    listing.amazonIt = (await make(ids.p1, 'AMAZON', 'IT', { price: '10.00', followMasterPrice: true, pricingRule: 'FIXED' })).id
    listing.ebayIt = (await make(ids.p1, 'EBAY', 'IT', { price: '11.00', followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: '10' })).id
    listing.amazonDe = (await make(ids.p1, 'AMAZON', 'DE', { price: '9.50', followMasterPrice: false, pricingRule: 'FIXED' })).id
    listing.ebayUk = (await make(ids.p1, 'EBAY', 'UK', { price: '8.00', followMasterPrice: true, pricingRule: 'FIXED' })).id
    listing.amazonFr = (await make(ids.p1, 'AMAZON', 'FR', { price: '10.00', followMasterPrice: true, pricingRule: 'FIXED', syncPaused: true })).id
    listing.p2AmazonIt = (await make(ids.p2, 'AMAZON', 'IT', { price: '20.00', followMasterPrice: true, pricingRule: 'FIXED' })).id
  })

  await inside(B, async () => {
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'AMAZON IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST_AMAZON_IT' } as never })
    ids.b1 = (await db.product.create({ data: { sku: 'BULK-B-1', name: 'Bravo jacket', basePrice: '30.00', categoryAttributes: { lining_note: 'Bravo' } } })).id
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.10 — bulk-price-change', { timeout: DB_TEST_TIMEOUT }, () => {
  it('keeps an unpublished draft out of the send count, while published and linked drafts still queue', async () => {
    const db = database.client
    const product = await inside(A, () => db.product.create({ data: { sku: 'BULK-DRAFT-PROOF', name: 'Draft proof', basePrice: 10 } }))
    try {
      const rows = await inside(A, async () => Promise.all([
        ['IT', false, null], ['DE', true, null], ['FR', false, 'TEST-LINKED'],
      ].map(([marketplace, isPublished, externalListingId]) => db.channelListing.create({ data: {
        productId: product.id, channel: 'AMAZON', marketplace: marketplace as string, region: 'EU',
        channelMarket: `AMAZON_${marketplace}`, listingStatus: 'DRAFT', isPublished: isPublished as boolean,
        externalListingId: externalListingId as string | null, syncPaused: false,
        price: 10, followMasterPrice: true, pricingRule: 'FIXED',
      } }))))
      const queued = await queue(PRICER, 'bulk-price-change', { products: [product.id], operation: 'set', value: 12 })
      expect(queued.ok).toBe(true)
      expect((queued.preview as any).totals).toMatchObject({ listingsSent: 2, listingsDrafts: 1, listingsPaused: 0 })
      expect((queued.preview as any).listings).toContain('BULK-DRAFT-PROOF · Amazon IT: 10.00 → 12.00 (draft: stored, not sent)')
      expect((await approve(queued.approvalId!, PRICER)).ok).toBe(true)
      const sent = await inside(A, () => db.outboundSyncQueue.findMany({ where: { productId: product.id }, select: { channelListingId: true } }))
      expect(sent.map((row) => row.channelListingId).sort()).toEqual(rows.slice(1).map((row) => row.id).sort())
      expect(Number((await inside(A, () => db.channelListing.findUniqueOrThrow({ where: { id: rows[0].id } }))).price)).toBe(12)
    } finally {
      await inside(A, () => db.outboundSyncQueue.deleteMany({ where: { productId: product.id } }))
    }
  })

  it('the preview changes nothing we can count, and shows from → to, the listings that follow, and the hold', async () => {
    const before = await measure()
    const out = await preview(PRICER, 'bulk-price-change', { products: [ids.p1, 'BULK-A-2'], operation: 'percent', value: 10 }) as any
    expect(await measure()).toEqual(before)

    expect(out.ok, out.error).toBe(true)
    const p = out.preview
    expect(p.changes).toEqual({
      'BULK-A-1 base price': { from: 10, to: 11 },
      'BULK-A-2 base price': { from: 20, to: 22 },
    })
    expect(p.totals).toEqual({
      products: 2, changing: 2, alreadyAtPrice: 0,
      listingsSent: 3, listingsPaused: 1, listingsDrafts: 0, listingsWithOwnPrice: 1, listingsOtherCurrency: 1, listingsAlreadyAtPrice: 0,
    })
    expect(p.listings).toEqual(expect.arrayContaining([
      'BULK-A-1 · Amazon IT: 10.00 → 11.00',
      'BULK-A-1 · eBay IT: 11.00 → 12.10',
      'BULK-A-1 · Amazon FR: 10.00 → 11.00 (paused: stored, not sent)',
      'BULK-A-1 · eBay UK: not sent — that market sells in GBP',
      'BULK-A-2 · Amazon IT: 20.00 → 22.00',
    ]))
    expect(p.effect).toBe('Master price raised by 10 % on 2 products. 3 listings that follow the master price are sent to their marketplace after a hold of 30 seconds.')
    expect(p.note).toContain('held for 30 seconds (the undo window)')
    expect(p.note).toContain('Nothing changes until a person approves this in Nexus')
  })

  it('set, percent and amount each work the new price out from the stored base price, to the cent', async () => {
    const changes = async (args: Record<string, unknown>) =>
      ((await preview(PRICER, 'bulk-price-change', { products: [ids.p1, ids.p2], ...args })) as any).preview.changes
    expect(await changes({ operation: 'set', value: 12.345 })).toEqual({
      'BULK-A-1 base price': { from: 10, to: 12.35 },
      'BULK-A-2 base price': { from: 20, to: 12.35 },
    })
    expect(await changes({ operation: 'percent', value: -15 })).toEqual({
      'BULK-A-1 base price': { from: 10, to: 8.5 },
      'BULK-A-2 base price': { from: 20, to: 17 },
    })
    expect(await changes({ operation: 'amount', value: '-2.5' })).toEqual({
      'BULK-A-1 base price': { from: 10, to: 7.5 },
      'BULK-A-2 base price': { from: 20, to: 17.5 },
    })
  })

  it('a price at or below 0 is refused, and so is a change that changes nothing; nothing is queued', async () => {
    const before = await measure()
    const below = await preview(PRICER, 'bulk-price-change', { products: [ids.p1, ids.p3], operation: 'amount', value: -1 }) as any
    expect(below).toMatchObject({ ok: false })
    expect(below.error).toBe('A master price must stay above 0: BULK-A-3 would go to -0.50. Nothing was queued.')
    expect(((await preview(PRICER, 'bulk-price-change', { products: [ids.p1], operation: 'set', value: 0 })) as any).error).toContain('above 0')
    expect(((await preview(PRICER, 'bulk-price-change', { products: [ids.p1], operation: 'percent', value: 0 })) as any).error).toContain('changes nothing')
    expect(((await preview(PRICER, 'bulk-price-change', { products: [ids.p1], operation: 'set', value: 10 })) as any).error).toContain('already has that master price')
    const queued = await queue(PRICER, 'bulk-price-change', { products: [ids.p1, ids.p3], operation: 'amount', value: -1 })
    expect(queued).toMatchObject({ ok: false, mode: 'error' })
    expect(await measure()).toEqual(before)
  })

  it('251 products are refused before anything runs', async () => {
    const products = Array.from({ length: 251 }, (_, i) => `SKU-${i}`)
    const out = await preview(PRICER, 'bulk-price-change', { products, operation: 'set', value: 5 }) as any
    expect(out.refused).toBeInstanceOf(ToolAccessError)
    expect(out.refused.code).toBe('invalid_arguments')
    expect(out.refused.message).toContain('products')
    // 250 is allowed: it reaches the tool, which then reports the ones it cannot find.
    const at = await preview(PRICER, 'bulk-price-change', { products: products.slice(0, 250), operation: 'set', value: 5 }) as any
    expect(at.refused).toBeUndefined()
    expect(at.error).toContain('250 products not found in this business')
  })

  it('a person without products.bulk.run may neither ask for it nor approve it', async () => {
    const out = await preview(PRICER_NO_BULK, 'bulk-price-change', { products: [ids.p1], operation: 'set', value: 15 }) as any
    expect(out.refused?.code).toBe('forbidden')
    expect(out.refused.message).toContain('products.bulk.run')
    const queued = await queue(PRICER, 'bulk-price-change', { products: [ids.p1], operation: 'set', value: 15 })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const decision = await approve(queued.approvalId!, PRICER_NO_BULK)
    expect(decision).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await basePrice(ids.p1)).toBe(10)
    await inside(A, () => decideApproval(queued.approvalId!, 'reject', PRICER))
  })

  it('after a person approves: the master price changes through the master price service, and exactly the listed pushes are queued', async () => {
    const args = { products: ['BULK-A-1', ids.p2], operation: 'percent', value: 10 }
    const queued = await queue(PRICER, 'bulk-price-change', args)
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const listed = (queued.preview as any).listings as string[]
    // Nothing moved while it waited.
    expect(await basePrice(ids.p1)).toBe(10)
    expect(await queueRows()).toEqual([])
    const calls = await inside(A, () => database.client.outboundApiCallLog.count())

    const decision = await approve(queued.approvalId!, PRICER)
    expect(decision).toMatchObject({ ok: true, status: 'executed' })
    expect(decision.result).toMatchObject({ changed: 2, prices: ['BULK-A-1: 10.00 → 11.00', 'BULK-A-2: 20.00 → 22.00'] })
    expect(await basePrice(ids.p1)).toBe(11)
    expect(await basePrice(ids.p2)).toBe(22)

    // Through masterPriceService: its own audit row, one per product.
    const audits = (await inside(A, () => database.client.auditLog.findMany({ where: { entityId: { in: [ids.p1, ids.p2] } } })))
      .filter((a) => (a.metadata as any)?.field === 'basePrice')
    expect(audits.map((a) => [a.entityId, a.after, (a.metadata as any).reason])).toEqual(expect.arrayContaining([
      [ids.p1, { basePrice: 11 }, 'bulk-grid-patch'],
      [ids.p2, { basePrice: 22 }, 'bulk-grid-patch'],
    ]))
    expect(audits).toHaveLength(2)

    // Exactly the pushes the preview listed as sent: PRICE_UPDATE rows, held, nothing sent from here.
    const all = await queueRows()
    // Round 5 — the paused listing's new price is kept as ONE held row (SKIPPED, never dispatched; sent once on resume):
    // not a push, and not counted by the approval's status (its own `source`).
    expect(all.filter((r) => r.syncStatus === 'SKIPPED').map((r) => [r.channelListingId, r.errorCode, (r.payload as any).source])).toEqual([[listing.amazonFr, 'PUSH_SYNC_PAUSED', 'HELD_PRICE']])
    const rows = all.filter((r) => r.syncStatus !== 'SKIPPED')
    expect(rows.map((r) => r.channelListingId).sort()).toEqual([listing.amazonIt, listing.ebayIt, listing.p2AmazonIt].sort())
    expect(rows.length).toBe((queued.preview as any).totals.listingsSent)
    for (const row of rows) {
      expect(row).toMatchObject({ syncType: 'PRICE_UPDATE', syncStatus: 'PENDING' })
      expect((row.payload as any).source).toBe('MASTER_PRICE_CHANGE')
      // The hold the preview quotes is the hold the service really puts on the row.
      expect(Math.abs(row.holdUntil!.getTime() - row.createdAt.getTime() - MASTER_PRICE_HOLD_MS)).toBeLessThan(10_000)
    }
    const priceOf = (id: string) => (rows.find((r) => r.channelListingId === id)!.payload as any).price
    expect([priceOf(listing.amazonIt), priceOf(listing.ebayIt), priceOf(listing.p2AmazonIt)]).toEqual([11, 12.1, 22])
    expect(listed).toEqual(expect.arrayContaining(['BULK-A-1 · Amazon IT: 10.00 → 11.00', 'BULK-A-1 · eBay IT: 11.00 → 12.10', 'BULK-A-2 · Amazon IT: 20.00 → 22.00']))
    // No channel call from here: the gateway's ledger is untouched.
    expect(await inside(A, () => database.client.outboundApiCallLog.count())).toBe(calls)

    // The other listings: paused keeps the new price unsent; own price and another currency keep theirs.
    const stored = await inside(A, () => database.client.channelListing.findMany({ where: { productId: ids.p1 } }))
    const price = (id: string) => Number(stored.find((l) => l.id === id)!.price)
    expect([price(listing.amazonFr), price(listing.amazonDe), price(listing.ebayUk)]).toEqual([11, 9.5, 8])

    // An approval runs once.
    expect(await approve(queued.approvalId!, PRICER)).toMatchObject({ ok: false, error: 'already executed' })

    // MCP.12 — approval-status says what is true: applied in Nexus, and the pushes are still waiting. It said
    // "Approved and done." while every one of them was PENDING.
    const waiting = await statusOf(queued.approvalId!)
    expect(waiting).toMatchObject({ status: 'executed', channels: { queued: 3, waiting: 3, sent: 0, failed: 0, notSent: 0 } })
    expect(waiting.meaning).toBe(
      'Approved and applied in Nexus: the master price changed. The channels update next: 3 price updates were queued for these products since it was approved — 3 waiting to be sent.',
    )
    // As the outbound queue works through them, the count follows the rows.
    await inside(A, () => database.client.outboundSyncQueue.update({ where: { id: rows[0].id }, data: { syncStatus: 'SUCCESS' } }))
    await inside(A, () => database.client.outboundSyncQueue.update({ where: { id: rows[1].id }, data: { syncStatus: 'FAILED' } }))
    const moving = await statusOf(queued.approvalId!)
    expect(moving.channels).toEqual({ queued: 3, waiting: 1, sent: 1, failed: 1, notSent: 0 })
    expect(moving.meaning).toContain('— 1 waiting to be sent, 1 sent, 1 failed.')
    await inside(A, () => database.client.outboundSyncQueue.update({ where: { id: rows[2].id }, data: { syncStatus: 'SUCCESS' } }))
    expect((await statusOf(queued.approvalId!)).meaning).toContain('The outbound queue has handled them: 3 price updates were queued')
  })

  it('an approval is worked out again when it runs: a price gone too low refuses the whole run and changes nothing', async () => {
    const queued = await queue(PRICER, 'bulk-price-change', { products: [ids.p4, ids.p2], operation: 'amount', value: -5 })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    // While it waits, BULK-A-4's base price is lowered elsewhere: 3 - 5 is no price.
    await inside(A, () => database.client.product.update({ where: { id: ids.p4 }, data: { basePrice: '3.00' } }))
    const before = await measure()
    const decision = await approve(queued.approvalId!, PRICER)
    expect(decision).toMatchObject({ ok: false, status: 'pending' })
    expect(decision.error).toBe('A master price must stay above 0: BULK-A-4 would go to -2.00. Nothing changed.')
    // Only the approval's own status moved (not measured); no product, listing, queue or audit row did.
    expect(await measure()).toEqual(before)
    await inside(A, () => decideApproval(queued.approvalId!, 'reject', PRICER))
  })

  it('an approval for a product deleted while it waited changes nothing and says so', async () => {
    const queued = await queue(PRICER, 'bulk-price-change', { products: [ids.p4, ids.p2], operation: 'set', value: 33 })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    await inside(A, () => database.client.product.update({ where: { id: ids.p4 }, data: { deletedAt: new Date() } }))
    try {
      const before = await measure()
      const decision = await approve(queued.approvalId!, PRICER)
      expect(decision).toMatchObject({ ok: false, status: 'pending' })
      expect(decision.error).toBe(`1 product not found in this business: ${ids.p4}. Nothing changed.`)
      expect((await measure()).A.products).toEqual(before.A.products)
      expect(await basePrice(ids.p2)).toBe(22)
    } finally {
      await inside(A, () => database.client.product.update({ where: { id: ids.p4 }, data: { deletedAt: null } }))
      await inside(A, () => decideApproval(queued.approvalId!, 'reject', PRICER))
    }
  })
})

describe('MCP.10 — bulk-attribute-change (Nexus only)', { timeout: DB_TEST_TIMEOUT }, () => {
  it('the preview changes nothing we can count, says Nexus only, and shows from → to', async () => {
    const before = await measure()
    const out = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1, ids.p2, ids.p3], attributes: { fit: 'slim' } }) as any
    expect(await measure()).toEqual(before)
    expect(out.ok, out.error).toBe(true)
    expect(out.preview).toMatchObject({
      action: 'bulk-attribute-change',
      scope: 'Nexus only',
      changes: {
        'BULK-A-1 fit': { from: 'regular', to: 'slim' },
        'BULK-A-2 fit': { from: 'regular', to: 'slim' },
        'BULK-A-3 fit': { from: null, to: 'slim' },
      },
      totals: { products: 3, changes: 3, alreadySet: 0 },
    })
    expect(out.preview.effect.startsWith(NEXUS_ONLY)).toBe(true)
    expect(out.preview.note.startsWith(NEXUS_ONLY)).toBe(true)
    expect(getTool('bulk-attribute-change')!.description).toContain(NEXUS_ONLY)
  })

  it('shows the product writer warnings without changing any rows in the preview', async () => {
    const before = await measure()
    const strict = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1], attributes: { protection_level: 'level_9' } }) as any
    expect(strict.ok).toBe(true)
    expect(strict.preview.warnings).toEqual([expect.stringContaining('BULK-A-1 protection_level:')])
    expect(strict.preview.warnings[0]).toContain('"level_9" is not one of the allowed values')
    expect(strict.preview.effect).toContain(strict.preview.warnings[0])
    expect(await measure()).toEqual(before)
  })

  it('still refuses an unknown attribute or a value the field cannot hold', async () => {
    const before = await measure()
    const unknown = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1], attributes: { collar_style: 'mandarin' } }) as any
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toBe(`1 change would be refused: BULK-A-1 collar_style: ${REFUSED_NOT_IN_FAMILY}. Nothing was queued.`)
    const wrongType = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1], attributes: { protection_level: ['level_1', 'level_2'] } }) as any
    expect(wrongType.ok).toBe(false)
    expect(wrongType.error).toContain('protection_level')
    expect(wrongType.error.endsWith('Nothing was queued.')).toBe(true)
    expect(await measure()).toEqual(before)
  })

  it('MCP.12 — text kept per language and a key saved as null are refused in plain words, as the description says', async () => {
    const before = await measure()
    // care_note is the family's translatable text; description is the product's own content: both are per language.
    for (const attributes of [{ care_note: 'Hand wash only' }, { description: 'A new description' }]) {
      const out = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1], attributes }) as any
      expect(out.ok).toBe(false)
      expect(out.error).toBe(`1 change would be refused: BULK-A-1 ${Object.keys(attributes)[0]}: ${REFUSED_PER_LANGUAGE}. Nothing was queued.`)
      expect(out.error).not.toMatch(/ContentAddress/)
    }
    // waterproofRating is saved on BULK-A-5 as null: the writer counts a saved attribute only while it holds a value.
    const nulled = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p5], attributes: { waterproofRating: 'IPX4' } }) as any
    expect(nulled.error).toBe(`1 change would be refused: BULK-A-5 waterproofRating: ${REFUSED_NOT_IN_FAMILY}. Nothing was queued.`)
    expect(nulled.error).not.toMatch(/business dictionary|marketplaceContexts/)
    // The same product's family attribute is still set: the refusal is about that one key, not the product.
    expect(((await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p5], attributes: { fit: 'slim' } })) as any).ok).toBe(true)
    expect(await measure()).toEqual(before)

    const tool = getTool('bulk-attribute-change')!
    expect(tool.description).toContain('a key saved empty or null does not count')
    expect(tool.description).toContain('It cannot set text kept per language')
    expect(String((tool.input as any).shape.attributes.description)).toContain('WITH a value')
  })

  it('invalidates an approval when its warning changes although its values do not', async () => {
    const queued = await queue(EDITOR, 'bulk-attribute-change', { products: [ids.p4], attributes: { protection_level: 'level_9' } })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect(await inside(A, () => checkStaleness(queued.approvalId!))).toEqual({ stale: false, why: null })
    const option = await inside(A, async () => {
      const attribute = await database.client.customAttribute.findFirstOrThrow({ where: { code: 'protection_level' } })
      return database.client.attributeOption.create({ data: { attributeId: attribute.id, code: 'level_9', label: 'Level 9' } })
    })
    clearSheetColumnCache()
    try {
      const before = await measure()
      expect((await inside(A, () => checkStaleness(queued.approvalId!)))).toMatchObject({ stale: true })
      expect(await measure()).toEqual(before)
    } finally {
      await inside(A, () => database.client.attributeOption.delete({ where: { id: option.id } }))
      clearSheetColumnCache()
    }
  })

  it('stores an approved warned value in Nexus and returns its warning without a channel write', async () => {
    const original = await attributes(ids.p4)
    const queued = await queue(EDITOR, 'bulk-attribute-change', { products: [ids.p4], attributes: { protection_level: 'level_9' } })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const before = await measure()
    try {
      const decision = await approve(queued.approvalId!, EDITOR)
      expect(decision).toMatchObject({ ok: true, status: 'executed' })
      expect(decision.result).toMatchObject({ changed: 1, note: NEXUS_ONLY, warnings: [expect.stringContaining('BULK-A-4 protection_level:')] })
      expect(await attributes(ids.p4)).toMatchObject({ protection_level: 'level_9' })
      const after = await measure()
      expect(after.A.counts.outboundSyncQueue).toBe(before.A.counts.outboundSyncQueue)
      expect(after.A.counts.outboundApiCallLog).toBe(before.A.counts.outboundApiCallLog)
      expect(after.A.listings).toEqual(before.A.listings)
      expect(after.B).toEqual(before.B)
    } finally {
      await inside(A, () => database.client.product.update({ where: { id: ids.p4 }, data: { categoryAttributes: original } }))
    }
  })

  it('a product with a formula reading the attribute is refused: its recalculation could reach a marketplace', async () => {
    const formula = await inside(A, () => database.client.cellFormula.create({
      data: { productId: ids.p2, scope: 'master', fieldKey: 'basePrice', expr: 'IF(fit = "slim", 25, 20)', dependsOn: ['fit'] },
    }))
    try {
      const out = await preview(EDITOR, 'bulk-attribute-change', { products: [ids.p1, ids.p2], attributes: { fit: 'slim' } }) as any
      expect(out.ok).toBe(false)
      expect(out.error).toContain('BULK-A-2 (basePrice)')
      expect(out.error.endsWith('Nothing was queued.')).toBe(true)
    } finally {
      await inside(A, () => database.client.cellFormula.delete({ where: { id: formula.id } }))
    }
  })

  it('251 products are refused, and so is a person without products.bulk.run or products.edit', async () => {
    const products = Array.from({ length: 251 }, (_, i) => `SKU-${i}`)
    const big = await preview(EDITOR, 'bulk-attribute-change', { products, attributes: { fit: 'slim' } }) as any
    expect(big.refused?.code).toBe('invalid_arguments')
    const noBulk = await preview(PRICER_NO_BULK, 'bulk-attribute-change', { products: [ids.p1], attributes: { fit: 'slim' } }) as any
    expect(noBulk.refused?.code).toBe('forbidden')
    expect(noBulk.refused.message).toContain('products.bulk.run')
    const noEdit = await preview(BULK_NO_EDIT, 'bulk-attribute-change', { products: [ids.p1], attributes: { fit: 'slim' } }) as any
    expect(noEdit.refused?.code).toBe('forbidden')
    expect(noEdit.refused.message).toContain('products.edit')
  })

  it('after a person approves: the values are stored, every other attribute stays, and NOTHING is queued to any marketplace', async () => {
    const queued = await queue(EDITOR, 'bulk-attribute-change', { products: [ids.p1, 'BULK-A-3'], attributes: { fit: 'slim', protection_level: 'level_2' } })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const before = await measure()
    const decision = await approve(queued.approvalId!, EDITOR)
    expect(decision).toMatchObject({ ok: true, status: 'executed' })
    expect(decision.result).toMatchObject({ changed: 4, note: NEXUS_ONLY })
    expect(await attributes(ids.p1)).toEqual({ lining_note: 'Mesh', fit: 'slim', protection_level: 'level_2' })
    expect(await attributes(ids.p3)).toMatchObject({ fit: 'slim', protection_level: 'level_2' })
    const after = await measure()
    // Nexus only: no queue row, no channel call, no listing touched.
    expect(after.A.counts.outboundSyncQueue).toBe(before.A.counts.outboundSyncQueue)
    expect(after.A.counts.outboundApiCallLog).toBe(before.A.counts.outboundApiCallLog)
    expect(after.A.listings).toEqual(before.A.listings)
    expect(after.B).toEqual(before.B)

    // MCP.12 — and approval-status says so, with no queue count: nothing was queued.
    const status = await statusOf(queued.approvalId!)
    expect(status.status).toBe('executed')
    expect(status.meaning).toBe(
      'Approved and applied in Nexus. Nothing was sent to a marketplace: Amazon, eBay, Shopify and Etsy change only when someone publishes from Nexus.',
    )
    expect(status).not.toHaveProperty('channels')
  })
})

describe('MCP.12 — what approval-status says an executed change did, per tool', () => {
  const none = { queued: 0, waiting: 0, sent: 0, failed: 0, notSent: 0 }
  it('never "done" while it cannot say what reached a channel', () => {
    expect(executedMeaning('set-price', none)).toBe(
      'Approved and applied in Nexus: the master price changed. No price update was queued to a marketplace for this product: no listing follows the master price, or each one is paused, has its own price, or sells in another currency.',
    )
    expect(executedMeaning('set-price', { ...none, queued: 2, waiting: 2 })).toContain('2 price updates were queued for this product since it was approved')
    expect(executedMeaning('bulk-price-change', none)).toContain('for these products:')
    // L5 — publish-listing queues nothing: its publication says what it did (publishedMeaning, publish-listing.tools test).
    expect(executedMeaning('publish-listing', null)).toBe('Approved, and it ran.')
    expect(executedMeaning('bulk-price-change', { ...none, queued: 2, notSent: 2 })).toContain('— 2 not sent (skipped or cancelled).')
    expect(executedMeaning('send-customer-message', null)).toBe('Approved, and it ran.')
    for (const tool of ['set-price', 'bulk-price-change', 'bulk-attribute-change', 'publish-listing', 'apply-content']) {
      expect(executedMeaning(tool, none)).not.toMatch(/\bdone\b/)
    }
  })
})

describe('MCP.10 — another business', { timeout: DB_TEST_TIMEOUT }, () => {
  it("a product of another business is not found, by id or by SKU, and nothing of it changes", async () => {
    await profilesOn(async () => {
      const before = await measure()
      for (const ref of [ids.b1, 'BULK-B-1']) {
        const price = await preview(PRICER, 'bulk-price-change', { products: [ids.p1, ref], operation: 'set', value: 99 }) as any
        expect(price).toMatchObject({ ok: false, error: `1 product not found in this business: ${ref}. Nothing was queued.` })
        const attr = await preview(EDITOR, 'bulk-attribute-change', { products: [ref], attributes: { lining_note: 'Changed' } }) as any
        expect(attr).toMatchObject({ ok: false, error: `1 product not found in this business: ${ref}. Nothing was queued.` })
      }
      expect(await measure()).toEqual(before)
    })
  })

  it('an approval whose stored arguments name another business’s product changes nothing there', async () => {
    await profilesOn(async () => {
      // As if the stored arguments had been altered after the preview: execute must resolve the products again,
      // in the business it runs in, and never trust an id.
      const run = await inside(A, () => database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } }))
      const approval = await inside(A, () => database.client.agentApproval.create({
        data: { agentRunId: run.id, toolName: 'bulk-price-change', riskTier: 'high', status: 'pending', preview: {}, args: { products: [ids.b1], operation: 'set', value: 1 } },
      }))
      const before = await measure()
      const decision = await approve(approval.id, PRICER)
      expect(decision).toMatchObject({ ok: false, status: 'pending', error: `1 product not found in this business: ${ids.b1}. Nothing changed.` })
      expect(await basePrice(ids.b1, B)).toBe(30)
      const after = await measure()
      expect(after.B).toEqual(before.B)
      expect(after.A.counts.outboundSyncQueue).toBe(before.A.counts.outboundSyncQueue)
    })
  })
})

describe('MCP.10 — the re-check before a scheduled approval runs', { timeout: DB_TEST_TIMEOUT }, () => {
  it('sees every product, not only the 20 the preview shows: product 21 moving makes it stale', async () => {
    const skus = Array.from({ length: 21 }, (_, i) => `BULK-S-${String(i + 1).padStart(2, '0')}`)
    const made = await inside(A, () => Promise.all(skus.map((sku) => database.client.product.create({ data: { sku, name: sku, basePrice: '5.00' } }))))
    const queued = await queue(PRICER, 'bulk-price-change', { products: skus, operation: 'set', value: 6 })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    const shown = Object.keys((queued.preview as any).changes)
    expect(shown).toHaveLength(20)
    expect(shown).not.toContain('BULK-S-21 base price')
    expect(await inside(A, () => checkStaleness(queued.approvalId!))).toEqual({ stale: false, why: null })

    // Only the one product the preview does not show moves.
    await inside(A, () => database.client.product.update({ where: { id: made[20].id }, data: { basePrice: '5.50' } }))
    const verdict = await inside(A, () => checkStaleness(queued.approvalId!))
    expect(verdict.stale).toBe(true)
    expect(verdict.why).toContain('basis changed')
    expect(verdict.why).not.toContain('changes changed')
    await inside(A, () => decideApproval(queued.approvalId!, 'reject', PRICER))
  })

  it('an attribute value that moved makes a queued attribute change stale', async () => {
    const queued = await queue(EDITOR, 'bulk-attribute-change', { products: [ids.p4], attributes: { fit: 'slim' } })
    expect(queued).toMatchObject({ ok: true, mode: 'queued' })
    expect(await inside(A, () => checkStaleness(queued.approvalId!))).toEqual({ stale: false, why: null })
    await inside(A, () => database.client.product.update({ where: { id: ids.p4 }, data: { categoryAttributes: { fit: 'relaxed' } } }))
    const verdict = await inside(A, () => checkStaleness(queued.approvalId!))
    expect(verdict.stale).toBe(true)
    expect(verdict.why).toContain('basis changed')
    await inside(A, () => decideApproval(queued.approvalId!, 'reject', EDITOR))
  })
})

describe('MCP.10 — over MCP, a bulk change is only ever queued', { timeout: DB_TEST_TIMEOUT }, () => {
  it.each([
    ['bulk-price-change', () => ({ products: [ids.p2], operation: 'set', value: 49 })],
    ['bulk-attribute-change', () => ({ products: [ids.p2], attributes: { fit: 'slim' } })],
  ])('%s from Claude waits for a person; nothing changes', async (name, args) => {
    const before = await measure()
    // C3 — a change from Claude names its business (a check; the token's business is the one used).
    const result = await runToolForClaude(claude, getTool(name)!, { ...args(), business: 'Alpha bulk business' })
    expect(result.isError).toBeFalsy()
    const out = JSON.parse((result.content[0] as { text: string }).text)
    expect(out).toMatchObject({ status: 'waiting_for_approval', approvalId: expect.any(String) })
    const after = await measure()
    expect(after.A.products).toEqual(before.A.products)
    expect(after.A.listings).toEqual(before.A.listings)
    expect(after.A.counts.outboundSyncQueue).toBe(before.A.counts.outboundSyncQueue)
    expect(after.A.counts.agentApproval).toBe(before.A.counts.agentApproval + 1)
    const approval = await inside(A, () => database.client.agentApproval.findUniqueOrThrow({ where: { id: out.approvalId } }))
    expect(approval).toMatchObject({ status: 'pending', toolName: name })
    const run = await inside(A, () => database.client.agentRun.findUniqueOrThrow({ where: { id: approval.agentRunId } }))
    expect(run).toMatchObject({ via: 'claude', oauthGrantId: 'grant-mcp10', status: 'awaiting_approval' })
  })
})
