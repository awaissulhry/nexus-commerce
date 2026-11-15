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
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-W2b-406 — a customer's own figures against ours (FIN-135) on the local stack, through the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_bank_bridge_w2b_guards
 * CustomerStatementFigures guard are real), the factory-db seeds of one tenant (P1's figures of 10 November among them), a
 * made-up customer P8 with one issued invoice written as the issuing command writes it, and test sessions:
 *   the seeded figures listed with our balance as of their day; P8's figures recorded (their order says less than is open,
 *   a payment we never received, their balance) and compared line by line; corrected at the version read; refusals in words
 *   (a day to come, a supplier, a stale version, a file that is not a statement's, no right, no price grain).
 * Every name, number and code is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/receivables/their-figures`.
 */

type Json = Record<string, any>
const NS = 'w2b406-figures'
const key = (name: string) => seedUuid(NS, name)
const ids = { tenant: key('tenant'), companyA: key('company:A'), P1: key('party:P1'), P2: key('party:P2'), P8: newId() }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000008018', name: 'Test Figures Customer S.r.l.', sdiCode: 'TESTC08', address: { street: 'Via di Prova', streetNumber: '8', postcode: '00000', city: 'Prova', province: 'PV', country: 'IT' } }
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01', address: { street: 'Via Finta', streetNumber: '1', postcode: '00000', city: 'Prova', province: 'PV', country: 'IT' } }

const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenant, actorId: newId(), grants })
const finance = templateOf('finance')!
const SESSIONS: Record<string, SessionContext> = {
  finance: office([grant([...finance.permissions, ...finance.grains.map((g) => `money.${g}`)])]),
  /** Reads receivables with prices, types nothing. */
  reader: office([grant(['receivables.view', 'money.price'])]),
  /** May type figures but holds no price grain. */
  blind: office([grant(['receivables.view', 'receivables.theirFigures.manage'])]),
}

let h: Harness
let app: FastifyInstance
let seeded: ReceivablesSeed
let serial = 0
const idem = () => `w2b406-${randomBytes(4).toString('hex')}-${++serial}`
const TODAY = businessDate(new Date())

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
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
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}

/** An issued TD01 of P8 of `gross`, issued ten days ago (written as the issuing command writes it). */
async function issuedInvoice(gross: number): Promise<{ id: string; number: string }> {
  const invoiceId = randomUUID()
  const net = Math.round(gross / 1.22)
  const number = `T-W2B406-${invoiceId.slice(0, 6).toUpperCase()}`
  const issued = addDays(TODAY, -10)
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', { id: invoiceId, companyId: ids.companyA, buyerPartyId: ids.P8, docType: 'TD01', priceBasis: 'NET', billTo: BILL_TO, netTotal: net, vatTotal: gross - net, grossTotal: gross, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat: gross - net, rounding: 0 }], paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: gross, dueDate: TODAY }] } }))
      await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { id: randomUUID(), invoiceId, buyerPartyId: ids.P8, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: `${net / 100}`, netAmount: net, vatRatePct: '22.00' }))
      await tx.$executeRawUnsafe(...insertSql('NumberAllocation', { id: randomUUID(), companyId: ids.companyA, seriesId: seeded.money.invoiceSeriesId, kind: 'INVOICE', value: 800_000 + ++serial, formatted: number, documentDate: issued, recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date().toISOString(), allocatedById: actorId, requestId: `test-${invoiceId.slice(0, 8)}` }))
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $5::int, "issueDate" = $6::date, "issuedAt" = now(), "issuedById" = $7::uuid, "partyId" = "buyerPartyId", seller = $4::jsonb WHERE id = $1::uuid`,
        invoiceId,
        seeded.money.invoiceSeriesId,
        number,
        JSON.stringify(SELLER),
        Number(issued.slice(0, 4)),
        issued,
        actorId,
      )
    }),
  )
  return { id: invoiceId, number }
}

let invoice = { id: '', number: '' }
let recorded: Json = {}

