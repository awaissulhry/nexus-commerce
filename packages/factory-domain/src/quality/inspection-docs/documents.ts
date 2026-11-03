import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import { GARMENT_ZONES } from '../defects/rules'
import { decimalWords } from '../final/plan'
import type { Uom } from '../../product/units/units'
import { Dec } from '../../tax/decimal'

/**
 * The quality documents for a customer (B-W2b-123; QHS-055 "Inspection report PDF for customers"; QHS-059 "Certificate of
 * conformity per shipment is a customer ask, not law"; design quality.inspections new tab "Inspection report (PDF)": "A
 * document to print or attach: result, AQL table, defects with photos, measurements, signatures"), pure: every word of
 * the PDF in Italian or English, laid out as facts, sections with lines, a table and photos. apps/factory-api's
 * modules/quality/inspection-docs reads the facts and paints it on A4 (pdfkit, the documents platform's WinAnsi rule).
 *
 * What a document never carries: a price, a cost, a margin, a pay figure (the Owner: pay figures never go by link); a
 * worker's name (a floor inspector or releaser is "the bench", the e-signature's SHA-256 stays); a rider's name or profile.
 * Office people are named where they signed (the inspector, the releaser, who asked and who countersigned a correction,
 * who issued the certificate). What stands is printed: the signed record with its signed corrections, each marked [A1].
 */

export interface DocumentCompany {
  readonly name: string
  readonly lines: readonly string[]
  readonly legal: string
}

export interface DocumentTable {
  readonly columns: readonly { readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]
  readonly rows: readonly (readonly string[])[]
}

export interface DocumentPhoto {
  readonly fileId: string
  readonly sha256: string
  readonly caption: string
}

export interface DocumentSection {
  readonly heading: string
  readonly lines: readonly string[]
  readonly table: DocumentTable | null
  readonly photos: readonly DocumentPhoto[]
}

/** A quality document as the PDF prints it. */
export interface QualityDocument {
  readonly language: DocumentLanguage
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly title: string
  /** The preview banner (null: a version kept). */
  readonly sample: string | null
  readonly company: DocumentCompany
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  /** The document's date line ("Report date 3 Nov 2026"), left out of the fingerprint. */
  readonly dated: string
  readonly sections: readonly DocumentSection[]
  readonly page: (page: number, pages: number) => string
  readonly fileName: string
}

/**
 * The text the version fingerprint is taken of: everything the document says but its date and the preview banner, so the
 * same record in the same language gives the same version whatever the day (as the claim letter and the 8D).
 */
export function fingerprintText(document: QualityDocument): string {
  return JSON.stringify({ language: document.language, title: document.title, company: document.company, facts: document.facts, sections: document.sections })
}

