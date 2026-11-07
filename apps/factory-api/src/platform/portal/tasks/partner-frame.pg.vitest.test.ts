import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor } from '../../../core/command'
import type { Log } from '../../../core/queue'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../auth/portal/testing/portal'
import { addRole, addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { runPartnerDigests } from '../notifications/digest'
import { partnerFanOut, partnerFanOutEvents } from '../notifications/fan-out'
import { unsubscribeKeyOf } from '../notifications/mail'
import { remindPartnerTasks } from './reminders'

/**
 * Tasks and notifications for partners on the local stack (B-W2b-167; COL-043, PLT-148, COL-063), through the real app: the
 * office asks a customer for a document; the one task list shows it to the people whose role acts on it (never another
 * party's, never before the first visit); the fan-out tells them, by e-mail as their settings say (transactional topics locked
 * on, the unsubscribe link in every mail); done in the portal with Undo; the office cancels, reopens, moves the date; the
 * reminder job and the daily summary; Home's counts and badges; the hand-over of a colleague's requests. Mail goes to the FAKE
 * mailbox only.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let other: string
let sales: Browser
let readOnly: Browser
const SLUG = 'portal-frame-a'
const lines: string[] = []
const log: Log = { info: (_fields, message) => void lines.push(message), warn: (_fields, message) => void lines.push(message), error: (_fields, message) => void lines.push(message) }

const people = { buyer: 'bea.buyer@brand-alpha.example', viewer: 'vic.viewer@brand-alpha.example', admin: 'ada.admin@brand-alpha.example', otherBuyer: 'oscar@brand-beta.example' }
const ids: Record<keyof typeof people, string> = { buyer: '', viewer: '', admin: '', otherBuyer: '' }

/** A partner person of a party with template roles over every company of the tenant (as an accepted invitation gives). */
async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await inWorld(h, world, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string, acknowledge = true): Promise<Browser> {
  const browser = await portalBrowser(h)
  // One new code a minute per address: the clock moves on first.
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  if (acknowledge) {
    const terms = await browser.get('/portal/terms?locale=en')
    expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  }
  return browser
}

const outbox = async (type: string) => (await h.db.admin.query('SELECT id, type, payload, "companyId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [tenant.id, type])).rows as { id: string; type: string; payload: Record<string, unknown>; companyId: string | null }[]
const system = () => callerFor(h.database, systemContext(tenant.id, `test-${newId()}`))

/** What the worker would do: every partner-relevant event made so far through the fan-out (a replay makes nothing). */
async function fanOutAll(): Promise<number> {
  let made = 0
  for (const type of partnerFanOutEvents()) {
    for (const row of await outbox(type)) made += await partnerFanOut(system(), { eventId: row.id, type: row.type, tenantId: tenant.id, companyId: row.companyId, siteId: null, payload: row.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
  }
  return made
}

const mailsTo = (email: string, template: string) => h.ses.mails.filter((mail) => mail.templateKey === template && mail.to[0] === email)
const notificationsOf = async (userId: string) => (await h.db.admin.query('SELECT id, "partyId", category, "messageKey", "readAt" FROM "Notification" WHERE "userId" = $1 ORDER BY "createdAt", id', [userId])).rows
const deliveriesOf = async (notificationId: string) => (await h.db.admin.query('SELECT channel, outcome, "emailOutboundId", detail FROM "NotificationDelivery" WHERE "notificationId" = $1', [notificationId])).rows

beforeAll(async () => {
  h = await startHarness('portal_frame')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG, 2)
  world = await portalWorld(h, tenant)
  other = newId()
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id: other, code: `P${other.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Beta S.r.l.', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: other, partyId: other, portalOn: true }, select: { id: true } })
  })
  ids.buyer = await partnerPerson(people.buyer, world.partyId, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  ids.viewer = await partnerPerson(people.viewer, world.partyId, ['customer-viewer'])
  ids.admin = await partnerPerson(people.admin, world.partyId, ['customer-admin', 'partner-comment', 'partner-upload', 'partner-approve'])
  ids.otherBuyer = await partnerPerson(people.otherBuyer, other, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  const seller = await addUser(h, tenant, { email: 'sam.sales@portal-frame-a.example', role: 'sales' })
  sales = new Browser(h.app)
  await sales.signIn(SLUG, seller.email, seller.password)
  // Sales and read-only see margins or costs: their roles need two-factor proved on the session.
  await enrolTotp(h, sales)
  const reader = await addUser(h, tenant, { email: 'rita.readonly@portal-frame-a.example' })
  await addRole(h, tenant, reader.id, 'read_only')
  readOnly = new Browser(h.app)
  await readOnly.signIn(SLUG, reader.email, reader.password)
  await enrolTotp(h, readOnly)
}, 180_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

const ask = (body: Record<string, unknown>, partyId = world.partyId, browser = sales) => browser.post(`/partners/${partyId}/tasks`, { kind: 'UPLOAD_DOCUMENT', recordType: 'Party', recordId: partyId, companyId: world.companyId, dueAt: new Date(h.clock.now().getTime() + 3 * 86_400_000).toISOString(), ...body })

describe('the one task list (COL-043)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let buyer: Browser
  let taskId: string

  it('the office asks a customer for a document; refused for another kind, another party, without the permission', async () => {
    const asked = await ask({})
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect(asked.body).toMatchObject({ made: true, task: { kind: 'UPLOAD_DOCUMENT', status: 'OPEN', askedBy: 'sam sales', record: { type: 'Party', id: world.partyId }, area: 'documents', due: 'SOON', version: 1 } })
    taskId = asked.body.task.id
    expect((await outbox('partner_task.opened')).map((row) => row.payload)).toEqual([expect.objectContaining({ taskId, partyId: world.partyId, kind: 'UPLOAD_DOCUMENT', byOffice: true })])
    expect((await ask({ kind: 'CONFIRM_PO' })).status).toBe(400)
    expect((await ask({ recordId: other })).status).toBe(400)
    expect((await ask({ dueAt: new Date(h.clock.now().getTime() - 60_000).toISOString() })).status).toBe(400)
    expect((await ask({}, world.partyId, readOnly)).status).toBe(403)
    const list = await sales.get(`/partners/${world.partyId}/tasks`)
    expect(list.status).toBe(200)
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([taskId])
    expect((await readOnly.get(`/partners/${world.partyId}/tasks`)).status).toBe(200)
  })

  it('shows the request to the people whose role acts on it, never before the first visit, never to another party', async () => {
    const early = await signedIn(people.buyer, false)
    expect((await early.get('/portal/tasks')).status).toBe(403)
    buyer = await signedIn(people.buyer)
    const mine = await buyer.get('/portal/tasks')
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    expect(mine.body.items).toHaveLength(1)
    expect(mine.body.items[0]).toMatchObject({ id: taskId, verb: { en: 'Upload', it: 'Carica' }, canMarkDone: true, canUndo: false, askedBy: 'sam sales' })
    expect(mine.body.items[0].link).toMatch(new RegExp(`^/p/P[0-9a-f]{6}/open/Party/${world.partyId}#task%3A${taskId}$`))
    expect(mine.body.badges).toEqual([expect.objectContaining({ area: 'documents', count: 1, words: { it: '1 richiesti', en: '1 requested' } })])
    expect(mine.body.counts).toEqual({ open: 1, overdue: 0, dueSoon: 1 })
    const viewer = await signedIn(people.viewer)
    expect((await viewer.get('/portal/tasks')).body.items).toEqual([])
    const stranger = await signedIn(people.otherBuyer)
    expect((await stranger.get('/portal/tasks')).body.items).toEqual([])
    expect((await stranger.post(`/portal/tasks/${taskId}/done`, { version: 1 })).status).toBe(404)
    expect((await viewer.post(`/portal/tasks/${taskId}/done`, { version: 1 })).status).toBe(404)
    // An office session never opens a portal route, nor a portal session an office one.
    expect((await sales.get('/portal/tasks')).status).toBe(401)
    expect((await buyer.get(`/partners/${world.partyId}/tasks`)).status).toBe(401)
  })

  it('marks it done in the portal with Undo by the same person within 10 minutes', async () => {
    const done = await buyer.post(`/portal/tasks/${taskId}/done`, { version: 1 })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.task).toMatchObject({ status: 'DONE', canUndo: true, canMarkDone: false })
    const row = (await h.db.admin.query('SELECT status, "doneById", version FROM "PartnerTask" WHERE id = $1', [taskId])).rows[0]
    expect(row).toEqual({ status: 'DONE', doneById: ids.buyer, version: 2 })
    expect((await buyer.get('/portal/tasks')).body.items).toEqual([])
    expect((await buyer.get('/portal/tasks?state=DONE')).body.items.map((item: { id: string }) => item.id)).toEqual([taskId])
    const admin = await signedIn(people.admin)
    expect((await admin.post(`/portal/tasks/${taskId}/undo`)).status).toBe(409)
    expect((await buyer.post(`/portal/tasks/${taskId}/undo`)).status).toBe(200)
    expect((await h.db.admin.query('SELECT status, "doneById", "closedAt" FROM "PartnerTask" WHERE id = $1', [taskId])).rows[0]).toEqual({ status: 'OPEN', doneById: null, closedAt: null })
    expect((await outbox('partner_task.reopened')).map((row) => row.payload)).toEqual([expect.objectContaining({ taskId, byPartner: true })])
    // Late: 11 minutes after a new done, Undo is refused.
    await buyer.post(`/portal/tasks/${taskId}/done`, { version: 3 })
    h.clock.advance(11 * 60_000)
    expect((await buyer.post(`/portal/tasks/${taskId}/undo`)).status).toBe(409)
  })

  it('the office reopens, moves the date and cancels; a stale version is refused; a cancelled request is not for the portal', async () => {
    expect((await sales.post(`/partner-tasks/${taskId}/reopen`, { version: 3 })).status).toBe(409)
    const reopened = await sales.post(`/partner-tasks/${taskId}/reopen`, { version: 4 })
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)
    const moved = await sales.send('PATCH' as never, `/partner-tasks/${taskId}`, { version: 5, dueAt: new Date(h.clock.now().getTime() + 10 * 86_400_000).toISOString() })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.task).toMatchObject({ status: 'OPEN', due: 'LATER', version: 6 })
    const cancelled = await sales.post(`/partner-tasks/${taskId}/cancel`, { version: 6 })
    expect(cancelled.body.task).toMatchObject({ status: 'CANCELLED' })
    expect((await buyer.post(`/portal/tasks/${taskId}/done`, { version: 7 })).status).toBe(409)
    expect((await readOnly.post(`/partner-tasks/${taskId}/reopen`, { version: 7 })).status).toBe(403)
  })
})

