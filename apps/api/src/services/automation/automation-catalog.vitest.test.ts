/**
 * R5 (MCP full control, part 06) — the automation catalog: all 39 automations, each at the level its own source says,
 * held under what the server's env allows; an automation the env switches off reads OFF and names the flag.
 *
 * On a real PostgreSQL (PGlite, production schema), in one business. Env flags are set per test and restored.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { isValidPermission } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { AUTOMATION_IDS, automationAdapter, getAutomationCatalog, getAutomationDetail, type AutomationEntry } from './automation-catalog.service.js'
import { resolveAutonomy } from '../advertising/ads-autonomy.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)

const ENV_KEYS = [
  'NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_ADS_AUTOMATION_KILL', 'NEXUS_AMAZON_ADS_MODE', 'NEXUS_BUDGET_ENFORCE_APPLY', 'NEXUS_ENABLE_RANK_DEFEND',
  'NEXUS_ENABLE_EBAY_ADS_SYNC', 'NEXUS_MARKETING_WRITES_EBAY', 'NEXUS_ENABLE_REPRICING_EVALUATOR', 'NEXUS_REPRICER_LIVE', 'NEXUS_ENABLE_REVIEW_INGEST',
  'NEXUS_ENABLE_OUTBOUND_EMAILS', 'NEXUS_ENABLE_FLEET_SWEEP_CRON', 'NEXUS_AI_KILL_SWITCH', 'NEXUS_ENABLE_AUTOMATION_RULE_CRON', 'NODE_ENV',
]
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
function env(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
/** The Amazon ads crons on, live, no kill. */
const adsOn = { NEXUS_ENABLE_AMAZON_ADS_CRON: '1', NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_ADS_AUTOMATION_KILL: undefined }

const ids: Record<string, string> = {}
async function catalog(): Promise<Record<string, AutomationEntry>> {
  return Object.fromEntries((await inside(() => getAutomationCatalog())).map((e) => [e.id, e]))
}

beforeAll(async () => {
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    const rule = (data: Record<string, unknown>) => db.automationRule.create({ data: { trigger: 'SCHEDULE', ...data } as never })
    ids.adsAuto = (await rule({ domain: 'advertising', name: 'TEST auto rule', enabled: true, dryRun: false, autonomyLevel: 'AUTO', actions: [{ type: 'bid_down', percent: 5 }] })).id
    ids.adsObserve = (await rule({ domain: 'advertising', name: 'TEST observe rule', enabled: true, autonomyLevel: 'OBSERVE' })).id
    ids.adsOff = (await rule({ domain: 'advertising', name: 'TEST off rule', enabled: false })).id
    ids.replenishment = (await rule({ domain: 'replenishment', name: 'TEST replenishment rule', enabled: true, autonomyLevel: 'PROPOSE', trigger: 'recommendation_generated' })).id
    ids.pool = (await db.budgetPool.create({ data: { name: 'TEST pool', totalDailyBudgetCents: 5000, enabled: true, dryRun: true } })).id
    ids.ebay = (await db.ebayAdsRule.create({ data: { name: 'TEST eBay rule', enabled: true, mode: 'AUTOPILOT', trigger: { scope: 'CPS_AD', all: [] }, action: { type: 'adjust_ad_rate' } } })).id
    const product = await db.product.create({ data: { sku: 'TEST-SKU-1', name: 'Test product', basePrice: '10.00', totalStock: 1 } })
    ids.repricing = (await db.repricingRule.create({ data: { productId: product.id, channel: 'AMAZON', marketplace: 'IT', enabled: true, minPrice: '8.00', maxPrice: '12.00', strategy: 'match_buy_box' } })).id
    ids.reviewRule = (await db.reviewRule.create({ data: { name: 'TEST review request', isActive: true, scope: 'EBAY' } })).id
    await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'Italy', dailyCapCents: 5000 } })
  })
}, 180_000)

afterEach(() => env(saved))
afterAll(async () => {
  env(saved)
  await database?.close()
}, 30_000)

