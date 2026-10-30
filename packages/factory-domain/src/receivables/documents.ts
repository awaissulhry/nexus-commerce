import { ValidationError } from '../core/errors'
import type { MinorUnits } from '../core/money'
import { businessDayStart, toUtcIso, type BusinessDate } from '../core/time'
import type { ComposedColumn, ComposedDocument } from '../documents/compose'
import { formatDate, formatMoney } from '../documents/format'
import { DOCUMENT_WORDS } from '../documents/i18n'
import { addressLine, legalFooter, legalLines, legalName, legalProblems } from '../documents/legal'
import type { CompanyLegal, DocumentLanguage, DocumentType, PostalAddress } from '../documents/model'
import type { AgeingTotals, Statement, StatementLine } from './ledger'
import type { ReminderAction } from './ladder'

/**
 * The receivables' printed documents (B-W2a-55; design finance.receivables, new tab "Statement (PDF)": "Document to print
 * or send"; a LETTER reminder), pure: the customer's statement of account and the reminder letter, composed as the
 * platform's documents are (the company's c.c. art. 2250 letterhead from its Company row, every word in the document's
 * language, every number formatted) and painted by the API with the same painter (platform/documents pdf.ts).
 *
 * The documents domain (documents/model DOCUMENT_TYPES) has no STATEMENT or REMINDER_LETTER type yet and is not this
 * step's: the composition is built here in its shape, with its own layout ids (STATEMENT/1, REMINDER_LETTER/1). The
 * painter reads the words, columns and rows, never the type.
 */

export const STATEMENT_LAYOUT = 'STATEMENT/1'
export const LETTER_LAYOUT = 'REMINDER_LETTER/1'

/** The documents domain's type list has neither: the painter never reads the type (see the file's comment). */
const typeOf = (name: 'STATEMENT' | 'REMINDER_LETTER'): DocumentType => name as unknown as DocumentType

export interface DocumentCustomer {
  readonly name: string
  readonly code: string
  readonly address: PostalAddress | null
  readonly vatNumber: string | null
}

