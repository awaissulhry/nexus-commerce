import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { ActionKind, ActionStatus, CapaStatus, CapaType } from './rules'

/**
 * The 8D report (B-W2b-108; QHS-094 "8D report for customers who ask"; design quality.capa Report tab capa-8d and the new
 * tab capa-pdf "8D report (PDF)"), pure: every word of the PDF in the chosen language (Italian or English), laid out as
 * the eight disciplines, a view of the record and never a document of its own to keep in step (design "better"). An
 * internal CAPA prints the same disciplines under its own title. apps/factory-api's modules/quality/capa reads the facts
 * and paints it on A4 with pdfkit (the documents platform's fonts and WinAnsi rule).
 *
 *   D1 team            the people and their roles
 *   D2 problem         what, where, when, how many
 *   D3 containment     live from the NCRs it came from: each containment action and where it stands
 *   D4 root cause      the cause codes its NCRs name (the root-cause tools are W3)
 *   D5 corrective      the corrective actions chosen: who, by when
 *   D6 in place        the corrective actions done: when, and their evidence
 *   D7 prevention      the preventive actions and where they stand
 *   D8 closure         closed on, the closing words; or still open
 *
 * No money, no figure per person, no worker: the team and the owners are office people named inside the record. The
 * internal notes of the complaints it came from (findings, root cause words) are never printed.
 */

export interface EightDCompany {
  readonly name: string
  readonly lines: readonly string[]
  readonly legal: string
}

export interface EightDAction {
  readonly seq: number
  readonly kind: ActionKind
  readonly description: string
  readonly owner: string | null
  readonly dueOn: BusinessDate
  readonly status: ActionStatus
  readonly doneOn: BusinessDate | null
  readonly evidence: string | null
}

export interface EightDContainment {
  /** The NCR's number. */
  readonly ncr: string
  readonly actions: readonly { readonly kind: string; readonly description: string; readonly status: string; readonly doneOn: BusinessDate | null }[]
}

export interface EightDInput {
  readonly language: DocumentLanguage
  /** The report's date. */
  readonly date: BusinessDate
  readonly company: EightDCompany
  readonly type: CapaType
  readonly number: string
  readonly title: string
  readonly status: CapaStatus
  readonly openedOn: BusinessDate
  readonly dueOn: BusinessDate
  readonly owner: string | null
  readonly customer: { readonly name: string; readonly reference: string | null } | null
  readonly team: readonly { readonly name: string; readonly role: string }[]
  readonly problem: { readonly what: string | null; readonly where: string | null; readonly when: string | null; readonly howMany: string | null }
  readonly sources: readonly { readonly type: 'Nonconformance' | 'Complaint'; readonly number: string }[]
  readonly containment: readonly EightDContainment[]
  readonly causes: readonly { readonly code: string; readonly label: string }[]
  readonly actions: readonly EightDAction[]
  readonly closedOn: BusinessDate | null
  readonly closeNote: string | null
  /** A preview, not a version kept: a banner says so. */
  readonly sample: boolean
}

export interface EightDTable {
  readonly columns: readonly { readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]
  readonly rows: readonly (readonly string[])[]
}

export interface EightDSection {
  readonly heading: string
  /** Lines of text (each printed as a paragraph); an empty section says so in one line. */
  readonly lines: readonly string[]
  readonly table: EightDTable | null
}

export interface EightDReport {
  readonly language: DocumentLanguage
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly title: string
  readonly sample: string | null
  readonly company: EightDCompany
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly sections: readonly EightDSection[]
  readonly page: (page: number, pages: number) => string
  readonly fileName: string
}

