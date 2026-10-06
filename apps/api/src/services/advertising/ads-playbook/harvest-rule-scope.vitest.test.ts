/**
 * ADS PLAYBOOK PB-6b — the Owner's rule 3 for a compiled harvest rule, on a real PostgreSQL with the production schema
 * and every business policy (PGlite), business profiles ON. Nothing about the product family is mocked: only the writes
 * that would reach Amazon are. Values are made up (public repo).
 *
 * Products A and B both buy "test x". A's playbook adopted an Auto campaign that advertises A AND B; B's own Exact
 * campaign holds "test x" as a live exact keyword that has proved itself.
 *
 *   sync     the shared slot is left out of A's rule, named: it is not A's alone
 *   runtime  a compiled rule looks a home up only in its listed slots: B's "test x" is never A's home, so A creates its
 *            own exact "test x" — and never negates "test x" in its Auto source because B's keyword proved itself
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const writes = vi.hoisted(() => ({
  createKeywordLocal: vi.fn(async (a: { adGroupId: string }) => ({ id: `k-${a.adGroupId}`, externalTargetId: `amz-${a.adGroupId}` })),
  createTargetLocal: vi.fn(async () => ({ id: 'pt-1', externalTargetId: 'amz-pt-1', mode: 'live' })),
  writeNegativeKeyword: vi.fn(async () => ({ outcome: 'created', mode: 'live', externalTargetId: 'amz-neg-1', reachedAmazon: true, adTargetId: 'n-1', refusal: null, error: null })),
  writeNegativeProductTarget: vi.fn(async () => ({ outcome: 'created', mode: 'live', externalTargetId: 'amz-negp-1', reachedAmazon: true, adTargetId: 'n-2', refusal: null, error: null })),
}))
vi.mock('../../automation-rule.service.js', () => ({ ACTION_HANDLERS: {} as Record<string, unknown>, getFieldPath: vi.fn() }))
vi.mock('../ads-mutation.service.js', () => ({ updateCampaignWithSync: vi.fn(), updateAdGroupWithSync: vi.fn(), updateAdTargetWithSync: vi.fn() }))
vi.mock('../ads-create.service.js', () => ({ createKeywordLocal: writes.createKeywordLocal, createTargetLocal: writes.createTargetLocal, pushExistingKeyword: vi.fn() }))
vi.mock('../ads-negative-kw.service.js', () => ({ createNegative: vi.fn(), writeNegativeKeyword: writes.writeNegativeKeyword, writeNegativeProductTarget: writes.writeNegativeProductTarget }))

import { ACTION_HANDLERS } from '../../automation-rule.service.js'
import '../automation-action-handlers.js'
import { syncHarvestRule } from './harvest-rule.js'

const A = 'pb6b_scope_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const ids = { row: '', groups: {} as Record<string, string> }
type Json = Record<string, any>

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    const c = db()
    const a = await c.product.create({ data: { sku: 'TEST-PB6B-A', name: 'Test product A', basePrice: '10.00', amazonAsin: 'B0TESTPBA1' } })
    const b = await c.product.create({ data: { sku: 'TEST-PB6B-B', name: 'Test product B', basePrice: '10.00', amazonAsin: 'B0TESTPBB1' } })
    const template = await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Amazon IT', templateId: template.id, updatedBy: 'user:test' } })
    const row = await c.adsPlaybook.create({ data: {
      market: 'IT', level: 'PRODUCT', scopeId: a.id, label: 'TEST-PB6B-A (IT)', enrolled: true, state: 'RUNNING', nameToken: 'TESTPBA',
      dailyBudgetCents: 1000, baseBidCents: 40, terms: { brand: [], category: [], competitor: [], competitorAsins: [], negatives: [] }, updatedBy: 'user:test',
    } })
    ids.row = row.id
    const group = async (key: string, targetingType: 'AUTO' | 'MANUAL', products: Array<{ id: string; asin: string }>, link: boolean) => {
      const campaign = await c.campaign.create({ data: { name: `Test ${key}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', targetingType, marketplace: 'IT', externalCampaignId: `EC-${key}`, dailyBudget: '5.00', startDate: new Date() } as never })
      const g = await c.adGroup.create({ data: { campaignId: campaign.id, name: `Test ${key}`, externalAdGroupId: `EAG-${key}` } })
      for (const p of products) await c.adProductAd.create({ data: { adGroupId: g.id, productId: p.id, asin: p.asin } })
      if (link) await c.adsPlaybookLink.create({ data: { playbookId: row.id, kind: 'slot', key, refId: campaign.id, adGroupId: g.id, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
      ids.groups[key] = g.id
      return g
    }
    const pa = { id: a.id, asin: 'B0TESTPBA1' }
    const pb = { id: b.id, asin: 'B0TESTPBB1' }
    await group('auto', 'AUTO', [pa, pb], true) // adopted, and it advertises B too
    await group('broad-category', 'MANUAL', [pa], true)
    await group('exact-category', 'MANUAL', [pa], true)
    await group('exact-brand', 'MANUAL', [pa], true)
    const bExact = await group('b-exact', 'MANUAL', [pb], false) // B's own campaign, no link to A
    await c.adTarget.create({ data: { adGroupId: bExact.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test x', bidCents: 30, status: 'ENABLED', externalTargetId: 'amz-kw-b-x' } })
    // "test x" sold in A's Auto (a winner to graduate), and B's exact "test x" has proved itself in B's campaign.
    const day = new Date(Date.now() - 5 * 86400_000)
    for (const key of ['auto', 'b-exact']) {
      await c.amazonAdsSearchTerm.create({ data: {
        profileId: 'test-profile', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: day, campaignId: `EC-${key}`, adGroupId: `EAG-${key}`,
        query: 'test x', currencyCode: 'EUR', impressions: 300, clicks: 12, costMicros: 6_000_000n, orders7d: 3, sales7dCents: 9000,
      } as never })
    }
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('PB-6b — rule 3 for a compiled harvest rule', () => {
  it('sync: the adopted slot that also advertises another product is left out of the rule, named', async () => {
    const out = await inA(() => syncHarvestRule(ids.row, { enabled: false }))
    if (!out.saved) throw new Error(out.problems.join('; '))
    expect(out.warnings.join('\n')).toMatch(/The slot "auto" is left out: its ad group also advertises TEST-PB6B-B, which is not this product/)
    const action = ((await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: out.ruleId } }))).actions as Json[])[0]
    expect(action.homeScope).not.toContain(ids.groups.auto)
    expect((action.sources as Json[]).map((s) => s.adGroupId)).not.toContain(ids.groups.auto)
    expect(JSON.stringify(action)).not.toContain(ids.groups['b-exact'])
  })

  it('runtime: B\'s proven exact "test x" never stops A — A creates its own, and its Auto source is never negated for it', async () => {
    const g = ids.groups
    // A compiled rule that still lists the shared Auto slot (saved before it advertised B): the run itself holds rule 3.
    const action = {
      type: 'harvest_and_negate', v: 2, control: 'manual', mode: 'harvest', playbookId: ids.row, market: 'IT', cadenceDays: null,
      homeScope: [g.auto, g['broad-category'], g['exact-category'], g['exact-brand']],
      sources: [{ adGroupId: g.auto, campaignId: 'c-auto', harvestFrom: true, graduate: ['EXACT'], negate: ['EXACT'], graduateProduct: false, negateProduct: true, negateOnLanding: false, negateSource: true, destinations: { EXACT: g['exact-category'] } }],
    }
    const run = (dryRun: boolean) => inA(() => (ACTION_HANDLERS.harvest_and_negate as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Json }>)(action, {}, { dryRun, ruleId: 'rule-pb6b-scope' }))
    const dry = await run(true)
    expect(dry.output?.items).toEqual([{ kind: 'graduation', query: 'test x', externalAdGroupId: 'EAG-auto', step: 'create' }])
    const live = await run(false)
    expect(writes.createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: g['exact-category'], keywordText: 'test x', matchType: 'EXACT' }))
    expect(writes.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(live.output).toMatchObject({ keywordsGraduated: 1, isolationNegativesAdded: 0 })
    // B's keyword is untouched.
    expect(await inA(() => db().adTarget.findFirstOrThrow({ where: { adGroupId: g['b-exact'], expressionValue: 'test x' } }))).toMatchObject({ isNegative: false, status: 'ENABLED' })
  })
})
