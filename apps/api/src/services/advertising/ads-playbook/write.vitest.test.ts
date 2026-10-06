/**
 * ADS PLAYBOOK PB-3 — the playbook writer (write.ts) on a real PostgreSQL with the production schema and every business
 * policy (PGlite), business profiles ON, two businesses. Values are made up (public repo).
 *
 *   template   a new one needs a name and its whole doc (a doc that does not read is refused, by path); sections replace
 *              whole; one name per business; expectVersion; capture saves one from live campaigns; remove only unused
 *   rows       a market row names a template; product-only fields and skipSlots belong on product rows; an unknown or a
 *              retired template is refused
 *   enroll     only into a playbook that compiles; enrolling is a raise; the phase recipes are made absolute from the
 *              family's profit data and the market's target (without costs: the fallback, said)
 *   judge      once enrolled, a higher budget raises, a lower one lowers, a name token is the same; a template change
 *              raises for the enrolled product that follows it, and is the same for a template nobody enrolled follows
 *   apply      one version row each (direction, via, actor, the code's time on a raise); a raise without the code's time
 *              is never written; a row moved since → 409 and nothing written
 *   undo       the undo arguments put the previous version back
 *   business   another business cannot name this one's template or product
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { fixtureTargets as t, templateDoc } from '../../../test-support/ads-playbook-fixtures.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { applyPlaybookPlan, planPlaybookChange, playbookStateNow, undoArgsOf, type PlaybookPlan, type PlaybookState } from './write.js'
import { PRODUCT_NOT_FOUND } from '../../agents/tools/live-product.js'

const A = 'pb3_write_alpha'
const B = 'pb3_write_bravo'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const ids = { parent: '', v: '', bare: '', template: '', other: '', campaign: '' }
type Json = Record<string, any>

const plan = async (args: Record<string, unknown>): Promise<PlaybookPlan> => {
  const out = await planPlaybookChange({ channel: 'AMAZON', ...args })
  if (!out.ok) throw new Error(`refused: ${out.error}`)
  return out.plan
}
const refusal = async (args: Record<string, unknown>) => {
  const out = await planPlaybookChange({ channel: 'AMAZON', ...args })
  if (out.ok) throw new Error('planned, expected a refusal')
  return out
}
const writer = (p: PlaybookPlan) => ({ via: 'screen', actor: 'Test person', actorUserId: 'u-test', stepUpAt: p.direction === 'raise' ? new Date() : null, updatedBy: 'user:u-test' })
const save = async (args: Record<string, unknown>) => {
  const p = await plan(args)
  const out = await applyPlaybookPlan(p, writer(p))
  if (!out.ok) throw new Error(`not saved: ${out.error}`)
  return { plan: p, out }
}
const product = (productId: string, extra: Record<string, unknown> = {}) => ({ kind: 'playbook', market: 'IT', level: 'product', productId, ...extra })
const dirOf = (p: PlaybookPlan, field: string) => p.changes.find((c) => c.field === field)?.direction

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await inA(async () => {
    const c = db()
    ids.parent = (await c.product.create({ data: { sku: 'TEST-PB3-PARENT', name: 'Test parent', basePrice: '10.00', isParent: true } })).id
    ids.v = (await c.product.create({ data: { sku: 'TEST-PB3-V1', name: 'Test variation', basePrice: '10.00', parentId: ids.parent } })).id
    ids.bare = (await c.product.create({ data: { sku: 'TEST-PB3-BARE', name: 'Test no costs', basePrice: '10.00' } })).id
    // The variation's profit in IT: 10,000 revenue, 6,500 of costs and fees → a break-even ACoS of 35 %.
    const day = new Date(Date.now() - 5 * 86_400_000)
    await c.productProfitDaily.create({ data: {
      productId: ids.v, marketplace: 'IT', date: day, unitsSold: 10, grossRevenueCents: 10_000, cogsCents: 4_000, referralFeesCents: 1_500, fbaFulfillmentFeesCents: 1_000, trueProfitCents: 3_500,
    } })
    await c.adsStrategy.create({ data: { market: 'IT', level: 'MARKET', label: 'Test strategy (IT)', targetKind: 'ACOS', targetPct: 30, updatedBy: 'user:test' } })
    // A live campaign for the capture.
    const campaign = await c.campaign.create({ data: { name: 'TESTPB3 | IT | Exact | Category', type: 'SP', marketplace: 'IT', dailyBudget: '10.00', startDate: new Date() } as never })
    ids.campaign = campaign.id
    const group = await c.adGroup.create({ data: { campaignId: campaign.id, name: 'TESTPB3 | IT | Exact | Category', defaultBidCents: 30 } })
    const kw = t.keyword('test jacket', 'EXACT', 40)
    await c.adTarget.create({ data: { adGroupId: group.id, kind: kw.kind, expressionType: kw.expressionType, expressionValue: kw.expressionValue, bidCents: kw.bidCents, isNegative: false } })
  })
  await inB(async () => {
    await db().product.create({ data: { sku: 'BRAVO-PB3-SKU', name: 'BRAVO jacket', basePrice: '10.00' } })
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('templates', () => {
  it('a new one needs a name and its whole doc; a doc that does not read is refused by path', async () => {
    await inA(async () => {
      expect(await refusal({ kind: 'template', name: 'Test funnel' })).toMatchObject({ status: 400, error: expect.stringMatching(/whole doc/) })
      const broken = { ...templateDoc(), bids: { ladder: { ghost: 1 }, launch: 'floor' } }
      expect(await refusal({ kind: 'template', name: 'Test funnel', doc: broken })).toMatchObject({ status: 400, error: expect.stringMatching(/bids\.ladder: no slot "ghost"/) })
    })
  })

  it('set: version 1 and its version row; nobody follows it, so it binds nothing (same)', async () => {
    await inA(async () => {
      const { plan: p, out } = await save({ kind: 'template', name: 'Test funnel', doc: templateDoc(), reason: 'test: first template' })
      ids.template = out.id
      expect(p.preview).toMatchObject({ action: 'set-ads-playbook', kind: 'template', direction: 'same', stepUp: null, reachesAmazon: false, version: { from: 0, to: 1 } })
      expect(p.preview.liveEffect).toMatch(/No playbook row names it yet/)
      expect(await db().adsPlaybookTemplate.findUniqueOrThrow({ where: { id: out.id } })).toMatchObject({ name: 'Test funnel', version: 1, status: 'ACTIVE', updatedBy: 'user:u-test' })
      expect(await db().adsPlaybookVersion.findFirstOrThrow({ where: { kind: 'template', refId: out.id } }))
        .toMatchObject({ version: 1, op: 'set', direction: 'same', via: 'screen', actor: 'Test person', stepUpAt: null, reason: 'test: first template' })
    })
  })

  it('sections replace whole; a name another template holds is refused; a stale expectVersion is a conflict', async () => {
    await inA(async () => {
      const other = await save({ kind: 'template', name: 'Test other', doc: templateDoc() })
      ids.other = other.out.id
      expect(await refusal({ kind: 'template', templateId: ids.other, name: 'Test funnel' })).toMatchObject({ status: 409 })
      expect(await refusal({ kind: 'template', templateId: ids.template, sections: { colours: {} } })).toMatchObject({ status: 400, error: expect.stringMatching(/unknown section/) })
      const placements = { ...templateDoc().placements, auto: { top: 5, productPage: 0, restOfSearch: 0 } }
      const { plan: p } = await save({ kind: 'template', templateId: ids.template, sections: { placements }, expectVersion: 1 })
      expect(p.changes.map((c) => c.field)).toEqual(['section.placements'])
      expect(await refusal({ kind: 'template', templateId: ids.template, status: 'DRAFT', expectVersion: 1 })).toMatchObject({ status: 409, code: 'version_moved' })
    })
  })

  it('capture saves a template from live campaigns; it names them', async () => {
    await inA(async () => {
      const { plan: p, out } = await save({ kind: 'template', op: 'capture', name: 'Test captured', market: 'IT', productToken: 'TESTPB3', campaignIds: [ids.campaign] })
      expect(p.preview.capture).toMatchObject({ slots: [{ campaignId: ids.campaign, slotKey: 'exact-category' }] })
      const row = await db().adsPlaybookTemplate.findUniqueOrThrow({ where: { id: out.id } })
      expect(row.capturedFrom).toMatchObject({ campaignIds: [ids.campaign], productToken: 'TESTPB3', market: 'IT' })
      expect((row.doc as Json).structure.slots.map((s: Json) => s.key)).toEqual(['exact-category'])
    })
  })
})

describe('rows and enrollment', () => {
  it('a market row names the template; product-only fields and skipSlots belong on a product row; an unknown or retired template is refused', async () => {
    await inA(async () => {
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', values: { dailyBudgetCents: 100 } })).toMatchObject({ status: 400, error: expect.stringMatching(/only a product row/) })
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', values: { overrides: { skipSlots: ['auto'] } } })).toMatchObject({ status: 400, error: expect.stringMatching(/only a product row leaves slots out/) })
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', values: { templateId: 'no-such' } })).toMatchObject({ status: 404 })
      await save({ kind: 'template', templateId: ids.other, status: 'RETIRED' })
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', values: { templateId: ids.other } })).toMatchObject({ status: 400, error: expect.stringMatching(/retired/) })
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', op: 'enroll' })).toMatchObject({ status: 400, error: expect.stringMatching(/never enrolls/) })
      // Nobody is enrolled: naming a template binds nothing yet.
      const { plan: p } = await save({ kind: 'playbook', market: 'IT', level: 'market', values: { templateId: ids.template } })
      expect(p.preview).toMatchObject({ direction: 'same', affects: { enrolledProducts: 0 } })
    })
  })

  it('enroll: only into a playbook that compiles; enrolling with a budget and a base bid is a raise; the recipes are made absolute', async () => {
    await inA(async () => {
      // A product row whose own (broken) bids section keeps the playbook from compiling.
      expect(await refusal(product(ids.parent, { op: 'enroll', values: { overrides: { bids: { ladder: { auto: 1 }, launch: 'floor' } } } })))
        .toMatchObject({ status: 400, error: expect.stringMatching(/Enrolling needs a playbook it can be built from.*has no start bid factor/) })
      const { plan: p, out } = await save(product(ids.parent, { op: 'enroll', values: { nameToken: 'TESTPB3', dailyBudgetCents: 2000, baseBidCents: 40 } }))
      expect(p.preview).toMatchObject({ direction: 'raise', stepUp: { what: 'raises what an ads playbook may spend' }, affects: { enrolledProducts: 1 } })
      expect(p.preview.raises).toEqual(expect.arrayContaining(['Enrolled', 'Daily budget', 'Base bid']))
      expect(dirOf(p, 'nameToken')).toBe('same')
      // Break-even 35 % from the variation's profit data; the market's target 30 %.
      expect(p.preview.recipes!.from).toMatchObject({ breakEvenAcosPct: 35, marketTargetPct: 30, marketTargetFrom: 'the ads strategy of IT', baseBidCents: 40 })
      expect(p.preview.recipes!.phaseRecipes).toMatchObject({ LAUNCH: { targetAcosPct: 46 }, GROW: { targetAcosPct: 30 }, PROFIT: { targetAcosPct: 28, harvestMaxAcosPct: 28 } })
      const row = await db().adsPlaybook.findUniqueOrThrow({ where: { id: out.id } })
      expect(row).toMatchObject({ enrolled: true, state: 'DRAFT', dailyBudgetCents: 2000, baseBidCents: 40, version: 1 })
      expect((row.phaseRecipes as Json).LAUNCH.targetAcosPct).toBe(46)
      const version = await db().adsPlaybookVersion.findFirstOrThrow({ where: { kind: 'playbook', refId: out.id } })
      expect(version).toMatchObject({ op: 'enroll', direction: 'raise', market: 'IT', level: 'PRODUCT', scopeId: ids.parent })
      expect(version.stepUpAt).toBeInstanceOf(Date)
    })
  })

  it('without costs: the recipe target is the fallback × the market\'s target, said', async () => {
    await inA(async () => {
      const p = await plan(product(ids.bare, { op: 'enroll', values: { baseBidCents: 30 } }))
      expect(p.preview.recipes!.from).toMatchObject({ breakEvenAcosPct: null, breakEvenFrom: expect.stringMatching(/no cost data/) })
      expect(p.preview.recipes!.phaseRecipes.LAUNCH!.targetAcosPct).toBe(45)
      expect(p.preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/LAUNCH: no cost data/)]))
    })
  })

  it('once enrolled: a higher budget raises, a lower one lowers, a name token is the same; a template change for its follower raises', async () => {
    await inA(async () => {
      expect(dirOf(await plan(product(ids.parent, { values: { dailyBudgetCents: 2500 } })), 'dailyBudgetCents')).toBe('raise')
      expect(dirOf(await plan(product(ids.parent, { values: { dailyBudgetCents: 1500 } })), 'dailyBudgetCents')).toBe('lower')
      expect((await plan(product(ids.parent, { values: { nameToken: 'TESTPB3B' } }))).direction).toBe('same')
      const ladder = { ...templateDoc().bids.ladder, auto: 1.5 }
      const raised = await plan({ kind: 'template', templateId: ids.template, sections: { bids: { ladder, launch: 'floor' } } })
      expect(raised.preview).toMatchObject({ direction: 'raise', raises: ['Start-bid ladder'], affects: { enrolledProducts: 1, products: [{ productId: ids.parent, sku: 'TEST-PB3-PARENT', market: 'IT' }] } })
      // The captured template: nobody follows it.
      const captured = await db().adsPlaybookTemplate.findFirstOrThrow({ where: { name: 'Test captured' } })
      expect((await plan({ kind: 'template', templateId: captured.id, status: 'DRAFT' })).direction).toBe('same')
      // PB-9 — the product's phase recipes, by what a switch would write: a higher target raises, a lower one lowers.
      const row = await db().adsPlaybook.findFirstOrThrow({ where: { market: 'IT', level: 'PRODUCT', scopeId: ids.parent } })
      const recipes = (row.phaseRecipes ?? {}) as Record<string, Record<string, number>>
      const target = recipes.GROW?.targetAcosPct ?? 30
      expect(dirOf(await plan(product(ids.parent, { values: { phaseRecipes: { ...recipes, GROW: { ...recipes.GROW, targetAcosPct: target + 5 } } } })), 'phaseRecipes')).toBe('raise')
      expect(dirOf(await plan(product(ids.parent, { values: { phaseRecipes: { ...recipes, GROW: { ...recipes.GROW, targetAcosPct: target - 5 } } } })), 'phaseRecipes')).toBe('lower')
      // And the template's phase table: Claude allowed more alone in a phase raises.
      const phases = { ...templateDoc().phases, LAUNCH: { ...templateDoc().phases.LAUNCH!, claude: {} } }
      expect((await plan({ kind: 'template', templateId: ids.template, sections: { phases } })).direction).toBe('raise')
    })
  })

  it('leave lowers; a row that owns campaigns cannot be removed; a named template cannot be removed, an unused one can', async () => {
    await inA(async () => {
      const left = await plan(product(ids.parent, { op: 'leave' }))
      expect(left.preview).toMatchObject({ direction: 'lower' })
      expect(dirOf(left, 'enrolled')).toBe('lower')
      const row = await db().adsPlaybook.findFirstOrThrow({ where: { level: 'PRODUCT', scopeId: ids.parent } })
      await db().adsPlaybookLink.create({ data: { playbookId: row.id, kind: 'slot', key: 'exact-category', refId: ids.campaign, origin: 'adopted', compiledVersion: 1, updatedBy: 'user:test' } })
      expect(await refusal(product(ids.parent, { op: 'remove' }))).toMatchObject({ status: 409, error: expect.stringMatching(/owns 1 campaign/) })
      expect(await refusal({ kind: 'template', templateId: ids.template, op: 'remove' })).toMatchObject({ status: 409, error: expect.stringMatching(/retire it instead/) })
      const captured = await db().adsPlaybookTemplate.findFirstOrThrow({ where: { name: 'Test captured' } })
      await save({ kind: 'template', templateId: captured.id, op: 'remove' })
      expect(await db().adsPlaybookTemplate.findUnique({ where: { id: captured.id } })).toBeNull()
      expect(await db().adsPlaybookVersion.findFirst({ where: { kind: 'template', refId: captured.id, op: 'remove' } })).toMatchObject({ values: null })
    })
  })
})

describe('apply and undo', () => {
  it('a raise without the time of its code is never written; a row moved since is a conflict and nothing is written', async () => {
    await inA(async () => {
      const p = await plan(product(ids.parent, { values: { dailyBudgetCents: 3000 } }))
      expect(p.direction).toBe('raise')
      await expect(applyPlaybookPlan(p, { ...writer(p), stepUpAt: null })).rejects.toThrow(/written only with the time its authenticator code was confirmed/)
      const lower = await plan(product(ids.parent, { values: { dailyBudgetCents: 1800 } }))
      await save(product(ids.parent, { values: { nameToken: 'TESTPB3C' } }))
      const before = await db().adsPlaybookVersion.count()
      expect(await applyPlaybookPlan(lower, writer(lower))).toMatchObject({ ok: false, status: 409, code: 'version_moved' })
      expect(await db().adsPlaybookVersion.count()).toBe(before)
    })
  })

  it('the undo arguments put the previous version back: an added override is cleared again', async () => {
    await inA(async () => {
      const { out } = await save(product(ids.parent, { values: { overrides: { skipSlots: ['exact-brand'] }, dailyBudgetCents: 1700 } }))
      const args = undoArgsOf(out.before, out.after)
      expect(args).toMatchObject({ kind: 'playbook', op: 'set', productId: ids.parent, expectVersion: (out.after as Json).version, values: { overrides: { skipSlots: null }, dailyBudgetCents: 2000 } })
      await save(args)
      const now = await playbookStateNow(out.after) as Extract<PlaybookState, { kind: 'playbook' }>
      expect(now.values).toMatchObject({ overrides: null, dailyBudgetCents: 2000, nameToken: 'TESTPB3C', enrolled: true })
    })
  })
})

describe('business', () => {
  it('another business cannot name this one\'s template or product', async () => {
    await inB(async () => {
      expect(await refusal(product(ids.parent, { values: { nameToken: 'X' } }))).toEqual({ ok: false, status: 404, error: PRODUCT_NOT_FOUND })
      expect(await refusal({ kind: 'template', templateId: ids.template, status: 'DRAFT' })).toMatchObject({ status: 404 })
      expect(await refusal({ kind: 'playbook', market: 'IT', level: 'market', values: { templateId: ids.template } })).toMatchObject({ status: 404 })
      expect(await db().adsPlaybook.count()).toBe(0)
    })
  })
})
