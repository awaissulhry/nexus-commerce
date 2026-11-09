import type { Issue } from '../../core/errors'
import { isUuid } from '../../core/ids'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { isCountryCode } from '../../parties/geo'
import { compactTaxNumber, euVatNumberProblem, splitEuVatNumber } from '../../parties/tax'
import { SITE_STEPS, type Question, type QuestionSection, type SiteStep } from './questions'

/**
 * A supplier's answer to one questionnaire version (B-W2b-172; SCM-023; portal-supply.prisma SupplierQuestionnaireResponse):
 * the answers by question key, its own sites and its sub-tier sites (each a name, a two-letter country, the town and the
 * steps done there), and the signed statement — the signer's name and role, and "true to the best of my knowledge".
 *
 *   kind              answers[key]
 *   TEXT, LONG_TEXT,  { value: "…" }
 *   ADDRESS, URL
 *   VAT               { value: "IT01234567897" }   (compacted; an EU number is checked for its shape and Italy's check digit)
 *   CONTACT           { value: { name, email, phone } }
 *   FILE              { value: { fileId, issuer, number, issuedOn, expiresOn } } or nothing (when not required)
 *   YES_NO            { value: "YES" | "NO", explain?: "…" }   (words needed on the question's `explain` answer)
 *   CHOICE            { value: "<option code>" }
 *   SIGN              { value: "SIGNED" }
 *   SITES / SUB_TIER_SITES  — the answer's `sites` / `subTierSites` lists
 *
 * `answerProblems` checks a whole answer against its version (the API refuses a send with any; the page checks each step
 * with the same rules). Paths are the send body's: `answers/<key>/value…`, `sites/<i>/country`, `signedName`.
 */

export const ANSWER_LIMITS = Object.freeze({
  text: 200,
  longText: 4000,
  address: 400,
  url: 300,
  explain: 2000,
  name: 120,
  email: 254,
  phone: 40,
  sites: 20,
  siteName: 160,
  town: 120,
  issuer: 160,
  number: 80,
  signer: 120,
  role: 120,
  files: 20,
})

export interface SiteRow {
  readonly name: string
  readonly country: string
  readonly town?: string | null
  readonly steps: SiteStep[]
}

export interface ContactValue {
  readonly name: string
  readonly email: string
  readonly phone?: string | null
}

export interface FileValue {
  readonly fileId: string
  readonly issuer?: string | null
  readonly number?: string | null
  readonly issuedOn?: BusinessDate | null
  readonly expiresOn?: BusinessDate | null
}

export interface AnswerEntry {
  readonly value?: unknown
  readonly explain?: string | null
}

