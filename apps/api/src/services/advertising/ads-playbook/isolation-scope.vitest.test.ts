/**
 * ADS PLAYBOOK PB-7 — the Owner's rule 3 on a real PostgreSQL with the production schema and every business policy
 * (PGlite), business profiles ON: isolation keeps ONE product's own campaigns apart and never touches another product
 * that buys the same keyword. Values are made up (public repo); the negative write service is a spy (nothing leaves
 * the process).
 *
 *   two products, one keyword   products A and B (two parents) each run their own linked Exact | Category (live exact
 *                               "test x") and Phrase | Category (search term "test x"); one adopted campaign
 *                               advertises BOTH and is linked to A. A's run writes only into A's ad groups — the exact
 *                               "test x" only into A's Phrase ad group — and not once into B's or the shared one; the
 *                               shared campaign is left out with its reason; B's "test x" stays a positive keyword.
 *                               B's run is the mirror. A's brand phrase never reaches B's category slot.
 *   winners stay                a search that wins in B's Phrase ad group (the harvest bar where the strategy sets
 *                               none) is not negated there until its exact keyword wins too
 *   the rule                    syncIsolationRule saves it once, off, a dry run, PROPOSE; a dry run lists its items;
 *                               another business cannot compile this business's playbook
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const { write } = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock('../ads-negative-kw.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ads-negative-kw.service.js')>()),
  writeNegativeKeyword: write,
}))

import { SLOT } from './doc.js'
import { compileIsolationFor, isolateProduct, runIsolation, syncIsolationRule } from './isolation-run.js'
import type { IsolationAction } from './isolation.js'

const A = 'pb7_scope_alpha'
const B = 'pb7_scope_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = {
  rowA: '', rowB: '', childA: '', childB: '',
  gAexact: 'g-a-exact', gAphrase: 'g-a-phrase', gAbrand: 'g-a-brand', gShared: 'g-shared', gBexact: 'g-b-exact', gBphrase: 'g-b-phrase', gAde: 'g-a-de',
}
const actionOf = async (playbookId: string): Promise<IsolationAction> => {
  const out = await compileIsolationFor(playbookId)
  if ('problems' in out) throw new Error(out.problems.join('; '))
  return out.compiled.action
}
type Call = { adGroupId: string; keywordText: string; matchType: string; userId: string; protectConverting: unknown }
const calls = () => write.mock.calls.map(([args]) => args as Call)
const searchTerm = (adGroupExt: string, query: string, orders: number, daysAgo = 3) => db().amazonAdsSearchTerm.create({
  data: {
    profileId: 'test-profile', marketplace: 'IT', adProduct: 'SP', date: new Date(Date.now() - daysAgo * 86_400_000), campaignId: `EXT-C-${adGroupExt}`, adGroupId: `EXT-${adGroupExt}`,
    query, impressions: 200, clicks: 12, costMicros: 6_000_000n, currencyCode: 'EUR', orders7d: orders, sales7dCents: orders * 3000,
  },
})

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    const parentA = (await c.product.create({ data: { sku: 'TEST-PB7-A', name: 'Test A', basePrice: '10.00', isParent: true, amazonAsin: 'B0TESTPA01' } })).id
    ids.childA = (await c.product.create({ data: { sku: 'TEST-PB7-A-V1', name: 'Test A v1', basePrice: '10.00', parentId: parentA, amazonAsin: 'B0TESTA001' } })).id
    const parentB = (await c.product.create({ data: { sku: 'TEST-PB7-B', name: 'Test B', basePrice: '10.00', isParent: true, amazonAsin: 'B0TESTPB01' } })).id
    ids.childB = (await c.product.create({ data: { sku: 'TEST-PB7-B-V1', name: 'Test B v1', basePrice: '10.00', parentId: parentB, amazonAsin: 'B0TESTB001' } })).id

    const doc = templateDoc()
    doc.structure.slots.splice(2, 0, SLOT.parse({ key: 'phrase-category', targeting: 'KEYWORD', match: 'PHRASE', intent: 'CATEGORY', rankRole: 'research', feeds: ['category'], nameParts: ['Phrase', 'Category'] }))
    doc.bids.ladder['phrase-category'] = 1
    const template = await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc: doc as never, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', templateId: template.id, updatedBy: 'user:test' } })
    const row = (scopeId: string, token: string) => c.adsPlaybook.create({ data: {
      market: 'IT', level: 'PRODUCT', scopeId, label: `${token} (IT)`, enrolled: true, state: 'RUNNING', nameToken: token,
      dailyBudgetCents: 1000, baseBidCents: 40, terms: { brand: [token.toLowerCase()], category: [{ text: 'test x', exactAtStart: true }] }, updatedBy: 'user:test',
    } })
    ids.rowA = (await row(parentA, 'TESTA')).id
    ids.rowB = (await row(parentB, 'TESTB')).id

    /** One live campaign with one ad group, its product ads and its positive keywords, linked to a playbook slot. */
    const campaign = async (adGroupId: string, name: string, products: Array<{ productId: string; asin: string }>, keywords: Array<[string, string]>, link: { playbookId: string; key: string; origin?: string }, marketplace = 'IT') => {
      const made = await c.campaign.create({ data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace, externalCampaignId: `EXT-C-${adGroupId}`, dailyBudget: '10.00', startDate: new Date(), targetingType: 'MANUAL' } as never })
      await c.adGroup.create({ data: { id: adGroupId, campaignId: made.id, name, externalAdGroupId: `EXT-${adGroupId}`, defaultBidCents: 30 } as never })
      for (const p of products) await c.adProductAd.create({ data: { adGroupId, productId: p.productId, asin: p.asin } })
      for (const [text, match] of keywords) {
        await c.adTarget.create({ data: { adGroupId, kind: 'KEYWORD', expressionType: match, expressionValue: text, bidCents: 40, status: 'ENABLED', isNegative: false, externalTargetId: `EXT-T-${adGroupId}-${text}` } as never })
      }
      await c.adsPlaybookLink.create({ data: { playbookId: link.playbookId, kind: 'slot', key: link.key, refId: made.id, adGroupId, origin: link.origin ?? 'built', compiledVersion: 1, updatedBy: 'user:test' } })
    }
    const a = [{ productId: ids.childA, asin: 'B0TESTA001' }]
    const b = [{ productId: ids.childB, asin: 'B0TESTB001' }]
    await campaign(ids.gAexact, 'TESTA | IT | Exact | Category', a, [['test x', 'EXACT']], { playbookId: ids.rowA, key: 'exact-category' })
    await campaign(ids.gAphrase, 'TESTA | IT | Phrase | Category', a, [['test x', 'PHRASE']], { playbookId: ids.rowA, key: 'phrase-category' })
    await campaign(ids.gAbrand, 'TESTA | IT | Exact | Brand', a, [['testa jacket', 'EXACT']], { playbookId: ids.rowA, key: 'exact-brand' })
    await campaign(ids.gShared, 'Test shared | IT | Broad', [...a, ...b], [['test x', 'BROAD']], { playbookId: ids.rowA, key: 'broad-category', origin: 'adopted' })
    await campaign(ids.gBexact, 'TESTB | IT | Exact | Category', b, [['test x', 'EXACT']], { playbookId: ids.rowB, key: 'exact-category' })
    await campaign(ids.gBphrase, 'TESTB | IT | Phrase | Category', b, [['test x', 'PHRASE']], { playbookId: ids.rowB, key: 'phrase-category' })
    // A's own campaign in another market, linked to A's IT row: never in its IT scope.
    await campaign(ids.gAde, 'TESTA | DE | Auto', a, [], { playbookId: ids.rowA, key: 'auto' }, 'DE')
    for (const g of [ids.gAphrase, ids.gShared, ids.gBphrase]) await searchTerm(g, 'test x', 0)
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const created = (over: Record<string, unknown> = {}) => ({ outcome: 'created', mode: 'live', externalTargetId: 'EXT-NEG', reachedAmazon: true, adTargetId: 'neg-row', refusal: null, error: null, rawResponse: null, ...over })