const WORDS = {
  it: {
    statement: 'Estratto conto',
    letter: 'Sollecito di pagamento',
    issuer: 'Società',
    customer: 'Cliente',
    date: 'Data',
    period: 'Periodo',
    code: 'Codice cliente',
    vat: 'P.IVA',
    columns: { date: 'Data', document: 'Documento', due: 'Scadenza', debit: 'Dare', credit: 'Avere', balance: 'Saldo' },
    letterColumns: { invoice: 'Fattura', date: 'Data', due: 'Scadenza', late: 'Giorni di ritardo', amount: 'Importo' },
    kinds: { TD01: 'Fattura', TD24: 'Fattura differita', TD02: 'Fattura di acconto', TD04: 'Nota di credito', PAYMENT: 'Pagamento ricevuto', REFUND: 'Rimborso al cliente' },
    reference: 'rif.',
    none: 'Nessun movimento nel periodo',
    opening: 'Saldo iniziale',
    invoiced: 'Fatture',
    credited: 'Note di credito',
    paid: 'Pagamenti',
    refunded: 'Rimborsi',
    closing: 'Saldo finale',
    open: 'Fatture aperte',
    overdue: 'Di cui scaduto',
    sign: 'Saldo positivo: importo dovuto dal cliente; saldo negativo: credito del cliente.',
    level: 'Livello',
    subject: 'Oggetto',
    text: 'Testo',
    total: 'Totale',
    interest: 'Interessi di mora',
  },
  en: {
    statement: 'Statement of account',
    letter: 'Payment reminder',
    issuer: 'Company',
    customer: 'Customer',
    date: 'Date',
    period: 'Period',
    code: 'Customer code',
    vat: 'VAT',
    columns: { date: 'Date', document: 'Document', due: 'Due', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
    letterColumns: { invoice: 'Invoice', date: 'Date', due: 'Due', late: 'Days late', amount: 'Amount' },
    kinds: { TD01: 'Invoice', TD24: 'Deferred invoice', TD02: 'Deposit invoice', TD04: 'Credit note', PAYMENT: 'Payment received', REFUND: 'Refund to the customer' },
    reference: 'ref.',
    none: 'No movements in the period',
    opening: 'Opening balance',
    invoiced: 'Invoices',
    credited: 'Credit notes',
    paid: 'Payments',
    refunded: 'Refunds',
    closing: 'Closing balance',
    open: 'Open invoices',
    overdue: 'Of which overdue',
    sign: 'A positive balance is owed by the customer; a negative one is the customer\'s credit.',
    level: 'Level',
    subject: 'Subject',
    text: 'Text',
    total: 'Total',
    interest: 'Late-payment interest',
  },
} as const

/** A statement line's document in words: "Fattura FT-2026-00001", "Pagamento ricevuto (rif. CRO123)". */
export function movementLabel(line: Pick<StatementLine, 'kind' | 'docType' | 'reference'>, language: DocumentLanguage): string {
  const words = WORDS[language]
  if (line.kind === 'PAYMENT' || line.kind === 'REFUND') return `${words.kinds[line.kind]}${line.reference ? ` (${words.reference} ${line.reference})` : ''}`
  const kind = line.docType && line.docType in words.kinds ? words.kinds[line.docType as keyof typeof words.kinds] : words.kinds.TD01
  return `${kind} ${line.reference ?? ''}`.trim()
}

const column = (key: ComposedColumn['key'], width: number, align: 'left' | 'right', label: string): ComposedColumn => ({ key, width, align, label })

function letterhead(company: CompanyLegal, language: DocumentLanguage) {
  const problems = legalProblems(company)
  if (problems.length > 0) throw new ValidationError('The document cannot be printed as it stands.', problems)
  return { name: legalName(company, language), lines: legalLines(company, language) }
}

function customerLines(customer: DocumentCustomer, language: DocumentLanguage): string[] {
  const words = WORDS[language]
  return [customer.name, ...(customer.address ? [addressLine(customer.address, language)] : []), ...(customer.vatNumber ? [`${words.vat} ${customer.vatNumber}`] : [])]
}

const footerOf = (company: CompanyLegal, language: DocumentLanguage) => ({
  legal: legalFooter(company, language),
  text: company.documentFooter?.trim() ? company.documentFooter.trim() : null,
  page: DOCUMENT_WORDS[language].page,
  continued: DOCUMENT_WORDS[language].continued,
})

export interface StatementDocumentInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly customer: DocumentCustomer
  readonly currency: string
  readonly statement: Statement
  /** What is open on its invoices at the end of the period (the ageing). */
  readonly open: AgeingTotals
  /** The day it is printed. */
  readonly printedOn: BusinessDate
  readonly note?: string | null
}

