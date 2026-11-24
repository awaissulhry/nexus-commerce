import { ACCOUNT_NUMBER, type FreightBilling } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { CARRIER_NAMES } from '@nexus/factory-domain/shipping/labels/labels'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { parsePercent } from '../../../quotes/model'
import type { CommercialTerms, TermsPatch } from '../../terms/api'
import { termsDraftOf, termsPatch, termsProblems, type TermsAbilities, type TermsDraft } from '../../terms/model'
import type { CarrierAccount, CarrierAccountBody, CompanyTermsBody } from './api'
import type { CompanyTermsReadEntry, OwnTermsRead } from './commercial'
import { depositInForce, paymentTermsInForce } from './in-force'
import { said, text, type Said } from './model'

/**
 * F-CT-204 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §6.2–6.5; 13-backend §3; 18-lead-settles Z8, Z24, Z25, Z26) —
 * the four NEW windows of the tab, pure: their drafts, what still stops Save, the ONE body each sends, and what a refusal means in words.
 *   Change terms…                   the customer's own terms (today's in-place form MOVED into a centred window, its rules unchanged:
 *                                   cu/terms/model.ts) — minus the carrier, which is Change delivery…'s (one command per window)
 *   Change delivery…                the carrier block: carrier, default service, who pays the freight, the account (write-only)
 *   Set terms for {company}…        a company's own payment terms, deposit, price list and PO rule; a customer of ONE company opens the
 *                                   same window with the PO switch only ("Customer PO number", data: never a look prop)
 *   Back to the customer's terms…   the company's own terms end (never offered while a credit limit is set: R6 answers 409)
 * Every window: one Idempotency-Key per attempt (the container's), a 409 reads again and says someone else changed it.
 */

interface WindowState {
  readonly busy: boolean
  /** Save was pressed once: the problems show. */
  readonly tried: boolean
  /** A refusal or a failed call, as a key (the tab's catalogue). */
  readonly problem: string | null
}
const FRESH: WindowState = { busy: false, tried: false, problem: null }

// ---- 1. Change terms… ----------------------------------------------------------------------------------------------------------

export interface TermsWindow extends WindowState {
  readonly kind: 'terms'
  readonly draft: TermsDraft
}
export const termsWindowOf = (terms: CommercialTerms): TermsWindow => ({ kind: 'terms', draft: termsDraftOf(terms), ...FRESH })

/** The fields that changed, as the PATCH sends them — never the carrier (Change delivery… keeps it). */
export function termsWindowPatch(window: TermsWindow, terms: CommercialTerms, can: Pick<TermsAbilities, 'price' | 'listsManage'>): TermsPatch {
  const before = termsDraftOf(terms)
  return termsPatch(before, { ...window.draft, preferredCarrierCode: before.preferredCarrierCode }, can)
}

/** What stops Save, per field (today's checks, minus the carrier's). */
export function termsWindowProblems(window: TermsWindow): Partial<Record<keyof TermsDraft, string>> {
  const { preferredCarrierCode: _carrier, ...problems } = termsProblems(window.draft)
  return problems
}

/** A refused terms save in words: moved meanwhile, a list or terms the customer may not have, a field. */
export function termsRefusal(error: unknown): string {
  if (!isApiError(error)) return 'terms.refused.internal'
  if (error.kind === 'conflict') return 'terms.refused.moved'
  if (error.kind === 'forbidden') return 'terms.refused.forbidden'
  if (error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => path.includes('priceListId'))) return 'terms.refused.list'
    if (paths.some((path) => path.includes('paymentTermsId'))) return 'terms.refused.terms'
    if (paths.some((path) => path.includes('currency'))) return 'terms.refused.currency'
    return 'terms.refused.fields'
  }
  return error.kind === 'unavailable' ? 'terms.refused.unavailable' : 'terms.refused.internal'
}

// ---- 2. Change delivery… -------------------------------------------------------------------------------------------------------

/** The account on file: keep it, replace it with a number typed (sealed, the old one deleted), or remove it (the freight back to us). */
export type AccountChoice = 'keep' | 'replace' | 'remove'

