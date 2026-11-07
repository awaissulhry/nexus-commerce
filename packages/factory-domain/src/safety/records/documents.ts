import { ValidationError } from '../../core/errors'
import { businessDayStart, toUtcIso, type BusinessDate } from '../../core/time'
import type { ComposedColumn, ComposedDocument } from '../../documents/compose'
import { formatDate, formatDecimal } from '../../documents/format'
import { DOCUMENT_WORDS } from '../../documents/i18n'
import { legalFooter, legalLines, legalName, legalProblems } from '../../documents/legal'
import type { CompanyLegal, DocumentLanguage, DocumentType } from '../../documents/model'
import { LANGUAGE_LAW, RECORDS_LAW, type DueState, type RecordResult, type SignMethod } from './rules'

/**
 * The two documents of the training records (B-W2b-139; design people.skills new tabs "Certificate (PDF)" — opened from a
 * cell, printable — and "Training due list (PDF)" — for the RSPP or the training provider), pure: every word decided here,
 * on the company's letterhead, painted by the API's shared PDF renderer. Neither is stored: they are printed from the
 * records as they stand (the provider's own certificate, when there is one, is a file of the record and opens as it is).
 *
 *   trainingRecordDocument   one training record as the employer's register keeps it: the person, the course, the day,
 *                            the hours, the trainer, the result, valid until, the language and its check, how the
 *                            attendance was signed; a corrected or VOID record says so on a banner. It is the register's
 *                            record, never the provider's certificate (the notice says so).
 *   dueListDocument          the due list as the page filtered it: person · course · state · due or valid until · why
 *                            needed · language checked.
 */

export const TRAINING_RECORD_LAYOUT = 'TRAINING_RECORD/1'
export const TRAINING_DUE_LIST_LAYOUT = 'TRAINING_DUE_LIST/1'
const typeOf = (name: 'TRAINING_RECORD' | 'TRAINING_DUE_LIST'): DocumentType => name as unknown as DocumentType

const WORDS = {
  it: {
    record: {
      title: 'Registrazione della formazione',
      issuer: 'Datore di lavoro',
      person: 'Lavoratore',
      code: 'Matricola',
      course: 'Corso',
      completedOn: 'Svolta il',
      hours: 'Ore',
      trainer: 'Docente o ente',
      result: 'Esito',
      results: { PASSED: 'Superato', FAILED: 'Non superato', VOID: 'Annullata' },
      validUntil: 'Valida fino al',
      noExpiry: 'senza scadenza',
      language: 'Lingua',
      languageChecked: 'Comprensione della lingua verificata',
      yes: 'sì',
      no: 'no',
      signed: 'Presenza firmata',
      methods: { FLOOR_PIN: 'sul terminale con badge e PIN', PAPER: 'sul foglio firme cartaceo', OFFICE: 'in ufficio' },
      countersigned: 'controfirmata dal docente',
      typed: 'registrata in ufficio',
      session: 'Sessione',
      reason: 'Motivo della data di validità',
      corrects: 'Corregge una registrazione precedente',
      columns: { code: 'Codice', description: 'Corso', quantity: 'Ore', delivery: 'Svolta il', amount: 'Valida fino al' },
      corrected: 'CORRETTA da una registrazione successiva: fa fede quella',
      void: 'ANNULLATA: questa formazione non è avvenuta',
      notice: 'Registrazione della formazione tenuta dal datore di lavoro ({law}). Non sostituisce l’attestato dell’ente formatore, quando previsto. La lingua di erogazione deve essere compresa dal lavoratore ({language}).',
    },
    due: {
      title: 'Scadenzario della formazione',
      issuer: 'Datore di lavoro',
      on: 'Alla data',
      lens: 'Vista',
      lenses: { due: 'Scaduta o in scadenza', overdue: 'Scaduta', soon: 'In scadenza', language: 'Lingua non verificata', all: 'Tutto' },
      where: 'Ambito',
      columns: { code: 'Lavoratore', description: 'Corso', quantity: 'Stato', delivery: 'Entro / valida fino al', uom: 'Perché', amount: 'Lingua verificata' },
      states: { VALID: 'Valida', DUE_SOON: 'In scadenza', EXPIRED: 'Scaduta', NEEDED: 'Da fare' },
      overdue: 'in ritardo',
      why: { ROLE: 'Mansione', MACHINE: 'Macchina', NONE: '—' },
      yes: 'sì',
      no: 'no',
      none: 'Nessuna formazione in questa vista.',
      count: 'Righe',
      notice: 'Formazione richiesta dalla scheda della mansione o da un tipo di macchina su cui il lavoratore è autorizzato ({law}). In ritardo: non posseduta oggi e oltre il termine della richiesta.',
    },
  },
  en: {
    record: {
      title: 'Training record',
      issuer: 'Employer',
      person: 'Worker',
      code: 'Employee code',
      course: 'Course',
      completedOn: 'Completed on',
      hours: 'Hours',
      trainer: 'Trainer or provider',
      result: 'Result',
      results: { PASSED: 'Passed', FAILED: 'Not passed', VOID: 'Void' },
      validUntil: 'Valid until',
      noExpiry: 'no expiry',
      language: 'Language',
      languageChecked: 'Understanding of the language checked',
      yes: 'yes',
      no: 'no',
      signed: 'Attendance signed',
      methods: { FLOOR_PIN: 'on the tablet with badge and PIN', PAPER: 'on the paper sheet', OFFICE: 'in the office' },
      countersigned: 'countersigned by the trainer',
      typed: 'recorded in the office',
      session: 'Session',
      reason: 'Why it is valid until this day',
      corrects: 'Corrects an earlier record',
      columns: { code: 'Code', description: 'Course', quantity: 'Hours', delivery: 'Completed on', amount: 'Valid until' },
      corrected: 'CORRECTED by a later record: that one stands',
      void: 'VOID: this training never took place',
      notice: 'Training record kept by the employer ({law}). It does not replace the training provider’s certificate where one is due. The training is given in a language the worker understands ({language}).',
    },
    due: {
      title: 'Training due list',
      issuer: 'Employer',
      on: 'As of',
      lens: 'View',
      lenses: { due: 'Overdue or due soon', overdue: 'Overdue', soon: 'Due soon', language: 'Language not checked', all: 'Everything' },
      where: 'Scope',
      columns: { code: 'Worker', description: 'Course', quantity: 'State', delivery: 'Due by / valid until', uom: 'Why', amount: 'Language checked' },
      states: { VALID: 'Valid', DUE_SOON: 'Due soon', EXPIRED: 'Expired', NEEDED: 'Needed' },
      overdue: 'overdue',
      why: { ROLE: 'Role', MACHINE: 'Machine', NONE: '—' },
      yes: 'yes',
      no: 'no',
      none: 'No training in this view.',
      count: 'Rows',
      notice: 'Training asked by the role sheet or by a type of machine the worker is authorised on ({law}). Overdue: not held today and past the requirement’s due day.',
    },
  },
} as const

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
const column = (key: ComposedColumn['key'], width: number, align: 'left' | 'right', label: string): ComposedColumn => ({ key, width, align, label })
const hoursOf = (hours: string, language: DocumentLanguage) => formatDecimal(hours, language, 0, 2)