describe('PB-7 — two products, one keyword: each product\'s isolation stays inside its own campaigns', () => {
  it('A\'s run writes only into A\'s ad groups; the shared campaign is left out with its reason; B is never touched', async () => {
    write.mockReset().mockResolvedValue(created())
    const run = await inA(async () => isolateProduct({ action: await actionOf(ids.rowA), actor: 'automation:test-rule', dryRun: false }))
    if ('refused' in run) throw new Error(run.refused)
    const all = calls()
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((c) => [ids.gAexact, ids.gAphrase].includes(c.adGroupId))).toBe(true)
    expect(all.filter((c) => [ids.gBexact, ids.gBphrase, ids.gShared, ids.gAbrand, ids.gAde].includes(c.adGroupId))).toEqual([])
    // The exact "test x" only into A's Phrase ad group; A's brand as a phrase into A's category slots.
    expect(all.filter((c) => c.keywordText === 'test x').map((c) => `${c.matchType}:${c.adGroupId}`)).toEqual([`EXACT:${ids.gAphrase}`])
    expect(all.filter((c) => c.matchType === 'PHRASE').map((c) => c.adGroupId).sort()).toEqual([ids.gAexact, ids.gAphrase].sort())
    expect(all.every((c) => c.userId === 'automation:test-rule' && c.protectConverting === null)).toBe(true)
    expect(run.scope.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: 'broad-category', adGroupId: ids.gShared, why: expect.stringMatching(/also advertises TEST-PB7-B-V1, which is not this product/) }),
      expect.objectContaining({ slot: 'auto', adGroupId: ids.gAde, why: 'its campaign runs in DE, not IT' }),
    ]))
    expect(run.scope.excluded).toHaveLength(2)
    expect(run.written).toMatchObject({ added: all.length, local: 0, refused: [], failed: [] })
    // B's "test x" is still B's own positive keyword, in both of B's campaigns.
    const bTargets = await inA(() => db().adTarget.findMany({ where: { adGroupId: { in: [ids.gBexact, ids.gBphrase] } }, select: { expressionValue: true, isNegative: true, status: true } }))
    expect(bTargets).toHaveLength(2)
    expect(bTargets.every((t) => t.expressionValue === 'test x' && !t.isNegative && String(t.status) === 'ENABLED')).toBe(true)
  })

  it('B\'s run is the mirror: only B\'s Phrase ad group, and A\'s brand phrase never reaches B\'s category slots', async () => {
    write.mockReset().mockResolvedValue(created())
    const run = await inA(async () => isolateProduct({ action: await actionOf(ids.rowB), actor: 'automation:test-rule-b', dryRun: false }))
    if ('refused' in run) throw new Error(run.refused)
    expect(calls().map((c) => `${c.matchType}:${c.keywordText}:${c.adGroupId}`)).toEqual([`EXACT:test x:${ids.gBphrase}`])
    // B has no brand slot: its own brand phrase goes nowhere (said), and A's ("testa") is not B's to write.
    expect(run.plan.leftAlone).toEqual([expect.objectContaining({ kind: 'brandPhrase', text: 'TESTB', adGroupId: null })])
    expect(run.scope.excluded).toEqual([])
  })

  it('winners stay: a search that wins in B\'s Phrase ad group is negated there only once its exact keyword wins too', async () => {
    await inA(() => searchTerm(ids.gBphrase, 'test x', 3, 5))
    write.mockReset().mockResolvedValue(created())
    const held = await inA(async () => isolateProduct({ action: await actionOf(ids.rowB), actor: 'automation:test-rule-b', dryRun: false }))
    if ('refused' in held) throw new Error(held.refused)
    expect(calls()).toEqual([])
    expect(held.plan.leftAlone).toContainEqual(expect.objectContaining({ adGroupId: ids.gBphrase, why: expect.stringMatching(/"test x" wins here/) }))

    await inA(() => searchTerm(ids.gBexact, 'test x', 3, 5))
    write.mockReset().mockResolvedValue(created())
    await inA(async () => isolateProduct({ action: await actionOf(ids.rowB), actor: 'automation:test-rule-b', dryRun: false }))
    expect(calls().map((c) => `${c.matchType}:${c.keywordText}:${c.adGroupId}`)).toEqual([`EXACT:test x:${ids.gBphrase}`])
  })
})

