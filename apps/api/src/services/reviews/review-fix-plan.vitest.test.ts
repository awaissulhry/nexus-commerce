/**
 * Reviews Insights › Fixes — a fix becomes change-plan steps by kind (Bullets → set-content in the market's language,
 * A+ → set-aplus-content draft on the product's ASIN, Recall check → reserve-stock in OWN warehouses only, never Amazon
 * FBA), every ticked fix that can be sent goes into ONE change plan, Tasks are created without approval, the rest are
 * held in words; a step the plan refuses holds only its own fix. Then the plan decides the status: Sent → Applied,
 * withdrawn → Open. Real SQL (PGlite with the production schema and policies); the approval door and the translation
 * are stand-ins, so nothing is asked of anyone and no AI is called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../ai/translate.service.js', () => ({
  translateProductCopy: vi.fn(async (input: { source: { bulletPoints?: string[]; name?: string; description?: string }; targetLanguage: string }) => ({
    language: input.targetLanguage,
    bulletPoints: input.source.bulletPoints?.map((b) => `[${input.targetLanguage}] ${b}`) ?? null,
    name: input.source.name ? `[${input.targetLanguage}] ${input.source.name}` : null,
    description: input.source.description ? `[${input.targetLanguage}] ${input.source.description}` : null,
  })),
}))

const fixPlan = await import('./review-fix-plan.service.js')
const { stepsForFix, assertOwnWarehouses, FbaRefusedError, proposeFixes, withdrawFix, syncSentFixes, listFixes, createFixTask, bulkFixes, updateFix } = fixPlan
type FixRow = Parameters<typeof stepsForFix>[0]
type FixFacts = Parameters<typeof stepsForFix>[1]

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = { kind: 'user', userId: 'test-user', label: 'Test person', permissions: { isOwner: true, permissions: new Set<string>() }, via: 'app' } as never

const fix = (over: Partial<FixRow>): FixRow => ({
  id: 'f', type: 'BULLETS', status: 'OPEN', productId: 'p', marketplace: 'DE', category: 'FIT_SIZING', title: 'Fix', detail: null,
  payload: {}, approvalId: null, spikeId: null, source: 'manual', createdBy: null, createdAt: new Date(), updatedAt: new Date(), ...over,
})
const facts = (over: Partial<FixFacts>): FixFacts => ({
  product: { id: 'p', sku: 'TEST-P', name: 'Test product' }, language: 'de', languageProblem: null, amazonMarket: true, asin: 'B0TESTP001',
  text: null, textProblem: null, stock: [], ...over,
})

describe('a fix becomes its steps (pure)', () => {
  it('Bullets → set-content in the market’s language, with what it means in English', () => {
    const out = stepsForFix(fix({}), facts({ text: { bulletPoints: ['[de] Runs small'], english: 'Runs small' } }))
    expect(out).toEqual({ steps: [{ tool: 'set-content', args: { product: 'p', language: 'de', bulletPoints: ['[de] Runs small'], englishMeaning: { bulletPoints: 'Runs small' } } }] })
    expect(stepsForFix(fix({}), facts({ language: 'en', text: { bulletPoints: ['Runs small'], english: null } }))).toEqual({
      steps: [{ tool: 'set-content', args: { product: 'p', language: 'en', bulletPoints: ['Runs small'] } }],
    })
  })

  it('A+ → a set-aplus-content draft applied to the product’s ASIN on that market', () => {
    const out = stepsForFix(fix({ type: 'APLUS' }), facts({ text: { headline: '[de] H', body: '[de] B', english: 'H: B' } }))
    expect(out).toMatchObject({
      steps: [{ tool: 'set-aplus-content', args: { op: 'create', market: 'DE', language: 'de', asins: ['B0TESTP001'], summary: 'H: B', modules: [{ contentModuleType: 'STANDARD_TEXT', standardText: { headline: { value: '[de] H' }, body: { textList: [{ value: '[de] B' }] } } }] } }],
    })
  })

  it('held, with the way out: no listing on the market, not an Amazon market, no market, size guide, no product', () => {
    expect(stepsForFix(fix({ type: 'APLUS', marketplace: 'ES' }), facts({ asin: null }))).toEqual({ held: expect.stringMatching(/no live listing on Amazon Spain/) })
    expect(stepsForFix(fix({ type: 'APLUS', marketplace: 'IT' }), facts({ amazonMarket: false }))).toEqual({ held: expect.stringMatching(/not one of this business’s Amazon markets/) })
    expect(stepsForFix(fix({ type: 'APLUS', marketplace: null }), facts({}))).toEqual({ held: expect.stringMatching(/names none/) })
    expect(stepsForFix(fix({ type: 'SIZE_GUIDE' }), facts({}))).toEqual({ held: expect.stringMatching(/come later/) })
    expect(stepsForFix(fix({}), facts({ product: null }))).toEqual({ held: expect.stringMatching(/no longer in Nexus/) })
    expect(stepsForFix(fix({}), facts({ text: { bulletPoints: ['Lauf klein'], english: null } }))).toEqual({ held: expect.stringMatching(/in English/) })
    expect(stepsForFix(fix({}), facts({ textProblem: 'Nexus could not translate the text into German (down).' }))).toEqual({ held: expect.stringMatching(/could not translate/) })
  })

  it('Recall check holds stock in OWN warehouses only — never Amazon FBA', () => {
    const stock = [
      { productId: 'p', sku: 'TEST-P', location: 'TEST-WH-1', locationType: 'WAREHOUSE', available: 30 },
      { productId: 'p', sku: 'TEST-P', location: 'TEST-FBA', locationType: 'AMAZON_FBA', available: 50 },
      { productId: 'p', sku: 'TEST-P', location: 'TEST-SHOP', locationType: 'SHOPIFY_LOCATION', available: 5 },
    ]
    const out = stepsForFix(fix({ type: 'RECALL_FLAG' }), facts({ stock }))
    expect(out).toEqual({ steps: [{ tool: 'reserve-stock', args: { action: 'reserve', productId: 'p', location: 'TEST-WH-1', quantity: 30, reason: 'MANUAL_HOLD', days: 14 } }] })
    expect(JSON.stringify(out)).not.toMatch(/TEST-FBA|TEST-SHOP/)
    expect(stepsForFix(fix({ type: 'RECALL_FLAG' }), facts({ stock: [stock[1]] }))).toEqual({ held: expect.stringMatching(/All 50 available units are Amazon FBA stock: Nexus never holds Amazon FBA stock/) })
    expect(stepsForFix(fix({ type: 'RECALL_FLAG' }), facts({ stock: [] }))).toEqual({ held: expect.stringMatching(/No units/) })
  })

  it('a hold step on an FBA location is refused in code, never asked for', () => {
    const stock = [{ productId: 'p', sku: 'TEST-P', location: 'TEST-FBA', locationType: 'AMAZON_FBA', available: 50 }]
    expect(() => assertOwnWarehouses([{ tool: 'reserve-stock', args: { productId: 'p', location: 'TEST-FBA', quantity: 5 } }], stock)).toThrow(FbaRefusedError)
    expect(() => assertOwnWarehouses([{ tool: 'reserve-stock', args: { productId: 'p', location: 'TEST-FBA', quantity: 5 } }], stock)).toThrow(/never holds Amazon FBA stock/)
    expect(() => assertOwnWarehouses([{ tool: 'reserve-stock', args: { productId: 'p', location: 'NOWHERE', quantity: 5 } }], stock)).toThrow(/not one of this business’s own warehouses/)
    expect(() => assertOwnWarehouses([{ tool: 'set-content', args: {} }], [])).not.toThrow()
  })
})

describe('Send for approval: ONE change plan (real SQL)', () => {
  const asked: Array<{ tool: string; args: { title: string; steps: Array<{ tool: string; args: Record<string, unknown> }> } }> = []
  let refuseFirst: { step: number; tool: string; error: string } | null = null
  const requester = {
    planTool: 'submit-change-plan',
    ask: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      asked.push({ tool, args: args as never })
      if (refuseFirst) {
        const refusal = refuseFirst
        refuseFirst = null
        return { ok: false, mode: 'error', error: 'The plan was not stored', refusals: [refusal] }
      }
      const run = await database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } as never })
      const approval = await database.client.agentApproval.create({
        data: { agentRunId: run.id, toolName: tool, riskTier: 'high', args: { title: (args as { title: string }).title }, status: 'pending', expiresAt: new Date(Date.now() + 86_400_000) } as never,
      })
      return { ok: true, mode: 'queued', approvalId: approval.id, expiresAt: approval.expiresAt, plan: { steps: (args as { steps: unknown[] }).steps.length, summary: 'Test plan', planHash: 'x' } }
    }),
  }
  const item = (id: string, data: Record<string, unknown>) =>
    database.client.reviewActionItem.create({ data: { id, title: `Test ${id}`, category: 'FIT_SIZING', marketplace: 'DE', ...data } as never })
  const statusOf = async (id: string) => (await inside(() => database.client.reviewActionItem.findUnique({ where: { id } })))!

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      for (const [code, language] of [['DE', 'de'], ['IT', 'it'], ['ES', 'es']]) {
        await c.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency: 'EUR', language, languages: [language] } as never })
      }
      await c.product.create({ data: { id: 'test-jacket', sku: 'TEST-JKT', name: 'Test jacket', basePrice: 10 } as never })
      await c.product.create({ data: { id: 'test-gloves', sku: 'TEST-GLV', name: 'Test gloves', basePrice: 10 } as never })
      await c.product.create({ data: { id: 'test-boots', sku: 'TEST-BOOT', name: 'Test boots', basePrice: 10 } as never })
      await c.channelListing.create({ data: { productId: 'test-jacket', channelMarket: 'AMAZON_DE', channel: 'AMAZON', region: 'DE', marketplace: 'DE', listingStatus: 'ACTIVE', externalListingId: 'B0TESTJKT1' } as never })
      const wh1 = await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-WH-1', name: 'Test warehouse 1' } as never })
      const wh2 = await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-WH-2', name: 'Test warehouse 2' } as never })
      const fba = await c.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Test FBA' } as never })
      await c.stockLevel.create({ data: { productId: 'test-gloves', locationId: wh1.id, quantity: 30, reserved: 0, available: 30 } as never })
      await c.stockLevel.create({ data: { productId: 'test-gloves', locationId: wh2.id, quantity: 16, reserved: 0, available: 16 } as never })
      await c.stockLevel.create({ data: { productId: 'test-gloves', locationId: fba.id, quantity: 50, reserved: 0, available: 50 } as never })
      await c.stockLevel.create({ data: { productId: 'test-boots', locationId: fba.id, quantity: 20, reserved: 0, available: 20 } as never })

      await item('f-bullets', { type: 'BULLETS', productId: 'test-jacket', payload: { bullets: ['Runs small: order one size up'], language: 'en' } })
      await item('f-aplus', { type: 'APLUS', productId: 'test-jacket', payload: { module: { headline: 'Our fit', body: 'Order one size up.' } } })
      await item('f-aplus-es', { type: 'APLUS', productId: 'test-jacket', marketplace: 'ES', payload: { module: { headline: 'Our fit', body: 'Order one size up.' } } })
      await item('f-recall', { type: 'RECALL_FLAG', productId: 'test-gloves', category: 'SAFETY' })
      await item('f-recall-fba', { type: 'RECALL_FLAG', productId: 'test-boots', category: 'SAFETY' })
      await item('f-task', { type: 'TASK', productId: 'test-gloves', category: 'SHIPPING' })
      await item('f-dismissed', { type: 'BULLETS', productId: 'test-jacket', status: 'DISMISSED', payload: { bullets: ['x'] } })
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close()
  })

  it('every ticked fix that can be sent goes into ONE plan; a Task is created without approval; the rest are held in words', async () => {
    const out = await inside(() => proposeFixes(['f-bullets', 'f-aplus', 'f-aplus-es', 'f-recall', 'f-recall-fba', 'f-task', 'f-dismissed', 'nope'], person, { requester }))
    expect(requester.ask).toHaveBeenCalledTimes(1)
    expect(asked[0].tool).toBe('submit-change-plan')
    expect(asked[0].args.title).toBe('Reviews fixes: 3 fixes from buyers’ reviews (1 × Bullets, 1 × A+ content, 1 × Recall check)')
    expect(asked[0].args.steps.map((s) => s.tool)).toEqual(['set-content', 'set-aplus-content', 'reserve-stock', 'reserve-stock'])
    expect(asked[0].args.steps[0].args).toEqual({ product: 'test-jacket', language: 'de', bulletPoints: ['[de] Runs small: order one size up'], englishMeaning: { bulletPoints: 'Runs small: order one size up' } })
    expect(asked[0].args.steps[1].args).toMatchObject({ op: 'create', market: 'DE', asins: ['B0TESTJKT1'], language: 'de' })
    expect(asked[0].args.steps.slice(2).map((s) => [s.args.location, s.args.quantity])).toEqual([['TEST-WH-1', 30], ['TEST-WH-2', 16]])
    expect(JSON.stringify(asked[0].args)).not.toMatch(/TEST-FBA/)

    expect(out).toMatchObject({ changed: 4, tasks: 1, sent: { fixes: 3, steps: 4, summary: 'Test plan' } })
    const held = Object.fromEntries(out.held.map((h) => [h.id, h.words]))
    expect(Object.keys(held).sort()).toEqual(['f-aplus-es', 'f-dismissed', 'f-recall-fba', 'nope'])
    expect(held['f-aplus-es']).toMatch(/no live listing on Amazon Spain/)
    expect(held['f-recall-fba']).toMatch(/never holds Amazon FBA stock/)
    expect(held['f-dismissed']).toBe('Dismissed: bring it back first.')

    const approvalId = out.sent!.approvalId
    for (const id of ['f-bullets', 'f-aplus', 'f-recall']) expect(await statusOf(id)).toMatchObject({ status: 'SENT', approvalId })
    expect((await statusOf('f-recall')).payload).toMatchObject({ plan: { approvalId, positions: [3, 4], sentBy: 'test-user' } })
    expect(await statusOf('f-task')).toMatchObject({ status: 'APPLIED', approvalId: null, payload: { task: { createdBy: 'test-user' } } })
  })

  it('the list says why each Open fix cannot be sent, and follows the plan', async () => {
    const list = await inside(() => listFixes({}))
    const byId = Object.fromEntries(list.items.map((i) => [i.id, i]))
    expect(byId['f-aplus-es'].held).toMatch(/no live listing on Amazon Spain/)
    expect(byId['f-bullets']).toMatchObject({ status: 'SENT', held: null, plan: { state: 'waiting', words: 'Change plan waits on the Approvals page' } })
    expect(byId['f-task']).toMatchObject({ kindWords: 'Task', status: 'APPLIED', applied: { words: 'Task created: nothing changed on a channel' } })
    expect(list.counts).toMatchObject({ SENT: 3, APPLIED: 1, DISMISSED: 1, OPEN: 2 })
  })

  it('Withdraw takes the waiting plan back: every fix in it is Open again', async () => {
    const approvalId = (await statusOf('f-bullets')).approvalId!
    const out = await inside(() => withdrawFix('f-bullets', 'test-user'))
    expect(out).toEqual({ withdrawn: true, approvalId, fixes: 3 })
    const approval = await inside(() => database.client.agentApproval.findUnique({ where: { id: approvalId } }))
    expect(approval).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/^withdrawn:/) })
    for (const id of ['f-bullets', 'f-aplus', 'f-recall']) expect(await statusOf(id)).toMatchObject({ status: 'OPEN', approvalId: null })
    await expect(inside(() => withdrawFix('f-bullets', 'test-user'))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a step the plan refuses holds only its own fix; the rest go in one plan', async () => {
    asked.length = 0
    requester.ask.mockClear()
    refuseFirst = { step: 2, tool: 'set-aplus-content', error: 'Amazon refused it: this account needs Brand Registry for this market.' }
    const out = await inside(() => bulkFixes({ ids: ['f-bullets', 'f-aplus', 'f-recall'], action: 'propose' }, person, { requester }))
    expect(requester.ask).toHaveBeenCalledTimes(2)
    expect(asked[1].args.steps.map((s) => s.tool)).toEqual(['set-content', 'reserve-stock', 'reserve-stock'])
    expect(out).toMatchObject({ changed: 2, held: [{ id: 'f-aplus', words: 'Not sent — A+ content: Amazon refused it: this account needs Brand Registry for this market.' }] })
    expect(await statusOf('f-aplus')).toMatchObject({ status: 'OPEN', approvalId: null })
    expect(await statusOf('f-recall')).toMatchObject({ status: 'SENT' })
  })

  it('once the plan ran, its fixes are Applied (with how many of their changes were made)', async () => {
    const approvalId = (await statusOf('f-recall')).approvalId!
    await inside(async () => {
      await database.client.agentApproval.update({ where: { id: approvalId }, data: { status: 'executed', decidedBy: 'Test approver' } })
      await database.client.agentPlanStep.createMany({
        data: [
          { approvalId, position: 1, toolName: 'set-content', args: {}, status: 'done' },
          { approvalId, position: 2, toolName: 'reserve-stock', args: {}, status: 'done' },
          { approvalId, position: 3, toolName: 'reserve-stock', args: {}, status: 'skipped', reason: 'the stock moved' },
        ] as never,
      })
    })
    expect(await inside(() => syncSentFixes())).toBe(2)
    expect(await statusOf('f-bullets')).toMatchObject({ status: 'APPLIED', approvalId, payload: { applied: { words: 'Applied · approved by Test approver' } } })
    expect(await statusOf('f-recall')).toMatchObject({ status: 'APPLIED', payload: { applied: { words: '1 of 2 changes made; 1 not: the stock moved' } } })
  })

  it('Dismiss, bring back, no direct Apply, and an edit only while Open', async () => {
    await expect(inside(() => updateFix('f-aplus', { status: 'APPLIED' }))).rejects.toMatchObject({ statusCode: 400 })
    expect(await inside(() => updateFix('f-aplus', { module: { headline: 'Unser Schnitt', body: 'Eine Nummer größer bestellen.' }, language: 'de', english: 'Our fit: order one size up.' }))).toMatchObject({ ok: true })
    expect((await statusOf('f-aplus')).payload).toMatchObject({ module: { headline: 'Unser Schnitt' }, language: 'de', english: 'Our fit: order one size up.' })
    expect(await inside(() => bulkFixes({ ids: ['f-aplus', 'f-recall'], action: 'dismiss' }, person))).toEqual({ changed: 1, held: [{ id: 'f-recall', words: 'Applied: undo it from its change plan.' }] })
    await expect(inside(() => updateFix('f-aplus', { title: 'x' }))).rejects.toMatchObject({ statusCode: 409 })
    expect(await inside(() => updateFix('f-aplus', { status: 'OPEN' }))).toMatchObject({ ok: true })
    await expect(inside(() => createFixTask('f-recall', 'test-user'))).rejects.toMatchObject({ statusCode: 409 })
    expect(await inside(() => createFixTask('f-aplus', 'test-user'))).toMatchObject({ ok: true, item: { status: 'APPLIED' } })
  })
})
