import { describe, expect, it } from 'vitest'
import { explanationProblems, intrastatCheck, paymentsPlacedCheck, periodEndedCheck, storedChecks, totalsAddUp, yearEndCheck } from './checks'
import { intrastatFileRows, intrastatRowOf, isEuSale, type IntrastatLineFacts } from './intrastat'
import { buyerOfBillTo, fileRows, paymentDocument, salesJournalDocument, type SalesInvoiceFacts } from './journals'
import { canonicalJson, differenceOf, fingerprint, heldDocuments, parseManifest, type ExportDocument } from './manifest'
import { packageProblems } from './packages'
import { databaseHardLockWords, dayWords, hardLockedWords, isYearEndPeriod, lockPhrases, monthLabel, PERIOD_LOCK_ISSUES, periodOfDays, periodOfMonth, periodWords, phraseMatches, softLockedWords, yearEndMonthNumber } from './periods'
import { periodLockOverride } from './contracts'
import { yearEndDocuments } from './year-end'

/**
 * The accounting exports' pure rules (B-W2a-39; FIN-046, LOG-098, LOG-100): periods and the closing phrase, what a
 * batch may carry, the manifest and its re-export difference, the journal rows, the Intrastat rows and file, the checks.
 * Every figure is made up.
 */

describe('periods (whole months, Europe/Rome days)', () => {
  it('names a month, its days, its labels and the year end', () => {
    expect(periodOfMonth('2026-02')).toEqual({ month: '2026-02', start: '2026-02-01', end: '2026-02-28' })
    expect(periodOfMonth('2028-02').end).toBe('2028-02-29')
    expect(periodOfDays('2026-10-01', '2026-10-31')?.month).toBe('2026-10')
    expect(periodOfDays('2026-10-01', '2026-11-30')).toBeNull()
    expect([monthLabel('2026-10'), monthLabel('2026-10', 'it')]).toEqual(['October 2026', 'ottobre 2026'])
    expect(yearEndMonthNumber(1)).toBe(12)
    expect(yearEndMonthNumber(7)).toBe(6)
    expect(isYearEndPeriod(periodOfMonth('2026-12'))).toBe(true)
    expect(isYearEndPeriod(periodOfMonth('2026-11'))).toBe(false)
    expect(() => periodOfMonth('2026-13')).toThrow()
  })

  it('closes a month for good only with its phrase, in either language (P1)', () => {
    expect(lockPhrases('2026-08')).toEqual({ en: 'close August 2026', it: 'chiudi agosto 2026' })
    expect(phraseMatches('2026-08', '  Close   august 2026 ')).toBe(true)
    expect(phraseMatches('2026-08', 'CHIUDI AGOSTO 2026')).toBe(true)
    expect(phraseMatches('2026-08', 'close September 2026')).toBe(false)
    expect(phraseMatches('2026-08', undefined)).toBe(false)
  })

  it('says a write refused by a hard lock in words: which month, which lock, who can lift it (B-W2a-F1)', () => {
    expect([dayWords('2026-09-05'), dayWords('2026-12-31')]).toEqual(['5 Sep 2026', '31 Dec 2026'])
    expect(periodWords(periodOfMonth('2026-09'))).toBe('September 2026')
    expect(periodWords({ start: '2026-11-01', end: '2027-01-31' })).toBe('November 2026 to January 2027')
    const lock = { start: '2026-09-01', end: '2026-09-30', company: 'Seed Company A S.r.l.', lockedOn: '2026-10-02', lockedBy: 'Fiona Neri' }
    expect(hardLockedWords(lock, 'the payment received on 15 Sep 2026 is not recorded')).toBe(
      'September 2026 is closed for good for Seed Company A S.r.l. (a hard lock since 2 Oct 2026, by Fiona Neri): the payment received on 15 Sep 2026 is not recorded. ' +
        'Only someone who may lift a hard lock (accounting.unlock: the owner, by default) reopens the month, with a reason, in Finance › Accounting; agree it with the accountant first.',
    )
    expect(hardLockedWords({ ...lock, lockedBy: null }, 'x')).toContain('(a hard lock since 2 Oct 2026): x.')
  })

  it('says a write into a soft-locked month sent without a reason in words, and how to go on (B-W2a-F8)', () => {
    const lock = { start: '2026-10-01', end: '2026-10-31', company: 'Seed Company A S.r.l.', lockedOn: '2026-11-03', lockedBy: 'Fiona Neri' }
    expect(softLockedWords(lock, 'the payment received on 20 Oct 2026 is not recorded')).toBe(
      'October 2026 is soft-locked for Seed Company A S.r.l. (since 3 Nov 2026, by Fiona Neri): the payment received on 20 Oct 2026 is not recorded without a reason. ' +
        'Say why it goes into that month (3 to 500 characters, kept in the audit trail) and send it again, or ask finance to lift the soft lock in Finance › Accounting.',
    )
    expect(softLockedWords({ ...lock, lockedBy: null }, 'x')).toContain('(since 3 Nov 2026): x without a reason.')
    expect(PERIOD_LOCK_ISSUES).toEqual({ soft: 'period/SOFT_LOCKED', hard: 'period/HARD_LOCKED' })
    expect(periodLockOverride.safeParse({ reason: '  ok ' }).success).toBe(false)
    expect(periodLockOverride.safeParse({ reason: 'Bank statement arrived late.' }).success).toBe(true)
    expect(periodLockOverride.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false)
    expect(periodLockOverride.safeParse({ reason: 'Late statement.', extra: 1 }).success).toBe(false)
  })

  it("turns the database's own hard-lock refusal into the same words, without record ids (B-W2a-F8)", () => {
    const words = (what: string) =>
      databaseHardLockWords(`period lock: ${what} is dated 2026-09-15, inside the closed period 2026-09-01 to 2026-09-30 of its company (a HARD lock: the accountant has it; lift the lock first, with a reason)`)
    expect(words('payment 0190f000-0000-7000-8000-000000000001 (CRO-1)')).toBe(
      'September 2026 is closed for good (a hard lock): the payment (CRO-1) dated 15 Sep 2026 is not written. ' +
        'Only someone who may lift a hard lock (accounting.unlock: the owner, by default) reopens the month, with a reason, in Finance › Accounting; agree it with the accountant first.',
    )
    expect(words('the payment of supplier invoice 0190f000-0000-7000-8000-000000000002 (number 2026/7)')).toContain(': the payment of supplier invoice (number 2026/7) dated 15 Sep 2026 is not written.')
    expect(words('stock move 0190f000-0000-7000-8000-000000000003 (ISSUE)')).toContain(': the stock move (ISSUE) dated 15 Sep 2026')
    expect(databaseHardLockWords('payments: something else entirely')).toBeNull()
  })
})