export interface AnswerForm {
  readonly answers: Readonly<Record<string, AnswerEntry>>
  readonly sites: readonly SiteRow[]
  readonly subTierSites: readonly SiteRow[]
  readonly signedName: string
  readonly signedRole: string
  readonly truthful: boolean
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_SHAPE = /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i
const PHONE = /^\+?[0-9 ().-]{5,40}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const SECTION_OF_SITES: Readonly<Record<'SITES' | 'SUB_TIER_SITES', 'sites' | 'subTierSites'>> = { SITES: 'sites', SUB_TIER_SITES: 'subTierSites' }

/** What is wrong with a VAT number as typed; null when it may go. An EU number is checked for its shape (and Italy's digit). */
export function vatProblem(value: string): string | null {
  const compact = compactTaxNumber(value)
  if (compact.length < 4 || compact.length > 30) return 'A VAT number with its country prefix, 4 to 30 characters.'
  const split = splitEuVatNumber(compact)
  if (!split) return null
  const country = split.prefix === 'EL' ? 'GR' : split.prefix
  return euVatNumberProblem(compact, country)
}

/** An EU VAT number outside Italy, which VIES checks: its prefix and number; null otherwise. */
export function viesTarget(value: string): { readonly countryCode: string; readonly vatNumber: string } | null {
  const split = splitEuVatNumber(compactTaxNumber(value))
  if (!split || split.prefix === 'IT' || split.number === '') return null
  return { countryCode: split.prefix, vatNumber: split.number }
}

/**
 * What a check found, with a stable code beside the English sentence: the API answers the sentence, the link page shows
 * its own words for the code (the same rules on both sides).
 */
export const CHECK_CODES = [
  'required', 'tooLong', 'url', 'vat', 'name', 'email', 'phone', 'file', 'day', 'issuedFuture', 'expired', 'expiresBefore', 'yesNo', 'explain', 'choice', 'sign',
  'stray', 'sites', 'tooMany', 'site', 'siteName', 'country', 'steps', 'sameFile', 'signedName', 'signedRole', 'truthful',
] as const
export type CheckCode = (typeof CHECK_CODES)[number]

export interface AnswerCheck extends Issue {
  readonly code: CheckCode
}

const check = (path: string, code: CheckCode, message: string): AnswerCheck => ({ path, code, message })

function siteProblems(rows: readonly unknown[], field: 'sites' | 'subTierSites'): AnswerCheck[] {
  if (rows.length > ANSWER_LIMITS.sites) return [check(field, 'tooMany', `At most ${ANSWER_LIMITS.sites} sites.`)]
  return rows.flatMap((row, index): AnswerCheck[] => {
    const at = `${field}/${index}`
    if (!isRecord(row)) return [check(at, 'site', 'A site: its name, country and steps.')]
    const issues: AnswerCheck[] = []
    const name = trimmed(row.name)
    if (name === '' || name.length > ANSWER_LIMITS.siteName) issues.push(check(`${at}/name`, 'siteName', `The site's name, 1 to ${ANSWER_LIMITS.siteName} characters.`))
    if (typeof row.country !== 'string' || !isCountryCode(row.country)) issues.push(check(`${at}/country`, 'country', 'The country (two letters).'))
    if (row.town !== undefined && row.town !== null && (typeof row.town !== 'string' || row.town.length > ANSWER_LIMITS.town)) issues.push(check(`${at}/town`, 'tooLong', `At most ${ANSWER_LIMITS.town} characters.`))
    if (!Array.isArray(row.steps) || !row.steps.every((step) => (SITE_STEPS as readonly unknown[]).includes(step)) || new Set(row.steps).size !== row.steps.length) issues.push(check(`${at}/steps`, 'steps', `Steps from ${SITE_STEPS.join(', ')}, each once.`))
    return issues
  })
}

function textProblem(question: Question, value: unknown, max: number, path: string): AnswerCheck[] {
  const text = trimmed(value)
  if (text === '') return question.required ? [check(path, 'required', 'Required.')] : []
  if (text.length > max) return [check(path, 'tooLong', `At most ${max} characters.`)]
  return []
}

/** The problems of one question's answer (its path inside `answers/<key>`), given today for an expiry. */
export function entryProblems(question: Question, entry: AnswerEntry | undefined, today: BusinessDate): AnswerCheck[] {
  const at = `answers/${question.key}`
  const path = `${at}/value`
  const value = entry?.value
  switch (question.kind) {
    case 'TEXT':
      return textProblem(question, value, ANSWER_LIMITS.text, path)
    case 'LONG_TEXT':
      return textProblem(question, value, ANSWER_LIMITS.longText, path)
    case 'ADDRESS':
      return textProblem(question, value, ANSWER_LIMITS.address, path)
    case 'URL': {
      const empty = textProblem(question, value, ANSWER_LIMITS.url, path)
      if (empty.length > 0 || trimmed(value) === '') return empty
      return URL_SHAPE.test(trimmed(value)) ? [] : [check(path, 'url', 'A web address, for example www.example.com.')]
    }
    case 'VAT': {
      const empty = textProblem(question, value, 40, path)
      if (empty.length > 0 || trimmed(value) === '') return empty
      const problem = vatProblem(trimmed(value))
      return problem ? [check(path, 'vat', problem)] : []
    }
    case 'CONTACT': {
      if (!isRecord(value) || (trimmed(value.name) === '' && trimmed(value.email) === '' && trimmed(value.phone) === '')) return question.required ? [check(`${path}/name`, 'required', 'Required.')] : []
      const issues: AnswerCheck[] = []
      const name = trimmed(value.name)
      if (name === '' || name.length > ANSWER_LIMITS.name) issues.push(check(`${path}/name`, 'name', `A name, 1 to ${ANSWER_LIMITS.name} characters.`))
      const email = trimmed(value.email)
      if (!EMAIL.test(email) || email.length > ANSWER_LIMITS.email) issues.push(check(`${path}/email`, 'email', 'An e-mail address.'))
      const phone = trimmed(value.phone)
      if (phone !== '' && !PHONE.test(phone)) issues.push(check(`${path}/phone`, 'phone', 'A phone number: digits, spaces, + ( ) . -'))
      return issues
    }
    case 'FILE': {
      if (value === undefined || value === null) return question.required ? [check(path, 'file', 'Required: upload the document.')] : []
      if (!isRecord(value) || typeof value.fileId !== 'string' || !isUuid(value.fileId)) return [check(path, 'file', 'Upload the document.')]
      const issues: AnswerCheck[] = []
      if (value.issuer !== undefined && value.issuer !== null && (typeof value.issuer !== 'string' || value.issuer.length > ANSWER_LIMITS.issuer)) issues.push(check(`${path}/issuer`, 'tooLong', `At most ${ANSWER_LIMITS.issuer} characters.`))
      if (value.number !== undefined && value.number !== null && (typeof value.number !== 'string' || value.number.length > ANSWER_LIMITS.number)) issues.push(check(`${path}/number`, 'tooLong', `At most ${ANSWER_LIMITS.number} characters.`))
      const issued = value.issuedOn ?? null
      const expires = value.expiresOn ?? null
      if (issued !== null && !isBusinessDate(issued)) issues.push(check(`${path}/issuedOn`, 'day', 'A day, YYYY-MM-DD.'))
      else if (issued !== null && issued > today) issues.push(check(`${path}/issuedOn`, 'issuedFuture', 'The day it was issued is today or before.'))
      if (expires !== null && !isBusinessDate(expires)) issues.push(check(`${path}/expiresOn`, 'day', 'A day, YYYY-MM-DD.'))
      else if (expires !== null && expires < today) issues.push(check(`${path}/expiresOn`, 'expired', 'This document has expired: upload the one in force.'))
      else if (expires !== null && isBusinessDate(issued) && expires < issued) issues.push(check(`${path}/expiresOn`, 'expiresBefore', 'It expires after the day it was issued.'))
      return issues
    }
    case 'YES_NO': {
      if (value !== 'YES' && value !== 'NO') return question.required || (value !== undefined && value !== null) ? [check(path, 'yesNo', 'Yes or No.')] : []
      const explain = trimmed(entry?.explain)
      if (explain.length > ANSWER_LIMITS.explain) return [check(`${at}/explain`, 'tooLong', `At most ${ANSWER_LIMITS.explain} characters.`)]
      if (question.explain === value && explain === '') return [check(`${at}/explain`, 'explain', 'Tell us more about this answer.')]
      return []
    }
    case 'CHOICE': {
      if (value === undefined || value === null || value === '') return question.required ? [check(path, 'choice', 'Choose one.')] : []
      return (question.options ?? []).some((option) => option.code === value) ? [] : [check(path, 'choice', 'Choose one of the choices.')]
    }
    case 'SIGN':
      if (value === 'SIGNED') return []
      return question.required || (value !== undefined && value !== null) ? [check(path, 'sign', 'Read and sign it.')] : []
    case 'SITES':
    case 'SUB_TIER_SITES':
      return []
  }
}

/** The keys of the answer that are no question of the version (the API refuses them: an answer names its version). */
export const strayKeys = (questions: readonly Question[], answers: Readonly<Record<string, unknown>>): string[] => {
  const keys = new Set(questions.filter((question) => question.kind !== 'SITES' && question.kind !== 'SUB_TIER_SITES').map((question) => question.key))
  return Object.keys(answers).filter((key) => !keys.has(key))
}

/** Every problem of an answer to a version, in the version's order; the statement last. */
export function answerProblems(questions: readonly Question[], form: AnswerForm, today: BusinessDate): AnswerCheck[] {
  const issues: AnswerCheck[] = []
  for (const key of strayKeys(questions, form.answers)) issues.push(check(`answers/${key}`, 'stray', 'Not a question of this questionnaire.'))
  for (const question of questions) {
    if (question.kind === 'SITES' || question.kind === 'SUB_TIER_SITES') {
      const field = SECTION_OF_SITES[question.kind]
      const rows = form[field]
      if (question.required && rows.length === 0) issues.push(check(field, 'sites', 'Add at least one site.'))
      continue
    }
    issues.push(...entryProblems(question, form.answers[question.key], today))
  }
  issues.push(...siteProblems(form.sites, 'sites'), ...siteProblems(form.subTierSites, 'subTierSites'))
  const files = filesOf(questions, form.answers).map((file) => file.fileId)
  if (new Set(files).size !== files.length) issues.push(check('answers', 'sameFile', 'One document answers one question.'))
  issues.push(...statementProblems(form))
  return issues
}

/** The signed statement: a name, a role, and "true to the best of my knowledge". */
export function statementProblems(form: Pick<AnswerForm, 'signedName' | 'signedRole' | 'truthful'>): AnswerCheck[] {
  const issues: AnswerCheck[] = []
  const name = form.signedName.trim()
  if (name === '' || name.length > ANSWER_LIMITS.signer) issues.push(check('signedName', 'signedName', `Your full name, 1 to ${ANSWER_LIMITS.signer} characters.`))
  const role = form.signedRole.trim()
  if (role === '' || role.length > ANSWER_LIMITS.role) issues.push(check('signedRole', 'signedRole', `Your role, 1 to ${ANSWER_LIMITS.role} characters.`))
  if (form.truthful !== true) issues.push(check('truthful', 'truthful', 'Confirm the answers are true to the best of your knowledge.'))
  return issues
}

/** The section an issue belongs to (the page's step), from its path; the statement is the last step's. */
export function sectionOfIssue(questions: readonly Question[], path: string): QuestionSection | 'sign' {
  if (path.startsWith('sites')) return 'sites'
  if (path.startsWith('subTierSites')) return 'sites'
  const key = /^answers\/([^/]+)/.exec(path)?.[1]
  if (key) return questions.find((question) => question.key === key)?.section ?? 'sign'
  return 'sign'
}

/** The documents an answer names (FILE questions with a file), with their question. */
export function filesOf(questions: readonly Question[], answers: Readonly<Record<string, AnswerEntry>>): Array<FileValue & { readonly key: string; readonly question: Question }> {
  return questions.flatMap((question) => {
    if (question.kind !== 'FILE') return []
    const value = answers[question.key]?.value
    if (!isRecord(value) || typeof value.fileId !== 'string') return []
    return [{ key: question.key, question, fileId: value.fileId, issuer: (value.issuer as string | null | undefined) ?? null, number: (value.number as string | null | undefined) ?? null, issuedOn: (value.issuedOn as string | null | undefined) ?? null, expiresOn: (value.expiresOn as string | null | undefined) ?? null }]
  })
}

/** The answer as kept: texts trimmed, a VAT number compacted, empty optional answers left out. */
export function cleanAnswers(questions: readonly Question[], answers: Readonly<Record<string, AnswerEntry>>): Record<string, { value: unknown; explain?: string }> {
  const out: Record<string, { value: unknown; explain?: string }> = {}
  for (const question of questions) {
    const entry = answers[question.key]
    if (!entry || entry.value === undefined || entry.value === null || entry.value === '') continue
    const explain = trimmed(entry.explain)
    const withExplain = (value: unknown) => (explain === '' ? { value } : { value, explain })
    switch (question.kind) {
      case 'VAT':
        out[question.key] = { value: compactTaxNumber(trimmed(entry.value)) }
        break
      case 'TEXT':
      case 'LONG_TEXT':
      case 'ADDRESS':
      case 'URL':
        if (trimmed(entry.value) !== '') out[question.key] = { value: trimmed(entry.value) }
        break
      case 'CONTACT': {
        const value = entry.value as Record<string, unknown>
        if (trimmed(value.name) === '' && trimmed(value.email) === '') break
        out[question.key] = { value: { name: trimmed(value.name), email: trimmed(value.email).toLowerCase(), phone: trimmed(value.phone) || null } }
        break
      }
      case 'FILE': {
        const value = entry.value as Record<string, unknown>
        out[question.key] = withExplain({ fileId: value.fileId, issuer: trimmed(value.issuer) || null, number: trimmed(value.number) || null, issuedOn: value.issuedOn ?? null, expiresOn: value.expiresOn ?? null })
        break
      }
      case 'YES_NO':
      case 'CHOICE':
      case 'SIGN':
        out[question.key] = withExplain(entry.value)
        break
      case 'SITES':
      case 'SUB_TIER_SITES':
        break
    }
  }
  return out
}

/** Sites as kept: names and towns trimmed, the country in capitals. */
export const cleanSites = (rows: readonly SiteRow[]): SiteRow[] => rows.map((row) => ({ name: row.name.trim(), country: row.country.toUpperCase(), town: row.town?.trim() || null, steps: [...row.steps] }))