export interface DeliveryWindow extends WindowState {
  readonly kind: 'delivery'
  /** The carrier code ('' = none: picked per shipment). */
  readonly carrier: string
  readonly service: string
  readonly freight: FreightBilling
  /** With an account on file; without one, a number typed is the new account. */
  readonly account: AccountChoice
  readonly number: string
  /** The field a refusal named (it is marked), else null. */
  readonly field: DeliveryField | null
}
export type DeliveryField = 'carrier' | 'service' | 'freight' | 'number'

export const deliveryWindowOf = (account: CarrierAccount): DeliveryWindow => ({ kind: 'delivery', carrier: account.carrierCode ?? '', service: account.defaultCarrierService ?? '', freight: account.freightBilling, account: account.accountOnFile ? 'keep' : 'replace', number: '', field: null, ...FRESH })

/** The carriers the window offers (their codes as the shipments name them, one per name), and the customer's own if another. */
export function carrierChoices(current: string | null): Array<{ readonly code: string; readonly name: string }> {
  const seen = new Set<string>()
  const out: Array<{ code: string; name: string }> = []
  for (const [code, name] of Object.entries(CARRIER_NAMES)) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ code, name })
  }
  if (current && !out.some((choice) => choice.code === current)) out.unshift({ code: current, name: current })
  return out
}

/** After the change: an account on file? (a number typed · removed · another carrier drops it · as it was). */
function accountAfter(window: DeliveryWindow, account: CarrierAccount): boolean {
  const carrier = window.carrier === '' ? null : window.carrier
  if (carrier === null) return false
  if (window.account === 'replace' && window.number.trim() !== '') return true
  if (window.account === 'remove') return false
  return carrier === account.carrierCode && account.accountOnFile
}

/** What stops Save, per field (the domain's own rules: customerAccountProblems, ACCOUNT_NUMBER). */
export function deliveryProblems(window: DeliveryWindow, account: CarrierAccount): Partial<Record<DeliveryField, string>> {
  const out: Partial<Record<DeliveryField, string>> = {}
  const typed = window.number.trim()
  if (window.account === 'replace' && typed !== '' && !ACCOUNT_NUMBER.test(typed)) out.number = 'ct.deliv.problem.number'
  if (window.account === 'replace' && account.accountOnFile && typed === '') out.number = 'ct.deliv.problem.numberEmpty'
  if (window.freight !== 'SENDER' && !accountAfter(window, account)) out.freight = 'ct.deliv.problem.needsAccount'
  if (window.carrier === '' && window.service.trim() !== '') out.service = 'ct.deliv.problem.needsCarrier'
  if (window.service.trim().length > 100) out.service = 'ct.deliv.problem.service'
  return out
}

/** The ONE command the window sends (only what changed), or null when nothing did. */
export function deliveryBody(window: DeliveryWindow, account: CarrierAccount): CarrierAccountBody | null {
  const carrierCode = window.carrier === '' ? null : window.carrier
  const carrierChanged = carrierCode !== account.carrierCode
  const service = window.service.trim() === '' ? null : window.service.trim()
  const typed = window.number.trim()
  // A number typed is the new account; removed, or another carrier (it needs its own account): the account on file goes.
  let accountNumber: string | null | undefined
  if (window.account === 'replace' && typed !== '') accountNumber = typed
  else if (account.accountOnFile && (window.account === 'remove' || carrierChanged)) accountNumber = null
  const body: { -readonly [K in keyof CarrierAccountBody]: CarrierAccountBody[K] } = { version: account.version }
  if (carrierChanged) body.carrierCode = carrierCode
  if (service !== account.defaultCarrierService) body.defaultCarrierService = service
  if (accountNumber !== undefined) body.accountNumber = accountNumber
  if (window.freight !== account.freightBilling) body.freightBilling = window.freight
  return Object.keys(body).length > 1 ? body : null
}