function assertLegal(company: CompanyLegal): void {
  const problems = legalProblems(company)
  if (problems.length > 0) throw new ValidationError('The document cannot be printed as it stands.', problems)
}

const footerOf = (company: CompanyLegal, language: DocumentLanguage) => ({
  legal: legalFooter(company, language),
  text: company.documentFooter?.trim() ? company.documentFooter.trim() : null,
  page: DOCUMENT_WORDS[language].page,
  continued: DOCUMENT_WORDS[language].continued,
})

export interface TrainingRecordInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly person: { readonly name: string; readonly code: string | null }
  readonly course: { readonly code: string; readonly name: string; readonly legalBasis: string }
  readonly record: {
    readonly id: string
    readonly completedOn: BusinessDate
    readonly hours: string
    readonly trainerName: string
    readonly result: RecordResult
    readonly validUntil: BusinessDate | null
    readonly validUntilReason: string | null
    readonly language: string
    readonly languageChecked: boolean
    readonly corrects: boolean
    readonly correctionReason: string | null
    /** A newer record corrects this one. */
    readonly corrected: boolean
    /** ISO instant the record was written (the document's date: the same record gives the same bytes). */
    readonly createdAt: string
  }
  /** How the attendance was signed, when the record came from a session. */
  readonly attendance: { readonly method: SignMethod; readonly countersignMethod: SignMethod | null; readonly heldOn: BusinessDate; readonly location: string | null } | null
}

