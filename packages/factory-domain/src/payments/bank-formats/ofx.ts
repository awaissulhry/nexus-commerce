import type { BusinessDate } from '../../core/time'
import { amountOf, ibanShape, isoDay, lineProblems, MAX_STATEMENT_LINES, oneLine, StatementReadError, type BankLineProblem, type ParsedLine, type ParsedStatement } from './statement'

/**
 * Open Financial Exchange (OFX 1.x in SGML, where a value's closing tag may be left out, and OFX 2.x in XML), pure: the
 * account (BANKACCTFROM / ACCTID, an IBAN for most European banks; CURDEF), the days (BANKTRANLIST DTSTART, DTEND) and
 * every transaction (STMTTRN): DTPOSTED (the booking day), DTAVAIL (the value day), TRNAMT (signed: below 0 is money
 * out; a decimal comma is read too), FITID (the bank's own id: the line's reference), NAME or PAYEE/NAME (the other
 * side), MEMO (the reference text), BANKACCTTO / ACCTID (the other side's account, when it is an IBAN). The header
 * (OFXHEADER:100 …, or the XML declaration) is skipped. Two accounts in one file are refused (one account per import).
 */

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

const decode = (text: string): string => text.replace(/&(#\d+|[a-z]+);/gi, (whole, body: string) => (body.startsWith('#') ? String.fromCodePoint(Number.parseInt(body.slice(1), 10)) : (ENTITIES[body.toLowerCase()] ?? whole)))

/** The value of a leaf element (`<TAG>value`, closed or not) inside `block`, or null. */
function valueOf(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block)
  const value = match ? decode(match[1]!).trim() : ''
  return value === '' ? null : value
}

/** Every `<TAG>…</TAG>` aggregate in `body`. */
function blocksOf(body: string, tag: string): string[] {
  return [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))].map((match) => match[1]!)
}

/** An OFX date (YYYYMMDD, maybe with a time and a zone) as a day. */
const ofxDay = (value: string | null): BusinessDate | null => {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value ?? '')
  return match ? isoDay(`${match[1]}-${match[2]}-${match[3]}`) : null
}

/** A TRNAMT as a decimal with a point ("-56,913.00" stays refused; "1234,56" is read as 1234.56). */
const decimalText = (value: string): string => (value.includes('.') ? value : value.replace(',', '.')).replace(/^\+/, '')

/** Reads an OFX file; StatementReadError when it is not one or holds two accounts. */
export function readOfx(source: string, today: BusinessDate): ParsedStatement {
  const start = source.search(/<OFX>/i)
  if (start === -1) throw new StatementReadError('NOT_THIS_FORMAT', 'This file is not an OFX statement (no <OFX> element).')
  const body = source.slice(start)
  const statements = blocksOf(body, 'STMTRS')
  if (statements.length === 0) throw new StatementReadError('NO_LINES', 'The file holds no bank statement (STMTRS): a credit card statement is not imported here.')
  const accounts = [...new Set(statements.map((stmt) => valueOf(blocksOf(stmt, 'BANKACCTFROM')[0] ?? '', 'ACCTID')))]
  if (accounts.length > 1) throw new StatementReadError('SEVERAL_ACCOUNTS')
  const currency = valueOf(statements[0]!, 'CURDEF')
  const starts = statements.map((stmt) => ofxDay(valueOf(blocksOf(stmt, 'BANKTRANLIST')[0] ?? '', 'DTSTART'))).filter((day): day is BusinessDate => day !== null).sort()
  const ends = statements.map((stmt) => ofxDay(valueOf(blocksOf(stmt, 'BANKTRANLIST')[0] ?? '', 'DTEND'))).filter((day): day is BusinessDate => day !== null).sort()

  const lines: ParsedLine[] = []
  let row = 0
  for (const stmt of statements) {
    for (const transaction of blocksOf(stmt, 'STMTTRN')) {
      row += 1
      const found: BankLineProblem[] = []
      const posted = valueOf(transaction, 'DTPOSTED')
      const bookedOn = ofxDay(posted)
      if (posted !== null && bookedOn === null) found.push('BAD_DATE')
      const lineCurrency = valueOf(transaction, 'CURRENCY') ?? currency
      const amountText = valueOf(transaction, 'TRNAMT')
      let amount: number | null = null
      if (amountText !== null) {
        const read = amountOf(decimalText(amountText), lineCurrency ?? 'EUR')
        if (read.problem) found.push(read.problem)
        else amount = read.amount
      }
      const payee = blocksOf(transaction, 'PAYEE')[0]
      const line = {
        row,
        bookedOn,
        valueOn: ofxDay(valueOf(transaction, 'DTAVAIL')),
        amount,
        currency: lineCurrency,
        bankReference: oneLine(valueOf(transaction, 'FITID')),
        referenceText: oneLine(valueOf(transaction, 'MEMO'), 1000),
        counterpartyName: oneLine(valueOf(transaction, 'NAME') ?? (payee ? valueOf(payee, 'NAME') : null), 140),
        counterpartyIban: ibanShape(valueOf(blocksOf(transaction, 'BANKACCTTO')[0] ?? '', 'ACCTID')),
      }
      lines.push({ ...line, problems: lineProblems(line, found, today, currency) })
      if (lines.length > MAX_STATEMENT_LINES) throw new StatementReadError('TOO_MANY_LINES')
    }
  }
  if (lines.length === 0) throw new StatementReadError('NO_LINES')
  return { format: 'OFX', iban: ibanShape(accounts[0] ?? null), currency, periodStart: starts[0] ?? null, periodEnd: ends[ends.length - 1] ?? null, lines }
}