/** A refused delivery save in words, and the field it names (marked in the window). */
export function deliveryRefusal(error: unknown): { readonly key: string; readonly field: DeliveryField | null } {
  if (!isApiError(error)) return { key: 'terms.refused.internal', field: null }
  if (error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => path.includes('accountNumber'))) return { key: 'ct.deliv.problem.number', field: 'number' }
    if (paths.some((path) => path.includes('freightBilling'))) return { key: 'ct.deliv.problem.needsAccount', field: 'freight' }
    if (paths.some((path) => path.includes('defaultCarrierService'))) return { key: 'ct.deliv.problem.service', field: 'service' }
    if (paths.some((path) => path.includes('carrierCode'))) return { key: 'ct.deliv.problem.needsCarrier', field: 'carrier' }
    return { key: 'terms.refused.fields', field: null }
  }
  if (error.kind === 'conflict') return { key: error.code.includes('NOT_A_CUSTOMER') ? 'terms.held.notCustomer' : 'terms.refused.moved', field: null }
  if (error.kind === 'forbidden') return { key: 'terms.refused.forbidden', field: null }
  return { key: error.kind === 'unavailable' ? 'terms.refused.unavailable' : 'terms.refused.internal', field: null }
}

/** The notice after a save: what new labels book (the account's last four characters only from the save's own answer, Z2). */
export function deliverySaved(account: CarrierAccount, endsIn: string | null): Said {
  const carrier = account.carrierName ?? account.carrierCode
  const customer = account.name
  if (!carrier) return said('ct.deliv.savedNone', { params: { customer } })
  if (endsIn) return said('ct.deliv.savedEnds', { params: { customer, carrier, ends: endsIn } })
  return said(account.accountOnFile ? 'ct.deliv.savedAccount' : 'ct.deliv.saved', { params: { customer, carrier } })
}

// ---- 3. Set terms for {company}… / Customer PO number… ------------------------------------------------------------------------

export interface CompanyWindow extends WindowState {
  readonly kind: 'company'
  readonly companyId: string
  /** A customer of ONE company: the PO switch only (data: `tenantWide` false). */
  readonly poOnly: boolean
  readonly payment: 'party' | 'own'
  readonly paymentTermsId: string
  readonly deposit: 'party' | 'own'
  readonly depositPct: string
  readonly list: 'party' | 'own'
  readonly priceListId: string
  readonly po: boolean
}

export function companyWindowOf(entry: CompanyTermsReadEntry, poOnly: boolean): CompanyWindow {
  const live = entry.terms
  return {
    kind: 'company',
    companyId: entry.company.id,
    poOnly,
    payment: live?.paymentTermsId ? 'own' : 'party',
    paymentTermsId: live?.paymentTermsId ?? '',
    deposit: live?.depositPct ? 'own' : 'party',
    depositPct: live?.depositPct ?? '',
    list: live?.priceListId ? 'own' : 'party',
    priceListId: live?.priceListId ?? '',
    po: entry.inForce.poNumberRequired,
    ...FRESH,
  }
}

/** A deposit a company may have: above 0, at most 100 % (the domain's companyTermsProblems). */
const depositOk = (value: string): string | null => {
  const pct = parsePercent(value)
  return pct !== null && Number(pct) > 0 ? pct : null
}

/** What stops Save, per field. */
export function companyProblems(window: CompanyWindow, can: Pick<TermsAbilities, 'listsManage'>): Partial<Record<'paymentTermsId' | 'depositPct' | 'priceListId', string>> {
  if (window.poOnly) return {}
  const out: Partial<Record<'paymentTermsId' | 'depositPct' | 'priceListId', string>> = {}
  if (window.payment === 'own' && window.paymentTermsId === '') out.paymentTermsId = 'ct.co.problem.terms'
  if (window.deposit === 'own' && depositOk(window.depositPct) === null) out.depositPct = 'terms.problem.deposit'
  if (can.listsManage && window.list === 'own' && window.priceListId === '') out.priceListId = 'ct.co.problem.list'
  return out
}

