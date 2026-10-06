/**
 * ADS PLAYBOOK PB-5a — adopt (adopt.ts): which existing campaign plays which slot (pure), and the write on a real
 * PostgreSQL with the production schema and every business policy (PGlite), business profiles ON. Values are made up.
 *
 *   match      asked (bind) first, then named as the playbook names it, then the one campaign of the slot's shape; two of
 *              one shape are ambiguous (bound only when bind names one); a campaign of no free slot is outside, with why
 *   candidates the market's SP campaigns advertising the product family's ASINs, in no playbook; another product's are not
 *   write      links only (origin adopted) and the shared portfolio, the row DRAFT → BUILT with a version row; nothing at a
 *              campaign changes (allowlist, bids, status); one campaign plays one slot of one playbook; unbind takes an
 *              adopted slot off again (never a built one); a slot whose built campaign was archived is adopted into (its
 *              stale link replaced); a portfolio another playbook holds is named and not linked
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedProductPlaybook, templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})

import { applyAdopt, matchSlots, planAdopt, type AdoptCandidate } from './adopt.js'

const shape = (targeting: 'AUTO' | 'KEYWORD' | 'PRODUCT', match?: 'BROAD' | 'PHRASE' | 'EXACT', intent: 'BRAND' | 'CATEGORY' | 'COMPETITOR' | 'ANY' = 'ANY') => ({ targeting, ...(match ? { match } : {}), intent })
const cand = (campaignId: string, name: string, s: AdoptCandidate['shape']): AdoptCandidate => ({ campaignId, name, adGroupId: `g-${campaignId}`, portfolioId: null, shape: s })

describe('matchSlots (pure)', () => {
  const doc = templateDoc()
  it('asked, then named, then by shape; the rest empty', () => {
    const out = matchSlots(doc, 'TOKEN', [
      cand('c-auto', 'Old auto campaign', shape('AUTO')),
      cand('c-ec', 'TOKEN | IT | Exact | Category', shape('KEYWORD', 'EXACT', 'BRAND')),
      cand('c-pat', 'Rival ASINs', shape('PRODUCT')),
    ], [{ slot: 'pat', campaignId: 'c-pat' }], [], { market: 'IT' })
    expect(out.bindings.map((b) => [b.slot, b.campaignId, b.why])).toEqual([['pat', 'c-pat', 'asked'], ['exact-category', 'c-ec', 'named'], ['auto', 'c-auto', 'shape']])
    expect(out.empty).toEqual(['broad-category', 'exact-brand'])
    expect(out).toMatchObject({ ambiguous: [], outside: [], problems: [] })
  })

  it('two campaigns of one shape: ambiguous, both outside with why, until bind names one', () => {
    const two = [cand('c-a1', 'Auto one', shape('AUTO')), cand('c-a2', 'Auto two', shape('AUTO'))]
    const out = matchSlots(doc, 'TOKEN', two, [], [], { market: 'IT' })
    expect(out.ambiguous).toEqual([{ slot: 'auto', campaignIds: ['c-a1', 'c-a2'] }])
    expect(out.outside.map((o) => o.why)).toEqual([expect.stringMatching(/one of several campaigns that could play slot "auto": name it with bind/), expect.any(String)])
    const asked = matchSlots(doc, 'TOKEN', two, [{ slot: 'auto', campaignId: 'c-a2' }], [], { market: 'IT' })
    expect(asked.bindings.map((b) => [b.slot, b.campaignId, b.why])).toEqual([['auto', 'c-a2', 'asked']])
    expect(asked.outside).toEqual([{ campaignId: 'c-a1', name: 'Auto one', why: 'the slot of its shape is already held' }])
  })

  it('a linked slot is never bound again; a campaign of no slot is outside; a bad bind is a problem', () => {
    const out = matchSlots(doc, 'TOKEN', [cand('c-x', 'Phrase brand', shape('KEYWORD', 'PHRASE', 'BRAND')), cand('c-auto', 'Auto', shape('AUTO'))],
      [{ slot: 'nope', campaignId: 'c-x' }, { slot: 'pat', campaignId: 'c-missing' }], [], { market: 'IT', linked: new Set(['auto']) })
    expect(out.bindings).toEqual([])
    expect(out.outside).toEqual([
      { campaignId: 'c-x', name: 'Phrase brand', why: 'it plays no slot of this playbook' },
      { campaignId: 'c-auto', name: 'Auto', why: 'the slot of its shape is already held' },
    ])
    expect(out.problems).toEqual(['bind: the playbook has no slot "nope"', expect.stringMatching(/^bind: campaign c-missing cannot be adopted here/)])
  })
})

const A = 'pb5_adopt_alpha'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const db = () => database.client
const writer = { via: 'claude', actor: 'user:u-approver', actorUserId: 'u-approver', updatedBy: 'claude:ap-9', approvalId: 'ap-9' }
let seeded: Awaited<ReturnType<typeof seedProductPlaybook>>
const ids = { exact: '', auto: '', otherProduct: '', inAnother: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [A])
  await inA(async () => {
    seeded = await seedProductPlaybook(db(), { token: 'TESTPBA', asinPrefix: 'B0TESTPA' })
    const c = db()
    const campaign = async (name: string, asin: string, targets: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => {
      const camp = await c.campaign.create({ data: { name, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '7.00', startDate: new Date(), externalCampaignId: `EXT-${name}`, liveBidWritesEnabled: true, portfolioId: 'pf-shared', ...extra } })
      const g = await c.adGroup.create({ data: { campaignId: camp.id, name: `${name} group`, defaultBidCents: 33, externalAdGroupId: `EXT-G-${name}` } })
      await c.adProductAd.create({ data: { adGroupId: g.id, asin, sku: 'TEST-ADOPT' } })
      for (const t of targets) await c.adTarget.create({ data: { adGroupId: g.id, bidCents: 33, ...t } as never })
      return camp.id
    }
    ids.exact = await campaign('TESTPBA | IT | Exact | Category', 'B0TESTPA01', [{ kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket' }])
    ids.auto = await campaign('TESTPBA old auto', 'B0TESTPA02', [{ kind: 'AUTO', expressionType: 'QUERY_HIGH_REL_MATCHES', expressionValue: 'close-match' }], { targetingType: 'AUTO' })
    ids.otherProduct = await campaign('Other product exact', 'B0OTHERX01', [{ kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'test jacket' }])
    ids.inAnother = await campaign('TESTPBA in another playbook', 'B0TESTPA01', [{ kind: 'KEYWORD', expressionType: 'BROAD', expressionValue: 'test coat' }])
    await c.adsPlaybookLink.create({ data: { playbookId: 'another-playbook', kind: 'slot', key: 'broad-category', refId: ids.inAnother, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
  })
}, 120_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)

describe('a stale link and a portfolio another playbook holds', () => {
  let second: Awaited<ReturnType<typeof seedProductPlaybook>>
  const made = { archived: '', pat: '' }
  beforeAll(async () => {
    await inA(async () => {
      second = await seedProductPlaybook(db(), { token: 'TESTPBS', asinPrefix: 'B0TESTPS' })
      const c = db()
      // The slot pat was built, then undone: its campaign archived, its link left behind.
      made.archived = (await c.campaign.create({ data: { name: 'TESTPBS | IT | PAT', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: 'EXT-TESTPBS-PAT-OLD', status: 'ARCHIVED' } })).id
      await c.adsPlaybookLink.create({ data: { playbookId: second.rowId, kind: 'slot', key: 'pat', refId: made.archived, origin: 'built', compiledVersion: 1, updatedBy: 'user:test' } })
      // A PAT campaign the product runs, in a portfolio another product's playbook holds.
      const camp = await c.campaign.create({ data: { name: 'TESTPBS rival ASINs', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', dailyBudget: '5.00', startDate: new Date(), externalCampaignId: 'EXT-TESTPBS-PAT-NEW', portfolioId: 'pf-held-elsewhere' } })
      const g = await c.adGroup.create({ data: { campaignId: camp.id, name: 'TESTPBS PAT group' } })
      await c.adProductAd.create({ data: { adGroupId: g.id, asin: 'B0TESTPS01', sku: 'TEST-TESTPBS-V1' } })
      await c.adTarget.create({ data: { adGroupId: g.id, kind: 'PRODUCT', expressionType: 'ASIN_SAME_AS', expressionValue: 'B0TESTRIV1', bidCents: 30 } })
      await c.adsPlaybookLink.create({ data: { playbookId: 'another-playbook', kind: 'portfolio', key: 'portfolio', refId: 'pf-held-elsewhere', origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
      made.pat = camp.id
    })
  })

  it('adopts into a slot whose built campaign was archived (its link replaced); names, and does not link, the held portfolio', async () => {
    const out = await inA(() => planAdopt({ market: 'IT', productId: second.parent }))
    if ('error' in out) throw new Error(out.error)
    expect(out.data.bindings.map((b) => [b.slot, b.campaignId])).toEqual([['pat', made.pat]])
    expect(out.data.portfolioId).toBeNull()
    expect(out.data.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/share portfolio pf-held-elsewhere, which another product's playbook holds: it is not linked to this one/)]))
    expect(await inA(() => applyAdopt(out.data, writer))).toEqual({ bound: 1, unbound: 0, errors: [] })
    expect(await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: second.rowId, kind: { in: ['slot', 'portfolio'] } }, select: { kind: true, key: true, refId: true, origin: true } })))
      .toEqual([{ kind: 'slot', key: 'pat', refId: made.pat, origin: 'adopted' }])
  })
})

describe('plan and apply an adopt', () => {
  it('finds the product family\'s own campaigns only (never another product\'s, never one in another playbook), and matches them', async () => {
    const out = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent }))
    if ('error' in out) throw new Error(out.error)
    const p = out.data
    expect(p.bindings.map((b) => [b.slot, b.campaignId, b.why])).toEqual([['exact-category', ids.exact, 'named'], ['auto', ids.auto, 'shape']])
    expect([...p.bindings.map((b) => b.campaignId), ...p.outside.map((o) => o.campaignId)]).not.toContain(ids.otherProduct)
    expect([...p.bindings.map((b) => b.campaignId), ...p.outside.map((o) => o.campaignId)]).not.toContain(ids.inAnother)
    expect(p).toMatchObject({ empty: ['broad-category', 'exact-brand', 'pat'], problems: [], portfolioId: 'pf-shared', playbook: { id: seeded.rowId, state: 'DRAFT' } })
  })

  it('writes links only: the campaigns are as they were, the row BUILT with a version row; a second adopt finds nothing new', async () => {
    const before = await inA(() => db().campaign.findMany({ where: { id: { in: [ids.exact, ids.auto] } }, orderBy: { id: 'asc' }, select: { status: true, liveBidWritesEnabled: true, dailyBudget: true, bidsSuppressedAt: true } }))
    const out = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent }))
    if ('error' in out) throw new Error(out.error)
    const r = await inA(() => applyAdopt(out.data, writer))
    expect(r).toEqual({ bound: 2, unbound: 0, errors: [] })
    const links = await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: seeded.rowId }, orderBy: [{ kind: 'asc' }, { key: 'asc' }], select: { kind: true, key: true, refId: true, origin: true } }))
    expect(links.filter((l) => l.kind === 'slot' || l.kind === 'portfolio')).toEqual([
      { kind: 'portfolio', key: 'portfolio', refId: 'pf-shared', origin: 'adopted' },
      { kind: 'slot', key: 'auto', refId: ids.auto, origin: 'adopted' },
      { kind: 'slot', key: 'exact-category', refId: ids.exact, origin: 'adopted' },
    ])
    // The artifacts hook compiled the product's harvest and isolation rules, each with its own link, born OFF.
    const rules = links.filter((l) => l.kind === 'harvestRule' || l.kind === 'isolationRule')
    expect(rules.map((l) => [l.kind, l.key])).toEqual([['harvestRule', 'harvest'], ['isolationRule', 'isolation']])
    expect(await inA(() => db().automationRule.findMany({ where: { id: { in: rules.map((l) => l.refId) } }, select: { enabled: true } }))).toEqual([{ enabled: false }, { enabled: false }])
    expect(await inA(() => db().campaign.findMany({ where: { id: { in: [ids.exact, ids.auto] } }, orderBy: { id: 'asc' }, select: { status: true, liveBidWritesEnabled: true, dailyBudget: true, bidsSuppressedAt: true } }))).toEqual(before)
    const row = await inA(() => db().adsPlaybook.findUniqueOrThrow({ where: { id: seeded.rowId }, select: { state: true, version: true, compiledVersion: true } }))
    expect(row).toEqual({ state: 'BUILT', version: 2, compiledVersion: 2 })
    expect(await inA(() => db().adsPlaybookVersion.findFirstOrThrow({ where: { refId: seeded.rowId, version: 2 }, select: { op: true, approvalId: true } }))).toEqual({ op: 'adopt', approvalId: 'ap-9' })
    const again = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent }))
    expect('data' in again && again.data.bindings).toEqual([])
  })

  it('one campaign plays one slot of one playbook: a bind of a campaign in another playbook is a problem', async () => {
    const out = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent, bind: [{ slot: 'broad-category', campaignId: ids.inAnother }] }))
    expect('data' in out && out.data.problems).toEqual([expect.stringMatching(/^bind: campaign .* cannot be adopted here/)])
  })

  it('unbind takes an adopted slot off again (the undo of an adopt); a built slot is never unbound', async () => {
    const out = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent, unbind: ['auto'] }))
    if ('error' in out) throw new Error(out.error)
    expect(out.data.unbinds).toEqual([{ slot: 'auto', campaignId: ids.auto }])
    expect(out.data.bindings).toEqual([])
    expect(await inA(() => applyAdopt(out.data, writer))).toEqual({ bound: 0, unbound: 1, errors: [] })
    expect((await inA(() => db().adsPlaybookLink.findMany({ where: { playbookId: seeded.rowId, kind: 'slot' }, select: { key: true } }))).map((l) => l.key)).toEqual(['exact-category'])
    await inA(() => db().adsPlaybookLink.updateMany({ where: { playbookId: seeded.rowId, key: 'exact-category' }, data: { origin: 'built' } }))
    const built = await inA(() => planAdopt({ market: 'IT', productId: seeded.parent, unbind: ['exact-category'] }))
    expect('data' in built && built.data.problems).toEqual([expect.stringMatching(/was built by the playbook, not adopted: archive its campaign instead/)])
  })
})