describe('what a batch may carry', () => {
  const all = new Set(['price', 'cost', 'margin', 'wages'] as const)
  it('refuses the W2b packages, the year-end pack outside the year end and a package of a grain not held', () => {
    expect(packageProblems(['SALES_JOURNAL', 'INTRASTAT'], { yearEndPeriod: false, grains: all })).toEqual([])
    expect(packageProblems(['VAT_REGISTERS', 'YEAR_END_STOCK'], { yearEndPeriod: false, grains: all }).map((problem) => problem.code)).toEqual(['PACKAGE_W2B', 'YEAR_END_NOT_THIS_PERIOD'])
    expect(packageProblems(['YEAR_END_STOCK'], { yearEndPeriod: true, grains: new Set(['price'] as const) }).map((problem) => problem.code)).toEqual(['PACKAGE_GRAIN'])
  })
})

const invoice = (over: Partial<SalesInvoiceFacts> = {}): SalesInvoiceFacts => ({
  id: '00000000-0000-7000-8000-000000000001',
  number: 'FT-2026-00001',
  version: 3,
  docType: 'TD01',
  issueDate: '2026-10-28',
  currency: 'EUR',
  netTotal: 100000,
  vatTotal: 22000,
  grossTotal: 122000,
  stampDutyAmount: null,
  summary: [{ rate: '22.00', nature: null, taxable: 100000, vat: 22000 }],
  buyerCode: 'P1',
  buyer: { kind: 'IT_BUSINESS', name: 'Cliente Esempio', vatId: 'IT00000001016', fiscalCode: null, country: 'IT' },
  creditOfNumber: null,
  ...over,
})

