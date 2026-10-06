/**
 * ADS PLAYBOOK PB-4 — the build DRY RUN (build-preview.ts, through readPlaybook view compile and the ads-playbook tool)
 * on a real PostgreSQL with the production schema and every business policy (PGlite), business profiles ON. Values are
 * made up (public repo).
 *
 *   built        every slot the product does not hold, named, budgeted, bid (the ladder clamped to the strategy's band)
 *   product ads  the children listed on Amazon in the market with an ASIN (never the parent's own ASIN)
 *   shared       Owner rule 3: a category term another product's campaign already buys is kept and listed (never
 *                skipped); one of the SAME product's campaigns outside the playbook buying it is skipped (template skip)
 *   linked       a slot linked to a live campaign is not built, and that campaign is neither a conflict nor a name clash
 *   money        a monthly cap the full-spend month would pass blocks, naming the cap (no amount in the words)
 *   gate         a market with no writable Amazon connection blocks, as a replication is blocked
 *   portfolio    one that exists by name in the market's ads profile is reused (never a Nexus-only local-pf- one)
 *   nothing      no campaign, ad group, target, run or playbook row is written
 *   money keys   the read tool hides exactly the money from a person without ad-spend money
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { readPlaybook } from './read.js'
import { PLAYBOOK_MONEY } from './doc.js'
import { RESTRICTED_FIELD_NAMES } from '../../../lib/auth/financial-fields.js'
import { callTool, type UserPrincipal } from '../../agents/call-tool.js'

const A = 'pb4_preview_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const ids = { parent: '', v1: '', v2: '', linked: '', other: '' }
type Json = Record<string, any>
const counts = () => inA(async () => ({
  campaigns: await db().campaign.count(), adGroups: await db().adGroup.count(), targets: await db().adTarget.count(),
  runs: await db().adBlueprintApplication.count(), rows: await db().adsPlaybook.count(), portfolios: await db().amazonAdsPortfolio.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    const c = db()
    ids.parent = (await c.product.create({ data: { sku: 'TEST-PB4-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true, amazonAsin: 'B0TESTPAR1' } })).id
    ids.v1 = (await c.product.create({ data: { sku: 'TEST-PB4-V1', name: 'Test v1', basePrice: '10.00', parentId: ids.parent, amazonAsin: 'B0TESTV001', fulfillmentMethod: 'FBA' } })).id
    ids.v2 = (await c.product.create({ data: { sku: 'TEST-PB4-V2', name: 'Test v2', basePrice: '10.00', parentId: ids.parent, amazonAsin: 'B0TESTV002', fulfillmentMethod: 'FBA' } })).id
    await c.product.create({ data: { sku: 'TEST-PB4-V3', name: 'Test v3 (not listed)', basePrice: '10.00', parentId: ids.parent, amazonAsin: 'B0TESTV003' } })
    for (const productId of [ids.parent, ids.v1, ids.v2]) {
      await c.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', listingStatus: 'ACTIVE' } as never })
    }
    const template = await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', doc: templateDoc() as never, updatedBy: 'user:test' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Amazon IT', templateId: template.id, updatedBy: 'user:test' } })
    const row = await c.adsPlaybook.create({ data: {
      market: 'IT', level: 'PRODUCT', scopeId: ids.parent, label: 'TEST-PB4-PARENT (IT)', enrolled: true, state: 'DRAFT', nameToken: 'TESTPB4',
      dailyBudgetCents: 404_040, baseBidCents: 40,
      terms: { brand: ['testpb4 jacket'], category: [{ text: 'test jacket', exactAtStart: true }, { text: 'test coat' }], competitor: [], competitorAsins: ['B0TESTRIV1'], negatives: [{ text: 'test kids', match: 'PHRASE' }] },
      updatedBy: 'user:test',
    } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test strategy (IT)', maxBidCents: 45, monthlySpendCapCents: 1_000_000, updatedBy: 'user:test' } })
    // PB-5a — the portfolio is reused only from the market's own ads profile, and never a Nexus-only (local-pf-) one.
    await c.amazonAdsConnection.create({ data: { profileId: 'test-profile', marketplace: 'IT', isActive: true, mode: 'sandbox' } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'test-profile', externalPortfolioId: 'local-pf-test-profile-testpb4', name: 'Test TESTPB4 IT' } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'other-profile', externalPortfolioId: 'test-pf-other', name: 'Test TESTPB4 IT' } })
    await c.amazonAdsPortfolio.create({ data: { profileId: 'test-profile', externalPortfolioId: 'test-pf-1', name: 'Test TESTPB4 IT' } })
    // Another product's live campaign buys "test coat" (a category term): kept and only listed (Owner rule 3).
    const other = await c.campaign.create({ data: { name: 'Other product | IT | Broad', type: 'SP', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } as never })
    ids.other = other.id
    const og = await c.adGroup.create({ data: { campaignId: other.id, name: 'Other group' } })
    await c.adProductAd.create({ data: { adGroupId: og.id, asin: 'B0TESTOTH1', sku: 'TEST-OTHER-1' } })
    await c.adTarget.create({ data: { adGroupId: og.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test coat', bidCents: 30 } })
    // The product's own Exact | Brand campaign, linked to its slot: not rebuilt, not a conflict, not a name clash.
    const linked = await c.campaign.create({ data: { name: 'TESTPB4 | IT | Exact | Brand', type: 'SP', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } as never })
    ids.linked = linked.id
    const lg = await c.adGroup.create({ data: { campaignId: linked.id, name: 'TESTPB4 | IT | Exact | Brand' } })
    await c.adTarget.create({ data: { adGroupId: lg.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket', bidCents: 30 } })
    await c.adsPlaybookLink.create({ data: { playbookId: row.id, kind: 'slot', key: 'exact-brand', refId: linked.id, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('the build dry run', () => {
  let out: Json
  let before: Awaited<ReturnType<typeof counts>>
  beforeAll(async () => {
    before = await counts()
    const read = await inA(() => readPlaybook({ view: 'compile', market: 'IT', productId: ids.parent }))
    if ('error' in read) throw new Error(read.error)
    out = read.data
  })

  it('the slots it does not hold, named and bid (the ladder clamped to the strategy\'s band); the linked one stays', () => {
    expect(out).toMatchObject({ view: 'compile', market: 'IT', product: { productId: ids.parent }, enrolled: true, compiles: true })
    expect(out.slots.map((s: Json) => [s.key, s.linked])).toEqual([['auto', false], ['broad-category', false], ['exact-category', false], ['exact-brand', true], ['pat', false]])
    expect(out.slots.find((s: Json) => s.key === 'exact-brand').campaign).toMatchObject({ name: 'TESTPB4 | IT | Exact | Brand' })
    expect(out.slots.find((s: Json) => s.key === 'exact-category')).toMatchObject({ startBidCents: 45, ladderBidCents: 52 })
    expect(out.campaigns.map((c: Json) => c.name)).toEqual(['TESTPB4 | IT | Auto', 'TESTPB4 | IT | Broad | Category', 'TESTPB4 | IT | Exact | Category', 'TESTPB4 | IT | PAT'])
  })

  it('advertises the children listed in the market with an ASIN, never the parent\'s own', () => {
    expect(out.productAds).toEqual([{ asin: 'B0TESTV001', skus: ['TEST-PB4-V1'] }, { asin: 'B0TESTV002', skus: ['TEST-PB4-V2'] }])
    expect(out.campaigns[0].adGroups[0].asins).toEqual(['B0TESTV001', 'B0TESTV002'])
    expect(out.warnings.join('\n')).toMatch(/1 product\(s\) of the family have an ASIN but no Amazon listing in IT/)
  })

  it('a category term another product\'s campaign buys is kept and listed, never skipped; the linked campaign\'s terms are no conflict', () => {
    expect(out.skippedShared).toEqual([])
    expect(out.sharedWithOtherProducts).toEqual([{ term: 'test coat', existing: [{ campaignName: 'Other product | IT | Broad', campaignId: ids.other }] }])
    const broad = out.campaigns.find((c: Json) => c.role === 'broad-category').adGroups[0].targets.filter((t: Json) => !t.isNegative).map((t: Json) => t.expression)
    expect(broad).toEqual(['test jacket', 'test coat'])
    expect(out.warnings.join('\n')).toMatch(/1 keyword\(s\) are also bought by your other products' campaigns \("test coat"\): allowed/)
    expect(out.blockers.join('\n')).not.toMatch(/bid against/)
  })

  it('blocks: the monthly cap at full spend (named, no amount) and a market Amazon cannot be written in; the portfolio is reused', () => {
    expect(out.allowed).toBe(false)
    expect(out.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/no writable production Amazon Ads connection/),
      expect.stringMatching(/add up to more than the monthly cap of Test strategy \(IT\)/),
    ]))
    expect(out.blockers.join(' ')).not.toMatch(/\d{4,}/)
    expect(out.strategy.caps).toEqual([expect.objectContaining({ over: true, source: { level: 'market', label: 'Test strategy (IT)' } })])
    expect(out.portfolio).toEqual({ name: 'Test TESTPB4 IT', does: 'reuse', portfolioId: 'test-pf-1' })
    expect(out.reach).toEqual({ writable: false, everWritten: false })
  })

  it('writes nothing: no campaign, ad group, target, run, playbook row or portfolio', async () => {
    expect(await counts()).toEqual(before)
  })

  it('refuses without a market or a product; a product without a playbook does not compile, and says why', async () => {
    expect(await inA(() => readPlaybook({ view: 'compile', productId: ids.parent }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ view: 'compile', market: 'IT' }))).toMatchObject({ status: 400 })
    const de = await inA(() => readPlaybook({ view: 'compile', market: 'DE', productId: ids.parent }))
    expect(de).toMatchObject({ data: { compiles: false, problems: ['No playbook applies here: no row names a template'] } })
  })
})

describe('one of the SAME product\'s campaigns outside the playbook buys a term', () => {
  let own = ''
  beforeAll(async () => {
    own = await inA(async () => {
      const c = db()
      const camp = await c.campaign.create({ data: { name: 'TESTPB4 older | IT | Broad', type: 'SP', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date() } as never })
      const g = await c.adGroup.create({ data: { campaignId: camp.id, name: 'TESTPB4 older group' } })
      await c.adProductAd.create({ data: { adGroupId: g.id, asin: 'B0TESTV001', sku: 'TEST-PB4-V1' } })
      await c.adTarget.create({ data: { adGroupId: g.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test coat', bidCents: 30 } })
      return camp.id
    })
  })
  afterAll(async () => { await inA(() => db().campaign.delete({ where: { id: own } })) })

  it('the template says skip: the term stays where the product already buys it, named — not listed as another product\'s', async () => {
    const read = await inA(() => readPlaybook({ view: 'compile', market: 'IT', productId: ids.parent }))
    if ('error' in read) throw new Error(read.error)
    const data = read.data as Json
    expect(data.skippedShared).toEqual([{ term: 'test coat', existing: [{ campaignName: 'TESTPB4 older | IT | Broad', campaignId: own }] }])
    expect(data.sharedWithOtherProducts).toEqual([])
    const broad = data.campaigns.find((c: Json) => c.role === 'broad-category').adGroups[0].targets.filter((t: Json) => !t.isNegative).map((t: Json) => t.expression)
    expect(broad).toEqual(['test jacket'])
  })
})

describe('money through the read tool', () => {
  const person = (permissions: string[]): UserPrincipal => ({
    kind: 'user', userId: 'u-pb4', label: 'PB4 reader', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: scope(A), via: 'app',
  })
  it('a person without ad-spend money gets the dry run minus exactly the money', async () => {
    const args = { view: 'compile', market: 'IT', productId: ids.parent }
    const full = (await callTool(person([...Object.values(FEATURES), ...Object.values(FIELDS)]), 'ads-playbook', args)).visible as Json
    const partial = (await callTool(person(Object.values(FEATURES)), 'ads-playbook', args)).visible as Json
    expect(full.ok).toBe(true)
    const money = new Set([...Object.keys(PLAYBOOK_MONEY), ...RESTRICTED_FIELD_NAMES])
    expect(JSON.stringify(partial)).toBe(JSON.stringify(full, (k, v) => (k && money.has(k) ? undefined : v)))
    for (const amount of ['404040', '4040.4']) expect(JSON.stringify(partial)).not.toContain(amount)
    expect(partial.data.slots[0]).not.toHaveProperty('startBidCents')
    expect(partial.data.campaigns[0]).not.toHaveProperty('dailyBudget')
    expect(partial.data.campaigns[0].adGroups[0]).not.toHaveProperty('defaultBidCents')
  })
})
