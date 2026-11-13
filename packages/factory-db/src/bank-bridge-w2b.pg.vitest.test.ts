import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedBank, type BankSeed } from '../seed/bank'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Bank, receivables, payables and the accountant's bridge (W2b-6, schema wave 50/57, B-W2b-370, …_bank_bridge_w2b_guards) on a
 * database built from the migrations and seeded twice, through the real login and the scoped client:
 *   - a company's own bank accounts (the IBAN's check digits, one live per IBAN, never deleted), statement files and lines (what
 *     the bank said never changes; a line imported twice is refused);
 *   - matches (money in: the customer's items or a payment typed by hand; money out: one supplier invoice; accepted once with its
 *     payment, reversed after the payment is voided; one live acceptance per line and per payment);
 *   - write-offs within the company's tolerance, counted by the allocation, refund and void rules; append-only;
 *   - Ri.Ba. batches issued only behind the company's switch, their instalments once, settled after their due day;
 *   - reminder stops that hold a reminder's approval, the customer's own figures;
 *   - payment proposals approved by someone who did not make it, to the supplier's ACTIVE account only;
 *   - account mappings fixed from their first day, documents handed over once, integrity check runs append-only;
 *   - none of it read by the floor or a portal.
 * The refusals are check_violation (23514) in words, or a unique key (23505); their messages are read through raw SQL.
 */

const NS = 'w2b-370-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: BankSeed
let memberId: string

const key = (name: string): string => seedUuid(NS, name)
const COMPANY_A = key('company:A')
const P1 = key('party:P1')
const P2 = key('party:P2')
const P3 = key('party:P3')
const INVOICE_SERIES = key('series:A:INVOICE:MAIN:2026')
const STORE = key('files:account:r2')
/** Company A's ACCOUNTING_EXPORT series (the numbering seed's id: eight f's). */
const EXPORT_SERIES = `ffffffff${key('series:A:ACCOUNTING_EXPORT:MAIN:2026').slice(8)}`
/** Made-up IBANs: bank and branch code 00000 (no real bank). */
const IBAN = { free: 'IT70X0000000000000000370102', other: 'IT16X0000000000000000370201' } as const

const office = (actorId?: string): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: actorId ?? a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[0]!.id })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: P1 })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** `INSERT INTO "<table>" (<the row's columns>) …`: the columns it leaves out take their defaults (tenantId too). */
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
/** INSERT a copy of row `id` of `table` with `changes`. */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (): string => randomUUID().slice(0, 8)
const today = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
let counter = 0

/** A file of `recordType` (a copy of the statement's file). */
async function fileOf(recordType: string, recordId: string): Promise<string> {
  const fileId = randomUUID()
  expect(await copyRow(office(), 'StoredFile', s.statementFileId, { id: fileId, recordType, recordId, storageKey: `test/${fileId}` })).toBe(1)
  return fileId
}
/** A payment of `party` to company A (as W1 records one). */
async function payment(amount: number, party = P1): Promise<string> {
  const id = randomUUID()
  expect(await insert(office(), 'Payment', { id, companyId: COMPANY_A, partyId: party, amount, receivedOn: '2026-11-11', externalRef: `TRN-${tag()}` })).toBe(1)
  return id
}
const allocate = (paymentId: string, invoiceId: string, amount: number, party = P1, extra: Record<string, unknown> = {}) =>
  insert(office(), 'PaymentAllocation', { id: randomUUID(), companyId: COMPANY_A, partyId: party, paymentId, invoiceId, amount, ...extra })
/**
 * An issued TD01 of company A to P1 (net 100.00 + 22%), its payment terms one instalment of the gross due on `due`, issued as the
 * issuing command does (the number from the series, its NumberAllocation, the XML).
 */
