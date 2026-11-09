import type { Issue } from '../../core/errors'

/**
 * The supplier questionnaire's questions, as data (B-W2b-172; SCM-023; design links.onboard; portal-supply.prisma
 * SupplierQuestionnaire.questions). A company keeps its questionnaire in versions: each version is an ordered list of
 * questions, each with a key unique in the version (`^[a-z][a-z0-9_.-]{0,99}$`, the database's rule too), the step of the
 * form it sits in (its section), its kind, whether it must be answered, and its words in Italian and English. A version is
 * changed only until it is published; from then on it is fixed, and every answer names the version it answers.
 *
 *   section          the step of the link page       kinds that sit there
 *   company          1 · Company                      TEXT, LONG_TEXT, VAT (checked live in VIES), ADDRESS, URL
 *   contacts         2 · Contacts                     CONTACT (name, e-mail, phone of the person for orders, invoices…)
 *   sites            3 · Sites and sub-suppliers      SITES (the supplier's own), SUB_TIER_SITES (who does each step)
 *   certifications   4 · Certifications and tests     FILE (a document with its issue and expiry day), CHOICE, YES_NO,
 *                                                     TEXT, LONG_TEXT
 *   labour           5 · Labour and social            YES_NO (+ words when the answer is the one that needs them),
 *                                                     CHOICE, TEXT, LONG_TEXT, SIGN (the code of conduct, signed)
 *
 * Any kind may sit in any section the API draws (the table says where they belong); SITES and SUB_TIER_SITES are answered
 * in the answer's own lists (`sites`, `subTierSites`), every other kind in `answers` by its key. Nothing here is money.
 */

export const QUESTION_SECTIONS = ['company', 'contacts', 'sites', 'certifications', 'labour'] as const
export type QuestionSection = (typeof QUESTION_SECTIONS)[number]

