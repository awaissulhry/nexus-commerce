import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedTax, type TaxSeed } from '../seed/tax'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Invoicing, tax and currency (W2b-6, schema wave 49/57, B-W2b-369, …_tax_currency_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the office scope:
 *   - tax codes: formats, a rate or a Natura with its law, versions that never overlap, a version in force never edited
 *     (ended, a new one made), VERIFIED never back, deleted only before its first day;
 *   - declarations of intent: the protocol, used up to the amount, the check recorded once with its receipt, one live per
 *     protocol, revoked then frozen, never deleted;
 *   - stamp duty quarters, self-invoices, e-invoice test mode, our copy of an SDI send, invoice runs, deposit rules,
 *     currencies, exchange rates and the payment terms' skipped months;
 *   - the invoice's language, rate, run, declaration (behind its switch) and debit note; the self-invoice types behind
 *     their switch and the SELF_INVOICE series; the stamp duty charged as a line behind its switch.
 * The refusals are check_violation (23514) in words, or the partial uniques' 23505.
 */

const NS = 'w2b-369-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: TaxSeed

const key = (name: string): string => seedUuid(NS, name)
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (text: string, ...values: unknown[]) => as(office(), (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** `INSERT INTO "<table>" (<the row's columns>) …`: the columns it leaves out take their defaults (tenantId too). */
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (table: string, row: Record<string, unknown>) => run(...insertSql(table, row))
const update = (table: string, id: string, set: string, ...values: unknown[]) => run(`UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (table: string, id: string) => run(`DELETE FROM "${table}" WHERE id = $1::uuid`, id)
/** A table the office may not delete from: refused by the grant, and by the guard for every login (the owner here). */
const neverDeleted = async (table: string, id: string, words: RegExp) => {
  await expect(remove(table, id)).rejects.toThrow(/permission denied/)
  await expect(admin(`DELETE FROM "${table}" WHERE id = $1::uuid`, [id])).rejects.toThrow(words)
}
const tag = (): string => randomUUID().slice(0, 8)
/** Europe/Rome's day, `days` from today, as YYYY-MM-DD. */
const romeDay = (days = 0): string => new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
const switchOn = (which: string, on: boolean) => update('CompanyEInvoiceSettings', s.companyA, `"${which}" = $2`, on)

const SELLER = { vatNumber: '00000003038', name: 'Seed Company A', taxRegime: 'RF01' }
const BILL_TO = { kind: 'IT_BUSINESS', vatNumber: '00000001016', name: 'Seed Customer One S.r.l.', sdiCode: 'SEEDC01' }
let counter = 0

/** A DRAFT invoice of company A (TD01 of net 100.00 + 22% VAT to P1 by default) with one line. */
async function draft(extra: Record<string, unknown> = {}, line: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const buyer = (extra.buyerPartyId as string | undefined) ?? key('party:P1')
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        ...insertSql('Invoice', {
          id,
          companyId: s.companyA,
          buyerPartyId: buyer,
          docType: 'TD01',
          billTo: BILL_TO,
          netTotal: 10000,
          vatTotal: 2200,
          grossTotal: 12200,
          vatSummary: [{ rate: '22.00', nature: null, taxable: 10000, vat: 2200, rounding: 0 }],
          ...extra,
        }),
      )
      await tx.$executeRawUnsafe(
        ...insertSql('InvoiceLine', { id: randomUUID(), invoiceId: id, buyerPartyId: buyer, seq: 1, kind: 'GOODS', description: 'Test jacket', quantity: '1', unitPrice: '100.000000', netAmount: 10000, vatRatePct: '22.00', ...line }),
      )
    }),
  )
  return id
}

/** Issues a DRAFT as the issuing command does (the number from `series`, its NumberAllocation row), today in Rome. */
async function issue(invoiceId: string, series: string, kind: string): Promise<void> {
  const number = `T-${tag()}-${++counter}`
  const date = romeDay()
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        ...insertSql('NumberAllocation', {
          id: randomUUID(),
          companyId: s.companyA,
          seriesId: series,
          kind,
          value: 200_000 + counter,
          formatted: number,
          documentDate: date,
          recordType: 'Invoice',
          recordId: invoiceId,
          allocatedAt: new Date().toISOString(),
          allocatedById: a.actorId,
          requestId: `test-${tag()}`,
        }),
      )
      await tx.$executeRawUnsafe(
        `UPDATE "Invoice" SET status = 'ISSUED', "numberSeriesId" = $2::uuid, number = $3, year = $4, "issueDate" = $5::date, "issuedAt" = now(),
           "issuedById" = $6::uuid, "partyId" = "buyerPartyId", seller = $7::jsonb WHERE id = $1::uuid`,
        invoiceId,
        series,
        number,
        Number(date.slice(0, 4)),
        date,
        a.actorId,
        JSON.stringify(SELLER),
      )
    }),
  )
}
const invoiceSeries = (): string => key('series:A:INVOICE:MAIN:2026')
const selfInvoiceSeries = (): string => `ffffffff${key('series:A:SELF_INVOICE:MAIN:2026').slice(8)}`

beforeAll(async () => {
  db = await migratedDatabase('taxcurrencyw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedTax({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedTax({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the seed', () => {
  it('runs twice and leaves one of each row, every tax switch off', async () => {
    const [counts] = await admin(
      `SELECT (SELECT count(*)::int FROM "TaxCode" WHERE "tenantId" = $1::uuid) AS codes,
              (SELECT count(*)::int FROM "DeclarationOfIntent" WHERE "tenantId" = $1::uuid) AS declarations,
              (SELECT count(*)::int FROM "StampDutyQuarter" WHERE "tenantId" = $1::uuid) AS quarters,
              (SELECT count(*)::int FROM "SelfInvoice" WHERE "tenantId" = $1::uuid) AS selfs,
              (SELECT count(*)::int FROM "CompanyEInvoiceSettings" WHERE "tenantId" = $1::uuid) AS settings,
              (SELECT count(*)::int FROM "SdiArchiveCopy" WHERE "tenantId" = $1::uuid) AS copies,
              (SELECT count(*)::int FROM "InvoiceRun" WHERE "tenantId" = $1::uuid) AS runs,
              (SELECT count(*)::int FROM "DepositCancellationRule" WHERE "tenantId" = $1::uuid) AS rules,
              (SELECT count(*)::int FROM "Currency" WHERE "tenantId" = $1::uuid) AS currencies,
              (SELECT count(*)::int FROM "ExchangeRate" WHERE "tenantId" = $1::uuid) AS rates,
              (SELECT count(*)::int FROM "CompanyEInvoiceSettings" WHERE "tenantId" = $1::uuid
                  AND ("taxCodesOn" OR "stampDutyOn" OR "declarationsOfIntentOn" OR "selfInvoicesOn")) AS switched_on`,
      [a.tenantId],
    )
    expect(counts).toEqual({ codes: 9, declarations: 2, quarters: 2, selfs: 2, settings: 2, copies: 1, runs: 2, rules: 5, currencies: 5, rates: 4, switched_on: 0 })
  })
})

describe('tax codes (FIN-107)', () => {
  const code = (extra: Record<string, unknown> = {}) =>
    insert('TaxCode', { id: randomUUID(), companyId: s.companyA, country: 'IT', code: `T${tag().toUpperCase()}`, label: 'Test code', ratePct: '22.00', validFrom: romeDay(10), ...extra })

  it('keeps a rate or a Natura with its law, in its formats', async () => {
    await expect(code({ country: 'ita' })).rejects.toThrow(/names its country as two capitals/)
    await expect(code({ code: 'n3 5' })).rejects.toThrow(/1-20 capitals, digits/)
    await expect(code({ ratePct: '0.00' })).rejects.toThrow(/carries a Natura .* exactly when its rate is 0/)
    await expect(code({ ratePct: '0.00', natura: 'N3' })).rejects.toThrow(/carries a Natura/)
    await expect(code({ ratePct: '0.00', natura: 'N3.1' })).rejects.toThrow(/cites its law/)
    await expect(code({ legalRef: 'Art. 1' })).rejects.toThrow(/cites its law/)
    await expect(code({ accountCodeKey: 'has space' })).rejects.toThrow(/account key/)
    await expect(code({ confirmedAt: new Date().toISOString(), confirmedById: a.actorId })).rejects.toThrow(/on a VERIFIED code/)
    await expect(code({ validTo: romeDay(5) })).rejects.toThrow(/ends .* before it starts/)
    expect(await code({ ratePct: '0.00', natura: 'N3.1', legalRef: 'Art. 8 c.1 lett. a) DPR 633/1972' })).toBe(1)
  })

  it('never overlaps two ACTIVE versions of a code; an archived one is apart', async () => {
    await expect(code({ code: '22', validFrom: romeDay(30) })).rejects.toThrow(/has an ACTIVE version from .* never overlap/)
    expect(await code({ code: '22', validFrom: romeDay(30), status: 'ARCHIVED' })).toBe(1)
  })

  it('never edits a version in force: it is ended and a new one made; VERIFIED never goes back', async () => {
    await expect(update('TaxCode', s.taxCodeIds.ordinary, `"ratePct" = 23`)).rejects.toThrow(/is in force since .* never edited/)
    await expect(update('TaxCode', s.taxCodeIds.ordinary, `"validTo" = $2::date`, romeDay(-10))).rejects.toThrow(/ends yesterday at the earliest/)
    await expect(update('TaxCode', s.taxCodeIds.ordinary, `verification = 'UNVERIFIED'`)).rejects.toThrow(/never goes back to UNVERIFIED/)
    expect(await update('TaxCode', s.taxCodeIds.ordinary, `label = 'Ordinary rate'`)).toBe(1)
    await expect(update('TaxCode', s.taxCodeIds.reducedOld, `"validTo" = $2::date`, '2026-06-30')).rejects.toThrow(/ended on .* never moves/)
    // The accountant's confirmation of an UNVERIFIED code: with its time and person, once.
    await expect(update('TaxCode', s.taxCodeIds.declaration, `verification = 'VERIFIED'`)).rejects.toThrow(/with the accountant's confirmation/)
    expect(await update('TaxCode', s.taxCodeIds.declaration, `verification = 'VERIFIED', "confirmedAt" = now(), "confirmedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update('TaxCode', s.taxCodeIds.declaration, `"confirmedAt" = now() - interval '1 day'`)).rejects.toThrow(/recorded once/)
  })

  it('ends a version from today and starts the next; deletes only a version not yet in force', async () => {
    expect(await update('TaxCode', s.taxCodeIds.stampDuty, `"validTo" = $2::date`, romeDay(-1))).toBe(1)
    const next = randomUUID()
    expect(await code({ id: next, code: 'N1-BOLLO', ratePct: '0.00', natura: 'N1', legalRef: 'Art. 15 DPR 633/1972', validFrom: romeDay() })).toBe(1)
    await expect(remove('TaxCode', s.taxCodeIds.stampDuty)).rejects.toThrow(/archive it/)
    const future = randomUUID()
    expect(await code({ id: future, validFrom: romeDay(40) })).toBe(1)
    expect(await update('TaxCode', future, `"ratePct" = 21`)).toBe(1)
    expect(await remove('TaxCode', future)).toBe(1)
  })
})

