import { ValidationError } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { businessDayStart, toUtcIso, type BusinessDate } from '../../core/time'
import type { ComposedColumn, ComposedDocument } from '../../documents/compose'
import { formatDate, formatDecimal, formatMoney, formatUnitPrice } from '../../documents/format'
import { DOCUMENT_WORDS } from '../../documents/i18n'
import { legalFooter, legalLines, legalName, legalProblems } from '../../documents/legal'
import type { CompanyLegal, DocumentLanguage, DocumentType } from '../../documents/model'
import type { StatementSummary } from '../earnings/statement'

/**
 * My statement as a PDF (B-W2b-68; design floor.myday new tab "My statement (PDF)"; c.c. art. 2101 c.3), pure: an APPROVED
 * statement on the company's letterhead, from the frozen row the office approved. No other person, no line figure. The
 * metadata comes from the statement (its creation date is the approval), so the same statement gives the same file. Only
 * APPROVED ones are ever drawn: the routes refuse the rest.
 */

export const MY_STATEMENT_LAYOUT = 'MY_STATEMENT/1'

const WORDS = {
  it: {
    title: 'Il mio prospetto',
    issuer: 'Datore di lavoro',
    month: 'Mese',
    revision: 'Revisione',
    approvedOn: 'Approvato il',
    worker: 'Lavoratore',
    code: 'Matricola',
    operation: 'Operazione',
    description: 'Descrizione',
    pieces: 'Pezzi',
    minutes: 'Minuti standard',
    rate: 'Tariffa',
    amount: 'Importo',
    share: 'quota',
    time: 'Tempo pagato fuori cottimo',
    correction: 'Correzione',
    earnings: 'Guadagni del mese',
    guaranteed: 'Paga garantita',
    earned: 'Maturato a cottimo',
    makeUp: 'Integrazione alla paga garantita',
    total: 'Totale',
    ordinary: 'Minuti ordinari presenti',
    overtime: 'Straordinario approvato (minuti)',
    held: 'Scansioni sospese',
    heldValue: '{open} aperte, {counted} contate, {notPaid} non pagate',
    defects: 'Scarti e rilavorazioni sulle proprie scansioni',
    defectsValue: '{scrap} scarti, {rework} rilavorazioni',
    none: 'Nessun lavoro a cottimo in questo mese.',
    notice: 'Prospetto dei dati di lavorazione e dei guadagni a cottimo (art. 2101 c.c.). Se una voce è sbagliata, contestala da La mia giornata sul terminale.',
  },
  en: {
    title: 'My statement',
    issuer: 'Employer',
    month: 'Month',
    revision: 'Revision',
    approvedOn: 'Approved on',
    worker: 'Worker',
    code: 'Employee code',
    operation: 'Operation',
    description: 'Description',
    pieces: 'Pieces',
    minutes: 'Standard minutes',
    rate: 'Rate',
    amount: 'Amount',
    share: 'share',
    time: 'Paid time off standard',
    correction: 'Correction',
    earnings: 'Earnings of the month',
    guaranteed: 'Guaranteed pay',
    earned: 'Earned by the piece',
    makeUp: 'Make-up to guaranteed pay',
    total: 'Total',
    ordinary: 'Ordinary minutes present',
    overtime: 'Approved overtime (minutes)',
    held: 'Held scans',
    heldValue: '{open} open, {counted} counted, {notPaid} not paid',
    defects: 'Scrap and rework on your own scans',
    defectsValue: '{scrap} scrap, {rework} rework',
    none: 'No piece work this month.',
    notice: 'Statement of the work done and the piece-work earnings (c.c. art. 2101). If an entry is wrong, dispute it from My day on the tablet.',
  },
} as const

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
const column = (key: ComposedColumn['key'], width: number, align: ComposedColumn['align'], label: string): ComposedColumn => ({ key, width, align, label })