/** One training record as the employer's register keeps it. */
export function trainingRecordDocument(input: TrainingRecordInput): ComposedDocument {
  const { language, record } = input
  const words = WORDS[language].record
  assertLegal(input.company)
  const name = legalName(input.company, language)
  const validUntil = record.result === 'PASSED' ? (record.validUntil ? formatDate(record.validUntil, language) : words.noExpiry) : '—'
  const attendance = input.attendance
  return {
    type: typeOf('TRAINING_RECORD'),
    language,
    layout: TRAINING_RECORD_LAYOUT,
    title: words.title,
    issuer: { heading: words.issuer, name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.course, value: input.course.code },
      { label: words.completedOn, value: formatDate(record.completedOn, language) },
    ],
    banner: record.result === 'VOID' ? words.void : record.corrected ? words.corrected : null,
    blocks: [
      { heading: words.person, lines: [input.person.name, ...(input.person.code ? [`${words.code} ${input.person.code}`] : [])] },
      { heading: words.course, lines: [input.course.name, input.course.legalBasis] },
    ],
    facts: [
      { label: words.hours, value: hoursOf(record.hours, language) },
      { label: words.trainer, value: record.trainerName },
      { label: words.result, value: words.results[record.result] },
      { label: words.validUntil, value: validUntil },
      ...(record.validUntilReason ? [{ label: words.reason, value: record.validUntilReason }] : []),
      { label: words.language, value: record.language },
      { label: words.languageChecked, value: record.languageChecked ? words.yes : words.no },
      attendance
        ? { label: words.signed, value: `${words.methods[attendance.method]}, ${attendance.countersignMethod ? words.countersigned : '—'}` }
        : { label: words.signed, value: words.typed },
      ...(attendance ? [{ label: words.session, value: [formatDate(attendance.heldOn, language), attendance.location].filter(Boolean).join(' · ') }] : []),
      ...(record.corrects ? [{ label: words.corrects, value: record.correctionReason ?? '' }] : []),
    ],
    table: {
      columns: [column('code', 160, 'left', words.columns.code), column('description', 440, 'left', words.columns.description), column('quantity', 100, 'right', words.columns.quantity), column('delivery', 150, 'right', words.columns.delivery), column('amount', 150, 'right', words.columns.amount)],
      rows: [[input.course.code, input.course.name, hoursOf(record.hours, language), formatDate(record.completedOn, language), validUntil]],
    },
    totals: [],
    notes: null,
    notices: [fill(words.notice, { law: RECORDS_LAW, language: LANGUAGE_LAW })],
    signatures: [],
    footer: footerOf(input.company, language),
    meta: {
      title: `${words.title} ${input.course.code} ${input.person.code ?? ''} ${record.completedOn}`.replace(/\s+/g, ' ').trim(),
      author: name,
      subject: `${TRAINING_RECORD_LAYOUT} ${language}`,
      createdAt: record.createdAt,
      keywords: ['TRAINING_RECORD', record.id].join(' '),
    },
  }
}

export interface DueListRow {
  readonly person: string
  readonly course: string
  readonly state: DueState
  readonly overdue: boolean
  readonly dueOn: BusinessDate | null
  readonly why: 'ROLE' | 'MACHINE' | 'NONE'
  readonly languageChecked: boolean | null
}

export interface DueListInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly on: BusinessDate
  readonly view: keyof (typeof WORDS)['en']['due']['lenses']
  readonly scope: string
  readonly rows: readonly DueListRow[]
}

/** The due list for the RSPP or the training provider, as the page filtered it. */
export function dueListDocument(input: DueListInput): ComposedDocument {
  const { language } = input
  const words = WORDS[language].due
  assertLegal(input.company)
  const name = legalName(input.company, language)
  const rows = input.rows.map((row) => [
    row.person,
    row.course,
    `${words.states[row.state]}${row.overdue ? ` (${words.overdue})` : ''}`,
    row.dueOn ? formatDate(row.dueOn, language) : '—',
    words.why[row.why],
    row.languageChecked === null ? '—' : row.languageChecked ? words.yes : words.no,
  ])
  return {
    type: typeOf('TRAINING_DUE_LIST'),
    language,
    layout: TRAINING_DUE_LIST_LAYOUT,
    title: words.title,
    issuer: { heading: words.issuer, name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.on, value: formatDate(input.on, language) },
      { label: words.lens, value: words.lenses[input.view] },
    ],
    banner: null,
    blocks: [{ heading: words.where, lines: [input.scope] }],
    facts: [{ label: words.count, value: String(input.rows.length) }],
    table: {
      columns: [
        column('code', 210, 'left', words.columns.code),
        column('description', 270, 'left', words.columns.description),
        column('quantity', 140, 'left', words.columns.quantity),
        column('delivery', 150, 'right', words.columns.delivery),
        column('uom', 110, 'left', words.columns.uom),
        column('amount', 120, 'left', words.columns.amount),
      ],
      rows: rows.length > 0 ? rows : [['', words.none, '', '', '', '']],
    },
    totals: [],
    notes: null,
    notices: [fill(words.notice, { law: RECORDS_LAW })],
    signatures: [],
    footer: footerOf(input.company, language),
    meta: {
      title: `${words.title} ${input.on}`,
      author: name,
      subject: `${TRAINING_DUE_LIST_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.on)),
      keywords: ['TRAINING_DUE_LIST', input.view, input.on].join(' '),
    },
  }
}