beforeAll(async () => {
  h = await startHarness('figures_406')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedReceivables({ db: h.database, namespace: NS })
  await seedBank({ db: h.database, namespace: NS })
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles, status, country, currency, language) VALUES ($1, $2, 'T406-C8', 'ORGANISATION', 'Test Figures Customer S.r.l.', ARRAY['CUSTOMER']::"PartyRole"[], 'ACTIVE', 'IT', 'EUR', 'it')`, [ids.P8, ids.tenant])
  await h.database.withScope({ audience: 'office', tenantId: ids.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../../', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  invoice = await issuedInvoice(30000)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe("a customer's own figures (FIN-135)", () => {
  it('lists the seeded figures with our balance as of their day; the price grain carries the amounts', async () => {
    const answer = await ok(call('finance', 'GET', `/receivables/their-figures?companyId=${ids.companyA}`))
    const seededRow = answer.figures.find((row: Json) => row.customer.id === ids.P1)
    expect(seededRow).toMatchObject({ asOf: '2026-11-10', currency: 'EUR', theirs: { orders: 1, payments: 1, balance: 21000 }, can: { correct: true }, file: null })
    expect(typeof seededRow.summary.ours).toBe('number')
    expect(seededRow.summary.difference).toBe(21000 - seededRow.summary.ours)
    const one = await ok(call('reader', 'GET', `/receivables/their-figures/${seededRow.id}`))
    expect(one.figures.can.correct).toBe(false)
    expect(one.comparison.orders[0]).toMatchObject({ index: 0, reference: 'Seed order 1 (samples)', theirs: 61000 })
    // Without the price grain: the states, never an amount.
    const blind = await ok(call('blind', 'GET', `/receivables/their-figures/${seededRow.id}`))
    expect(blind.figures.theirs.balance).toBeUndefined()
    expect(blind.comparison.balance.state).toBe(one.comparison.balance.state)
    expect(blind.comparison.orders[0].theirs).toBeUndefined()
  })

  it("records P8's figures and compares them line by line with our books", async () => {
    recorded = await ok(
      call('finance', 'POST', '/receivables/their-figures', {
        companyId: ids.companyA,
        partyId: ids.P8,
        asOf: TODAY,
        figures: { orders: [{ reference: `Fattura ${invoice.number}`, amount: 25000 }], payments: [{ reference: 'TRN never arrived', date: addDays(TODAY, -2), amount: 5000 }], balance: 25000 },
        note: 'Typed from their statement (test).',
      }),
      201,
    )
    expect(recorded.figures).toMatchObject({ customer: { id: ids.P8, code: 'T406-C8' }, asOf: TODAY, currency: 'EUR', theirs: { orders: 1, payments: 1, balance: 25000 }, summary: { ours: 30000, difference: -5000, differences: 3, state: 'DIFFERS' }, version: 1 })
    expect(recorded.comparison.orders).toEqual([
      { index: 0, reference: `Fattura ${invoice.number}`, theirs: 25000, ours: { kind: 'INVOICE', id: invoice.id, number: invoice.number, invoices: [{ id: invoice.id, number: invoice.number, open: 30000 }], open: 30000 }, state: 'DIFFERS', difference: -5000 },
    ])
    expect(recorded.comparison.payments).toEqual([{ index: 0, reference: 'TRN never arrived', date: addDays(TODAY, -2), theirs: 5000, ours: null, foundBy: null, state: 'NOT_FOUND', difference: 5000 }])
    expect(recorded.comparison.balance).toEqual({ theirs: 25000, ours: 30000, difference: -5000, state: 'DIFFERS' })
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'customer_figures.changed' ORDER BY id`, [ids.tenant])
    expect(event!.payload).toEqual({ figuresId: recorded.figures.id, partyId: ids.P8, asOf: TODAY, action: 'RECORDED', orders: 1, payments: 1, fileKept: false })
    const [audit] = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2`, [ids.tenant, recorded.figures.id])
    expect(audit!.action).toBe('receivables.figuresRecord')
  })

  it('corrects a typing mistake at the version read; a stale version is refused', async () => {
    const corrected = await ok(call('finance', 'PATCH', `/receivables/their-figures/${recorded.figures.id}`, { version: 1, figures: { orders: [{ reference: invoice.number, amount: 30000 }], payments: [], balance: 30000 } }))
    expect(corrected.figures).toMatchObject({ version: 2, summary: { ours: 30000, difference: 0, differences: 0, state: 'AGREES' } })
    expect(corrected.comparison.orders[0]).toMatchObject({ state: 'SAME', difference: 0 })
    expect(await refusal(call('finance', 'PATCH', `/receivables/their-figures/${recorded.figures.id}`, { version: 1, note: 'again' }), 409)).toEqual(['body/version'])
  })

  it('refuses in words: a day to come, a supplier, a file that is not a statement’s, no right, no price grain', async () => {
    const body = (over: Json = {}) => ({ companyId: ids.companyA, partyId: ids.P8, asOf: TODAY, figures: { orders: [], payments: [], balance: 0 }, ...over })
    expect(await refusal(call('finance', 'POST', '/receivables/their-figures', body({ asOf: addDays(TODAY, 1) })), 400)).toEqual(['body/asOf'])
    expect(await refusal(call('finance', 'POST', '/receivables/their-figures', body({ partyId: ids.P2 })), 409)).toEqual(['body/partyId'])
    const [statementFile] = await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" = 'BankStatement' LIMIT 1`, [ids.tenant])
    expect(await refusal(call('finance', 'POST', '/receivables/their-figures', body({ fileId: statementFile!.id })), 409)).toEqual(['body/fileId'])
    expect((await call('reader', 'POST', '/receivables/their-figures', body())).statusCode).toBe(403)
    expect((await call('blind', 'POST', '/receivables/their-figures', body())).statusCode).toBe(403)
  })
})