describe('declarations of intent (FIN-100)', () => {
  const declaration = (extra: Record<string, unknown> = {}) =>
    insert('DeclarationOfIntent', { id: randomUUID(), companyId: s.companyA, partyId: key('party:P1'), protocolNumber: `2600000000000${String(1000 + ++counter).padStart(4, '0')}-000001`, protocolDate: '2026-04-01', year: 2026, amount: 100_000, ...extra })

  it('keeps the protocol, its date and year, the amount and what is used of it', async () => {
    await expect(declaration({ protocolNumber: '123-456' })).rejects.toThrow(/17 digits, a hyphen and 6 digits/)
    await expect(declaration({ protocolDate: romeDay(3) })).rejects.toThrow(/in the future/)
    await expect(declaration({ year: 2028 })).rejects.toThrow(/covers its year or the next/)
    await expect(declaration({ usedAmount: 100_001 })).rejects.toThrow(/used from 0 up to it/)
    await expect(declaration({ checkedAt: new Date().toISOString() })).rejects.toThrow(/all three/)
    await expect(update('DeclarationOfIntent', s.declarationIds.live, `"usedAmount" = 5000001`)).rejects.toThrow(/used-up declaration/)
    expect(await update('DeclarationOfIntent', s.declarationIds.live, `"usedAmount" = 12200`)).toBe(1)
    await expect(update('DeclarationOfIntent', s.declarationIds.live, `amount = 6000000`)).rejects.toThrow(/never change/)
    await expect(update('DeclarationOfIntent', s.declarationIds.live, `"checkedAt" = now()`)).rejects.toThrow(/recorded once/)
  })

  it('takes a receipt of its own; one live declaration per protocol; revoked, then frozen; never deleted', async () => {
    await expect(declaration({ checkedAt: new Date().toISOString(), checkedById: a.actorId, receiptFileId: s.receiptFileId })).rejects.toThrow(/a file of the declaration and its company/)
    const [live] = await admin(`SELECT "protocolNumber" FROM "DeclarationOfIntent" WHERE id = $1::uuid`, [s.declarationIds.live])
    await expect(declaration({ protocolNumber: live!.protocolNumber })).rejects.toThrow(/DeclarationOfIntent_one_live/)
    await expect(update('DeclarationOfIntent', s.declarationIds.revoked, `"usedAmount" = 1`)).rejects.toThrow(/was revoked on .* changes no more/)
    const id = randomUUID()
    expect(await declaration({ id })).toBe(1)
    await expect(update('DeclarationOfIntent', id, `"revokedAt" = now()`)).rejects.toThrow(/with its time .* and why/)
    expect(await update('DeclarationOfIntent', id, `"revokedAt" = now(), "revokeReason" = 'Typed for the wrong customer'`)).toBe(1)
    await neverDeleted('DeclarationOfIntent', id, /never deleted \(revoke it with why\)/)
  })
})