describe('the manifest and a re-export', () => {
  it('fingerprints the data the file writes, whatever the key order or the version', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}')
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
    const first = salesJournalDocument(invoice())
    // An SDI status that moved bumps the version only: the same rows, the same fingerprint.
    expect(salesJournalDocument(invoice({ version: 5 })).document.hash).toBe(first.document.hash)
    expect(salesJournalDocument(invoice({ grossTotal: 122100 })).document.hash).not.toBe(first.document.hash)
  })

  it('carries only what is new, changed or gone since the batches before', () => {
    const doc = (recordId: string, hash: string): ExportDocument => ({ package: 'SALES_JOURNAL', recordType: 'Invoice', recordId, number: recordId, version: 1, hash })
    const first = differenceOf(new Map(), [doc('a', '1'), doc('b', '2')], ['SALES_JOURNAL'])
    expect(first.entries.map((entry) => [entry.recordId, entry.change])).toEqual([['a', 'NEW'], ['b', 'NEW']])
    const held = heldDocuments([first.entries])
    const second = differenceOf(held, [doc('a', '1'), doc('b', '9'), doc('c', '3')], ['SALES_JOURNAL'])
    expect(second.entries.map((entry) => [entry.recordId, entry.change])).toEqual([['b', 'CHANGED'], ['c', 'NEW']])
    expect(second.packages).toEqual([{ package: 'SALES_JOURNAL', documents: 3, new: 1, changed: 1, removed: 0, same: 1 }])
    const third = differenceOf(heldDocuments([first.entries, second.entries]), [doc('c', '3')], ['SALES_JOURNAL'])
    expect(third.entries.map((entry) => [entry.recordId, entry.change])).toEqual([['a', 'REMOVED'], ['b', 'REMOVED']])
    expect(differenceOf(heldDocuments([first.entries, second.entries, third.entries]), [doc('c', '3')], ['SALES_JOURNAL']).changes).toBe(0)
    // Stored JSON read back; the seeds' entries without a package take the default.
    expect(parseManifest([{ recordType: 'Invoice', recordId: 'x', number: 'FT-1', change: 'NEW' }, { nonsense: true }], 'SALES_JOURNAL')).toEqual([
      { package: 'SALES_JOURNAL', recordType: 'Invoice', recordId: 'x', number: 'FT-1', version: null, hash: '', change: 'NEW' },
    ])
  })

  it('writes a journal row per VAT rate with the change, and a row for a document that left the month', () => {
    const doc = salesJournalDocument(invoice({ summary: [{ rate: '22.00', nature: null, taxable: 80000, vat: 17600 }, { rate: null, nature: 'N3.2', taxable: 20000, vat: 0 }] }))
    expect(doc.rows).toHaveLength(2)
    expect(fileRows([doc], null, 15, 0).map((row) => row.at(-1))).toEqual(['NEW', 'NEW'])
    const removed = { ...doc.document, number: 'FT-2026-00009', recordId: 'gone', change: 'REMOVED' as const }
    const rows = fileRows([doc], [removed], 15, 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]![0]).toBe('FT-2026-00009')
    expect(rows[0]!.at(-1)).toBe('REMOVED')
  })
})

describe('the buyer as an invoice names it', () => {
  it('prefixes the VAT ID with its country (EL for Greece) and keeps a consumer without one', () => {
    expect(buyerOfBillTo({ kind: 'FOREIGN', country: 'DE', taxId: '999999999', name: 'Kunde GmbH', address: { country: 'DE' } })).toMatchObject({ vatId: 'DE999999999', country: 'DE' })
    expect(buyerOfBillTo({ kind: 'FOREIGN', country: 'GR', taxId: '123456789', name: 'Pelatis' })).toMatchObject({ vatId: 'EL123456789' })
    expect(buyerOfBillTo({ kind: 'IT_CONSUMER', fiscalCode: 'RSSMRA80A01H501U', firstName: 'Mario', lastName: 'Rossi' })).toMatchObject({ vatId: null, name: 'Mario Rossi' })
  })
})