describe('PB-7 — a product that left its playbook, or a stopped playbook', () => {
  for (const [what, data, why] of [
    ['un-enrolled', { enrolled: false }, /no longer in its ads playbook/],
    ['stopped', { state: 'STOPPED' }, /playbook is stopped/],
  ] as const) {
    it(`${what}: a dry run proposes nothing, with the reason; an accepted card is refused and writes nothing`, async () => {
      await inA(() => db().adsPlaybook.update({ where: { id: ids.rowB }, data }))
      try {
        write.mockReset().mockResolvedValue(created())
        const action = await inA(() => actionOf(ids.rowB))
        const dry = await inA(() => runIsolation({ action: action as never, ruleId: 'test-rule-b', dryRun: true, preview: true }))
        expect(dry).toMatchObject({ ok: true, output: { noChange: true, why: expect.stringMatching(why) } })
        const accept = await inA(() => runIsolation({ action: { ...action, items: [{ text: 'test x', match: 'EXACT', adGroupId: ids.gBphrase }] } as never, ruleId: 'test-rule-b', dryRun: false }))
        expect(accept).toMatchObject({ ok: false, error: expect.stringMatching(why) })
        expect(write).not.toHaveBeenCalled()
      } finally {
        await inA(() => db().adsPlaybook.update({ where: { id: ids.rowB }, data: { enrolled: true, state: 'RUNNING' } }))
      }
    })
  }
})