const WORDS = {
  it: {
    title8d: 'Rapporto 8D',
    titleCapa: 'Rapporto di azione correttiva',
    sample: 'ANTEPRIMA - versione non conservata',
    number: 'Numero',
    subject: 'Oggetto',
    customer: 'Cliente',
    yourRef: 'Vs. riferimento',
    opened: 'Aperto il',
    due: 'Scadenza',
    owner: 'Responsabile',
    stage: 'Stato',
    sources: 'Origine',
    reportDate: 'Data del rapporto',
    d1: 'D1 - Team',
    d2: 'D2 - Descrizione del problema',
    d3: 'D3 - Azioni di contenimento',
    d4: 'D4 - Causa radice',
    d5: 'D5 - Azioni correttive scelte',
    d6: 'D6 - Azioni correttive attuate',
    d7: 'D7 - Azioni preventive',
    d8: 'D8 - Chiusura',
    what: 'Cosa',
    where: 'Dove',
    when: 'Quando',
    howMany: 'Quanti',
    none: 'Nessuna voce.',
    notStated: 'Non indicato.',
    noContainment: 'Nessuna azione di contenimento registrata nelle non conformità di origine.',
    noCause: 'Causa radice non ancora registrata.',
    open: (dueOn: string) => `Aperto: scadenza ${dueOn}.`,
    closed: (on: string) => `Chiuso il ${on}.`,
    cancelled: 'Annullato.',
    columns: { seq: 'N.', action: 'Azione', owner: 'Responsabile', due: 'Scadenza', state: 'Stato' },
    doneColumns: { seq: 'N.', action: 'Azione', done: 'Fatta il', evidence: 'Evidenza' },
    status: { OPEN: 'Aperta', DONE: 'Fatta', CANCELLED: 'Annullata' } as Record<string, string>,
    containmentKind: { HOLD_STOCK: 'Blocco della merce', CHECK_WIP: 'Verifica del semilavorato', CHECK_SHIPPED: 'Verifica della merce spedita', TELL_CUSTOMER: 'Avviso al cliente', OTHER: 'Altro' } as Record<string, string>,
    stages: {
      PLAN: 'Pianificazione', ACT: 'Attuazione', CHECK: 'Verifica', D1: 'D1 team', D2: 'D2 problema', D3: 'D3 contenimento', D4: 'D4 causa radice', D5: 'D5 azioni correttive', D6: 'D6 azioni attuate', D7: 'D7 prevenzione', D8: 'D8 chiusura', CLOSED: 'Chiuso', CANCELLED: 'Annullato',
    } as Record<string, string>,
    done: (on: string) => `fatta il ${on}`,
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Rapporto-8D',
  },
  en: {
    title8d: '8D report',
    titleCapa: 'Corrective action report',
    sample: 'PREVIEW - version not kept',
    number: 'Number',
    subject: 'Subject',
    customer: 'Customer',
    yourRef: 'Your reference',
    opened: 'Opened on',
    due: 'Due',
    owner: 'Owner',
    stage: 'Status',
    sources: 'Came from',
    reportDate: 'Report date',
    d1: 'D1 - Team',
    d2: 'D2 - Problem description',
    d3: 'D3 - Containment actions',
    d4: 'D4 - Root cause',
    d5: 'D5 - Corrective actions chosen',
    d6: 'D6 - Corrective actions in place',
    d7: 'D7 - Preventive actions',
    d8: 'D8 - Closure',
    what: 'What',
    where: 'Where',
    when: 'When',
    howMany: 'How many',
    none: 'None.',
    notStated: 'Not stated.',
    noContainment: 'No containment action is recorded in the nonconformances it came from.',
    noCause: 'The root cause is not recorded yet.',
    open: (dueOn: string) => `Open: due ${dueOn}.`,
    closed: (on: string) => `Closed on ${on}.`,
    cancelled: 'Cancelled.',
    columns: { seq: 'No.', action: 'Action', owner: 'Owner', due: 'Due', state: 'Status' },
    doneColumns: { seq: 'No.', action: 'Action', done: 'Done on', evidence: 'Evidence' },
    status: { OPEN: 'Open', DONE: 'Done', CANCELLED: 'Cancelled' } as Record<string, string>,
    containmentKind: { HOLD_STOCK: 'Goods put on hold', CHECK_WIP: 'Work in progress checked', CHECK_SHIPPED: 'Shipped goods checked', TELL_CUSTOMER: 'Customer told', OTHER: 'Other' } as Record<string, string>,
    stages: {
      PLAN: 'Plan', ACT: 'Act', CHECK: 'Check', D1: 'D1 team', D2: 'D2 problem', D3: 'D3 containment', D4: 'D4 root cause', D5: 'D5 corrective actions', D6: 'D6 actions in place', D7: 'D7 prevention', D8: 'D8 closure', CLOSED: 'Closed', CANCELLED: 'Cancelled',
    } as Record<string, string>,
    done: (on: string) => `done on ${on}`,
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: '8D-report',
  },
} as const

