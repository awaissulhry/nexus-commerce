import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { REQUEST_TASK_WORDS } from '@nexus/factory-domain/portal/tasks/rules'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, inWorld, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../auth/portal/testing/portal'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { systemContext } from '../../outbox/system'
import { partnerFanOut, partnerFanOutEvents } from '../notifications/fan-out'
import { unsubscribeKeyOf } from '../notifications/mail'

/**
 * B-TH-051 (threads plan TH-3, L2-G13; wall test T06; Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand"): the office hands a customer a task on its request (an Inquiry) — a document, an answer or measurements, by a
 * date — and the customer finds it under "We need something from you" (its task list, Home's waiting items, the bell). Brand Alpha
 * (customer A) and Brand Beta (customer B) each have a portal and a buyer: a task on A's request never reaches B (list, Home, bell),
 * and asking it under B's name is refused as "not a record of this partner". A prospect's request, a closed request and a kind a
 * request never needs are refused in words (409 / 400). Requests are written past their guards (test data only). Every name is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs portal/tasks/request-task`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
let beta: string
let sales: Browser
const SLUG = 'th051-request-task'
const people = { alpha: 'anna.alfieri@brand-alpha.example', beta: 'berta.becker@brand-beta.example' }
const ids: Record<keyof typeof people, string> = { alpha: '', beta: '' }
const browsers = {} as Record<keyof typeof people, Browser>
const requests = { open: newId(), declined: newId(), prospect: newId(), betaOpen: newId() }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]

async function partnerPerson(email: string, partyId: string): Promise<string> {
  const id = newId()
  await inWorld(h, world, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment', 'partner-upload']) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: SLUG, company: 'C1', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: SLUG, company: 'C1', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A request as the inquiries module keeps it, written past its triggers (test data only). */
