/**
 * ADS PLAYBOOK PB-6b — `syncHarvestRule` (harvest-rule.ts) on a real PostgreSQL with the production schema and every
 * business policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   build    the product's resolved playbook, its slot links (an archived campaign left out, said) and the strategy's goal
 *            compile into ONE rule: born disabled, a dry run that proposes only, one run a day, linked to the row
 *   start    a START switches the rule on — in a phase that turns the harvest off too, where no source is harvested from
 *   phase    once the phase harvests again, a re-sync makes the rule harvest; a re-sync never switches it off (rules.ts)
 *   business another business cannot sync (or see) this product's playbook
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { syncHarvestRule } from './harvest-rule.js'

const A = 'pb6b_sync_alpha'
const B = 'pb6b_sync_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { row: '', strategy: '', groups: {} as Record<string, string> }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    const product = await c.product.create({ data: { sku: 'TEST-PB6B-1', name: 'Test product', basePrice: '10.00', amazonAsin: 'B0TESTPB61' } })
    const template = await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Amazon IT', templateId: template.id, updatedBy: 'user:test' } })
    const row = await c.adsPlaybook.create({ data: {
      market: 'IT', level: 'PRODUCT', scopeId: product.id, label: 'TEST-PB6B-1 (IT)', enrolled: true, state: 'BUILT', nameToken: 'TESTPB6B',
      dailyBudgetCents: 1000, baseBidCents: 40, terms: { brand: ['testpb6b jacket'], category: [], competitor: ['rivalco'], competitorAsins: [], negatives: [] },
      updatedBy: 'user:test',
    } })
    ids.row = row.id
    ids.strategy = (await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test strategy (IT)', goal: 'LAUNCH', updatedBy: 'user:test' } })).id
    // The product's slots, built: every one linked with its ad group; the PAT campaign archived since.
    for (const key of ['auto', 'broad-category', 'exact-category', 'exact-brand', 'pat']) {
      const campaign = await c.campaign.create({ data: { name: `TESTPB6B | IT | ${key}`, type: 'SP', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), ...(key === 'pat' ? { status: 'ARCHIVED' } : {}) } as never })
      const group = await c.adGroup.create({ data: { campaignId: campaign.id, name: `TESTPB6B | IT | ${key}` } })
      ids.groups[key] = group.id
      await c.adsPlaybookLink.create({ data: { playbookId: row.id, kind: 'slot', key, refId: campaign.id, adGroupId: group.id, origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
    }
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

type Json = Record<string, any>

describe('PB-6b — syncHarvestRule', () => {
  let ruleId = ''

  it('at build: one rule, born disabled, a propose-only dry run once a day, linked to the product\'s playbook', async () => {
    const out = await inA(() => syncHarvestRule(ids.row, { enabled: false, actor: 'user:test' }))
    if (!out.saved) throw new Error(out.problems.join('; '))
    expect(out).toMatchObject({ created: true, changed: true, enabled: false, cadenceDays: 1 })
    expect(out.warnings.join('\n')).toMatch(/The slot "pat"'s campaign is archived: it is left out/)
    ruleId = out.ruleId
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(rule).toMatchObject({ domain: 'advertising', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', maxExecutionsPerDay: 1, createdBy: 'user:test' })
    const action = (rule.actions as Json[])[0]
    expect(action).toMatchObject({ type: 'harvest_and_negate', v: 2, control: 'manual', mode: 'both', playbookId: ids.row, market: 'IT', cadenceDays: 1 })
    expect(action).not.toHaveProperty('minOrders')
    const g = ids.groups
    expect(new Set(action.homeScope)).toEqual(new Set([g.auto, g['broad-category'], g['exact-category'], g['exact-brand']]))
    const auto = (action.sources as Json[]).find((s) => s.adGroupId === g.auto)!
    // The template has no competitor slot: the router hands competitor terms to Category; the PAT edge is left out.
    expect(auto.destinations).toEqual({
      EXACT: { router: 'intent', BRAND: g['exact-brand'], COMPETITOR: g['exact-category'], CATEGORY: g['exact-category'], brand: ['TESTPB6B', 'testpb6b jacket'], competitor: ['rivalco'] },
    })
    expect(auto).toMatchObject({ graduate: ['EXACT'], graduateProduct: false, negateOnLanding: false })
    expect((action.sources as Json[]).find((s) => s.adGroupId === g['broad-category'])!.destinations).toEqual({ EXACT: g['exact-category'] })
    expect(await inA(() => db().adsPlaybookLink.findFirst({ where: { kind: 'harvestRule' } }))).toMatchObject({ playbookId: ids.row, key: 'harvest', refId: ruleId, origin: 'built' })
  })

  it('a START in a phase that turns the harvest off: the rule is switched on, and no source is harvested from', async () => {
    await inA(() => db().adsStrategy.update({ where: { id: ids.strategy }, data: { goal: 'CLEAR_STOCK' } }))
    const out = await inA(() => syncHarvestRule(ids.row, { enabled: true }))
    expect(out).toMatchObject({ saved: true, ruleId, created: false, changed: true, enabled: true, cadenceDays: null })
    expect(out.warnings.join('\n')).toMatch(/CLEAR_STOCK phase turns the harvest off/)
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(rule).toMatchObject({ enabled: true, dryRun: true, autonomyLevel: 'PROPOSE' })
    expect(((rule.actions as Json[])[0].sources as Json[]).every((s) => s.harvestFrom === false)).toBe(true)
  })

  it('the phase changes: a re-sync makes the started rule harvest, and never switches it off', async () => {
    await inA(() => db().adsStrategy.update({ where: { id: ids.strategy }, data: { goal: 'LAUNCH' } }))
    const out = await inA(() => syncHarvestRule(ids.row, { enabled: false }))
    expect(out).toMatchObject({ saved: true, ruleId, created: false, changed: true, enabled: true, cadenceDays: 1 })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: ruleId } }))
    expect(((rule.actions as Json[])[0].sources as Json[]).every((s) => s.harvestFrom === true)).toBe(true)
    expect(await inA(() => syncHarvestRule(ids.row, { enabled: false }))).toMatchObject({ saved: true, ruleId, enabled: true, changed: false })
    expect(await inA(() => db().automationRule.count())).toBe(1)
  })

  it('another business cannot sync it, nor see the rule', async () => {
    expect(await inB(() => syncHarvestRule(ids.row, { enabled: true }))).toMatchObject({ saved: false, problems: ['No product playbook row has this id'] })
    expect(await inB(() => db().automationRule.findMany())).toEqual([])
  })
})
