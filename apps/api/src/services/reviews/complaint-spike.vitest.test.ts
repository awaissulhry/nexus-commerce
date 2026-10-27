/**
 * Reviews › "Complaint spike" alert — the spike check's rule (thresholds, windows, once per product, market and theme),
 * its words, and the switch in Settings › Alerts. Pure rules first; then the hourly check against real SQL (PGlite with
 * the production schema and policies): it opens the alert in Insights › Alerts whether the switch is on or off; on, the
 * people picked hear once per alert, in Nexus and/or by e-mail (the shared transport, mocked: nothing leaves this
 * machine), never again for the same open or acknowledged alert, and not for a week after a resolve.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import {
  COMPLAINT_SPIKE_RULE, complaintSpikeHeld, complaintSpikeNoticeWords, complaintSpikeRule, complaintSpikeVerdict,
} from './complaint-spike-math.js'
import { complaintSpikeAlertsHref } from './review-alert-notify.service.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string[]; subject: string; text: string }> }))
vi.mock('../email/transport.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendEmail: vi.fn(async (msg: { to: string | string[]; subject: string; text: string }) => {
    mail.sent.push({ to: Array.isArray(msg.to) ? msg.to : [msg.to], subject: msg.subject, text: msg.text })
    return { ok: true, provider: 'mock', dryRun: true }
  }),
}))

const DAY = 86_400_000
const stats = (n7: number, d7: number, n28: number, d28: number) => ({ rate7dNumerator: n7, rate7dDenominator: d7, rate28dNumerator: n28, rate28dDenominator: d28 })

describe('the spike check’s rule', () => {
  it('the numbers this deployment runs, and a tuned deployment’s; a value that does not read keeps the default', () => {
    expect(COMPLAINT_SPIKE_RULE).toEqual({ recentDays: 7, baselineDays: 28, minNegative: 3, minReviews: 5, multiplier: 2, reopenAfterDays: 7 })
    expect(complaintSpikeRule({ NEXUS_REVIEW_SPIKE_MIN_7D: '4', NEXUS_REVIEW_SPIKE_MIN_BASELINE: '10', NEXUS_REVIEW_SPIKE_MULTIPLIER: '2.5' }))
      .toMatchObject({ minNegative: 4, minReviews: 10, multiplier: 2.5 })
    expect(complaintSpikeRule({ NEXUS_REVIEW_SPIKE_MIN_7D: 'many', NEXUS_REVIEW_SPIKE_MULTIPLIER: '' })).toMatchObject({ minNegative: 3, multiplier: 2 })
  })

  it('needs enough negatives in 7 days and enough reviews in 28, and the share at least doubled', () => {
    expect(complaintSpikeVerdict(stats(2, 3, 2, 30))).toEqual({ spike: false, multiplier: null })
    expect(complaintSpikeVerdict(stats(3, 3, 3, 4))).toEqual({ spike: false, multiplier: null })
    expect(complaintSpikeVerdict(stats(4, 6, 6, 26))).toMatchObject({ spike: true })
    expect(complaintSpikeVerdict(stats(4, 6, 6, 26)).multiplier).toBeCloseTo(2.89, 2)
    expect(complaintSpikeVerdict(stats(3, 10, 6, 40))).toEqual({ spike: true, multiplier: 2 })
    expect(complaintSpikeVerdict(stats(3, 10, 8, 40))).toMatchObject({ spike: false })
    expect(complaintSpikeVerdict(stats(3, 3, 0, 20))).toEqual({ spike: true, multiplier: 99 })
  })

  it('once per product, market and theme: open or acknowledged holds it; a resolve holds it for 7 days', () => {
    const now = new Date('2026-10-27T10:00:00Z')
    expect(complaintSpikeHeld([], now)).toBeNull()
    expect(complaintSpikeHeld([{ status: 'OPEN', resolvedAt: null }], now)).toBe('open')
    expect(complaintSpikeHeld([{ status: 'ACKNOWLEDGED', resolvedAt: null }], now)).toBe('open')
    expect(complaintSpikeHeld([{ status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 3 * DAY) }], now)).toBe('resolved recently')
    expect(complaintSpikeHeld([{ status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 8 * DAY) }], now)).toBeNull()
  })

  it('the notice: the theme, where, the product; the shares in each window and the buyers’ own words', () => {
    const w = complaintSpikeNoticeWords({ ...stats(4, 6, 6, 26), theme: 'FIT_SIZING', market: 'IT', channels: ['AMAZON'], productName: 'Test jacket', phrases: ['runs  small', 'too tight'] })
    expect(w.title).toBe('Complaint spike: Fit & sizing on Amazon Italy · Test jacket')
    expect(w.body).toBe('4 of 6 reviews about Fit & sizing in the last 7 days are negative (67%), against 23% over the last 28 days. Buyers wrote: “runs small”, “too tight”.')
    const two = complaintSpikeNoticeWords({ ...stats(3, 3, 3, 20), theme: 'QUALITY', market: 'DE', channels: ['AMAZON', 'EBAY'], productName: null, phrases: [] })
    expect(two).toEqual({ title: 'Complaint spike: Quality on Germany', body: '3 of 3 reviews about Quality in the last 7 days are negative (100%), against 15% over the last 28 days.' })
    expect(complaintSpikeAlertsHref({ market: 'IT', theme: 'FIT_SIZING', productId: 'p 1' })).toBe('/marketing/reviews/insights/alerts?market=IT&theme=FIT_SIZING&product=p+1')
  })
})

describe('the hourly check (real SQL)', () => {
  let check: typeof import('./spike-detector.service.js')
  let settings: typeof import('./review-settings.service.js')
  let alerts: typeof import('./review-alerts.service.js')
  const owner = randomUUID()
  const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)
  const spikes = () => inside(() => database.client.reviewSpike.findMany({ where: { productId: 'sp-1' }, orderBy: { detectedAt: 'asc' } }))
  const bell = () => inside(() => database.client.notification.findMany({ where: { userId: owner, type: 'review-complaint-spike' } }))
  const midnight = (days: number) => {
    const d = new Date(Date.now() - days * DAY)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  }
  const resolvedAgo = (id: string, days: number) => inside(() => database.client.reviewSpike.update({ where: { id }, data: { status: 'RESOLVED', resolvedAt: new Date(Date.now() - days * DAY) } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    check = await import('./spike-detector.service.js')
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
      await c.product.create({ data: { id: 'sp-1', sku: 'TEST-SP1', name: 'Test jacket', basePrice: 10 } as never })
      await c.product.create({ data: { id: 'sp-2', sku: 'TEST-SP2', name: 'Test gloves', basePrice: 10 } as never })
      // Test jacket, Italy, Fit & sizing: 2 of 20 negative in the weeks before, 4 of 6 in the last days — a spike.
      for (const [days, total, negative] of [[20, 10, 1], [12, 10, 1], [2, 3, 2], [1, 3, 2]] as const) {
        await c.reviewCategoryRate.create({ data: { productId: 'sp-1', marketplace: 'IT', category: 'FIT_SIZING', date: midnight(days), total, negative, positive: total - negative } })
      }
      // Test gloves, Germany, Quality: only 2 negatives in 7 days — no spike.
      await c.reviewCategoryRate.create({ data: { productId: 'sp-2', marketplace: 'DE', category: 'QUALITY', date: midnight(1), total: 2, negative: 2 } })
      await c.reviewCategoryRate.create({ data: { productId: 'sp-2', marketplace: 'DE', category: 'QUALITY', date: midnight(20), total: 10, negative: 0, positive: 10 } })
      // The negative reviews behind the jacket's spike: where they came from and the buyers' words.
      for (let i = 0; i < 2; i++) {
        await c.review.create({
          data: {
            channel: 'AMAZON', marketplace: 'IT', externalReviewId: `cs-${i}`, productId: 'sp-1', rating: 2, body: 'Test review', postedAt: new Date(Date.now() - (1 + i) * DAY),
            ingestSource: 'IMPORT_CSV', sentiment: { create: { label: 'NEGATIVE', score: -0.6, categories: ['FIT_SIZING'], topPhrases: [i === 0 ? 'runs small' : 'too tight'], model: 'test' } },
          } as never,
        })
      }
    })
  }, 120_000)
  afterAll(async () => { await database?.close() })

  it('off in Settings (the default): the alert still opens in Insights › Alerts, nobody is told', async () => {
    const run = await inside(() => check.runSpikeDetectorOnce())
    expect(run).toMatchObject({ cohortsScanned: 2, spikesDetected: 1, notified: 0, errors: [] })
    const [a] = await spikes()
    expect(a).toMatchObject({ marketplace: 'IT', category: 'FIT_SIZING', status: 'OPEN', rate7dNumerator: 4, rate7dDenominator: 6, rate28dNumerator: 6, rate28dDenominator: 26, sampleTopPhrases: ['runs small', 'too tight'] })
    expect(await bell()).toHaveLength(0)
    expect(mail.sent).toHaveLength(0)
  })

  it('on: a new alert tells the owners once in Nexus; the same open or acknowledged alert never again', async () => {
    const saved = await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'complaintSpike', on: true }] }, owner))
    expect(saved.ok).toBe(true)
    // Switched on while an alert is open: nothing new opens, nobody is told about the old one.
    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 0, spikesSkippedDuplicate: 1, notified: 0 })
    const [first] = await spikes()
    await resolvedAgo(first.id, 8)

    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 1, notified: 1, errors: [] })
    const second = (await spikes()).at(-1)!
    const notices = await bell()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      entityType: 'ReviewSpike', entityId: second.id, severity: 'warn',
      href: '/marketing/reviews/insights/alerts?market=IT&theme=FIT_SIZING&product=sp-1',
      title: 'Complaint spike: Fit & sizing on Amazon Italy · Test jacket',
      body: '4 of 6 reviews about Fit & sizing in the last 7 days are negative (67%), against 23% over the last 28 days. Buyers wrote: “runs small”, “too tight”.',
    })
    expect(mail.sent).toHaveLength(0)

    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 0, spikesSkippedDuplicate: 1, notified: 0 })
    await inside(() => alerts.decideAlert(second.id, 'ACKNOWLEDGED', owner))
    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 0, spikesSkippedDuplicate: 1, notified: 0 })
    await inside(() => alerts.decideAlert(second.id, 'RESOLVED', owner))
    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 0, spikesSkippedResolved: 1, notified: 0 })
    expect(await spikes()).toHaveLength(2)
    expect(await bell()).toHaveLength(1)
  })

  it('by e-mail when Settings says so, to the people picked, with the link to Insights › Alerts', async () => {
    await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'complaintSpike', via: ['email'], recipients: [owner] }] }, owner))
    await resolvedAgo((await spikes()).at(-1)!.id, 8)
    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 1, notified: 1 })
    expect(mail.sent).toHaveLength(1)
    expect(mail.sent[0]).toMatchObject({ to: [`${owner}@example.test`], subject: 'Complaint spike: Fit & sizing on Amazon Italy · Test jacket' })
    expect(await bell()).toHaveLength(1)

    await resolvedAgo((await spikes()).at(-1)!.id, 8)
    await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'complaintSpike', on: false }] }, owner))
    expect(await inside(() => check.runSpikeDetectorOnce())).toMatchObject({ spikesDetected: 1, notified: 0 })
    expect(mail.sent).toHaveLength(1)
  })
})