async function request(id: string, values: { number: string; status: string; partyId: string | null }): Promise<void> {
  const prospect = values.partyId === null ? `'Pia Prospect', 'Moto Club Esempio', 'pia.th051@moto-club.example', NULL, 'CONSENT'` : 'NULL, NULL, NULL, NULL, NULL'
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "Inquiry" (id, "tenantId", "companyId", number, source, "receivedAt", status, request, "partyId", "prospectName", "prospectCompany", "prospectEmail", "prospectPhone", "prospectLawfulBasis", "closedAt", "declineReason")
    VALUES ('${id}', '${tenant.id}', '${world.companyId}', '${values.number}', 'PORTAL', now() - interval '2 days', '${values.status}', 'Made-up: team jackets for the season', ${values.partyId ? `'${values.partyId}'` : 'NULL'}, ${prospect},
            ${values.status === 'DECLINED' ? 'now() - interval \'1 day\'' : 'NULL'}, ${values.status === 'DECLINED' ? `'CAPACITY'` : 'NULL'});
  END $$`)
}

const outbox = async (type: string) => admin<{ id: string; type: string; payload: Json; companyId: string | null }>('SELECT id, type, payload, "companyId" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [tenant.id, type])
async function fanOutAll(): Promise<void> {
  for (const type of partnerFanOutEvents()) {
    for (const row of await outbox(type)) await partnerFanOut(callerFor(h.database, systemContext(tenant.id, `th051-${newId()}`)), { eventId: row.id, type: row.type, tenantId: tenant.id, companyId: row.companyId, siteId: null, payload: row.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
  }
}
const dueAt = () => new Date(h.clock.now().getTime() + 3 * 86_400_000).toISOString()
const ask = (partyId: string, recordId: string, kind = 'SEND_MEASUREMENTS') => sales.post(`/partners/${partyId}/tasks`, { kind, recordType: 'Inquiry', recordId, dueAt: dueAt() })

beforeAll(async () => {
  h = await startHarness('th051_request_task')
  h.clock.set(new Date())
  freshGuard(h)
  usePortalOptions({ answerFloorMs: 0 })
  tenant = await addTenant(h, SLUG)
  world = await portalWorld(h, tenant)
  beta = newId()
  await inWorld(h, world, async (client) => {
    await client.party.create({ data: { id: beta, code: `P${beta.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Beta GmbH', tradeName: 'Brand Beta', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: beta, partyId: beta, portalOn: true }, select: { id: true } })
  })
  await request(requests.open, { number: 'INQ-TH051-1', status: 'NEW', partyId: world.partyId })
  await request(requests.declined, { number: 'INQ-TH051-2', status: 'DECLINED', partyId: world.partyId })
  await request(requests.prospect, { number: 'INQ-TH051-3', status: 'NEW', partyId: null })
  await request(requests.betaOpen, { number: 'INQ-TH051-4', status: 'NEW', partyId: beta })
  ids.alpha = await partnerPerson(people.alpha, world.partyId)
  ids.beta = await partnerPerson(people.beta, beta)
  browsers.alpha = await signedIn(people.alpha)
  browsers.beta = await signedIn(people.beta)
  const seller = await addUser(h, tenant, { email: 'sam.sales@th051-request-task.example', role: 'sales' })
  sales = new Browser(h.app)
  await sales.signIn(SLUG, seller.email, seller.password)
  await enrolTotp(h, sales)
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('B-TH-051: hand the customer a task on its request', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let taskId = ''

  it('the office asks customer A for measurements on its open request, by a date; A finds it on its list and Home', async () => {
    const asked = await ask(world.partyId, requests.open)
    expect(asked.status, JSON.stringify(asked.body)).toBe(200)
    expect(asked.body.task).toMatchObject({ kind: 'SEND_MEASUREMENTS', status: 'OPEN', record: { type: 'Inquiry', id: requests.open, label: 'INQ-TH051-1' } })
    taskId = asked.body.task.id
    const [row] = await admin('SELECT "partyId", "companyId", "recordType" FROM "PartnerTask" WHERE id = $1', [taskId])
    expect(row).toEqual({ partyId: world.partyId, companyId: world.companyId, recordType: 'Inquiry' })
    const mine = await browsers.alpha.get('/portal/tasks')
    expect(mine.status, JSON.stringify(mine.body)).toBe(200)
    expect(mine.body.items.map((item: Json) => item.id)).toContain(taskId)
    const home = await browsers.alpha.get('/portal/home')
    expect(home.body.waiting.map((item: Json) => item.id)).toContain(taskId)
  })

  it('T06: the task, its news and Home never reach customer B', async () => {
    await fanOutAll()
    const news = await admin<{ partyId: string; userId: string }>('SELECT "partyId", "userId" FROM "Notification" WHERE "recordType" = \'Inquiry\' AND "recordId" = $1', [requests.open])
    expect(news.map((row) => row.userId)).toContain(ids.alpha)
    for (const row of news) expect(row.partyId).toBe(world.partyId)
    for (const url of ['/portal/tasks', '/portal/home', '/portal/notifications']) {
      const answer = await browsers.beta.get(url)
      expect(answer.status, url).toBe(200)
      expect(taskId).not.toBe('')
      for (const marker of [taskId, requests.open, 'INQ-TH051-1']) expect(JSON.stringify(answer.body), url).not.toContain(marker)
    }
  })

  it('asking on A’s request under B’s name is "not a record of this partner" (naming no one)', async () => {
    const refused = await ask(beta, requests.open)
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/recordId', message: 'Not a record of this partner.' }])
    // B's own open request takes its task.
    expect((await ask(beta, requests.betaOpen, 'UPLOAD_DOCUMENT')).status).toBe(200)
  })

  it('a prospect’s request, a closed request and a kind a request never needs are refused in words', async () => {
    const prospect = await ask(world.partyId, requests.prospect)
    expect(prospect.status).toBe(409)
    expect(prospect.body.error.issues).toEqual([{ path: 'refusal/REQUEST_PROSPECT', message: REQUEST_TASK_WORDS.REQUEST_PROSPECT.en }])
    const closed = await ask(world.partyId, requests.declined)
    expect(closed.status).toBe(409)
    expect(closed.body.error.issues).toEqual([{ path: 'refusal/REQUEST_CLOSED', message: REQUEST_TASK_WORDS.REQUEST_CLOSED.en }])
    const kind = await ask(world.partyId, requests.open, 'REPORT_PROGRESS')
    expect(kind.status).toBe(400)
    expect(kind.body.error.issues).toEqual([{ path: 'body/kind', message: REQUEST_TASK_WORDS.REQUEST_KIND.en }])
    expect((await admin('SELECT count(*)::int AS n FROM "PartnerTask" WHERE "recordId" = ANY($1::uuid[])', [[requests.prospect, requests.declined]]))[0]!.n).toBe(0)
  })
})
