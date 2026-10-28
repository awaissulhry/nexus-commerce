/**
 * Reviews Overview — Etsy against real SQL (PGlite with the production schema and policies), lane N4 (2026-10-27):
 * "Needs you" lists the Etsy reviews that need a reply with their reply window (100 days from the buyer's last edit),
 * the ones about to close first, inside the one needs-a-reply count (never a second count); and with no Etsy shop
 * connected the channel table shows Etsy as "Not connected" with Connect — never sample numbers. Nothing leaves this
 * machine: no channel is called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    redis: { connection: null },
  }
})
vi.mock('../review-events.service.js', () => ({
  publishReviewEvent: vi.fn(),
  subscribeReviewEvents: vi.fn(() => () => {}),
  getReviewListenerCount: vi.fn(() => 0),
  replayReviewEventsSince: vi.fn(() => []),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const NOW = new Date()
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY)

describe('Etsy in the Reviews Overview (real SQL)', () => {
  beforeAll(async () => {
    database = await formulaDatabase()
    await inside(async () => {
      const review = (id: string, data: Record<string, unknown>) => database.client.review.create({
        data: { id, externalReviewId: `TEST-${id}`, body: 'Strap feels thin.', rating: 3, ingestSource: 'ETSY_API', channel: 'ETSY', marketplace: 'IT', ...data } as never,
      })
      // Edited 96 days ago: 4 days left to reply on Etsy.com.
      await review('etsy-closing', { postedAt: daysAgo(150), channelEditedAt: daysAgo(96) })
      // Edited 20 days ago: 80 days left — needs a reply, not urgent.
      await review('etsy-open', { postedAt: daysAgo(20), channelEditedAt: daysAgo(20), rating: 2 })
      // The window closed: nobody can reply any more, so it is no work.
      await review('etsy-closed', { postedAt: daysAgo(130), channelEditedAt: daysAgo(120), rating: 1 })
      // Positive: never work, also when its window closes soon.
      await review('etsy-happy', { postedAt: daysAgo(97), channelEditedAt: daysAgo(97), rating: 5 })
      // Answered already.
      await review('etsy-done', { postedAt: daysAgo(95), channelEditedAt: daysAgo(95), triageStatus: 'RESPONDED' })
      // A new one-star eBay feedback: urgent too, but its chance to reply does not run out.
      await review('ebay-new', { channel: 'EBAY', marketplace: 'IT', ingestSource: 'EBAY_API', rating: 1, postedAt: daysAgo(1), channelEditedAt: null })
    })
  }, 180_000)

  afterAll(async () => {
    await database?.close()
  })

  it('Needs you: the Etsy window about to close leads, says when, and counts once', async () => {
    const { reviewNeedsYou } = await import('./review-needs-you.service.js')
    const needs = await inside(() => reviewNeedsYou({ now: NOW }))
    expect(needs.counts.reply).toBe(3) // etsy-closing, etsy-open, ebay-new — the one rule, no second count
    expect(needs.items.map((i) => i.id)).toEqual(['etsy-closing', 'ebay-new', 'etsy-open'])
    expect(needs.items[0]).toMatchObject({ title: 'Etsy reply window closes in 4 days', tone: 'danger', dueAt: new Date(daysAgo(96).getTime() + 100 * DAY).toISOString() })
    expect(needs.items[0].detail).toContain('reply on Etsy.com by')
    expect(needs.items[2].detail).toContain('reply on Etsy.com · 80 days left')

    // "Needs a reply" only: the same order (closing first, then negative, then the rest).
    const reply = await inside(() => reviewNeedsYou({ only: 'reply', now: NOW }))
    expect(reply.items.map((i) => i.id)).toEqual(['etsy-closing', 'ebay-new', 'etsy-open'])
    expect(reply.total).toBe(3)

    // Scoped to eBay: no Etsy item; scoped to Etsy: only Etsy.
    const ebay = await inside(() => reviewNeedsYou({ only: 'reply', channel: 'EBAY', now: NOW }))
    expect(ebay.items.map((i) => i.id)).toEqual(['ebay-new'])
    const etsy = await inside(() => reviewNeedsYou({ only: 'reply', channel: 'ETSY', now: NOW }))
    expect(etsy.items.map((i) => i.id)).toEqual(['etsy-closing', 'etsy-open'])
    expect(etsy.counts.reply).toBe(2)
  })

  it('the channel table: no Etsy shop connected is "Not connected" with Connect, with only the reviews held', async () => {
    const { reviewsOverview } = await import('./review-overview.service.js')
    const overview = await inside(() => reviewsOverview({ period: 'all', now: NOW }))
    const channels = overview.sections.channels
    expect(channels.ok).toBe(true)
    const rows = channels.ok ? channels.data : []
    const etsy = rows.filter((r) => r.channel === 'ETSY')
    expect(etsy).toHaveLength(1)
    expect(etsy[0]).toMatchObject({
      market: 'IT', state: 'not_connected', reason: 'No Etsy shop is connected', reconnectHref: '/settings/channels/etsy',
      reviews: 5, sent: null, rate: null, lastNote: null,
    })

    // Scoped to eBay: no Etsy row at all.
    const ebay = await inside(() => reviewsOverview({ period: 'all', channel: 'EBAY', now: NOW }))
    expect(ebay.sections.channels.ok && ebay.sections.channels.data.some((r) => r.channel === 'ETSY')).toBe(false)
  })
})
