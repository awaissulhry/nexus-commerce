import { checkPaymentTerms, PAYMENT_METHOD_CODES, termsSummary } from '@nexus/factory-domain/sales/terms/terms'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Phrase } from '../../_shared/model'
import type { InstalmentEvent, PaymentTerms, TermsFields } from './api'

/**
 * The payment terms library's rules, pure (B-W2a-80; design finance.settings sec:terms): who may (paymentterms.view reads,
 * paymentterms.manage adds, edits, archives), the rows (active, archived, all), the add / edit / copy dialog's draft — code,
 * the printed name (the company's language) and its English, the FatturaPA method, instalments (share, from which event,
 * days, end of month; the shares total 100; at most one on the order: the deposit), the early-payment discount (percent and
 * days, both or neither) — checked here as factory-domain checks them, the words of terms as the documents print them,
 * and the API's refusals in words (terms in use keep their rules: new rules are new terms). Words: `finance-daily`.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

export interface TermsAbilities {
  view: boolean
  manage: boolean
}

export const termsAbilitiesOf = (permissions: readonly string[]): TermsAbilities => {
  const held = new Set(permissions)
  return { view: held.has('paymentterms.view'), manage: held.has('paymentterms.manage') }
}

export const TERMS_ROWS = ['active', 'archived', 'all'] as const
export type TermsRows = (typeof TERMS_ROWS)[number]
export const termsStatusOf = (rows: TermsRows): 'ACTIVE' | 'ARCHIVED' | 'ALL' => (rows === 'active' ? 'ACTIVE' : rows === 'archived' ? 'ARCHIVED' : 'ALL')

/** The FatturaPA payment methods a person picks from (MP05 bank transfer first, MP12 Ri.Ba. next, then the rest). */
export const METHOD_CHOICES: readonly string[] = ['MP05', 'MP12', ...PAYMENT_METHOD_CODES.filter((code) => code !== 'MP05' && code !== 'MP12')]

export interface InstalmentDraft {
  sharePct: string
  from: InstalmentEvent
  days: string
  endOfMonth: boolean
}

export interface TermsDraft {
  code: string
  name: string
  nameEn: string
  method: string
  instalments: InstalmentDraft[]
  discountPct: string
  discountDays: string
}

export const emptyTerms = (): TermsDraft => ({ code: '', name: '', nameEn: '', method: 'MP05', instalments: [{ sharePct: '100', from: 'INVOICE', days: '30', endOfMonth: true }], discountPct: '', discountDays: '' })

const pctText = (value: string, locale: Locale) => (locale === 'it' ? value.replace('.', ',') : value)

/** The draft of stored terms (to edit them, or to copy them as new terms with a new code). */
export function draftOf(terms: PaymentTerms, locale: Locale, copy = false): TermsDraft {
  return {
    code: copy ? '' : terms.code,
    name: terms.name,
    nameEn: terms.nameI18n?.en ?? '',
    method: terms.method,
    instalments: terms.instalments.map((item) => ({ sharePct: pctText(item.sharePct, locale), from: item.from, days: String(item.days), endOfMonth: item.endOfMonth })),
    discountPct: terms.earlyPaymentDiscountPct ? pctText(terms.earlyPaymentDiscountPct, locale) : '',
    discountDays: terms.earlyPaymentDays === null ? '' : String(terms.earlyPaymentDays),
  }
}

const decimalOf = (text: string): string => text.trim().replace(',', '.')
const daysOf = (text: string): number => (/^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN)

/** The fields as the API takes them (codes in capitals, decimals with a dot). */
export function fieldsOf(draft: TermsDraft): TermsFields {
  const discount = decimalOf(draft.discountPct)
  const days = draft.discountDays.trim() === '' ? null : daysOf(draft.discountDays)
  return {
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim(),
    nameI18n: draft.nameEn.trim() ? { en: draft.nameEn.trim() } : null,
    method: draft.method,
    instalments: draft.instalments.map((item) => ({ sharePct: decimalOf(item.sharePct), from: item.from, days: daysOf(item.days), endOfMonth: item.endOfMonth })),
    earlyPaymentDiscountPct: discount === '' ? null : discount,
    earlyPaymentDays: days,
  }
}

export interface TermsProblems {
  code?: string
  name?: string
  nameEn?: string
  method?: string
  instalments?: string
  lines: Record<number, string>
  discount?: string
}

/**
 * The draft's problems as message keys (factory-domain checkPaymentTerms, read by path): a code (BB30FM), a printed name,
 * a method, 1 to 12 instalments whose shares total 100 with at most one on the order, whole days 0 to 366, the discount's
 * percent and days both or neither.
 */
