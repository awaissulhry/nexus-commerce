import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/receivables/ledger'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedBank } from '../../../../../../packages/factory-db/seed/bank'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { runLadderFor } from '../ladder'
import { sendPaymentNotice } from '../notices/customer'
import { trustedPass } from '../reminders/approval'

/**
 * B-W2b-402 — collections on the local stack, through the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the …_bank_bridge_w2b_guards triggers are real), the factory-db
 * seeds of one tenant (company A with its made-up IT account, the tenant-wide ladder −3 / +7 / +30 switched OFF), a made-up
 * customer P9, FAKE mail, the local file store, test sessions and the owner's real browser for step-up.
 *   FIN-126  two MP12 invoices of P9 due yesterday → candidates → a DRAFT batch → the file refused while Ri.Ba. is off →
 *            the Owner's switch (step-up) → the CBI file kept on the batch (16 records of 120 + CR LF) → a reminder held
 *            "Ri.Ba. collecting" → one PAID (its payment recorded and placed), one UNPAID with the fee (open again, the tile)
 *   FIN-112  a promise to pay holds a reminder (the database refuses its approval in words); lifted, it may go
 *   FIN-113  a trusted level (the Owner's, step-up): a ladder e-mail goes by itself only once reminders are on and nothing
 *            holds it, approved by the level (no person), sent on FAKE mail
 *   FIN-128  the payment received notice to who follows the customer (the amount with the grain), the deposit paid to who
 *            releases production; the customer's notice only behind its switch
 * Every name, number, IBAN and code is made up (bank and branch codes 00000). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/receivables`.
 */

type Json = Record<string, any>
const NS = 'w2b402-collections'
const key = (name: string) => seedUuid(NS, name)
// P9: a made-up customer of this file (no money on account, no bank line: its bank is given when the file is made).
const ids = { tenant: key('tenant'), companyA: key('company:A'), P1: key('party:P1'), P9: newId() }
const TENANT: TestTenant = { id: ids.tenant, slug: NS, companies: [{ id: ids.companyA, code: 'A' }] }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000009019', name: 'Test Ri.Ba. Customer S.r.l.', sdiCode: 'TESTC09', address: { street: 'Via di Prova', streetNumber: '2', postcode: '00000', city: 'Prova', province: 'PV', country: 'IT' } }
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01', address: { street: 'Via Finta', streetNumber: '1', postcode: '00000', city: 'Prova', province: 'PV', country: 'IT' } }

const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId: newId(), grants })
const role = templateOf('finance')!
const SESSIONS: Record<string, SessionContext> = {
  finance: office([grant([...role.permissions, ...role.grains.map((g) => `money.${g}`)])]),
  /** Works Ri.Ba. batches, but may not record payments. */
  batcher: office([grant(['receivables.view', 'receivables.riba.manage', 'money.price'])]),
  viewer: office([grant(['receivables.view'])]),
}

let h: Harness
let app: FastifyInstance
let seeded: ReceivablesSeed
let system: CommandCaller
let owner: { browser: Browser; secret: string; id: string }
let serial = 0
const idem = () => `w2b402-${randomBytes(4).toString('hex')}-${++serial}`
const TODAY = businessDate(new Date())
const YESTERDAY = addDays(TODAY, -1)

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refusal = async (response: Promise<LightMyRequestResponse>, status: number): Promise<string[]> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json().error.issues ?? []).map((issue: Json) => issue.path)
}
const asOwner = async (method: 'GET' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const answer = await owner.browser.send(method, url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': idem() } })
  return { status: answer.status, body: answer.body as Json }
}
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const outbox = async (type: string) => admin<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY id`, [ids.tenant, type])

/** An issued TD01 of P9 paid by Ri.Ba. in one instalment due yesterday (written as the issuing command writes it). */
async function ribaInvoice(gross: number): Promise<{ id: string; number: string }> {
  const invoiceId = randomUUID()
  const net = Math.round(gross / 1.22)
  const number = `T-W2B402-${invoiceId.slice(0, 6).toUpperCase()}`
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: owner.id }, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', { id: invoiceId, companyId: ids.companyA, buyerPartyId: ids.P9, docType: 'TD01', priceBasis: 'NET', billTo: BILL_TO, netTotal: net, vatTotal: gross - net, grossTotal: gross, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat: gross - net, rounding: 0 }], paymentTerms: { condition: 'TP02', installments: [{ method: 'MP12', amount: gross, dueDate: YESTERDAY }] } }))
      await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { id: randomUUID(), invoiceId, buyerPartyId: ids.P9, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: `${net / 100}`, netAmount: net, vatRatePct: '22.00' }))
      await tx.$executeRawUnsafe(...insertSql('NumberAllocation', { id: randomUUID(), companyId: ids.companyA, seriesId: seeded.money.invoiceSeriesId, kind: 'INVOICE', value: 700_000 + ++serial, formatted: number, documentDate: addDays(TODAY, -20), recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date().toISOString(), allocatedById: owner.id, requestId: `test-${invoiceId.slice(0, 8)}` }))
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $6::int, "issueDate" = $7::date, "issuedAt" = now(), "issuedById" = $4::uuid, "partyId" = "buyerPartyId", seller = $5::jsonb WHERE id = $1::uuid`,
        invoiceId,
        seeded.money.invoiceSeriesId,
        number,
        owner.id,
        JSON.stringify(SELLER),
        Number(addDays(TODAY, -20).slice(0, 4)),
        addDays(TODAY, -20),
      )
    }),
  )
  return { id: invoiceId, number }
}

