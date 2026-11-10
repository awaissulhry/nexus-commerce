import { POINT_INFO, NEVER_IN_A_PACK, type AnnexIIIPoint, type PackContent, type PackPurpose } from './rules'

/**
 * The evidence pack's PDF as words (B-W2b-251; PRD-299; design tf-pack "Evidence pack (PDF)"): every word and number decided
 * here, painted on A4 by apps/factory-api's modules/compliance/techfiles/pdf.ts. Italian for an Italian recipient, English for
 * every other language (the authority's language is the pack's `language`; the documents in the ZIP keep their own). The cover
 * says what the pack is, for whom, from which technical file and scope, its fingerprint and that costs, prices and wages are
 * never included; then the list of every document with its SHA-256; then one section per kind of record chosen. Nothing here
 * reads a clock: the same pack gives the same paper.
 */

export type PaperLanguage = 'it' | 'en'
export const paperLanguageOf = (language: string): PaperLanguage => (language === 'it' ? 'it' : 'en')

export interface PaperTable {
  readonly columns: readonly { readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]
  readonly rows: readonly (readonly string[])[]
}

export interface PaperSection {
  readonly heading: string
  readonly lines: readonly string[]
  readonly table: PaperTable | null
}

export interface PackPaper {
  readonly language: PaperLanguage
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly title: string
  readonly company: { readonly name: string; readonly lines: readonly string[]; readonly legal: string }
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly sections: readonly PaperSection[]
  readonly page: (page: number, pages: number) => string
  readonly fileName: string
}

export interface PackPaperInput {
  readonly language: string
  readonly number: string
  readonly purpose: PackPurpose
  readonly recipient: string
  /** When it was built (ISO instant) and how it reads in the company's zone ("2026-11-10 10:42"). */
  readonly builtAt: string
  readonly builtAtWords: string
  readonly company: { readonly name: string; readonly lines: readonly string[]; readonly legal: string }
  readonly technicalFile: { readonly number: string; readonly styleCode: string; readonly styleName: string; readonly certificate: string | null }
  readonly scopeWords: string
  readonly fingerprint: string
  readonly include: readonly PackContent[]
  readonly contents: readonly { readonly title: string; readonly sha256: string }[]
  readonly index?: readonly { readonly point: AnnexIIIPoint; readonly state: string; readonly evidence: string; readonly reviewedOn: string | null }[]
  readonly risk?: {
    readonly revision: number
    readonly signedByName: string
    readonly signedByFunction: string
    readonly signedOn: string
    readonly classReasoning: string | null
    readonly rows: readonly { readonly hazard: string; readonly zone: string | null; readonly intendedUse: string; readonly misuse: string | null; readonly control: string; readonly clause: string | null; readonly residual: string }[]
  } | null
  readonly certificates?: readonly { readonly number: string; readonly standard: string; readonly body: string; readonly validFrom: string; readonly validTo: string; readonly status: string }[]
  readonly tests?: readonly { readonly test: string; readonly batch: string | null; readonly day: string; readonly result: string | null; readonly testedBy: string | null; readonly reportNumber: string | null }[]
  readonly inspections?: readonly { readonly workOrder: string; readonly batch: string | null; readonly inspection: string; readonly status: string; readonly decidedOn: string | null; readonly released: number }[]
  readonly labels?: readonly { readonly workOrder: string; readonly template: string | null; readonly prints: number; readonly labels: number }[]
  readonly lots?: readonly { readonly lot: string; readonly item: string; readonly status: string; readonly value: string | null; readonly limit: string | null; readonly testedOn: string | null }[]
}