async function issuedInvoice(due: string): Promise<string> {
  const id = randomUUID()
  const number = `T-${tag()}-${++counter}`
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      const exec = (table: string, row: Record<string, unknown>) => tx.$executeRawUnsafe(...insertSql(table, row))
      await exec('Invoice', {
        id,
        companyId: COMPANY_A,
        buyerPartyId: P1,
        docType: 'TD01',
        billTo: { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' },
        netTotal: 10000,
        vatTotal: 2200,
        grossTotal: 12200,
        vatSummary: [{ rate: '22.00', nature: null, taxable: 10000, vat: 2200, rounding: 0 }],
        paymentTerms: { condition: 'TP02', installments: [{ method: 'MP12', amount: 12200, dueDate: due }] },
      })
      await exec('InvoiceLine', { id: randomUUID(), invoiceId: id, buyerPartyId: P1, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: '100.000000', netAmount: 10000, vatRatePct: '22.00' })
      await exec('NumberAllocation', {
        id: randomUUID(), companyId: COMPANY_A, seriesId: INVOICE_SERIES, kind: 'INVOICE', value: 200_000 + counter, formatted: number, documentDate: '2026-11-02',
        recordType: 'Invoice', recordId: id, allocatedAt: new Date().toISOString(), allocatedById: a.actorId, requestId: `test-${tag()}`,
      })
      const xml = randomUUID()
      await exec('StoredFile', {
        id: xml, companyId: COMPANY_A, recordType: 'Invoice', recordId: id, kind: 'FISCAL_ARCHIVE', originalName: `IT00000003038_${tag()}.xml`, contentType: 'application/xml',
        sizeBytes: 2048, sha256: 'b'.repeat(64), storeAccountId: STORE, storageKey: `legal/t/${a.tenantId}/c/${COMPANY_A}/2026/${randomUUID()}`, status: 'AVAILABLE',
        availableAt: new Date().toISOString(), retainUntil: '2037-01-01T00:00:00.000Z',
      })
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = 2026, "issueDate" = '2026-11-02'::date, "issuedAt" = now(),
           "issuedById" = $4::uuid, "partyId" = "buyerPartyId", seller = $5::jsonb, "xmlFileId" = $6::uuid WHERE id = $1::uuid`,
        id, INVOICE_SERIES, number, a.actorId, JSON.stringify({ vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }), xml,
      )
    }),
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('bankbridgew2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  memberId = (await seedAuth({ db: factory, namespace: NS })).memberId
  s = await seedBank({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedBank({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe("a company's own bank accounts (FIN-130)", () => {
  it("start from the company's bank columns, hold their IBAN's check digits, one live per IBAN, never deleted", async () => {
    const [company] = await sql(office(), `SELECT "bankAccountHolder", iban FROM "Company" WHERE id = $1::uuid`, COMPANY_A)
    expect(await sql(office(), `SELECT holder, iban, active FROM "BankAccount" WHERE id = $1::uuid`, s.bankAccountIds.companyA)).toEqual([{ holder: company!.bankAccountHolder, iban: company!.iban, active: true }])
    const account = (changes: Record<string, unknown>) => copyRow(office(), 'BankAccount', s.bankAccountIds.oldA, { id: randomUUID(), ...changes })
    await expect(account({ iban: 'IT00X0000000000000000370102' })).rejects.toThrow(/is not an IBAN whose check digits hold/)
    await expect(account({ bic: 'seed' })).rejects.toThrow(/is not a BIC/)
    await expect(account({ holder: 'two\nlines' })).rejects.toThrow(/names its holder/)
    await expect(account({ iban: company!.iban, active: true })).rejects.toThrow(/BankAccount_one_live_iban/)
    const id = randomUUID()
    expect(await copyRow(office(), 'BankAccount', s.bankAccountIds.oldA, { id, iban: IBAN.free, active: true })).toBe(1)
    await expect(update(office(), 'BankAccount', id, `iban = $2`, IBAN.other)).rejects.toThrow(/company, IBAN, currency and creation of bank account .* never change/)
    expect(await update(office(), 'BankAccount', id, `active = false, "bankName" = 'Seed bank (closed)', version = version + 1`)).toBe(1)
    await expect(admin(`DELETE FROM "BankAccount" WHERE id = $1::uuid`, [id])).rejects.toThrow(/kept, never deleted/)
  })
})

describe('statements and their lines (FIN-130)', () => {
  it('are what the bank said: imported into a live account, never changed; a line imported twice is refused', async () => {
    const statement = (changes: Record<string, unknown>) => copyRow(office(), 'BankStatement', s.statementId, { id: randomUUID(), ...changes })
    await expect(statement({ bankAccountId: s.bankAccountIds.oldA })).rejects.toThrow(/is switched off; no statement is imported into it/)
    await expect(statement({ periodEnd: '2099-01-01' })).rejects.toThrow(/its last is not after today/)
    await expect(statement({ fileId: await fileOf('RibaBatch', randomUUID()) })).rejects.toThrow(/not a file of the company kept for a bank statement/)
    // The office has no UPDATE grant; the owner meets the trigger.
    await expect(update(office(), 'BankStatement', s.statementId, `format = 'CSV'`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "BankStatement" SET format = 'CSV' WHERE id = $1::uuid`, [s.statementId])).rejects.toThrow(/is what the bank said; it never changes/)
    const line = (changes: Record<string, unknown>) => copyRow(office(), 'BankLine', s.lineIds.unplaced, { id: randomUUID(), fingerprint: `test:${tag()}`, ...changes })
    await expect(line({ amount: 0 })).rejects.toThrow(/an amount other than 0/)
    await expect(line({ bookedOn: '2026-10-01' })).rejects.toThrow(/outside its statement's days/)
    await expect(line({ currency: 'USD' })).rejects.toThrow(/is in USD, its account in EUR/)
    await expect(line({ fingerprint: 'has spaces' })).rejects.toThrow(/fingerprint .* without spaces/)
    await expect(line({ counterpartyIban: 'it 12' })).rejects.toThrow(/IBAN upper case without spaces/)
    const [{ fingerprint }] = (await sql(office(), `SELECT fingerprint FROM "BankLine" WHERE id = $1::uuid`, s.lineIds.sample)) as [{ fingerprint: string }]
    await expect(line({ fingerprint })).rejects.toThrow(/BankLine_tenantId_bankAccountId_fingerprint_key/)
    await expect(admin(`UPDATE "BankLine" SET "referenceText" = 'changed' WHERE id = $1::uuid`, [s.lineIds.unplaced])).rejects.toThrow(/is what the bank said; it never changes/)
    await expect(admin(`DELETE FROM "BankLine" WHERE id = $1::uuid`, [s.lineIds.unplaced])).rejects.toThrow(/kept, never deleted/)
  })

  it('are the office\'s only', async () => {
    for (const table of ['BankAccount', 'BankStatement', 'BankLine', 'BankMatch', 'PaymentWriteOff', 'RibaBatch', 'PaymentProposal', 'AccountMapping', 'IntegrityCheckRun']) {
      await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
      await expect(sql(partner(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    await expect(sql(partner(), `SELECT "reminderTrustedLevel" FROM "Party" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })
})

describe('matches (FIN-132, FIN-117)', () => {
  const suggest = (changes: Record<string, unknown>) => copyRow(office(), 'BankMatch', s.matchIds.sample, { id: randomUUID(), version: 1, ...changes })

  it('name the customer\'s items or a payment for money in, one supplier invoice for money out', async () => {
    await expect(suggest({ supplierInvoiceId: s.supplierInvoiceId, partyId: P2, invoiceIds: [] })).rejects.toThrow(/is for money in: it names the customer's open items/)
    await expect(suggest({ invoiceIds: [] })).rejects.toThrow(/is for money in/)
    await expect(suggest({ invoiceIds: [s.sampleInvoiceId, s.sampleInvoiceId] })).rejects.toThrow(/names each invoice and deposit request once/)
    await expect(suggest({ invoiceIds: [s.depositInvoiceId] })).rejects.toThrow(/is not an issued TD01 or TD24 of the company to the party/)
    await expect(suggest({ reasons: [] })).rejects.toThrow(/says why: at least one reason/)
    await expect(suggest({ bankLineId: s.lineIds.toP2 })).rejects.toThrow(/is for money out: it names the one supplier invoice/)
    await expect(suggest({ paymentId: s.onAccountPaymentId, invoiceIds: [] })).rejects.toThrow(/is RECEIVED for 40000 EUR; the payment of a bank line is RECEIVED for the line's 41000 EUR/)
    expect(await suggest({ invoiceIds: [s.sampleInvoiceId], confidence: 'LOW' })).toBe(1)
  })

  it('are accepted once with the payment, one per line and per payment, reversed after the payment is voided; only a suggestion is deleted', async () => {
    const pending = randomUUID()
    expect(await suggest({ id: pending })).toBe(1)
    await expect(update(office(), 'BankMatch', pending, `"acceptedAt" = now(), "acceptedById" = $2::uuid`, a.actorId)).rejects.toThrow(/accepted with the payment it recorded/)
    await expect(update(office(), 'BankMatch', pending, `"paymentId" = $2::uuid`, s.onAccountPaymentId)).rejects.toThrow(/is named with its acceptance/)
    await expect(update(office(), 'BankMatch', pending, `confidence = 'LOW'`)).rejects.toThrow(/what match .* suggests .* never changes/)
    // The line's money recorded as a payment of P1 and placed (as B-W2b-393's acceptance does), then the match accepted with it.
    const paid = await payment(41000)
    expect(await allocate(paid, s.sampleInvoiceId, 41000)).toBe(1)
    expect(await update(office(), 'BankMatch', pending, `"acceptedAt" = now(), "acceptedById" = $2::uuid, "paymentId" = $3::uuid, version = 2`, a.actorId, paid)).toBe(1)
    await expect(update(office(), 'BankMatch', pending, `"acceptedById" = $2::uuid`, memberId)).rejects.toThrow(/is accepted; who accepted it, when and its payment never change/)
    // One live acceptance per line; a suggestion of an accepted line stays a suggestion.
    await expect(suggest({ acceptedAt: new Date().toISOString(), acceptedById: a.actorId, paymentId: paid })).rejects.toThrow(/BankMatch_one_(accepted_per_line|line_per_payment)/)
    await expect(admin(`DELETE FROM "BankMatch" WHERE id = $1::uuid`, [pending])).rejects.toThrow(/is accepted; it is kept/)
    // Reversed only after the payment it recorded is voided (its allocation reversed first).
    await expect(update(office(), 'BankMatch', pending, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'Wrong customer.'`, a.actorId)).rejects.toThrow(/void the payment first, then reverse the match/)
    const [allocation] = await sql(office(), `SELECT id FROM "PaymentAllocation" WHERE "paymentId" = $1::uuid`, paid)
    expect(await allocate(paid, s.sampleInvoiceId, -41000, P1, { reversalOfId: allocation!.id, note: 'Wrong customer.' })).toBe(1)
    expect(await update(office(), 'Payment', paid, `status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Wrong customer.', version = version + 1`)).toBe(1)
    await expect(update(office(), 'BankMatch', pending, `"reversedAt" = now(), "reversedById" = $2::uuid`, a.actorId)).rejects.toThrow(/reversed only once accepted, with who, when .* and why/)
    expect(await update(office(), 'BankMatch', pending, `"reversedAt" = now(), "reversedById" = $2::uuid, "reverseReason" = 'Wrong customer.', version = 3`, a.actorId)).toBe(1)
    await expect(update(office(), 'BankMatch', pending, `"reverseReason" = 'Other.'`)).rejects.toThrow(/is reversed; it never changes/)
    // The line may be matched again; a suggestion is deleted.
    const again = randomUUID()
    expect(await suggest({ id: again })).toBe(1)
    expect(await admin(`DELETE FROM "BankMatch" WHERE id = $1::uuid`, [again])).toEqual([])
    // A payment is the line of one live acceptance (the seeded on-account match holds SEED-TRN-0000002).
    await expect(copyRow(office(), 'BankMatch', s.matchIds.onAccount, { id: randomUUID(), bankLineId: s.lineIds.onAccount })).rejects.toThrow(/BankMatch_one_(accepted_per_line|line_per_payment)/)
  })
})

describe('write-offs (FIN-119)', () => {
  const writeOff = (changes: Record<string, unknown>) => copyRow(office(), 'PaymentWriteOff', s.writeOffId, { id: randomUUID(), createdAt: new Date().toISOString(), ...changes })

  it('stay within the tolerance in force and within the payment; the allocation, refund and void rules count them; append-only', async () => {
    await expect(writeOff({ amount: 101, toleranceAmount: 100 })).rejects.toThrow(/passes the company's write-off tolerance of 100/)
    await expect(writeOff({ amount: 10, toleranceAmount: 200 })).rejects.toThrow(/passes the company's write-off tolerance of 100 \(or names another\)/)
    await expect(writeOff({ reason: 'OTHER', note: null })).rejects.toThrow(/note of 1 to 500 characters \(required for OTHER/)
    await expect(writeOff({ kind: 'UNDERPAYMENT' })).rejects.toThrow(/is an UNDERPAYMENT on the allocation whose invoice is short-paid/)
    // P3's test transfer: 50, 25 kept by the seed; 25 more fits, then nothing.
    const second = randomUUID()
    expect(await writeOff({ id: second, amount: 25 })).toBe(1)
    await expect(writeOff({ amount: 1 })).rejects.toThrow(/has 0 allocated, 0 refunded or due and 51 written off .* it passes the payment/)
    // The write-off is no longer placed or refunded, and the payment is not voided while one stands.
    await expect(insert(office(), 'Refund', { id: randomUUID(), companyId: COMPANY_A, partyId: P3, paymentId: s.testPaymentId, amount: 1 })).rejects.toThrow(/0 refunded or due and 50 written off; refund .* passes what is unplaced/)
    await expect(update(office(), 'Payment', s.testPaymentId, `status = 'VOIDED', "voidedAt" = now(), "voidReason" = 'Test.'`)).rejects.toThrow(/has a write-off still standing; reverse the write-off before the payment is voided/)
    // A reversal takes one back exactly, once.
    await expect(writeOff({ amount: -10, reversalOfId: second, note: 'Typed twice.' })).rejects.toThrow(/takes back write-off .* exactly/)
    expect(await writeOff({ amount: -25, reversalOfId: second, note: 'Typed twice.' })).toBe(1)
    await expect(writeOff({ amount: -25, reversalOfId: second, note: 'Again.' })).rejects.toThrow(/is reversed already/)
    await expect(admin(`UPDATE "PaymentWriteOff" SET note = 'x' WHERE id = $1::uuid`, [s.writeOffId])).rejects.toThrow(/append-only: UPDATE on "PaymentWriteOff" is refused/)
    await expect(admin(`DELETE FROM "PaymentWriteOff" WHERE id = $1::uuid`, [s.writeOffId])).rejects.toThrow(/append-only: DELETE on "PaymentWriteOff" is refused/)
  })

  it('close what an allocation left open on its invoice (UNDERPAYMENT), counted by the invoice cap; its allocation is reversed after it', async () => {
    const invoice = await issuedInvoice('2026-11-30')
    const paid = await payment(12150)
    const [allocationId] = [randomUUID()]
    expect(await allocate(paid, invoice, 12150, P1, { id: allocationId })).toBe(1)
    const under = (changes: Record<string, unknown>) =>
      insert(office(), 'PaymentWriteOff', { id: randomUUID(), companyId: COMPANY_A, partyId: P1, paymentId: paid, allocationId, kind: 'UNDERPAYMENT', reason: 'BANK_CHARGES', toleranceAmount: 100, writtenOffById: a.actorId, amount: 50, ...changes })
    await expect(under({ amount: 60 })).rejects.toThrow(/invoice .* is open for 50 .* written off 60 .* it passes the invoice/)
    const closing = randomUUID()
    expect(await under({ id: closing })).toBe(1)
    // The invoice is closed: one more cent is refused, in words that name the write-off.
    const other = await payment(100)
    await expect(allocate(other, invoice, 1)).rejects.toThrow(/is open for 0 \(gross 12200, credited 0, paid 12150, written off 50\); 1 more passes it/)
    // Its allocation is reversed only after its write-off.
    await expect(allocate(paid, invoice, -12150, P1, { reversalOfId: allocationId, note: 'Wrong invoice.' })).rejects.toThrow(/has a write-off still standing; reverse the write-off first/)
    expect(await under({ amount: -50, reversalOfId: closing, note: 'Wrong invoice.' })).toBe(1)
    expect(await allocate(paid, invoice, -12150, P1, { reversalOfId: allocationId, note: 'Wrong invoice.' })).toBe(1)
    await expect(under({ amount: 10 })).rejects.toThrow(/allocation .* is reversed; nothing is written off on it/)
  })

  it('need the company\'s tolerance (the accountant\'s): none set, none written off', async () => {
    const [settings] = await sql(office(), `SELECT id FROM "ReceivablesSettings" WHERE "companyId" IS NULL`)
    expect(await update(office(), 'ReceivablesSettings', settings!.id as string, `"writeOffToleranceAmount" = NULL, version = version + 1`)).toBe(1)
    try {
      await expect(writeOff({ amount: 1 })).rejects.toThrow(/has no write-off tolerance set/)
    } finally {
      expect(await update(office(), 'ReceivablesSettings', settings!.id as string, `"writeOffToleranceAmount" = 100, version = version + 1`)).toBe(1)
    }
    await expect(update(office(), 'ReceivablesSettings', settings!.id as string, `"writeOffToleranceAmount" = -1`)).rejects.toThrow(/write-off tolerance .* is 0 or more/)
  })
})

describe('Ri.Ba. batches (FIN-126)', () => {
  it('collect instalments of issued invoices in their window, issued only behind the switch, each instalment once', async () => {
    const item = (changes: Record<string, unknown>) => copyRow(office(), 'RibaItem', s.ribaItemId, { id: randomUUID(), version: 1, ...changes })
    await expect(item({ instalment: 2 })).rejects.toThrow(/names instalment 2 of invoice .*: an instalment of its payment terms/)
    await expect(item({ amount: 61001 })).rejects.toThrow(/for at least the amount collected/)
    await expect(item({ dueDate: '2026-12-31' })).rejects.toThrow(/is due on 2026-12-31, outside its batch's window/)
    await expect(item({ invoiceId: s.depositInvoiceId })).rejects.toThrow(/Ri.Ba. collects issued TD01 and TD24 invoices/)
    // A batch of its own: an instalment due in the past, so it can be settled today.
    const invoice = await issuedInvoice('2026-11-02')
    const batch = randomUUID()
    expect(await copyRow(office(), 'RibaBatch', s.ribaBatchId, { id: batch, dueFrom: '2026-11-01', dueTo: '2026-11-15', version: 1 })).toBe(1)
    const own = randomUUID()
    expect(await insert(office(), 'RibaItem', { id: own, companyId: COMPANY_A, batchId: batch, partyId: P1, invoiceId: invoice, instalment: 1, dueDate: '2026-11-02', amount: 12200 })).toBe(1)
    expect(await insert(office(), 'RibaItem', { id: randomUUID(), companyId: COMPANY_A, batchId: batch, partyId: P1, invoiceId: invoice, instalment: 1, dueDate: '2026-11-02', amount: 12200 })).toBe(1)
    const fileId = await fileOf('RibaBatch', batch)
    const issue = () => update(office(), 'RibaBatch', batch, `status = 'ISSUED', "fileId" = $2::uuid, "issuedAt" = now(), "issuedById" = $3::uuid, version = 2`, fileId, a.actorId)
    await expect(issue()).rejects.toThrow(/is issued only while the company's Ri.Ba. switch is on/)
    await expect(update(office(), 'RibaItem', own, `status = 'PAID', "settledOn" = $2::date`, today())).rejects.toThrow(/is settled only once its batch is issued/)
    const [settings] = await sql(office(), `SELECT id FROM "ReceivablesSettings" WHERE "companyId" IS NULL`)
    expect(await update(office(), 'ReceivablesSettings', settings!.id as string, `"ribaOn" = true, version = version + 1`)).toBe(1)
    try {
      await expect(issue()).rejects.toThrow(/collects instalment 1 of invoice .* twice/)
      const [twice] = await sql(office(), `SELECT id FROM "RibaItem" WHERE "batchId" = $1::uuid AND id <> $2::uuid`, batch, own)
      expect(await admin(`DELETE FROM "RibaItem" WHERE id = $1::uuid`, [twice!.id])).toEqual([])
      await expect(update(office(), 'RibaBatch', batch, `status = 'ISSUED', "issuedAt" = now(), "issuedById" = $2::uuid`, a.actorId)).rejects.toThrow(/its file, when and by whom it was issued exactly when ISSUED/)
      expect(await issue()).toBe(1)
      await expect(update(office(), 'RibaBatch', batch, `note = 'Late.'`)).rejects.toThrow(/is ISSUED; it never changes/)
      await expect(insert(office(), 'RibaItem', { id: randomUUID(), companyId: COMPANY_A, batchId: batch, partyId: P1, invoiceId: invoice, instalment: 1, dueDate: '2026-11-02', amount: 100 })).rejects.toThrow(/instalments are added only while it is a DRAFT/)
      await expect(admin(`DELETE FROM "RibaItem" WHERE id = $1::uuid`, [own])).rejects.toThrow(/its instalments are removed only while it is a DRAFT/)
      // A second batch never collects the same instalment.
      const second = randomUUID()
      expect(await copyRow(office(), 'RibaBatch', s.ribaBatchId, { id: second, dueFrom: '2026-11-01', dueTo: '2026-11-15', version: 1 })).toBe(1)
      expect(await insert(office(), 'RibaItem', { id: randomUUID(), companyId: COMPANY_A, batchId: second, partyId: P1, invoiceId: invoice, instalment: 1, dueDate: '2026-11-02', amount: 12200 })).toBe(1)
      await expect(update(office(), 'RibaBatch', second, `status = 'ISSUED', "fileId" = $2::uuid, "issuedAt" = now(), "issuedById" = $3::uuid`, await fileOf('RibaBatch', second), a.actorId)).rejects.toThrow(/is collected by Ri.Ba. batch .* already/)
      // Settled once: paid, or returned unpaid with the bank's fee.
      await expect(update(office(), 'RibaItem', own, `status = 'UNPAID', "settledOn" = $2::date`, today())).rejects.toThrow(/the bank's fee \(0 or more\) exactly when it came back UNPAID/)
      await expect(update(office(), 'RibaItem', own, `status = 'PAID', "settledOn" = '2026-11-01'`)).rejects.toThrow(/not before its due day and not after today/)
      expect(await update(office(), 'RibaItem', own, `status = 'UNPAID', "settledOn" = $2::date, "unpaidFee" = 450, version = 2`, today())).toBe(1)
      await expect(update(office(), 'RibaItem', own, `status = 'PAID'`)).rejects.toThrow(/is UNPAID; it never changes/)
    } finally {
      expect(await update(office(), 'ReceivablesSettings', settings!.id as string, `"ribaOn" = false, version = version + 1`)).toBe(1)
    }
  })
})

describe('reminder stops (FIN-112) and the customer\'s own figures (FIN-135)', () => {
  it('hold a reminder\'s approval while they are in force; a lifted or past stop holds nothing', async () => {
    const [reminder] = await sql(office(), `SELECT id FROM "PaymentReminder" WHERE status = 'PREPARED' AND $1::uuid = ANY ("invoiceIds") LIMIT 1`, s.sampleInvoiceId)
    expect(reminder).toBeDefined()
    const stop = randomUUID()
    await expect(copyRow(office(), 'ReminderStop', s.stopIds.promise, { id: randomUUID(), until: null })).rejects.toThrow(/a promise to pay names the day promised/)
    await expect(copyRow(office(), 'ReminderStop', s.stopIds.dispute, { id: randomUUID() })).rejects.toThrow(/starts in force, not lifted/)
    expect(await copyRow(office(), 'ReminderStop', s.stopIds.promise, { id: stop, reason: 'DISPUTE', until: null, version: 1, createdAt: new Date().toISOString() })).toBe(1)
    await expect(update(office(), 'PaymentReminder', reminder!.id as string, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid, subject = 'Promemoria', body = 'Gentile cliente'`, a.actorId)).rejects.toThrow(
      /covers invoice .*, whose reminders are stopped \(DISPUTE\); it is not approved or sent while the stop holds/,
    )
    await expect(update(office(), 'ReminderStop', stop, `reason = 'CREDIT_PENDING'`)).rejects.toThrow(/invoice, reason and creation of reminder stop .* never change/)
    expect(await update(office(), 'ReminderStop', stop, `"liftedAt" = now(), "liftedById" = $2::uuid, "liftReason" = 'Settled.', version = 2`, a.actorId)).toBe(1)
    await expect(update(office(), 'ReminderStop', stop, `note = 'Again.'`)).rejects.toThrow(/is lifted; it never changes/)
    await expect(admin(`DELETE FROM "ReminderStop" WHERE id = $1::uuid`, [stop])).rejects.toThrow(/kept, never deleted/)
  })

  it('keep the customer\'s figures in their shape', async () => {
    const figures = (value: unknown) => update(office(), 'CustomerStatementFigures', s.figuresId, `figures = $2::jsonb`, JSON.stringify(value))
    await expect(figures({ orders: [], payments: [] })).rejects.toThrow(/"balance" \}/)
    await expect(figures({ orders: [{ reference: 'x', amount: 1.5 }], payments: [], balance: 0 })).rejects.toThrow(/whole amounts/)
    await expect(figures({ orders: [], payments: [{ reference: 'x', date: '2026-13-40', amount: 1 }], balance: 0 })).rejects.toThrow(/dates YYYY-MM-DD/)
    expect(await figures({ orders: [{ reference: 'Seed order 1', amount: 61000 }], payments: [], balance: 61000 })).toBe(1)
    await expect(update(office(), 'CustomerStatementFigures', s.figuresId, `"asOf" = '2099-01-01'`)).rejects.toThrow(/as of a day not after today/)
    await expect(update(office(), 'CustomerStatementFigures', s.figuresId, `"partyId" = $2::uuid`, P3)).rejects.toThrow(/company, customer and creation .* never change/)
  })
})

describe('payment proposals (FIN-140, FIN-142)', () => {
  /** A supplier invoice of P2 typed in (MANUAL, no purchase order), approved for payment by the member (not its registrant). */
  async function approvedSupplierInvoice(gross: number): Promise<string> {
    const id = randomUUID()
    expect(await insert(office(), 'SupplierInvoice', { id, companyId: COMPANY_A, partyId: P2, source: 'MANUAL', number: `T-${tag()}`, issueDate: '2026-11-10', receivedOn: '2026-11-12', netTotal: gross, grossTotal: gross, matchStatus: 'NO_PO' })).toBe(1)
    expect(await update(office(memberId), 'SupplierInvoice', id, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid, version = version + 1`, memberId)).toBe(1)
    return id
  }

  it('are approved by someone who did not make them, to the supplier\'s ACTIVE account, each invoice once, paid once every invoice is', async () => {
    const proposal = randomUUID()
    expect(await copyRow(office(), 'PaymentProposal', s.proposalId, { id: proposal, version: 1 })).toBe(1)
    await expect(copyRow(office(), 'PaymentProposal', s.proposalId, { id: randomUUID(), weekStart: '2026-11-17' })).rejects.toThrow(/for a week starting on a Monday/)
    const approve = (by: string) => update(office(by), 'PaymentProposal', proposal, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid, version = version + 1`, by)
    await expect(approve(memberId)).rejects.toThrow(/is approved with at least one supplier invoice/)
    const line = (changes: Record<string, unknown>) =>
      insert(office(), 'PaymentProposalLine', { id: randomUUID(), companyId: COMPANY_A, proposalId: proposal, partyId: P2, supplierInvoiceId: s.supplierInvoiceId, amount: 56913, supplierBankAccountId: s.supplierBankAccountId, ...changes })
    // The seeded draft holds P2's 2026/0412 already: one proposal pays an invoice.
    await expect(line({})).rejects.toThrow(/is in payment proposal .* already; it is paid by one proposal/)
    const invoice = await approvedSupplierInvoice(20000)
    await expect(line({ supplierInvoiceId: invoice, amount: 20001 })).rejects.toThrow(/more than supplier invoice .* asks/)
    const [pending] = await sql(office(), `SELECT id FROM "SupplierBankAccount" WHERE "partyId" = $1::uuid AND status <> 'ACTIVE' LIMIT 1`, P2)
    await expect(line({ supplierInvoiceId: invoice, amount: 19000, supplierBankAccountId: pending!.id })).rejects.toThrow(/a payment goes only to the supplier's ACTIVE \(verified\) account/)
    const held = randomUUID()
    expect(await line({ id: held, supplierInvoiceId: invoice, amount: 19600, discountAmount: 400, supplierBankAccountId: null })).toBe(1)
    // Held: no verified account named yet.
    await expect(approve(memberId)).rejects.toThrow(/holds supplier invoice .*: it has no ACTIVE \(verified\) bank account/)
    expect(await update(office(), 'PaymentProposalLine', held, `"supplierBankAccountId" = $2::uuid, version = 2`, s.supplierBankAccountId)).toBe(1)
    await expect(update(office(), 'PaymentProposalLine', held, `"partyId" = $2::uuid`, P1)).rejects.toThrow(/proposal, supplier, invoice and creation of payment proposal line .* never change/)
    // A second line of the same invoice in the draft is refused at the approval; an invoice not approved for payment too.
    const twice = randomUUID()
    expect(await line({ id: twice, supplierInvoiceId: invoice, amount: 100 })).toBe(1)
    await expect(approve(memberId)).rejects.toThrow(/pays supplier invoice .* twice/)
    expect(await admin(`DELETE FROM "PaymentProposalLine" WHERE id = $1::uuid`, [twice])).toEqual([])
    // The person who made it never approves it; nothing but the note changes while it stays a DRAFT.
    await expect(approve(a.actorId)).rejects.toThrow(/is never approved by the person who made it/)
    await expect(update(office(), 'PaymentProposal', proposal, `currency = 'USD'`)).rejects.toThrow(/company, week, currency and maker of payment proposal .* never change/)
    await expect(update(office(), 'PaymentProposal', proposal, `status = 'PAID', "paidAt" = now()`)).rejects.toThrow(/cannot move from DRAFT to PAID/)
    expect(await approve(memberId)).toBe(1)
    await expect(line({ supplierInvoiceId: await approvedSupplierInvoice(5000), amount: 5000 })).rejects.toThrow(/its lines are written only while it is a DRAFT/)
    await expect(admin(`DELETE FROM "PaymentProposalLine" WHERE id = $1::uuid`, [held])).rejects.toThrow(/its lines are removed only while it is a DRAFT/)
    // Paid once every invoice in it is PAID.
    const pay = () => update(office(), 'PaymentProposal', proposal, `status = 'PAID', "paidAt" = now(), version = version + 1`)
    await expect(pay()).rejects.toThrow(/is paid once every supplier invoice in it is PAID/)
    expect(await update(office(), 'SupplierInvoice', invoice, `status = 'PAID', "paidOn" = '2026-11-13', "paymentRef" = $2, version = version + 1`, `TRN-${tag()}`)).toBe(1)
    expect(await pay()).toBe(1)
    await expect(update(office(), 'PaymentProposal', proposal, `note = 'Late.'`)).rejects.toThrow(/is PAID; it never changes/)
    await expect(admin(`DELETE FROM "PaymentProposal" WHERE id = $1::uuid`, [proposal])).rejects.toThrow(/kept, never deleted/)
  })
})

describe("the accountant's bridge (FIN-152, FIN-154, FIN-157)", () => {
  it('keeps a mapping fixed from its first day; a row not yet in force is changed or removed', async () => {
    await expect(update(office(), 'AccountMapping', s.mappingIds.leather, `"accountCode" = '6199'`)).rejects.toThrow(/applies since 2026-01-01; it is fixed/)
    await expect(admin(`DELETE FROM "AccountMapping" WHERE id = $1::uuid`, [s.mappingIds.leather])).rejects.toThrow(/applies since 2026-01-01; it is kept/)
    await expect(copyRow(office(), 'AccountMapping', s.mappingIds.leather, { id: randomUUID(), validFrom: '2027-06-01', accountCode: ' 61' })).rejects.toThrow(/names an account of 1 to 40 letters/)
    await expect(copyRow(office(), 'AccountMapping', s.mappingIds.leather, { id: randomUUID() })).rejects.toThrow(/AccountMapping_tenantId_companyId_kind_key_validFrom_key/)
    expect(await update(office(), 'AccountMapping', s.mappingIds.leatherNext, `"accountCode" = '6103', version = version + 1`)).toBe(1)
    await expect(update(office(), 'AccountMapping', s.mappingIds.leatherNext, `key = 'HIDES'`)).rejects.toThrow(/company, kind, key, first day and creation .* never change/)
    expect(await admin(`DELETE FROM "AccountMapping" WHERE id = $1::uuid`, [s.mappingIds.leatherNext])).toEqual([])
  })

  it('hands a document over once: NEW in no other exported batch, CHANGED only in a re-export; a later change flagged once', async () => {
    const doc = (changes: Record<string, unknown>) => copyRow(office(), 'ExportedDocument', s.exportedDocumentIds.sample, { id: randomUUID(), ...changes })
    await expect(doc({ change: 'CHANGED' })).rejects.toThrow(/is CHANGED only in a re-export/)
    await expect(doc({ recordType: 'not a model' })).rejects.toThrow(/names a model/)
    await expect(doc({ changedAt: new Date().toISOString(), changedFingerprint: 'sha256:other' })).rejects.toThrow(/not flagged as changed when it is handed over/)
    await expect(update(office(), 'ExportedDocument', s.exportedDocumentIds.sample, `"changedAt" = now(), "changedFingerprint" = 'sha256:other'`)).rejects.toThrow(/a change is flagged on its documents only once it is exported/)
    // The same invoice twice in October's draft is refused when it is exported.
    const twice = randomUUID()
    expect(await doc({ id: twice })).toBe(1)
    const exportIt = () =>
      update(office(), 'AccountingExport', s.draftExportId, `status = 'EXPORTED', "numberSeriesId" = $2::uuid, number = $3, "exportedAt" = now(), "exportedById" = $4::uuid, checks = '[]'::jsonb, version = version + 1`,
        EXPORT_SERIES, `EXP-T-${tag()}`, a.actorId)
    await expect(exportIt()).rejects.toThrow(/hands over Invoice .* twice/)
    expect(await admin(`DELETE FROM "ExportedDocument" WHERE id = $1::uuid`, [twice])).toEqual([])
    expect(await exportIt()).toBe(1)
    await expect(doc({})).rejects.toThrow(/its documents are written only while it is a DRAFT/)
    await expect(update(office(), 'ExportedDocument', s.exportedDocumentIds.sample, `"changedAt" = now(), "changedFingerprint" = fingerprint`)).rejects.toThrow(/other than the exported one/)
    expect(await update(office(), 'ExportedDocument', s.exportedDocumentIds.sample, `"changedAt" = now(), "changedFingerprint" = 'sha256:after-a-change'`)).toBe(1)
    await expect(update(office(), 'ExportedDocument', s.exportedDocumentIds.sample, `"changedFingerprint" = 'sha256:again'`)).rejects.toThrow(/never changes; only a later change .* once/)
    await expect(admin(`DELETE FROM "ExportedDocument" WHERE id = $1::uuid`, [s.exportedDocumentIds.sample])).rejects.toThrow(/its documents are kept/)
    // A re-export of October carries the changed invoice as CHANGED, never as NEW.
    const reexport = randomUUID()
    expect(await copyRow(office(), 'AccountingExport', s.draftExportId, { id: reexport, status: 'DRAFT', supersedesId: s.draftExportId, number: null, numberSeriesId: null, exportedAt: null, exportedById: null, version: 1 })).toBe(1)
    expect(await doc({ exportId: reexport, changedAt: null, changedFingerprint: null })).toBe(1)
    expect(await insert(office(), 'AccountingExportFile', { id: randomUUID(), exportId: reexport, seq: 1, package: 'SALES_JOURNAL', fileId: await fileOf('AccountingExport', reexport), format: 'CSV', rowCount: 1 })).toBe(1)
    await expect(
      update(office(), 'AccountingExport', reexport, `status = 'EXPORTED', "numberSeriesId" = $2::uuid, number = $3, "exportedAt" = now(), "exportedById" = $4::uuid, version = version + 1`,
        EXPORT_SERIES, `EXP-T-${tag()}`, a.actorId),
    ).rejects.toThrow(/hands over Invoice .* as NEW, but export .* handed it over already/)
  })

  it('records integrity check runs as they ran, append-only', async () => {
    const runOf = (changes: Record<string, unknown>) => copyRow(office(), 'IntegrityCheckRun', s.checkRunIds.allocations, { id: randomUUID(), ...changes })
    await expect(runOf({ checkCode: 'lower' })).rejects.toThrow(/names its check/)
    await expect(runOf({ result: 'FAILED' })).rejects.toThrow(/FAILED with its count and up to 100 of them/)
    await expect(runOf({ result: 'FAILED', failureCount: 1, failures: [{ recordType: 'Payment', recordId: 'x' }] })).rejects.toThrow(/"recordId": a uuid/)
    await expect(runOf({ result: 'ERROR' })).rejects.toThrow(/ERROR with the error in words/)
    expect(await runOf({ result: 'ERROR', errorWords: 'The database was busy.' })).toBe(1)
    await expect(admin(`UPDATE "IntegrityCheckRun" SET "failureCount" = 0 WHERE id = $1::uuid`, [s.checkRunIds.placed])).rejects.toThrow(/append-only: UPDATE on "IntegrityCheckRun" is refused/)
  })

  it('keeps a trusted reminder level of 1 to 10 on a customer', async () => {
    await expect(update(office(), 'Party', P1, `"reminderTrustedLevel" = 11`)).rejects.toThrow(/trusted reminder level of party .* is 1 to 10/)
    expect(await update(office(), 'Party', P1, `"reminderTrustedLevel" = 2, version = version + 1`)).toBe(1)
    expect(await update(office(), 'Party', P1, `"reminderTrustedLevel" = NULL, version = version + 1`)).toBe(1)
  })
})
