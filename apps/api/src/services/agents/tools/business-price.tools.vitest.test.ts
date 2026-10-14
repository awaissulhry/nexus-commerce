/**
 * Amazon Business (B2B) step 6 — Claude's tools for the business price, against a real PostgreSQL with the production
 * schema (PGlite), through the one door (call-tool.ts) and the approval gate (a person approves in Nexus; the commit runs
 * it as the approver). The queue is a stub: nothing is sent anywhere. Every id, SKU and price is invented.
 *
 * Proven here:
 *   set-listing-price, action business   the dry run is the business price door's own and writes nothing; a person's
 *                                        approval runs exactly it (rule, percent or price, tiers) through the Matrix door
 *                                        and queues one business send; refused with the door's sentence: above the normal
 *                                        price, below the minimum price, a percent out of range, fixed tiers on a percent
 *                                        rule, the parent, a market where Amazon lists no Amazon Business; a paused listing
 *                                        keeps it in Nexus and says so; a first offer says it waits while Amazon's shopper
 *                                        price is not Nexus's (#602); nothing is a removal but remove: true, and a removal
 *                                        where Nexus keeps none while Amazon shows its own is refused; without an approved
 *                                        preview it never runs; an order between approval and commit moves nothing it
 *                                        stands on (#609), a business price someone set since refuses it; undo-change puts
 *                                        the setting back by value, refused once it moved, and never removes Amazon's own.
 *   bulk-listing-price-change, business  many listings in ONE approval and one undo; any refused listing refuses it all;
 *                                        a business price change is never run by rule.
 *   resend-prices                        the price only by default; asked, the business price Nexus keeps is queued again,
 *                                        spread out, and a removal at Amazon is said on the card.
 *   price-explain                        the rule, the price it gives, the normal price, the tiers, the last send.
 *   the approval card                    (#621 review) it shows only the summary and the from → to labels, so they say
 *                                        it all: Amazon's own price it replaces (and that an undo cannot bring it back),
 *                                        a first offer that waits, kept in Nexus, Amazon's warnings — counts for many.
 *   trust                                a business price change in bulk is held at ask whatever the tool is set to.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true, workersOff: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../../outbound-enqueue.js', async (original) => ({ ...(await original<object>()), fireOutboundJobs: vi.fn(async () => undefined) }))
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn(), emitTx: vi.fn() } }))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { runOrQueueTool } from '../approval-gate.service.js'
import { getTool } from '../tool-registry.js'
import { commitScheduledApproval, decideFleetApproval } from '../../agent-fleet/approval-inbox.service.js'
import { OFFER_AUDIENCE_FIELD_KEY } from '../../categories/seller-offer-audience.service.js'
import { PARENT_PRICE_REASON } from '../../pim/matrix-cells.js'
import { BUSINESS_PRICE_SYNC_TYPE } from '../../pim/business-price-write.service.js'
import { BUSINESS_NEEDS_A_PERSON, BULK_LISTING_PRICE_LIMITS, bulkListingPriceWithinLimits } from './price-change.tools.js'
import { AMAZON_OWN_UNDO, REMOVAL_REACHES_AMAZON, resolveBusinessSetting } from './business-price-plan.js'
import { resolveRequest } from '../../agent-fleet/approval-target.js'
import { claudeRuleForChange } from '../claude-trust.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client as any
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const people = { asker: '', approver: '' }
const principal = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId.slice(0, 6)}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
type Row = Record<string, any>
const accounts = { amazon: '', ebay: '' }
const IT = 'AMAZON:IT'
const tiers = { type: 'percent', levels: [{ minQty: 2, value: 3 }, { minQty: 5, value: 5 }] }

/** Claude asks and a person approves it in Nexus; the undo window is still open. */
async function askApprove(tool: string, args: Record<string, unknown>): Promise<{ approvalId: string; preview: Row }> {
  const asked = await ask(tool, args)
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true, mode: 'queued' })
  const parked = await inside(() => decideFleetApproval({ id: asked.approvalId, decision: 'approve', actor: principal(people.approver, 'app') })) as Row
  expect(parked, JSON.stringify(parked)).toMatchObject({ ok: true, status: 'scheduled' })
  return { approvalId: asked.approvalId, preview: asked.preview }
}
async function ask(tool: string, args: Record<string, unknown>): Promise<Row> {
  return inside(async () => {
    const run = await db().agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: people.asker } })
    return runOrQueueTool(tool, args, principal(people.asker, 'claude'), run.id, { forceAsk: true })
  }) as Promise<Row>
}
/** The undo window closes and the commit takes it (re-checked, then run as the approver). */
async function commit(approvalId: string): Promise<Row> {
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Row>
}
const dryRun = async (tool: string, args: Row) => (await inside(() => callTool(principal(people.asker, 'claude'), tool, args))).raw as Row
const stored = (id: string) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id }, select: { version: true, businessPriceRule: true, businessPricePercent: true, businessPrice: true, businessTiers: true } })) as Promise<Row>
const setting = (row: Row) => ({ rule: row.businessPriceRule, percent: row.businessPricePercent == null ? null : Number(row.businessPricePercent), price: row.businessPrice == null ? null : Number(row.businessPrice), tiers: row.businessTiers })
const businessRows = (id: string) => inside(() => db().outboundSyncQueue.findMany({ where: { channelListingId: id, syncType: BUSINESS_PRICE_SYNC_TYPE }, orderBy: { createdAt: 'asc' }, select: { syncStatus: true } })) as Promise<Row[]>
const target = (rowId: string, coordinateKey = IT) => [{ rowId, coordinateKey }]