describe('stamp duty quarters (FIN-101)', () => {
  it('starts on a quarter\'s first day, is paid after it ended, then frozen', async () => {
    const quarter = (extra: Record<string, unknown>) => insert('StampDutyQuarter', { id: randomUUID(), companyId: s.companyA, ...extra })
    await expect(quarter({ quarterStart: '2026-02-01' })).rejects.toThrow(/starts on 1 January, April, July or October/)
    await expect(quarter({ quarterStart: '2026-04-01', invoiceCount: -1 })).rejects.toThrow(/0 or more/)
    await expect(quarter({ quarterStart: '2026-04-01', paidAt: '2026-05-01T09:00:00.000Z', paidById: a.actorId })).rejects.toThrow(/paid after it ended/)
    expect(await quarter({ quarterStart: '2026-04-01', invoiceCount: 2, total: 400, paidAt: '2026-07-20T09:00:00.000Z', paidById: a.actorId })).toBe(1)
    expect(await update('StampDutyQuarter', s.stampDutyQuarterIds.october, `"invoiceCount" = 2, total = 400`)).toBe(1)
    await expect(update('StampDutyQuarter', s.stampDutyQuarterIds.october, `"paidAt" = now(), "paidById" = $2::uuid`, a.actorId)).rejects.toThrow(/paid after it ended/)
    await expect(update('StampDutyQuarter', s.stampDutyQuarterIds.july, `total = 800`)).rejects.toThrow(/was paid on .* changes no more/)
    await neverDeleted('StampDutyQuarter', s.stampDutyQuarterIds.october, /never deleted/)
  })
})