describe('R5 — the automation catalog', () => {
  it('lists all 39 automations of the inventory, in order, each with a key, a view permission and a preview statement', async () => {
    const entries = await inside(() => getAutomationCatalog())
    expect(entries.map((e) => e.id)).toEqual([...AUTOMATION_IDS])
    expect(new Set(entries.map((e) => e.key)).size).toBe(39)
    for (const e of entries) {
      expect(e.name && e.what && e.previewNote, e.id).toBeTruthy()
      expect(isValidPermission(automationAdapter(e.id)!.view), e.id).toBe(true)
      expect(automationAdapter(e.key), e.key).toBe(automationAdapter(e.id))
    }
  })

  it('env says off: every Amazon ads engine reads OFF and names NEXUS_ENABLE_AMAZON_ADS_CRON, even with an AUTO rule', async () => {
    env({ NEXUS_ENABLE_AMAZON_ADS_CRON: undefined })
    const all = await catalog()
    for (const id of ['A1', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12']) {
      expect(all[id].level, id).toBe('OFF')
      expect(all[id].levelReason, id).toContain('NEXUS_ENABLE_AMAZON_ADS_CRON')
      expect(all[id].env.flags.find((f) => f.flag === 'NEXUS_ENABLE_AMAZON_ADS_CRON')?.allows, id).toBe(false)
    }
    // What the business set is still shown beside it: an AUTO rule, held by a dial never set (SUGGEST: it proposes).
    expect(all.A1.business).toEqual({ level: 'PROPOSE', reason: 'The account ads dial is SUGGEST (never set) — it proposes, nothing acts.' })
    expect(all.A1.sample?.[0]).toEqual({ id: ids.adsAuto, name: 'TEST auto rule', level: 'AUTO' })
  })

  it("A1 — the rules' own levels, held under the account dial; the dial's halt stops them", async () => {
    env(adsOn)
    await inside(() => database.client.adsAutomationState.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', autonomy: 'AUTO' }, update: { autonomy: 'AUTO', halted: false } }))
    let all = await catalog()
    expect(all.A1.level).toBe('AUTO')
    expect(all.A1.rows).toEqual({ total: 3, byLevel: { AUTO: 1, OBSERVE: 1, OFF: 1 } })
    // Each row is at the level the engine resolves it to.
    const detail = await inside(() => getAutomationDetail(automationAdapter('A1')!))
    const stored = await inside(() => database.client.automationRule.findMany({ where: { domain: 'advertising' } }))
    for (const row of detail.rows!) expect(row.level, row.name).toBe(resolveAutonomy(stored.find((r) => r.id === row.id)!))

    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { autonomy: 'SUGGEST' } }))
    all = await catalog()
    expect(all.A1.level).toBe('PROPOSE')
    expect(all.A1.levelReason).toContain('SUGGEST')

    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { autonomy: 'AUTO', halted: true, haltReason: 'TEST halt' } }))
    all = await catalog()
    expect(all.A1.level).toBe('OFF')
    expect(all.A1.levelReason).toContain('TEST halt')
    expect(all.A3.level).toBe('OFF')
    await inside(() => database.client.adsAutomationState.update({ where: { id: 'singleton' }, data: { halted: false, haltReason: null } }))
  })

  it("the kill switch and sandbox mode hold the ads engines: OFF, then OBSERVE (writes reach only Amazon's sandbox)", async () => {
    env({ ...adsOn, NEXUS_ADS_AUTOMATION_KILL: '1' })
    expect((await catalog()).A9.level).toBe('OFF')
    env({ ...adsOn, NEXUS_AMAZON_ADS_MODE: 'sandbox' })
    const all = await catalog()
    expect(all.A1.level).toBe('OBSERVE')
    expect(all.A1.levelReason).toContain('NEXUS_AMAZON_ADS_MODE')
  })

  it("A9 — a pool switched on as a dry run is OBSERVE; A8 — the job's own strict check decides, not envEnabled", async () => {
    env({ ...adsOn, NEXUS_BUDGET_ENFORCE_APPLY: 'true' })
    const all = await catalog()
    expect(all.A9.level).toBe('OBSERVE')
    expect(all.A9.sample).toEqual([{ id: ids.pool, name: 'TEST pool', level: 'OBSERVE' }])
    // jobs/ad-budget-enforce.job.ts applies only with exactly '1'; 'true' computes and never applies.
    expect(all.A8.env.ceiling).toBe('OBSERVE')
    expect(all.A8.env.flags.find((f) => f.flag === 'NEXUS_BUDGET_ENFORCE_APPLY')?.allows).toBe(false)
  })

  it('A10 — rank-defend needs NEXUS_ENABLE_RANK_DEFEND=1 on top of the ads crons', async () => {
    env({ ...adsOn, NEXUS_ENABLE_RANK_DEFEND: undefined })
    const all = await catalog()
    expect(all.A10.env.ceiling).toBe('OFF')
    expect(all.A10.env.flags.find((f) => f.flag === 'NEXUS_ENABLE_RANK_DEFEND')?.says).toContain('hourly bid plans do not run')
  })

  it("E1 — an AUTOPILOT rule under the eBay dial; eBay's sandbox holds it at OBSERVE", async () => {
    env({ NEXUS_ENABLE_EBAY_ADS_SYNC: '1', NEXUS_MARKETING_WRITES_EBAY: '1' })
    let all = await catalog()
    // No dial row: the eBay dial defaults to OFF.
    expect(all.E1.business.level).toBe('OFF')
    await inside(() => database.client.marketingAutomationState.create({ data: { channel: 'EBAY', globalMode: 'SUGGEST' } }))
    all = await catalog()
    expect(all.E1.level).toBe('PROPOSE')
    await inside(() => database.client.marketingAutomationState.updateMany({ where: { channel: 'EBAY' }, data: { globalMode: 'AUTO' } }))
    expect((await catalog()).E1.level).toBe('AUTO')
    env({ NEXUS_ENABLE_EBAY_ADS_SYNC: '1', NEXUS_MARKETING_WRITES_EBAY: undefined })
    all = await catalog()
    expect(all.E1.level).toBe('OBSERVE')
    expect(all.E1.levelReason).toContain('NEXUS_MARKETING_WRITES_EBAY')
    env({ NEXUS_ENABLE_EBAY_ADS_SYNC: '0' })
    expect((await catalog()).E1.level).toBe('OFF')
  })

  it('N1 — repricing: OBSERVE until NEXUS_REPRICER_LIVE=1, OFF when the evaluator is switched off', async () => {
    env({ NEXUS_REPRICER_LIVE: undefined, NEXUS_ENABLE_REPRICING_EVALUATOR: undefined })
    let all = await catalog()
    expect(all.N1.level).toBe('OBSERVE')
    expect(all.N1.levelReason).toContain('NEXUS_REPRICER_LIVE')
    env({ NEXUS_REPRICER_LIVE: '1' })
    expect((await catalog()).N1.level).toBe('AUTO')
    env({ NEXUS_ENABLE_REPRICING_EVALUATOR: '0' })
    all = await catalog()
    expect(all.N1.level).toBe('OFF')
    expect(all.N1.levelReason).toContain('NEXUS_ENABLE_REPRICING_EVALUATOR')
  })

  it("N6 and N8 — a rule's level under its cron's flag; the mailer's pause wins", async () => {
    env({ NEXUS_ENABLE_AUTOMATION_RULE_CRON: '1', NEXUS_ENABLE_REVIEW_INGEST: '1', NEXUS_ENABLE_OUTBOUND_EMAILS: 'true' })
    let all = await catalog()
    expect(all.N6.level).toBe('PROPOSE')
    expect(all.N8.level).toBe('AUTO')
    await inside(() => database.client.reviewMailerState.create({ data: { id: 'default', isPaused: true } }))
    all = await catalog()
    expect(all.N8.level).toBe('OFF')
    expect(all.N8.levelReason).toContain('paused')
    env({ NEXUS_ENABLE_AUTOMATION_RULE_CRON: undefined })
    expect((await catalog()).N6.level).toBe('OFF')
  })

  it('settings and brakes have no level, only what is in force; the external engine says Nexus cannot read its switch', async () => {
    const all = await catalog()
    for (const id of ['A2', 'A13', 'A14', 'A15', 'A16', 'A18']) {
      expect(all[id].level, id).toBeNull()
      expect(all[id].state, id).toBeTruthy()
    }
    expect(all.A13.state).toContain('1 of 1 ceilings and bid policies in force')
    expect(all.A18.levelReason).toContain('BIDDING_DRY_RUN')
  })

  it('never writes: reading the catalog creates no dial or mailer row in a business that has none', async () => {
    const other = { workspaceId: 'ws_r5_other', actorUserId: null, membershipId: null, roleKeys: [] }
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`, [other.workspaceId])
    const counts = () => withWorkspace(other, async () => [
      await database.client.adsAutomationState.count(),
      await database.client.reviewMailerState.count(),
      await database.client.agentFleetState.count(),
      await database.client.marketingAutomationState.count(),
    ])
    expect(await counts()).toEqual([0, 0, 0, 0])
    const entries = await withWorkspace(other, () => getAutomationCatalog())
    expect(entries).toHaveLength(39)
    // Nothing of the first business shows here.
    expect(JSON.stringify(entries)).not.toContain('TEST ')
    expect(await counts()).toEqual([0, 0, 0, 0])
  })
})