/** A family of its own per test: the parent (OUTERWEAR) and a variation listed on Amazon IT at its own price of 200. */
async function family(tag: string, listing: Row = {}) {
  return inside(async () => {
    const parent = await db().product.create({ data: { sku: `TEST-SKU-B2B-${tag}`, name: `B2B jacket ${tag}`, basePrice: 200, isParent: true, productType: 'OUTERWEAR' } })
    const child = await db().product.create({ data: { sku: `TEST-SKU-B2B-${tag}-M`, name: `B2B jacket ${tag} M`, basePrice: 200, totalStock: 9, parentId: parent.id } })
    const list = (productId: string, channel: string, marketplace: string, extra: Row = {}) => db().channelListing.create({ data: {
      productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: channel === 'AMAZON' ? 'EU' : marketplace,
      channelConnectionId: channel === 'AMAZON' ? accounts.amazon : accounts.ebay, price: 200, priceOverride: 200, followMasterPrice: false, quantity: 3,
      listingStatus: 'ACTIVE', isPublished: true, externalListingId: `TEST-B2B-${channel}-${marketplace}-${tag}-${productId.slice(0, 6)}`, ...extra,
    } as never })
    const parentListing = await list(parent.id, 'AMAZON', 'IT')
    const it = await list(child.id, 'AMAZON', 'IT', listing)
    return { parent: parent.id as string, child: child.id as string, it: it.id as string, parentListing: parentListing.id as string, list }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  const c = database.client as any
  await database.db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceStart" DATE; ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "salePriceEnd" DATE;')
  people.asker = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Asker' } })).id
  people.approver = (await c.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'Test Approver' } })).id
  const role = await c.role.create({ data: { key: `B2B_${randomUUID().slice(0, 8)}`, name: 'Price approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
  await c.userRole.create({ data: { userId: people.approver, roleId: role.id } })
  const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: people.approver, status: 'active' } })
  await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
  await inside(async () => {
    for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['EBAY', 'IT']]) {
      await c.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    accounts.amazon = (await c.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, isPrimary: true, externalAccountId: 'TEST-B2B-AMAZON' } })).id
    accounts.ebay = (await c.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-B2B-EBAY' } })).id
    // Amazon lists Amazon Business for this account on IT (the seller-scoped schema answer); DE was never checked.
    await c.sellerReferenceLabel.create({ data: {
      channel: 'AMAZON', connectionId: accounts.amazon, marketplace: 'IT', productType: 'OUTERWEAR', fieldKey: OFFER_AUDIENCE_FIELD_KEY,
      labels: { B2B: 'Amazon Business (B2B)', ALL: 'Vendita su Amazon' },
    } as never })
  })
}, 180_000)
afterAll(async () => { await database?.close() }, 60_000)

