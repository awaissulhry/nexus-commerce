/**
 * Reviews › Fixes › Size guide against real SQL (PGlite with the production schema and policies): the re-check makes one
 * fix per family and direction from fit by size (reviews and size returns), is idempotent, keeps a person's decision,
 * closes a fix whose evidence is gone and makes it again when the evidence comes back; the Fixes list carries it; Send
 * for approval asks ONE change plan with a set-content step (the family's bullets as they are + the sizing bullet), and
 * holds it with the way out when it cannot go. The approval door is a stand-in: nothing is asked of anyone, no AI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../ai/translate.service.js', () => ({ translateProductCopy: vi.fn(async () => { throw new Error('no AI in a size-guide fix') }) }))

const { recheckSizeGuideFixes, recheckSizeGuideIfDue, SIZE_GUIDE_RECHECK_MS } = await import('./review-size-guide.service.js')
const { listFixes, proposeFixes, updateFix } = await import('./review-fix-plan.service.js')
const { PRIMARY_CONTENT_LOCALE } = await import('../pim/content-locale.js')
const { sizingLine } = await import('./review-size-guide.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = { kind: 'user', userId: 'test-user', label: 'Test person', permissions: { isOwner: true, permissions: new Set<string>() }, via: 'app' } as never
const NOW = new Date()
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

let seq = 0
async function review(productId: string, body: string, days = 20) {
  seq += 1
  await database.client.review.create({
    data: {
      channel: 'EBAY', marketplace: 'IT', externalReviewId: `test-sg-${seq}`, productId, rating: 3, body, postedAt: daysAgo(days), ingestSource: 'MANUAL',
      sentiment: { create: { label: 'NEUTRAL', score: 0, categories: ['FIT_SIZING'], model: 'test' } },
    } as never,
  })
}
async function returned(productId: string, reason: string) {
  seq += 1
  await database.client.return.create({
    data: { channel: 'EBAY', marketplace: 'IT', rmaNumber: `TEST-SG-RMA-${seq}`, status: 'RECEIVED', reason, createdAt: daysAgo(10), items: { create: [{ productId, sku: productId.toUpperCase(), quantity: 1 }] } } as never,
  })
}
async function family(id: string, sizes: string[], bulletPoints: string[]) {
  await database.client.product.create({ data: { id, sku: id.toUpperCase(), name: `Test ${id}`, basePrice: 10, isParent: true, bulletPoints } as never })
  for (const size of sizes) {
    await database.client.product.create({ data: { id: `${id}-${size}`.toLowerCase(), sku: `${id}-${size}`.toUpperCase(), name: `Test ${id} ${size}`, basePrice: 10, parentId: id, variantAttributes: { Size: size } } as never })
  }
}
const fixesOf = (productId: string) => inside(() => database.client.reviewActionItem.findMany({ where: { type: 'SIZE_GUIDE', productId }, orderBy: { createdAt: 'asc' } }))

describe('Reviews › Fixes › Size guide (real SQL)', () => {
  const asked: Array<{ tool: string; args: { title: string; steps: Array<{ tool: string; args: Record<string, unknown> }> } }> = []
  const requester = {
    planTool: 'submit-change-plan',
    ask: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      asked.push({ tool, args: args as never })
      const run = await database.client.agentRun.create({ data: { agentKey: 'manual-action', trigger: 'manual', status: 'done' } as never })
      const approval = await database.client.agentApproval.create({
        data: { agentRunId: run.id, toolName: tool, riskTier: 'high', args: { title: (args as { title: string }).title }, status: 'pending', expiresAt: new Date(Date.now() + 86_400_000) } as never,
      })
      return { ok: true, mode: 'queued', approvalId: approval.id, expiresAt: approval.expiresAt, plan: { steps: (args as { steps: unknown[] }).steps.length, summary: 'Test plan', planHash: 'x' } }
    }),
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      // A jacket whose M and L run small (reviews on M, size returns on L); S has too few.
      await family('test-sg', ['S', 'M', 'L'], ['Test shell fabric', 'Two test pockets'])
      for (let i = 0; i < 4; i += 1) await review('test-sg-m', 'Runs small, order one size up')
      await review('test-sg-m', 'Fits true to size')
      for (let i = 0; i < 2; i += 1) await returned('test-sg-m', 'apparel too small')
      for (let i = 0; i < 3; i += 1) await review('test-sg-l', 'Way too tight on the chest')
      for (let i = 0; i < 2; i += 1) await returned('test-sg-l', 'size too small')
      await review('test-sg-s', 'Runs small')
      // Trousers whose 48 runs large; the family keeps no bullet points in Nexus.
      await family('test-sg-pants', ['46', '48'], [])
      for (let i = 0; i < 5; i += 1) await review('test-sg-pants-48', 'Runs large')
      // Gloves whose M runs small, with ten bullet points already.
      await family('test-sg-gloves', ['S', 'M'], Array.from({ length: 10 }, (_, i) => `Test glove point ${i + 1}`))
      for (let i = 0; i < 5; i += 1) await review('test-sg-gloves-m', 'Too small')
      // Old reviews never count (outside the last 12 months).
      for (let i = 0; i < 5; i += 1) await review('test-sg-gloves-s', 'Runs large', 400)
      // Another kind of fix on the jacket stays as it is.
      await database.client.reviewActionItem.create({ data: { id: 'f-bullets', type: 'BULLETS', productId: 'test-sg', title: 'Test bullets', category: 'FIT_SIZING', payload: { bullets: ['x'], language: 'en' } } as never })
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close()
  })

  it('the re-check makes one fix per family and direction, and a second re-check changes nothing', async () => {
    expect(await inside(() => recheckSizeGuideFixes(NOW))).toEqual({ created: 3, refreshed: 0, closed: 0, gone: 0 })
    const [jacket] = await fixesOf('test-sg')
    expect(jacket).toMatchObject({
      type: 'SIZE_GUIDE', status: 'OPEN', marketplace: null, category: 'FIT_SIZING', source: 'fit-by-size', spikeId: null,
      title: 'Runs small: 7 reviews and 4 size returns say so for sizes M–L',
      payload: { direction: 'small', sizes: ['M', 'L'], allSizes: false, reviews: 7, returns: 4, language: PRIMARY_CONTENT_LOCALE, line: sizingLine('small', ['M', 'L'], ['S', 'M', 'L'], false, PRIMARY_CONTENT_LOCALE) },
    })
    expect((await fixesOf('test-sg-pants'))[0]).toMatchObject({ title: 'Runs large: 5 reviews say so for size 48', payload: { direction: 'large', sizes: ['48'] } })
    expect((await fixesOf('test-sg-gloves')).map((f) => f.payload)).toEqual([expect.objectContaining({ direction: 'small', sizes: ['M'] })])
    expect(await inside(() => recheckSizeGuideFixes(new Date(NOW.getTime() + 60_000)))).toEqual({ created: 0, refreshed: 0, closed: 0, gone: 0 })
  })

  it('the Fixes list carries them: the chip filters real rows, each with its proposal, evidence and why it is held', async () => {
    const list = await inside(() => listFixes({ kind: 'SIZE_GUIDE', now: NOW }))
    expect(list.items.map((i) => [i.product?.sku, i.kind])).toEqual(expect.arrayContaining([['TEST-SG', 'SIZE_GUIDE'], ['TEST-SG-PANTS', 'SIZE_GUIDE'], ['TEST-SG-GLOVES', 'SIZE_GUIDE']]))
    expect(list.items).toHaveLength(3)
    const byProduct = Object.fromEntries(list.items.map((i) => [i.product!.id, i]))
    expect(byProduct['test-sg']).toMatchObject({
      kindWords: 'Size guide', held: null, closed: null,
      proposal: {
        language: PRIMARY_CONTENT_LOCALE,
        sizeGuide: { direction: 'small', sizes: ['M', 'L'], reviews: 7, returns: 4, advice: 'Tell buyers to order one size up in sizes M–L: in the size guide and in the listing text.', evidence: [expect.stringMatching(/^M — Runs small/), expect.stringMatching(/^L — Runs small/)] },
      },
    })
    expect(byProduct['test-sg-pants'].held).toMatch(/keeps no bullet points in Nexus.*Create a task instead/)
    expect(byProduct['test-sg-gloves'].held).toMatch(/has 10 bullet points already: make room in the product sheet, or create a task instead/)
  })

  it('Send for approval: ONE change plan with the bullets as they are + the sizing bullet; nothing else, no AI', async () => {
    const [jacket] = await fixesOf('test-sg')
    const line = (jacket.payload as { line: string }).line
    const out = await inside(() => proposeFixes([jacket.id], person, { requester }))
    expect(out).toMatchObject({ changed: 1, held: [], sent: { fixes: 1, steps: 1 } })
    expect(asked[0].args.title).toBe('Reviews fixes: 1 fix from buyers’ reviews (1 × Size guide)')
    expect(asked[0].args.steps).toEqual([{
      tool: 'set-content',
      args: {
        product: 'test-sg', language: PRIMARY_CONTENT_LOCALE, bulletPoints: ['Test shell fabric', 'Two test pockets', line],
        ...(PRIMARY_CONTENT_LOCALE === 'en' ? {} : { englishMeaning: { bulletPoints: 'The 2 bullet points as they are, then a new last one: “Sizes M–L run small: we suggest ordering one size up.”' } }),
      },
    }])
    expect((await fixesOf('test-sg'))[0]).toMatchObject({ status: 'SENT' })
    // Held ones are held with their way out, and nothing is asked for them.
    const held = await inside(async () => proposeFixes([(await fixesOf('test-sg-pants'))[0].id], person, { requester }))
    expect(held).toMatchObject({ changed: 0, sent: null, held: [{ words: expect.stringMatching(/keeps no bullet points/) }] })
    expect(requester.ask).toHaveBeenCalledTimes(1)
  })

  it('an edit of the bullet is kept by the re-check; the language follows the product’s text', async () => {
    const [gloves] = await fixesOf('test-sg-gloves')
    expect(await inside(() => updateFix(gloves.id, { line: 'Test sizing line', english: 'Test sizing line in English' }))).toMatchObject({ ok: true })
    expect((await fixesOf('test-sg-gloves'))[0].payload).toMatchObject({ line: 'Test sizing line', edited: true })
    await expect(inside(() => updateFix(gloves.id, { language: 'de' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(inside(() => updateFix('f-bullets', { line: 'x' }))).rejects.toMatchObject({ statusCode: 400 })
    await inside(() => recheckSizeGuideFixes(NOW))
    expect((await fixesOf('test-sg-gloves'))[0].payload).toMatchObject({ line: 'Test sizing line', edited: true })
  })

  it('a person’s Dismiss stands while the evidence does; gone evidence closes an open fix; when it comes back, a new fix', async () => {
    const [pants] = await fixesOf('test-sg-pants')
    await inside(() => updateFix(pants.id, { status: 'DISMISSED' }))
    expect(await inside(() => recheckSizeGuideFixes(NOW))).toMatchObject({ created: 0 })

    // The evidence goes: the reviews are hidden as fixtures (they never count).
    await inside(() => database.client.review.updateMany({ where: { productId: { in: ['test-sg-pants-48', 'test-sg-gloves-m'] } }, data: { ingestSource: 'FIXTURE' } }))
    expect(await inside(() => recheckSizeGuideFixes(NOW))).toEqual({ created: 0, refreshed: 0, closed: 1, gone: 1 })
    const [gloves] = await fixesOf('test-sg-gloves')
    expect(gloves).toMatchObject({ status: 'DISMISSED', payload: { closed: { words: 'Closed by Nexus: the reviews and returns of the last 12 months no longer say size M runs small.' } } })
    expect((await fixesOf('test-sg-pants'))[0].payload).toMatchObject({ evidenceGoneAt: NOW.toISOString() })
    const list = await inside(() => listFixes({ kind: 'SIZE_GUIDE', status: 'DISMISSED', now: new Date(NOW.getTime() + SIZE_GUIDE_RECHECK_MS * 2) }))
    expect(list.items.find((i) => i.id === gloves.id)).toMatchObject({ closed: { words: expect.stringMatching(/^Closed by Nexus/) } })
    // A SENT fix waits for its person, evidence or not.
    expect((await fixesOf('test-sg'))[0]).toMatchObject({ status: 'SENT' })

    // The evidence comes back: one new open fix each.
    await inside(() => database.client.review.updateMany({ where: { productId: { in: ['test-sg-pants-48', 'test-sg-gloves-m'] } }, data: { ingestSource: 'MANUAL' } }))
    expect(await inside(() => recheckSizeGuideFixes(NOW))).toEqual({ created: 2, refreshed: 0, closed: 0, gone: 0 })
    expect((await fixesOf('test-sg-pants')).map((f) => f.status)).toEqual(['DISMISSED', 'OPEN'])
  })

  it('runs from the list at most once per few minutes per business', async () => {
    const t = new Date(NOW.getTime() + 3_600_000)
    expect(await inside(() => recheckSizeGuideIfDue(t))).not.toBeNull()
    expect(await inside(() => recheckSizeGuideIfDue(new Date(t.getTime() + 1_000)))).toBeNull()
    expect(await inside(() => recheckSizeGuideIfDue(new Date(t.getTime() + SIZE_GUIDE_RECHECK_MS)))).not.toBeNull()
  })
})