const WORDS = {
  it: {
    title: 'Pacchetto di evidenze',
    subject: 'Documentazione tecnica di un DPI (Reg. (UE) 2016/425, art. 8 e allegato III)',
    number: 'Numero',
    purpose: 'Scopo',
    AUTHORITY: "Per l'autorità di vigilanza del mercato (art. 8, par. 9)",
    CUSTOMER: 'Per il cliente',
    recipient: 'Destinatario',
    language: 'Lingua',
    technicalFile: 'Fascicolo tecnico',
    style: 'Modello',
    certificate: 'Certificato UE del tipo',
    none: 'nessuno',
    scope: 'Ambito',
    builtAt: 'Preparato il',
    documents: 'Documenti',
    fingerprint: 'Impronta (SHA-256)',
    never: 'Costi, prezzi e salari non sono mai inclusi.',
    contents: 'Contenuto',
    contentsLine: "Ogni documento del pacchetto con la sua impronta SHA-256. L'impronta del pacchetto è lo SHA-256 di questo elenco (numero, poi una riga per documento: impronta, due spazi, titolo).",
    noDocuments: 'Nessun file: il pacchetto è fatto delle sezioni di questo PDF.',
    title_: 'Titolo',
    TECHFILE_INDEX: 'Indice del fascicolo tecnico (allegato III)',
    RISK_ASSESSMENT: 'Valutazione dei rischi del prodotto',
    CERTIFICATES: 'Certificati',
    PRODUCTION_CONTROL: 'Prove di controllo della produzione',
    INSPECTIONS: 'Controlli finali e rilasci',
    LABELS: 'Etichette e stampe',
    CR6: 'Cromo VI per lotto',
    DOC: 'Dichiarazioni di conformità',
    USER_INFORMATION: "Informazioni per l'utilizzatore",
    TEST_REPORTS: 'Rapporti di prova',
    inZip: 'I file sono nello ZIP del pacchetto e nel contenuto qui sopra.',
    noneInScope: 'Nessuno in questo ambito.',
    noSigned: 'Nessuna valutazione dei rischi firmata.',
    point: 'Punto',
    state: 'Stato',
    evidence: 'Evidenza',
    reviewed: 'Riesaminato il',
    revision: 'Revisione',
    signedBy: 'Firmata da',
    signedOn: 'Firmata il',
    classReasoning: 'Motivazione della classe',
    hazard: 'Pericolo',
    zone: 'Zona',
    intendedUse: 'Uso previsto',
    misuse: 'Uso scorretto prevedibile',
    control: 'Controllo',
    clause: 'Punto della norma',
    residual: 'Rischio residuo',
    standard: 'Norma',
    body: 'Organismo notificato',
    valid: 'Validità',
    status: 'Stato',
    test: 'Prova',
    batch: 'Lotto',
    day: 'Data',
    result: 'Esito',
    testedBy: 'Eseguita da',
    report: 'Rapporto n.',
    due: 'da fare',
    workOrder: 'Ordine di produzione',
    inspection: 'Controllo',
    decided: 'Deciso il',
    released: 'Capi rilasciati',
    template: 'Modello di etichetta',
    prints: 'Stampe',
    labelCount: 'Etichette',
    lot: 'Lotto',
    item: 'Articolo',
    value: 'Valore mg/kg',
    limit: 'Limite mg/kg',
    testedOn: 'Provato il',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
  },
  en: {
    title: 'Evidence pack',
    subject: 'Technical documentation of a PPE (Reg. (EU) 2016/425, art. 8 and Annex III)',
    number: 'Number',
    purpose: 'Purpose',
    AUTHORITY: 'For the market surveillance authority (art. 8(9))',
    CUSTOMER: 'For the customer',
    recipient: 'Recipient',
    language: 'Language',
    technicalFile: 'Technical file',
    style: 'Style',
    certificate: 'EU type-examination certificate',
    none: 'none',
    scope: 'Scope',
    builtAt: 'Built on',
    documents: 'Documents',
    fingerprint: 'Fingerprint (SHA-256)',
    never: NEVER_IN_A_PACK,
    contents: 'Contents',
    contentsLine: "Every document of the pack with its SHA-256 fingerprint. The pack's fingerprint is the SHA-256 of this list (the number, then one line per document: fingerprint, two spaces, title).",
    noDocuments: 'No files: the pack is the sections of this PDF.',
    title_: 'Title',
    TECHFILE_INDEX: 'Technical file index (Annex III)',
    RISK_ASSESSMENT: 'Product risk assessment',
    CERTIFICATES: 'Certificates',
    PRODUCTION_CONTROL: 'Production-control tests',
    INSPECTIONS: 'Final inspections and releases',
    LABELS: 'Labels and print records',
    CR6: 'Chromium VI per lot',
    DOC: 'Declarations of conformity',
    USER_INFORMATION: 'User information',
    TEST_REPORTS: 'Test reports',
    inZip: "The files are in the pack's ZIP and in the contents above.",
    noneInScope: 'None in this scope.',
    noSigned: 'No signed risk assessment.',
    point: 'Point',
    state: 'State',
    evidence: 'Evidence',
    reviewed: 'Reviewed on',
    revision: 'Revision',
    signedBy: 'Signed by',
    signedOn: 'Signed on',
    classReasoning: 'Class reasoning',
    hazard: 'Hazard',
    zone: 'Zone',
    intendedUse: 'Intended use',
    misuse: 'Foreseeable misuse',
    control: 'Control',
    clause: 'Standard clause',
    residual: 'Residual risk',
    standard: 'Standard',
    body: 'Notified body',
    valid: 'Valid',
    status: 'Status',
    test: 'Test',
    batch: 'Batch',
    day: 'Day',
    result: 'Result',
    testedBy: 'Tested by',
    report: 'Report no.',
    due: 'due',
    workOrder: 'Work order',
    inspection: 'Inspection',
    decided: 'Decided on',
    released: 'Garments released',
    template: 'Label template',
    prints: 'Prints',
    labelCount: 'Labels',
    lot: 'Lot',
    item: 'Item',
    value: 'Value mg/kg',
    limit: 'Limit mg/kg',
    testedOn: 'Tested on',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
  },
} as const