describe('PB-7 — the compiled rule', () => {
  it('saved once, off, a dry run, PROPOSE, linked to the playbook; the same sync again writes nothing', async () => {
    const first = await inA(() => syncIsolationRule(ids.rowA, { enabled: false, actor: 'user:test' }))
    expect(first).toMatchObject({ created: true, changed: true, enabled: false, problems: [] })
    const rule = await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: first.ruleId! } }))
    // Filed under its own market (its IT campaigns' code), not the whole account — the DE campaign does not move it.
    expect(rule).toMatchObject({ domain: 'advertising', trigger: 'SCHEDULE', enabled: false, dryRun: true, autonomyLevel: 'PROPOSE', maxExecutionsPerDay: 1, name: 'TESTA (IT) — isolation', scopeMarketplace: 'IT' })
    expect((rule.actions as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'isolate_product_terms', playbookId: ids.rowA, market: 'IT', handover: 'proven' })
    expect(await inA(() => db().adsPlaybookLink.findFirst({ where: { playbookId: ids.rowA, kind: 'isolationRule' } }))).toMatchObject({ key: 'isolation', refId: first.ruleId })
    expect(await inA(() => syncIsolationRule(ids.rowA, { enabled: false, actor: 'user:test' }))).toMatchObject({ ruleId: first.ruleId, created: false, changed: false })
  })

  it('a START switches it on; a later build or stop re-sync never switches it off (the playbook never does)', async () => {
    const started = await inA(() => syncIsolationRule(ids.rowA, { enabled: true, actor: 'user:test' }))
    expect(started).toMatchObject({ enabled: true, created: false })
    expect(await inA(() => syncIsolationRule(ids.rowA, { enabled: false, actor: 'user:test' }))).toMatchObject({ ruleId: started.ruleId, enabled: true })
    expect((await inA(() => db().automationRule.findUniqueOrThrow({ where: { id: started.ruleId! } }))).enabled).toBe(true)
  })

  it('a dry run lists the items an accept applies, and the shared campaign it leaves out', async () => {
    write.mockReset()
    const action = await inA(() => actionOf(ids.rowA))
    const out = await inA(() => runIsolation({ action: action as never, ruleId: 'test-rule', dryRun: true, preview: true }))
    expect(write).not.toHaveBeenCalled()
    expect(out).toMatchObject({ type: 'isolate_product_terms', ok: true, output: { dryRun: true, noChange: false } })
    const output = out.output as { items: Array<{ adGroupId: string }>; scope: { excluded: Array<{ adGroupId: string }> } }
    expect(output.items.length).toBeGreaterThan(0)
    expect(output.items.every((i) => [ids.gAexact, ids.gAphrase].includes(i.adGroupId))).toBe(true)
    expect(output.scope.excluded.map((e) => e.adGroupId).sort()).toEqual([ids.gAde, ids.gShared].sort())
  })

  it('a variation\'s playbook keeps a campaign that also advertises a sibling variant: the same product, as a home is', async () => {
    const rowV = await inA(async () => {
      const c = db()
      const parentA = (await c.product.findFirstOrThrow({ where: { sku: 'TEST-PB7-A' } })).id
      const sibling = (await c.product.create({ data: { sku: 'TEST-PB7-A-V2', name: 'Test A v2', basePrice: '10.00', parentId: parentA, amazonAsin: 'B0TESTA002' } })).id
      const row = await c.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.childA, label: 'TEST-PB7-A-V1 (IT)', enrolled: true, updatedBy: 'user:test' } })
      const made = await c.campaign.create({ data: { name: 'TESTA V1 | IT | Broad', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-C-g-var', dailyBudget: '10.00', startDate: new Date(), targetingType: 'MANUAL' } as never })
      await c.adGroup.create({ data: { id: 'g-var', campaignId: made.id, name: 'TESTA V1 | IT | Broad', externalAdGroupId: 'EXT-g-var', defaultBidCents: 30 } as never })
      await c.adProductAd.create({ data: { adGroupId: 'g-var', productId: ids.childA, asin: 'B0TESTA001' } })
      await c.adProductAd.create({ data: { adGroupId: 'g-var', productId: sibling, asin: 'B0TESTA002' } })
      await c.adsPlaybookLink.create({ data: { playbookId: row.id, kind: 'slot', key: 'broad-category', refId: made.id, adGroupId: 'g-var', origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
      return row.id
    })
    const run = await inA(async () => isolateProduct({ action: await actionOf(rowV), actor: 'automation:test-rule-v', dryRun: true }))
    if ('refused' in run) throw new Error(run.refused)
    expect(run.scope).toMatchObject({ adGroups: 1, excluded: [] })
  })

  it('another business cannot compile this business\'s playbook', async () => {
    expect(await inB(() => compileIsolationFor(ids.rowA))).toEqual({ problems: ['No such playbook row in this business'] })
  })
})
