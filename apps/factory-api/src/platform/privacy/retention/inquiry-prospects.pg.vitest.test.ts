import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { SUGGESTED_KEEP_MONTHS } from '@nexus/factory-domain/privacy/retention/retention'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'

/**
 * B-TH-053 (threads plan TH-3, L2-G20; GDPR art. 5(1)(e); GATE-PRIVACY): the prospects of closed requests have a retention rule.
 * The sweep knows Inquiry: a request of someone who is not a customer yet, closed (quoted, declined, lost) longer ago than the
 * rule's period, is due; the rule REPORTS it until a person switches it on with a fresh code (the Owner's pick: 24 months,
 * unverified until the privacy consultant confirms), then the sweep erases the prospect — name, company, e-mail, phone blank
 * for good, with when and by whom — and keeps the request, its lawful basis and everything else. Never due: an open request,
 * a customer's request, a recent close, a prospect already erased. Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/privacy/retention`.
 */

let h: Harness
const NS = 'th053-inquiries'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const MONTH = 30 * 86_400_000
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let desk: { browser: Browser; secret: string; userId: string }
let keys = 0
const send = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => desk.browser.send(method as 'POST', url, body, { headers: { 'idempotency-key': `th053-${++keys}-${newId()}` } })
async function ok(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await send(method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const customer = newId()
const ids = { closedOld: newId(), closedRecent: newId(), openOld: newId(), customerOld: newId(), erasedOld: newId() }
let serial = 0

/** A request as the inquiries module keeps it (written past its triggers: the dates are in the past, test data only). */
async function request(id: string, values: { status: string; monthsAgo: number; prospect: boolean; partyId?: string; erased?: boolean }): Promise<void> {
  const received = new Date(Date.now() - (values.monthsAgo + 1) * MONTH).toISOString()
  const closed = values.status === 'NEW' ? 'NULL' : `'${new Date(Date.now() - values.monthsAgo * MONTH).toISOString()}'`
  const prospect = values.prospect && !values.erased ? `'Pia Prospect ${serial + 1}', 'Moto Club Esempio', 'pia${serial + 1}@moto-club.example.com', '+39 000 000 000${serial % 10}', 'CONSENT'` : values.erased ? `NULL, NULL, NULL, NULL, 'CONSENT'` : 'NULL, NULL, NULL, NULL, NULL'
  serial++
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "Inquiry" (id, "tenantId", "companyId", number, source, "receivedAt", status, request, "partyId", "prospectName", "prospectCompany", "prospectEmail", "prospectPhone", "prospectLawfulBasis", "closedAt", "declineReason", "closeNote", "prospectErasedAt", "prospectErasedById")
    VALUES ('${id}', '${T}', '${companyA}', 'INQ-TH053-${serial}', 'FAIR', '${received}', '${values.status}', 'Team suits for the season', ${values.partyId ? `'${values.partyId}'` : 'NULL'}, ${prospect}, ${closed}, ${values.status === 'DECLINED' ? `'CAPACITY'` : 'NULL'}, ${values.status === 'LOST' ? `'They chose another maker (made up).'` : 'NULL'}, ${values.erased ? `'${received}'` : 'NULL'}, ${values.erased ? `'${newId()}'` : 'NULL'});
  END $$`)
}
const row = async (id: string) => (await admin('SELECT "prospectName", "prospectCompany", "prospectEmail", "prospectPhone", "prospectLawfulBasis"::text, "prospectErasedAt", "prospectErasedById", status::text, request FROM "Inquiry" WHERE id = $1', [id]))[0]!

beforeAll(async () => {
  h = await startHarness('retention_inquiries')
  await seedCore({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }] }
  const user = await addUser(h, tenant, { email: 'privacy.desk.th053@example.com' })
  await addRole(h, tenant, user.id, 'admin')
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  desk = { browser, secret: await enrolTotp(h, browser), userId: user.id }
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'TH053-C1', 'ORGANISATION', 'Cliente Esempio S.r.l.', '{CUSTOMER}')`, [customer, T, companyA])
  await request(ids.closedOld, { status: 'DECLINED', monthsAgo: 30, prospect: true })
  await request(ids.closedRecent, { status: 'LOST', monthsAgo: 3, prospect: true })
  await request(ids.openOld, { status: 'NEW', monthsAgo: 30, prospect: true })
  await request(ids.customerOld, { status: 'DECLINED', monthsAgo: 30, prospect: false, partyId: customer })
  await request(ids.erasedOld, { status: 'LOST', monthsAgo: 30, prospect: true, erased: true })
}, 300_000)