const words = (value: string): string => value.replace(/_/g, ' ').toLowerCase()
const or = (value: string | null | undefined, fallback = '-'): string => (value == null || value === '' ? fallback : value)

/** The pack's paper. */
export function packPaper(input: PackPaperInput): PackPaper {
  const language = paperLanguageOf(input.language)
  const w = WORDS[language]
  const include = new Set(input.include)
  const sections: PaperSection[] = []

  sections.push({
    heading: w.contents,
    lines: [w.contentsLine, ...(input.contents.length === 0 ? [w.noDocuments] : [])],
    table: input.contents.length === 0 ? null : { columns: [{ label: '#', width: 0.06, align: 'right' }, { label: w.title_, width: 0.44, align: 'left' }, { label: 'SHA-256', width: 0.5, align: 'left' }], rows: input.contents.map((entry, index) => [String(index + 1), entry.title, entry.sha256]) },
  })

  if (include.has('TECHFILE_INDEX') && input.index) {
    sections.push({
      heading: w.TECHFILE_INDEX,
      lines: input.index.length === 0 ? [w.noneInScope] : [],
      table: input.index.length === 0 ? null : {
        columns: [{ label: w.point, width: 0.3, align: 'left' }, { label: w.state, width: 0.14, align: 'left' }, { label: w.evidence, width: 0.4, align: 'left' }, { label: w.reviewed, width: 0.16, align: 'left' }],
        rows: input.index.map((row) => [`(${POINT_INFO[row.point].letter}) ${POINT_INFO[row.point][language]}`, words(row.state), row.evidence, or(row.reviewedOn)]),
      },
    })
  }
  if (include.has('RISK_ASSESSMENT') && input.risk !== undefined) {
    const risk = input.risk
    sections.push(
      risk === null
        ? { heading: w.RISK_ASSESSMENT, lines: [w.noSigned], table: null }
        : {
            heading: w.RISK_ASSESSMENT,
            lines: [`${w.revision} ${risk.revision} · ${w.signedBy} ${risk.signedByName} (${risk.signedByFunction}) · ${w.signedOn} ${risk.signedOn}`, ...(risk.classReasoning ? [`${w.classReasoning}: ${risk.classReasoning}`] : [])],
            table: {
              columns: [
                { label: w.hazard, width: 0.12, align: 'left' },
                { label: w.zone, width: 0.09, align: 'left' },
                { label: w.intendedUse, width: 0.18, align: 'left' },
                { label: w.misuse, width: 0.15, align: 'left' },
                { label: w.control, width: 0.22, align: 'left' },
                { label: w.clause, width: 0.13, align: 'left' },
                { label: w.residual, width: 0.11, align: 'left' },
              ],
              rows: risk.rows.map((row) => [row.hazard, or(row.zone), row.intendedUse, or(row.misuse), row.control, or(row.clause), words(row.residual)]),
            },
          },
    )
  }
  if (include.has('CERTIFICATES') && input.certificates) {
    sections.push({
      heading: w.CERTIFICATES,
      lines: input.certificates.length === 0 ? [w.noneInScope] : [w.inZip],
      table: input.certificates.length === 0 ? null : {
        columns: [{ label: w.number, width: 0.2, align: 'left' }, { label: w.standard, width: 0.2, align: 'left' }, { label: w.body, width: 0.26, align: 'left' }, { label: w.valid, width: 0.22, align: 'left' }, { label: w.status, width: 0.12, align: 'left' }],
        rows: input.certificates.map((row) => [row.number, row.standard, row.body, `${row.validFrom} - ${row.validTo}`, words(row.status)]),
      },
    })
  }
  for (const kind of ['DOC', 'USER_INFORMATION', 'TEST_REPORTS'] as const) {
    if (include.has(kind)) sections.push({ heading: w[kind], lines: [w.inZip], table: null })
  }
  if (include.has('PRODUCTION_CONTROL') && input.tests) {
    sections.push({
      heading: w.PRODUCTION_CONTROL,
      lines: input.tests.length === 0 ? [w.noneInScope] : [],
      table: input.tests.length === 0 ? null : {
        columns: [{ label: w.test, width: 0.24, align: 'left' }, { label: w.batch, width: 0.16, align: 'left' }, { label: w.day, width: 0.12, align: 'left' }, { label: w.result, width: 0.1, align: 'left' }, { label: w.testedBy, width: 0.22, align: 'left' }, { label: w.report, width: 0.16, align: 'left' }],
        rows: input.tests.map((row) => [row.test, or(row.batch), row.day, row.result ? row.result : w.due, or(row.testedBy), or(row.reportNumber)]),
      },
    })
  }
  if (include.has('INSPECTIONS') && input.inspections) {
    sections.push({
      heading: w.INSPECTIONS,
      lines: input.inspections.length === 0 ? [w.noneInScope] : [],
      table: input.inspections.length === 0 ? null : {
        columns: [{ label: w.workOrder, width: 0.2, align: 'left' }, { label: w.batch, width: 0.18, align: 'left' }, { label: w.inspection, width: 0.18, align: 'left' }, { label: w.status, width: 0.12, align: 'left' }, { label: w.decided, width: 0.16, align: 'left' }, { label: w.released, width: 0.16, align: 'right' }],
        rows: input.inspections.map((row) => [row.workOrder, or(row.batch), row.inspection, words(row.status), or(row.decidedOn), String(row.released)]),
      },
    })
  }
  if (include.has('LABELS') && input.labels) {
    sections.push({
      heading: w.LABELS,
      lines: input.labels.length === 0 ? [w.noneInScope] : [],
      table: input.labels.length === 0 ? null : {
        columns: [{ label: w.workOrder, width: 0.3, align: 'left' }, { label: w.template, width: 0.34, align: 'left' }, { label: w.prints, width: 0.16, align: 'right' }, { label: w.labelCount, width: 0.2, align: 'right' }],
        rows: input.labels.map((row) => [row.workOrder, or(row.template), String(row.prints), String(row.labels)]),
      },
    })
  }
  if (include.has('CR6') && input.lots) {
    sections.push({
      heading: w.CR6,
      lines: input.lots.length === 0 ? [w.noneInScope] : [],
      table: input.lots.length === 0 ? null : {
        columns: [{ label: w.lot, width: 0.18, align: 'left' }, { label: w.item, width: 0.3, align: 'left' }, { label: w.status, width: 0.14, align: 'left' }, { label: w.value, width: 0.12, align: 'right' }, { label: w.limit, width: 0.12, align: 'right' }, { label: w.testedOn, width: 0.14, align: 'left' }],
        rows: input.lots.map((row) => [row.lot, row.item, words(row.status), or(row.value), or(row.limit), or(row.testedOn)]),
      },
    })
  }

  const facts = [
    { label: w.number, value: input.number },
    { label: w.purpose, value: w[input.purpose] },
    { label: w.recipient, value: input.recipient },
    { label: w.language, value: input.language },
    { label: w.technicalFile, value: input.technicalFile.number },
    { label: w.style, value: `${input.technicalFile.styleCode} ${input.technicalFile.styleName}` },
    { label: w.certificate, value: input.technicalFile.certificate ?? w.none },
    { label: w.scope, value: input.scopeWords },
    { label: w.builtAt, value: input.builtAtWords },
    { label: w.documents, value: String(input.contents.length) },
    { label: w.fingerprint, value: input.fingerprint },
    { label: '', value: w.never },
  ]
  return {
    language,
    meta: { title: `${w.title} ${input.number}`, subject: w.subject, createdAt: input.builtAt },
    title: `${w.title} ${input.number}`,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${input.number}.pdf`,
  }
}