const euLine = (over: Partial<IntrastatLineFacts> = {}): IntrastatLineFacts => ({
  invoice: { id: '00000000-0000-7000-8000-0000000000a1', number: 'FT-2026-00010', version: 2, docType: 'TD24', issueDate: '2026-11-30', currency: 'EUR' },
  line: { id: '00000000-0000-7000-8000-0000000000b1', seq: 1, kind: 'GOODS', quantity: '12.0000', netAmount: 504000, description: 'Giacca moto' },
  buyer: { kind: 'FOREIGN', name: 'Kunde GmbH', vatId: 'DE999999999', fiscalCode: null, country: 'DE', partyId: '00000000-0000-7000-8000-0000000000c1', code: 'P9', incoterm: 'DAP' },
  destination: { country: 'DE', source: 'DDT' },
  style: { id: '00000000-0000-7000-8000-0000000000d1', code: 'JKT-01', hsCode: '4203100010', originCountry: 'IT', netMassKg: '1.850' },
  ...over,
})

describe('Intrastat rows and file (LOG-098, LOG-100)', () => {
  it('takes goods going to another member state, never Italy, charges or a deposit', () => {
    expect(isEuSale(euLine())).toBe(true)
    expect(isEuSale(euLine({ destination: { country: 'IT', source: 'DDT' } }))).toBe(false)
    expect(isEuSale(euLine({ destination: { country: 'CH', source: 'DDT' } }))).toBe(false)
    expect(isEuSale(euLine({ line: { ...euLine().line, kind: 'CHARGE' } }))).toBe(false)
    expect(isEuSale(euLine({ invoice: { ...euLine().invoice, docType: 'TD02' } }))).toBe(false)
  })

  it('writes what the file needs: the CN code of 8 digits, the mass of the pieces, the suggested nature', () => {
    const row = intrastatRowOf(euLine())
    expect(row).toMatchObject({ cnCode: '42031000', partnerVatId: 'DE999999999', netMassKg: '22.200', supplementaryUnits: '12', nature: 'SALE', suggestedNatureCode: '11', deliveryTerms: 'DAP', transportMode: null, flags: [] })
    expect(intrastatRowOf(euLine({ invoice: { ...euLine().invoice, docType: 'TD04' } }))).toMatchObject({ nature: 'RETURN', suggestedNatureCode: '21' })
  })

  it('flags what is missing with what fixes it', () => {
    const row = intrastatRowOf(euLine({ style: { id: 'S', code: 'JKT-02', hsCode: '420310', originCountry: null, netMassKg: null }, buyer: { ...euLine().buyer, vatId: null, incoterm: null }, destination: { country: 'DE', source: 'BILL_TO' } }))
    expect(row.flags.map((flag) => [flag.code, flag.severity, flag.fix?.field ?? null])).toEqual([
      ['CN_CODE_SHORT', 'BLOCKING', 'hsCode'],
      ['ORIGIN_MISSING', 'BLOCKING', 'originCountry'],
      ['NET_MASS_MISSING', 'BLOCKING', 'netMassKg'],
      ['VAT_ID_MISSING', 'BLOCKING', 'taxIdentity'],
      ['DELIVERY_TERMS_MISSING', 'WARNING', 'incoterm'],
      ['DESTINATION_FROM_BILL_TO', 'WARNING', null],
    ])
    expect(intrastatRowOf(euLine({ style: null })).flags[0]).toMatchObject({ code: 'NO_STYLE', fix: { recordType: 'Invoice' } })
    expect(intrastatRowOf(euLine({ invoice: { ...euLine().invoice, currency: 'USD' } })).flags[0]!.code).toBe('NOT_EUR')
    const check = intrastatCheck([row])
    expect(check).toMatchObject({ code: 'INTRASTAT_COMPLETE', passed: false, count: 4 })
    expect(intrastatCheck([intrastatRowOf(euLine())]).passed).toBe(true)
  })

  it('sums the rows of one partner, CN code, nature, terms and origin in the file, naming its invoices', () => {
    const a = intrastatRowOf(euLine())
    const b = intrastatRowOf(euLine({ invoice: { ...euLine().invoice, id: 'other', number: 'FT-2026-00011' }, line: { ...euLine().line, id: 'l2', quantity: '3.0000', netAmount: 126000 } }))
    const c = intrastatRowOf(euLine({ destination: { country: 'FR', source: 'DDT' }, buyer: { ...euLine().buyer, vatId: 'FR00000000000', country: 'FR' } }))
    const file = intrastatFileRows([a, b, c])
    expect(file).toHaveLength(2)
    expect(file[0]).toMatchObject({ destinationCountry: 'DE', value: 630000, netMassKg: '27.750', supplementaryUnits: '15', documents: ['FT-2026-00010', 'FT-2026-00011'] })
    expect(file[1]).toMatchObject({ destinationCountry: 'FR', value: 504000 })
  })
})