afterAll(async () => {
  await h?.close()
}, 60_000)

describe('closed prospect requests have a retention rule (B-TH-053)', () => {
  let rule: Json

  it('the sweep knows Inquiry: anonymise its prospect, counted from the close; the suggested period is 24 months', async () => {
    expect(SUGGESTED_KEEP_MONTHS.Inquiry).toBe(24)
    const listed = await ok('GET', '/privacy/retention')
    expect(listed.types.find((entry: Json) => entry.recordType === 'Inquiry')).toMatchObject({ companyScoped: true, actions: ['ANONYMISE'], holdsAll: null, countsFrom: expect.stringContaining('closed') })
    rule = (await ok('POST', '/privacy/retention/rules', { companyId: null, recordType: 'Inquiry', keepMonths: SUGGESTED_KEEP_MONTHS.Inquiry, thenAction: 'ANONYMISE', legalReason: 'Prospects of closed requests: 24 months (Owner pick, waits for the privacy consultant).' }, 201)).rule
    expect(rule).toMatchObject({ key: 'retention:Inquiry:all', applyOn: false, unverified: true, known: true, period: '2 years' })
    // A request is never deleted by a sweep (only its prospect erased); one rule per record type and company.
    expect((await send('POST', '/privacy/retention/rules', { companyId: null, recordType: 'Inquiry', keepMonths: 24, thenAction: 'DELETE', legalReason: 'Delete them.' })).body.error.issues[0].path).toBe('thenAction')
    expect((await send('POST', '/privacy/retention/rules', { companyId: null, recordType: 'Inquiry', keepMonths: 36, thenAction: 'ANONYMISE', legalReason: 'Again.' })).status).toBe(409)
  })

  it('reports only the closed prospect request past the period, and changes nothing', async () => {
    const before = await row(ids.closedOld)
    const swept = await ok('POST', `/privacy/retention/rules/${rule.id}/sweep`, undefined, 201)
    expect(swept.sweep).toMatchObject({ mode: 'REPORT', status: 'DONE', due: 1, applied: 0, held: 0 })
    expect(await row(ids.closedOld)).toEqual(before)
    rule = swept.rule
  })

  it('switched on with a fresh code, the sweep erases that prospect for good and keeps the request; nothing else changes', async () => {
    const others = await Promise.all([ids.closedRecent, ids.openOld, ids.customerOld, ids.erasedOld].map(row))
    await stepUp(h, desk.browser, desk.secret)
    rule = (await ok('POST', `/privacy/retention/rules/${rule.id}/apply`, { version: rule.version, on: true })).rule
    expect(rule.applyOn).toBe(true)
    const swept = await ok('POST', `/privacy/retention/rules/${rule.id}/sweep`, undefined, 201)
    expect(swept.sweep).toMatchObject({ mode: 'APPLY', status: 'DONE', due: 1, applied: 1, held: 0 })
    expect(await row(ids.closedOld)).toMatchObject({
      prospectName: null,
      prospectCompany: null,
      prospectEmail: null,
      prospectPhone: null,
      prospectLawfulBasis: 'CONSENT',
      prospectErasedAt: expect.any(Date),
      prospectErasedById: desk.userId,
      status: 'DECLINED',
      request: 'Team suits for the season',
    })
    expect(await Promise.all([ids.closedRecent, ids.openOld, ids.customerOld, ids.erasedOld].map(row))).toEqual(others)
    // A second sweep finds nothing more.
    expect((await ok('POST', `/privacy/retention/rules/${rule.id}/sweep`, undefined, 201)).sweep).toMatchObject({ mode: 'APPLY', due: 0, applied: 0 })
  })
})