describe('the business setting a change asks for (pure)', () => {
  it('a rule from its fields; left-out tiers keep; only remove: true removes; a shape that cannot be read is refused', () => {
    const now = { rule: 'PERCENT_OFF' as const, percent: 5, price: null, tiers: { type: 'percent' as const, levels: [{ minQty: 2, value: 3 }] } }
    expect(resolveBusinessSetting(now, { percent: 7 })).toEqual({ setting: { ...now, percent: 7 } })
    expect(resolveBusinessSetting(now, { price: 90 })).toEqual({ setting: { rule: 'FIXED', percent: null, price: 90, tiers: now.tiers } })
    expect(resolveBusinessSetting(now, { tiers: null })).toEqual({ setting: { ...now, tiers: null } })
    expect(resolveBusinessSetting(now, { remove: true })).toEqual({ setting: null })
    expect(resolveBusinessSetting(now, {})).toMatchObject({ error: expect.stringContaining('Name the business price') })
    expect(resolveBusinessSetting(now, { remove: true, percent: 3 })).toMatchObject({ error: expect.stringContaining('remove goes alone') })
    expect(resolveBusinessSetting(null, { tiers: tiers as never })).toMatchObject({ error: expect.stringContaining('no business price yet') })
    expect(resolveBusinessSetting(now, { rule: 'FIXED' })).toMatchObject({ error: expect.stringContaining('FIXED needs a price') })
    expect(resolveBusinessSetting(now, { rule: 'PERCENT_OFF', price: 80 })).toMatchObject({ error: expect.stringContaining('A price goes with rule FIXED') })
  })
})

