import { BUSINESS_TIME_ZONE, type BusinessDate } from '../../core/time'
import { formatDate, formatDateTime } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { DiscrepancyReport, ReportColumn } from '../../inventory/receipts/report'
import { DVR_LAW, VERSIONS_LAW, type DvrAuthorKind, type DvrSignerRole, type DvrSignMethod, type DvrVersionStatus } from './rules'

/**
 * The seal of a DVR version (B-W2b-122; QHS-230; design plant.risk "Freeze: PDF + SHA-256 + timestamp → DocumentSeal", new tab
 * "DVR (frozen PDF)": the signed document, printable): one A4 record that binds the consultant's PDF by its SHA-256 (any change
 * to the file gives another fingerprint), says when it was frozen and by whom, and lists the signers the certain date needs
 * with how and when each one signed; the certain date is the day of the last of them. Painted by apps/factory-api with the
 * A4 renderer of the discrepancy report (the same shape, as the check report); kept as a GeneratedDocument DVR_FROZEN of the
 * version once it is signed (the consultant's PDF stays the file it froze: the seal names it, never copies it).
 *
 * A pure function of what it prints: the same version, signatures and language give the same text (its fingerprint). No
 * money; people only as the register names them (the signers, the office person who froze it or recorded a paper).
 */

export interface SealSignature {
  readonly role: DvrSignerRole
  readonly signerName: string
  readonly signedOn: BusinessDate
  /** ISO instant. */
  readonly signedAt: string
  readonly method: DvrSignMethod
  /** PAPER: who recorded it; OFFICE: who signed in; FLOOR_PIN: null (the worker signed with badge and PIN); LINK: null (the outside signer approved our request). */
  readonly recordedBy: string | null
}

export interface SealInput {
  readonly language: DocumentLanguage
  /** When the PDF is made (its metadata only; the text never shows it). */
  readonly createdAt: string
  readonly company: DiscrepancyReport['company']
  readonly site: { readonly code: string; readonly name: string }
  readonly assessment: { readonly name: string }
  readonly version: {
    readonly versionNo: number
    readonly label: string
    readonly effectiveOn: BusinessDate
    readonly authorKind: DvrAuthorKind
    readonly authorName: string
    readonly changeSummary: string | null
    readonly fileName: string
    readonly sha256: string
    /** ISO instant. */
    readonly frozenAt: string
    readonly frozenBy: string | null
    readonly status: DvrVersionStatus
    readonly certainDateOn: BusinessDate | null
    readonly signersRequired: readonly DvrSignerRole[]
  }
  readonly signatures: readonly SealSignature[]
  /** A preview, not the kept record: a banner says so. */
  readonly sample: boolean
}

const WORDS = {
  it: {
    title: 'Valutazione dei rischi: versione e data certa',
    sample: 'ANTEPRIMA - non conservato',
    waiting: 'IN ATTESA DI FIRME - anteprima',
    assessment: 'Valutazione',
    site: 'Sito',
    version: 'Versione',
    effective: 'In vigore dal',
    author: 'Autore',
    authorKinds: { CONSULTANT: 'consulente', IN_HOUSE: 'interno' },
    file: 'Documento congelato',
    sha: 'Impronta SHA-256',
    frozen: 'Congelato il',
    frozenBy: 'Congelato da',
    status: 'Stato',
    statuses: { AWAITING_SIGNATURES: 'In attesa di firme', SIGNED: 'Firmato', WITHDRAWN: 'Ritirato' },
    certain: 'Data certa',
    law: 'Riferimento normativo',
    none: '-',
    unit: 'Azienda',
    intro: `Questa attestazione lega il documento di valutazione dei rischi indicato sopra alla sua impronta SHA-256: qualsiasi modifica del file dà un'impronta diversa. La data certa è il giorno dell'ultima firma richiesta (${VERSIONS_LAW}). Una versione congelata non cambia mai: una modifica è una nuova versione.`,
    summary: 'Modifiche di questa versione',
    columns: { seq: 'N.', material: 'Ruolo', kind: 'Firmatario', quantity: 'Data', note: 'Modo · registrata da' },
    roles: { EMPLOYER: 'Datore di lavoro', RSPP: 'RSPP', RLS: 'RLS', RLST: 'RLS territoriale', DOCTOR: 'Medico competente' },
    methods: { OFFICE: 'firma in ufficio', FLOOR_PIN: 'badge e PIN', PAPER: 'firma su carta (scansione in archivio)', LINK: 'firmata tramite link (richiesta di approvazione, nome digitato dal firmatario)' },
    missing: 'firma mancante',
    closing: 'Attestazione generata dal registro della valutazione dei rischi; il documento del consulente resta il file congelato, con la sua impronta.',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    fileName: 'DVR',
    seal: 'sigillo',
  },
  en: {
    title: 'Risk assessment: version and certain date',
    sample: 'PREVIEW - not kept',
    waiting: 'AWAITING SIGNATURES - preview',
    assessment: 'Assessment',
    site: 'Site',
    version: 'Version',
    effective: 'In force from',
    author: 'Author',
    authorKinds: { CONSULTANT: 'consultant', IN_HOUSE: 'in-house' },
    file: 'Frozen document',
    sha: 'SHA-256 fingerprint',
    frozen: 'Frozen on',
    frozenBy: 'Frozen by',
    status: 'Status',
    statuses: { AWAITING_SIGNATURES: 'Awaiting signatures', SIGNED: 'Signed', WITHDRAWN: 'Withdrawn' },
    certain: 'Certain date',
    law: 'Legal basis',
    none: '-',
    unit: 'Company',
    intro: `This record binds the risk assessment document named above to its SHA-256 fingerprint: any change to the file gives another fingerprint. The certain date is the day of the last required signature (${VERSIONS_LAW}). A frozen version never changes: a change is a new version.`,
    summary: 'Changes in this version',
    columns: { seq: 'No.', material: 'Role', kind: 'Signer', quantity: 'Date', note: 'How · recorded by' },
    roles: { EMPLOYER: 'Employer', RSPP: 'RSPP', RLS: 'RLS', RLST: 'Territorial RLS', DOCTOR: 'Occupational doctor' },
    methods: { OFFICE: 'signed in the office', FLOOR_PIN: 'badge and PIN', PAPER: 'signed on paper (scan on file)', LINK: "signed by link (approval request, the name the signer typed)" },
    missing: 'not signed yet',
    closing: "Made from the risk assessment register; the consultant's document stays the frozen file, with its fingerprint.",
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    fileName: 'DVR',
    seal: 'seal',
  },
} as const

