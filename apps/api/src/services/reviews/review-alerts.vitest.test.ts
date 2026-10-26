/**
 * Reviews Insights › Alerts — the bulk bar changes only the ticked alerts it applies to and names why it skipped each
 * other one (ruling 7): Acknowledge N, Resolve N, Suggest fixes (at most 5); one alert's decision (Reopen forgets who
 * acknowledged and resolved it; the actor is the signed-in person); the list with its counts and channels. Real SQL
 * (PGlite with the production schema and policies); the AI is a stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const { bulkAlerts, decideAlert, listAlerts, parseDecision, decisionHeld } = await import('./review-alerts.service.js')

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)
const spikeOf = (id: string) => inside(() => database.client.reviewSpike.findUnique({ where: { id } }))

describe('Reviews Insights › Alerts (real SQL)', () => {
  const generate = vi.fn(async (spikeId: string) => ({ created: [{ id: `fix-for-${spikeId}` }, { id: `fix2-for-${spikeId}` }] }))

  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const c = database.client
      await c.product.create({ data: { id: 'test-jacket', sku: 'TEST-JKT', name: 'Test jacket', basePrice: 10 } as never })
      const spike = (id: string, status: string, extra: Record<string, unknown> = {}) => c.reviewSpike.create({
        data: { id, productId: 'test-jacket', marketplace: 'DE', category: 'FIT_SIZING', rate7dNumerator: 9, rate7dDenominator: 50, rate28dNumerator: 14, rate28dDenominator: 200, spikeMultiplier: 2.6, sampleTopPhrases: ['runs small'], status, detectedAt: daysAgo(3), ...extra } as never,
      })
      await spike('s-open', 'OPEN')
      await spike('s-ack', 'ACKNOWLEDGED', { acknowledgedAt: daysAgo(2), acknowledgedBy: 'user:old-label' })
      await spike('s-res', 'RESOLVED', { resolvedAt: daysAgo(1), resolvedBy: 'test-user' })
      for (const n of [2, 3, 4, 5, 6]) await spike(`s-open${n}`, 'OPEN', { category: 'DURABILITY', marketplace: 'IT' })
      await c.reviewActionItem.create({ data: { spikeId: 's-open6', productId: 'test-jacket', type: 'BULLETS', title: 'Test fix' } as never })
      // The channel of the DE alert: an Amazon review in its 7 days.
      await c.review.create({
        data: {
          channel: 'AMAZON', marketplace: 'DE', externalReviewId: 'test-alert-1', productId: 'test-jacket', rating: 2, body: 'Runs small', postedAt: daysAgo(4), ingestSource: 'IMPORT_CSV',
          sentiment: { create: { label: 'NEGATIVE', score: -0.5, categories: ['FIT_SIZING'], model: 'test' } },
        } as never,
      })
    })
  }, 120_000)

  afterAll(async () => {
    await database?.close()
  })

  it('pure: which decision an alert can take', () => {
    expect(decisionHeld('OPEN', 'ACKNOWLEDGED')).toBeNull()
    expect(decisionHeld('ACKNOWLEDGED', 'ACKNOWLEDGED')).toBe('Already acknowledged.')
    expect(decisionHeld('RESOLVED', 'ACKNOWLEDGED')).toBe('Already resolved: reopen it first.')
    expect(decisionHeld('OPEN', 'REOPEN')).toBe('Already open.')
    expect(parseDecision('reopen')).toBe('REOPEN')
    expect(() => parseDecision('APPLY')).toThrow(/ACKNOWLEDGED, RESOLVED or REOPEN/)
  })

  it('Acknowledge N changes only the ticked alerts it applies to; each other one is held, saying why', async () => {
    const out = await inside(() => bulkAlerts({ ids: ['s-open', 's-ack', 's-res', 'nope'], action: 'acknowledge' }, 'test-user', generate))
    expect(out).toEqual({
      changed: 1,
      held: [
        { id: 's-ack', words: 'Already acknowledged.' },
        { id: 's-res', words: 'Already resolved: reopen it first.' },
        { id: 'nope', words: 'Not found in this business’s alerts.' },
      ],
    })
    expect(await spikeOf('s-open')).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgedBy: 'test-user' })
  })

  it('held as a whole when it applies to none of the ticked alerts', async () => {
    expect(await inside(() => bulkAlerts({ ids: ['s-res'], action: 'resolve' }, 'test-user', generate))).toEqual({ changed: 0, held: [{ id: 's-res', words: 'Already resolved.' }] })
  })

  it('Resolve N records who resolved it', async () => {
    const out = await inside(() => bulkAlerts({ ids: ['s-ack', 's-res'], action: 'resolve' }, 'test-user', generate))
    expect(out).toMatchObject({ changed: 1, held: [{ id: 's-res' }] })
    expect(await spikeOf('s-ack')).toMatchObject({ status: 'RESOLVED', resolvedBy: 'test-user' })
  })

  it('Suggest fixes: at most 5 alerts; resolved ones and ones that have fixes are held', async () => {
    const six = await inside(() => bulkAlerts({ ids: ['s-open', 's-open2', 's-open3', 's-open4', 's-open5', 's-open6'], action: 'suggest' }, 'test-user', generate))
    expect(six.changed).toBe(0)
    expect(six.held).toHaveLength(6)
    expect(six.held[0].words).toBe('Suggest fixes works on up to 5 alerts at a time: untick 1.')
    expect(generate).not.toHaveBeenCalled()

    const out = await inside(() => bulkAlerts({ ids: ['s-open2', 's-res', 's-open6'], action: 'suggest' }, 'test-user', generate))
    expect(out).toEqual({
      changed: 1,
      fixes: 2,
      held: [
        { id: 's-res', words: 'Resolved: reopen it to ask for fixes.' },
        { id: 's-open6', words: 'It has fixes already: they are on the Fixes page.' },
      ],
    })
    expect(generate).toHaveBeenCalledWith('s-open2', 'test-user')
  })

  it('a bulk request needs ids and a known action', async () => {
    await expect(inside(() => bulkAlerts({ ids: [], action: 'resolve' }, 'test-user', generate))).rejects.toMatchObject({ statusCode: 400 })
    await expect(inside(() => bulkAlerts({ ids: ['s-open'], action: 'delete' }, 'test-user', generate))).rejects.toMatchObject({ statusCode: 400 })
    await expect(inside(() => bulkAlerts({ ids: Array.from({ length: 201 }, (_, i) => `x${i}`), action: 'resolve' }, 'test-user', generate))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('Reopen forgets who acknowledged and resolved it; a repeated decision is a 409 with the reason', async () => {
    await inside(() => decideAlert('s-res', 'REOPEN', 'test-user'))
    expect(await spikeOf('s-res')).toMatchObject({ status: 'OPEN', resolvedAt: null, resolvedBy: null, acknowledgedBy: null })
    await expect(inside(() => decideAlert('s-res', 'REOPEN', 'test-user'))).rejects.toMatchObject({ statusCode: 409, message: 'Already open.' })
    await expect(inside(() => decideAlert('nope', 'RESOLVED', 'test-user'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('the list: counts per status, channels from the reviews, who decided, the fixes each alert has', async () => {
    const all = await inside(() => listAlerts({}))
    expect(all.counts).toEqual({ open: 6, acknowledged: 1, resolved: 1 })
    const de = all.items.find((i) => i.id === 's-open')!
    expect(de).toMatchObject({ channels: ['AMAZON'], where: 'Amazon Germany', from: 7, to: 18, basis: '9 of 50 reviews in 7 days', theme: { key: 'FIT_SIZING', label: 'Fit & sizing' }, acknowledged: { by: 'someone' } })
    expect(all.items.find((i) => i.id === 's-open6')!.fixes).toEqual({ open: 1, sent: 0, applied: 0, dismissed: 0 })
    const amazon = await inside(() => listAlerts({ channel: 'AMAZON' }))
    expect(amazon.items.map((i) => i.id).sort()).toEqual(['s-ack', 's-open', 's-res'])
    const resolved = await inside(() => listAlerts({ status: 'resolved' }))
    expect(resolved.items.map((i) => [i.id, i.resolved?.by])).toEqual([['s-ack', 'someone']])
    expect(resolved.check.schedule).toBe('17 * * * *')
  })
})
