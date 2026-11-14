import { describe, expect, it } from 'vitest'
import { readCamt053 } from './camt053'
import { readOfx } from './ofx'
import { mapStatementHeaders, readStatementSheet } from './sheet'
import { amountOf, fingerprints, periodOf, StatementReadError } from './statement'

// Every IBAN, name and reference here is made up (bank and branch code 00000).
const ACCOUNT = 'IT60X0000000000000000123456'
const PAYER = 'IT27X0000000000000000370003'
const TODAY = '2026-11-14'

const camt = (entries: string, iban = ACCOUNT) => `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>TEST</MsgId></GrpHdr>
<Stmt><Id>S1</Id><FrToDt><FrDtTm>2026-11-02T00:00:00</FrDtTm><ToDtTm>2026-11-13T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>EUR</Ccy></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`

const entry = (amount: string, side: 'CRDT' | 'DBIT', more = '', status = '<Sts><Cd>BOOK</Cd></Sts>') =>
  `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${side}</CdtDbtInd>${status}<BookgDt><Dt>2026-11-06</Dt></BookgDt><ValDt><Dt>2026-11-07</Dt></ValDt><AcctSvcrRef>REF-${amount}</AcctSvcrRef>${more}</Ntry>`

describe('camt.053', () => {
  it('reads the account, the days and each booked entry with its side, other side and reference text', () => {
    const statement = readCamt053(
      camt(
        entry('410.00', 'CRDT', `<NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>Test Customer One S.r.l.</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>${PAYER}</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>Saldo fattura</Ustrd><Ustrd>FT-2026-00001</Ustrd></RmtInf></TxDtls></NtryDtls>`) +
          entry('56.13', 'DBIT', '<NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Test Supplier</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>') +
          entry('9.99', 'CRDT', '', '<Sts>PDNG</Sts>'),
      ),
      TODAY,
    )
    expect(statement).toMatchObject({ format: 'CAMT053', iban: ACCOUNT, currency: 'EUR', periodStart: '2026-11-02', periodEnd: '2026-11-13' })
    expect(statement.lines).toHaveLength(2)
    expect(statement.lines[0]).toMatchObject({ bookedOn: '2026-11-06', valueOn: '2026-11-07', amount: 41000, bankReference: 'REF-410.00', referenceText: 'Saldo fattura FT-2026-00001', counterpartyName: 'Test Customer One S.r.l.', counterpartyIban: PAYER, problems: [] })
    expect(statement.lines[1]).toMatchObject({ amount: -5613, counterpartyName: 'Test Supplier' })
  })

  it('splits an entry booked for several transactions whose amounts add up to it; keeps it whole otherwise', () => {
    const batch = `<NtryDtls><TxDtls><Amt Ccy="EUR">100.00</Amt><RmtInf><Ustrd>A</Ustrd></RmtInf></TxDtls><TxDtls><Amt Ccy="EUR">50.00</Amt><RmtInf><Ustrd>B</Ustrd></RmtInf></TxDtls></NtryDtls>`
    expect(readCamt053(camt(entry('150.00', 'CRDT', batch)), TODAY).lines.map((line) => [line.amount, line.referenceText])).toEqual([[10000, 'A'], [5000, 'B']])
    expect(readCamt053(camt(entry('160.00', 'CRDT', batch)), TODAY).lines.map((line) => line.amount)).toEqual([16000])
  })

  it('marks a line with more decimals than the currency, and refuses two accounts or another document', () => {
    expect(readCamt053(camt(entry('1.005', 'CRDT')), TODAY).lines[0]!.problems).toEqual(['TOO_MANY_DECIMALS'])
    const two = camt(entry('1.00', 'CRDT')).replace('</Stmt>', `</Stmt><Stmt><Acct><Id><IBAN>${PAYER}</IBAN></Id></Acct>${entry('2.00', 'CRDT')}</Stmt>`)
    expect(() => readCamt053(two, TODAY)).toThrow(StatementReadError)
    expect(() => readCamt053('<Document><Other/></Document>', TODAY)).toThrow(/not a camt.053/)
    expect(() => readCamt053('<<<', TODAY)).toThrow(/could not read this file as XML/)
  })
})

describe('OFX', () => {
  it('reads OFX 1.x where values have no closing tag, a decimal comma, the account and the days', () => {
    const sgml = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKACCTFROM><ACCTID>${ACCOUNT}</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261113
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261106120000[0:GMT]<TRNAMT>410,00<FITID>F-0001<NAME>Test Customer One<MEMO>Saldo FT-2026-00001 &amp; altro</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261107<DTAVAIL>20261108<TRNAMT>-12.50<FITID>F-0002<NAME>Bank charges</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    const statement = readOfx(sgml, TODAY)
    expect(statement).toMatchObject({ format: 'OFX', iban: ACCOUNT, currency: 'EUR', periodStart: '2026-11-01', periodEnd: '2026-11-13' })
    expect(statement.lines.map((line) => [line.bookedOn, line.valueOn, line.amount, line.bankReference, line.counterpartyName, line.referenceText])).toEqual([
      ['2026-11-06', null, 41000, 'F-0001', 'Test Customer One', 'Saldo FT-2026-00001 & altro'],
      ['2026-11-07', '2026-11-08', -1250, 'F-0002', 'Bank charges', null],
    ])
  })

  it('refuses a file that is not OFX, or one with two accounts', () => {
    expect(() => readOfx('not a statement', TODAY)).toThrow(/not an OFX/)
    const account = (id: string) => `<STMTRS><BANKACCTFROM><ACCTID>${id}</ACCTID></BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20261106</DTPOSTED><TRNAMT>1.00</TRNAMT></STMTTRN></BANKTRANLIST></STMTRS>`
    expect(() => readOfx(`<OFX>${account('A1')}${account('A2')}</OFX>`, TODAY)).toThrow(StatementReadError)
  })
})