let inv1 = { id: '', number: '' }
let inv2 = { id: '', number: '' }
let batch: Json = {}

beforeAll(async () => {
  h = await startHarness('collections_402')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  seeded = await seedReceivables({ db: h.database, namespace: NS })
  await seedBank({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [ids.tenant])
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', address = $2::jsonb WHERE id = $1`, [ids.companyA, JSON.stringify({ line1: 'Via Finta 1', postalCode: '00000', city: 'Prova', province: 'PV', country: 'IT' })])
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, status, country, currency, language) VALUES ($1, $2, 'T402-C9', 'ORGANISATION', 'Test Ri.Ba. Customer S.r.l.', ARRAY['CUSTOMER']::"PartyRole"[], 'ACTIVE', 'IT', 'EUR', 'it')`, [ids.P9, ids.tenant])
  await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, roles, status) VALUES ($1, $2, $3, 'Test Accounts Nine', 'accounts.t402@example.com', ARRAY['INVOICES']::"PartyContactRole"[], 'ACTIVE')`, [newId(), ids.tenant, ids.P9])
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const user = await addUser(h, TENANT, { email: `owner-${randomBytes(3).toString('hex')}@example.test`, role: 'owner' })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`owner sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  owner = { browser, secret: await enrolTotp(h, browser), id: user.id }
  system = callerFor(h.database, systemContext(ids.tenant, `collections-test-${newId()}`))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  inv1 = await ribaInvoice(30000)
  inv2 = await ribaInvoice(20000)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('Ri.Ba. collections (FIN-126)', () => {
  it('lists the open MP12 instalments due in the window; the customer’s bank is not known yet', async () => {
    const answer = await ok(call('finance', 'GET', `/receivables/riba/candidates?companyId=${ids.companyA}&dueFrom=${addDays(TODAY, -5)}&dueTo=${TODAY}`))
    const mine = answer.candidates.filter((entry: Json) => [inv1.id, inv2.id].includes(entry.invoice.id))
    expect(mine.map((entry: Json) => [entry.invoice.number, entry.instalment, entry.amount, entry.dueDate])).toEqual([
      [inv1.number, 1, 30000, YESTERDAY],
      [inv2.number, 1, 20000, YESTERDAY],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    expect(mine[0].debtorBank).toBeNull()
    expect(mine[0].held).toBeNull()
    // Without the price grain: no amount.
    const blind = await ok(call('viewer', 'GET', `/receivables/riba/candidates?companyId=${ids.companyA}&dueFrom=${addDays(TODAY, -5)}&dueTo=${TODAY}`))
    expect(blind.candidates.find((entry: Json) => entry.invoice.id === inv1.id).amount).toBeUndefined()
  })

  it('a DRAFT batch of the window; its file refused while Ri.Ba. is off; the Owner’s switch asks a fresh step-up', async () => {
    batch = (await ok(call('finance', 'POST', '/receivables/riba/batches', { companyId: ids.companyA, dueFrom: addDays(TODAY, -5), dueTo: TODAY, items: [{ invoiceId: inv1.id, instalment: 1 }, { invoiceId: inv2.id, instalment: 1 }] }), 201)).batch
    expect(batch).toMatchObject({ status: 'DRAFT', count: 2, total: 50000, switchOn: false, can: { pick: true, issue: false, cancel: true, settle: false }, rule: { status: 'UNVERIFIED' } })
    // The same instalment in another batch is refused.
    expect(await refusal(call('finance', 'POST', '/receivables/riba/batches', { companyId: ids.companyA, dueFrom: addDays(TODAY, -5), dueTo: TODAY, items: [{ invoiceId: inv1.id, instalment: 1 }] }), 400)).toEqual(['body/items/0/IN_ANOTHER_BATCH'])
    expect(await refusal(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/issue`, { version: batch.version, siaCode: 'A0000' }), 409)).toEqual(['riba/SWITCHED_OFF'])
    const before = await ok(call('finance', 'GET', '/receivables/collections/settings'))
    expect(before).toMatchObject({ source: 'TENANT', ribaOn: false, paymentNoticeToCustomerOn: false, mayChange: false })
    expect((await call('finance', 'PUT', '/receivables/collections/settings', { companyId: null, ribaOn: true, version: before.version })).statusCode).toBe(403)
    const noStepUp = await asOwner('PUT', '/receivables/collections/settings', { companyId: null, ribaOn: true, version: before.version })
    expect([noStepUp.status, noStepUp.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    await stepUp(h, owner.browser, owner.secret)
    const on = await asOwner('PUT', '/receivables/collections/settings', { companyId: null, ribaOn: true, version: before.version })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body).toMatchObject({ source: 'TENANT', ribaOn: true, paymentNoticeToCustomerOn: false })
    expect((await outbox('collections_settings.changed')).map((event) => event.payload)).toEqual([expect.objectContaining({ ribaOn: true, paymentNoticeToCustomerOn: false })])
  })

  it('makes the CBI file and keeps it on the batch: ISSUED, a file a person downloads', async () => {
    // The customer's bank is needed: refused in words, each receipt at its path, until it is given.
    expect(await refusal(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/issue`, { version: batch.version, siaCode: 'A0000' }), 400)).toEqual(['items/0/NO_DEBTOR_BANK', 'items/1/NO_DEBTOR_BANK'])
    const issued = (await ok(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/issue`, { version: batch.version, siaCode: 'a0000', banks: [{ partyId: ids.P9, abi: '00000', cab: '00000', name: 'Banca di Prova' }] }))).batch
    expect(issued).toMatchObject({ status: 'ISSUED', can: { pick: false, issue: false, cancel: false, settle: true }, settled: { paid: 0, unpaid: 0, waiting: 2 } })
    expect(issued.items[0].debtorBank).toBeNull()
    const [file] = await admin<{ recordType: string; recordId: string; contentType: string; sizeBytes: number; kind: string; retainUntil: Date }>(`SELECT "recordType", "recordId", "contentType", "sizeBytes", kind::text AS kind, "retainUntil" FROM "StoredFile" WHERE id = $1`, [issued.file.id])
    expect(file).toMatchObject({ recordType: 'RibaBatch', recordId: batch.id, contentType: 'text/plain', kind: 'ATTACHMENT', sizeBytes: 16 * 122 })
    expect(file!.retainUntil.getUTCFullYear()).toBe(Number(TODAY.slice(0, 4)) + 10)
    expect((await outbox('riba_batch.changed')).map((event) => event.payload.action)).toEqual(['CREATED', 'ISSUED'])
    batch = issued
    // An issued batch never changes.
    expect(await refusal(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/cancel`, { version: batch.version, reason: 'Test' }), 409)).toEqual(['riba/NOT_DRAFT'])
  })

  it('holds a reminder of an instalment the bank is collecting', async () => {
    const prepared = (await ok(call('finance', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P9, invoiceIds: [inv1.id] }), 201)).reminder
    expect(prepared.held.map((entry: Json) => entry.code)).toContain('RIBA_IN_COLLECTION')
    expect(prepared.trusted).toEqual({ level: null, goesByItself: false, approvedByLevel: false })
    await ok(call('finance', 'POST', `/receivables/reminders/${prepared.id}/cancel`, { version: prepared.version, reason: 'Test: collected by Ri.Ba.' }))
  })

  it('settles: one PAID (its payment recorded and placed), one UNPAID with the bank’s fee (the invoice open again)', async () => {
    const [item1, item2] = [batch.items.find((item: Json) => item.invoice.id === inv1.id), batch.items.find((item: Json) => item.invoice.id === inv2.id)]
    // Recording a payment needs payments.record.
    expect((await call('batcher', 'POST', `/receivables/riba/batches/${batch.id}/settle`, { version: batch.version, items: [{ itemId: item1.id, status: 'PAID', settledOn: TODAY }] })).statusCode).toBe(403)
    expect(await refusal(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/settle`, { version: batch.version, items: [{ itemId: item2.id, status: 'UNPAID', settledOn: TODAY }] }), 400)).toEqual(['body/items/0/FEE_NEEDED'])
    const settled = (await ok(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/settle`, { version: batch.version, items: [{ itemId: item1.id, status: 'PAID', settledOn: TODAY }, { itemId: item2.id, status: 'UNPAID', settledOn: TODAY, unpaidFee: 350 }] }))).batch
    const [paid, unpaid] = [settled.items.find((item: Json) => item.id === item1.id), settled.items.find((item: Json) => item.id === item2.id)]
    expect(paid).toMatchObject({ status: 'PAID', settledOn: TODAY, invoiceOpen: 0, unpaidFee: null })
    expect(unpaid).toMatchObject({ status: 'UNPAID', settledOn: TODAY, unpaidFee: 350, invoiceOpen: 20000, paymentId: null })
    const [payment] = await admin<{ amount: number; externalRef: string; method: string }>(`SELECT amount, "externalRef", method::text AS method FROM "Payment" WHERE id = $1`, [paid.paymentId])
    expect(payment).toEqual({ amount: 30000, externalRef: `RIBA-${item1.id.toUpperCase()}`, method: 'BANK_TRANSFER' })
    expect(settled.settled).toEqual({ paid: 1, unpaid: 1, waiting: 0 })
    expect((await outbox('riba_item.settled')).map((event) => event.payload.status).sort()).toEqual(['PAID', 'UNPAID'])
    // Settled once.
    expect(await refusal(call('finance', 'POST', `/receivables/riba/batches/${batch.id}/settle`, { version: settled.version, items: [{ itemId: item1.id, status: 'UNPAID', settledOn: TODAY, unpaidFee: 0 }] }), 400)).toEqual(['body/items/0/SETTLED'])
    // The tile "Ri.Ba. unpaid": the returned instalment, open again, with its fee; a new window offers it again.
    const unpaidList = await ok(call('finance', 'GET', `/receivables/riba/unpaid?companyId=${ids.companyA}`))
    expect(unpaidList.tiles).toEqual([{ currency: 'EUR', count: 1, open: 20000, fees: 350 }])
    expect(unpaidList.items[0]).toMatchObject({ invoice: { id: inv2.id }, unpaidFee: 350, invoiceOpen: 20000 })
    const again = await ok(call('finance', 'GET', `/receivables/riba/candidates?companyId=${ids.companyA}&dueFrom=${addDays(TODAY, -5)}&dueTo=${TODAY}`))
    expect(again.candidates.filter((entry: Json) => [inv1.id, inv2.id].includes(entry.invoice.id)).map((entry: Json) => entry.invoice.id)).toEqual([inv2.id])
  })
})

describe('reminder stops (FIN-112)', () => {
  let stop: Json = {}
  let reminder: Json = {}

  it('a promise to pay holds a reminder: shown held, its approval refused in words; lifted, it may go', async () => {
    expect(await refusal(call('finance', 'POST', '/receivables/stops', { invoiceId: inv2.id, reason: 'PROMISE_TO_PAY' }), 400)).toEqual(['body/until'])
    stop = (await ok(call('finance', 'POST', '/receivables/stops', { invoiceId: inv2.id, reason: 'PROMISE_TO_PAY', until: addDays(TODAY, 7), note: 'Test: the customer promised a transfer.' }), 201)).stop
    expect(stop).toMatchObject({ state: 'holding', reason: 'PROMISE_TO_PAY', reasonWords: { en: 'Promise to pay' }, can: { change: true, lift: true } })
    expect(await refusal(call('finance', 'POST', '/receivables/stops', { invoiceId: inv2.id, reason: 'PROMISE_TO_PAY', until: addDays(TODAY, 3) }), 409)).toEqual(['stop/SAME_STOP'])
    reminder = (await ok(call('finance', 'POST', '/receivables/reminders', { companyId: ids.companyA, partyId: ids.P9, invoiceIds: [inv2.id] }), 201)).reminder
    expect(reminder.held.map((entry: Json) => entry.code)).toContain('STOP_PROMISE_TO_PAY')
    expect((await ok(call('finance', 'GET', `/receivables/stops?invoiceId=${inv2.id}`))).stops[0].holdsReminders).toEqual([reminder.id])
    expect(await refusal(call('finance', 'POST', `/receivables/reminders/${reminder.id}/approve`, { version: reminder.version, send: false }), 409)).toEqual(['receivables/REMINDER_STOPPED'])
    const lifted = (await ok(call('finance', 'POST', `/receivables/stops/${stop.id}/lift`, { version: stop.version, reason: 'Test: the promise was withdrawn.' }))).stop
    expect(lifted).toMatchObject({ state: 'lifted', liftReason: 'Test: the promise was withdrawn.', can: { change: false, lift: false } })
    expect(await refusal(call('finance', 'PATCH', `/receivables/stops/${stop.id}`, { version: lifted.version, note: 'Again' }), 409)).toEqual(['stop/LIFTED'])
    const view = (await ok(call('finance', 'GET', `/receivables/reminders/${reminder.id}`))).reminder
    expect(view.held.map((entry: Json) => entry.code)).not.toContain('STOP_PROMISE_TO_PAY')
    expect((await outbox('reminder_stop.changed')).map((event) => event.payload.action)).toEqual(['ADDED', 'LIFTED'])
    await ok(call('finance', 'POST', `/receivables/reminders/${reminder.id}/cancel`, { version: view.version, reason: 'Test: the ladder prepares its own.' }))
  })
})

describe('trusted levels (FIN-113)', () => {
  it('a ladder e-mail goes by itself only once reminders are on and nothing holds it, approved by the level', async () => {
    const scope = { companyId: ids.companyA, partyId: ids.P9 }
    const outcome = await runLadderFor(system, scope, { prepare: true })
    const [prepared] = await admin<{ id: string; level: number; action: string; invoiceIds: string[] }>(`SELECT id, level, action::text AS action, "invoiceIds" FROM "PaymentReminder" WHERE id = ANY($1::uuid[]) AND $2::uuid = ANY("invoiceIds")`, [outcome?.prepared ?? [], inv2.id])
    expect(prepared).toMatchObject({ level: 1, action: 'EMAIL' })
    const party = await ok(call('finance', 'GET', `/receivables/customers/${ids.P9}/trust`))
    expect(party).toMatchObject({ level: null, mayChange: false })
    // The Owner's: step-up for a level (fresh since the switch above).
    const trusted = await asOwner('PUT', `/receivables/customers/${ids.P9}/trust`, { version: party.customer.version, level: 1 })
    expect(trusted.status, JSON.stringify(trusted.body)).toBe(200)
    expect(trusted.body).toMatchObject({ level: 1, words: { en: expect.stringContaining('level 1') } })
    // Reminders are off (the Owner's switch): it waits, shown held.
    expect(await trustedPass(system, scope, `trusted-test-${newId()}`)).toEqual([])
    const waiting = (await ok(call('finance', 'GET', `/receivables/reminders/${prepared!.id}`))).reminder
    expect(waiting).toMatchObject({ status: 'PREPARED', trusted: { level: 1, goesByItself: false, approvedByLevel: false } })
    expect(waiting.held.map((entry: Json) => entry.code)).toContain('SWITCHED_OFF')
    // Reminders on: the rule decided (NONE, made up) and the Owner's switch.
    const settings = await ok(call('finance', 'GET', '/receivables/settings'))
    await ok(call('finance', 'PUT', '/receivables/settings', { companyId: null, version: settings.tenant.version, ladder: settings.tenant.ladder.map((step: Json) => ({ offsetDays: step.offsetDays, action: step.action, template: step.template })), lateInterestMode: 'NONE', recoveryChargeAmount: null, minimumAmount: null }))
    const tenantNow = (await ok(call('finance', 'GET', '/receivables/settings'))).tenant
    expect((await asOwner('PUT', '/receivables/settings/switch', { companyId: null, on: true, version: tenantNow.version })).status).toBe(200)
    expect((await ok(call('finance', 'GET', `/receivables/reminders/${prepared!.id}`))).reminder.trusted.goesByItself).toBe(true)
    expect(await trustedPass(system, scope, `trusted-test-${newId()}`)).toEqual([prepared!.id])
    const [row] = await admin<{ status: string; approvedById: string; sentAt: Date | null }>(`SELECT status::text AS status, "approvedById", "sentAt" FROM "PaymentReminder" WHERE id = $1`, [prepared!.id])
    expect(row).toMatchObject({ status: 'SENT', approvedById: SYSTEM_ACTOR_ID })
    const [mail] = await admin<{ to: string[]; status: string }>(`SELECT "to", status::text AS status FROM "EmailOutbound" WHERE "recordType" = 'PaymentReminder' AND "recordId" = $1`, [prepared!.id])
    expect(mail).toMatchObject({ to: ['accounts.t402@example.com'], status: 'QUEUED' })
    expect((await ok(call('finance', 'GET', `/receivables/reminders/${prepared!.id}`))).reminder.trusted).toEqual({ level: 1, goesByItself: false, approvedByLevel: true })
    expect((await outbox('reminder_trust.changed')).map((event) => event.payload)).toEqual([{ partyId: ids.P9, level: 1 }])
    // Done: reminders off again (nothing else of this file reaches a customer by itself).
    const after = (await ok(call('finance', 'GET', '/receivables/settings'))).tenant
    expect((await asOwner('PUT', '/receivables/settings/switch', { companyId: null, on: false, version: after.version })).status).toBe(200)
  })
})

describe('payment received notices (FIN-128)', () => {
  it('tells who follows the customer (the amount with the grain) and who releases production; the customer only behind its switch', async () => {
    const [ribaPayment] = await admin<{ id: string }>(`SELECT id FROM "Payment" WHERE "tenantId" = $1 AND "externalRef" LIKE 'RIBA-%'`, [ids.tenant])
    await admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'Party', $3, $4, 'CHOSE')`, [newId(), ids.tenant, ids.P9, owner.id])
    const [recorded] = (await outbox('payment.recorded')).filter((event) => event.payload.paymentId === ribaPayment!.id)
    expect(await fanOut(system, { eventId: recorded!.id, type: 'payment.recorded', payload: recorded!.payload } as never)).toBe(1)
    const [received] = await admin<{ messageKey: string; params: Json; recordType: string }>(`SELECT "messageKey", params, "recordType" FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "messageKey" = 'notifications.payments.received'`, [ids.tenant, owner.id])
    expect(received).toMatchObject({ recordType: 'Payment', params: { paymentId: ribaPayment!.id, netAmount: { $money: 'price', value: { minor: 30000, currency: 'EUR' } } } })
    // The seeded deposit (PAID) told as if just paid: who releases work orders hears production may start.
    const [allocation] = await admin<{ depositRequestId: string }>(`SELECT "depositRequestId" FROM "PaymentAllocation" WHERE id = $1`, [seeded.money.depositAllocationId])
    const depositEvent = { eventId: newId(), type: 'payment.deposit_paid', payload: { depositRequestId: allocation!.depositRequestId, partyId: ids.P1, orderId: null } }
    expect(await fanOut(system, depositEvent as never)).toBeGreaterThanOrEqual(1)
    expect(await admin(`SELECT 1 FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "messageKey" = 'notifications.payments.depositPaid'`, [ids.tenant, owner.id])).toHaveLength(1)
    // The customer's notice: held while the switch is off; on (step-up), e-mailed once.
    expect(await sendPaymentNotice(system, ribaPayment!.id)).toEqual({ outboundId: null, held: 'SWITCHED_OFF' })
    await stepUp(h, owner.browser, owner.secret)
    const current = (await asOwner('GET', '/receivables/collections/settings')).body
    const on = await asOwner('PUT', '/receivables/collections/settings', { companyId: null, paymentNoticeToCustomerOn: true, version: current.version })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    const sent = await sendPaymentNotice(system, ribaPayment!.id, `payment-notice:${ribaPayment!.id}`)
    expect(sent.held).toBeNull()
    const [mail] = await admin<{ to: string[]; subject: string; recordType: string }>(`SELECT "to", subject, "recordType" FROM "EmailOutbound" WHERE id = $1`, [sent.outboundId])
    expect(mail).toMatchObject({ to: ['accounts.t402@example.com'], recordType: 'Party', subject: expect.stringMatching(/^Pagamento ricevuto - /) })
    expect((await outbox('payment.receipt_sent')).map((event) => event.payload)).toEqual([{ paymentId: ribaPayment!.id, partyId: ids.P9, outboundId: sent.outboundId }])
    // A repeat of the handler's key sends nothing twice.
    expect((await sendPaymentNotice(system, ribaPayment!.id, `payment-notice:${ribaPayment!.id}`)).outboundId).toBe(sent.outboundId)
  })
})