describe('set-listing-price, action business', { timeout: 90_000 }, () => {
  it('Claude asks, a person approves, it runs through the Matrix door; the preview is the door\'s; undo-change puts it back by value', async () => {
    const f = await family('HAPPY')
    const args = { productId: f.child, action: 'business', businessPrice: { rule: 'PERCENT_OFF', percent: 5, tiers }, targets: target(f.child) }
    const dry = await dryRun('set-listing-price', args)
    expect(dry.ok, dry.error).toBe(true)
    expect(dry.preview).toMatchObject({
      verb: 'business', basisOn: 'fields',
      changes: [{ rowId: f.child, coordinateKey: IT, cell: 'businessPrice', from: null, to: { rule: 'PERCENT_OFF', percent: 5, price: null, tiers },
        fromLabel: 'No business price', toLabel: '5 % below the normal price · quantity discounts 2+ 3 %, 5+ 5 %' }],
      prices: [{ coordinateKey: IT, currency: 'EUR', normalPrice: 200, now: null, after: 190 }],
    })
    // A dry run writes nothing and queues nothing.
    expect(setting(await stored(f.it))).toEqual({ rule: null, percent: null, price: null, tiers: null })
    expect(await businessRows(f.it)).toEqual([])

    const { approvalId } = await askApprove('set-listing-price', args)
    const done = await commit(approvalId)
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, status: 'executed' })
    expect(setting(await stored(f.it))).toEqual({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers })
    expect(await businessRows(f.it)).toEqual([{ syncStatus: 'PENDING' }])
    const audit = await inside(() => db().channelListingOverride.findFirst({ where: { channelListingId: f.it, fieldName: 'businessPrice' }, select: { changedBy: true, reason: true } }))
    expect(audit).toEqual({ changedBy: people.approver, reason: 'matrix' })

    // Undo: the setting before (none) by value, in ONE bulk request a person approves.
    const undo = await askApprove('undo-change', { approvalId })
    expect(undo.preview).toMatchObject({ action: 'bulk-listing-price-change', businessPrices: true, changes: [{ fromLabel: '5 % below the normal price · quantity discounts 2+ 3 %, 5+ 5 %', toLabel: 'No business price' }] })
    expect((await commit(undo.approvalId)).status).toBe('executed')
    expect(setting(await stored(f.it))).toEqual({ rule: null, percent: null, price: null, tiers: null })
    // The removal reaches Amazon too: one waiting business row (the earlier one replaced).
    expect((await businessRows(f.it)).map((r) => r.syncStatus)).toEqual(['CANCELLED', 'PENDING'])
  })

  it('an exact price above the normal price, below the minimum price, a percent out of range, fixed tiers on a percent: refused with Amazon\'s rule', async () => {
    const f = await family('BOUNDS')
    const min = await inside(async () => (await f.list((await db().product.create({ data: { sku: 'TEST-SKU-B2B-BOUNDS-L', name: 'L', basePrice: 200, parentId: f.parent } })).id, 'AMAZON', 'IT',
      { platformAttributes: { amazonOffer: { minimum_seller_allowed_price: 195 } } })).productId as string)
    const ask = (business: Row, rowId = f.child) => dryRun('set-listing-price', { productId: f.child, action: 'business', businessPrice: business, targets: target(rowId) })
    expect(await ask({ rule: 'FIXED', price: 240 })).toMatchObject({ ok: false, error: expect.stringContaining('The business price EUR 240.00 is above the normal price EUR 200.00: Amazon would not show it to business buyers.') })
    expect(await ask({ rule: 'PERCENT_OFF', percent: 10 }, min)).toMatchObject({ ok: false, error: expect.stringContaining('below this listing\'s minimum price EUR 195.00: Amazon refuses it') })
    expect(await ask({ rule: 'PERCENT_OFF', percent: 99.5 })).toMatchObject({ ok: false, error: expect.stringContaining('a percent from 0 to 99') })
    expect(await ask({ rule: 'PERCENT_OFF', percent: 5, tiers: { type: 'fixed', levels: [{ minQty: 2, value: 90 }] } })).toMatchObject({ ok: false, error: expect.stringContaining('Fixed quantity prices go with an exact business price') })
    expect(await ask({ rule: 'PERCENT_OFF', percent: 5, tiers: { type: 'percent', levels: [{ minQty: 1, value: 3 }] } })).toMatchObject({ ok: false, error: expect.stringContaining('at least 2') })
    expect(setting(await stored(f.it))).toEqual({ rule: null, percent: null, price: null, tiers: null })
  })

  it('held by the Matrix: the parent, and a market where Amazon lists no Amazon Business, are refused with the Matrix\'s reason', async () => {
    const f = await family('HELD')
    await inside(() => f.list(f.child, 'AMAZON', 'DE'))
    const asked = (rowId: string, coordinateKey: string) => dryRun('set-listing-price', { productId: f.child, action: 'business', businessPrice: { percent: 5 }, targets: target(rowId, coordinateKey) })
    expect(await asked(f.parent, IT)).toMatchObject({ ok: false, error: expect.stringContaining(PARENT_PRICE_REASON) })
    expect(await asked(f.child, 'AMAZON:DE')).toMatchObject({ ok: false, error: expect.stringMatching(/Business pricing|Amazon Business/) })
    // One target held, one not: the preview changes the one and names the other.
    const both = await dryRun('set-listing-price', { productId: f.child, action: 'business', businessPrice: { percent: 5 }, targets: [...target(f.parent), ...target(f.child)] })
    expect(both.preview).toMatchObject({ changes: [{ rowId: f.child }], refused: [{ coordinateKey: IT, reason: PARENT_PRICE_REASON }] })
  })

  it('a paused listing keeps it in Nexus and says so; a first offer waits while Amazon\'s shopper price is not Nexus\'s (#602)', async () => {
    const paused = await family('PAUSED', { syncPaused: true })
    const p = await dryRun('set-listing-price', { productId: paused.child, action: 'business', businessPrice: { percent: 5 }, targets: target(paused.child) })
    expect(p.preview.warning).toContain('this listing\'s sync is paused. It is sent when the listing resumes')
    const differs = await family('SHOPPER', { platformAttributes: { attributes: { purchasable_offer: [{ audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 210 }] }] }] } } })
    const d = await dryRun('set-listing-price', { productId: differs.child, action: 'business', businessPrice: { percent: 5 }, targets: target(differs.child) })
    expect(d.preview.warning).toContain('Not sent yet: Amazon\'s shopper price is EUR 210.00 and Nexus\'s is EUR 200.00')
  })

  it('a business price Amazon shows that Nexus never kept: a removal is refused, a new one replaces it, and its undo never removes Amazon\'s', async () => {
    const offer = { attributes: { purchasable_offer: [{ audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 200 }] }] }, { audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 185 }] }] }] } }
    const f = await family('OWN', { platformAttributes: offer })
    expect(await dryRun('set-listing-price', { productId: f.child, action: 'business', businessPrice: { remove: true }, targets: target(f.child) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('Amazon shows one of EUR 185.00, set outside Nexus') })
    const args = { productId: f.child, action: 'business', businessPrice: { rule: 'FIXED', price: 187 }, targets: target(f.child) }
    const own = (await dryRun('set-listing-price', args)).preview
    expect(own.warning).toContain('Amazon shows a business price of EUR 185.00 set outside Nexus: this replaces it')
    // The card (summary + from → to): it says it replaces Amazon's own price, and that an undo cannot bring it back.
    const card = resolveRequest('set-listing-price', args, own, { masterCurrency: 'EUR' })
    expect(card.changes[0]).toMatchObject({ from: 'Amazon\'s own EUR 185.00 (set outside Nexus)', to: 'EUR 187.00 (exact)' })
    expect(card.summary).toContain('Replaces Amazon\'s own business price EUR 185.00 (set outside Nexus; an undo cannot bring it back)')
    const { approvalId } = await askApprove('set-listing-price', args)
    expect((await commit(approvalId)).status).toBe('executed')
    const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } })) as Row
    expect(change.before).toMatchObject({ kind: 'business', businessPrices: [{ listingId: f.it, setting: null, amazonOwn: { price: 185 } }] })
    expect(getTool('set-listing-price')!.undo!.request({ before: change.before, after: change.after })).toEqual({ refusal: AMAZON_OWN_UNDO })
  })

  it('a removal asks for remove: true and says it reaches Amazon', async () => {
    const f = await family('REMOVE', { businessPriceRule: 'FIXED', businessPrice: 189 })
    const r = await dryRun('set-listing-price', { productId: f.child, action: 'business', businessPrice: { remove: true }, targets: target(f.child) })
    expect(r.preview).toMatchObject({ changes: [{ from: { rule: 'FIXED', price: 189 }, to: null, toLabel: 'No business price' }] })
    expect(r.preview.warning).toContain(REMOVAL_REACHES_AMAZON)
  })

  it('it never runs without a person\'s approved preview; the tool always asks', async () => {
    const f = await family('NOAPPROVAL')
    const tool = getTool('set-listing-price')!
    expect({ alwaysAsk: tool.alwaysAsk, maxClaudeTrust: tool.maxClaudeTrust, openWorld: tool.openWorld }).toEqual({ alwaysAsk: true, maxClaudeTrust: 'ask', openWorld: true })
    const ran = (await inside(() => executeTool(principal(people.approver, 'app'), 'set-listing-price', { productId: f.child, action: 'business', businessPrice: { percent: 5 }, targets: target(f.child) }, { via: 'claude' }))).raw as Row
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining('only after a person approved its preview') })
    expect(setting(await stored(f.it))).toEqual({ rule: null, percent: null, price: null, tiers: null })
  })

  it('#609 — an order between approval and commit moves nothing it stands on; a business price someone set since refuses it', async () => {
    const f = await family('BASIS')
    const args = { productId: f.child, action: 'business', businessPrice: { percent: 5 }, targets: target(f.child) }
    const first = await askApprove('set-listing-price', args)
    await inside(() => db().channelListing.update({ where: { id: f.it }, data: { quantity: { decrement: 1 }, version: { increment: 1 } } }))
    expect((await commit(first.approvalId)).status).toBe('executed')
    expect(setting(await stored(f.it))).toMatchObject({ rule: 'PERCENT_OFF', percent: 5 })

    const second = await askApprove('set-listing-price', { ...args, businessPrice: { percent: 6 } })
    await inside(() => db().channelListing.update({ where: { id: f.it }, data: { businessPricePercent: 7, version: { increment: 1 } } }))
    expect(await commit(second.approvalId)).toMatchObject({ ok: false, error: expect.stringContaining('the facts moved since you approved it') })
    expect(setting(await stored(f.it))).toMatchObject({ rule: 'PERCENT_OFF', percent: 7 })
    // And the first change's undo is refused: what it wrote is no longer there.
    const undo = await ask('undo-change', { approvalId: first.approvalId })
    expect(undo).toMatchObject({ ok: false, error: expect.stringContaining('changed since') })
  })
})

