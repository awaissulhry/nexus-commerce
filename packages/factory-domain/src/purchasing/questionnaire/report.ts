import type { BusinessDate } from '../../core/time'
import { QUESTION_SECTIONS, type Question, type QuestionDocument, type QuestionSection } from './questions'
import type { SiteRow } from './answers'

/**
 * The words of the questionnaire's PDFs (B-W2b-172; SCM-023), built here so they are pure and tested; apps/factory-api
 * paints them (modules/purchasing/questionnaire/pdf.ts):
 *
 *   the answer      kept on the supplier's files when it is sent: who answered which version when, every question with
 *                   its answer (and the words given with it), the sites and sub-tier sites, the documents with their
 *                   issue and expiry day, and the signed statement — in the language the supplier answered in
 *   the code        the code of conduct of a SIGN question, read before signing (design links.onboard tab:code-of-conduct)
 *
 * No money anywhere.
 */

type Locale = 'it' | 'en'

export interface ReportFact {
  readonly label: string
  readonly value: string
}

export interface ReportRow {
  readonly question: string
  readonly answer: string
  readonly words: string | null
}

export interface ReportTable {
  readonly heading: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export interface AnswerReport {
  readonly language: Locale
  readonly title: string
  readonly company: string
  readonly facts: readonly ReportFact[]
  readonly sections: ReadonlyArray<{ readonly heading: string; readonly rows: readonly ReportRow[]; readonly tables: readonly ReportTable[] }>
  readonly statement: { readonly heading: string; readonly text: string; readonly signed: string }
  readonly footer: string
  readonly createdAt: string
}

const SECTION_WORDS: Readonly<Record<QuestionSection, { it: string; en: string }>> = {
  company: { it: '1 · Azienda', en: '1 · Company' },
  contacts: { it: '2 · Contatti', en: '2 · Contacts' },
  sites: { it: '3 · Stabilimenti e subfornitori', en: '3 · Sites and sub-suppliers' },
  certifications: { it: '4 · Certificazioni e prove', en: '4 · Certifications and tests' },
  labour: { it: '5 · Lavoro e aspetti sociali', en: '5 · Labour and social' },
}

const STEP_WORDS: Readonly<Record<string, { it: string; en: string }>> = {
  BEAMHOUSE: { it: 'Riviera', en: 'Beamhouse' },
  TANNING: { it: 'Concia', en: 'Tanning' },
  RETANNING: { it: 'Riconcia', en: 'Retanning' },
  FINISHING: { it: 'Rifinizione', en: 'Finishing' },
  WEAVING: { it: 'Tessitura', en: 'Weaving' },
  DYEING: { it: 'Tintoria', en: 'Dyeing' },
  MANUFACTURING: { it: 'Produzione', en: 'Manufacturing' },
}

const W = {
  it: {
    title: (revision: number) => `Questionario fornitore — versione ${revision}`,
    supplier: 'Fornitore',
    questionnaire: 'Questionario',
    sent: 'Inviato il',
    via: 'Inviato con',
    link: 'link personale',
    signer: 'Firmato da',
    yes: 'Sì',
    no: 'No',
    signed: 'Letto e firmato',
    none: '—',
    file: (name: string, issued: string | null, expires: string | null) => [name, issued ? `emesso il ${issued}` : null, expires ? `scade il ${expires}` : null].filter(Boolean).join(' · '),
    sites: 'I vostri stabilimenti',
    subTier: 'I vostri subfornitori',
    siteColumns: ['Nome', 'Paese', 'Località', 'Fasi'],
    statementHeading: '6 · Dichiarazione firmata',
    statement: 'Dichiaro che le informazioni date sono vere per quanto a mia conoscenza.',
    signedLine: (name: string, role: string | null, at: string) => `${name}${role ? `, ${role}` : ''} — ${at}`,
    footer: (company: string) => `${company} · questionario fornitore (due diligence, Regolamento (UE) 2024/3015)`,
  },
  en: {
    title: (revision: number) => `Supplier questionnaire — version ${revision}`,
    supplier: 'Supplier',
    questionnaire: 'Questionnaire',
    sent: 'Sent on',
    via: 'Sent through',
    link: 'personal link',
    signer: 'Signed by',
    yes: 'Yes',
    no: 'No',
    signed: 'Read and signed',
    none: '—',
    file: (name: string, issued: string | null, expires: string | null) => [name, issued ? `issued ${issued}` : null, expires ? `expires ${expires}` : null].filter(Boolean).join(' · '),
    sites: 'Your sites',
    subTier: 'Your sub-suppliers',
    siteColumns: ['Name', 'Country', 'Town', 'Steps'],
    statementHeading: '6 · Signed statement',
    statement: 'I declare that the information given is true to the best of my knowledge.',
    signedLine: (name: string, role: string | null, at: string) => `${name}${role ? `, ${role}` : ''} — ${at}`,
    footer: (company: string) => `${company} · supplier questionnaire (due diligence, Regulation (EU) 2024/3015)`,
  },
} as const

/** A day in the reader's way: 09/11/2026 or 2026-11-09. */
export const dayIn = (day: BusinessDate, locale: Locale): string => (locale === 'it' ? day.split('-').reverse().join('/') : day)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** One answer in words, for the PDF and the office's read. */
export function answerWords(question: Question, entry: { readonly value?: unknown } | undefined, locale: Locale, fileName: (fileId: string) => string): string {
  const w = W[locale]
  const value = entry?.value
  if (value === undefined || value === null || value === '') return w.none
  switch (question.kind) {
    case 'YES_NO':
      return value === 'YES' ? w.yes : value === 'NO' ? w.no : w.none
    case 'CHOICE':
      return question.options?.find((option) => option.code === value)?.text[locale] ?? text(value)
    case 'SIGN':
      return value === 'SIGNED' ? w.signed : w.none
    case 'CONTACT':
      return isRecord(value) ? [text(value.name), text(value.email), text(value.phone)].filter(Boolean).join(' · ') : w.none
    case 'FILE':
      if (!isRecord(value)) return w.none
      return [w.file(fileName(text(value.fileId)), value.issuedOn ? dayIn(text(value.issuedOn), locale) : null, value.expiresOn ? dayIn(text(value.expiresOn), locale) : null), text(value.issuer), text(value.number)].filter(Boolean).join(' · ')
    default:
      return text(value) || w.none
  }
}

const siteTable = (heading: string, rows: readonly SiteRow[], locale: Locale): ReportTable => ({
  heading,
  columns: W[locale].siteColumns,
  rows: rows.map((row) => [row.name, row.country, row.town ?? '', row.steps.map((step) => STEP_WORDS[step]?.[locale] ?? step).join(', ')]),
})

export interface AnswerReportInput {
  readonly locale: Locale
  readonly companyName: string
  readonly supplier: { readonly code: string; readonly name: string }
  readonly revision: number
  readonly title: string
  readonly questions: readonly Question[]
  readonly answers: Readonly<Record<string, { readonly value?: unknown; readonly explain?: string | null }>>
  readonly sites: readonly SiteRow[]
  readonly subTierSites: readonly SiteRow[]
  readonly signedName: string
  readonly signedRole: string | null
  /** When it was sent, in the reader's words (day and time). */
  readonly sentWords: string
  readonly sentAt: string
  readonly viaLink: boolean
  readonly fileNames: ReadonlyMap<string, string>
}

/** The answer's report, section by section in the version's order. */
export function answerReport(input: AnswerReportInput): AnswerReport {
  const { locale } = input
  const w = W[locale]
  const fileName = (fileId: string) => input.fileNames.get(fileId) ?? fileId
  const sections = QUESTION_SECTIONS.flatMap((section) => {
    const questions = input.questions.filter((question) => question.section === section)
    if (questions.length === 0) return []
    const rows: ReportRow[] = []
    const tables: ReportTable[] = []
    for (const question of questions) {
      if (question.kind === 'SITES') tables.push(siteTable(question.text[locale] || w.sites, input.sites, locale))
      else if (question.kind === 'SUB_TIER_SITES') tables.push(siteTable(question.text[locale] || w.subTier, input.subTierSites, locale))
      else {
        const entry = input.answers[question.key]
        const words = entry?.explain?.trim() ? entry.explain.trim() : null
        rows.push({ question: question.text[locale], answer: answerWords(question, entry, locale, fileName), words })
      }
    }
    return [{ heading: SECTION_WORDS[section][locale], rows, tables }]
  })
  return {
    language: locale,
    title: w.title(input.revision),
    company: input.companyName,
    facts: [
      { label: w.supplier, value: `${input.supplier.name} (${input.supplier.code})` },
      { label: w.questionnaire, value: `${input.title} · v${input.revision}` },
      { label: w.sent, value: input.sentWords },
      { label: w.via, value: input.viaLink ? w.link : '—' },
      { label: w.signer, value: `${input.signedName}${input.signedRole ? `, ${input.signedRole}` : ''}` },
    ],
    sections,
    statement: { heading: w.statementHeading, text: w.statement, signed: w.signedLine(input.signedName, input.signedRole, input.sentWords) },
    footer: w.footer(input.companyName),
    createdAt: input.sentAt,
  }
}

/** The code of conduct to read before signing, in the reader's language. */
export function codeReport(document: QuestionDocument, locale: Locale, companyName: string): { readonly title: string; readonly company: string; readonly paragraphs: readonly string[]; readonly language: Locale } {
  return { title: document.title[locale], company: companyName, paragraphs: [...document.paragraphs[locale]], language: locale }
}