export const QUESTION_KINDS = ['TEXT', 'LONG_TEXT', 'VAT', 'ADDRESS', 'URL', 'CONTACT', 'SITES', 'SUB_TIER_SITES', 'FILE', 'YES_NO', 'CHOICE', 'SIGN'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

/** The kinds whose answer is a list of sites, kept in the answer's own columns. */
export const SITE_KINDS: readonly QuestionKind[] = Object.freeze(['SITES', 'SUB_TIER_SITES'])

/** What a FILE question's document is, once the buyer accepts the answer (StoredFile.category). */
export const DOCUMENT_CATEGORIES = ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'] as const
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

/** The steps a site does (for leather: beamhouse, tanning, retanning, finishing — design links.onboard sec:sites). */
export const SITE_STEPS = ['BEAMHOUSE', 'TANNING', 'RETANNING', 'FINISHING', 'WEAVING', 'DYEING', 'MANUFACTURING'] as const
export type SiteStep = (typeof SITE_STEPS)[number]

export const QUESTION_KEY = /^[a-z][a-z0-9_.-]{0,99}$/
const OPTION_CODE = /^[A-Z][A-Z0-9_]{0,39}$/

/** The limits of a version (the API's and the page's). */
export const QUESTIONNAIRE_LIMITS = Object.freeze({
  questions: 80,
  questionText: 400,
  help: 600,
  options: 12,
  optionText: 120,
  title: 120,
  documentParagraphs: 40,
  documentParagraph: 1500,
})

export interface Words {
  readonly it: string
  readonly en: string
}

export interface QuestionOption {
  readonly code: string
  readonly text: Words
}

/** A document the supplier reads before it signs (a SIGN question): painted as a PDF in the reader's language. */
export interface QuestionDocument {
  readonly title: Words
  readonly paragraphs: { readonly it: readonly string[]; readonly en: readonly string[] }
}

export interface Question {
  readonly key: string
  readonly section: QuestionSection
  readonly kind: QuestionKind
  readonly required: boolean
  readonly text: Words
  /** A hint under the field. */
  readonly help?: Words | null
  /** YES_NO: the answer that needs words ("explain"); none: words are optional. */
  readonly explain?: 'YES' | 'NO' | null
  /** CHOICE: the choices, in order. */
  readonly options?: readonly QuestionOption[] | null
  /** FILE: what the document is once accepted (default SUPPLIER_CERTIFICATE). */
  readonly category?: DocumentCategory | null
  /** SIGN: the document signed (the code of conduct). */
  readonly document?: QuestionDocument | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max

function wordsProblems(value: unknown, path: string, max: number): Issue[] {
  if (!isRecord(value)) return [{ path, message: 'Words in Italian and English: { it, en }.' }]
  return (['it', 'en'] as const).flatMap((language) => (isText(value[language], max) ? [] : [{ path: `${path}/${language}`, message: `1 to ${max} characters.` }]))
}

/** What is wrong with a version's questions (the API refuses a version with any), each at its place. */
export function questionProblems(questions: unknown): Issue[] {
  if (!Array.isArray(questions)) return [{ path: 'body/questions', message: 'A list of questions.' }]
  if (questions.length === 0) return [{ path: 'body/questions', message: 'At least one question.' }]
  if (questions.length > QUESTIONNAIRE_LIMITS.questions) return [{ path: 'body/questions', message: `At most ${QUESTIONNAIRE_LIMITS.questions} questions.` }]
  const seen = new Set<string>()
  const issues: Issue[] = []
  questions.forEach((question: unknown, index) => {
    const at = `body/questions/${index}`
    if (!isRecord(question)) {
      issues.push({ path: at, message: 'A question: { key, section, kind, required, text }.' })
      return
    }
    const key = question.key
    if (typeof key !== 'string' || !QUESTION_KEY.test(key)) issues.push({ path: `${at}/key`, message: 'A key: lower case letters, digits, . _ - (starting with a letter).' })
    else if (seen.has(key)) issues.push({ path: `${at}/key`, message: `The key ${key} is used twice.` })
    else seen.add(key)
    if (!(QUESTION_SECTIONS as readonly unknown[]).includes(question.section)) issues.push({ path: `${at}/section`, message: `One of ${QUESTION_SECTIONS.join(', ')}.` })
    if (!(QUESTION_KINDS as readonly unknown[]).includes(question.kind)) issues.push({ path: `${at}/kind`, message: `One of ${QUESTION_KINDS.join(', ')}.` })
    if (typeof question.required !== 'boolean') issues.push({ path: `${at}/required`, message: 'true or false.' })
    issues.push(...wordsProblems(question.text, `${at}/text`, QUESTIONNAIRE_LIMITS.questionText))
    if (question.help !== undefined && question.help !== null) issues.push(...wordsProblems(question.help, `${at}/help`, QUESTIONNAIRE_LIMITS.help))
    if (question.explain !== undefined && question.explain !== null) {
      if (question.kind !== 'YES_NO') issues.push({ path: `${at}/explain`, message: 'Only a YES_NO question asks for words on one answer.' })
      else if (question.explain !== 'YES' && question.explain !== 'NO') issues.push({ path: `${at}/explain`, message: 'YES or NO.' })
    }
    if (question.kind === 'CHOICE') {
      const options = question.options
      if (!Array.isArray(options) || options.length < 2 || options.length > QUESTIONNAIRE_LIMITS.options) issues.push({ path: `${at}/options`, message: `2 to ${QUESTIONNAIRE_LIMITS.options} choices.` })
      else {
        const codes = new Set<string>()
        options.forEach((option: unknown, at2) => {
          const place = `${at}/options/${at2}`
          if (!isRecord(option) || typeof option.code !== 'string' || !OPTION_CODE.test(option.code)) issues.push({ path: `${place}/code`, message: 'A code in capitals (A-Z, 0-9, _).' })
          else if (codes.has(option.code)) issues.push({ path: `${place}/code`, message: `The choice ${option.code} is listed twice.` })
          else codes.add(option.code)
          if (isRecord(option)) issues.push(...wordsProblems(option.text, `${place}/text`, QUESTIONNAIRE_LIMITS.optionText))
        })
      }
    } else if (question.options !== undefined && question.options !== null) issues.push({ path: `${at}/options`, message: 'Only a CHOICE question has choices.' })
    if (question.category !== undefined && question.category !== null) {
      if (question.kind !== 'FILE') issues.push({ path: `${at}/category`, message: 'Only a FILE question says what its document is.' })
      else if (!(DOCUMENT_CATEGORIES as readonly unknown[]).includes(question.category)) issues.push({ path: `${at}/category`, message: `One of ${DOCUMENT_CATEGORIES.join(', ')}.` })
    }
    if (question.document !== undefined && question.document !== null) {
      if (question.kind !== 'SIGN') issues.push({ path: `${at}/document`, message: 'Only a SIGN question carries a document to sign.' })
      else if (!isRecord(question.document)) issues.push({ path: `${at}/document`, message: 'A document: { title, paragraphs: { it, en } }.' })
      else {
        issues.push(...wordsProblems(question.document.title, `${at}/document/title`, QUESTIONNAIRE_LIMITS.questionText))
        const paragraphs = question.document.paragraphs
        if (!isRecord(paragraphs)) issues.push({ path: `${at}/document/paragraphs`, message: 'Paragraphs in Italian and English.' })
        else
          for (const language of ['it', 'en'] as const) {
            const list = paragraphs[language]
            if (!Array.isArray(list) || list.length === 0 || list.length > QUESTIONNAIRE_LIMITS.documentParagraphs || !list.every((line) => isText(line, QUESTIONNAIRE_LIMITS.documentParagraph))) {
              issues.push({ path: `${at}/document/paragraphs/${language}`, message: `1 to ${QUESTIONNAIRE_LIMITS.documentParagraphs} paragraphs of at most ${QUESTIONNAIRE_LIMITS.documentParagraph} characters.` })
            }
          }
      }
    }
  })
  return issues
}

/** The questions of a stored version, read leniently: anything that is not a question is left out (never throws). */
export function questionsOf(stored: unknown): Question[] {
  if (!Array.isArray(stored)) return []
  return stored.filter((question): question is Question => {
    if (!isRecord(question)) return false
    return (
      typeof question.key === 'string' &&
      (QUESTION_SECTIONS as readonly unknown[]).includes(question.section) &&
      (QUESTION_KINDS as readonly unknown[]).includes(question.kind) &&
      isRecord(question.text) &&
      typeof question.text.it === 'string' &&
      typeof question.text.en === 'string'
    )
  })
}

/** The questions of one section, in the version's order. */
export const sectionQuestions = (questions: readonly Question[], section: QuestionSection): Question[] => questions.filter((question) => question.section === section)

/** The section of a question key, or null. */
export const sectionOfKey = (questions: readonly Question[], key: string): QuestionSection | null => questions.find((question) => question.key === key)?.section ?? null

/** The document a version asks the supplier to sign (its first SIGN question that carries one), or null. */
export function codeOfConduct(questions: readonly Question[]): { readonly key: string; readonly document: QuestionDocument } | null {
  const question = questions.find((entry) => entry.kind === 'SIGN' && entry.document)
  return question?.document ? { key: question.key, document: question.document } : null
}

/** A FILE question's document category, once accepted. */
export const categoryOf = (question: Question): DocumentCategory => question.category ?? 'SUPPLIER_CERTIFICATE'

/** The words of a question in a language. */
export const wordsIn = (words: Words, locale: 'it' | 'en'): string => words[locale]