/** The ONE command for that company (its row at its version; none yet: the row is made), only what changed — or null. */
export function companyBody(window: CompanyWindow, entry: CompanyTermsReadEntry, can: Pick<TermsAbilities, 'listsManage'>): CompanyTermsBody | null {
  const live = entry.terms
  const body: { -readonly [K in keyof CompanyTermsBody]: CompanyTermsBody[K] } = live ? { version: live.version } : {}
  const before = live?.poNumberRequired ?? false
  if (window.po !== before) body.poNumberRequired = window.po
  if (!window.poOnly) {
    const terms = window.payment === 'own' ? window.paymentTermsId : null
    if (terms !== (live?.paymentTermsId ?? null)) body.paymentTermsId = terms
    const deposit = window.deposit === 'own' ? depositOk(window.depositPct) : null
    const had = live?.depositPct ?? null
    if (!(deposit === had || (deposit !== null && had !== null && Number(deposit) === Number(had)))) body.depositPct = deposit
    if (can.listsManage) {
      const list = window.list === 'own' ? window.priceListId : null
      if (list !== (live?.priceListId ?? null)) body.priceListId = list
    }
  }
  const sent = Object.keys(body).filter((key) => key !== 'version')
  return sent.length > 0 ? body : null
}

/** A refused company save in words. */
export function companyRefusal(error: unknown): string {
  if (!isApiError(error)) return 'terms.refused.internal'
  if (error.kind === 'conflict') return 'terms.refused.moved'
  if (error.kind === 'forbidden') return 'terms.refused.forbidden'
  if (error.kind === 'not_found') return 'terms.refused.moved'
  if (error.kind === 'invalid') {
    const paths = error.issues.map((issue) => issuePath(issue))
    if (paths.some((path) => path.includes('paymentTermsId'))) return 'terms.refused.terms'
    if (paths.some((path) => path.includes('priceListId'))) return 'terms.refused.list'
    if (paths.some((path) => path.includes('depositPct'))) return 'terms.problem.deposit'
    return 'terms.refused.fields'
  }
  return error.kind === 'unavailable' ? 'terms.refused.unavailable' : 'terms.refused.internal'
}

// ---- 4. Back to the customer's terms with {company}? ---------------------------------------------------------------------------

export interface CompanyEndWindow extends WindowState {
  readonly kind: 'end'
  readonly companyId: string
}
export const companyEndWindowOf = (companyId: string): CompanyEndWindow => ({ kind: 'end', companyId, ...FRESH })

/** What going back changes — only what is true: its payment terms, its deposit, its PO rule; open quotes and orders keep theirs. */
export function endLines(entry: CompanyTermsReadEntry, own: OwnTermsRead | null, locale: 'en' | 'it'): Array<{ readonly tone: 'info' | 'warning'; readonly words: Said }> {
  const live = entry.terms
  if (!live) return []
  const customer = { commercial: own, companies: null, companyId: null, typed: null }
  const lines: Array<{ tone: 'info' | 'warning'; words: Said }> = []
  if (live.paymentTermsLabel || live.paymentTermsText) {
    const theirs = paymentTermsInForce(customer, locale)
    lines.push({ tone: 'info', words: said('ct.end.terms', { words: { own: text(live.paymentTermsLabel?.name ?? live.paymentTermsText ?? ''), party: theirs ? text(theirs.name) : said('ct.com.ptNoneShort') } }) })
  }
  if (live.depositPct) {
    const theirs = depositInForce(customer)
    lines.push({ tone: 'info', words: said('ct.end.deposit', { pcts: { own: live.depositPct }, words: { party: theirs.pct ? said('customer-money:cm.credit.pct', { pcts: { pct: theirs.pct } }) : said('terms.depositSettings') } }) })
  }
  if (live.poNumberRequired) lines.push({ tone: 'warning', words: said('ct.end.po', { params: { company: entry.company.name } }) })
  lines.push({ tone: 'info', words: said('ct.end.openKeep') })
  return lines
}

/** A refused end in words (a credit limit set meanwhile, moved meanwhile). */
export function endRefusal(error: unknown): string {
  if (!isApiError(error)) return 'terms.refused.internal'
  if (error.kind === 'conflict') return error.issues.length > 0 && error.issues.every((issue) => issuePath(issue) === 'body') ? 'ct.end.refusedCredit' : 'terms.refused.moved'
  if (error.kind === 'not_found') return 'terms.refused.moved'
  if (error.kind === 'forbidden') return 'terms.refused.forbidden'
  return error.kind === 'unavailable' ? 'terms.refused.unavailable' : 'terms.refused.internal'
}

/** Any of the four windows (the container holds one at a time). */
export type TermsTabWindow = TermsWindow | DeliveryWindow | CompanyWindow | CompanyEndWindow