describe('bulk-listing-price-change, business', { timeout: 90_000 }, () => {
  it('many listings in ONE approval, each its own setting; one undo puts every one back', async () => {
    const a = await family('BULK-A')
    const b = await family('BULK-B', { businessPriceRule: 'FIXED', businessPrice: 189 })
    const args = { businessPrices: [{ listingId: a.it, rule: 'PERCENT_OFF', percent: 5, tiers }, { listingId: b.it, price: 188 }] }
    const { approvalId, preview } = await askApprove('bulk-listing-price-change', args)
    expect(preview).toMatchObject({ businessPrices: true, totals: { listings: 2, removed: 0 }, changes: [{ toLabel: expect.stringContaining('5 % below') }, { fromLabel: 'EUR 189.00 (exact)', toLabel: 'EUR 188.00 (exact)' }] })
    expect((await commit(approvalId)).status).toBe('executed')
    expect(setting(await stored(a.it))).toEqual({ rule: 'PERCENT_OFF', percent: 5, price: null, tiers })
    expect(setting(await stored(b.it))).toMatchObject({ rule: 'FIXED', price: 188 })
    expect(await inside(() => db().agentApproval.count({ where: { id: approvalId } }))).toBe(1)

    const undo = await askApprove('undo-change', { approvalId })
    expect((await commit(undo.approvalId)).status).toBe('executed')
    expect(setting(await stored(a.it))).toEqual({ rule: null, percent: null, price: null, tiers: null })
    expect(setting(await stored(b.it))).toMatchObject({ rule: 'FIXED', price: 189 })
  })

  it('one listing the door refuses refuses the request; normal prices and business prices are not mixed', async () => {
    const f = await family('BULK-NO')
    const ebay = await inside(() => f.list(f.child, 'EBAY', 'IT'))
    expect(await dryRun('bulk-listing-price-change', { businessPrices: [{ listingId: f.it, percent: 5 }, { listingId: ebay.id, percent: 5 }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('Only an Amazon listing has a business price') })
    expect(await dryRun('bulk-listing-price-change', { businessPrices: [{ listingId: f.parentListing, percent: 5 }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining(PARENT_PRICE_REASON) })
    expect(await dryRun('bulk-listing-price-change', { businessPrices: [{ listingId: f.it, percent: 5 }], listingIds: [f.it], mode: 'percent', value: 5 }))
      .toMatchObject({ ok: false, error: expect.stringContaining('one request changes normal prices or business prices') })
  })

  it('a business price change is never run by a business\'s rule, whatever its limits', async () => {
    const f = await family('BULK-RULE')
    const dry = await dryRun('bulk-listing-price-change', { businessPrices: [{ listingId: f.it, percent: 1 }] })
    const open = BULK_LISTING_PRICE_LIMITS.parse({ maxChangePct: 100 })
    expect(bulkListingPriceWithinLimits(dry.preview, open)).toBe(BUSINESS_NEEDS_A_PERSON)
  })
})

describe('#621 review — the approval card says what a person must know', { timeout: 90_000 }, () => {
  const card = (tool: string, args: Row, preview: Row) => resolveRequest(tool, args, preview, { masterCurrency: 'EUR' })

  it('one listing: a first offer that waits (whatever Nexus keeps, while Amazon holds none), and kept in Nexus while paused', async () => {
    // Nexus keeps a business price that never reached Amazon; Amazon's shopper price is another.
    const waits = await family('CARD-WAIT', { businessPriceRule: 'FIXED', businessPrice: 189,
      platformAttributes: { attributes: { purchasable_offer: [{ audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 210 }] }] }] } } })
    const args = { productId: waits.child, action: 'business', businessPrice: { percent: 5 }, targets: target(waits.child) }
    const preview = (await dryRun('set-listing-price', args)).preview
    expect(preview.warning).toContain('Not sent yet: Amazon\'s shopper price is EUR 210.00 and Nexus\'s is EUR 200.00')
    expect(card('set-listing-price', args, preview).summary).toContain('Not sent while Amazon\'s shopper price EUR 210.00 is not Nexus\'s EUR 200.00')
    const paused = await family('CARD-PAUSED', { syncPaused: true })
    const pArgs = { productId: paused.child, action: 'business', businessPrice: { percent: 5 }, targets: target(paused.child) }
    expect(card('set-listing-price', pArgs, (await dryRun('set-listing-price', pArgs)).preview).summary).toContain('Kept in Nexus, not sent yet: this listing\'s sync is paused')
  })

  it('many listings: each kind counted with the first listings, inside the card\'s 400 characters; a removal said too', async () => {
    const own = await family('CARD-OWN', { platformAttributes: { attributes: { purchasable_offer: [{ audience: 'B2B', our_price: [{ schedule: [{ value_with_tax: 185 }] }] }] } } })
    const paused = await family('CARD-HELD', { syncPaused: true })
    const sale = await family('CARD-SALE', { salePrice: 150 })
    const removed = await family('CARD-RM', { businessPriceRule: 'FIXED', businessPrice: 189 })
    const args = { businessPrices: [{ listingId: own.it, price: 187 }, { listingId: paused.it, percent: 5 }, { listingId: sale.it, percent: 5 }, { listingId: removed.it, remove: true }] }
    const preview = (await dryRun('bulk-listing-price-change', args)).preview
    const shown = card('bulk-listing-price-change', args, preview)
    // Four kinds at once: every one is said, fewer names to fit the card.
    expect(shown.summary!.length).toBeLessThanOrEqual(400)
    expect(shown.summary).toContain('Replaces Amazon\'s own business price (an undo cannot bring it back): 1')
    expect(shown.summary).toContain('Kept in Nexus, not sent yet (paused, draft or Inactive): 1')
    expect(shown.summary).toContain('Saved with a warning (hidden by Amazon, or a sale below it): 1')
    expect(shown.summary).toContain('Removed at Amazon too: 1')
    expect(shown.summary!.indexOf('Replaces Amazon')).toBeLessThan(shown.summary!.indexOf('Kept in Nexus'))
    expect(shown.changes.map((c) => c.from)).toEqual(['Amazon\'s own EUR 185.00 (set outside Nexus)', 'No business price', 'No business price', 'EUR 189.00 (exact)'])
    // Two kinds: the listings are named.
    const two = (await dryRun('bulk-listing-price-change', { businessPrices: [{ listingId: own.it, price: 187 }, { listingId: paused.it, percent: 5 }] })).preview
    expect(two.summary).toContain('Replaces Amazon\'s own business price (an undo cannot bring it back): 1 (TEST-SKU-B2B-CARD-OWN-M IT)')
    expect(two.summary).toContain('Kept in Nexus, not sent yet (paused, draft or Inactive): 1 (TEST-SKU-B2B-CARD-HELD-M IT)')
  })
})

