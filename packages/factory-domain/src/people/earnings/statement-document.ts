import { ValidationError } from '../../core/errors'
import type { MinorUnits } from '../../core/money'
import { businessDayStart, toUtcIso, type BusinessDate } from '../../core/time'
import type { ComposedColumn, ComposedDocument } from '../../documents/compose'
import { formatDate, formatDecimal, formatMoney, formatUnitPrice } from '../../documents/format'
import { DOCUMENT_WORDS } from '../../documents/i18n'
import { legalFooter, legalLines, legalName, legalProblems } from '../../documents/legal'
import type { CompanyLegal, DocumentLanguage, DocumentType } from '../../documents/model'
import type { StatementSummary } from './statement'

/**
 * The worker statement as a document (B-W2b-62; design people.piecerates new tab "Worker statement (PDF)"; c.c. art. 2101 c.3:
 * the quantity of work done and the time taken), pure: every word and number decided here, on the company's letterhead
 * (c.c. art. 2250), from the frozen statement row: the ONE statement document, the office's route and the floor's My day
 * (people/myday/statement-document.ts) print this, so they give the same file. The metadata come from
 * the statement only (its creation date is the approval), so the same statement gives the same bytes. A statement that is
 * not approved says so on a banner: it may still change; only an approved one is stored.
 */

export const WORKER_STATEMENT_LAYOUT = 'WORKER_STATEMENT/1'
const typeOf = (name: 'WORKER_STATEMENT'): DocumentType => name as unknown as DocumentType

const WORDS = {
  it: {
    title: 'Prospetto di cottimo',
    issuer: 'Datore di lavoro',
    period: 'Mese',
    revision: 'Revisione',
    approvedOn: 'Approvato il',
    worker: 'Lavoratore',
    code: 'Matricola',
    pieces: { code: 'Operazione', description: 'Descrizione', quantity: 'Pezzi', minutes: 'Minuti standard', rate: 'Tariffa', amount: 'Importo' },
    share: 'quota {share}',
    time: 'Tempo pagato fuori cottimo',
    corrections: 'Correzioni',
    correctsMonth: 'Lavoro di {month}',
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
    defectsOthers: '{scrap} scarti, {rework} rilavorazioni (di cui per causa altrui: {othersScrap} scarti, {othersRework} rilavorazioni)',
    bonus: 'Premio a minuti standard',
    bonusFacts: 'Rendimento',
    bonusValue: '{efficiency}%: {standard} minuti standard su {present} minuti presenti, soglia {threshold}, premio su {above} minuti',
    bonusNotice: 'Con lo schema a premio i pezzi non sono pagati a cottimo: misurano il premio. La paga garantita copre i minuti presenti.',
    none: 'Nessun lavoro a cottimo in questo mese.',
    draft: 'BOZZA: non approvato, può ancora cambiare',
    superseded: 'SOSTITUITO da una revisione successiva',
    notice: 'Prospetto dei dati di lavorazione e dei guadagni a cottimo (art. 2101 c.c.). Scarti e rilavorazioni sulle proprie scansioni sono pagati secondo la causa: per propria colpa con la regola dello schema, per causa altrui come tempo pagato. Se una voce è sbagliata, contestala da La mia giornata sul terminale.',
  },
  en: {
    title: 'Piece-work statement',
    issuer: 'Employer',
    period: 'Month',
    revision: 'Revision',
    approvedOn: 'Approved on',
    worker: 'Worker',
    code: 'Employee code',
    pieces: { code: 'Operation', description: 'Description', quantity: 'Pieces', minutes: 'Standard minutes', rate: 'Rate', amount: 'Amount' },
    share: 'share {share}',
    time: 'Paid time off standard',
    corrections: 'Corrections',
    correctsMonth: 'Work of {month}',
    earnings: 'Earnings of the month',
    guaranteed: 'Guaranteed pay',
    earned: 'Earned by the piece',
    makeUp: 'Make-up to guaranteed pay',
    total: 'Total',
    ordinary: 'Ordinary minutes present',
    overtime: 'Approved overtime (minutes)',
    held: 'Held scans',
    heldValue: '{open} open, {counted} counted, {notPaid} not paid',
    defects: 'Scrap and rework on own scans',
    defectsValue: '{scrap} scrap, {rework} rework',
    defectsOthers: '{scrap} scrap, {rework} rework (of which caused by others: {othersScrap} scrap, {othersRework} rework)',
    bonus: 'Standard-minute bonus',
    bonusFacts: 'Efficiency',
    bonusValue: '{efficiency}%: {standard} standard minutes over {present} minutes present, threshold {threshold}, bonus on {above} minutes',
    bonusNotice: 'Under the bonus scheme the pieces are not paid by the piece: they measure the bonus. The guaranteed pay covers the minutes present.',
    none: 'No piece work this month.',
    draft: 'DRAFT: not approved, it may still change',
    superseded: 'SUPERSEDED by a later revision',
    notice: "Statement of the work done and the piece-work earnings (c.c. art. 2101). Scrap and rework on your own scans are paid by their cause: your own fault by the scheme's rule, caused by others as paid time. If an entry is wrong, dispute it from My day on the tablet.",
  },
} as const

const fill = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''))
const column = (key: ComposedColumn['key'], width: number, align: 'left' | 'right', label: string): ComposedColumn => ({ key, width, align, label })

