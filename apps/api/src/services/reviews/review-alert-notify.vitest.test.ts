/**
 * Reviews › Settings › Alerts — "New negative review" reaches the right people, once, and only for reviews that arrive.
 * Pure parts first; then real SQL (PGlite with the production schema and policies): the bell notices it writes, the
 * owners when nobody is picked, the picked members otherwise, one unread notice per review per person, the switch off,
 * and the e-mail through the shared transport (mocked: nothing leaves this machine).
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { alertRecipients, inboxReviewHref, isAlertableNegative, negativeAlertWords } from './review-alert-notify.service.js'

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

const member = (userId: string, owner: boolean) => ({ userId, name: userId, email: `${userId}@example.test`, owner })

describe('which reviews alert, who hears, in which words', () => {
  it('1–2 stars or a negative reading, arrivals only', () => {
    expect(isAlertableNegative({ rating: 2, label: 'NEUTRAL', ingestSource: 'EBAY_API' })).toEqual({ alert: true })
    expect(isAlertableNegative({ rating: 4, label: 'NEGATIVE', ingestSource: 'EBAY_API' })).toEqual({ alert: true })
    expect(isAlertableNegative({ rating: 3, label: 'NEUTRAL', ingestSource: 'EBAY_API' })).toEqual({ alert: false, why: 'not negative' })
    expect(isAlertableNegative({ rating: 1, label: 'NEGATIVE', ingestSource: 'IMPORT_CSV' })).toEqual({ alert: false, why: 'imported' })
    expect(isAlertableNegative({ rating: 1, label: 'NEGATIVE', ingestSource: 'FIXTURE' })).toEqual({ alert: false, why: 'imported' })
  })

  it('the picked members still in the business, else the owners', () => {
    const team = [member('a', true), member('b', false), member('c', false)]
    expect(alertRecipients({ recipients: ['b', 'gone'] }, team).map((m) => m.userId)).toEqual(['b'])
    expect(alertRecipients({ recipients: ['gone'] }, team).map((m) => m.userId)).toEqual(['a'])
    expect(alertRecipients({ recipients: [] }, team).map((m) => m.userId)).toEqual(['a'])
  })

  it('a title and a short quote', () => {
    const w = negativeAlertWords({ channel: 'EBAY', marketplace: 'DE', rating: 1, title: null, body: 'The zip broke   after a week.', productName: 'Rain jacket' })
    expect(w.title).toBe('New negative review: 1 star on eBay Germany · Rain jacket')
    expect(w.body).toBe('“The zip broke after a week.”')
    expect(negativeAlertWords({ channel: 'AMAZON', marketplace: 'IT', rating: null, body: 'x'.repeat(300) }).body.length).toBeLessThanOrEqual(203)
    expect(inboxReviewHref('r 1')).toBe('/marketing/reviews/inbox?review=r%201')
  })
})

describe('against real SQL', () => {
  let notify: typeof import('./review-alert-notify.service.js')
  let settings: typeof import('./review-settings.service.js')
  const owner = randomUUID()
  const staff = randomUUID()
  const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, work)
  const bell = (userId: string) => inside(() => database.client.notification.findMany({ where: { userId, type: 'review-negative' } }))
  const review = (over: Partial<Parameters<typeof notify.notifyReviewAlert>[0]> = {}) => ({
    reviewId: randomUUID(), channel: 'EBAY', marketplace: 'IT', rating: 1, label: 'NEGATIVE', ingestSource: 'EBAY_API', body: 'Arrived broken.', ...over,
  })

  beforeAll(async () => {
    database = await formulaDatabase()
    notify = await import('./review-alert-notify.service.js')
    settings = await import('./review-settings.service.js')
    const ownerRole = randomUUID()
    const viewerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem",permissions,"updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['reviews.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    for (const [id, role] of [[owner, ownerRole], [staff, viewerRole]]) {
      await database.db.query(`INSERT INTO "UserProfile" (id,email,"displayName",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, `${id}@example.test`, id === owner ? 'Owner person' : 'Staff person'])
      const m = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [m, LEGACY_WORKSPACE_ID, id])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, role])
    }
  })
  afterAll(async () => { await database?.close() })

  it('nobody picked: the owners, in Nexus, once per review', async () => {
    const r = review()
    expect(await inside(() => notify.notifyReviewAlert(r))).toEqual({ created: 1, deduped: 0, emailed: 0 })
    expect(await inside(() => notify.notifyReviewAlert(r))).toEqual({ created: 0, deduped: 1, emailed: 0 })
    const notices = await bell(owner)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ entityType: 'Review', entityId: r.reviewId, href: inboxReviewHref(r.reviewId), severity: 'warn' })
    expect(await bell(staff)).toHaveLength(0)
  })

  it('an imported or positive review alerts nobody', async () => {
    expect(await inside(() => notify.notifyReviewAlert(review({ ingestSource: 'IMPORT_CSV' })))).toMatchObject({ created: 0, skipped: 'imported' })
    expect(await inside(() => notify.notifyReviewAlert(review({ rating: 5, label: 'POSITIVE' })))).toMatchObject({ created: 0, skipped: 'not negative' })
  })

  it('the picked member, in Nexus and by e-mail; off means nobody', async () => {
    const saved = await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'negative', recipients: [staff], via: ['app', 'email'] }] }, owner))
    expect(saved.ok).toBe(true)
    const before = (await bell(owner)).length
    expect(await inside(() => notify.notifyReviewAlert(review()))).toEqual({ created: 1, deduped: 0, emailed: 1 })
    expect(await bell(staff)).toHaveLength(1)
    expect(await bell(owner)).toHaveLength(before)
    expect(mail.sent.at(-1)).toMatchObject({ to: [`${staff}@example.test`] })
    expect(mail.sent.at(-1)?.subject).toMatch(/^New negative review: 1 star on eBay Italy/)

    await inside(() => settings.saveReviewSettings({ alerts: [{ key: 'negative', on: false }] }, owner))
    expect(await inside(() => notify.notifyReviewAlert(review()))).toMatchObject({ created: 0, skipped: 'off' })
  })
})
