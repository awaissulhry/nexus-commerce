import type { BusinessDate } from '../../core/time'
import { child, children, parseXml, textAt, XmlReadError, type XmlNode } from '../../payables/xml'
import { amountOf, ibanShape, isoDay, lineProblems, MAX_STATEMENT_LINES, oneLine, StatementReadError, type BankLineProblem, type ParsedLine, type ParsedStatement } from './statement'

/**
 * ISO 20022 camt.053 (the bank-to-customer statement XML, versions .001.02 to .001.13 alike), pure: Document /
 * BkToCstmrStmt / Stmt — the account (Acct/Id/IBAN, Acct/Ccy), the days (FrToDt), and every BOOKED entry (Ntry with Sts
 * BOOK, or Sts/Cd BOOK): its amount and side (Amt, CdtDbtInd: DBIT is money out), booking and value day (BookgDt, ValDt:
 * Dt or DtTm), the bank's reference (AcctSvcrRef), the reference text (every RmtInf/Ustrd, else AddtlTxInf, else
 * AddtlNtryInf), and the other side (money in: Dbtr and DbtrAcct; money out: Cdtr and CdtrAcct; a name under Pty in the
 * newer versions). An entry booked as one amount for several transactions (a batch, TxDtls with their own amounts that
 * add up to it) is read as one line per transaction; otherwise one line per entry. Pending (PDNG) and information (INFO)
 * entries are not movements and are skipped. Several Stmt of one account are read together; of two accounts the file is
 * refused (one account per import).
 */

const statusOf = (entry: XmlNode): string | null => textAt(entry, 'Sts', 'Cd') ?? textAt(entry, 'Sts')

const dayAt = (node: XmlNode | null, name: string): BusinessDate | null => isoDay(textAt(node, name, 'Dt') ?? textAt(node, name, 'DtTm'))

/** A party's name: Nm, or Pty/Nm (camt.053.001.08 and later). */
const nameOf = (party: XmlNode | null): string | null => textAt(party, 'Nm') ?? textAt(party, 'Pty', 'Nm')

interface Piece {
  readonly amountText: string | null
  readonly currency: string | null
  readonly debit: boolean
  readonly bankReference: string | null
  readonly referenceText: string | null
  readonly counterpartyName: string | null
  readonly counterpartyIban: string | null
}

/** What one transaction (TxDtls) says, against its entry's side. */
function pieceOf(entry: XmlNode, details: XmlNode | null, entryDebit: boolean): Piece {
  const amountNode = child(details, 'Amt') ?? child(details, 'AmtDtls', 'TxAmt', 'Amt') ?? null
  const debit = (textAt(details, 'CdtDbtInd') ?? (entryDebit ? 'DBIT' : 'CRDT')) === 'DBIT'
  const parties = child(details, 'RltdPties')
  const other = debit ? { party: child(parties, 'Cdtr'), account: child(parties, 'CdtrAcct') } : { party: child(parties, 'Dbtr'), account: child(parties, 'DbtrAcct') }
  const unstructured = children(details, 'RmtInf', 'Ustrd').map((node) => node.text.trim()).filter((text) => text !== '')
  const text = unstructured.length > 0 ? unstructured.join(' ') : (textAt(details, 'AddtlTxInf') ?? textAt(entry, 'AddtlNtryInf'))
  return {
    amountText: amountNode ? amountNode.text.trim() : null,
    currency: amountNode?.attributes.Ccy ?? null,
    debit,
    bankReference: textAt(details, 'Refs', 'AcctSvcrRef') ?? textAt(entry, 'AcctSvcrRef') ?? textAt(entry, 'NtryRef'),
    referenceText: text,
    counterpartyName: nameOf(other.party),
    counterpartyIban: textAt(other.account, 'Id', 'IBAN'),
  }
}

