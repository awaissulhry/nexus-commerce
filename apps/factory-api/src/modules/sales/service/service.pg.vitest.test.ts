import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { addYears, daysBetween } from '@nexus/factory-domain/sales/service/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedService } from '../../../../../../packages/factory-db/seed/service'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor } from '../../../core/command'
import { scopeForContext } from '../../../core/context'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { deliverOutbound, threadMailBuilder } from '../../../platform/email-out/outbound'
import { serviceCases as exportSource } from '../../../platform/exports/sources/service-cases'
import indexer from '../../../platform/search/indexers/service-case'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Warranty and service cases on the local stack (B-W2b-345; SAL-368, SAL-436), through the real app and real office sign-ins:
 * the factory-db seeds up to the service wave (SVC-SEED-0001..0003, the serials SEED-SN-0001..0003 of batch SEED-BT-0003 made
 * for P1, SH-0001 shipped to P1 with batch SEED-BT-0001, the private rider P4 and its contact, company A's FAKE sending
 * address), a service desk (view, manage, decide, repairs and returns), quality (view and manage, no decide), a reader, and
 * a desk limited to customer P2. Every name, number and address is made up; every date is counted from the test's own day.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/service/`.
 */

let h: Harness
const NS = 'service-cases-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const P2 = seedUuid(NS, 'party:P2')
const P4 = seedUuid(NS, 'party:P4')
const riderContact = seedUuid(NS, 'party-contact:P4:rider')
const buyerContact = seedUuid(NS, 'party-contact:P1:buyer')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