const section = (heading: string, lines: readonly string[], table: DocumentTable | null = null, photos: readonly DocumentPhoto[] = []): DocumentSection => ({ heading, lines, table, photos })
const paragraphs = (text: string | null | undefined): string[] => (text ? text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') : [])
const marks = (refs: readonly number[]): string => (refs.length === 0 ? '' : ` [${refs.map((ref) => `A${ref}`).join(', ')}]`)
const short = (sha: string | null): string => (sha ? `${sha.slice(0, 16)}…` : '-')

// ---- the inspection report --------------------------------------------------------------------------------------------------

export type DefectClass = 'CRITICAL' | 'MAJOR' | 'MINOR'
export type Outcome = 'PASS' | 'FAIL' | 'NOT_APPLICABLE'

export interface ReportInput {
  readonly language: DocumentLanguage
  /** The report's date (left out of the fingerprint). */
  readonly date: BusinessDate
  readonly company: DocumentCompany
  readonly inspection: {
    readonly number: string
    readonly status: 'PASSED' | 'FAILED'
    readonly computedResult: 'PASS' | 'FAIL' | null
    readonly overrideReason: string | null
    readonly decidedOn: BusinessDate
    readonly signatureSha256: string | null
    readonly note: string | null
    readonly noteAmended: readonly number[]
  }
  readonly workOrder: { readonly number: string; readonly batchNumber: string | null; readonly style: { readonly code: string; readonly name: string; readonly revision: number | null } }
  readonly sampling: {
    readonly lotSize: number
    readonly sampleSize: number
    readonly inspectionLevel: string
    readonly codeLetter: string | null
    readonly aqlMajor: string
    readonly aqlMinor: string
    readonly acceptMajor: number
    readonly acceptMinor: number
    readonly plan: string | null
  }
  readonly counts: { readonly critical: number; readonly major: number; readonly minor: number }
  /** The inspector's name when an office user signed; null: the bench (a floor inspector, never named on a document). */
  readonly inspector: string | null
  /** A plan's checks (null: W1's fixed checklist, below). */
  readonly checks: readonly { readonly code: string; readonly label: string; readonly checkClass: DefectClass | null; readonly results: readonly { readonly unit: number; readonly outcome: Outcome; readonly value: string | null; readonly note: string | null; readonly amended: readonly number[] }[] }[] | null
  readonly checklist: readonly { readonly code: string; readonly label: string; readonly ok: boolean | null; readonly note: string | null; readonly amended: readonly number[] }[]
  readonly measurements: readonly { readonly pointCode: string; readonly size: string; readonly unit: number; readonly nominal: string; readonly tolerance: string; readonly measured: string; readonly uom: Uom; readonly pass: boolean; readonly amended: readonly number[] }[]
  readonly identity: { readonly mode: 'SERIAL' | 'BATCH'; readonly ok: boolean | null; readonly words: string } | null
  readonly defects: readonly { readonly defectClass: DefectClass; readonly code: string; readonly zone: string | null; readonly quantity: number; readonly description: string | null; readonly note: string | null; readonly cause: string | null; readonly amended: readonly number[]; readonly zoneAmended: readonly number[] }[]
  readonly photos: readonly DocumentPhoto[]
  /** Photos of the results that could not be printed (not a JPEG or PNG, too large, or not available). */
  readonly photosLeftOut: number
  readonly releases: readonly { readonly number: string; readonly garments: number; readonly reversed: number; readonly releasedOn: BusinessDate; readonly by: string | null }[]
  readonly amendments: readonly { readonly ref: number; readonly field: string; readonly from: string; readonly to: string; readonly reason: string; readonly askedBy: string; readonly signedBy: string; readonly signedOn: BusinessDate }[]
  readonly sample: boolean
}

const REPORT_WORDS = {
  it: {
    title: 'Rapporto di ispezione finale',
    sample: 'ANTEPRIMA - versione non conservata',
    number: 'Ispezione',
    workOrder: 'Ordine di produzione',
    style: 'Modello',
    revision: 'rev.',
    batch: 'Lotto di produzione',
    lot: 'Lotto ispezionato',
    sampleSize: 'Campione',
    plan: 'Piano di ispezione',
    result: 'Esito',
    decided: 'Firmata il',
    dated: 'Data del rapporto',
    garments: (n: number) => `${n} capi`,
    passed: 'CONFORME',
    failed: 'NON CONFORME',
    overridden: (computed: string) => `decisione dell'ispettore sul risultato calcolato (${computed})`,
    sampling: 'Campionamento (ISO 2859-1, campionamento singolo)',
    samplingLine: (level: string, letter: string | null, n: number, lot: number) => `Lotto ${lot} capi · livello ${level}${letter ? ` · lettera codice ${letter}` : ''} · ispezionati ${n}.`,
    aqlColumns: { cls: 'Classe', aql: 'AQL', ac: 'Accettazione (Ac)', re: 'Rifiuto (Re)', found: 'Trovati', verdict: 'Esito' },
    classes: { CRITICAL: 'Critico', MAJOR: 'Maggiore', MINOR: 'Minore' } as Record<DefectClass, string>,
    accept: 'accettato',
    reject: 'rifiutato',
    checks: 'Controlli',
    checkColumns: { code: 'Controllo', unit: 'Capo', outcome: 'Esito', value: 'Valore', note: 'Nota' },
    outcomes: { PASS: 'Conforme', FAIL: 'Non conforme', NOT_APPLICABLE: 'Non applicabile' } as Record<Outcome, string>,
    checklistOk: (ok: boolean | null) => (ok === true ? 'Conforme' : ok === false ? 'Non conforme' : 'Non applicabile'),
    noChecks: 'Nessun controllo registrato.',
    measurements: 'Misure',
    measureColumns: { point: 'Punto', size: 'Taglia', unit: 'Capo', spec: 'Valore nominale', measured: 'Misurato', verdict: 'Esito' },
    noMeasurements: 'Nessuna misura per questo piano.',
    within: 'entro tolleranza',
    identity: 'Verifica di matricole e lotto',
    identityMode: { SERIAL: 'Matricole', BATCH: 'Lotto' },
    identityOk: (ok: boolean | null) => (ok === true ? 'superata' : ok === false ? 'non superata' : 'non conclusa'),
    defects: 'Difetti trovati',
    defectColumns: { cls: 'Classe', code: 'Difetto', zone: 'Zona', qty: 'Capi', note: 'Descrizione e nota' },
    noDefects: 'Nessun difetto trovato.',
    photos: 'Foto',
    photosLeftOut: (n: number) => `${n} ${n === 1 ? 'foto non stampata' : 'foto non stampate'} (formato non stampabile o non disponibile): sono nel fascicolo dell'ispezione.`,
    noPhotos: 'Nessuna foto.',
    signatures: 'Firme',
    signedBy: (who: string | null, on: string, sha: string) => `Esito firmato ${who ? `da ${who}` : "dall'ispettore al banco (PIN)"} il ${on} · firma elettronica ${sha}`,
    releases: 'Rilasci',
    releaseLine: (number: string, n: number, on: string, by: string | null, reversed: number) =>
      `${number}: ${n} ${n === 1 ? 'capo rilasciato' : 'capi rilasciati'} il ${on} ${by ? `da ${by}` : 'al banco (PIN)'}${reversed > 0 ? ` · ${reversed} ${reversed === 1 ? 'ritirato' : 'ritirati'}` : ''}`,
    noReleases: 'Nessun rilascio.',
    amendments: 'Correzioni dopo la firma',
    amendmentLine: (ref: number, field: string, from: string, to: string) => `A${ref} · ${field}: da ${from} a ${to}`,
    amendmentWhy: (reason: string, asked: string, signed: string, on: string) => `Motivo: ${reason} · chiesta da ${asked}, controfirmata da ${signed} il ${on}`,
    noAmendments: 'Nessuna correzione.',
    note: 'Nota',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Rapporto-ispezione',
    cause: 'causa',
  },
  en: {
    title: 'Final inspection report',
    sample: 'PREVIEW - version not kept',
    number: 'Inspection',
    workOrder: 'Work order',
    style: 'Style',
    revision: 'revision',
    batch: 'Production batch',
    lot: 'Inspection lot',
    sampleSize: 'Sample',
    plan: 'Inspection plan',
    result: 'Result',
    decided: 'Signed on',
    dated: 'Report date',
    garments: (n: number) => `${n} garments`,
    passed: 'PASSED',
    failed: 'FAILED',
    overridden: (computed: string) => `the inspector's decision over the computed result (${computed})`,
    sampling: 'Sampling (ISO 2859-1, single sampling)',
    samplingLine: (level: string, letter: string | null, n: number, lot: number) => `Lot ${lot} garments · level ${level}${letter ? ` · code letter ${letter}` : ''} · inspected ${n}.`,
    aqlColumns: { cls: 'Class', aql: 'AQL', ac: 'Accept (Ac)', re: 'Reject (Re)', found: 'Found', verdict: 'Verdict' },
    classes: { CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' } as Record<DefectClass, string>,
    accept: 'accept',
    reject: 'reject',
    checks: 'Checks',
    checkColumns: { code: 'Check', unit: 'Unit', outcome: 'Outcome', value: 'Value', note: 'Note' },
    outcomes: { PASS: 'Pass', FAIL: 'Fail', NOT_APPLICABLE: 'Not applicable' } as Record<Outcome, string>,
    checklistOk: (ok: boolean | null) => (ok === true ? 'Pass' : ok === false ? 'Fail' : 'Not applicable'),
    noChecks: 'No check recorded.',
    measurements: 'Measurements',
    measureColumns: { point: 'Point', size: 'Size', unit: 'Unit', spec: 'Nominal', measured: 'Measured', verdict: 'Verdict' },
    noMeasurements: 'This plan takes no measurements.',
    within: 'within tolerance',
    identity: 'Serial and batch check',
    identityMode: { SERIAL: 'Serials', BATCH: 'Batch' },
    identityOk: (ok: boolean | null) => (ok === true ? 'passed' : ok === false ? 'failed' : 'not finished'),
    defects: 'Defects found',
    defectColumns: { cls: 'Class', code: 'Defect', zone: 'Zone', qty: 'Garments', note: 'Description and note' },
    noDefects: 'No defect found.',
    photos: 'Photos',
    photosLeftOut: (n: number) => `${n} ${n === 1 ? 'photo is' : 'photos are'} not printed (a format that cannot be printed, or not available): kept on the inspection.`,
    noPhotos: 'No photos.',
    signatures: 'Signatures',
    signedBy: (who: string | null, on: string, sha: string) => `Result signed by ${who ?? 'the inspector at the bench (PIN)'} on ${on} · e-signature ${sha}`,
    releases: 'Releases',
    releaseLine: (number: string, n: number, on: string, by: string | null, reversed: number) =>
      `${number}: ${n} ${n === 1 ? 'garment' : 'garments'} released on ${on} ${by ? `by ${by}` : 'at the bench (PIN)'}${reversed > 0 ? ` · ${reversed} taken back` : ''}`,
    noReleases: 'No release.',
    amendments: 'Corrections after signing',
    amendmentLine: (ref: number, field: string, from: string, to: string) => `A${ref} · ${field}: from ${from} to ${to}`,
    amendmentWhy: (reason: string, asked: string, signed: string, on: string) => `Reason: ${reason} · asked by ${asked}, countersigned by ${signed} on ${on}`,
    noAmendments: 'No correction.',
    note: 'Note',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Inspection-report',
    cause: 'cause',
  },
} as const

/** A value out of its spec in words, in the document's language: "over by 0.8 cm", "sotto di 0.5 cm". */
function deviation(measured: string, nominal: string, tolerance: string, uom: Uom, language: DocumentLanguage): string {
  const value = new Dec(measured)
  const high = new Dec(nominal).plus(new Dec(tolerance))
  const low = new Dec(nominal).minus(new Dec(tolerance))
  const unit = uom.toLowerCase()
  if (value.greaterThan(high)) return `${language === 'it' ? 'oltre di' : 'over by'} ${decimalWords(value.minus(high).toFixed(3))} ${unit}`
  if (value.lessThan(low)) return `${language === 'it' ? 'sotto di' : 'under by'} ${decimalWords(low.minus(value).toFixed(3))} ${unit}`
  return language === 'it' ? 'entro tolleranza' : 'within tolerance'
}

const zoneWords = (zone: string | null, language: DocumentLanguage): string => (zone ? (GARMENT_ZONES.find((entry) => entry.id === zone)?.[language] ?? zone) : '-')

/** The inspection report as the PDF prints it: every word decided here. */
export function inspectionReport(input: ReportInput): QualityDocument {
  const w = REPORT_WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const { inspection, workOrder, sampling, counts } = input
  const result = inspection.status === 'PASSED' ? w.passed : w.failed
  const computed = inspection.computedResult === null ? null : inspection.computedResult === 'PASS' ? w.passed : w.failed
  const resultText = inspection.overrideReason && computed ? `${result} (${w.overridden(computed)})` : result
  const style = `${workOrder.style.code} ${workOrder.style.name}${workOrder.style.revision === null ? '' : ` · ${w.revision} ${workOrder.style.revision}`}`
  const facts = [
    { label: w.number, value: inspection.number },
    { label: w.result, value: resultText },
    { label: w.workOrder, value: workOrder.number },
    { label: w.style, value: style },
    ...(workOrder.batchNumber ? [{ label: w.batch, value: workOrder.batchNumber }] : []),
    { label: w.lot, value: w.garments(sampling.lotSize) },
    { label: w.sampleSize, value: w.garments(sampling.sampleSize) },
    ...(sampling.plan ? [{ label: w.plan, value: sampling.plan }] : []),
    { label: w.decided, value: day(inspection.decidedOn) },
  ]

  const re = (accept: number) => String(accept + 1)
  const verdict = (found: number, accept: number) => (found > accept ? w.reject : w.accept)
  const aqlTable: DocumentTable = {
    columns: [
      { label: w.aqlColumns.cls, width: 0.22, align: 'left' },
      { label: w.aqlColumns.aql, width: 0.13, align: 'right' },
      { label: w.aqlColumns.ac, width: 0.17, align: 'right' },
      { label: w.aqlColumns.re, width: 0.16, align: 'right' },
      { label: w.aqlColumns.found, width: 0.14, align: 'right' },
      { label: w.aqlColumns.verdict, width: 0.18, align: 'left' },
    ],
    rows: [
      [w.classes.CRITICAL, '0', '0', '1', String(counts.critical), verdict(counts.critical, 0)],
      [w.classes.MAJOR, decimalWords(sampling.aqlMajor), String(sampling.acceptMajor), re(sampling.acceptMajor), String(counts.major), verdict(counts.major, sampling.acceptMajor)],
      [w.classes.MINOR, decimalWords(sampling.aqlMinor), String(sampling.acceptMinor), re(sampling.acceptMinor), String(counts.minor), verdict(counts.minor, sampling.acceptMinor)],
    ],
  }

  const checkRows: string[][] =
    input.checks === null
      ? input.checklist.map((line) => [`${line.label}${marks(line.amended)}`, '-', w.checklistOk(line.ok), '-', line.note?.trim() || '-'])
      : input.checks.flatMap((check) =>
          check.results.map((entry) => [
            `${check.label} (${check.code})${check.checkClass ? ` · ${w.classes[check.checkClass]}` : ''}`,
            String(entry.unit),
            w.outcomes[entry.outcome],
            `${entry.value ?? '-'}`,
            `${entry.note?.trim() || '-'}${marks(entry.amended)}`,
          ]),
        )
  const checksTable: DocumentTable | null =
    checkRows.length === 0
      ? null
      : {
          columns: [
            { label: w.checkColumns.code, width: 0.36, align: 'left' },
            { label: w.checkColumns.unit, width: 0.07, align: 'right' },
            { label: w.checkColumns.outcome, width: 0.15, align: 'left' },
            { label: w.checkColumns.value, width: 0.14, align: 'left' },
            { label: w.checkColumns.note, width: 0.28, align: 'left' },
          ],
          rows: checkRows,
        }

  const measureTable: DocumentTable | null =
    input.measurements.length === 0
      ? null
      : {
          columns: [
            { label: w.measureColumns.point, width: 0.2, align: 'left' },
            { label: w.measureColumns.size, width: 0.09, align: 'left' },
            { label: w.measureColumns.unit, width: 0.07, align: 'right' },
            { label: w.measureColumns.spec, width: 0.2, align: 'left' },
            { label: w.measureColumns.measured, width: 0.14, align: 'right' },
            { label: w.measureColumns.verdict, width: 0.3, align: 'left' },
          ],
          rows: input.measurements.map((entry) => [
            entry.pointCode,
            entry.size || '-',
            String(entry.unit),
            `${decimalWords(entry.nominal)} ± ${decimalWords(entry.tolerance)} ${entry.uom.toLowerCase()}`,
            `${decimalWords(entry.measured)}${marks(entry.amended)}`,
            entry.pass ? w.within : `${w.outcomes.FAIL}: ${deviation(entry.measured, entry.nominal, entry.tolerance, entry.uom, input.language)}`,
          ]),
        }

  const defectTable: DocumentTable | null =
    input.defects.length === 0
      ? null
      : {
          columns: [
            { label: w.defectColumns.cls, width: 0.13, align: 'left' },
            { label: w.defectColumns.code, width: 0.22, align: 'left' },
            { label: w.defectColumns.zone, width: 0.17, align: 'left' },
            { label: w.defectColumns.qty, width: 0.1, align: 'right' },
            { label: w.defectColumns.note, width: 0.38, align: 'left' },
          ],
          rows: input.defects.map((defect) => [
            w.classes[defect.defectClass],
            defect.code,
            `${zoneWords(defect.zone, input.language)}${marks(defect.zoneAmended)}`,
            String(defect.quantity),
            `${[defect.description?.trim(), defect.note?.trim(), defect.cause ? `${w.cause}: ${defect.cause}` : null].filter(Boolean).join(' · ') || '-'}${marks(defect.amended.filter((ref) => !defect.zoneAmended.includes(ref)))}`,
          ]),
        }

  const signature = w.signedBy(input.inspector, day(inspection.decidedOn), short(inspection.signatureSha256))
  const releases = input.releases.map((release) => w.releaseLine(release.number, release.garments, day(release.releasedOn), release.by, release.reversed))
  const amendments = input.amendments.flatMap((entry) => [w.amendmentLine(entry.ref, entry.field, entry.from, entry.to), w.amendmentWhy(entry.reason, entry.askedBy, entry.signedBy, day(entry.signedOn))])
  const note = paragraphs(inspection.note)
  const overrideLines = inspection.overrideReason ? paragraphs(inspection.overrideReason) : []

  const sections: DocumentSection[] = [
    section(w.sampling, [w.samplingLine(sampling.inspectionLevel, sampling.codeLetter, sampling.sampleSize, sampling.lotSize), ...overrideLines], aqlTable),
    section(w.checks, checksTable ? [] : [w.noChecks], checksTable),
    section(w.measurements, measureTable ? [] : [w.noMeasurements], measureTable),
    ...(input.identity ? [section(w.identity, [`${w.identityMode[input.identity.mode]}: ${w.identityOk(input.identity.ok)} · ${input.identity.words}`])] : []),
    section(w.defects, defectTable ? [] : [w.noDefects], defectTable),
    section(w.photos, [...(input.photos.length === 0 && input.photosLeftOut === 0 ? [w.noPhotos] : []), ...(input.photosLeftOut > 0 ? [w.photosLeftOut(input.photosLeftOut)] : [])], null, input.photos),
    ...(note.length > 0 ? [section(w.note, note.map((line, index) => (index === note.length - 1 ? `${line}${marks(inspection.noteAmended)}` : line)))] : []),
    section(w.signatures, [signature, ...(releases.length === 0 ? [w.noReleases] : releases)]),
    section(w.amendments, amendments.length === 0 ? [w.noAmendments] : amendments),
  ]

  return {
    language: input.language,
    meta: { title: `${w.title} ${inspection.number}`, subject: `${workOrder.number} · ${workOrder.style.code}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    dated: `${w.dated} ${day(input.date)}`,
    sections,
    page: w.page,
    fileName: `${w.file}-${inspection.number}-${input.language}.pdf`,
  }
}

// ---- the certificate of conformity ----------------------------------------------------------------------------------------

export interface CertificateLine {
  readonly style: { readonly code: string; readonly name: string; readonly revision: number | null }
  readonly colourway: string
  readonly size: string
  readonly garments: number
  readonly workOrder: string
  readonly batchNumber: string | null
  /** The final inspections and releases that cleared these garments (their numbers). */
  readonly inspections: readonly string[]
  readonly releases: readonly string[]
}

export interface CertificateInput {
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly company: DocumentCompany
  readonly shipment: { readonly number: string; readonly shippedOn: BusinessDate | null }
  readonly customer: { readonly name: string; readonly vatNumber: string | null }
  readonly order: { readonly number: string; readonly customerRef: string | null } | null
  readonly ddt: { readonly number: string; readonly date: BusinessDate } | null
  readonly lines: readonly CertificateLine[]
  /** The EU declarations of conformity of the PPE styles on it: their number and language; number null: not on file. */
  readonly declarations: readonly { readonly style: string; readonly number: string | null; readonly language: string }[]
  /** Who issues it: the office person keeping the version (null on a preview: the line says who will). */
  readonly issuer: string | null
  readonly sample: boolean
}

const CERTIFICATE_WORDS = {
  it: {
    title: 'Certificato di conformità',
    sample: 'ANTEPRIMA - versione non conservata',
    shipment: 'Spedizione',
    customer: 'Cliente',
    vat: 'Partita IVA',
    order: 'Ordine',
    yourRef: 'Vs. riferimento',
    ddt: 'DDT',
    shipped: 'Spedita il',
    dated: 'Data del certificato',
    statementHeading: 'Dichiarazione',
    statement: (company: string, n: number) =>
      `${company} dichiara che i ${n} capi di questa spedizione sono stati prodotti secondo l'ordine e le specifiche del modello indicati, hanno superato l'ispezione finale e sono stati rilasciati prima della spedizione, come riportato di seguito.`,
    goods: 'Merce',
    columns: { style: 'Modello', variant: 'Colore e taglia', qty: 'Capi', wo: 'Ordine di produzione', inspections: 'Ispezione finale', releases: 'Rilascio' },
    declarations: 'Dichiarazioni UE di conformità (DPI)',
    declarationLine: (style: string, number: string | null, language: string) => (number ? `${style}: ${number} (${language})` : `${style}: dichiarazione UE di conformità non in archivio`),
    noDeclarations: 'Nessun DPI in questa spedizione.',
    issued: 'Emesso da',
    issuedBy: (who: string, on: string) => `${who}, qualità · ${on}`,
    previewIssuer: 'Chi conserva la versione la emette a suo nome.',
    revision: 'rev.',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Certificato-conformita',
  },
  en: {
    title: 'Certificate of conformity',
    sample: 'PREVIEW - version not kept',
    shipment: 'Shipment',
    customer: 'Customer',
    vat: 'VAT number',
    order: 'Order',
    yourRef: 'Your reference',
    ddt: 'Delivery note (DDT)',
    shipped: 'Shipped on',
    dated: 'Certificate date',
    statementHeading: 'Statement',
    statement: (company: string, n: number) =>
      `${company} declares that the ${n} garments of this shipment were made to the order and to the style specifications named, passed final inspection and were released before shipping, as listed below.`,
    goods: 'Goods',
    columns: { style: 'Style', variant: 'Colour and size', qty: 'Garments', wo: 'Work order', inspections: 'Final inspection', releases: 'Release' },
    declarations: 'EU declarations of conformity (PPE)',
    declarationLine: (style: string, number: string | null, language: string) => (number ? `${style}: ${number} (${language})` : `${style}: EU declaration of conformity not on file`),
    noDeclarations: 'No PPE on this shipment.',
    issued: 'Issued by',
    issuedBy: (who: string, on: string) => `${who}, quality · ${on}`,
    previewIssuer: 'Whoever keeps the version issues it in their name.',
    revision: 'revision',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Certificate-of-conformity',
  },
} as const

/** The certificate of conformity as the PDF prints it: every word decided here. No price anywhere. */
export function conformityCertificate(input: CertificateInput): QualityDocument {
  const w = CERTIFICATE_WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const garments = input.lines.reduce((sum, line) => sum + line.garments, 0)
  const facts = [
    { label: w.shipment, value: input.shipment.number },
    { label: w.customer, value: input.customer.name },
    ...(input.customer.vatNumber ? [{ label: w.vat, value: input.customer.vatNumber }] : []),
    ...(input.order ? [{ label: w.order, value: input.order.number }] : []),
    ...(input.order?.customerRef ? [{ label: w.yourRef, value: input.order.customerRef }] : []),
    ...(input.ddt ? [{ label: w.ddt, value: `${input.ddt.number} · ${day(input.ddt.date)}` }] : []),
    ...(input.shipment.shippedOn ? [{ label: w.shipped, value: day(input.shipment.shippedOn) }] : []),
  ]
  const goods: DocumentTable = {
    columns: [
      { label: w.columns.style, width: 0.25, align: 'left' },
      { label: w.columns.variant, width: 0.15, align: 'left' },
      { label: w.columns.qty, width: 0.08, align: 'right' },
      { label: w.columns.wo, width: 0.16, align: 'left' },
      { label: w.columns.inspections, width: 0.18, align: 'left' },
      { label: w.columns.releases, width: 0.18, align: 'left' },
    ],
    rows: input.lines.map((line) => [
      `${line.style.code} ${line.style.name}${line.style.revision === null ? '' : ` · ${w.revision} ${line.style.revision}`}`,
      `${line.colourway} ${line.size}`,
      String(line.garments),
      `${line.workOrder}${line.batchNumber ? ` · ${line.batchNumber}` : ''}`,
      line.inspections.join(', ') || '-',
      line.releases.join(', ') || '-',
    ]),
  }
  const sections: DocumentSection[] = [
    section(w.statementHeading, [w.statement(input.company.name, garments)]),
    section(w.goods, [], goods),
    section(w.declarations, input.declarations.length === 0 ? [w.noDeclarations] : input.declarations.map((entry) => w.declarationLine(entry.style, entry.number, entry.language))),
    section(w.issued, [input.issuer ? w.issuedBy(input.issuer, day(input.date)) : w.previewIssuer]),
  ]
  return {
    language: input.language,
    meta: { title: `${w.title} ${input.shipment.number}`, subject: input.customer.name, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    dated: `${w.dated} ${day(input.date)}`,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.shipment.number}-${input.language}.pdf`,
  }
}

/**
 * The certificate's fingerprint leaves out who issued it and the date (the issuer line is the last section): the same
 * goods, documents and words give the same version back whoever presses Keep again.
 */
export function certificateFingerprintText(document: QualityDocument): string {
  return JSON.stringify({ language: document.language, title: document.title, company: document.company, facts: document.facts, sections: document.sections.slice(0, -1) })
}

// ---- when a certificate can be issued ---------------------------------------------------------------------------------------

/** The shipment states a certificate is made in: packed, gone, delivered (a draft can still change, a cancelled or returned one carries no goods). */
export const CERTIFIABLE_STATES = ['PACKED', 'SHIPPED', 'DELIVERED'] as const

export interface CellCover {
  readonly label: string
  /** Garments of the cell on this shipment, on every shipment that is not a draft or cancelled, released now (less reversals). */
  readonly onShipment: number
  readonly onShipments: number
  readonly released: number
}

/** Why a certificate cannot be issued now, in words (empty: it can). */
export function certificateProblems(input: { readonly status: string; readonly lines: number; readonly cells: readonly CellCover[] }): string[] {
  const problems: string[] = []
  if (!(CERTIFIABLE_STATES as readonly string[]).includes(input.status)) {
    problems.push(input.status === 'DRAFT' ? 'The shipment is a draft: its lines can still change. Pack it first.' : `The shipment is ${input.status.toLowerCase()}: no certificate of conformity is issued for it.`)
  }
  if (input.lines === 0) problems.push('The shipment has no garments.')
  for (const cell of input.cells) {
    if (cell.released < cell.onShipments) problems.push(`${cell.label}: ${cell.onShipments} garments on shipments, ${cell.released} released now. Every garment it certifies must stand released.`)
  }
  return problems
}