describe('e-invoice test mode (FIN-096)', () => {
  it('goes live with when and who, both fixed while live; test mode has neither', async () => {
    await expect(update('CompanyEInvoiceSettings', s.companyA, `"testMode" = false`)).rejects.toThrow(/goes live with when/)
    await expect(update('CompanyEInvoiceSettings', s.companyA, `"testMode" = false, "liveSince" = now() + interval '1 day', "liveSetById" = $2::uuid`, a.actorId)).rejects.toThrow(/not in the future/)
    await expect(update('CompanyEInvoiceSettings', s.companyB, `"liveSince" = now()`)).rejects.toThrow(/never change while it stays live/)
    expect(await update('CompanyEInvoiceSettings', s.companyB, `"testMode" = true, "liveSince" = NULL, "liveSetById" = NULL, "simulateOutcome" = 'NOT_DELIVERABLE'`)).toBe(1)
    await neverDeleted('CompanyEInvoiceSettings', s.companyB, /never deleted/)
  })
})

describe('the invoice: language, rate, debit note, run and declaration (FIN-063, FIN-068, FIN-071, FIN-100)', () => {
  it('keeps its language and, in another currency, its rate, day and euro total together', async () => {
    await expect(draft({ language: 'DE' })).rejects.toThrow(/ISO 639-1 code/)
    await expect(draft({ currency: 'USD', exchangeRate: '1.08500000' })).rejects.toThrow(/all three or none/)
    await expect(draft({ exchangeRate: '1.08500000', rateDate: '2026-11-12', totalEur: 12200 })).rejects.toThrow(/none in euro/)
    await expect(draft({ currency: 'USD', exchangeRate: '0', rateDate: '2026-11-12', totalEur: 11244 })).rejects.toThrow(/above 0/)
    const usd = await draft({ language: 'en', currency: 'USD', exchangeRate: '1.08500000', rateDate: '2026-11-12', totalEur: 11244 })
    expect(await update('Invoice', usd, `"exchangeRate" = '1.09000000', "totalEur" = 11193`)).toBe(1)
  })

  it('makes a debit note TD05 of an issued TD01 or TD24 only', async () => {
    const original = await draft()
    await expect(draft({ docType: 'TD05' })).rejects.toThrow(/a debit note TD05 \(and only a TD05\) names the invoice/)
    await expect(draft({ debitOfId: original })).rejects.toThrow(/and only a TD05/)
    await expect(draft({ docType: 'TD05', debitOfId: original })).rejects.toThrow(/a debit note adds to an issued TD01 or TD24/)
    await issue(original, invoiceSeries(), 'INVOICE')
    const note = await draft({ docType: 'TD05', debitOfId: original })
    await issue(note, invoiceSeries(), 'INVOICE')
    await expect(update('Invoice', note, `language = 'it'`)).rejects.toThrow(/is issued/)
  })

  it('goes into a run only while it is a PREVIEW that picks its customer; the run is issued with no draft left', async () => {
    await expect(draft({ invoiceRunId: s.invoiceRunIds.october })).rejects.toThrow(/only while it is a PREVIEW that picks its customer/)
    await expect(draft({ invoiceRunId: s.invoiceRunIds.november, buyerPartyId: key('party:P2') })).rejects.toThrow(/only while it is a PREVIEW that picks its customer/)
    const inRun = await draft({ invoiceRunId: s.invoiceRunIds.november })
    await expect(update('InvoiceRun', s.invoiceRunIds.november, `"partyIds" = ARRAY[$2::uuid]`, key('party:P2'))).rejects.toThrow(/a customer it would no longer pick/)
    await expect(update('InvoiceRun', s.invoiceRunIds.november, `status = 'ISSUED', "issuedAt" = now(), "issuedById" = $2::uuid`, a.actorId)).rejects.toThrow(/still holds draft invoice/)
    await issue(inRun, invoiceSeries(), 'INVOICE')
    expect(await update('InvoiceRun', s.invoiceRunIds.november, `status = 'ISSUED', "issuedAt" = now(), "issuedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update('InvoiceRun', s.invoiceRunIds.november, `"partyIds" = ARRAY[$2::uuid, $3::uuid]`, key('party:P1'), key('party:P2'))).rejects.toThrow(/was issued on .* changes no more/)
    await expect(remove('InvoiceRun', s.invoiceRunIds.november)).rejects.toThrow(/only a preview is deleted/)
  })

  it('checks a run\'s month and customers; deletes a preview with no invoice', async () => {
    const runRow = (extra: Record<string, unknown>) => insert('InvoiceRun', { id: randomUUID(), companyId: s.companyA, month: '2026-12-01', partyIds: [key('party:P1')], ...extra })
    await expect(runRow({ month: '2026-12-15' })).rejects.toThrow(/by its first day/)
    await expect(runRow({ partyIds: [] })).rejects.toThrow(/1 to 1000 customers/)
    await expect(runRow({ partyIds: [randomUUID()] })).rejects.toThrow(/not a party of the tenant/)
    const id = randomUUID()
    expect(await runRow({ id })).toBe(1)
    expect(await remove('InvoiceRun', id)).toBe(1)
  })

  it('rests on a declaration of intent only while the switch is on, checked, of its year, with an N3.5 entry', async () => {
    const n35 = { netTotal: 10000, vatTotal: 0, grossTotal: 10000, vatSummary: [{ rate: null, nature: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972', taxable: 10000, vat: 0, rounding: 0 }] }
    const n35Line = { vatRatePct: '0.00', vatNature: 'N3.5', vatLegalRef: 'Art. 8 c.1 lett. c) DPR 633/1972' }
    await expect(draft({ ...n35, declarationOfIntentId: s.declarationIds.live }, n35Line)).rejects.toThrow(/declarations of intent are switched off .*\(GATE-ACCOUNTANT\)/)
    await switchOn('declarationsOfIntentOn', true)
    await expect(draft({ ...n35, declarationOfIntentId: s.declarationIds.revoked }, n35Line)).rejects.toThrow(/was revoked/)
    // An unchecked declaration: named on a draft, refused at the issue.
    const unchecked = randomUUID()
    await insert('DeclarationOfIntent', { id: unchecked, companyId: s.companyA, partyId: key('party:P1'), protocolNumber: '26000000000000099-000001', protocolDate: '2026-05-01', year: 2026, amount: 100_000 })
    const early = await draft({ ...n35, declarationOfIntentId: unchecked }, n35Line)
    await expect(issue(early, invoiceSeries(), 'INVOICE')).rejects.toThrow(/only once it is checked on the tax agency's site/)
    const plain = await draft({ declarationOfIntentId: s.declarationIds.live })
    await expect(issue(plain, invoiceSeries(), 'INVOICE')).rejects.toThrow(/has the N3.5 lines it covers/)
    const covered = await draft({ ...n35, declarationOfIntentId: s.declarationIds.live }, n35Line)
    await issue(covered, invoiceSeries(), 'INVOICE')
    await switchOn('declarationsOfIntentOn', false)
  })
})

describe('self-invoices TD16-TD19 (FIN-095)', () => {
  const td17 = () => draft({ docType: 'TD17', buyerPartyId: key('party:P3'), netTotal: 120000, vatTotal: 26400, grossTotal: 146400, vatSummary: [{ rate: '22.00', nature: null, taxable: 120000, vat: 26400, rounding: 0 }] }, { netAmount: 120000, unitPrice: '1200.000000', description: 'Trade fair stand (self-invoice)', kind: 'SERVICE' })

  it('lists one live self-invoice per supplier invoice, cancelled with why', async () => {
    await expect(insert('SelfInvoice', { id: randomUUID(), companyId: s.companyA, partyId: key('party:P3'), supplierInvoiceId: s.foreignSupplierInvoiceId, kind: 'TD17', deadline: '2026-12-15' })).rejects.toThrow(/SelfInvoice_one_live/)
    await expect(insert('SelfInvoice', { id: randomUUID(), companyId: s.companyA, partyId: key('party:P3'), supplierInvoiceId: s.foreignSupplierInvoiceId, kind: 'TD18', deadline: '2026-11-01', status: 'CANCELLED', cancelledAt: new Date().toISOString(), cancelReason: 'test' })).rejects.toThrow(/before the day its supplier invoice was received/)
    await expect(update('SelfInvoice', s.selfInvoiceIds.pending, `status = 'CANCELLED', "cancelledAt" = now()`)).rejects.toThrow(/CANCELLED exactly with its time .* and why/)
    await expect(update('SelfInvoice', s.selfInvoiceIds.cancelled, `deadline = '2026-12-31'`)).rejects.toThrow(/is CANCELLED; it changes no more/)
    await expect(update('SelfInvoice', s.selfInvoiceIds.pending, `kind = 'TD18'`)).rejects.toThrow(/never change/)
    await neverDeleted('SelfInvoice', s.selfInvoiceIds.pending, /never deleted/)
  })

  it('issues the TD17 only while the self-invoice switch is on, from the SELF_INVOICE series; then the self-invoice is ISSUED', async () => {
    const doc = await td17()
    await expect(update('SelfInvoice', s.selfInvoiceIds.pending, `"invoiceId" = $2::uuid, status = 'ISSUED'`, doc)).rejects.toThrow(/ISSUED once its invoice is issued/)
    expect(await update('SelfInvoice', s.selfInvoiceIds.pending, `"invoiceId" = $2::uuid`, doc)).toBe(1)
    await expect(issue(doc, selfInvoiceSeries(), 'SELF_INVOICE')).rejects.toThrow(/self-invoices are switched off .*\(GATE-ACCOUNTANT\)/)
    await switchOn('selfInvoicesOn', true)
    // A TD01 is never numbered from the SELF_INVOICE series.
    const plain = await draft()
    await expect(issue(plain, selfInvoiceSeries(), 'SELF_INVOICE')).rejects.toThrow(/SELF_INVOICE for a TD16-TD19\), not from a SELF_INVOICE series/)
    await issue(doc, selfInvoiceSeries(), 'SELF_INVOICE')
    expect(await update('SelfInvoice', s.selfInvoiceIds.pending, `status = 'ISSUED'`)).toBe(1)
    await expect(update('SelfInvoice', s.selfInvoiceIds.pending, `deadline = '2026-12-31'`)).rejects.toThrow(/is ISSUED; it changes no more/)
    // Its invoice is the document of one self-invoice only.
    const other = randomUUID()
    await insert('SupplierInvoice', { id: other, companyId: s.companyA, partyId: key('party:P3'), source: 'MANUAL', kind: 'INVOICE', number: `SEED-DE-${tag()}`, issueDate: '2026-11-03', receivedOn: '2026-11-06', grossTotal: 0 })
    await expect(insert('SelfInvoice', { id: randomUUID(), companyId: s.companyA, partyId: key('party:P3'), supplierInvoiceId: other, kind: 'TD17', deadline: '2026-12-15', invoiceId: doc })).rejects.toThrow(/SelfInvoice_tenantId_invoiceId_key|duplicate key/)
    await switchOn('selfInvoicesOn', false)
  })
})

describe('stamp duty charged to the customer (FIN-101, Owner 11-13)', () => {
  const stampLine = (invoiceId: string, extra: Record<string, unknown> = {}) =>
    insert('InvoiceLine', { id: randomUUID(), invoiceId, buyerPartyId: key('party:P1'), seq: 2, kind: 'CHARGE', chargeKind: 'STAMP_DUTY', description: 'Imposta di bollo', quantity: '1', unitPrice: '2.000000', netAmount: 200, vatRatePct: '0.00', vatNature: 'N1', vatLegalRef: 'Art. 15 DPR 633/1972', ...extra })
  const n32 = { netTotal: 10200, vatTotal: 0, grossTotal: 10200, vatSummary: [{ rate: null, nature: 'N3.5', legalRef: 'Art. 8', taxable: 10000, vat: 0, rounding: 0 }, { rate: null, nature: 'N1', legalRef: 'Art. 15', taxable: 200, vat: 0, rounding: 0 }] }
  const line0 = { vatRatePct: '0.00', vatNature: 'N3.5', vatLegalRef: 'Art. 8' }

  it('is a line only while the stamp duty switch is on, one unit at rate 0 with N1, once per invoice, equal to the stamp duty', async () => {
    const invoice = await draft({ ...n32, stampDutyAmount: 200 }, line0)
    await expect(stampLine(invoice)).rejects.toThrow(/switched off .*\(GATE-ACCOUNTANT\)/)
    await switchOn('stampDutyOn', true)
    await expect(stampLine(invoice, { vatNature: 'N3.5' })).rejects.toThrow(/Natura N1/)
    expect(await stampLine(invoice)).toBe(1)
    await expect(stampLine(invoice, { seq: 3 })).rejects.toThrow(/InvoiceLine_one_stamp_duty/)
    const wrong = await draft({ ...n32, stampDutyAmount: 400 }, line0)
    expect(await stampLine(wrong)).toBe(1)
    await expect(issue(wrong, invoiceSeries(), 'INVOICE')).rejects.toThrow(/charges stamp duty of 200 to the customer; it carries that stamp duty/)
    await issue(invoice, invoiceSeries(), 'INVOICE')
    await switchOn('stampDutyOn', false)
  })
})

describe('our own copy of an SDI send (FIN-097)', () => {
  it('keeps its send, provider and XML; receipts are only added', async () => {
    await expect(update('SdiArchiveCopy', s.archiveCopyId, `"providerName" = 'Openapi'`)).rejects.toThrow(/keeps its send, provider and XML/)
    await expect(update('SdiArchiveCopy', s.archiveCopyId, `"receiptFileIds" = '{}'`)).rejects.toThrow(/only gains receipts/)
    await expect(update('SdiArchiveCopy', s.archiveCopyId, `"receiptFileIds" = "receiptFileIds" || $2::uuid`, s.declarationReceiptFileId)).rejects.toThrow(/a fiscal-archive file of the company/)
    expect(await update('SdiArchiveCopy', s.archiveCopyId, `"copiedAt" = now()`)).toBe(1)
    await neverDeleted('SdiArchiveCopy', s.archiveCopyId, /never deleted/)
  })

  it('is keyed by its send', async () => {
    const [row] = await admin(`SELECT "submissionId", "invoiceId", "partyId", "xmlFileId" FROM "SdiArchiveCopy" WHERE id = $1::uuid`, [s.archiveCopyId])
    await expect(
      insert('SdiArchiveCopy', { id: randomUUID(), companyId: s.companyA, partyId: row!.partyId, invoiceId: row!.invoiceId, submissionId: row!.submissionId, key: `sdi:${randomUUID()}`, providerName: 'FAKE', xmlFileId: row!.xmlFileId, copiedAt: new Date().toISOString() }),
    ).rejects.toThrow(/keyed "sdi:" and the send's id/)
  })
})

describe('deposit rules on cancellation (FIN-080)', () => {
  const rule = (extra: Record<string, unknown>) => insert('DepositCancellationRule', { id: randomUUID(), companyId: s.companyA, depositKind: 'ACCONTO', cancelledBy: 'COMPANY', keepPct: '0', refundRule: 'REFUND_ALL', documentKind: 'CREDIT_NOTE', ...extra })

  it('keeps a share only for KEEP_PERCENT, pays back double only a caparra we cancel, one active per kind and side', async () => {
    await expect(rule({ keepPct: '20' })).rejects.toThrow(/above 0 exactly when it keeps a percent/)
    await expect(rule({ refundRule: 'REFUND_DOUBLE' })).rejects.toThrow(/pays back double only a caparra when we cancel/)
    await expect(rule({ refundRule: 'KEEP_PERCENT', keepPct: '100' })).rejects.toThrow(/no document follows/)
    await expect(rule({ depositKind: 'CAPARRA', refundRule: 'REFUND_DOUBLE', documentKind: 'NONE' })).rejects.toThrow(/DepositCancellationRule_one_active/)
    expect(await rule({})).toBe(1)
    await expect(update('DepositCancellationRule', s.depositRuleIds.acconto, `"cancelledBy" = 'COMPANY'`)).rejects.toThrow(/never change/)
    await neverDeleted('DepositCancellationRule', s.depositRuleIds.acconto, /never deleted \(archive it\)/)
  })
})

describe('currencies and exchange rates (PLT-132, PLT-133)', () => {
  it('switches currencies on and off, never the base one, one active per code', async () => {
    await expect(insert('Currency', { id: randomUUID(), companyId: s.companyA, code: 'usd', minorUnits: 2 })).rejects.toThrow(/three capitals/)
    await expect(insert('Currency', { id: randomUUID(), companyId: s.companyA, code: 'JPY', minorUnits: 5 })).rejects.toThrow(/0 to 4 minor-unit digits/)
    await expect(insert('Currency', { id: randomUUID(), companyId: s.companyA, code: 'USD', minorUnits: 2 })).rejects.toThrow(/Currency_one_active/)
    await expect(update('Currency', s.currencyIds.eur, `active = false`)).rejects.toThrow(/base currency; it is never switched off/)
    expect(await update('Currency', s.currencyIds.chf, `active = true`)).toBe(1)
    await expect(update('Currency', s.currencyIds.chf, `"minorUnits" = 0`)).rejects.toThrow(/never change/)
    await neverDeleted('Currency', s.currencyIds.chf, /never deleted \(switch it off\)/)
  })

  it('keeps the ECB\'s rates as they came, a manual rate of a day with its person, one per base, quote, day and source', async () => {
    const rate = (extra: Record<string, unknown>) => {
      const row = { id: randomUUID(), base: 'EUR', quote: 'CHF', rateDate: '2026-11-12', rate: '0.94000000', source: 'ECB', ...extra }
      return insert('ExchangeRate', { key: `${row.base}:${row.quote}:${row.rateDate}:${row.source}`, ...row })
    }
    await expect(rate({ base: 'USD', quote: 'CHF' })).rejects.toThrow(/an ECB rate's base is EUR/)
    await expect(rate({ quote: 'EUR' })).rejects.toThrow(/two different ISO 4217 currencies/)
    await expect(rate({ rate: '0' })).rejects.toThrow(/above 0/)
    await expect(rate({ rateDate: romeDay(2) })).rejects.toThrow(/the day is in the future/)
    await expect(rate({ source: 'MANUAL' })).rejects.toThrow(/names the person who typed it/)
    await expect(rate({ key: 'EUR:CHF:2026-11-11:ECB' })).rejects.toThrow(/is keyed "EUR:CHF:2026-11-12:ECB"/)
    expect(await rate({})).toBe(1)
    await expect(rate({})).rejects.toThrow(/ExchangeRate_tenantId_key_key|duplicate key/)
    await expect(update('ExchangeRate', s.rateIds.ecbUsd12, `rate = '1.10000000'`)).rejects.toThrow(/what the ECB's file said; it never changes/)
    await expect(remove('ExchangeRate', s.rateIds.ecbUsd12)).rejects.toThrow(/only a manual rate is removed/)
    expect(await update('ExchangeRate', s.rateIds.manualUsd12, `rate = '1.09100000'`)).toBe(1)
    await expect(update('ExchangeRate', s.rateIds.manualUsd12, `"rateDate" = '2026-11-11'`)).rejects.toThrow(/never change/)
    expect(await remove('ExchangeRate', s.rateIds.manualUsd12)).toBe(1)
  })
})

describe('payment terms: skipped months (FIN-076)', () => {
  it('skips months 1 to 12, each once, at most 11', async () => {
    await expect(update('PaymentTerms', s.paymentTermsId, `"skipMonths" = '{8,8}'`)).rejects.toThrow(/skip months 1 to 12, each once/)
    await expect(update('PaymentTerms', s.paymentTermsId, `"skipMonths" = '{13}'`)).rejects.toThrow(/skip months 1 to 12/)
    await expect(update('PaymentTerms', s.paymentTermsId, `"skipMonths" = NULL`)).rejects.toThrow(/skip months 1 to 12/)
    expect(await update('PaymentTerms', s.paymentTermsId, `"skipMonths" = '{8,12}', "fromEndOfMonth" = false`)).toBe(1)
  })
})