const browsers = {} as Record<'desk' | 'quality' | 'reader' | 'limited', Browser>
let keyCount = 0
const key = () => `w2b345-${process.pid}-${++keyCount}-${Date.now()}`
const send = (browser: Browser, method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => browser.send(method as 'POST', url, body ?? (method === 'DELETE' ? undefined : {}), { headers: { 'idempotency-key': key() } })
const post = (browser: Browser, url: string, body: unknown = {}) => send(browser, 'POST', url, body)
const patch = (browser: Browser, url: string, body: unknown) => send(browser, 'PATCH', url, body)
async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}
async function done(answer: { status: number; body: any }, status = 200): Promise<Json> {
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const system = () => callerFor(h.database, systemContext(T, newId()))
const today = () => businessDate(h.clock.now())
const daysAgo = (days: number) => businessDate(new Date(h.clock.now().getTime() - days * 86_400_000))

const DESK: Permission[] = ['home.view', 'sales.service.view', 'sales.service.manage', 'sales.service.decide', 'sales.repairs.view', 'sales.repairs.manage', 'sales.returns.view', 'sales.returns.manage', 'orders.view', 'quality.complaints.view', 'threads.read', 'threads.post']
const QUALITY: Permission[] = ['home.view', 'sales.service.view', 'sales.service.manage', 'threads.read']
const READER: Permission[] = ['home.view', 'sales.service.view']

beforeAll(async () => {
  h = await startHarness('service_cases')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedService({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
  })
  const roles = { desk: DESK, quality: QUALITY, reader: READER, limited: DESK }
  for (const [name, permissions] of Object.entries(roles)) {
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, $3, $4, $5, false)`, [newId(), T, `service-${name}-345`, `Service ${name} (test)`, [...permissions].sort()])
  }
  for (const name of ['desk', 'quality', 'reader'] as const) await addUser(h, tenant, { email: `${name}.service.345@example.com`, role: `service-${name}-345` })
  // The desk limited to customer P2 (its cases, and the cases that name no customer).
  const limited = await addUser(h, tenant, { email: 'limited.service.345@example.com' })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: limited.id }, async (client) => {
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'service-limited-345' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: limited.id, roleId: role.id, allCompanies: true, partyIds: [P2], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  for (const name of ['desk', 'quality', 'reader', 'limited'] as const) {
    browsers[name] = new Browser(h.app)
    expect((await browsers[name].signIn(NS, `${name}.service.345@example.com`, 'quiet-harbour-lantern-58')).status).toBe(200)
  }
}, 300_000)

afterAll(async () => {
  await h?.close()
})

let consumerCase: Json
let businessCase: Json

describe('a warranty case for a consumer: the legal guarantee against the factory’s own (SAL-368)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('previews a scanned serial: our garment, its batch, the other open case of the same garment, the check in words', async () => {
    const preview = await done(await post(browsers.desk, '/sales/service/cases/preview', { companyId: companyA, partyId: P1, kind: 'WARRANTY', serial: 'SEED-SN-0002' }))
    expect(preview.garment.serial).toMatchObject({ serial: 'SEED-SN-0002', workOrderNumber: 'SEED-WO-0003', batchNumber: 'SEED-BT-0003', madeForPartyId: P1, shipment: null })
    expect(preview.draft).toMatchObject({ garmentSerial: 'SEED-SN-0002', garmentBatch: 'SEED-BT-0003', batchNumber: 'SEED-BT-0003', size: '52', deliveredOn: null })
    expect(preview.others.map((other: Json) => other.number)).toEqual(['SVC-SEED-0001'])
    expect(preview.warnings.map((warning: Json) => warning.message)).toContain('Case SVC-SEED-0001 is open for this garment (new).')
    // A business customer: not the consumer's legal guarantee; nothing known yet.
    expect(preview.warranty).toMatchObject({ buyer: 'BUSINESS', suggested: null, state: 'UNKNOWN', legal: { state: 'NONE' } })
    expect(preview.ok).toBe(false)
    expect(preview.problems.map((problem: Json) => problem.path)).toEqual(['body/channel', 'body/problem'])
    // REFUSED: a batch the serial is not of.
    const wrong = await done(await post(browsers.desk, '/sales/service/cases/preview', { companyId: companyA, serial: 'SEED-SN-0002', batchNumber: 'SEED-BT-0001' }))
    expect(wrong.problems).toContainEqual({ path: 'body/batchNumber', message: 'Serial SEED-SN-0002 is of batch SEED-BT-0003, not SEED-BT-0001.' })
  })

  it('opens it NEW with its number, the legal guarantee counted from delivery, the customer not told by default; refusals in words', async () => {
    const delivered = daysAgo(100)
    const body = { companyId: companyA, kind: 'WARRANTY', channel: 'PHONE', partyId: P4, contactId: riderContact, serial: 'SEED-SN-0001', problem: 'The collar zip came off after a month.\nThe rider wants it fixed.', customerWants: 'REPAIR', deliveredOn: delivered }
    // REFUSED: the reader may not open one; told at each status change without a contact; no problem.
    expect((await post(browsers.reader, '/sales/service/cases', body)).status).toBe(403)
    expect((await done(await post(browsers.desk, '/sales/service/cases', { ...body, contactId: null, notifyCustomer: true }), 400)).error.issues).toContainEqual({ path: 'body/notifyCustomer', message: "The customer is told at each status change by e-mail to the case's contact: name a contact with an e-mail first." })
    expect((await done(await post(browsers.desk, '/sales/service/cases', { ...body, problem: '  ' }), 400)).error.issues).toEqual([{ path: 'body/problem', message: "Say what is wrong, in the customer's words." }])
    const opened = await done(await post(browsers.desk, '/sales/service/cases', body), 201)
    consumerCase = opened.case
    expect(consumerCase.number).toMatch(/^SVC-\d{4}-0001$/)
    expect(consumerCase).toMatchObject({ status: 'NEW', kind: 'WARRANTY', channel: 'PHONE', garmentSerial: 'SEED-SN-0001', garmentBatch: 'SEED-BT-0003', notifyCustomer: false, party: { id: P4, kind: 'PERSON' }, summary: 'The collar zip came off after a month.' })
    expect(opened.warnings.map((warning: Json) => warning.message)).toContain("Serial SEED-SN-0001 was made for another customer's order: check the label.")
    expect(consumerCase.warranty).toMatchObject({ deliveredOn: delivered, legalGuaranteeEndsOn: addYears(delivered, 2), factoryGuaranteeEndsOn: null, decided: null })
    expect(consumerCase.warranty.check).toMatchObject({ buyer: 'CONSUMER', suggested: 'LEGAL_GUARANTEE', state: 'LEGAL_GUARANTEE', legal: { state: 'RUNS', daysLeft: daysBetween(today(), addYears(delivered, 2)) }, presumption: { applies: true } })
    expect(consumerCase.cover).toEqual({ state: 'LEGAL_GUARANTEE', decided: false, decision: null })
    expect(consumerCase.actions.find((action: Json) => action.action === 'resolve')).toEqual({ action: 'resolve', allowed: false, held: 'NOT_NEW' })
    const [event] = (await events('service_case.opened')).filter((payload) => payload.caseId === consumerCase.id)
    expect(event).toMatchObject({ number: consumerCase.number, partyId: P4, kind: 'WARRANTY', channel: 'PHONE', garmentSerial: 'SEED-SN-0001' })
    // The audit row names the facts, never the customer's words.
    const audit = await one<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'ServiceCase' AND "recordId" = $1 ORDER BY at, id LIMIT 1`, [consumerCase.id])
    expect(JSON.stringify(audit.after)).not.toContain('collar zip')
    // Its maker follows it.
    expect(await admin(`SELECT reason::text FROM "RecordFollower" WHERE "recordType" = 'ServiceCase' AND "recordId" = $1`, [consumerCase.id])).toEqual([{ reason: 'CREATOR' }])
  })

  it('switches the status mails on (a contact with an e-mail), and holds a warranty claim from resolving before its cover is decided', async () => {
    const changed = await done(await patch(browsers.desk, `/sales/service/cases/${consumerCase.id}`, { version: consumerCase.version, notifyCustomer: true, priority: 'HIGH' }))
    consumerCase = changed.case
    expect(consumerCase).toMatchObject({ notifyCustomer: true, priority: 'HIGH' })
    expect((await events('service_case.changed')).filter((payload) => payload.caseId === consumerCase.id)).toEqual([{ caseId: consumerCase.id, number: consumerCase.number, fields: ['notifyCustomer', 'priority'] }])
    const opened = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/status`, { version: consumerCase.version, to: 'OPEN', message: 'We will call you tomorrow about the zip.' }))
    consumerCase = opened.case
    expect(opened.notified).toMatchObject({ sent: true, to: 'rider.p4@example.com', subject: `Pratica di assistenza ${consumerCase.number}: in lavorazione` })
    // REFUSED: resolved before the cover is decided (a warranty claim).
    const held = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/status`, { version: consumerCase.version, to: 'RESOLVED', resolution: 'Zip replaced.' }), 409)
    expect(held.error.issues[0].path).toBe('held/COVER_UNDECIDED')
  })

  it("queues the status mail on the case's thread and the FAKE mailbox delivers it in Italian, sent as the person", async () => {
    const [mail] = await admin<{ id: string; status: string; to: string[]; subject: string; threadId: string }>(`SELECT id, status::text, "to", subject, "threadId" FROM "EmailOutbound" WHERE "recordType" = 'ServiceCase' AND "recordId" = $1`, [consumerCase.id])
    expect(mail).toMatchObject({ status: 'QUEUED', to: ['rider.p4@example.com'] })
    expect(await one(`SELECT "partyId" FROM "Thread" WHERE id = $1`, [mail!.threadId])).toEqual({ partyId: P4 })
    expect(await one(`SELECT direction::text, channel::text FROM "Message" WHERE "threadId" = $1`, [mail!.threadId])).toEqual({ direction: 'OUTBOUND', channel: 'EMAIL' })
    expect((await events('service_case.status_changed')).find((payload) => payload.caseId === consumerCase.id)).toEqual({ caseId: consumerCase.id, number: consumerCase.number, from: 'NEW', to: 'OPEN', notified: true })
    expect(await deliverOutbound(h.email, system(), mail!.id, { retry: true, build: threadMailBuilder(h.email, system()) })).toBe('sent')
    const sent = h.ses.mails.find((entry) => entry.outboundId === mail!.id)!
    expect(sent.to).toEqual(['rider.p4@example.com'])
    const text = textOf(sent.raw)
    expect(text).toContain('Gentile Seed Private Rider,')
    expect(text).toContain(`la sua pratica di assistenza ${consumerCase.number} è in lavorazione.`)
    expect(text).toContain('We will call you tomorrow about the zip.')
    expect(text).not.toContain('collar zip came off')
    const record = (await ok(browsers.desk, `/sales/service/cases/${consumerCase.id}`)).case
    expect(record.mails).toEqual([expect.objectContaining({ id: mail!.id, status: 'SENT', to: ['rider.p4@example.com'] })])
  })

  it('decides the cover: quality may not, a refusal in words, then covered under the legal guarantee with why', async () => {
    const body = { version: consumerCase.version, cover: 'LEGAL_GUARANTEE', decision: 'COVERED', note: 'A zip that comes off within a month is a defect of conformity.' }
    expect((await post(browsers.quality, `/sales/service/cases/${consumerCase.id}/cover`, body)).status).toBe(403)
    expect((await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/cover`, { ...body, decision: 'NOT_COVERED' }), 400)).error.issues).toEqual([{ path: 'body/cover', message: 'Not covered: the cover is none (out of cover).' }])
    const decided = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/cover`, body))
    consumerCase = decided.case
    expect(decided.warnings).toEqual([])
    expect(consumerCase.warranty.decided).toMatchObject({ cover: 'LEGAL_GUARANTEE', decision: 'COVERED', note: body.note })
    expect(consumerCase.warranty.decided.remedies).toContain('free of charge')
    expect(consumerCase.cover).toEqual({ state: 'LEGAL_GUARANTEE', decided: true, decision: 'COVERED' })
    expect((await events('service_case.cover_decided')).find((payload) => payload.caseId === consumerCase.id)).toEqual({ caseId: consumerCase.id, number: consumerCase.number, cover: 'LEGAL_GUARANTEE', decision: 'COVERED' })
  })

  it('opens a repair from the case in one command, linked; waits for a part, resolves, reopens and closes, the customer told each time', async () => {
    expect((await post(browsers.quality, `/sales/service/cases/${consumerCase.id}/repair`, { version: consumerCase.version })).status).toBe(403)
    const repaired = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/repair`, { version: consumerCase.version, workWanted: 'Replace the collar zip.' }), 201)
    consumerCase = repaired.case
    expect(repaired.repair.number).toMatch(/^REP-/)
    const repair = await one(`SELECT "partyId", serial, "garmentSerial", stage::text, "workWanted" FROM "RepairOrder" WHERE id = $1`, [repaired.repair.id])
    expect(repair).toEqual({ partyId: P4, serial: 'SEED-SN-0001', garmentSerial: 'SEED-SN-0001', stage: 'AWAITING_GOODS', workWanted: 'Replace the collar zip.' })
    expect(consumerCase.links).toEqual([expect.objectContaining({ recordType: 'RepairOrder', recordId: repaired.repair.id, note: `Repair ${repaired.repair.number} opened from the case.`, record: { label: repaired.repair.number, status: 'AWAITING_GOODS' } })])
    expect((await events('service_case.linked')).find((payload) => payload.caseId === consumerCase.id)).toMatchObject({ recordType: 'RepairOrder', change: 'LINKED', via: 'REPAIR' })
    expect((await events('repair.created')).some((payload) => payload.repairId === repaired.repair.id)).toBe(true)
    // The moves, each with its status mail.
    for (const move of [{ to: 'WAITING_PART' }, { to: 'RESOLVED', resolution: 'Zip replaced under the legal guarantee.' }, { to: 'OPEN' }]) {
      const moved = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/status`, { version: consumerCase.version, ...move }))
      consumerCase = moved.case
      expect(moved.notified.sent).toBe(true)
    }
    // Reopened: the resolution goes.
    expect(consumerCase).toMatchObject({ status: 'OPEN', resolution: null })
    expect((await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/status`, { version: consumerCase.version, to: 'CLOSED' }), 400)).error.issues).toEqual([{ path: 'body/reason', message: 'Closed without a resolution: say why, in words.' }])
    const closed = await done(await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/status`, { version: consumerCase.version, to: 'CLOSED', reason: 'The rider took the garment to the shop instead.' }))
    consumerCase = closed.case
    expect(closed.warnings.map((warning: Json) => warning.message)).toEqual([`Closed with ${repaired.repair.number} still open: they go on on their own.`])
    expect(consumerCase).toMatchObject({ status: 'CLOSED', closed: { reason: 'The rider took the garment to the shop instead.' } })
    const subjects = (await admin<{ subject: string }>(`SELECT subject FROM "EmailOutbound" WHERE "recordType" = 'ServiceCase' AND "recordId" = $1 ORDER BY "queuedAt", id`, [consumerCase.id])).map((row) => row.subject.split(': ')[1])
    expect(subjects).toEqual(['in lavorazione', 'in attesa di un ricambio', 'risolta', 'in lavorazione', 'chiusa'])
    // A closed case: its facts and links never change; its internal note still may.
    expect((await patch(browsers.desk, `/sales/service/cases/${consumerCase.id}`, { version: consumerCase.version, problem: 'Other words.' })).status).toBe(409)
    expect((await post(browsers.desk, `/sales/service/cases/${consumerCase.id}/links`, { version: consumerCase.version, recordType: 'RepairOrder', recordId: repaired.repair.id })).status).toBe(409)
    const noted = await done(await patch(browsers.desk, `/sales/service/cases/${consumerCase.id}`, { version: consumerCase.version, internalNote: 'Called the shop: they fit a new zip.' }))
    expect(noted.case).toMatchObject({ status: 'CLOSED', internalNote: 'Called the shop: they fit a new zip.' })
  })
})

