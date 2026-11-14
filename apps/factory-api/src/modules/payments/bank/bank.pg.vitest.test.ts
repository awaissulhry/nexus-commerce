import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedBank, type BankSeed } from '../../../../../../packages/factory-db/seed/bank'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../../packages/factory-db/seed/receivables'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { suggestionHandlers } from '../matching/suggest'

/**
 * B-W2b-393 — bank statements, matching, the unapplied cash queue and write-offs on the local stack, through the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_bank_bridge_w2b_guards triggers are real), the factory-db seeds of one tenant (company A's account, a camt.053
 * statement with five lines, the tenant-wide write-off tolerance of 1.00), the local file store, test sessions.
 *   FIN-130  a CSV statement uploaded, dry run (NEW, DUPLICATE, ERROR), imported; the same lines again refused; camt.053
 *            and OFX picked by the file's IBAN
 *   FIN-132  suggestions with how sure and why; accept (the payment recorded and placed), choose another (a split), accept a
 *            money-out match, take an acceptance back (the payment voided); the worker's look again after a payment
 *   FIN-117  a payment not placed waits in one queue
 *   FIN-119  a small difference written off at matching and on a payment, within the tolerance; over it refused
 * Every name, number, IBAN (bank and branch code 00000) and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/payments`.
 */

let h: Harness
let app: FastifyInstance
let bank: BankSeed
let receivables: ReceivablesSeed

const NS = 'w2b393-bank-a'
const id = (name: string) => seedUuid(NS, name)
const A = { tenant: id('tenant'), company: id('company:A'), P1: id('party:P1'), P2: id('party:P2'), actor: id('actor') }
const PAYER = 'IT27X0000000000000000370003'
const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const FINANCE: Permission[] = ['payments.view', 'payments.record', 'payments.void', 'payments.writeOff', 'payments.bank.view', 'payments.bank.import', 'payments.bank.match', 'files.upload', 'files.read', 'invoices.view', 'receivables.view', 'receivables.settings.manage', 'payables.view', 'money.price']
const SESSIONS: Record<string, SessionContext> = {
  finance: office(FINANCE),
  viewer: office(['payments.view', 'payments.bank.view', 'money.price']),
  matcher: office(['payments.view', 'payments.bank.view', 'payments.bank.match', 'money.price']),
  blind: office(['payments.view', 'payments.bank.view']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let keys = 0
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b393-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row).map((column) => `"${column}"`).join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}

const TODAY = businessDate(new Date())
const YESTERDAY = businessDate(new Date(Date.now() - 86_400_000))
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`

/** An issued TD01 of P1 (written as the issuing command writes it); answers its id and number. */
async function issuedInvoice(net: number): Promise<{ id: string; number: string }> {
  const invoiceId = randomUUID()
  const vat = Math.round((net * 22) / 100)
  const number = `T-W2B393-${invoiceId.slice(0, 6).toUpperCase()}`
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql('Invoice', { id: invoiceId, companyId: A.company, buyerPartyId: A.P1, docType: 'TD01', priceBasis: 'NET', billTo: BILL_TO, netTotal: net, vatTotal: vat, grossTotal: net + vat, vatSummary: [{ rate: '22.00', nature: null, taxable: net, vat, rounding: 0 }] }))
      await tx.$executeRawUnsafe(...insertSql('InvoiceLine', { id: randomUUID(), invoiceId, buyerPartyId: A.P1, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: `${net / 100}`, netAmount: net, vatRatePct: '22.00' }))
      await tx.$executeRawUnsafe(
        ...insertSql('NumberAllocation', { id: randomUUID(), companyId: A.company, seriesId: receivables.money.invoiceSeriesId, kind: 'INVOICE', value: 500_000 + ++keys, formatted: number, documentDate: YESTERDAY, recordType: 'Invoice', recordId: invoiceId, allocatedAt: new Date().toISOString(), allocatedById: A.actor, requestId: `test-${invoiceId.slice(0, 8)}` }),
      )
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $6::int, "issueDate" = $7::date, "issuedAt" = now(), "issuedById" = $4::uuid, "partyId" = "buyerPartyId", seller = $5::jsonb WHERE id = $1::uuid`,
        invoiceId,
        receivables.money.invoiceSeriesId,
        number,
        A.actor,
        JSON.stringify(SELLER),
        Number(YESTERDAY.slice(0, 4)),
        YESTERDAY,
      )
    }),
  )
  return { id: invoiceId, number }
}

