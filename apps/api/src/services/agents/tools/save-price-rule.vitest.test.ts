/**
 * MCP full control R17 — save-price-rule, through the one door, on a real PostgreSQL (PGlite).
 *
 * Proven: always a person (alwaysAsk, trust at most ask); a new rule is born OFF; its range must sit inside the
 * product's own pricing floor and ceiling — refused, never clamped — compared only in the master currency (a GBP market
 * is not compared; a rule for every market must name one when the product has bounds); the preview shows the price
 * the draft would pick now and applies nothing; an edit keeps the rule's switch; undo saves the rule as it was;
 * channel, market and product never change; another business's rule is not found.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const A = LEGACY_WORKSPACE_ID
const OTHER = 'ws_r17_other'
const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(work: () => Promise<T>, workspaceId = A) => withWorkspace(business(workspaceId), work)
const person: UserPrincipal = { kind: 'user', userId: 'u-r17', label: 'R17 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) }, workspace: business(A), via: 'claude' }
type Out = { ok: boolean; error?: string; preview?: Record<string, any>; data?: Record<string, any>; change?: { before: any; after: any } }
const dry = async (args: Record<string, unknown>) => (await callTool(person, 'save-price-rule', args)).raw as Out
const run = async (args: Record<string, unknown>) => (await executeTool(person, 'save-price-rule', args, { via: 'claude' })).raw as Out
const tool = () => getTool('save-price-rule')!
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [OTHER])
  await inside(async () => {
    const db = database.client
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT' } as never })
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'UK', name: 'eBay UK', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'], marketplaceId: 'EBAY_GB' } as never })
    // A floor of 20 and a ceiling of 50 (master currency, EUR).
    ids.bounded = (await db.product.create({ data: { sku: 'TEST-SKU-1', name: 'TEST bounded', basePrice: '30.00', minPrice: '20.00', maxPrice: '50.00' } as never })).id
    ids.free = (await db.product.create({ data: { sku: 'TEST-SKU-2', name: 'TEST free', basePrice: '30.00' } as never })).id
    await db.channelListing.create({ data: { productId: ids.bounded, channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'IT', price: 30, masterPrice: 30, followMasterPrice: true } as never })
    ids.existing = (await db.repricingRule.create({ data: { productId: ids.free, channel: 'EBAY', marketplace: 'IT', enabled: true, minPrice: 10, maxPrice: 40, strategy: 'match_buy_box' } })).id
  })
  await inside(async () => {
    const p = await database.client.product.create({ data: { sku: 'TEST-SKU-9', name: 'TEST other', basePrice: '10.00' } as never })
    ids.otherRule = (await database.client.repricingRule.create({ data: { productId: p.id, channel: 'EBAY', marketplace: 'IT', minPrice: 1, maxPrice: 2, strategy: 'manual' } })).id
  }, OTHER)
}, 180_000)
afterAll(async () => {
  await database?.close()
}, 30_000)

describe('R17 — save-price-rule', () => {
  it('always a person: alwaysAsk, trust at most ask', () => {
    expect(tool()).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requires: [FEATURES.repricingRulesManage, FEATURES.pricingView] })
  })

  it("the range must sit inside the product's floor and ceiling — refused, never clamped; only in the master currency", async () => {
    const base = { productId: ids.bounded, channel: 'EBAY', marketplace: 'IT', strategy: 'match_buy_box' }
    expect((await dry({ ...base, minPrice: 15, maxPrice: 40 })).error).toBe("TEST-SKU-1 on EBAY IT: its minimum 15.00 is below the product's pricing floor of 20.00: refused, never clamped.")
    expect((await dry({ ...base, minPrice: 25, maxPrice: 60 })).error).toBe("TEST-SKU-1 on EBAY IT: its maximum 60.00 is above the product's pricing ceiling of 50.00: refused, never clamped.")
    expect((await dry({ ...base, marketplace: null, minPrice: 25, maxPrice: 40 })).error).toContain('name the market (marketplace) so the rule\'s range can be checked against them')
    // A GBP market: the EUR floor is not compared, and not converted.
    const uk = await dry({ ...base, marketplace: 'UK', minPrice: 5, maxPrice: 90 })
    expect(uk.preview!.bounds).toMatchObject({ applied: false, note: expect.stringContaining('prices in GBP') })
  })

  it('a new rule: born OFF; the preview picks a price and applies nothing; the run saves it OFF; undo is a refusal (it is OFF already)', async () => {
    const args = { productId: ids.bounded, channel: 'EBAY', marketplace: 'IT', minPrice: 22, maxPrice: 45, strategy: 'manual', notes: 'R17 test' }
    const preview = await dry(args)
    expect(preview.preview).toMatchObject({
      action: 'save-price-rule', rule: { id: null, sku: 'TEST-SKU-1', channel: 'EBAY', marketplace: 'IT', enabled: false },
      changes: { minPrice: { from: null, to: 22 }, maxPrice: { from: null, to: 45 } },
      bounds: { minPrice: 20, maxPrice: 50, applied: true }, wouldPick: { price: expect.any(Number) },
    })
    expect(await inside(() => database.client.repricingDecision.count())).toBe(0)
    const done = await run(args)
    expect(done.ok).toBe(true)
    const saved = await inside(() => database.client.repricingRule.findUniqueOrThrow({ where: { id: done.data!.priceRuleId } }))
    expect({ enabled: saved.enabled, min: Number(saved.minPrice), max: Number(saved.maxPrice), notes: saved.notes }).toEqual({ enabled: false, min: 22, max: 45, notes: 'R17 test' })
    expect(await inside(() => database.client.repricingDecision.count())).toBe(0)
    expect(await inside(() => database.client.channelListing.findFirstOrThrow({ where: { productId: ids.bounded } }))).toMatchObject({ price: expect.anything() })
    expect(Number((await inside(() => database.client.channelListing.findFirstOrThrow({ where: { productId: ids.bounded } }))).price)).toBe(30)
    expect(await inside(() => database.client.auditLog.findFirst({ where: { entityType: 'RepricingRule', entityId: saved.id }, select: { action: true, userId: true } }))).toEqual({ action: 'create_rule', userId: 'u-r17' })
    expect((tool().undo!.request(done.change!) as { refusal: string }).refusal).toContain('was created switched off')
    expect((await dry(args)).error).toBe(`TEST-SKU-1 already has a rule on EBAY IT: edit it (priceRuleId ${saved.id}).`)
  })

  it("an edit keeps the rule's switch; undo saves it as it was; channel, market and product never change", async () => {
    const edited = await run({ priceRuleId: ids.existing, minPrice: 12, strategy: 'beat_lowest_by_pct', beatPct: 2 })
    expect(edited).toMatchObject({ ok: true, data: { rule: { enabled: true }, changes: { minPrice: { from: 10, to: 12 }, strategy: { from: 'match_buy_box', to: 'beat_lowest_by_pct' }, beatPct: { from: null, to: 2 } } } })
    expect(await inside(() => database.client.repricingRule.findUniqueOrThrow({ where: { id: ids.existing } }))).toMatchObject({ enabled: true, strategy: 'beat_lowest_by_pct' })
    expect(await inside(() => tool().undo!.current(edited.change!))).toEqual(edited.change!.after)
    const back = tool().undo!.request(edited.change!) as { tool: string; args: Record<string, unknown> }
    expect(back).toEqual({ tool: 'save-price-rule', args: { priceRuleId: ids.existing, minPrice: 10, maxPrice: 40, strategy: 'match_buy_box', beatPct: null, beatAmount: null, activeFromHour: null, activeToHour: null, activeDays: [], notes: null } })
    expect(tool().input.safeParse(back.args).success).toBe(true)
    expect((await run(back.args)).ok).toBe(true)
    expect(await inside(() => database.client.repricingRule.findUniqueOrThrow({ where: { id: ids.existing } }))).toMatchObject({ strategy: 'match_buy_box', beatPct: null })

    expect((await dry({ priceRuleId: ids.existing, channel: 'AMAZON' })).error).toBe('TEST-SKU-2 on EBAY IT: a rule\'s channel never changes — delete it in Nexus and create one.')
    expect((await dry({ priceRuleId: ids.existing, notes: null, minPrice: 10 })).error).toBe('TEST-SKU-2 on EBAY IT: nothing to change.')
    expect((await dry({ priceRuleId: ids.otherRule, minPrice: 1.5 })).error).toBe(`There is no repricing rule ${ids.otherRule} in this business (not found).`)
  })
})
