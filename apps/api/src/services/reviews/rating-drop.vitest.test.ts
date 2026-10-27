/**
 * Reviews › "Rating drop" alert — the window maths, the minimum sample, the threshold, once per family and market until
 * resolved, seller feedback (and Amazon stars not from imported reviews) never counting, and the switch in Settings.
 * Pure rules first; then the hourly check against real SQL (PGlite with the production schema and policies): the alert it
 * opens in Insights › Alerts, the bell notice, Overview › Needs you, and "Suggest fixes" held with why.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  countsForRatingDrop, isRatingDrop, RATING_DROP_CATEGORY, RATING_DROP_NO_SUGGEST, RATING_DROP_RULE, ratingDropBasis,
  ratingDropHeld, ratingDropNoticeWords, ratingDropStats, ratingDropTitle, ratingDropWindows, storedDropRating, windowOf,
  type RatingDropRow,
} from './rating-drop-math.js'
import { alertItem } from './review-needs-you.service.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string[]; subject: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendEmail: vi.fn(async (msg: { to: string | string[]; subject: string }) => {
    mail.sent.push({ to: Array.isArray(msg.to) ? msg.to : [msg.to], subject: msg.subject })
    return { ok: true, provider: 'mock', dryRun: true }
  }),
}))

const NOW = new Date('2026-10-27T10:00:00Z')
const DAY = 86_400_000
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY)

const row = (over: Partial<RatingDropRow> = {}): RatingDropRow => ({
  productId: 'p-s', channel: 'SHOPIFY', marketplace: 'IT', rating: 5, kind: null, ingestSource: 'SHOPIFY_APP', postedAt: ago(2), ...over,
})
const rows = (ratings: number[], over: Partial<RatingDropRow>) => ratings.map((rating) => row({ rating, ...over }))
const family = (id: string) => (id === 'gone' ? null : id.startsWith('p-') ? 'fam' : id)

describe('the windows', () => {
  it('the last 7 days, and the 28 days before them, never overlapping', () => {
    const w = ratingDropWindows(NOW)
    expect(w.recentFrom.toISOString()).toBe('2026-10-20T10:00:00.000Z')
    expect(w.beforeFrom.toISOString()).toBe('2026-09-22T10:00:00.000Z')
    expect(windowOf(ago(0), w)).toBe('recent')
    expect(windowOf(w.recentFrom, w)).toBe('recent')
    expect(windowOf(new Date(w.recentFrom.getTime() - 1), w)).toBe('before')
    expect(windowOf(w.beforeFrom, w)).toBe('before')
    expect(windowOf(new Date(w.beforeFrom.getTime() - 1), w)).toBeNull()
    expect(windowOf(new Date(NOW.getTime() + 1), w)).toBeNull()
  })

  it('averages each window per family and market (a variant counts for its family)', () => {
    const stats = ratingDropStats([
      ...rows([5, 5, 4, 4, 4], { postedAt: ago(20), productId: 'p-s' }),
      ...rows([4, 4, 4, 4, 5], { postedAt: ago(3), productId: 'p-m' }),
      ...rows([1, 1, 1, 1, 1], { postedAt: ago(3), marketplace: 'DE' }),
      ...rows([1], { postedAt: ago(40) }),
      ...rows([1], { postedAt: ago(3), productId: 'gone' }),
    ], family, NOW)
    const italy = stats.find((s) => s.market === 'IT')!
    expect(italy).toMatchObject({ familyId: 'fam', recentCount: 5, recentSum: 21, beforeCount: 5, beforeSum: 22, channels: ['SHOPIFY'] })
    expect(italy.recentAvg).toBeCloseTo(4.2)
    expect(italy.beforeAvg).toBeCloseTo(4.4)
    expect(italy.change).toBe(-0.2)
    expect(stats.find((s) => s.market === 'DE')).toMatchObject({ recentCount: 5, beforeCount: 0, change: null })
  })
})

describe('when it opens', () => {
  it('needs the minimum sample in EACH window', () => {
    const rule = RATING_DROP_RULE
    expect(isRatingDrop({ recentCount: rule.minRated - 1, beforeCount: 30, change: -2 })).toEqual({ drop: false, why: 'fewer than 5 rated reviews in the last 7 days' })
    expect(isRatingDrop({ recentCount: 30, beforeCount: rule.minRated - 1, change: -2 })).toEqual({ drop: false, why: 'fewer than 5 rated reviews in the 28 days before' })
    expect(isRatingDrop({ recentCount: rule.minRated, beforeCount: rule.minRated, change: -2 })).toEqual({ drop: true })
  })

  it('needs a fall of at least 0.3 stars', () => {
    expect(isRatingDrop({ recentCount: 5, beforeCount: 5, change: -0.29 })).toMatchObject({ drop: false })
    expect(isRatingDrop({ recentCount: 5, beforeCount: 5, change: -0.3 })).toEqual({ drop: true })
    expect(isRatingDrop({ recentCount: 5, beforeCount: 5, change: 0.5 })).toMatchObject({ drop: false })
    expect(isRatingDrop({ recentCount: 5, beforeCount: 5, change: null })).toMatchObject({ drop: false })
    // 4.4 → 4.1 is a fall of exactly 0.3 (floating point does not hide it).
    const [s] = ratingDropStats([...rows([5, 5, 4, 4, 4], { postedAt: ago(20) }), ...rows([5, 4, 4, 4, 4, 4, 4, 4, 4, 4], { postedAt: ago(1) })], family, NOW)
    expect(s.change).toBe(-0.3)
    expect(isRatingDrop(s)).toEqual({ drop: true })
  })

  it('once per family and market until resolved; a resolved one waits 7 days', () => {
    expect(ratingDropHeld([], NOW)).toBeNull()
    expect(ratingDropHeld([{ status: 'OPEN', resolvedAt: null }], NOW)).toBe('open')
    expect(ratingDropHeld([{ status: 'ACKNOWLEDGED', resolvedAt: null }], NOW)).toBe('open')
    expect(ratingDropHeld([{ status: 'RESOLVED', resolvedAt: ago(2) }], NOW)).toBe('resolved recently')
    expect(ratingDropHeld([{ status: 'RESOLVED', resolvedAt: ago(8) }], NOW)).toBeNull()
  })
})

describe('what counts', () => {
  it('product reviews with stars only: never seller feedback, never eBay, Amazon only from imported reviews', () => {
    expect(countsForRatingDrop(row())).toEqual({ counts: true })
    expect(countsForRatingDrop(row({ channel: 'AMAZON', ingestSource: 'IMPORT_CSV' }))).toEqual({ counts: true })
    expect(countsForRatingDrop(row({ channel: 'ETSY', ingestSource: 'ETSY_API' }))).toEqual({ counts: true })
    expect(countsForRatingDrop(row({ channel: 'EBAY', ingestSource: 'EBAY_API' }))).toEqual({ counts: false, why: 'seller feedback' })
    expect(countsForRatingDrop(row({ channel: 'EBAY', kind: 'PRODUCT' }))).toEqual({ counts: false, why: 'no stars on this channel' })
    expect(countsForRatingDrop(row({ channel: 'AMAZON', kind: 'SELLER', ingestSource: 'AMAZON_SELLER_FEEDBACK' }))).toEqual({ counts: false, why: 'seller feedback' })
    expect(countsForRatingDrop(row({ channel: 'SHOPIFY', kind: 'SELLER' }))).toEqual({ counts: false, why: 'seller feedback' })
    expect(countsForRatingDrop(row({ channel: 'AMAZON', ingestSource: 'AMAZON_VOC' }))).toEqual({ counts: false, why: 'Amazon stars only from imported reviews' })
    expect(countsForRatingDrop(row({ ingestSource: 'FIXTURE' }))).toMatchObject({ counts: false })
    expect(countsForRatingDrop(row({ marketplace: null }))).toEqual({ counts: false, why: 'no market' })
    expect(countsForRatingDrop(row({ rating: null }))).toEqual({ counts: false, why: 'no stars' })
  })

  it('seller feedback in the same market does not move the average', () => {
    const [s] = ratingDropStats([
      ...rows([5, 5, 5, 5, 5], { postedAt: ago(20) }),
      ...rows([5, 5, 5, 5, 5], { postedAt: ago(2) }),
      ...rows([1, 1, 1, 1, 1], { postedAt: ago(2), channel: 'AMAZON', kind: 'SELLER', ingestSource: 'AMAZON_SELLER_FEEDBACK' }),
      ...rows([1, 1, 1, 1, 1], { postedAt: ago(2), channel: 'EBAY', ingestSource: 'EBAY_API' }),
    ], family, NOW)
    expect(s).toMatchObject({ recentCount: 5, change: 0, channels: ['SHOPIFY'] })
    expect(isRatingDrop(s)).toMatchObject({ drop: false })
  })
})

describe('words', () => {
  const stored = { rate7dNumerator: 15, rate7dDenominator: 5, rate28dNumerator: 27, rate28dDenominator: 6 }
  it('the title, the basis and the notice', () => {
    expect(storedDropRating(stored)).toEqual({ before: 4.5, now: 3, change: -1.5 })
    expect(ratingDropTitle(stored)).toBe('Rating fell 1.5 stars')
    expect(ratingDropBasis(stored)).toBe('5 rated reviews in 7 days · 6 in the 28 days before')
    expect(ratingDropNoticeWords({ ...stored, productName: 'Rain jacket', market: 'IT', channels: ['SHOPIFY'] })).toEqual({
      title: 'Rating fell 1.5 stars on Shopify Italy · Rain jacket',
      body: '3.0 stars in the last 7 days, was 4.5 (5 rated reviews in 7 days · 6 in the 28 days before).',
    })
    expect(ratingDropNoticeWords({ ...stored, productName: null, market: 'IT', channels: ['SHOPIFY', 'AMAZON'] }).title).toBe('Rating fell 1.5 stars on Italy')
  })

  it('Overview › Needs you shows it like other alerts', () => {
    const item = alertItem({ id: 's-1', marketplace: 'IT', category: RATING_DROP_CATEGORY, ...stored, spikeMultiplier: -1.5, detectedAt: NOW, product: { name: 'Rain jacket', sku: 'RJ' } })
    expect(item).toMatchObject({ kind: 'alert', title: 'Rating fell 1.5 stars', detail: 'Rain jacket · Italy · 3.0 stars in the last 7 days, was 4.5', action: { page: 'alerts', params: { market: 'IT' } } })
  })
})

describe('the hourly check (real SQL)', () => {
  let check: typeof import('./rating-drop.service.js')
  let settings: typeof import('./review-settings.service.js')
  let alerts: typeof import('./review-alerts.service.js')
  const owner = randomUUID()
  const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)
  const dropAlerts = () => inside(() => database.client.reviewSpike.findMany({ where: { category: RATING_DROP_CATEGORY }, orderBy: { detectedAt: 'asc' } }))
  let n = 0
  const review = (productId: string, rating: number, postedAt: Date, over: Record<string, unknown> = {}) => database.client.review.create({
    data: { channel: 'SHOPIFY', marketplace: 'IT', externalReviewId: `rd-${++n}`, productId, rating, body: 'Test review', postedAt, ingestSource: 'SHOPIFY_APP', ...over } as never,
  })

  beforeAll(async () => {
    database = await formulaDatabase()
    check = await import('./rating-drop.service.js')
    settings = await import('./review-settings.service.js')
    alerts = await import('./review-alerts.service.js')
    const ownerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,'Owner person','active',CURRENT_TIMESTAMP)`, [owner, `${owner}@example.test`])
    const m = randomUUID()
    await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [m, LEGACY_WORKSPACE_ID, owner])
    await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, ownerRole])
    await inside(async () => {
      const c = database.client
      // A family whose stars fell in Italy: 5 stars before, 3 stars in the last week (on two of its sizes).
      await c.product.create({ data: { id: 'fam-1', sku: 'TEST-FAM1', name: 'Test jacket', basePrice: 10, isParent: true } as never })
      for (const id of ['fam-1-s', 'fam-1-m']) await c.product.create({ data: { id, sku: `TEST-${id}`, name: `Test jacket ${id}`, basePrice: 10, parentId: 'fam-1' } as never })
      for (let i = 0; i < 6; i++) await review(i % 2 ? 'fam-1-s' : 'fam-1-m', 5, ago(10 + i, new Date()))
      for (let i = 0; i < 5; i++) await review(i % 2 ? 'fam-1-s' : 'fam-1-m', 3, ago(1 + i * 0.5, new Date()), { sentiment: { create: { label: 'NEGATIVE', score: -0.4, categories: ['FIT_SIZING'], topPhrases: ['runs small'], model: 'test' } } })
      // A family whose only low stars are seller feedback: no drop.
      await c.product.create({ data: { id: 'fam-2', sku: 'TEST-FAM2', name: 'Test gloves', basePrice: 10 } as never })
      for (let i = 0; i < 5; i++) await review('fam-2', 5, ago(12 + i, new Date()))
      for (let i = 0; i < 5; i++) await review('fam-2', 5, ago(2, new Date()))
      for (let i = 0; i < 5; i++) await review('fam-2', 1, ago(2, new Date()), { channel: 'AMAZON', kind: 'SELLER', ingestSource: 'AMAZON_SELLER_FEEDBACK' })
      for (let i = 0; i < 5; i++) await review('fam-2', 1, ago(2, new Date()), { channel: 'EBAY', ingestSource: 'EBAY_API' })
    })
  }, 120_000)
  afterAll(async () => { await database?.close() })

  it('off in Settings (the default): nothing opens', async () => {
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ off: true, opened: 0 })
    expect(await dropAlerts()).toHaveLength(0)
  })

  it('on: one alert for the family in its market, the owners told in Nexus; seller feedback opens nothing', async () => {
    const saved = await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'ratingDrop', on: true }] }, owner))
    expect(saved.ok).toBe(true)
    const run = await inside(() => check.runRatingDropCheckOnce())
    expect(run).toMatchObject({ off: false, opened: 1, dropped: 1, errors: [] })
    const [a] = await dropAlerts()
    expect(a).toMatchObject({ productId: 'fam-1', marketplace: 'IT', status: 'OPEN', rate7dNumerator: 15, rate7dDenominator: 5, rate28dNumerator: 30, rate28dDenominator: 6, sampleTopPhrases: ['runs small'] })
    expect(Number(a.spikeMultiplier)).toBe(-2)
    const bell = await inside(() => database.client.notification.findMany({ where: { userId: owner, type: 'review-rating-drop' } }))
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ entityType: 'ReviewSpike', entityId: a.id, href: '/marketing/reviews/insights/alerts?market=IT', title: 'Rating fell 2.0 stars on Shopify Italy · Test jacket' })
    expect(mail.sent).toHaveLength(0)
  })

  it('once until resolved: open or acknowledged stops a second; a fresh resolve waits 7 days', async () => {
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ opened: 0, skippedOpen: 1 })
    const [a] = await dropAlerts()
    await inside(() => alerts.decideAlert(a.id, 'ACKNOWLEDGED', owner))
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ opened: 0, skippedOpen: 1 })
    await inside(() => alerts.decideAlert(a.id, 'RESOLVED', owner))
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ opened: 0, skippedResolved: 1 })
    expect(await dropAlerts()).toHaveLength(1)
    await inside(() => alerts.decideAlert(a.id, 'REOPEN', owner))
  })

  it('Insights › Alerts lists it with its stars; Suggest fixes holds with why; e-mail only when Settings says so', async () => {
    const list = await inside(() => alerts.listAlerts({ status: 'OPEN' }))
    const item = list.items.find((i) => i.kind === 'rating_drop')!
    expect(item).toMatchObject({ theme: { key: RATING_DROP_CATEGORY, label: 'Rating drop' }, channels: ['SHOPIFY'], where: 'Shopify Italy', rating: { before: 5, now: 3, change: -2 }, count: 5, basis: '5 rated reviews in 7 days · 6 in the 28 days before' })
    const generate = vi.fn(async () => ({ created: [] }))
    expect(await inside(() => alerts.bulkAlerts({ ids: [item.id], action: 'suggest' }, owner, generate))).toEqual({ changed: 0, held: [{ id: item.id, words: RATING_DROP_NO_SUGGEST }] })
    expect(generate).not.toHaveBeenCalled()

    await inside(() => alerts.decideAlert(item.id, 'RESOLVED', owner))
    await inside(() => database.client.reviewSpike.update({ where: { id: item.id }, data: { resolvedAt: ago(8, new Date()) } }))
    await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'ratingDrop', via: ['email'] }] }, owner))
    const before = mail.sent.length
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ opened: 1 })
    // By e-mail only now: the shared transport (mocked) gets one message to the owner; the bell gets nothing new.
    expect(mail.sent.length).toBe(before + 1)
    expect(mail.sent.at(-1)).toMatchObject({ to: [`${owner}@example.test`], subject: 'Rating fell 2.0 stars on Shopify Italy · Test jacket' })
    expect(await inside(() => database.client.notification.count({ where: { userId: owner, type: 'review-rating-drop' } }))).toBe(1)

    await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'ratingDrop', on: false }] }, owner))
    expect(await inside(() => check.runRatingDropCheckOnce())).toMatchObject({ off: true })
  })
})