/** A statement file announced, sent and confirmed: answers its file id. */
async function upload(name: string, content: string | Buffer): Promise<string> {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const announced = await ok('finance', 'POST', '/payments/bank/statements/uploads', { companyId: A.company, originalName: name, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }, 201)
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  await ok('finance', 'POST', `/files/${announced.file.id}/complete`)
  return announced.file.id
}

const lineOf = async (lineId: string) => (await ok('finance', 'GET', `/payments/bank/lines/${lineId}`)).line

let accountIban = ''
let invoice1 = { id: '', number: '' }
let invoice2 = { id: '', number: '' }
let csvLines: string[] = []

beforeAll(async () => {
  h = await startHarness('payments_bank')
  // The file store's presigned requests run on the real clock (this test's dates are today's).
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  receivables = await seedReceivables({ db: h.database, namespace: NS })
  bank = await seedBank({ db: h.database, namespace: NS })
  // Every upload and every read of a statement is a call to the (fake) file store: room for this file's many.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  accountIban = (await admin<{ iban: string }>('SELECT iban FROM "BankAccount" WHERE id = $1', [bank.bankAccountIds.companyA]))[0]!.iban
  invoice1 = await issuedInvoice(100000)
  invoice2 = await issuedInvoice(24590)
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const CSV_HEADER = 'Data contabile;Data valuta;Importo;Causale;Ordinante;IBAN ordinante;Riferimento banca'

describe('a CSV statement: upload, dry run, import, the same lines refused (FIN-130)', () => {
  it('the dry run maps the Italian headers and answers NEW and ERROR lines; nothing is written', async () => {
    csvLines = [
      `${dmy(YESTERDAY)};${dmy(YESTERDAY)};1.219,70;Saldo fattura ${invoice1.number};Seed Customer One S.r.l.;${PAYER};BNK-T393-0001`,
      `${dmy(TODAY)};;500,00;Pagamento;Test Walk-in Payer;;BNK-T393-0002`,
      `${dmy(TODAY)};;-12,50;Commissioni bonifico;;;BNK-T393-0003`,
      `;;9,99;Saldo finale;;;`,
    ]
    const fileId = await upload('estratto-conto.csv', [CSV_HEADER, ...csvLines].join('\n'))
    const run = await ok('finance', 'POST', '/payments/bank/statements/dry-run', { fileId, bankAccountId: bank.bankAccountIds.companyA })
    expect(run).toMatchObject({ format: 'CSV', ready: true, account: { id: bank.bankAccountIds.companyA }, counts: { new: 3, duplicate: 0, error: 1 }, totals: { moneyIn: 171970, moneyOut: 1250 }, period: { start: YESTERDAY, end: TODAY } })
    expect(run.mapping.issues).toEqual([])
    expect(run.lines[3]).toMatchObject({ verdict: 'ERROR', problems: [{ code: 'NO_DATE' }] })
    expect((await admin('SELECT id FROM "BankStatement" WHERE "fileId" = $1', [fileId])).length).toBe(0)
    // Lines that cannot be read are imported only when the person says so.
    const unread = await refused('finance', 'POST', '/payments/bank/statements', { fileId, bankAccountId: bank.bankAccountIds.companyA }, 409)
    expect(unread.issues).toEqual([expect.objectContaining({ path: 'import/LINES_UNREADABLE' })])
    const imported = await ok('finance', 'POST', '/payments/bank/statements', { fileId, bankAccountId: bank.bankAccountIds.companyA, skipErrors: true, expectNew: 3 }, 201)
    expect(imported.lineIds).toHaveLength(3)
    expect(imported.suggested).toBeGreaterThan(0)
    const stored = await admin<{ kind: string; retainUntil: Date | null }>('SELECT kind, "retainUntil" FROM "StoredFile" WHERE id = $1', [fileId])
    expect(stored[0]!.kind).toBe('DOCUMENT')
    expect(stored[0]!.retainUntil!.getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 9)
  })

  it('a later file with a line imported before: DUPLICATE in the dry run, only the new one imported; all duplicates refused', async () => {
    const overlap = [CSV_HEADER, csvLines[0]!, `${dmy(TODAY)};;75,00;Rimborso spese;Test Walk-in Payer;;BNK-T393-0004`].join('\n')
    const fileId = await upload('estratto-conto-2.csv', overlap)
    const run = await ok('finance', 'POST', '/payments/bank/statements/dry-run', { fileId, bankAccountId: bank.bankAccountIds.companyA })
    expect(run.counts).toEqual({ new: 1, duplicate: 1, error: 0 })
    expect(run.lines.map((line: Json) => line.verdict)).toEqual(['DUPLICATE', 'NEW'])
    const changed = await refused('finance', 'POST', '/payments/bank/statements', { fileId, bankAccountId: bank.bankAccountIds.companyA, expectNew: 2 }, 409)
    expect(changed.issues[0].path).toBe('import/CHANGED_SINCE_DRY_RUN')
    await ok('finance', 'POST', '/payments/bank/statements', { fileId, bankAccountId: bank.bankAccountIds.companyA, expectNew: 1 }, 201)
    const again = await upload('estratto-conto-3.csv', overlap)
    const none = await refused('finance', 'POST', '/payments/bank/statements', { fileId: again, bankAccountId: bank.bankAccountIds.companyA }, 409)
    expect(none.issues[0].path).toBe('import/NOTHING_NEW')
    expect((await refused('finance', 'POST', '/payments/bank/statements/dry-run', { fileId }, 409)).issues[0].path).toBe('import/FILE_USED')
  })

  it('camt.053 and OFX pick the account by the file’s IBAN; a sheet without an account chosen is refused', async () => {
    const camt = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>T393</MsgId></GrpHdr><Stmt><Id>T393</Id><Acct><Id><IBAN>${accountIban}</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Ntry><Amt Ccy="EUR">33.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${YESTERDAY}</Dt></BookgDt><AcctSvcrRef>CAMT-T393-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Test Walk-in Payer</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Contributo</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`
    const camtFile = await upload('statement.xml', camt)
    const camtRun = await ok('finance', 'POST', '/payments/bank/statements', { fileId: camtFile }, 201)
    expect(camtRun).toMatchObject({ format: 'CAMT053', fileIban: accountIban, account: { id: bank.bankAccountIds.companyA }, counts: { new: 1 } })
    expect((await admin<{ kind: string }>('SELECT kind FROM "StoredFile" WHERE id = $1', [camtFile]))[0]!.kind).toBe('FISCAL_ARCHIVE')
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKACCTFROM><ACCTID>${accountIban}</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>${YESTERDAY.replaceAll('-', '')}<TRNAMT>-4.00<FITID>OFX-T393-1<NAME>Test Bank<MEMO>Canone</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(await ok('finance', 'POST', '/payments/bank/statements', { fileId: await upload('statement.ofx', ofx) }, 201)).toMatchObject({ format: 'OFX', counts: { new: 1 } })
    const sheet = await upload('senza-conto.csv', [CSV_HEADER, `${dmy(TODAY)};;1,00;x;;;BNK-T393-0009`].join('\n'))
    expect((await refused('finance', 'POST', '/payments/bank/statements/dry-run', { fileId: sheet }, 409)).issues[0].path).toBe('import/ACCOUNT_NEEDED')
  })

  it('refusals: importing needs payments.bank.import; amounts travel only with the price grain', async () => {
    await refused('viewer', 'POST', '/payments/bank/statements/dry-run', { fileId: newId() }, 403)
    const tiles = await ok('blind', 'GET', `/payments/bank/lines/counts?companyId=${A.company}`)
    expect(tiles.toMatch).toBeGreaterThan(0)
    const { lines } = await ok('blind', 'GET', `/payments/bank/lines?companyId=${A.company}&limit=5`)
    expect(lines[0].amount).toBeUndefined()
  })
})

describe('matching with how sure and why, the unapplied queue, write-offs (FIN-132, FIN-117, FIN-119)', () => {
  let lineId = ''
  let matchId = ''
  let paymentId = ''

  it('the line quoting the invoice 0.30 short is a HIGH suggestion; accepting it records, places and writes off 0.30', async () => {
    lineId = (await admin<{ id: string }>('SELECT id FROM "BankLine" WHERE "bankReference" = $1', ['BNK-T393-0001']))[0]!.id
    const line = await lineOf(lineId)
    expect(line.state).toBe('TO_MATCH')
    const best = line.suggestions[0]
    expect(best).toMatchObject({ confidence: 'HIGH', partyId: A.P1, items: [{ id: invoice1.id, openAmount: 122000 }], difference: { kind: 'UNDERPAYMENT', amount: 30, writable: true } })
    expect(best.reasons.map((reason: Json) => reason.code)).toEqual(['AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES'])
    expect(best.reasons[1].words).toBe('number in the reference')
    // Recording a payment needs payments.record.
    await refused('matcher', 'POST', `/payments/bank/matches/${best.id}/accept`, { version: best.version }, 403)
    const accepted = await ok('finance', 'POST', `/payments/bank/matches/${best.id}/accept`, { version: best.version, writeOff: { reason: 'ROUNDING' } })
    expect(accepted).toMatchObject({ recorded: true })
    matchId = best.id
    paymentId = accepted.paymentId
    const payment = (await ok('finance', 'GET', `/payments/${paymentId}`)).payment
    expect(payment).toMatchObject({ amount: 121970, externalRef: 'BNK-T393-0001', receivedOn: YESTERDAY, allocated: 121970, unallocated: 0 })
    const open = await ok('finance', 'GET', `/payments/open-items?companyId=${A.company}&partyId=${A.P1}`)
    expect(open.items.find((item: Json) => item.id === invoice1.id)).toBeUndefined()
    const writeOffs = await ok('finance', 'GET', `/payments/${paymentId}/write-offs`)
    expect(writeOffs.writeOffs).toEqual([expect.objectContaining({ kind: 'UNDERPAYMENT', amount: 30, reason: 'ROUNDING', toleranceAmount: 100 })])
    const tab = await ok('finance', 'GET', `/payments/${paymentId}/bank-line`)
    expect(tab).toMatchObject({ recordedByHand: false, line: { id: lineId, counterpartyIban: PAYER, match: { confidence: 'HIGH' } } })
    expect((await lineOf(lineId)).state).toBe('MATCHED')
  })

  it('a person’s own choice places 500.00 on a 300.00 invoice; the 200.00 left waits in the unapplied queue and is over the tolerance', async () => {
    const walkIn = (await admin<{ id: string }>('SELECT id FROM "BankLine" WHERE "bankReference" = $1', ['BNK-T393-0002']))[0]!.id
    const chosen = await ok('finance', 'POST', `/payments/bank/lines/${walkIn}/match`, { partyId: A.P1, items: [{ invoiceId: invoice2.id }] }, 201)
    expect(chosen.recorded).toBe(true)
    const match = (await lineOf(walkIn)).accepted
    expect(match.chosenByPerson).toBe(true)
    expect(match.reasons.map((reason: Json) => reason.code)).toContain('CHOSEN_BY_PERSON')
    const queue = await ok('finance', 'GET', `/payments/unapplied?companyId=${A.company}`)
    const waiting = queue.payments.find((entry: Json) => entry.id === chosen.paymentId)
    expect(waiting).toMatchObject({ unplacedAmount: 20000, writeOffWithinTolerance: false, bankLine: { id: walkIn } })
    expect(queue.totals.count).toBeGreaterThan(0)
    const over = await refused('finance', 'POST', `/payments/${chosen.paymentId}/write-offs`, { kind: 'OVERPAYMENT', reason: 'OTHER', note: 'Test' }, 409)
    expect(over.issues[0].path).toBe('writeOff/OVER_TOLERANCE')
    // The tolerance raised for every company (the accountant's): now it is written off, and taken back again.
    const tolerance = await ok('finance', 'GET', `/payments/write-offs/tolerance?companyId=${A.company}`)
    expect(tolerance.inForce).toEqual({ amount: 100, source: 'TENANT' })
    await ok('finance', 'PUT', '/payments/write-offs/tolerance', { companyId: null, amount: 25000, version: tolerance.tenant.version })
    const written = await ok('finance', 'POST', `/payments/${chosen.paymentId}/write-offs`, { kind: 'OVERPAYMENT', reason: 'OTHER', note: 'Test: kept as agreed' }, 201)
    expect(written.amount).toBe(20000)
    expect((await ok('finance', 'GET', `/payments/unapplied?companyId=${A.company}`)).payments.some((entry: Json) => entry.id === chosen.paymentId)).toBe(false)
    await ok('finance', 'POST', `/payments/${chosen.paymentId}/write-offs/${written.writeOffId}/reverse`, { note: 'Test: refund instead' })
    expect((await ok('finance', 'GET', `/payments/unapplied?companyId=${A.company}`)).payments.some((entry: Json) => entry.id === chosen.paymentId)).toBe(true)
    const back = await ok('finance', 'GET', `/payments/write-offs/tolerance?companyId=${A.company}`)
    await ok('finance', 'PUT', '/payments/write-offs/tolerance', { companyId: null, amount: 100, version: back.tenant.version })
  })

  it('money out: the seeded suggestion of the supplier invoice is accepted without a payment', async () => {
    const line = await lineOf(bank.lineIds.toP2)
    const suggestion = line.suggestions.find((entry: Json) => entry.supplierInvoiceId === bank.supplierInvoiceId)
    expect(suggestion).toBeDefined()
    const accepted = await ok('finance', 'POST', `/payments/bank/matches/${suggestion.id}/accept`, { version: suggestion.version })
    expect(accepted).toMatchObject({ recorded: false, paymentId: null })
    expect((await lineOf(bank.lineIds.toP2)).state).toBe('MATCHED')
  })

  it('a wrong acceptance taken back: its write-off and allocation reversed, the payment voided, the line to match again', async () => {
    const before = (await lineOf(lineId)).accepted
    const reversed = await ok('finance', 'POST', `/payments/bank/matches/${matchId}/reverse`, { version: before.version, reason: 'Test: the wrong customer' })
    expect(reversed).toMatchObject({ voided: true, paymentId })
    expect((await ok('finance', 'GET', `/payments/${paymentId}`)).payment.status).toBe('VOIDED')
    const sums = await admin<{ sum: string }>('SELECT sum(amount)::text AS sum FROM "PaymentWriteOff" WHERE "paymentId" = $1', [paymentId])
    expect(sums[0]!.sum).toBe('0')
    const line = await lineOf(lineId)
    expect(line.state).toBe('TO_MATCH')
    expect(line.reversed).toEqual([expect.objectContaining({ id: matchId, reverseReason: 'Test: the wrong customer' })])
    expect(line.suggestions[0]).toMatchObject({ confidence: 'HIGH', items: [{ id: invoice1.id }] })
    await refused('finance', 'POST', `/payments/bank/matches/${matchId}/reverse`, { version: before.version + 1, reason: 'again' }, 409)
  })

  it('a payment typed by hand pays the invoice: the worker’s look again drops the suggestion naming it', async () => {
    await ok('finance', 'POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 122000, receivedOn: TODAY, externalRef: 'TRN-T393-HAND-1', allocations: [{ invoiceId: invoice1.id }] }, 201)
    const handler = suggestionHandlers()[0]!
    const envelope = { eventId: newId(), type: 'payment.allocated', version: 1, tenantId: A.tenant, companyId: A.company, payload: {} } as never
    await handler.handle(envelope, { caller: callerFor(h.database, systemContext(A.tenant, newId())), attempt: 1 } as never)
    const line = await lineOf(lineId)
    expect(line.suggestions.some((entry: Json) => entry.items.some((item: Json) => item.id === invoice1.id))).toBe(false)
    const tiles = await ok('finance', 'GET', `/payments/bank/lines/counts?companyId=${A.company}`)
    expect(tiles).toMatchObject({ oldAfterDays: 7, lastStatementOn: TODAY })
  })
})