describe('CSV and Excel sheets', () => {
  it('maps the Italian headers banks use and reads money in and out, day first, in the Italian number format', () => {
    const headers = ['Data contabile', 'Data valuta', 'Entrate', 'Uscite', 'Causale', 'Ordinante']
    expect(mapStatementHeaders(headers).issues).toEqual([])
    const { statement } = readStatementSheet(
      {
        format: 'CSV',
        headers,
        rows: [
          { rowNumber: 2, cells: ['06/11/2026', '07/11/2026', '1.234,56', '', 'Saldo FT-2026-00001', 'Test Customer One'] },
          { rowNumber: 3, cells: ['07/11/2026', '', '', '-12,50', 'Commissioni', ''] },
          { rowNumber: 4, cells: ['08/11/2026', '', '5,00', '5,00', 'Both', ''] },
          { rowNumber: 5, cells: ['31/02/2026', '', '1,00', '', 'Bad day', ''] },
        ],
      },
      { numberFormat: 'it', accountCurrency: 'EUR', today: TODAY },
    )
    expect(statement!.lines.map((line) => [line.row, line.bookedOn, line.valueOn, line.amount, line.problems])).toEqual([
      [2, '2026-11-06', '2026-11-07', 123456, []],
      [3, '2026-11-07', null, -1250, []],
      [4, '2026-11-08', null, null, ['BOTH_SIDES']],
      [5, null, null, 100, ['BAD_DATE']],
    ])
  })

  it('answers no statement while the day or the amount has no column, and takes the person’s mapping', () => {
    const headers = ['Quando', 'Quanto', 'Note']
    const unmapped = readStatementSheet({ format: 'XLSX', headers, rows: [{ rowNumber: 2, cells: ['2026-11-06', 10, 'x'] }] }, { numberFormat: 'en', accountCurrency: 'EUR', today: TODAY })
    expect(unmapped.statement).toBeNull()
    expect(unmapped.mapping.issues.map((issue) => issue.path)).toEqual(['column/bookedOn', 'column/amount'])
    const mapped = readStatementSheet({ format: 'XLSX', headers, rows: [{ rowNumber: 2, cells: ['2026-11-06', 10.5, 'x'] }] }, { overrides: { Quando: 'bookedOn', Quanto: 'amount', Note: 'referenceText' }, numberFormat: 'en', accountCurrency: 'EUR', today: TODAY })
    expect(mapped.statement!.lines[0]).toMatchObject({ bookedOn: '2026-11-06', amount: 1050, referenceText: 'x', problems: [] })
  })
})

describe('the line, its fingerprint and the period', () => {
  it('reads amounts exactly: no rounding, no zero', () => {
    expect(amountOf('410.10', 'EUR')).toEqual({ amount: 41010, problem: null })
    expect(amountOf('-0.5', 'EUR')).toEqual({ amount: -50, problem: null })
    expect(amountOf('12.345', 'EUR')).toEqual({ amount: null, problem: 'TOO_MANY_DECIMALS' })
    expect(amountOf('12.340', 'EUR')).toEqual({ amount: 1234, problem: null })
    expect(amountOf('0.00', 'EUR')).toEqual({ amount: null, problem: 'ZERO_AMOUNT' })
    expect(amountOf('1,00', 'EUR')).toEqual({ amount: null, problem: 'BAD_AMOUNT' })
  })

  it('gives two equal lines of a file two fingerprints, and the same file the same ones again', () => {
    const line = { bookedOn: '2026-11-06', amount: -150, bankReference: null, referenceText: 'Commissione  bonifico' }
    const first = fingerprints('acc-1', [line, { ...line, referenceText: 'COMMISSIONE BONIFICO' }])
    expect(first[0]).not.toBe(first[1])
    expect(fingerprints('acc-1', [line, line])).toEqual(first)
    expect(fingerprints('acc-2', [line])[0]).not.toBe(first[0])
    expect(first[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('keeps the file’s days when they hold every line and end by today, else its lines’ days', () => {
    const lines = [{ bookedOn: '2026-11-06' }, { bookedOn: '2026-11-09' }]
    expect(periodOf({ periodStart: '2026-11-01', periodEnd: '2026-11-13', lines: lines as never }, TODAY)).toEqual({ start: '2026-11-01', end: '2026-11-13' })
    expect(periodOf({ periodStart: '2026-11-07', periodEnd: '2026-11-13', lines: lines as never }, TODAY)).toEqual({ start: '2026-11-06', end: '2026-11-09' })
    expect(periodOf({ periodStart: '2026-11-01', periodEnd: '2026-11-30', lines: lines as never }, TODAY)).toEqual({ start: '2026-11-06', end: '2026-11-09' })
  })
})