export interface MyStatementInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly person: { readonly name: string; readonly code: string | null }
  readonly month: string
  readonly revision: number
  readonly approvedOn: BusinessDate
  readonly summary: StatementSummary
  readonly earningsAmount: MinorUnits
  readonly makeUpAmount: MinorUnits
}

/** The statement in its fixed layout. Refuses a company whose legal data are incomplete, as every company document. */
export function myStatementDocument(input: MyStatementInput): ComposedDocument {
  const { language, summary } = input
  const words = WORDS[language]
  const problems = legalProblems(input.company)
  if (problems.length > 0) throw new ValidationError('The document cannot be printed as it stands.', problems)
  const money = (amount: MinorUnits) => formatMoney(amount, summary.currency, language)
  const minutes = (value: string) => formatDecimal(value, language, 0, 3)
  const pieces = summary.lines.map((line) => [line.operationCode, line.sharePct ? `${line.operationName} (${words.share} ${formatDecimal(line.sharePct, language, 0, 2)}%)` : line.operationName, String(line.pieces), minutes(line.minutes), formatUnitPrice(line.rate, language), money(line.amount)])
  const time = summary.time.map((line) => [line.code, words.time, '', minutes(line.minutes), formatUnitPrice(line.rate, language), money(line.amount)])
  const corrections = summary.corrections.map((line) => ['', [words.correction, line.month, line.words].filter(Boolean).join(' · '), '', '', '', money(line.amount)])
  const rows = [...pieces, ...time, ...corrections]
  const name = legalName(input.company, language)
  return {
    // The renderer reads no type: a statement is no fiscal or sales document, and has no number of its own.
    type: 'WORKER_STATEMENT' as unknown as DocumentType,
    language,
    layout: MY_STATEMENT_LAYOUT,
    title: words.title,
    issuer: { heading: words.issuer, name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.month, value: input.month },
      { label: words.revision, value: String(input.revision) },
      { label: words.approvedOn, value: formatDate(input.approvedOn, language) },
    ],
    banner: null,
    blocks: [{ heading: words.worker, lines: [input.person.name, ...(input.person.code ? [`${words.code} ${input.person.code}`] : [])] }],
    facts: [
      ...(summary.attendance ? [{ label: words.ordinary, value: String(summary.attendance.ordinaryMinutes) }, { label: words.overtime, value: String(summary.attendance.approvedOvertimeMinutes) }] : []),
      { label: words.held, value: fill(words.heldValue, summary.held) },
      { label: words.defects, value: fill(words.defectsValue, summary.defects) },
    ],
    table: {
      columns: [column('code', 150, 'left', words.operation), column('description', 370, 'left', words.description), column('quantity', 100, 'right', words.pieces), column('delivery', 130, 'right', words.minutes), column('unitPrice', 120, 'right', words.rate), column('amount', 130, 'right', words.amount)],
      rows: rows.length > 0 ? rows : [['', words.none, '', '', '', '']],
    },
    totals: [
      { label: words.earnings, value: money(input.earningsAmount), strong: false },
      ...(summary.makeUp ? [{ label: words.guaranteed, value: money(summary.makeUp.guaranteed), strong: false }, { label: words.earned, value: money(summary.makeUp.earned), strong: false }] : []),
      { label: words.makeUp, value: money(input.makeUpAmount), strong: false },
      { label: words.total, value: money(input.earningsAmount + input.makeUpAmount), strong: true },
    ],
    notes: null,
    notices: [words.notice],
    signatures: [],
    footer: { legal: legalFooter(input.company, language), text: input.company.documentFooter?.trim() ? input.company.documentFooter.trim() : null, page: DOCUMENT_WORDS[language].page, continued: DOCUMENT_WORDS[language].continued },
    meta: {
      title: `${words.title} ${input.person.code ?? ''} ${input.month}`.replace(/\s+/g, ' ').trim(),
      author: name,
      subject: `${MY_STATEMENT_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.approvedOn)),
      keywords: ['WORKER_STATEMENT', input.month, String(input.revision)].join(' '),
    },
  }
}