describe('resend-prices and price-explain, with the business price', { timeout: 90_000 }, () => {
  it('resend-prices queues the business price Nexus keeps, with the price or alone', async () => {
    const f = await family('RESEND', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 })
    // By default the price only, as before step 6.
    expect((await dryRun('resend-prices', { listingIds: [f.it] })).preview).toMatchObject({ totals: { listings: 1 } })
    expect((await dryRun('resend-prices', { listingIds: [f.it] })).preview.businessPrices).toBeUndefined()
    const dry = await dryRun('resend-prices', { listingIds: [f.it], which: 'both' })
    expect(dry.preview).toMatchObject({ totals: { listings: 1, businessListings: 1 }, businessPrices: [{ market: 'IT', setting: '5 % below the normal price', price: 190, currency: 'EUR' }] })
    const only = await dryRun('resend-prices', { listingIds: [f.it], which: 'business' })
    expect(only.preview).toMatchObject({ totals: { listings: 0, businessListings: 1 } })
    const { approvalId } = await askApprove('resend-prices', { listingIds: [f.it], which: 'business' })
    const done = await commit(approvalId)
    expect(done.status, JSON.stringify(done)).toBe('executed')
    expect(await businessRows(f.it)).toEqual([{ syncStatus: 'PENDING' }])
  })

  it('a removal at Amazon is named on the card; asked business sends are spread out, 2 s apart', async () => {
    const gone = await family('RESEND-RM')
    // Nexus kept a business price here once (its audit row) and keeps none now: a resend removes Amazon's.
    await inside(() => db().channelListingOverride.create({ data: { channelListingId: gone.it, fieldName: 'businessPrice', previousValue: null, newValue: 'x', reason: 'test', changedBy: 'test@example.test' } }))
    const both = (await dryRun('resend-prices', { listingIds: [gone.it], which: 'both' })).preview
    expect(both.summary).toBe('Send the price 1 listing already carries again, and remove the business price at Amazon for 1 listing (Nexus keeps none there now).')
    expect(resolveRequest('resend-prices', { listingIds: [gone.it], which: 'both' }, both, { masterCurrency: 'EUR' }).summary).toBe(both.summary)

    const a = await family('RESEND-A', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 })
    const b = await family('RESEND-B', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5 })
    const { approvalId } = await askApprove('resend-prices', { listingIds: [a.it, b.it], which: 'business' })
    expect((await commit(approvalId)).status).toBe('executed')
    const rows = await inside(() => db().outboundSyncQueue.findMany({ where: { channelListingId: { in: [a.it, b.it] }, syncType: BUSINESS_PRICE_SYNC_TYPE }, select: { holdUntil: true } })) as Row[]
    const holds = rows.map((r) => new Date(r.holdUntil).getTime()).sort((x, y) => x - y)
    expect(holds).toHaveLength(2)
    expect(holds[1]! - holds[0]!).toBeGreaterThanOrEqual(1_900)
  })

  it('price-explain: the rule, the price it gives, the normal price it follows, the tiers and the last send', async () => {
    const f = await family('EXPLAIN', { businessPriceRule: 'PERCENT_OFF', businessPricePercent: 5, businessTiers: tiers })
    const out = (await inside(() => callTool(principal(people.asker, 'claude'), 'price-explain', { productId: f.child, channel: 'AMAZON', marketplace: 'IT' }))).raw as Row
    expect(out.ok, out.error).toBe(true)
    expect(out.data.business).toMatchObject({
      offered: true, coordinateKey: IT, rowId: f.child, rule: 'PERCENT_OFF', percent: 5, price: 190, normalPrice: 200, currency: 'EUR',
      setting: '5 % below the normal price · quantity discounts 2+ 3 %, 5+ 5 %',
      tiers: { type: 'percent', levels: [{ minQty: 2, value: 3, unitPrice: 184.3 }, { minQty: 5, value: 5, unitPrice: 180.5 }] },
      change: expect.stringContaining('set-listing-price action business'),
    })
    const parent = (await inside(() => callTool(principal(people.asker, 'claude'), 'price-explain', { productId: f.parent, channel: 'AMAZON', marketplace: 'IT' }))).raw as Row
    expect(parent.ok, parent.error).toBe(true)
    expect(parent.data.business).toMatchObject({ offered: false, rowId: f.parent, reason: PARENT_PRICE_REASON })
    // Another channel says nothing of a business price.
    await inside(() => f.list(f.child, 'EBAY', 'IT'))
    const ebay = (await inside(() => callTool(principal(people.asker, 'claude'), 'price-explain', { productId: f.child, channel: 'EBAY', marketplace: 'IT' }))).raw as Row
    expect(ebay.ok, ebay.error).toBe(true)
    expect(ebay.data.business).toBeUndefined()
  })

  it('listing-matrix: the business cell is writable through set-listing-price', async () => {
    const f = await family('MATRIX')
    const out = (await inside(() => callTool(principal(people.asker, 'claude'), 'listing-matrix', { productId: f.child, channel: 'AMAZON' }))).raw as Row
    const cell = out.data.rows.find((r: Row) => r.rowId === f.child).cells[IT]
    expect(cell.business).toMatchObject({ rule: null, normalPrice: 200, currency: 'EUR' })
    expect(cell.writable).toContain('businessPrice')
  })
})