describe('the named checks', () => {
  it('a month still running fails PERIOD_ENDED; a failing check needs its explanation in words', () => {
    const running = periodEndedCheck(periodOfMonth('2026-10'), '2026-10-30')
    expect(running.passed).toBe(false)
    expect(periodEndedCheck(periodOfMonth('2026-10'), '2026-11-01').passed).toBe(true)
    const placed = paymentsPlacedCheck([{ id: 'p', reference: 'BONIFICO-1', amount: 40000, placed: 20000, refunded: 0 }])
    expect(placed).toMatchObject({ passed: false, count: 1, fixes: [{ recordType: 'Payment', number: 'BONIFICO-1' }] })
    expect(explanationProblems([running, placed], [{ code: 'PERIOD_ENDED', explanation: 'Mid-month export for the accountant.' }]).map((issue) => issue.path)).toEqual(['body/explanations/PAYMENTS_PLACED'])
    expect(storedChecks([running, placed], [{ code: 'PERIOD_ENDED', explanation: ' Mid-month. ' }, { code: 'PAYMENTS_PLACED', explanation: 'On account.' }])).toEqual([
      { code: 'PERIOD_ENDED', passed: false, count: 1, explanation: 'Mid-month.' },
      { code: 'PAYMENTS_PLACED', passed: false, count: 1, explanation: 'On account.' },
    ])
  })

  it('totals add up to the VAT summary (with or without the stamp duty); the year end wants every site signed off', () => {
    const base = { id: 'i', number: 'FT-1', netTotal: 100000, vatTotal: 22000, grossTotal: 122000, stampDutyAmount: null, vatSummary: [{ rate: '22.00', taxable: 100000, vat: 22000 }] }
    expect(totalsAddUp(base)).toBe(true)
    expect(totalsAddUp({ ...base, grossTotal: 122200, stampDutyAmount: 200 })).toBe(true)
    expect(totalsAddUp({ ...base, vatTotal: 21999 })).toBe(false)
    const count = { id: 'c', number: 'CNT-2026-0001', version: 4, siteId: 's1', siteCode: 'A1', status: 'APPLIED', signedOffAt: null, pdfFileId: null, sheetFileId: null }
    expect(yearEndCheck({ counts: [count], sitesWithStock: [{ siteId: 's1', code: 'A1' }] })).toMatchObject({ passed: false, count: 2 })
    expect(yearEndCheck({ counts: [{ ...count, status: 'SIGNED_OFF' }], sitesWithStock: [{ siteId: 's1', code: 'A1' }] }).passed).toBe(true)
  })

  it('the year-end pack rests on each signed-off inventory and on the valuation at the year end', () => {
    const docs = yearEndDocuments({ companyId: 'co', yearEndDay: '2026-12-31', counts: [{ id: 'c', number: 'CNT-2026-0001', version: 6, siteId: 's1', siteCode: 'A1', status: 'SIGNED_OFF', signedOffAt: null, pdfFileId: 'f1', sheetFileId: 'f2' }], valuation: [] })
    expect(docs.map((doc) => [doc.recordType, doc.number])).toEqual([['StockCount', 'CNT-2026-0001'], ['StockValuation', '2026-12-31']])
    expect(paymentDocument({ id: 'p', version: 1, receivedOn: '2026-10-29', reference: 'R', method: 'BANK_TRANSFER', currency: 'EUR', amount: 100, placed: 100, refunded: 0, paysInvoices: ['FT-1'], paysDeposits: 0, customerCode: 'P1', customerName: 'Cliente' }).rows[0]!.at(-1)).toBe('FT-1')
  })
})