/** Lines of free text: one paragraph per line written, blank lines dropped. */
const paragraphs = (text: string | null): string[] => (text ? text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') : [])

/** The report as the PDF prints it: every word decided here. */
export function eightDReport(input: EightDInput): EightDReport {
  const w = WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const title = input.type === 'EIGHT_D' ? w.title8d : w.titleCapa
  const facts = [
    { label: w.number, value: input.number },
    { label: w.subject, value: input.title },
    ...(input.customer ? [{ label: w.customer, value: input.customer.name }] : []),
    ...(input.customer?.reference ? [{ label: w.yourRef, value: input.customer.reference }] : []),
    { label: w.opened, value: day(input.openedOn) },
    { label: w.due, value: day(input.dueOn) },
    ...(input.owner ? [{ label: w.owner, value: input.owner }] : []),
    { label: w.stage, value: w.stages[input.status] ?? input.status },
    // The numbers say what they are (NCR-…, CMP-…).
    ...(input.sources.length > 0 ? [{ label: w.sources, value: input.sources.map((source) => source.number).join(', ') }] : []),
    { label: w.reportDate, value: day(input.date) },
  ]

  const problem = [
    [w.what, input.problem.what],
    [w.where, input.problem.where],
    [w.when, input.problem.when],
    [w.howMany, input.problem.howMany],
  ].flatMap(([label, value]) => (value ? paragraphs(value).map((line, index) => (index === 0 ? `${label}: ${line}` : line)) : []))

  const containment = input.containment.flatMap((ncr) =>
    ncr.actions.map((action) => {
      const state = action.status === 'DONE' && action.doneOn ? w.done(day(action.doneOn)) : (w.status[action.status] ?? action.status).toLowerCase()
      return `${ncr.ncr} · ${w.containmentKind[action.kind] ?? action.kind}: ${action.description.trim()} (${state})`
    }),
  )

  const actionsTable = (kind: ActionKind): EightDTable | null => {
    const rows = input.actions.filter((action) => action.kind === kind)
    if (rows.length === 0) return null
    return {
      columns: [
        { label: w.columns.seq, width: 0.07, align: 'right' },
        { label: w.columns.action, width: 0.5, align: 'left' },
        { label: w.columns.owner, width: 0.18, align: 'left' },
        { label: w.columns.due, width: 0.12, align: 'left' },
        { label: w.columns.state, width: 0.13, align: 'left' },
      ],
      rows: rows.map((action) => [String(action.seq), action.description.trim(), action.owner ?? '-', day(action.dueOn), w.status[action.status] ?? action.status]),
    }
  }
  const done = input.actions.filter((action) => action.kind === 'CORRECTIVE' && action.status === 'DONE')
  const doneTable: EightDTable | null =
    done.length === 0
      ? null
      : {
          columns: [
            { label: w.doneColumns.seq, width: 0.07, align: 'right' },
            { label: w.doneColumns.action, width: 0.4, align: 'left' },
            { label: w.doneColumns.done, width: 0.13, align: 'left' },
            { label: w.doneColumns.evidence, width: 0.4, align: 'left' },
          ],
          rows: done.map((action) => [String(action.seq), action.description.trim(), action.doneOn ? day(action.doneOn) : '-', action.evidence?.trim() || '-']),
        }

  const corrective = actionsTable('CORRECTIVE')
  const preventive = actionsTable('PREVENTIVE')
  const closure =
    input.status === 'CLOSED' && input.closedOn ? [w.closed(day(input.closedOn)), ...paragraphs(input.closeNote)] : input.status === 'CANCELLED' ? [w.cancelled] : [w.open(day(input.dueOn))]

  const sections: EightDSection[] = [
    { heading: w.d1, lines: input.team.length === 0 ? [w.none] : input.team.map((member) => `${member.name} - ${member.role}`), table: null },
    { heading: w.d2, lines: problem.length === 0 ? [w.notStated] : problem, table: null },
    { heading: w.d3, lines: containment.length === 0 ? [w.noContainment] : containment, table: null },
    { heading: w.d4, lines: input.causes.length === 0 ? [w.noCause] : input.causes.map((cause) => `${cause.label} (${cause.code})`), table: null },
    { heading: w.d5, lines: corrective ? [] : [w.none], table: corrective },
    { heading: w.d6, lines: doneTable ? [] : [w.none], table: doneTable },
    { heading: w.d7, lines: preventive ? [] : [w.none], table: preventive },
    { heading: w.d8, lines: closure, table: null },
  ]

  return {
    language: input.language,
    meta: { title: `${title} ${input.number}`, subject: input.title, createdAt: `${input.date}T00:00:00.000Z` },
    title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.number}-${input.language}.pdf`,
  }
}

/**
 * The text the version fingerprint is taken of: everything the report says but the report's date and the preview banner,
 * so the same record in the same language gives the same version whatever the day.
 */
export function eightDFingerprintText(report: EightDReport): string {
  return JSON.stringify({
    language: report.language,
    title: report.title,
    company: report.company,
    facts: report.facts.slice(0, -1),
    sections: report.sections,
  })
}