describe('#621 review — business prices in bulk are approved by a person in Nexus, whatever the tool is set to', () => {
  it('confirm or auto for bulk-listing-price-change: a business price request is held at ask with the reason; normal prices keep the level', async () => {
    const f = await family('TRUST')
    try {
      for (const level of ['confirm', 'auto']) {
        await inside(() => db().agentTool.upsert({ where: { workspace_name: { workspaceId: LEGACY_WORKSPACE_ID, name: 'bulk-listing-price-change' } },
          create: { name: 'bulk-listing-price-change', riskTier: 'high', requiresApproval: true, claudeTrust: level }, update: { claudeTrust: level } }))
        const businessRule = await inside(() => claudeRuleForChange('bulk-listing-price-change', { businessPrices: [{ listingId: f.it, percent: 5 }] }))
        expect(businessRule).toMatchObject({ level: 'ask', narrowedFor: BUSINESS_NEEDS_A_PERSON })
        const normalRule = await inside(() => claudeRuleForChange('bulk-listing-price-change', { listingIds: [f.it], mode: 'percent', value: 1 }))
        expect(normalRule?.level).toBe(level)
      }
    } finally {
      await inside(() => db().agentTool.deleteMany({ where: { name: 'bulk-listing-price-change' } }))
    }
  })
})