const COLUMNS = (language: DocumentLanguage): ReportColumn[] => {
  const w = WORDS[language].columns
  return [
    { key: 'seq', label: w.seq, width: 0.06, align: 'right' },
    { key: 'material', label: w.material, width: 0.2, align: 'left' },
    { key: 'kind', label: w.kind, width: 0.28, align: 'left' },
    { key: 'quantity', label: w.quantity, width: 0.14, align: 'left' },
    { key: 'note', label: w.note, width: 0.32, align: 'left' },
  ]
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')

/** The seal, ready to paint (the discrepancy report's A4 shape). */
export function dvrSeal(input: SealInput): DiscrepancyReport {
  const w = WORDS[input.language]
  const { version } = input
  const date = (day: BusinessDate) => formatDate(day, input.language)
  const facts: { label: string; value: string }[] = [
    { label: w.assessment, value: input.assessment.name },
    { label: w.site, value: `${input.site.code} · ${input.site.name}` },
    { label: w.version, value: `${version.label} (${version.versionNo})` },
    { label: w.effective, value: date(version.effectiveOn) },
    { label: w.author, value: `${version.authorName} (${w.authorKinds[version.authorKind]})` },
    { label: w.file, value: version.fileName },
    { label: w.sha, value: version.sha256 },
    { label: w.frozen, value: formatDateTime(new Date(version.frozenAt), BUSINESS_TIME_ZONE, input.language) },
    { label: w.frozenBy, value: version.frozenBy ?? w.none },
    { label: w.status, value: w.statuses[version.status] },
    { label: w.certain, value: version.certainDateOn ? date(version.certainDateOn) : w.none },
    { label: w.law, value: DVR_LAW },
  ]
  const rows = version.signersRequired.map((role, index) => {
    const signature = input.signatures.find((entry) => entry.role === role)
    return {
      seq: String(index + 1),
      material: w.roles[role],
      kind: signature ? signature.signerName : w.missing,
      quantity: signature ? date(signature.signedOn) : w.none,
      note: signature ? [w.methods[signature.method], signature.recordedBy].filter((part): part is string => Boolean(part)).join(' · ') : w.none,
    }
  })
  const intro = version.changeSummary ? `${w.intro} ${w.summary}: ${version.changeSummary}` : w.intro
  const banner = input.sample ? (version.status === 'AWAITING_SIGNATURES' ? w.waiting : w.sample) : null
  return {
    language: input.language,
    meta: { title: `${w.title} · ${input.assessment.name} ${version.label}`, subject: `${input.assessment.name} ${version.label}`, createdAt: input.createdAt },
    title: w.title,
    sample: banner,
    company: input.company,
    facts,
    supplier: { label: w.unit, lines: [input.company.name, `${input.site.code} · ${input.site.name}`] },
    intro,
    columns: COLUMNS(input.language),
    rows,
    closing: w.closing,
    page: w.page,
    fileName: `${w.fileName}-${safeName(input.site.code)}-${safeName(version.label)}-${w.seal}.pdf`,
  }
}

/** What the seal shows, as one text: its fingerprint's source (the same contents give the same text, whatever the day). */
export function sealFingerprintText(input: Omit<SealInput, 'createdAt' | 'sample'>): string {
  return JSON.stringify({
    language: input.language,
    company: input.company,
    site: input.site,
    assessment: input.assessment,
    version: { ...input.version, signersRequired: [...input.version.signersRequired] },
    signatures: input.signatures.map((signature) => ({ ...signature })),
  })
}
