import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../auth/portal/testing/portal'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'

/**
 * A request handed to a colleague (B-W2b-F14 on B-W2b-167; PartnerTask.assigneeId, schema wave 23) on the local stack,
 * through the real app and the portal's sign-in by code: a customer's buyer takes the office's request, the "Mine" filter
 * shows it to them only, the office sees who has it; it is handed to an active colleague whose role acts on it, never to
 * one who cannot act on it, is not active, or is another customer's; a closed request does not move; when the person it
 * was handed to is deactivated, it goes back to everyone in the same command. Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/portal/tasks/assign`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let other: string
let sales: Browser
const SLUG = 'portal-assign-a'

const people = { buyer: 'bea.buyer@brand-gamma.example', viewer: 'vic.viewer@brand-gamma.example', admin: 'ada.admin@brand-gamma.example', resting: 'rex.resting@brand-gamma.example', otherBuyer: 'oscar@brand-delta.example' }
const ids: Record<keyof typeof people, string> = { buyer: '', viewer: '', admin: '', resting: '', otherBuyer: '' }

type Json = Record<string, any>

/** A partner person of a party with template roles over every company of the tenant (as an accepted invitation gives). */
async function partnerPerson(email: string, partyId: string, roleKeys: string[], status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE'): Promise<string> {
  const id = newId()
  await inWorld(h, world, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status, audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  // One new code a minute per address: the clock moves on first.
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A fresh step-up by e-mail code on a portal session (a new code at most once a minute: the clock moves on first). */
async function portalStepUp(browser: Browser, email: string): Promise<void> {
  h.clock.advance(61_000)
  expect((await browser.post('/portal/step-up/start')).status).toBe(200)
  const proved = await browser.post('/portal/step-up', { code: mailedCode(h, email, 'auth.portal_step_up')!.code })
  expect(proved.status, JSON.stringify(proved.body)).toBe(200)
}

const outbox = async (type: string) => (await h.db.admin.query('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [tenant.id, type])).rows.map((row) => row.payload as Json)
const taskRow = async (id: string) => (await h.db.admin.query('SELECT "assigneeId", status::text AS status, version FROM "PartnerTask" WHERE id = $1', [id])).rows[0] as { assigneeId: string | null; status: string; version: number }
const versionOf = async (userId: string) => inWorld(h, world, async (client) => (await client.user.findUniqueOrThrow({ where: { id: userId }, select: { version: true } })).version)

beforeAll(async () => {
  h = await startHarness('portal_assign')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG, 2)
  world = await portalWorld(h, tenant)
  other = newId()
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id: other, code: `P${other.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Delta S.r.l.', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: other, partyId: other, portalOn: true }, select: { id: true } })
  })
  ids.buyer = await partnerPerson(people.buyer, world.partyId, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  ids.viewer = await partnerPerson(people.viewer, world.partyId, ['customer-viewer'])
  ids.admin = await partnerPerson(people.admin, world.partyId, ['customer-admin', 'partner-comment', 'partner-upload', 'partner-approve'])
  ids.resting = await partnerPerson(people.resting, world.partyId, ['customer-buyer', 'partner-upload'], 'SUSPENDED')
  ids.otherBuyer = await partnerPerson(people.otherBuyer, other, ['customer-buyer', 'partner-upload'])
  const seller = await addUser(h, tenant, { email: 'sam.sales@portal-assign-a.example', role: 'sales' })
  sales = new Browser(h.app)
  await sales.signIn(SLUG, seller.email, seller.password)
  await enrolTotp(h, sales)
}, 180_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('a request handed to a colleague (B-W2b-F14, PartnerTask.assigneeId)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let buyer: Browser
  let admin: Browser
  let taskId: string
  const assign = (browser: Browser, assigneeId: string | null, version: number, id = taskId) => browser.post(`/portal/tasks/${id}/assign`, { version, assigneeId })

  it('the buyer takes the office’s request: "Mine" shows it to them only, the others still see it, the office sees who has it', async () => {
    const asked = await sales.post(`/partners/${world.partyId}/tasks`, { kind: 'UPLOAD_DOCUMENT', recordType: 'Party', recordId: world.partyId, companyId: world.companyId, dueAt: new Date(h.clock.now().getTime() + 3 * 86_400_000).toISOString() })
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect(asked.body.task.assignee).toBeNull()
    taskId = asked.body.task.id
    buyer = await signedIn(people.buyer)
    admin = await signedIn(people.admin)
    const before = await buyer.get('/portal/tasks')
    expect(before.body.items).toEqual([expect.objectContaining({ id: taskId, assignee: null, mine: false, canAssign: true })])
    expect(before.body.counts.mine).toBe(0)
    expect(before.body.live.events).toContain('partner_task.assigned')

    const taken = await assign(buyer, ids.buyer, 1)
    expect(taken.status, JSON.stringify(taken.body)).toBe(200)
    expect(taken.body.task).toMatchObject({ id: taskId, assignee: { id: ids.buyer, displayName: 'bea buyer' }, mine: true, version: 2 })
    expect(await taskRow(taskId)).toEqual({ assigneeId: ids.buyer, status: 'OPEN', version: 2 })
    expect(await outbox('partner_task.assigned')).toEqual([{ taskId, partyId: world.partyId, kind: 'UPLOAD_DOCUMENT', assigned: true, why: 'TAKEN' }])

    const mine = await buyer.get('/portal/tasks?mine=true')
    expect(mine.body).toMatchObject({ mine: true, counts: { open: 1, mine: 1 } })
    expect(mine.body.items.map((item: Json) => item.id)).toEqual([taskId])
    expect((await admin.get('/portal/tasks?mine=true')).body).toMatchObject({ items: [], counts: { open: 1, mine: 0 } })
    expect((await admin.get('/portal/tasks')).body.items).toEqual([expect.objectContaining({ id: taskId, assignee: { id: ids.buyer, displayName: 'bea buyer' }, mine: false })])
    const office = await sales.get(`/partners/${world.partyId}/tasks`)
    expect(office.body.items).toEqual([expect.objectContaining({ id: taskId, assignee: { id: ids.buyer, displayName: 'bea buyer' } })])
  })

  it('refuses in words a colleague whose role does not act on it, one who is not active, another customer’s person, a stale version', async () => {
    const viewer = await assign(buyer, ids.viewer, 2)
    expect(viewer.status).toBe(409)
    expect(viewer.body.error).toMatchObject({ code: 'invalid_state', message: 'vic viewer cannot upload this: their role does not allow it.', issues: [{ path: 'body/assigneeId/CANNOT_ACT' }] })
    const resting = await assign(buyer, ids.resting, 2)
    expect(resting.status).toBe(409)
    expect(resting.body.error).toMatchObject({ message: 'rex resting is not active in the portal: hand it to an active colleague.', issues: [{ path: 'body/assigneeId/INACTIVE' }] })
    // Another customer's person is as unknown as a wrong id.
    expect((await assign(buyer, ids.otherBuyer, 2)).status).toBe(404)
    expect((await assign(buyer, newId(), 2)).status).toBe(404)
    expect((await assign(buyer, ids.admin, 1)).status).toBe(409)
    // Nothing moved.
    expect(await taskRow(taskId)).toEqual({ assigneeId: ids.buyer, status: 'OPEN', version: 2 })
    expect(await outbox('partner_task.assigned')).toHaveLength(1)
  })

  it('hands it to the admin, who gives it back; deactivating the person it was handed to gives it back to everyone in the same command', async () => {
    const given = await assign(buyer, ids.admin, 2)
    expect(given.status, JSON.stringify(given.body)).toBe(200)
    expect(given.body.task).toMatchObject({ assignee: { id: ids.admin, displayName: 'ada admin' }, mine: false })
    expect((await admin.get('/portal/tasks?mine=true')).body.items.map((item: Json) => item.id)).toEqual([taskId])
    const back = await assign(admin, ids.buyer, 3)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect((await outbox('partner_task.assigned')).map((payload) => payload.why)).toEqual(['TAKEN', 'GIVEN', 'GIVEN'])

    // The admin's hand-over read says one open request is handed to the buyer; deactivating the buyer gives it back.
    const handover = await admin.get(`/portal/tasks/handover/${ids.buyer}`)
    expect(handover.status, JSON.stringify(handover.body)).toBe(200)
    expect(handover.body).toMatchObject({ open: 1, kept: 1, assigned: 1 })
    await portalStepUp(admin, people.admin)
    const gone = await admin.post(`/portal/colleagues/${ids.buyer}/deactivate`, { version: await versionOf(ids.buyer) })
    expect(gone.status, JSON.stringify(gone.body)).toBe(200)
    expect(await taskRow(taskId)).toEqual({ assigneeId: null, status: 'OPEN', version: 5 })
    expect((await outbox('partner_task.assigned')).at(-1)).toEqual({ taskId, partyId: world.partyId, kind: 'UPLOAD_DOCUMENT', assigned: false, why: 'LEFT' })
    const audit = (await h.db.admin.query(`SELECT after FROM "AuditLog" WHERE "recordType" = 'User' AND "recordId" = $1 AND action = 'portal.deactivateColleague'`, [ids.buyer])).rows
    expect(audit).toEqual([{ after: expect.objectContaining({ status: 'DEACTIVATED', tasksHandedBack: 1 }) }])
    expect((await admin.get('/portal/tasks')).body.items).toEqual([expect.objectContaining({ id: taskId, assignee: null })])
  })

  it('moves no closed request: withdrawn or done, it is refused in words (409); the database holds the same', async () => {
    const taken = await assign(admin, ids.admin, 5)
    expect(taken.status, JSON.stringify(taken.body)).toBe(200)
    // The office withdraws it: who had it stays (its history); handing it on is refused in words.
    const cancelled = await sales.post(`/partner-tasks/${taskId}/cancel`, { version: 6 })
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.task).toMatchObject({ status: 'CANCELLED', assignee: { id: ids.admin, displayName: 'ada admin' } })
    const withdrawn = await assign(admin, null, 7)
    expect(withdrawn.status).toBe(409)
    expect(withdrawn.body.error).toMatchObject({ message: 'This request was withdrawn: only an open request is handed to a colleague.', issues: [{ path: 'task/CANCELLED' }] })
    // Reopened, then marked done in the portal: done is refused too.
    expect((await sales.post(`/partner-tasks/${taskId}/reopen`, { version: 7 })).status).toBe(200)
    const marked = await admin.post(`/portal/tasks/${taskId}/done`, { version: 8 })
    expect(marked.status, JSON.stringify(marked.body)).toBe(200)
    const done = await assign(admin, ids.admin, 9)
    expect(done.status).toBe(409)
    expect(done.body.error).toMatchObject({ message: 'This request is already done: only an open request is handed to a colleague.', issues: [{ path: 'task/DONE' }] })
    expect(await taskRow(taskId)).toEqual({ assigneeId: ids.admin, status: 'DONE', version: 9 })
    // The database's guard holds the same for every login: a closed task is handed to nobody.
    await expect(h.db.admin.query('UPDATE "PartnerTask" SET "assigneeId" = NULL, version = version + 1 WHERE id = $1', [taskId])).rejects.toThrow(/only while OPEN|changes only by being reopened/)
  })
})
