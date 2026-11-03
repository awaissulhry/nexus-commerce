import type { BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import type { DiscrepancyReport, ReportColumn } from '../../inventory/receipts/report'
import { keptYearsOf, type CheckIntervalUnit, type CheckOutcome } from './rules'

/**
 * The check report (B-W2b-124; QHS-205; design plant.preventive tab "Check report (PDF) — From a result"): one result of the
 * check register on A4, in Italian or English, for the file and for an inspector (D.Lgs. 81/2008 art. 71: results kept at
 * least three years). The company's letterhead, the machine, the check type with the law it rests on, the day, who did
 * it, the outcome and remarks, the next due date, until when it is kept, the report files on record, and the register of
 * this machine and check type (newest first) with this result marked. Painted by apps/factory-api with the A4 renderer
 * of the discrepancy report (the same shape); the PDF is a GeneratedDocument CHECK_REPORT of the result.
 *
 * A pure function of what it prints: the same result, register, files and language give the same text (its fingerprint).
 * No money and no worker: "who did it" is the outside body or the inspector as on the report.
 */

export interface CheckReportResult {
  readonly id: string
  readonly performedOn: BusinessDate
  readonly outcome: CheckOutcome
  readonly remarks: string | null
  readonly performedBy: string
  readonly outsideBody: string | null
  readonly nextDueOn: BusinessDate | null
  readonly keptUntil: BusinessDate
  readonly correctsOn: BusinessDate | null
  readonly correctionReason: string | null
  readonly correctedOn: BusinessDate | null
}

export interface CheckReportInput {
  readonly language: DocumentLanguage
  /** When the PDF is made (its metadata only; the text never shows it). */
  readonly createdAt: string
  readonly company: DiscrepancyReport['company']
  readonly machine: { readonly assetNumber: string; readonly make: string | null; readonly modelName: string | null; readonly serialNumber: string | null; readonly site: string }
  readonly checkType: { readonly code: string; readonly labelIt: string; readonly labelEn: string; readonly legalBasis: string; readonly retentionYears: number }
  readonly plan: { readonly interval: number; readonly intervalUnit: CheckIntervalUnit; readonly nextDueOn: BusinessDate; readonly ended: boolean } | null
  readonly result: CheckReportResult
  /** The report files of the result (and of the result it corrects), by name. */
  readonly files: readonly string[]
  /** The register of this machine and check type, newest first (this result among them). */
  readonly register: readonly CheckReportResult[]
  /** A preview, not a kept version: a banner says so. */
  readonly sample: boolean
}

const WORDS = {
  it: {
    title: 'Rapporto di verifica periodica',
    sample: 'ANTEPRIMA - non conservato',
    machine: 'Macchina',
    check: 'Verifica',
    law: 'Riferimento normativo',
    doneOn: 'Eseguita il',
    by: 'Eseguita da',
    body: 'Ente esterno',
    outcome: 'Esito',
    nextDue: 'Prossima scadenza',
    keptUntil: 'Conservare fino al',
    plan: 'Periodicità del piano',
    noPlan: 'Fuori piano',
    ended: 'piano chiuso',
    files: 'Rapporti in archivio',
    noFiles: 'nessun rapporto caricato',
    corrects: (day: string, why: string) => `Corregge il risultato del ${day}: ${why}`,
    correctedOn: (day: string) => `Corretto dal risultato del ${day}.`,
    intro: (kept: number) => `Registro dei controlli della macchina (D.Lgs. 81/2008 art. 71: risultati conservati almeno 3 anni); i risultati di questa verifica si conservano ${kept} anni.`,
    remarks: 'Osservazioni',
    none: '-',
    closing: 'Documento generato dal registro dei controlli; i rapporti dell\'ente o del tecnico sono conservati con il risultato.',
    columns: { seq: 'N.', material: 'Data', kind: 'Esito', quantity: 'Prossima scad.', note: 'Eseguita da · osservazioni' },
    outcomes: { PASSED: 'Superata', PASSED_WITH_REMARKS: 'Superata con osservazioni', FAILED: 'Non superata' },
    units: { DAY: ['giorno', 'giorni'], WEEK: ['settimana', 'settimane'], MONTH: ['mese', 'mesi'], YEAR: ['anno', 'anni'] },
    every: 'ogni',
    thisOne: '(questo)',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'Rapporto-verifica',
  },
  en: {
    title: 'Periodic check report',
    sample: 'PREVIEW - not kept',
    machine: 'Machine',
    check: 'Check',
    law: 'Legal basis',
    doneOn: 'Done on',
    by: 'Done by',
    body: 'Outside body',
    outcome: 'Outcome',
    nextDue: 'Next due',
    keptUntil: 'Keep until',
    plan: 'Plan interval',
    noPlan: 'Out of plan',
    ended: 'plan ended',
    files: 'Reports on file',
    noFiles: 'no report uploaded',
    corrects: (day: string, why: string) => `Corrects the result of ${day}: ${why}`,
    correctedOn: (day: string) => `Corrected by the result of ${day}.`,
    intro: (kept: number) => `The machine's control register (D.Lgs. 81/2008 art. 71: results kept at least 3 years); this check's results are kept ${kept} years.`,
    remarks: 'Remarks',
    none: '-',
    closing: 'Made from the control register; the reports of the outside body or the technician are kept with the result.',
    columns: { seq: 'No.', material: 'Date', kind: 'Outcome', quantity: 'Next due', note: 'Done by · remarks' },
    outcomes: { PASSED: 'Passed', PASSED_WITH_REMARKS: 'Passed with remarks', FAILED: 'Failed' },
    units: { DAY: ['day', 'days'], WEEK: ['week', 'weeks'], MONTH: ['month', 'months'], YEAR: ['year', 'years'] },
    every: 'every',
    thisOne: '(this one)',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'Check-report',
  },
} as const

/** A day as printed: 20/11/2026 (both languages). */
const printed = (day: BusinessDate): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`

const COLUMNS = (language: DocumentLanguage): ReportColumn[] => {
  const w = WORDS[language].columns
  return [
    { key: 'seq', label: w.seq, width: 0.07, align: 'right' },
    { key: 'material', label: w.material, width: 0.15, align: 'left' },
    { key: 'kind', label: w.kind, width: 0.2, align: 'left' },
    { key: 'quantity', label: w.quantity, width: 0.15, align: 'left' },
    { key: 'note', label: w.note, width: 0.43, align: 'left' },
  ]
}

/** The interval in words: "every 3 months" / "ogni 3 mesi". */
export function intervalWords(language: DocumentLanguage, amount: number, unit: CheckIntervalUnit): string {
  const w = WORDS[language]
  const [one, many] = w.units[unit]
  return amount === 1 ? `${w.every} ${one}` : `${w.every} ${amount} ${many}`
}

/** The check report, ready to paint (the discrepancy report's A4 shape). */
export function checkReport(input: CheckReportInput): DiscrepancyReport {
  const w = WORDS[input.language]
  const { result, checkType, machine } = input
  const label = input.language === 'it' ? checkType.labelIt : checkType.labelEn
  const facts: { label: string; value: string }[] = [
    { label: w.check, value: `${label} (${checkType.code})` },
    { label: w.law, value: checkType.legalBasis },
    { label: w.doneOn, value: printed(result.performedOn) },
    { label: w.by, value: result.performedBy },
    ...(result.outsideBody ? [{ label: w.body, value: result.outsideBody }] : []),
    { label: w.outcome, value: w.outcomes[result.outcome] },
    { label: w.nextDue, value: result.nextDueOn ? printed(result.nextDueOn) : input.plan && !input.plan.ended ? printed(input.plan.nextDueOn) : w.none },
    { label: w.keptUntil, value: printed(result.keptUntil) },
    { label: w.plan, value: input.plan ? `${intervalWords(input.language, input.plan.interval, input.plan.intervalUnit)}${input.plan.ended ? ` (${w.ended})` : ''}` : w.noPlan },
    { label: w.files, value: input.files.length > 0 ? input.files.join(', ') : w.noFiles },
  ]
  const machineLines = [machine.assetNumber, [machine.make, machine.modelName].filter((part): part is string => Boolean(part)).join(' '), machine.serialNumber ? `S/N ${machine.serialNumber}` : '', machine.site].filter((line) => line.trim() !== '')
  const introParts = [w.intro(keptYearsOf(checkType.retentionYears))]
  if (result.remarks) introParts.push(`${w.remarks}: ${result.remarks}`)
  if (result.correctsOn && result.correctionReason) introParts.push(w.corrects(printed(result.correctsOn), result.correctionReason))
  if (result.correctedOn) introParts.push(w.correctedOn(printed(result.correctedOn)))
  const total = input.register.length
  const rows = input.register.map((entry, index) => ({
    seq: String(total - index),
    material: `${printed(entry.performedOn)}${entry.id === result.id ? ` ${w.thisOne}` : ''}`,
    kind: w.outcomes[entry.outcome],
    quantity: entry.nextDueOn ? printed(entry.nextDueOn) : w.none,
    note: [entry.performedBy, entry.remarks, entry.correctedOn ? w.correctedOn(printed(entry.correctedOn)) : null].filter((part): part is string => Boolean(part)).join(' · '),
  }))
  const title = `${w.title} · ${machine.assetNumber}`
  return {
    language: input.language,
    meta: { title, subject: `${label} ${printed(result.performedOn)}`, createdAt: input.createdAt },
    title: w.title,
    sample: input.sample ? w.sample : null,
    company: input.company,
    facts,
    supplier: { label: w.machine, lines: machineLines },
    intro: introParts.join(' '),
    columns: COLUMNS(input.language),
    rows,
    closing: w.closing,
    page: w.page,
    fileName: `${w.file}-${machine.assetNumber.replace(/[^A-Za-z0-9_-]/g, '_')}-${checkType.code}-${result.performedOn}.pdf`,
  }
}

/** What the report shows, as one text: its fingerprint's source (the same contents give the same text, whatever the day). */
export function reportFingerprintText(input: Omit<CheckReportInput, 'createdAt' | 'sample'>): string {
  return JSON.stringify({
    language: input.language,
    company: input.company,
    machine: input.machine,
    checkType: input.checkType,
    plan: input.plan,
    result: input.result,
    files: [...input.files],
    register: input.register.map((entry) => ({ ...entry })),
  })
}