/** The pieces of one entry: its transactions when they carry amounts that add up to it, else the entry whole. */
function piecesOf(entry: XmlNode, entryAmount: string | null, entryCurrency: string | null, entryDebit: boolean): Piece[] {
  const details = children(entry, 'NtryDtls').flatMap((node) => children(node, 'TxDtls'))
  if (details.length > 1) {
    const pieces = details.map((node) => pieceOf(entry, node, entryDebit))
    const amounts = pieces.map((piece) => (piece.amountText !== null && piece.currency !== null ? amountOf(piece.amountText, piece.currency).amount : null))
    const whole = entryAmount !== null && entryCurrency !== null ? amountOf(entryAmount, entryCurrency).amount : null
    if (whole !== null && amounts.every((amount) => amount !== null) && pieces.every((piece) => piece.debit === entryDebit) && amounts.reduce<number>((sum, amount) => sum + amount!, 0) === whole) return pieces
  }
  const only = pieceOf(entry, details[0] ?? null, entryDebit)
  return [{ ...only, amountText: entryAmount, currency: entryCurrency, debit: entryDebit }]
}

/** Reads a camt.053 file; StatementReadError when it is not one or holds two accounts. */
export function readCamt053(source: string, today: BusinessDate): ParsedStatement {
  let root: XmlNode
  try {
    root = parseXml(source)
  } catch (error) {
    if (error instanceof XmlReadError) throw new StatementReadError('UNREADABLE', `We could not read this file as XML: ${error.message}`)
    throw error
  }
  const report = root.name === 'Document' ? child(root, 'BkToCstmrStmt') : root.name === 'BkToCstmrStmt' ? root : null
  if (!report) throw new StatementReadError('NOT_THIS_FORMAT', 'This file is not a camt.053 bank statement (no BkToCstmrStmt).')
  const statements = children(report, 'Stmt')
  if (statements.length === 0) throw new StatementReadError('NO_LINES')
  const ibans = [...new Set(statements.map((stmt) => ibanShape(textAt(stmt, 'Acct', 'Id', 'IBAN'))))]
  if (ibans.length > 1) throw new StatementReadError('SEVERAL_ACCOUNTS')
  const iban = ibans[0] ?? null
  const currency = textAt(statements[0], 'Acct', 'Ccy')
  const starts = statements.map((stmt) => isoDay(textAt(stmt, 'FrToDt', 'FrDtTm'))).filter((day): day is BusinessDate => day !== null).sort()
  const ends = statements.map((stmt) => isoDay(textAt(stmt, 'FrToDt', 'ToDtTm'))).filter((day): day is BusinessDate => day !== null).sort()

  const lines: ParsedLine[] = []
  let row = 0
  for (const stmt of statements) {
    for (const entry of children(stmt, 'Ntry')) {
      row += 1
      const status = statusOf(entry)
      if (status !== null && status !== 'BOOK') continue
      const amountNode = child(entry, 'Amt')
      const entryDebit = textAt(entry, 'CdtDbtInd') === 'DBIT'
      const bookedOn = dayAt(entry, 'BookgDt')
      const valueOn = dayAt(entry, 'ValDt')
      for (const piece of piecesOf(entry, amountNode ? amountNode.text.trim() : null, amountNode?.attributes.Ccy ?? currency, entryDebit)) {
        const found: BankLineProblem[] = []
        const lineCurrency = piece.currency ?? currency
        let amount: number | null = null
        if (piece.amountText !== null && lineCurrency !== null) {
          const read = amountOf(piece.amountText, lineCurrency)
          if (read.problem) found.push(read.problem)
          else amount = piece.debit ? -Math.abs(read.amount!) : Math.abs(read.amount!)
        }
        if (textAt(entry, 'BookgDt', 'Dt') !== null && bookedOn === null) found.push('BAD_DATE')
        const line = {
          row,
          bookedOn,
          valueOn,
          amount,
          currency: lineCurrency,
          bankReference: oneLine(piece.bankReference),
          referenceText: oneLine(piece.referenceText, 1000),
          counterpartyName: oneLine(piece.counterpartyName, 140),
          counterpartyIban: ibanShape(piece.counterpartyIban),
        }
        lines.push({ ...line, problems: lineProblems(line, found, today, currency) })
        if (lines.length > MAX_STATEMENT_LINES) throw new StatementReadError('TOO_MANY_LINES')
      }
    }
  }
  if (lines.length === 0) throw new StatementReadError('NO_LINES')
  return { format: 'CAMT053', iban, currency, periodStart: starts[0] ?? null, periodEnd: ends[ends.length - 1] ?? null, lines }
}