describe("a business customer's case: a batch, a return for a remake or a credit, links by hand, a mail that cannot go", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it("opens a complaint about a batch: the delivery day from the batch's only shipment, the factory guarantee typed", async () => {
    const factoryEnds = addYears(today(), 1)
    const opened = await done(await post(browsers.desk, '/sales/service/cases', { companyId: companyA, kind: 'COMPLAINT', channel: 'MAIL', partyId: P1, contactId: buyerContact, batchNumber: 'SEED-BT-0001', problem: 'Several jackets of the batch lose their colour at the cuffs.', factoryGuaranteeEndsOn: factoryEnds }), 201)
    businessCase = opened.case
    expect(businessCase).toMatchObject({ garmentBatch: 'SEED-BT-0001', garmentSerial: null, party: { id: P1, kind: 'ORGANISATION' } })
    expect(businessCase.garment.batch.deliveries.length).toBe(1)
    // The seed's shipment day may be before or after the test's day: a day after today is said, never used.
    const shipped = businessCase.garment.batch.deliveries[0].day
    expect(businessCase.warranty.deliveredOn).toBe(shipped <= today() ? shipped : null)
    expect(opened.warnings.map((warning: Json) => warning.path)).toContain('body/deliveredOn')
    expect(businessCase.warranty.check).toMatchObject({ buyer: 'BUSINESS', suggested: 'FACTORY_GUARANTEE', legal: { state: 'NONE' }, factory: { state: 'RUNS', endsOn: factoryEnds } })
    expect(businessCase.warranty.legalGuaranteeEndsOn).toBeNull()
    // REFUSED: the legal guarantee for a business without its last day.
    expect((await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/cover`, { version: businessCase.version, cover: 'LEGAL_GUARANTEE', decision: 'COVERED', note: 'x' }), 400)).error.issues[0].path).toBe('body/cover')
  })

  it('opens a return for a remake and one for a credit, each linked; the garment line is refused without a shipment of the serial', async () => {
    const returnable = await ok(browsers.desk, `/sales/returns/returnable?companyId=${companyA}&partyId=${P1}`)
    // The seeds leave P1 one shipped piece that may come back (SEED-RMA-0002 takes the other): the remake takes it, the remake's
    // return is cancelled on its own record (W2a's route), and the credit takes the same piece again.
    const piece = returnable.lines.find((entry: Json) => entry.left > 0 && entry.salesOrderLineId)
    expect(piece).toBeDefined()
    const reason = await one<{ code: string }>(`SELECT code FROM "ReasonCode" WHERE "tenantId" = $1 AND list = 'RETURN' AND active ORDER BY code LIMIT 1`, [T])
    // REFUSED: no lines and no garment of ours that left on a shipment.
    expect((await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/return`, { version: businessCase.version, purpose: 'RETURN', reasonCode: reason.code }), 400)).error.issues).toEqual([{ path: 'body/lines', message: 'The case names no garment of ours: name the lines that come back.' }])
    const lineOf = (entry: Json) => [{ salesOrderLineId: entry.salesOrderLineId, size: entry.size, quantity: 1, reasonCode: reason.code }]
    expect((await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/return`, { version: businessCase.version, purpose: 'REMAKE', lines: lineOf(piece) }), 400)).error.issues.map((issue: Json) => issue.path)).toContain('body/fit')
    const remade = await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/return`, { version: businessCase.version, purpose: 'REMAKE', lines: lineOf(piece), fit: 'The sleeves are 2 cm too short for the rider.' }), 201)
    businessCase = remade.case
    expect(remade.next).toContain('remake is asked')
    expect(await one(`SELECT status::text, "partyId", "contactId" FROM "ReturnAuthorisation" WHERE id = $1`, [remade.return.id])).toEqual({ status: 'AUTHORISED', partyId: P1, contactId: buyerContact })
    expect((await events('return.remake_asked')).find((payload) => payload.returnId === remade.return.id)).toMatchObject({ via: 'OFFICE' })
    const rma = await one<{ version: number }>(`SELECT version FROM "ReturnAuthorisation" WHERE id = $1`, [remade.return.id])
    await done(await post(browsers.desk, `/sales/returns/${remade.return.id}/cancel`, { version: rma.version, reason: 'The customer asked for a credit instead.' }))
    const credited = await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/return`, { version: businessCase.version, purpose: 'CREDIT', lines: lineOf(piece) }), 201)
    businessCase = credited.case
    expect(credited.next).toContain('Credit without return')
    expect(businessCase.links.map((link: Json) => [link.recordType, link.note])).toEqual([
      ['ReturnAuthorisation', `Return ${remade.return.number} opened from the case for a remake.`],
      ['ReturnAuthorisation', `Return ${credited.return.number} opened from the case for a credit.`],
    ])
    expect((await events('service_case.linked')).filter((payload) => payload.caseId === businessCase.id).map((payload) => payload.via)).toEqual(['REMAKE', 'CREDIT'])
    // The list of the cases a return is linked to.
    const linked = await ok(browsers.desk, `/sales/service/cases?view=all&linked=ReturnAuthorisation:${credited.return.id}`)
    expect(linked.cases.map((row: Json) => row.number)).toEqual([businessCase.number])
  })

  it('links and unlinks a record by hand: of the case’s customer, once, seen by the person', async () => {
    const order = await one<{ id: string; number: string }>(`SELECT id, number FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 1`, [T, P1])
    const other = await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" <> $2 AND "companyId" = $3 ORDER BY number LIMIT 1`, [T, P1, companyA])
    const linked = await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/links`, { version: businessCase.version, recordType: 'SalesOrder', recordId: order.id, note: 'The order the batch was made for.' }))
    businessCase = linked.case
    expect(businessCase.links.at(-1)).toMatchObject({ recordType: 'SalesOrder', recordId: order.id, record: { label: order.number } })
    // REFUSED: twice; another customer's order (when the seed has one).
    expect((await post(browsers.desk, `/sales/service/cases/${businessCase.id}/links`, { version: businessCase.version, recordType: 'SalesOrder', recordId: order.id })).status).toBe(409)
    if (other) expect((await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/links`, { version: businessCase.version, recordType: 'SalesOrder', recordId: other.id }), 400)).error.issues[0].path).toBe('body/recordId')
    // A reader without orders.view sees the link, not the order.
    const seenByQuality = (await ok(browsers.quality, `/sales/service/cases/${businessCase.id}`)).case
    expect(seenByQuality.links.find((link: Json) => link.recordType === 'SalesOrder').record).toBeNull()
    const link = businessCase.links.at(-1)
    const unlinked = await done(await send(browsers.desk, 'DELETE', `/sales/service/cases/${businessCase.id}/links/${link.id}?version=${businessCase.version}`))
    businessCase = unlinked.case
    expect(businessCase.links.map((entry: Json) => entry.recordType)).toEqual(['ReturnAuthorisation', 'ReturnAuthorisation'])
    expect((await events('service_case.linked')).filter((payload) => payload.caseId === businessCase.id).at(-1)).toMatchObject({ change: 'UNLINKED', recordType: 'SalesOrder' })
  })

  it('a status mail that cannot go (the address is on the blocked list) does not hold the move: it says why', async () => {
    await admin(`UPDATE "PartyContact" SET email = $1 WHERE id = $2`, [`stopped.${NS}@example.com`, buyerContact])
    const on = await done(await patch(browsers.desk, `/sales/service/cases/${businessCase.id}`, { version: businessCase.version, notifyCustomer: true }))
    const moved = await done(await post(browsers.desk, `/sales/service/cases/${businessCase.id}/status`, { version: on.case.version, to: 'OPEN' }))
    businessCase = moved.case
    expect(businessCase.status).toBe('OPEN')
    expect(moved.notified).toMatchObject({ sent: false, reason: 'NOT_SENT' })
    expect(moved.warnings[0].path).toBe('notified')
    expect((await events('service_case.status_changed')).find((payload) => payload.caseId === businessCase.id)).toMatchObject({ to: 'OPEN', notified: false })
    expect(await admin(`SELECT id FROM "EmailOutbound" WHERE "recordType" = 'ServiceCase' AND "recordId" = $1`, [businessCase.id])).toEqual([])
    await admin(`UPDATE "PartyContact" SET email = 'buyer.p1@example.com' WHERE id = $1`, [buyerContact])
  })
})

