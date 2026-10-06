/**
 * ADS PLAYBOOK PB-2 — the playbook loaders and reads (load.ts, read.ts) and the ads-playbook tool, on a real PostgreSQL
 * with the production schema and every business policy (PGlite), business profiles ON, two businesses. Values are made
 * up (public repo).
 *
 *   effective  a variation follows the market's template with its parent's and its own rows: each section and field with
 *              its source, its slots named, what it owns (links), and the strategy beside it (the phase = its goal)
 *   rows       every row of the market, the orphan flagged
 *   templates  the list, and one with its doc; a template that does not read says why
 *   history    a template's changes, and a product's
 *   capture    live campaigns with their hourly plans and the floor targets become a template preview; nothing is saved
 *   refusals   one scope at a time; a deleted product is not found; a capture names a market, a token and one selector
 *   business   another business reads only its own playbook; this business's ids are not found there
 *   money      the read tool hides exactly the money from a person without ad-spend money
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

import { readPlaybook, PLAYBOOK_NOTE } from './read.js'
import { PLAYBOOK_MONEY } from './doc.js'
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'
import { callTool, type UserPrincipal } from '../../agents/call-tool.js'

const A = 'pb2_read_alpha'
const B = 'pb2_read_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { leaf: '', parent: '', v: '', gone: '', template: '', marketRow: '', parentRow: '', vRow: '', campaigns: [] as string[], bProduct: '' }

type Data = Record<string, any>
const data = (out: Awaited<ReturnType<typeof readPlaybook>>) => {
  if ('error' in out) throw new Error(`refused: ${out.error}`)
  return out.data as Data
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.leaf = (await c.category.create({ data: { slug: 'pb2-leaf', name: { en: { name: 'Test leaf' }, it: {} } } })).id
    await c.categoryClosure.create({ data: { ancestorId: ids.leaf, descendantId: ids.leaf, depth: 0 } })
    ids.parent = (await c.product.create({ data: { sku: 'TEST-PB2-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v = (await c.product.create({ data: { sku: 'TEST-PB2-V1', name: 'Test variation', basePrice: '10.00', parentId: ids.parent } })).id
    ids.gone = (await c.product.create({ data: { sku: 'TEST-PB2-GONE', name: 'Test deleted', basePrice: '10.00', deletedAt: new Date() } })).id
    await c.productCategory.create({ data: { productId: ids.parent, categoryId: ids.leaf, isPrimary: true } })

    ids.template = (await c.adsPlaybookTemplate.create({ data: { name: 'Test funnel', version: 2, doc: templateDoc() as never, updatedBy: 'user:test' } })).id
    await c.adsPlaybookTemplate.create({ data: { name: 'Test broken', doc: { structure: { slots: [] } }, status: 'DRAFT', updatedBy: 'user:test' } })
    ids.marketRow = (await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'Test market (IT)', templateId: ids.template, updatedBy: 'user:test' } })).id
    ids.parentRow = (await c.adsPlaybook.create({ data: {
      market: 'IT', level: 'PRODUCT', scopeId: ids.parent, label: 'TEST-PB2-PARENT (IT)', enrolled: true, state: 'DRAFT', nameToken: 'TESTTOKEN',
      dailyBudgetCents: 424242, baseBidCents: 3737, compiledTemplateVersion: 1, terms: { brand: ['testtoken jacket'], category: [{ text: 'test jacket', exactAtStart: true }] },
      phaseRecipes: { LAUNCH: { targetAcosPct: 41, maxBidCents: 8989 } }, updatedBy: 'user:test',
    } })).id
    ids.vRow = (await c.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.v, label: 'TEST-PB2-V1 (IT)', overrides: { skipSlots: ['exact-brand'] }, updatedBy: 'user:test' } })).id
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'PRODUCT', scopeId: ids.gone, label: 'TEST-PB2-GONE (IT)', updatedBy: 'user:test' } })
    await c.adsPlaybookVersion.create({ data: { kind: 'template', refId: ids.template, version: 2, op: 'set', changes: [{ section: 'budget', from: null, to: 'set' }], direction: 'same', via: 'screen', actor: 'Test person' } })
    await c.adsPlaybookVersion.create({ data: {
      kind: 'playbook', refId: ids.parentRow, version: 1, market: 'IT', level: 'PRODUCT', scopeId: ids.parent, op: 'enroll',
      changes: [{ field: 'enrolled', from: null, to: true }], direction: 'raise', via: 'claude', approvalId: 'appr-test-1', actor: 'Test person',
    } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test strategy (IT)', goal: 'LAUNCH', targetKind: 'ACOS', targetPct: 33, maxBidCents: 6161, updatedBy: 'user:test' } })

    // A live set for the capture (and the parent's playbook owns its Exact campaign).
    await c.amazonAdsPortfolio.create({ data: { profileId: 'test-profile', externalPortfolioId: 'test-pf-1', name: 'Test TESTTOKEN IT' } })
    await c.rankTarget.create({ data: { key: 'test-min-bid', name: 'Test min bid', pause: true } })
    await c.rankTarget.create({ data: { key: 'test-own-top', name: 'Test own top' } })
    const campaign = async (name: string, targets: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
      const made = await c.campaign.create({ data: { name, type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date(), portfolioId: 'test-pf-1', ...extra } as never })
      const group = await c.adGroup.create({ data: { campaignId: made.id, name, defaultBidCents: 30 } })
      for (const t of targets) await c.adTarget.create({ data: { adGroupId: group.id, ...t } as never })
      await c.adProductAd.create({ data: { adGroupId: group.id, productId: ids.v, asin: 'B0TESTPB21' } })
      ids.campaigns.push(made.id)
      return made.id
    }
    const exact = await campaign('TESTTOKEN | IT | Exact | Category', [
      { kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket', bidCents: 45 },
      { kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test old jacket', bidCents: 45, status: 'ARCHIVED' },
    ])
    const broad = await campaign('TESTTOKEN | IT | Broad | Category', [
      { kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test jacket', bidCents: 30 },
      { kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket', isNegative: true, negativeLevel: 'AD_GROUP' },
    ])
    await c.adSchedule.create({ data: { campaignId: exact, name: 'Test performance', windows: [{ days: [1, 2, 3], startHour: 8, endHour: 20, targetKey: 'test-own-top' }], defaultTargetKey: null } })
    await c.adSchedule.create({ data: { campaignId: broad, name: 'Test research', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 7, targetKey: 'test-min-bid' }], defaultTargetKey: null } })
    await c.adsPlaybookLink.create({ data: { playbookId: ids.parentRow, kind: 'slot', key: 'exact-category', refId: exact, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
  })
  await inB(async () => {
    const c = db()
    ids.bProduct = (await c.product.create({ data: { sku: 'BRAVO-PB2-SKU', name: 'BRAVO jacket', basePrice: '10.00' } })).id
    const t = await c.adsPlaybookTemplate.create({ data: { name: 'BRAVO funnel', doc: templateDoc() as never, updatedBy: 'user:bravo' } })
    await c.adsPlaybook.create({ data: { market: 'IT', level: 'MARKET', label: 'BRAVO market (IT)', templateId: t.id, updatedBy: 'user:bravo' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('effective', () => {
  it('a variation follows the market\'s template, its parent\'s fields and its own skip; the slots are named; links and the strategy beside it', async () => {
    const out = data(await inA(() => readPlaybook({ market: 'IT', productId: ids.v })))
    expect(out).toMatchObject({ view: 'effective', scope: { kind: 'product', productId: ids.v, sku: 'TEST-PB2-V1' }, playbookNote: PLAYBOOK_NOTE })
    const it = out.markets[0]
    expect(it).toMatchObject({ market: 'IT', enrolled: true, compiles: true })
    expect(it.template).toMatchObject({ templateId: ids.template, name: 'Test funnel', version: 2, source: { level: 'market', id: ids.marketRow } })
    expect(it.template.newer).toMatch(/template is at v2; this product was last applied with v1/)
    expect(it.sources.structure).toMatchObject({ level: 'template', id: ids.template })
    expect(it.sections.structure.naming.pattern).toBe('{product} | {market} | {parts}')
    expect(it.skipSlots).toEqual({ slots: ['exact-brand'], source: expect.objectContaining({ level: 'product', id: ids.vRow }) })
    const field = (name: string) => it.product.find((f: Data) => f.field === name)
    expect(field('dailyBudgetCents')).toMatchObject({ dailyBudgetCents: 424242, source: { level: 'product', id: ids.parentRow, via: 'parent' } })
    expect(field('terms').terms.brand).toEqual(['testtoken jacket'])
    expect(it.slots.map((s: Data) => s.key)).toEqual(['auto', 'broad-category', 'exact-category', 'pat'])
    expect(it.slots.find((s: Data) => s.key === 'exact-category')).toMatchObject({ name: 'TESTTOKEN | IT | Exact | Category', match: 'EXACT', rankRole: 'performance' })
    expect(it.links).toEqual([expect.objectContaining({ kind: 'slot', key: 'exact-category', origin: 'adopted', campaign: expect.objectContaining({ name: 'TESTTOKEN | IT | Exact | Category' }) })])
    expect(it.strategy).toMatchObject({ phase: { goal: 'LAUNCH', source: { level: 'market' } }, targetAcosPct: 33, maxBidCents: 6161 })
    expect(it.orphans).toEqual([expect.objectContaining({ scopeId: ids.gone, why: 'the product no longer exists or was deleted' })])
  })

  it('a market without a playbook says so and cannot compile', async () => {
    const de = data(await inA(() => readPlaybook({ market: 'DE' }))).markets[0]
    expect(de).toMatchObject({ market: 'DE', playbookRows: 0, note: 'No playbook is set for DE yet.', compiles: false, problems: ['No playbook applies here: no row names a template'] })
  })

  it('a category resolves through its own chain', async () => {
    const out = data(await inA(() => readPlaybook({ market: 'IT', categoryId: ids.leaf })))
    expect(out.scope).toEqual({ kind: 'category', categoryId: ids.leaf, name: 'Test leaf' })
    expect(out.markets[0]).not.toHaveProperty('product')
  })
})

describe('rows, templates and history', () => {
  it('rows: every row of the market, the orphan flagged', async () => {
    const rows = data(await inA(() => readPlaybook({ market: 'IT', view: 'rows' }))).rows as Data[]
    expect(rows.map((r) => [r.market, r.level])).toEqual([['IT', 'MARKET'], ['IT', 'PRODUCT'], ['IT', 'PRODUCT'], ['IT', 'PRODUCT']])
    expect(rows[0]).toMatchObject({ playbookId: ids.marketRow, template: 'Test funnel' })
    expect(rows.find((r) => r.scopeId === ids.gone)).toMatchObject({ orphan: 'the product no longer exists or was deleted' })
  })

  it('templates: the list (a doc that does not read says why), and one with its doc', async () => {
    const list = data(await inA(() => readPlaybook({ view: 'templates' }))).templates as Data[]
    expect(list.map((t) => t.name)).toEqual(['Test broken', 'Test funnel'])
    expect(list[0].problems.length).toBeGreaterThan(0)
    expect(list[1]).toMatchObject({ slots: ['auto', 'broad-category', 'exact-category', 'exact-brand', 'pat'] })
    expect(list[1]).not.toHaveProperty('doc')
    const one = data(await inA(() => readPlaybook({ view: 'templates', templateId: ids.template }))).templates[0]
    expect(one.doc.structure.naming.pattern).toBe('{product} | {market} | {parts}')
    expect(await inA(() => readPlaybook({ view: 'templates', templateId: 'no-such' }))).toMatchObject({ status: 404 })
  })

  it('history: a template\'s changes, and a product\'s', async () => {
    const template = data(await inA(() => readPlaybook({ view: 'history', templateId: ids.template })))
    expect(template.versions).toEqual([expect.objectContaining({ kind: 'template', version: 2, op: 'set', actor: 'Test person' })])
    const product = data(await inA(() => readPlaybook({ view: 'history', market: 'IT', productId: ids.parent })))
    expect(product.versions).toEqual([expect.objectContaining({ kind: 'playbook', market: 'IT', op: 'enroll', via: 'claude', approvalId: 'appr-test-1' })])
  })
})

describe('capture', () => {
  it('live campaigns, their hourly plans and the floor targets become a template preview; archived targets and nothing saved', async () => {
    const before = await inA(() => db().adsPlaybookTemplate.count())
    const out = data(await inA(() => readPlaybook({ view: 'capture', market: 'IT', productToken: 'TESTTOKEN', namePrefix: 'TESTTOKEN | IT |' })))
    expect(out.source.portfolio).toEqual({ id: 'test-pf-1', name: 'Test TESTTOKEN IT' })
    expect(out.slots.map((s: Data) => s.slotKey)).toEqual(['broad-category', 'exact-category'])
    expect(out.template.structure.portfolio).toEqual({ pattern: 'Test {product} {market}', mode: 'reuse-or-create' })
    expect(out.template.structure.slots.map((s: Data) => [s.key, s.rankRole])).toEqual([['broad-category', 'research'], ['exact-category', 'performance']])
    expect(out.template.isolation.exactIntoResearch).toBe(true)
    expect(out.product.terms.category).toEqual([{ text: 'test jacket', exactAtStart: true }])
    expect(JSON.stringify(out)).not.toContain('test old jacket')
    expect(await inA(() => db().adsPlaybookTemplate.count())).toBe(before)
  })

  it('a campaign an engine holds at the floor is read with the bids held before the floor, and says so; nothing is written', async () => {
    const made = await inA(async () => {
      const c = db()
      const floored = await c.campaign.create({ data: {
        name: 'TESTFLOOR | IT | Exact | Category', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date(),
        bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: 2, bidsSuppressedBy: 'automation:test-rank',
      } as never })
      const group = await c.adGroup.create({ data: { campaignId: floored.id, name: 'TESTFLOOR exact', defaultBidCents: 2, suppressedFromBidCents: 30 } })
      await c.adTarget.create({ data: { adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test floor jacket', bidCents: 2, suppressedFromBidCents: 45 } })
      await c.adTarget.create({ data: { adGroupId: group.id, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test floor coat', bidCents: 2, suppressedFromBidCents: 55 } })
      // A campaign nothing floors, with a bid remembered from an old stop, is read as it bids today.
      const plain = await c.campaign.create({ data: { name: 'TESTFLOOR | IT | Broad | Category', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date() } as never })
      const plainGroup = await c.adGroup.create({ data: { campaignId: plain.id, name: 'TESTFLOOR broad', defaultBidCents: 25, suppressedFromBidCents: 90 } })
      await c.adTarget.create({ data: { adGroupId: plainGroup.id, kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test floor jacket', bidCents: 40, suppressedFromBidCents: 99 } })
      return { floored: floored.id, group: group.id }
    })
    const out = data(await inA(() => readPlaybook({ view: 'capture', market: 'IT', productToken: 'TESTFLOOR', namePrefix: 'TESTFLOOR | IT |' })))
    expect(out.slots.map((s: Data) => s.slotKey)).toEqual(['broad-category', 'exact-category'])
    expect(out.product.baseBidCents).toBe(45)
    expect(out.template.bids.ladder).toEqual({ 'broad-category': 0.89, 'exact-category': 1.11 })
    expect(out.warnings).toContain('"TESTFLOOR | IT | Exact | Category": 3 bid(s) held at the floor; read the bid held before the floor (by automation:test-rank)')
    expect(out.warnings.join('\n')).not.toMatch(/every bid is at the floor|"TESTFLOOR \| IT \| Broad \| Category": .*held before the floor/)
    const after = await inA(() => db().adTarget.findMany({ where: { adGroupId: made.group }, select: { bidCents: true, suppressedFromBidCents: true }, orderBy: { expressionValue: 'asc' } }))
    expect(after).toEqual([{ bidCents: 2, suppressedFromBidCents: 55 }, { bidCents: 2, suppressedFromBidCents: 45 }])
    expect(await inA(() => db().campaign.findUnique({ where: { id: made.floored }, select: { bidsSuppressedBy: true } }))).toEqual({ bidsSuppressedBy: 'automation:test-rank' })
  })

  it('a capture names a market, the token and one selector', async () => {
    expect(await inA(() => readPlaybook({ view: 'capture', productToken: 'X', namePrefix: 'X' }))).toMatchObject({ status: 400, error: expect.stringMatching(/one market/) })
    expect(await inA(() => readPlaybook({ view: 'capture', market: 'IT', namePrefix: 'X' }))).toMatchObject({ status: 400, error: expect.stringMatching(/productToken/) })
    expect(await inA(() => readPlaybook({ view: 'capture', market: 'IT', productToken: 'X', namePrefix: 'X', campaignIds: ['y'] }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ view: 'capture', market: 'IT', productToken: 'X', namePrefix: 'NO SUCH' }))).toMatchObject({ status: 404 })
  })
})

describe('refusals and business', () => {
  it('one scope at a time; a deleted product is not found; rows take no scope; Amazon only', async () => {
    expect(await inA(() => readPlaybook({ productId: ids.v, categoryId: ids.leaf }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ productId: ids.gone }))).toEqual({ status: 404, error: PRODUCT_NOT_FOUND })
    expect(await inA(() => readPlaybook({ view: 'rows', productId: ids.v }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ channel: 'EBAY' }))).toMatchObject({ status: 400 })
  })

  it('PB-5a — view build: one product in one market, or one run; this business\'s run is not found from another', async () => {
    expect(await inA(() => readPlaybook({ view: 'build', productId: ids.v }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ view: 'build', market: 'IT' }))).toMatchObject({ status: 400 })
    expect(await inA(() => readPlaybook({ view: 'build', market: 'IT', productId: ids.gone }))).toEqual({ status: 404, error: PRODUCT_NOT_FOUND })
    expect(data(await inA(() => readPlaybook({ view: 'build', market: 'IT', productId: ids.v })))).toMatchObject({ view: 'build', runs: [], empty: 'No build of this playbook yet.' })
    const run = await inA(() => db().adBlueprintApplication.create({ data: {
      productToken: 'TESTTOKEN', marketplace: 'IT', status: 'APPLIED', plan: {}, playbookId: ids.vRow, createdCampaignIds: [ids.campaigns[0]], errors: [],
      options: { source: 'playbook', changeSetId: 'ap-read', compiledVersion: 1, slots: ['auto'], deferredPlacements: [] },
    } }))
    const one = data(await inA(() => readPlaybook({ view: 'build', applicationId: run.id })))
    expect(one.run).toMatchObject({ applicationId: run.id, status: 'APPLIED', changeSetId: 'ap-read', slots: ['auto'], created: [{ campaignId: ids.campaigns[0], atAmazon: expect.any(Boolean) }] })
    expect(data(await inA(() => readPlaybook({ view: 'build', market: 'IT', productId: ids.v }))).runs.map((r: Data) => r.applicationId)).toEqual([run.id])
    expect(await inB(() => readPlaybook({ view: 'build', applicationId: run.id }))).toMatchObject({ status: 404 })
    await inA(() => db().adBlueprintApplication.delete({ where: { id: run.id } }))
  })

  it('another business reads only its own playbook; this business\'s ids are not found there', async () => {
    await inB(async () => {
      expect(await readPlaybook({ productId: ids.v })).toEqual({ status: 404, error: PRODUCT_NOT_FOUND })
      expect(await readPlaybook({ view: 'templates', templateId: ids.template })).toMatchObject({ status: 404 })
      const rows = data(await readPlaybook({ market: 'IT', view: 'rows' }))
      expect(rows.rows.map((r: Data) => r.label)).toEqual(['BRAVO market (IT)'])
      expect(data(await readPlaybook({ view: 'templates' })).templates.map((t: Data) => t.name)).toEqual(['BRAVO funnel'])
      expect(await readPlaybook({ view: 'capture', market: 'IT', productToken: 'TESTTOKEN', campaignIds: ids.campaigns })).toMatchObject({ status: 404 })
    })
    for (const view of ['effective', 'rows', 'templates', 'history'] as const) {
      expect(JSON.stringify(data(await inA(() => readPlaybook({ market: 'IT', view }))))).not.toContain('BRAVO')
    }
  })
})

describe('money through the read tool', () => {
  const person = (permissions: string[]): UserPrincipal => ({
    kind: 'user', userId: 'u-pb2-read', label: 'PB2 reader', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: scope(A), via: 'app',
  })
  const ACTIONS = Object.values(FEATURES)

  const money = new Set(Object.keys(PLAYBOOK_MONEY))
  const keys = (value: unknown, out = new Set<string>()): Set<string> => {
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keys(v, out) }
    return out
  }
  const both = async (args: Record<string, unknown>) => ({
    full: (await callTool(person([...ACTIONS, ...Object.values(FIELDS)]), 'ads-playbook', args)).visible as Data,
    partial: (await callTool(person(ACTIONS), 'ads-playbook', args)).visible as Data,
  })

  it('a person without ad-spend money gets the same answer minus exactly the playbook\'s money keys', async () => {
    const { full, partial } = await both({ market: 'IT', productId: ids.v })
    expect(full.ok).toBe(true)
    expect([...keys(full)].filter((k) => money.has(k)).sort()).toEqual(expect.arrayContaining(['baseBidCents', 'dailyBudgetCents', 'maxBidCents', 'minPerSlotCents', 'targetAcosPct']))
    expect([...keys(partial)].filter((k) => money.has(k))).toEqual([])
    // Nothing else is lost: the whole doc is shallow enough for the money filter (no part cut at its depth).
    expect(JSON.stringify(partial)).toBe(JSON.stringify(full, (k, v) => (k && money.has(k) ? undefined : v)))
    for (const amount of ['424242', '3737', '8989', '6161']) expect(JSON.stringify(partial)).not.toContain(amount)
    // Where each part comes from stays visible.
    expect(partial.data.markets[0].product.find((f: Data) => f.field === 'dailyBudgetCents')).toMatchObject({ source: { via: 'parent' } })
  })

  it('every other view loses exactly the money too, and nothing else', async () => {
    await inA(() => db().adsPlaybook.update({ where: { id: ids.vRow }, data: { overrides: { skipSlots: ['exact-brand'], phases: templateDoc().phases, budget: templateDoc().budget } } }))
    await inA(() => db().adsPlaybookVersion.create({ data: {
      kind: 'playbook', refId: ids.vRow, version: 2, market: 'IT', level: 'PRODUCT', scopeId: ids.v, op: 'set',
      values: { overrides: { phases: templateDoc().phases }, dailyBudgetCents: 515151 }, changes: [{ section: 'phases' }], direction: 'same', via: 'screen', actor: 'Test person',
    } }))
    for (const args of [
      { market: 'IT', view: 'rows' }, { market: 'IT', view: 'history', productId: ids.v }, { view: 'templates', templateId: ids.template },
      { view: 'capture', market: 'IT', productToken: 'TESTTOKEN', namePrefix: 'TESTTOKEN | IT |' }, { market: 'IT', productId: ids.v },
    ]) {
      const { full, partial } = await both(args)
      expect(full.ok, JSON.stringify(args)).toBe(true)
      expect(JSON.stringify(partial), JSON.stringify(args)).toBe(JSON.stringify(full, (k, v) => (k && money.has(k) ? undefined : v)))
      expect(JSON.stringify(partial), JSON.stringify(args)).not.toContain('515151')
    }
  })
})