/** The customer's statement of account: opening balance + invoices − payments − credits = running balance. */
export function statementDocument(input: StatementDocumentInput): ComposedDocument {
  const { language, statement, currency } = input
  const words = WORDS[language]
  const head = letterhead(input.company, language)
  const money = (amount: MinorUnits) => formatMoney(amount, currency, language)
  const columns = [
    column('code', 120, 'left', words.columns.date),
    column('description', 330, 'left', words.columns.document),
    column('delivery', 110, 'left', words.columns.due),
    column('unitPrice', 145, 'right', words.columns.debit),
    column('discount', 145, 'right', words.columns.credit),
    column('amount', 150, 'right', words.columns.balance),
  ]
  const rows = statement.lines.map((line) => [
    formatDate(line.date, language),
    movementLabel(line, language),
    line.dueDate ? formatDate(line.dueDate, language) : '',
    line.debit ? money(line.debit) : '',
    line.credit ? money(line.credit) : '',
    money(line.balance),
  ])
  const period = `${formatDate(statement.from, language)} – ${formatDate(statement.to, language)}`
  return {
    type: typeOf('STATEMENT'),
    language,
    layout: STATEMENT_LAYOUT,
    title: words.statement,
    issuer: { heading: words.issuer, name: head.name, lines: head.lines },
    identity: [
      { label: words.date, value: formatDate(input.printedOn, language) },
      { label: words.period, value: period },
    ],
    banner: null,
    blocks: [{ heading: words.customer, lines: customerLines(input.customer, language) }],
    facts: [
      { label: words.code, value: input.customer.code },
      { label: words.opening, value: money(statement.opening) },
    ],
    table: { columns, rows: rows.length > 0 ? rows : [['', words.none, '', '', '', money(statement.opening)]] },
    totals: [
      { label: words.opening, value: money(statement.opening), strong: false },
      { label: words.invoiced, value: money(statement.totals.invoiced), strong: false },
      { label: words.credited, value: money(-statement.totals.credited), strong: false },
      { label: words.paid, value: money(-statement.totals.paid), strong: false },
      ...(statement.totals.refunded ? [{ label: words.refunded, value: money(statement.totals.refunded), strong: false }] : []),
      { label: words.closing, value: money(statement.closing), strong: true },
      { label: words.open, value: money(input.open.open), strong: false },
      { label: words.overdue, value: money(input.open.overdue), strong: true },
    ],
    notes: input.note?.trim() ? { label: words.text, value: input.note.trim() } : null,
    notices: [words.sign],
    signatures: [],
    footer: footerOf(input.company, language),
    meta: {
      title: `${words.statement} ${input.customer.code} ${statement.to}`,
      author: head.name,
      subject: `${STATEMENT_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.printedOn)),
      keywords: ['STATEMENT', input.customer.code, statement.from, statement.to].join(' '),
    },
  }
}

export interface LetterDocumentInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly customer: DocumentCustomer
  readonly currency: string
  readonly level: number
  readonly action: ReminderAction
  readonly subject: string
  readonly body: string
  readonly lines: readonly { readonly number: string; readonly issueDate: BusinessDate; readonly dueDate: BusinessDate; readonly daysLate: number; readonly claimed: MinorUnits }[]
  readonly amountDue: MinorUnits
  readonly interestAmount: MinorUnits | null
  readonly printedOn: BusinessDate
}

/** A reminder sent as a letter: the approved text, with its invoices in a table. */
export function letterDocument(input: LetterDocumentInput): ComposedDocument {
  const { language, currency } = input
  const words = WORDS[language]
  const head = letterhead(input.company, language)
  const money = (amount: MinorUnits) => formatMoney(amount, currency, language)
  const columns = [
    column('code', 250, 'left', words.letterColumns.invoice),
    column('delivery', 170, 'left', words.letterColumns.date),
    column('goods', 170, 'left', words.letterColumns.due),
    column('quantity', 150, 'right', words.letterColumns.late),
    column('amount', 260, 'right', words.letterColumns.amount),
  ]
  return {
    type: typeOf('REMINDER_LETTER'),
    language,
    layout: LETTER_LAYOUT,
    title: words.letter,
    issuer: { heading: words.issuer, name: head.name, lines: head.lines },
    identity: [
      { label: words.date, value: formatDate(input.printedOn, language) },
      { label: words.level, value: String(input.level) },
    ],
    banner: null,
    blocks: [{ heading: words.customer, lines: customerLines(input.customer, language) }],
    facts: [{ label: words.subject, value: input.subject }],
    table: {
      columns,
      rows: input.lines.map((line) => [line.number, formatDate(line.issueDate, language), formatDate(line.dueDate, language), line.daysLate > 0 ? String(line.daysLate) : '', money(line.claimed)]),
    },
    totals: [
      { label: words.total, value: money(input.amountDue), strong: true },
      ...(input.interestAmount ? [{ label: words.interest, value: money(input.interestAmount), strong: false }] : []),
    ],
    notes: { label: words.text, value: input.body },
    notices: [],
    signatures: [],
    footer: footerOf(input.company, language),
    meta: {
      title: `${words.letter} ${input.customer.code} ${input.printedOn}`,
      author: head.name,
      subject: `${LETTER_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.printedOn)),
      keywords: ['REMINDER_LETTER', input.customer.code, String(input.level), input.printedOn].join(' '),
    },
  }
}