describe('the list, its tiles, its scope; search and the export source', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists by saved row and filter; the tiles count; a desk limited to P2 sees only its cases and those without a customer', async () => {
    const open = await ok(browsers.desk, '/sales/service/cases')
    expect(open.cases.map((row: Json) => row.number)).toEqual(expect.arrayContaining([businessCase.number, 'SVC-SEED-0001', 'SVC-SEED-0002']))
    expect(open.cases.map((row: Json) => row.number)).not.toContain(consumerCase.number)
    expect((await ok(browsers.desk, '/sales/service/cases?view=closed')).cases.map((row: Json) => row.number)).toEqual(expect.arrayContaining([consumerCase.number, 'SVC-SEED-0003']))
    expect((await ok(browsers.desk, '/sales/service/cases?view=all&serial=SEED-SN-0001')).cases.map((row: Json) => row.number)).toEqual([consumerCase.number])
    expect((await ok(browsers.desk, '/sales/service/cases?view=all&cover=LEGAL_GUARANTEE')).cases.map((row: Json) => row.number)).toEqual([consumerCase.number])
    expect((await ok(browsers.desk, `/sales/service/cases?view=all&q=${consumerCase.number}`)).cases).toHaveLength(1)
    const mine = await ok(browsers.desk, '/sales/service/cases?view=mine')
    expect(mine.cases.map((row: Json) => row.number)).toEqual([businessCase.number])
    const page = await ok(browsers.desk, '/sales/service/cases?view=all&limit=2')
    expect(page.cases).toHaveLength(2)
    const next = await ok(browsers.desk, `/sales/service/cases?view=all&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)
    expect(next.cases.map((row: Json) => row.id)).not.toContain(page.cases[0].id)
    const counts = await ok(browsers.desk, '/sales/service/cases/counts')
    expect(counts.tiles).toEqual({ new: 1, waitingCustomer: 0, waitingPart: 0 })
    expect(counts.rows).toMatchObject({ closed: 2, all: 5 })
    const limited = await ok(browsers.limited, '/sales/service/cases?view=all')
    expect(limited.cases.map((row: Json) => row.number)).toEqual(['SVC-SEED-0002'])
    expect((await browsers.limited.get(`/sales/service/cases/${businessCase.id}`)).status).toBe(404)
    expect((await ok(browsers.desk, `/sales/service/cases/people?companyId=${companyA}`)).owners.map((owner: Json) => owner.name)).toEqual(expect.arrayContaining(['desk service 345', 'quality service 345']))
    // REFUSED: a bad filter.
    expect((await browsers.desk.get('/sales/service/cases?status=LOST')).status).toBe(400)
  })

  it('search finds a case by number and serial, never by the customer’s words; the export source reads the list as the person', async () => {
    const [document] = await h.database.withScope(scopeForContext(systemContext(T, newId())), (client) => client.$transaction((tx) => indexer.read(tx, { ids: [consumerCase.id] }, 10)))
    expect(document).toMatchObject({ recordId: consumerCase.id, number: consumerCase.number, partyId: P4, subtitle: 'SEED-SN-0001', status: 'CLOSED' })
    expect(JSON.stringify(document)).not.toContain('collar')
    const page = await exportSource.read(callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), companyId: companyA, requestId: newId(), grants: [{ permissions: ['sales.service.view'], companies: 'all', sites: 'all', parties: 'all' }] } as never), exportSource.query(new URLSearchParams('view=all')), null, 50)
    const row = (page.rows as Json[]).find((entry) => entry.id === consumerCase.id)!
    const words = (code: string) => exportSource.words!.en[code] ?? code
    expect(exportSource.columns.cover!.value(row, words)).toBe('Legal guarantee · Covered')
    expect(exportSource.columns.status!.value(row, words)).toBe('Closed')
    expect(exportSource.columns.serial!.value(row, words)).toBe('SEED-SN-0001')
  })
})
