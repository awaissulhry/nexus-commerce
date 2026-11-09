import { ValidationError } from '../../core/errors'
import { businessDayStart, toUtcIso, type BusinessDate } from '../../core/time'
import type { ComposedColumn, ComposedDocument } from '../../documents/compose'
import { formatDate, formatDecimal } from '../../documents/format'
import { DOCUMENT_WORDS } from '../../documents/i18n'
import { legalFooter, legalLines, legalName, legalProblems } from '../../documents/legal'
import type { CompanyLegal, DocumentLanguage, DocumentType } from '../../documents/model'
import type { VersionStatus } from './rules'

/**
 * The instruction sheet (B-W2b-214; PRD-117 "the PDF sheet"; design production.instructions "Instruction sheet PDF: paper
 * at the station"): one version of a work instruction on A4 through the shared renderer (apps/factory-api
 * platform/documents/pdf.ts): the company's header, the instruction's number and version, the operation and the style it is
 * for, the machine settings, the steps in order (critical points marked, the tick the tablet asks), the safety notes boxed.
 * A version that is not the one in force says so across the top: paper at a station must never pass for the current one.
 * The renderer prints no pictures: a step says how many photos and videos the tablet shows. No money, no person but the
 * office users who wrote and approved it.
 */

export const INSTRUCTION_SHEET_LAYOUT = 'WORK_INSTRUCTION/1'
const TYPE = 'WORK_INSTRUCTION' as unknown as DocumentType

const WORDS = {
  it: {
    title: 'Istruzione di lavoro',
    issuer: 'Azienda',
    number: 'Numero',
    version: 'Versione',
    operation: 'Operazione',
    style: 'Modello',
    everyStyle: 'Tutti i modelli',
    revision: 'rev.',
    published: 'Pubblicata il',
    approvedBy: 'Approvata da',
    writtenBy: 'Scritta da',
    change: 'Cosa cambia',
    settings: 'Impostazioni macchina',
    columns: { code: 'Passo', description: 'Come si fa', uom: 'Punto critico', quantity: 'Spunta' },
    critical: 'sì',
    required: 'obbligatoria',
    optional: 'facoltativa',
    media: (n: number) => (n === 1 ? '1 foto o video sul tablet' : `${n} foto o video sul tablet`),
    banners: { DRAFT: 'BOZZA: non pubblicata, non usarla in reparto', SUPERSEDED: 'SOSTITUITA da una versione più recente: usa quella sul tablet', DISCARDED: 'SCARTATA: non è mai stata pubblicata' },
    safety: (code: string, text: string) => `Sicurezza, passo ${code}: ${text}`,
    current: (n: number) => `Questa carta è la versione ${n}. Sul tablet c'è sempre la versione in vigore: in caso di dubbio vale il tablet.`,
    none: 'Nessun passo.',
    printed: 'Stampata il',
  },
  en: {
    title: 'Work instruction',
    issuer: 'Company',
    number: 'Number',
    version: 'Version',
    operation: 'Operation',
    style: 'Style',
    everyStyle: 'Every style',
    revision: 'rev.',
    published: 'Published on',
    approvedBy: 'Approved by',
    writtenBy: 'Written by',
    change: 'What changed',
    settings: 'Machine settings',
    columns: { code: 'Step', description: 'How to do it', uom: 'Critical point', quantity: 'Tick' },
    critical: 'yes',
    required: 'required',
    optional: 'optional',
    media: (n: number) => (n === 1 ? '1 photo or video on the tablet' : `${n} photos or videos on the tablet`),
    banners: { DRAFT: 'DRAFT: not published, do not use it at the station', SUPERSEDED: 'SUPERSEDED by a newer version: use the one on the tablet', DISCARDED: 'DISCARDED: it was never published' },
    safety: (code: string, text: string) => `Safety, step ${code}: ${text}`,
    current: (n: number) => `This paper is version ${n}. The tablet always shows the version in force: when in doubt, the tablet counts.`,
    none: 'No step.',
    printed: 'Printed on',
  },
} as const

export interface SheetSetting {
  readonly seq: number
  readonly machineClass: string | null
  readonly stitchType: string | null
  readonly needle: string | null
  readonly thread: string | null
  readonly stitchesPerCm: string | null
  readonly tension: string | null
  readonly foot: string | null
  readonly notes: string | null
}

export interface SheetStep {
  readonly code: string
  readonly text: string
  readonly critical: boolean
  readonly safety: string | null
  readonly requiredTick: boolean
  readonly media: number
}