export function termsProblems(draft: TermsDraft): TermsProblems {
  const problems: TermsProblems = { lines: {} }
  const fields = fieldsOf(draft)
  const checked = checkPaymentTerms({ ...fields, instalments: fields.instalments.map((item) => ({ ...item, days: Number.isNaN(item.days) ? -1 : item.days })), earlyPaymentDays: fields.earlyPaymentDays === null ? null : Number.isNaN(fields.earlyPaymentDays) ? -1 : fields.earlyPaymentDays })
  if (checked.ok) return problems
  for (const issue of checked.issues) {
    const path = issue.path
    if (path === 'code') problems.code ??= 'terms.problem.code'
    else if (path === 'name') problems.name ??= 'terms.problem.name'
    else if (path.startsWith('nameI18n')) problems.nameEn ??= 'terms.problem.nameEn'
    else if (path === 'method') problems.method ??= 'terms.problem.method'
    else if (path.startsWith('earlyPayment')) problems.discount ??= 'terms.problem.discount'
    else if (path === 'instalments') {
      const orders = fields.instalments.filter((item) => item.from === 'ORDER').length
      problems.instalments ??= fields.instalments.length === 0 || fields.instalments.length > 12 ? 'terms.problem.count' : orders > 1 ? 'terms.problem.oneOrder' : 'terms.problem.total'
    } else {
      const match = /^instalments\/(\d+)\/(sharePct|from|days)$/.exec(path)
      if (match) problems.lines[Number(match[1])] ??= match[2] === 'sharePct' ? 'terms.problem.share' : match[2] === 'days' ? 'terms.problem.days' : 'terms.problem.from'
    }
  }
  return problems
}

export const hasProblems = (problems: TermsProblems): boolean => Object.keys(problems.lines).length > 0 || !!(problems.code ?? problems.name ?? problems.nameEn ?? problems.method ?? problems.instalments ?? problems.discount)

/** The shares typed so far, totalled (the dialog's "Total 100 %" line). */
export function shareTotal(draft: TermsDraft): number {
  return Math.round(draft.instalments.reduce((sum, item) => sum + (Number(decimalOf(item.sharePct)) || 0), 0) * 10_000) / 10_000
}

/** The draft in the words its documents would print (factory-domain termsSummary), or null while it does not check. */
export function previewOf(draft: TermsDraft, locale: Locale): string | null {
  const fields = fieldsOf(draft)
  if (fields.instalments.some((item) => Number.isNaN(item.days)) || (fields.earlyPaymentDays !== null && Number.isNaN(fields.earlyPaymentDays))) return null
  const checked = checkPaymentTerms(fields)
  return checked.ok ? termsSummary(checked.terms, locale) : null
}

/** Whether the rules (method, instalments, discount) differ from the stored terms (names may always change). */
export function rulesChanged(terms: PaymentTerms, draft: TermsDraft): boolean {
  const fields = fieldsOf(draft)
  const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Number(a) === Number(b))
  if (fields.method !== terms.method) return true
  if (!same(fields.earlyPaymentDiscountPct, terms.earlyPaymentDiscountPct) || fields.earlyPaymentDays !== terms.earlyPaymentDays) return true
  if (fields.instalments.length !== terms.instalments.length) return true
  return fields.instalments.some((item, index) => {
    const stored = terms.instalments[index]!
    return !same(item.sharePct, stored.sharePct) || item.from !== stored.from || item.days !== stored.days || item.endOfMonth !== stored.endOfMonth
  })
}

/** What PATCH sends: the names always; the rules only when they changed. */
export function patchOf(terms: PaymentTerms, draft: TermsDraft): Partial<TermsFields> {
  const fields = fieldsOf(draft)
  const patch: Partial<TermsFields> = { name: fields.name, nameI18n: fields.nameI18n }
  if (rulesChanged(terms, draft)) Object.assign(patch, { method: fields.method, instalments: fields.instalments, earlyPaymentDiscountPct: fields.earlyPaymentDiscountPct, earlyPaymentDays: fields.earlyPaymentDays })
  return patch
}

/** Why archiving waits for terms, or null: the right, active terms, no customer with them as default. */
export function archiveHeld(terms: Pick<PaymentTerms, 'status' | 'customers'>, can: TermsAbilities): Phrase | null {
  if (!can.manage) return phrase('terms.held.noManage')
  if (terms.status === 'ARCHIVED') return phrase('terms.held.archived')
  if (terms.customers > 0) return phrase('terms.held.customers', { count: terms.customers })
  return null
}

/** The terms in the person's language (the API's summary), and their printed name there. */
export const termsWords = (terms: Pick<PaymentTerms, 'summary'>, locale: Locale): string => (locale === 'it' ? terms.summary.it : terms.summary.en)
export const termsName = (terms: Pick<PaymentTerms, 'name' | 'nameI18n'>, locale: Locale): string => (locale === 'en' && terms.nameI18n?.en ? terms.nameI18n.en : terms.name)

export type TermsWriteProblem = Phrase & { inUse: boolean; reload: boolean }

/** A refused write in words: rules fixed by use (offer "save as new terms"), a code taken, a customer's default, moved. */
export function termsWriteProblem(error: unknown, changedRules: boolean): TermsWriteProblem {
  if (!isApiError(error)) return { key: 'terms.problem.write', inUse: false, reload: false }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') {
    if (paths.some((path) => path.split(/[./]/).includes('version'))) return { key: 'terms.problem.moved', inUse: false, reload: true }
    if (paths.some((path) => path.includes('code'))) return { key: 'terms.problem.codeTaken', inUse: false, reload: false }
    if (changedRules) return { key: 'terms.problem.inUse', inUse: true, reload: false }
    return { key: 'terms.problem.state', inUse: false, reload: true }
  }
  if (error.kind === 'invalid') return { key: 'terms.problem.invalid', inUse: false, reload: false }
  if (error.kind === 'forbidden') return { key: 'terms.problem.forbidden', inUse: false, reload: false }
  if (error.kind === 'step_up') return { key: 'terms.problem.stepUp', inUse: false, reload: false }
  return { key: 'terms.problem.write', inUse: false, reload: false }
}

/** A live event that changes the library. */
export const termsTouched = (change: { type: string }): boolean => change.type === 'payment_terms.changed'