describe('notifications, e-mail settings and summaries (PLT-148, COL-063)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let buyer: Browser
  let taskId: string

  it('locks order, delivery and invoice mail on; one switch turns the rest off; a preview has no settings', async () => {
    buyer = await signedIn(people.buyer)
    const read = await buyer.get('/portal/email-settings')
    expect(read.status).toBe(200)
    expect(read.body.topics.find((entry: { topic: string }) => entry.topic === 'INVOICES')).toMatchObject({ frequency: 'INSTANT', locked: true, reason: { en: 'Needed to run your orders.' } })
    expect(read.body.topics.find((entry: { topic: string }) => entry.topic === 'DOCUMENTS')).toMatchObject({ frequency: 'DAILY', locked: false, stored: false })
    expect((await buyer.send('PUT' as never, '/portal/email-settings', { topics: [{ topic: 'INVOICES', frequency: 'OFF' }] })).status).toBe(400)
    const off = await buyer.send('PUT' as never, '/portal/email-settings', { nonEssential: 'OFF' })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.nonEssentialOff).toBe(true)
    const instant = await buyer.send('PUT' as never, '/portal/email-settings', { nonEssential: 'DAILY', topics: [{ topic: 'DOCUMENTS', frequency: 'INSTANT' }] })
    expect(instant.body.topics.find((entry: { topic: string }) => entry.topic === 'DOCUMENTS')).toMatchObject({ frequency: 'INSTANT', stored: true })
    // Saving what is there already changes nothing and is still a good answer.
    expect((await buyer.send('PUT' as never, '/portal/email-settings', { topics: [{ topic: 'DOCUMENTS', frequency: 'INSTANT' }] })).status).toBe(200)
    // One row per person and topic, however often it is saved.
    expect((await h.db.admin.query('SELECT topic, count(*)::int AS n FROM "PartnerEmailPreference" WHERE "userId" = $1 GROUP BY topic HAVING count(*) > 1', [ids.buyer])).rows).toEqual([])
    expect((await outbox('partner_email.settings_changed')).length).toBeGreaterThanOrEqual(2)
  })

  it("tells the request's people (as it happens for an instant topic, with both links), not the others; the bell reads and marks read", async () => {
    await fanOutAll()
    h.ses.mails.length = 0
    const asked = await ask({})
    taskId = asked.body.task.id
    expect(await fanOutAll()).toBeGreaterThanOrEqual(2)
    const buyerRows = await notificationsOf(ids.buyer)
    const fresh = buyerRows.filter((row: { messageKey: string }) => row.messageKey === 'portal.task.opened').at(-1)
    expect(fresh).toMatchObject({ partyId: world.partyId, category: 'ASSIGNMENT' })
    expect((await notificationsOf(ids.viewer)).filter((row: { messageKey: string }) => row.messageKey === 'portal.task.opened')).toEqual([])
    expect(await notificationsOf(ids.otherBuyer)).toEqual([])
    // DOCUMENTS as it happens: one mail with the record's link, Manage e-mails and the unsubscribe link.
    const mails = mailsTo(people.buyer, 'portal.notification')
    expect(mails).toHaveLength(1)
    const text = textOf(mails[0]!.raw)
    expect(text).toContain('asks you: Upload the document we asked for on')
    expect(text).toMatch(/\/p\/P[0-9a-f]{6}\?dialog=email-settings/)
    expect(text).toContain('/p/unsubscribe#token=pu1.')
    expect(await deliveriesOf(fresh.id)).toEqual([expect.objectContaining({ channel: 'EMAIL', outcome: 'SENT' })])
    // The admin's DOCUMENTS are daily (the default): no mail now.
    expect(mailsTo(people.admin, 'portal.notification')).toEqual([])
    // A replayed event makes nothing.
    expect(await fanOutAll()).toBe(0)
    const bell = await buyer.get('/portal/notifications')
    expect(bell.status).toBe(200)
    expect(bell.body.items[0]).toMatchObject({ messageKey: 'portal.task.opened', read: false, sentence: { en: expect.stringContaining('asks you: Upload') } })
    expect((await buyer.get('/portal/notifications/counts')).body.unread).toBeGreaterThanOrEqual(1)
    const stranger = await signedIn(people.otherBuyer)
    expect((await stranger.post('/portal/notifications/read', { ids: [fresh.id] })).body).toEqual({ changed: 0, unknown: [fresh.id] })
    expect((await buyer.post('/portal/notifications/read', { all: true })).status).toBe(200)
    expect((await buyer.get('/portal/notifications/counts')).body.unread).toBe(0)
  })

  it('the unsubscribe link of a mail turns non-essential mail off without a session; a token we did not make is refused', async () => {
    const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mailsTo(people.buyer, 'portal.notification').at(-1)!.raw))![1]!)
    const anonymous = await portalBrowser(h)
    const preview = await anonymous.post('/portal/unsubscribe/preview', { token })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body).toMatchObject({ email: expect.stringMatching(/^b•+@brand-alpha\.example$/), alreadyOff: false })
    expect((await anonymous.post('/portal/unsubscribe', { token }, { csrf: false })).status).toBe(403)
    const done = await anonymous.post('/portal/unsubscribe', { token })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect((await buyer.get('/portal/email-settings')).body.nonEssentialOff).toBe(true)
    expect((await anonymous.post('/portal/unsubscribe/preview', { token: token.replace(/.$/, (char) => (char === 'A' ? 'B' : 'A')) })).status).toBe(404)
    expect((await outbox('partner_email.settings_changed')).at(-1)?.payload).toMatchObject({ userId: ids.buyer, byLink: true })
  })

  it('reminds of a request due within 2 days once, and the daily summary carries what was not mailed, once a day', async () => {
    expect(await remindPartnerTasks({ database: h.database, log, clock: h.clock })).toBe(0)
    h.clock.advance(2 * 86_400_000)
    expect(await remindPartnerTasks({ database: h.database, log, clock: h.clock })).toBe(1)
    expect(await remindPartnerTasks({ database: h.database, log, clock: h.clock })).toBe(0)
    expect((await outbox('partner_task.reminded')).map((row) => row.payload.taskId)).toEqual([taskId])
    await fanOutAll()
    const reminders = (await notificationsOf(ids.admin)).filter((row: { messageKey: string }) => row.messageKey === 'portal.task.reminded')
    expect(reminders).toHaveLength(1)
    // The admin's settings are the defaults: daily. The next working day at 08:30 Rome: one summary.
    const now = h.clock.now()
    const next = new Date(now.getTime() + 86_400_000)
    while (![1, 2, 3, 4, 5].includes(new Date(next.toLocaleString('en-US', { timeZone: 'Europe/Rome' })).getDay())) next.setTime(next.getTime() + 86_400_000)
    const day = next.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
    h.clock.set(new Date(`${day}T07:30:00Z`))
    const first = await runPartnerDigests({ database: h.database, log, clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    expect(first.sent).toBeGreaterThanOrEqual(1)
    const summary = mailsTo(people.admin, 'portal.digest')
    expect(summary).toHaveLength(1)
    expect(textOf(summary[0]!.raw)).toContain('Reminder: Upload the document we asked for on')
    expect(await deliveriesOf(reminders[0]!.id)).toEqual([expect.objectContaining({ channel: 'EMAIL_DIGEST', outcome: 'SENT' })])
    await runPartnerDigests({ database: h.database, log, clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    expect(mailsTo(people.admin, 'portal.digest')).toHaveLength(1)
    // The buyer unsubscribed: no summary for them.
    expect(mailsTo(people.buyer, 'portal.digest')).toEqual([])
  })

  it("Home: what waits, the rail's badges and the counts; the hand-over says which requests stay with others", async () => {
    const admin = await signedIn(people.admin)
    const home = await admin.get('/portal/home')
    expect(home.status, JSON.stringify(home.body)).toBe(200)
    expect(home.body).toMatchObject({ kind: 'CUSTOMER', waiting: [expect.objectContaining({ id: taskId })], badges: [expect.objectContaining({ area: 'documents', count: 1 })] })
    expect(home.body.counts.find((count: { key: string }) => count.key === 'tasks.open')).toMatchObject({ value: 1 })
    expect(home.body.counts.find((count: { key: string }) => count.key === 'notifications.unread').value).toBeGreaterThanOrEqual(1)
    const handover = await admin.get(`/portal/tasks/handover/${ids.buyer}`)
    expect(handover.status, JSON.stringify(handover.body)).toBe(200)
    expect(handover.body).toMatchObject({ open: 1, kept: 1, alone: [], colleagues: [expect.objectContaining({ id: ids.admin, count: 1 })] })
    const viewer = await signedIn(people.viewer)
    expect((await viewer.get(`/portal/tasks/handover/${ids.buyer}`)).status).toBe(403)
    expect((await admin.get(`/portal/tasks/handover/${ids.otherBuyer}`)).status).toBe(404)
  })
})