export interface SheetInput {
  readonly language: DocumentLanguage
  readonly company: CompanyLegal
  readonly printedOn: BusinessDate
  readonly instruction: { readonly number: string; readonly operation: { readonly code: string; readonly name: string }; readonly style: { readonly code: string; readonly name: string; readonly revision: number } | null }
  readonly version: {
    readonly number: number
    readonly status: VersionStatus
    /** The day it was published (Europe/Rome), null for a draft. */
    readonly publishedOn: BusinessDate | null
    readonly authorName: string | null
    readonly approvedByName: string | null
    readonly changeNote: string | null
  }
  readonly settings: readonly SheetSetting[]
  readonly steps: readonly SheetStep[]
}

const column = (key: ComposedColumn['key'], width: number, align: 'left' | 'right', label: string): ComposedColumn => ({ key, width, align, label })

function settingLine(setting: SheetSetting, language: DocumentLanguage): string {
  const parts = [
    setting.machineClass,
    setting.stitchType ? (language === 'it' ? `punto ${setting.stitchType}` : `stitch ${setting.stitchType}`) : null,
    setting.needle,
    setting.thread,
    setting.stitchesPerCm ? `${formatDecimal(setting.stitchesPerCm, language, 0, 2)} ${language === 'it' ? 'punti/cm' : 'stitches/cm'}` : null,
    setting.tension,
    setting.foot,
    setting.notes,
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '')
  return `${setting.seq}. ${parts.join(' · ')}`
}

/** The sheet of one version. */
export function instructionSheetDocument(input: SheetInput): ComposedDocument {
  const { language, instruction, version } = input
  const words = WORDS[language]
  const problems = legalProblems(input.company)
  if (problems.length > 0) throw new ValidationError('The sheet cannot be printed as it stands.', problems)
  const name = legalName(input.company, language)
  const style = instruction.style ? `${instruction.style.code} ${instruction.style.name} (${words.revision} ${instruction.style.revision})` : words.everyStyle
  const rows = input.steps.map((step, index) => [
    `${index + 1}. ${step.code}`,
    [step.text, ...(step.media > 0 ? [`(${words.media(step.media)})`] : [])].join(' '),
    step.critical ? words.critical : '',
    step.requiredTick ? words.required : words.optional,
  ])
  const banner = version.status === 'PUBLISHED' ? null : words.banners[version.status]
  return {
    type: TYPE,
    language,
    layout: INSTRUCTION_SHEET_LAYOUT,
    title: words.title,
    issuer: { heading: words.issuer, name, lines: legalLines(input.company, language) },
    identity: [
      { label: words.number, value: instruction.number },
      { label: words.version, value: String(version.number) },
      { label: words.printed, value: formatDate(input.printedOn, language) },
    ],
    banner,
    blocks: [
      { heading: words.operation, lines: [`${instruction.operation.code} ${instruction.operation.name}`] },
      { heading: words.style, lines: [style] },
      ...(input.settings.length > 0 ? [{ heading: words.settings, lines: input.settings.map((setting) => settingLine(setting, language)) }] : []),
    ],
    facts: [
      ...(version.publishedOn ? [{ label: words.published, value: formatDate(version.publishedOn, language) }] : []),
      ...(version.approvedByName ? [{ label: words.approvedBy, value: version.approvedByName }] : []),
      ...(version.authorName ? [{ label: words.writtenBy, value: version.authorName }] : []),
      ...(version.changeNote?.trim() ? [{ label: words.change, value: version.changeNote.trim() }] : []),
    ],
    table: {
      columns: [column('code', 180, 'left', words.columns.code), column('description', 580, 'left', words.columns.description), column('uom', 120, 'left', words.columns.uom), column('quantity', 120, 'left', words.columns.quantity)],
      rows: rows.length > 0 ? rows : [['', words.none, '', '']],
    },
    totals: [],
    notes: null,
    notices: [...input.steps.filter((step) => step.safety).map((step) => words.safety(step.code, step.safety!)), words.current(version.number)],
    signatures: [],
    footer: {
      legal: legalFooter(input.company, language),
      text: input.company.documentFooter?.trim() ? input.company.documentFooter.trim() : null,
      page: DOCUMENT_WORDS[language].page,
      continued: DOCUMENT_WORDS[language].continued,
    },
    meta: {
      title: `${words.title} ${instruction.number} v${version.number}`,
      author: name,
      subject: `${INSTRUCTION_SHEET_LAYOUT} ${language}`,
      createdAt: toUtcIso(businessDayStart(input.printedOn)),
      keywords: ['WORK_INSTRUCTION', instruction.number, `v${version.number}`, version.status].join(' '),
    },
  }
}