export interface WorkerStatementInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly person: { readonly name: string; readonly code: string | null }
  readonly month: string
  readonly revision: number
  readonly status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'
  /** The day it was approved; otherwise the day it is printed. */
  readonly on: BusinessDate
  readonly summary: StatementSummary
  readonly earningsAmount: MinorUnits
  readonly makeUpAmount: MinorUnits
}

/** The month in the document's words ("ottobre 2026"). */
export function monthWords(month: string, language: DocumentLanguage): string {
  const [year, number] = month.split('-').map(Number)
  const day = new Date(Date.UTC(year ?? 1970, (number ?? 1) - 1, 1))
  return new Intl.DateTimeFormat(language === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(day)
}

/** The worker statement in its fixed layout. Refuses a company whose legal data are incomplete, as every company document. */
export function workerStatementDocument(input: WorkerStatementInput): ComposedDocument {
  const { language, summary, status } = input
  const words = WORDS[language]
  const problems = legalProblems(input.company)
  if (problems.length > 0) throw new ValidationError('The document cannot be printed as it stands.', problems)
  const money = (amount: MinorUnits) => formatMoney(amount, summary.currency, language)
  const minutes = (value: string | number) => formatDecimal(String(value), language, 0, 3)
  const columns = [
    column('code', 150, 'left', words.pieces.code),
    column('description', 370, 'left', words.pieces.description),
    column('quantity', 100, 'right', words.pieces.quantity),
    column('delivery', 130, 'right', words.pieces.minutes),
    column('unitPrice', 120, 'right', words.pieces.rate),
    column('amount', 130, 'right', words.pieces.amount),
  ]
  const pieces = summary.lines.map((line) => [line.operationCode, line.sharePct ? `${line.operationName} (${fill(words.share, { share: `${formatDecimal(line.sharePct, language, 0, 2)}%` })})` : line.operationName, String(line.pieces), minutes(line.minutes), formatUnitPrice(line.rate, language), money(line.amount)])
  const time = summary.time.map((line) => [line.code, words.time, '', minutes(line.minutes), formatUnitPrice(line.rate, language), money(line.amount)])
  const corrections = summary.corrections.map((line) => ['', [words.corrections, line.month ? fill(words.correctsMonth, { month: monthWords(line.month, language) }) : null, line.words].filter(Boolean).join(' · '), '', '', '', money(line.amount)])
  const rows = [...pieces, ...time, ...corrections]
  const name = legalName(input.company, language)
  // B-W2b-84: both absent from a statement stored before them.
  const bonus = summary.bonus ?? null
  const defects = { scrap: summary.defects.scrap, rework: summary.defects.rework, othersScrap: summary.defects.othersScrap ?? 0, othersRework: summary.defects.othersRework ?? 0 }
  const month = monthWords(input.month, language)
  return {
    type: typeOf('WORKER_STATEMENT'),
    language,
    layout: WORKER_STATEMENT_LAYOUT,
    title: words.title,
    issuer: { heading: words.issuer, name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.period, value: month },
      { label: words.revision, value: String(input.revision) },
      ...(status === 'APPROVED' ? [{ label: words.approvedOn, value: formatDate(input.on, language) }] : []),
    ],
    banner: status === 'DRAFT' ? words.draft : status === 'SUPERSEDED' ? words.superseded : null,
    blocks: [{ heading: words.worker, lines: [input.person.name, ...(input.person.code ? [`${words.code} ${input.person.code}`] : [])] }],
    facts: [
      ...(summary.attendance ? [{ label: words.ordinary, value: String(summary.attendance.ordinaryMinutes) }, { label: words.overtime, value: String(summary.attendance.approvedOvertimeMinutes) }] : []),
      { label: words.held, value: fill(words.heldValue, summary.held) },
      { label: words.defects, value: fill(defects.othersScrap + defects.othersRework > 0 ? words.defectsOthers : words.defectsValue, defects) },
      ...(bonus
        ? [
            {
              label: words.bonusFacts,
              value: fill(words.bonusValue, { efficiency: formatDecimal(bonus.efficiencyPct, language, 0, 2), standard: minutes(bonus.standardMinutes), present: String(bonus.minutesPresent), threshold: minutes(bonus.thresholdMinutes), above: minutes(bonus.bonusMinutes) }),
            },
          ]
        : []),
    ],
    table: { columns, rows: rows.length > 0 ? rows : [['', words.none, '', '', '', '']] },
    totals: [
      { label: words.earnings, value: money(input.earningsAmount), strong: false },
      ...(bonus ? [{ label: words.bonus, value: money(bonus.amount), strong: false }] : []),
      ...(summary.makeUp ? [{ label: words.guaranteed, value: money(summary.makeUp.guaranteed), strong: false }, { label: words.earned, value: money(summary.makeUp.earned), strong: false }] : []),
      { label: words.makeUp, value: money(input.makeUpAmount), strong: false },
      { label: words.total, value: money(input.earningsAmount + input.makeUpAmount), strong: true },
    ],
    notes: null,
    notices: bonus ? [words.notice, words.bonusNotice] : [words.notice],
    signatures: [],
    footer: { legal: legalFooter(input.company, language), text: input.company.documentFooter?.trim() ? input.company.documentFooter.trim() : null, page: DOCUMENT_WORDS[language].page, continued: DOCUMENT_WORDS[language].continued },
    meta: {
      title: `${words.title} ${input.person.code ?? ''} ${input.month}`.replace(/\s+/g, ' ').trim(),
      author: name,
      subject: `${WORKER_STATEMENT_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.on)),
      keywords: ['WORKER_STATEMENT', input.month, String(input.revision)].join(' '),
    },
  }
}
