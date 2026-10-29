import { normaliseAddress, addressProblems } from '@nexus/factory-domain/parties/addresses'
import { contactProblems, normaliseContact } from '@nexus/factory-domain/parties/contacts'
import { isCountryCode, isLanguageCode, COUNTRY_CODES } from '@nexus/factory-domain/parties/geo'
import { PARTY_CODE } from '@nexus/factory-domain/parties/rules'
import { EU_VAT_FORMATS, normaliseTaxIdentity, splitEuVatNumber, suggestTaxMode, taxIdentityProblems, vatPrefixOf } from '@nexus/factory-domain/parties/tax'
import { isEuMemberState } from '@nexus/factory-domain/tax/eu'
import { isValidPartitaIva } from '@nexus/factory-domain/tax/tax-ids'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type {
  Address,
  AddressBody,
  AddressKind,
  Attention,
  Contact,
  ContactBody,
  ContactRole,
  Party,
  PartyKind,
  PartyQuery,
  PartyRole,
  PartyRow,
  PartyStatus,
  PurchaseOrderRow,
  QuoteRow,
  SalesOrderRow,
  TaxIdentity,
  TaxIdentityBody,
  TaxMode,
  ViesCheck,
  ViesState,
  WarningCode,
} from './api'

/**
 * Customers and suppliers (SCR-032, SCR-033, SCR-056, SCR-057), pure: ONE party record seen from two sides. Sales ›
 * Customers lists the parties we sell to (CUSTOMER, BRAND), Purchasing › Suppliers the ones we buy from or send work and
 * goods with (SUPPLIER, SUBCONTRACTOR, CARRIER); a tannery that also buys from us is one record in both lists. This file
 * holds what the two sides share and where they differ (`SIDES`), the list's saved filters (Rows ▾ and the tiles are one
 * filter model), the checks a form runs before it sends (the API's own rules from factory-domain, in this app's words:
 * message keys of `parties`), and the view models. The API's English never reaches the screen.
 */

// ---- the two sides ----------------------------------------------------------------------------------------------------

export type Side = 'customers' | 'suppliers'

export type ListView = 'open' | 'active' | 'prospects' | 'brands' | 'invoice' | 'vies' | 'blocked' | 'archived' | 'all' | 'suppliers' | 'subcontractors' | 'carriers'

export type TileId = 'active' | 'prospects' | 'vies' | 'invoice' | 'blocked'

export type CustomerTab = 'overview' | 'addresses' | 'tax' | 'orders' | 'documents' | 'activity'
export type SupplierTab = 'overview' | 'contacts' | 'orders' | 'activity'
export type RecordTab = CustomerTab | SupplierTab

export interface SideConfig {
  side: Side
  /** The roles this list shows (`role=` of GET /parties). */
  roles: readonly PartyRole[]
  /** The roles a new party of this side may take. */
  newRoles: readonly PartyRole[]
  /** The company-free address of the list (`/sales/customers`). */
  base: string
  /** A new party starts as (design: a new supplier is a Prospect until approved). */
  newStatus: 'ACTIVE' | 'PROSPECT'
  views: readonly ListView[]
  tiles: readonly TileId[]
  tabs: readonly RecordTab[]
  /** The record's thread and files (record panels) — `Party`, the API's thread resolver. */
  recordType: 'Party'
}

export const SIDES: Readonly<Record<Side, SideConfig>> = {
  customers: {
    side: 'customers',
    roles: ['CUSTOMER', 'BRAND'],
    newRoles: ['CUSTOMER', 'BRAND'],
    base: '/sales/customers',
    newStatus: 'ACTIVE',
    views: ['open', 'active', 'prospects', 'brands', 'invoice', 'vies', 'blocked', 'archived', 'all'],
    tiles: ['active', 'prospects', 'vies', 'invoice', 'blocked'],
    tabs: ['overview', 'addresses', 'tax', 'orders', 'documents', 'activity'],
    recordType: 'Party',
  },
  suppliers: {
    side: 'suppliers',
    roles: ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'],
    newRoles: ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'],
    base: '/purchasing/suppliers',
    newStatus: 'PROSPECT',
    views: ['open', 'active', 'prospects', 'suppliers', 'subcontractors', 'carriers', 'blocked', 'archived', 'all'],
    tiles: ['active', 'prospects', 'blocked'],
    tabs: ['overview', 'contacts', 'orders', 'activity'],
    recordType: 'Party',
  },
}

/** A tile is a named saved filter (00 §2.1): pressing it shows that view of the list. */
export const TILE_VIEW: Readonly<Record<TileId, ListView>> = { active: 'active', prospects: 'prospects', vies: 'vies', invoice: 'invoice', blocked: 'blocked' }

/** The extra filters of the filter row (beside the view and the search). */
export interface ListFilters {
  kind?: PartyKind | null
  taxMode?: TaxMode | null
}

/** A view of the list as the API's query. */
export function viewQuery(config: SideConfig, view: ListView, filters: ListFilters = {}, q = ''): PartyQuery {
  const base: PartyQuery = { roles: config.roles, q, ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.taxMode ? { taxMode: filters.taxMode } : {}) }
  const statuses: Partial<Record<ListView, PartyQuery['statuses']>> = { active: ['ACTIVE'], prospects: ['PROSPECT'], blocked: ['BLOCKED'], archived: ['ARCHIVED'], all: ['ALL'] }
  const roles: Partial<Record<ListView, PartyRole[]>> = { brands: ['BRAND'], suppliers: ['SUPPLIER'], subcontractors: ['SUBCONTRACTOR'], carriers: ['CARRIER'] }
  const attention: Partial<Record<ListView, Attention>> = { invoice: 'INVOICE', vies: 'VIES' }
  return {
    ...base,
    ...(statuses[view] ? { statuses: statuses[view] } : {}),
    ...(roles[view] ? { roles: roles[view] } : {}),
    ...(attention[view] ? { attention: attention[view] } : {}),
  }
}

/** The address of a side's list or record under `/w/<company>`. */
export const sideHref = (prefix: string, config: SideConfig, path = '') => `${prefix}${config.base}${path}`
export const recordHref = (prefix: string, config: SideConfig, partyId: string, tab?: RecordTab) =>
  `${sideHref(prefix, config, `/${encodeURIComponent(partyId)}`)}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`

// ---- reads and problems -----------------------------------------------------------------------------------------------

/** A read: null items while loading; a problem (a message key) when it failed. */
export interface Loaded<T> {
  items: readonly T[] | null
  problem?: string | null
  /** More exist than were read. */
  more?: boolean
}
export const loading = <T>(): Loaded<T> => ({ items: null, problem: null })
export const loaded = <T>(items: readonly T[], more = false): Loaded<T> => ({ items, problem: null, more })
export const failed = <T>(problem: string): Loaded<T> => ({ items: null, problem })

export interface Notice {
  key: string
  tone: 'success' | 'info' | 'warning' | 'danger'
  params?: Readonly<Record<string, string | number>>
}

/** A failed read or write in this app's words (a key of `parties`). */
export function problemKey(error: unknown): string {
  if (!isApiError(error)) return 'problem.internal'
  switch (error.kind) {
    case 'signed_out':
      return 'problem.signedOut'
    case 'forbidden':
    case 'step_up':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'unavailable':
      return 'problem.unavailable'
    case 'contract':
      return 'problem.contract'
    default:
      return 'problem.internal'
  }
}

/**
 * The fields a refused write points at (`body/vatNumber`, `body/taxIdentity/vatNumber`, `body/addresses/0/city`): the
 * last part is the field; the form shows its own words for it ("The API refused this value").
 */
export function refusedFields(error: unknown): string[] {
  if (!isApiError(error)) return []
  return error.issues
    .map(
      (issue) =>
        issuePath(issue)
          .replace(/\./g, '/')
          .split('/')
          .filter((part) => part !== '' && part !== 'body' && !/^\d+$/.test(part))
          .at(-1) ?? '',
    )
    .filter((field) => field !== '')
}

// ---- words and tones --------------------------------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export const STATUS_TONE: Readonly<Record<PartyStatus, Tone>> = { PROSPECT: 'info', ACTIVE: 'success', BLOCKED: 'danger', ARCHIVED: 'neutral' }

/** A VIES standing as a tone: proven green, refused red, waiting amber, nothing to check neutral. */
export const VIES_TONE: Readonly<Record<ViesState, Tone>> = { NOT_APPLICABLE: 'neutral', UNCHECKED: 'warning', VALID: 'success', EXPIRED: 'warning', INVALID: 'danger', HELD: 'warning' }

/** The VIES result of one check, as a tone. */
export const RESULT_TONE: Readonly<Record<ViesCheck['result'], Tone>> = { VALID: 'success', INVALID: 'danger', ERROR: 'warning' }

/** What each warning asks the person to do, and where (the side panel's "next step"). */
export type NextAction = 'identity' | 'correctIdentity' | 'vies' | 'address' | 'contact' | 'edit'
export const WARNING_ACTION: Readonly<Record<WarningCode, NextAction>> = {
  NO_TAX_IDENTITY: 'identity',
  NO_REGISTERED_ADDRESS: 'address',
  FISCAL_DRAWER: 'correctIdentity',
  VIES_NOT_PROVEN: 'vies',
  TAX_COUNTRY_DIFFERS: 'edit',
  NO_DEFAULT_BILL_TO: 'address',
  NO_DEFAULT_SHIP_TO: 'address',
  NO_ORDERS_CONTACT: 'contact',
  NAME_TOO_LONG: 'edit',
  NOT_LATIN1: 'edit',
}

/** The warnings most serious first: what stops an invoice, then the rest in the API's order. */
export function nextSteps(warnings: Party['warnings']): Party['warnings'] {
  return [...warnings.filter((warning) => warning.blocksInvoice), ...warnings.filter((warning) => !warning.blocksInvoice)]
}

/** A tax mode is a business one with a VAT number VIES can prove (EU outside Italy). */
export const viesApplies = (row: Pick<PartyRow, 'vies'>) => row.vies.state !== 'NOT_APPLICABLE'

/** The SDI code or PEC column of an Italian business customer: set / missing; else not needed (null). */
export function sdiState(row: Pick<PartyRow, 'taxMode' | 'attention' | 'roles'>): 'set' | 'missing' | null {
  if (row.taxMode !== 'IT_B2B' || !row.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) return null
  return row.attention.includes('FISCAL_DRAWER') ? 'missing' : 'set'
}

/** The country's name in the page's language (Intl), else its code. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** A language's name in the page's language (Intl), else its code. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
  } catch {
    return code
  }
}

/** The countries a form offers, by their name in the page's language; Italy and the EU first. */
export function countryOptions(locale: string): Array<{ value: string; label: string }> {
  const all = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code, locale) }))
  const rank = (code: string) => (code === 'IT' ? 0 : isEuMemberState(code) ? 1 : 2)
  return all.sort((a, b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label, locale))
}

/** The languages a form offers (documents and mail go out in the party's language). */
export const LANGUAGE_CHOICES = ['it', 'en', 'de', 'fr', 'es', 'pt', 'nl', 'pl', 'ro', 'cs', 'el', 'sv', 'da', 'fi', 'hu', 'sk', 'sl', 'hr', 'bg', 'lt', 'lv', 'et', 'tr', 'zh', 'ja'] as const
export const CURRENCY_CHOICES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'NOK', 'CNY', 'JPY', 'TRY'] as const

/** The language a party of this country most likely reads. */
export function languageOf(country: string): string {
  const map: Record<string, string> = {
    IT: 'it',
    SM: 'it',
    VA: 'it',
    DE: 'de',
    AT: 'de',
    FR: 'fr',
    BE: 'fr',
    LU: 'fr',
    ES: 'es',
    PT: 'pt',
    NL: 'nl',
    PL: 'pl',
    RO: 'ro',
    CZ: 'cs',
    GR: 'el',
    SE: 'sv',
    DK: 'da',
    FI: 'fi',
    HU: 'hu',
    SK: 'sk',
    SI: 'sl',
    HR: 'hr',
    BG: 'bg',
    LT: 'lt',
    LV: 'lv',
    EE: 'et',
    TR: 'tr',
    CN: 'zh',
    JP: 'ja',
  }
  return map[country] ?? 'en'
}

// ---- money by grain ---------------------------------------------------------------------------------------------------

/** An amount in minor units in its currency, in the page's language; null when the field was not sent (no grain). */
export function money(minor: number | undefined, currency: string, locale: string): string | null {
  if (minor === undefined) return null
  const format = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency })
  const places = format.resolvedOptions().maximumFractionDigits ?? 2
  return format.format(minor / 10 ** places)
}

// ---- quotes and orders (the customer's Quotes & orders, the supplier's Orders) -----------------------------------------

export const OPEN_QUOTES: ReadonlySet<QuoteRow['status']> = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'])
export const OPEN_ORDERS: ReadonlySet<SalesOrderRow['status']> = new Set(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'])
export const OPEN_PURCHASE_ORDERS: ReadonlySet<PurchaseOrderRow['status']> = new Set(['DRAFT', 'SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'])

export type DealFilter = 'open' | 'won' | 'lost' | 'all'

export interface DealRow {
  type: 'quote' | 'order'
  id: string
  number: string
  status: string
  /** The quote's last change or the order's date (YYYY-MM-DD or an instant). */
  date: string
  currency: string
  amount: number | undefined
  promiseDate: string | null
  validUntil: string | null
  open: boolean
  won: boolean
  lost: boolean
}

/** Quotes and orders in one list, newest first (the customer's Quotes & orders tab). */
export function dealRows(quotes: readonly QuoteRow[], orders: readonly SalesOrderRow[], filter: DealFilter): DealRow[] {
  const rows: DealRow[] = [
    ...quotes.map((quote) => ({
      type: 'quote' as const,
      id: quote.id,
      number: quote.number,
      status: quote.status,
      date: quote.updatedAt,
      currency: quote.currency,
      amount: quote.netAmount,
      promiseDate: quote.promiseDate,
      validUntil: quote.validUntil,
      open: OPEN_QUOTES.has(quote.status),
      won: quote.status === 'ACCEPTED',
      lost: quote.status === 'DECLINED' || quote.status === 'EXPIRED' || quote.status === 'CANCELLED',
    })),
    ...orders.map((order) => ({
      type: 'order' as const,
      id: order.id,
      number: order.number,
      status: order.status,
      date: order.orderDate,
      currency: order.currency,
      amount: order.netAmount,
      promiseDate: order.promiseDate,
      validUntil: null,
      open: OPEN_ORDERS.has(order.status),
      won: order.status !== 'CANCELLED',
      lost: order.status === 'CANCELLED',
    })),
  ]
  const kept = rows.filter((row) => filter === 'all' || (filter === 'open' ? row.open : filter === 'won' ? row.won : row.lost))
  return kept.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** The customer's key numbers (SAL-019), from what was read: null when unknown (no read, no right). */
export interface KeyNumbers {
  openQuotes: { count: number; amount: number | null; currency: string | null } | null
  backlog: { count: number; units: number; amount: number | null; currency: string | null } | null
  orderedThisYear: { count: number; amount: number | null; currency: string | null } | null
}

/** One sum when every row has its amount in one currency; null otherwise (never a sum of mixed currencies or hidden values). */
function sumOf(rows: ReadonlyArray<{ amount: number | undefined; currency: string }>): { amount: number | null; currency: string | null } {
  if (rows.length === 0) return { amount: 0, currency: null }
  const currencies = new Set(rows.map((row) => row.currency))
  if (currencies.size !== 1 || rows.some((row) => row.amount === undefined)) return { amount: null, currency: currencies.size === 1 ? rows[0]!.currency : null }
  return { amount: rows.reduce((total, row) => total + (row.amount ?? 0), 0), currency: rows[0]!.currency }
}

export function keyNumbers(quotes: Loaded<QuoteRow>, orders: Loaded<SalesOrderRow>, year: string): KeyNumbers {
  const open = quotes.items && !quotes.more ? quotes.items.filter((quote) => OPEN_QUOTES.has(quote.status)) : null
  const backlog = orders.items && !orders.more ? orders.items.filter((order) => OPEN_ORDERS.has(order.status)) : null
  const thisYear = orders.items && !orders.more ? orders.items.filter((order) => order.status !== 'CANCELLED' && order.orderDate.startsWith(year)) : null
  return {
    openQuotes: open ? { count: open.length, ...sumOf(open.map((quote) => ({ amount: quote.netAmount, currency: quote.currency }))) } : null,
    backlog: backlog
      ? {
          count: backlog.length,
          units: backlog.reduce((total, order) => total + Math.max(0, order.units - order.shippedUnits), 0),
          ...sumOf(backlog.map((order) => ({ amount: order.netAmount, currency: order.currency }))),
        }
      : null,
    orderedThisYear: thisYear ? { count: thisYear.length, ...sumOf(thisYear.map((order) => ({ amount: order.netAmount, currency: order.currency }))) } : null,
  }
}

// ---- drafts and their checks (the API's rules, in this app's words) ---------------------------------------------------

/** A form's problems: field → message key (`form.*` of `parties`), with the parameters it needs. */
export type Problems = Record<string, { key: string; params?: Record<string, string> }>

const has = (problems: Problems) => Object.keys(problems).length > 0
export const isReady = (problems: Problems) => !has(problems)

export interface IdentityDraft {
  country: string
  taxMode: TaxMode
  vatNumber: string
  fiscalCode: string
  sdiRecipientCode: string
  pec: string
  validFrom: string
}

export const blankIdentity = (country = 'IT', hasVat = true): IdentityDraft => ({
  country,
  taxMode: suggestTaxMode({ country, hasVatNumber: hasVat }),
  vatNumber: '',
  fiscalCode: '',
  sdiRecipientCode: '',
  pec: '',
  validFrom: '',
})

export const identityDraftOf = (identity: TaxIdentity): IdentityDraft => ({
  country: identity.country,
  taxMode: identity.taxMode,
  vatNumber: identity.vatNumber ?? '',
  fiscalCode: identity.fiscalCode ?? '',
  sdiRecipientCode: identity.sdiRecipientCode ?? '',
  pec: identity.pec ?? '',
  validFrom: identity.validFrom,
})

/** Which fields a tax mode asks for. */
export function identityFields(mode: TaxMode): { vat: boolean; fiscal: boolean; sdi: boolean } {
  return { vat: mode === 'IT_B2B' || mode === 'EU_B2B' || mode === 'EXTRA_EU', fiscal: mode === 'IT_B2B' || mode === 'IT_B2C', sdi: mode === 'IT_B2B' || mode === 'IT_B2C' }
}

const blankToNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** A tax identity draft as the API's body (fields its mode does not use are left out). */
export function identityBody(draft: IdentityDraft, withDate: boolean): TaxIdentityBody {
  const fields = identityFields(draft.taxMode)
  return {
    country: draft.country,
    taxMode: draft.taxMode,
    vatNumber: fields.vat ? blankToNull(draft.vatNumber) : null,
    fiscalCode: fields.fiscal ? blankToNull(draft.fiscalCode) : null,
    sdiRecipientCode: fields.sdi ? blankToNull(draft.sdiRecipientCode) : null,
    pec: fields.sdi ? blankToNull(draft.pec) : null,
    ...(withDate && draft.validFrom ? { validFrom: draft.validFrom } : {}),
  }
}

/**
 * What is wrong with a tax identity (factory-domain parties/tax: VAT check digits and formats, the codice fiscale, the
 * 7-character SDI code), one message key per field. `withDate`: the "from a date" form, whose day is needed.
 */
export function identityProblems(draft: IdentityDraft, withDate = false): Problems {
  const body = identityBody(draft, true)
  const normal = normaliseTaxIdentity({ ...body, validFrom: draft.validFrom || '2000-01-01' })
  const paths = new Set(taxIdentityProblems(normal).map((issue) => issue.path))
  const problems: Problems = {}
  const italian = draft.taxMode === 'IT_B2B' || draft.taxMode === 'IT_B2C'
  if (paths.has('country')) problems.country = isCountryCode(draft.country) ? { key: `form.identity.countryMode.${draft.taxMode}` } : { key: 'form.country' }
  if (paths.has('vatNumber')) {
    const number = normal.vatNumber
    if (number === null) problems.vatNumber = { key: draft.taxMode === 'IT_B2B' ? 'form.identity.vatNeededIt' : 'form.identity.vatNeededEu' }
    else if (draft.taxMode === 'EXTRA_EU') problems.vatNumber = { key: 'form.identity.foreignId' }
    else if (draft.taxMode === 'IT_B2C' || draft.taxMode === 'EU_B2C')
      problems.vatNumber = { key: draft.taxMode === 'IT_B2C' ? 'form.identity.vatMeansBusinessIt' : 'form.identity.vatMeansBusinessEu' }
    else {
      const prefix = vatPrefixOf(draft.country)
      const split = splitEuVatNumber(number)
      const format = EU_VAT_FORMATS[prefix]
      if (!split || split.prefix !== prefix) problems.vatNumber = { key: 'form.identity.vatPrefix', params: { prefix } }
      else if (format && !format.pattern.test(split.number)) problems.vatNumber = { key: 'form.identity.vatShape', params: { country: draft.country } }
      else if (prefix === 'IT' && !isValidPartitaIva(split.number)) problems.vatNumber = { key: 'form.identity.vatCheckDigit' }
      else problems.vatNumber = { key: 'form.identity.vatShape', params: { country: draft.country } }
    }
  }
  if (paths.has('fiscalCode')) problems.fiscalCode = { key: !italian ? 'form.identity.fiscalItalian' : normal.fiscalCode === null ? 'form.identity.fiscalNeeded' : 'form.identity.fiscalShape' }
  if (paths.has('sdiRecipientCode'))
    problems.sdiRecipientCode = { key: !italian ? 'form.identity.sdiItalian' : /^[A-Z0-9]{6}$/.test(normal.sdiRecipientCode ?? '') ? 'form.identity.sdiPublic' : 'form.identity.sdiShape' }
  if (paths.has('pec')) problems.pec = { key: italian ? 'form.identity.pecShape' : 'form.identity.pecItalian' }
  if (withDate && !/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom)) problems.validFrom = { key: 'form.identity.validFrom' }
  return problems
}

export interface PartyDraft {
  code: string
  kind: PartyKind
  legalName: string
  tradeName: string
  roles: PartyRole[]
  country: string
  currency: string
  language: string
  paymentTerms: string
  internalNote: string
}

export const partyDraftOf = (party: Party): PartyDraft => ({
  code: party.code,
  kind: party.kind,
  legalName: party.legalName,
  tradeName: party.tradeName ?? '',
  roles: [...party.roles],
  country: party.country,
  currency: party.currency,
  language: party.language,
  paymentTerms: party.paymentTerms ?? '',
  internalNote: party.internalNote ?? '',
})

/** What is wrong with a party's own fields (factory-domain parties/rules), one key per field. */
export function partyProblems(draft: PartyDraft): Problems {
  const problems: Problems = {}
  const code = draft.code.trim().toUpperCase()
  if (code === '') problems.code = { key: 'form.party.codeNeeded' }
  else if (!PARTY_CODE.test(code)) problems.code = { key: 'form.party.codeShape' }
  if (draft.legalName.trim() === '') problems.legalName = { key: 'form.party.legalNameNeeded' }
  else if (draft.legalName.trim().length > 200) problems.legalName = { key: 'form.tooLong', params: { max: '200' } }
  if (draft.tradeName.trim().length > 200) problems.tradeName = { key: 'form.tooLong', params: { max: '200' } }
  if (draft.roles.length === 0) problems.roles = { key: 'form.party.rolesNeeded' }
  if (!isCountryCode(draft.country)) problems.country = { key: 'form.country' }
  if (!/^[A-Z]{3}$/.test(draft.currency)) problems.currency = { key: 'form.party.currency' }
  if (!isLanguageCode(draft.language)) problems.language = { key: 'form.party.language' }
  if (draft.paymentTerms.trim().length > 500) problems.paymentTerms = { key: 'form.tooLong', params: { max: '500' } }
  if (draft.internalNote.trim().length > 4000) problems.internalNote = { key: 'form.tooLong', params: { max: '4000' } }
  return problems
}

/** The fields of a party that changed, as a PATCH body (null clears an optional text). */
export function partyPatch(before: PartyDraft, after: PartyDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (after.code.trim().toUpperCase() !== before.code) out.code = after.code.trim().toUpperCase()
  if (after.kind !== before.kind) out.kind = after.kind
  if (after.legalName.trim() !== before.legalName) out.legalName = after.legalName.trim()
  if (text(after.tradeName) !== text(before.tradeName)) out.tradeName = text(after.tradeName)
  if (after.roles.join() !== before.roles.join()) out.roles = after.roles
  if (after.country !== before.country) out.country = after.country
  if (after.currency !== before.currency) out.currency = after.currency
  if (after.language !== before.language) out.language = after.language
  if (text(after.paymentTerms) !== text(before.paymentTerms)) out.paymentTerms = text(after.paymentTerms)
  if (text(after.internalNote) !== text(before.internalNote)) out.internalNote = text(after.internalNote)
  return out
}

/** A code from a name: its words in capitals joined by dashes, at most 24 characters (the person may change it). */
export function suggestCode(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\b(S\.?R\.?L\.?S?|S\.?P\.?A\.?|S\.?N\.?C\.?|S\.?A\.?S\.?|GMBH|LTD|SARL|SAS|SL|BV|AG|INC)\b/g, ' ')
    .split(/[^A-Z0-9]+/)
    .filter((word) => word !== '')
  let code = ''
  for (const word of words) {
    const next = code ? `${code}-${word}` : word
    if (next.length > 24) break
    code = next
  }
  return code.slice(0, 24).replace(/-+$/, '')
}

export interface NewPartyDraft {
  party: PartyDraft
  identity: IdentityDraft
  /** The code was typed by the person (no longer follows the name). */
  codeTouched: boolean
  /** The company it belongs to; null: every company of the tenant (asked only when the person works in several). */
  companyId: string | null
}

export function blankNewParty(config: SideConfig): NewPartyDraft {
  return {
    companyId: null,
    party: { code: '', kind: 'ORGANISATION', legalName: '', tradeName: '', roles: [config.newRoles[0]!], country: 'IT', currency: 'EUR', language: 'it', paymentTerms: '', internalNote: '' },
    identity: blankIdentity('IT', true),
    codeTouched: false,
  }
}

/** Every problem of a new party: its fields and its first tax identity (an identity with no number at all is left out). */
export function newPartyProblems(draft: NewPartyDraft): Problems {
  const identity = identityProblems({ ...draft.identity, country: draft.party.country })
  const prefixed: Problems = Object.fromEntries(Object.entries(identity).map(([field, problem]) => [`identity.${field}`, problem]))
  return { ...partyProblems(draft.party), ...(identityWanted(draft) ? prefixed : {}) }
}

/** A first identity goes with the new party unless the mode needs nothing and nothing was typed (EU_B2C, an empty EXTRA_EU). */
export function identityWanted(draft: NewPartyDraft): boolean {
  const typed = [draft.identity.vatNumber, draft.identity.fiscalCode, draft.identity.sdiRecipientCode, draft.identity.pec].some((value) => value.trim() !== '')
  return typed || draft.identity.taxMode === 'IT_B2B' || draft.identity.taxMode === 'IT_B2C' || draft.identity.taxMode === 'EU_B2B'
}

export interface AddressDraft {
  kinds: AddressKind[]
  name: string
  line1: string
  line2: string
  postalCode: string
  city: string
  province: string
  country: string
  contactName: string
  phone: string
  deliveryNotes: string
  isDefaultBillTo: boolean
  isDefaultShipTo: boolean
}

export const blankAddress = (country: string, first: boolean): AddressDraft => ({
  kinds: first ? ['REGISTERED', 'BILL_TO', 'SHIP_TO'] : ['SHIP_TO'],
  name: '',
  line1: '',
  line2: '',
  postalCode: '',
  city: '',
  province: '',
  country,
  contactName: '',
  phone: '',
  deliveryNotes: '',
  isDefaultBillTo: first,
  isDefaultShipTo: first,
})

export const addressDraftOf = (address: Address): AddressDraft => ({
  kinds: [...address.kinds],
  name: address.name ?? '',
  line1: address.line1,
  line2: address.line2 ?? '',
  postalCode: address.postalCode,
  city: address.city,
  province: address.province ?? '',
  country: address.country,
  contactName: address.contactName ?? '',
  phone: address.phone ?? '',
  deliveryNotes: address.deliveryNotes ?? '',
  isDefaultBillTo: address.isDefaultBillTo,
  isDefaultShipTo: address.isDefaultShipTo,
})

export function addressBody(draft: AddressDraft): AddressBody {
  return {
    kinds: draft.kinds,
    name: blankToNull(draft.name),
    line1: draft.line1.trim(),
    line2: blankToNull(draft.line2),
    postalCode: draft.postalCode.trim(),
    city: draft.city.trim(),
    province: blankToNull(draft.province),
    country: draft.country,
    contactName: blankToNull(draft.contactName),
    phone: blankToNull(draft.phone),
    deliveryNotes: blankToNull(draft.deliveryNotes),
  }
}

/** factory-domain parties/addresses rules, one key per field (`form.address.<field>`); a default needs its use. */
export function addressDraftProblems(draft: AddressDraft): Problems {
  const problems: Problems = {}
  for (const issue of addressProblems(normaliseAddress(addressBody(draft)))) {
    if (problems[issue.path]) continue
    const italian = draft.country === 'IT'
    const key =
      issue.path === 'postalCode'
        ? italian
          ? 'form.address.capIt'
          : 'form.address.postalCode'
        : issue.path === 'province'
          ? italian
            ? 'form.address.provinceIt'
            : 'form.address.provinceLong'
          : `form.address.${issue.path}`
    problems[issue.path] = { key }
  }
  if (draft.isDefaultBillTo && !draft.kinds.includes('BILL_TO')) problems.isDefaultBillTo = { key: 'form.address.defaultBillTo' }
  if (draft.isDefaultShipTo && !draft.kinds.includes('SHIP_TO')) problems.isDefaultShipTo = { key: 'form.address.defaultShipTo' }
  return problems
}

export interface ContactDraft {
  name: string
  email: string
  phone: string
  roles: ContactRole[]
  language: string
}

export const blankContact = (roles: ContactRole[] = ['ORDERS']): ContactDraft => ({ name: '', email: '', phone: '', roles, language: '' })
export const contactDraftOf = (contact: Contact): ContactDraft => ({
  name: contact.name,
  email: contact.email ?? '',
  phone: contact.phone ?? '',
  roles: [...contact.roles],
  language: contact.language ?? '',
})

export function contactBody(draft: ContactDraft): ContactBody {
  return { name: draft.name.trim(), email: blankToNull(draft.email), phone: blankToNull(draft.phone), roles: draft.roles, language: blankToNull(draft.language) }
}

/** factory-domain parties/contacts rules (a contact who receives documents has an email), one key per field. */
export function contactDraftProblems(draft: ContactDraft, others: readonly Contact[] = []): Problems {
  const problems: Problems = {}
  const contact = normaliseContact(contactBody(draft))
  for (const issue of contactProblems(contact)) {
    if (problems[issue.path]) continue
    problems[issue.path] = { key: issue.path === 'email' && contact.email === null ? 'form.contact.emailForDocuments' : `form.contact.${issue.path}` }
  }
  if (!problems.email && contact.email !== null && others.some((other) => other.status === 'ACTIVE' && other.email === contact.email)) problems.email = { key: 'form.contact.emailTwice' }
  return problems
}

/** A block or an archive needs its reason (1 to 500 characters). */
export function reasonProblem(reason: string, required: boolean): string | null {
  const text = reason.trim()
  if (text === '') return required ? 'form.reasonNeeded' : null
  return text.length > 500 ? 'form.reasonLong' : null
}

// ---- export (Export ▾ "This view (CSV)") ------------------------------------------------------------------------------

const csvCell = (value: string | null | undefined) => {
  const text = value ?? ''
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The rows of the view as CSV (the columns the list shows, words in the page's language). */
export function partiesCsv(
  rows: readonly PartyRow[],
  words: { header: readonly string[]; status: (row: PartyRow) => string; roles: (row: PartyRow) => string; vies: (row: PartyRow) => string; taxMode: (row: PartyRow) => string },
): string {
  const lines = [words.header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [row.code, row.legalName, row.tradeName, words.roles(row), words.status(row), row.country, row.city, words.taxMode(row), row.vatNumber, row.fiscalCode, words.vies(row), row.language]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

// ---- bulk runs (Check VIES for N, Archive N) --------------------------------------------------------------------------

export type BulkKind = 'vies' | 'archive' | 'block'
export interface BulkResult {
  id: string
  code: string
  name: string
  /** A message key: the VIES result, archived, or why not. */
  outcome: string
  tone: Tone
}
export interface BulkRun {
  kind: BulkKind
  total: number
  results: readonly BulkResult[]
  done: boolean
}

/** Which selected rows a bulk action reaches, and the rest with why not (held before the click, 00 §2.1). */
export function bulkReach(kind: BulkKind, rows: readonly PartyRow[]): { reach: PartyRow[]; skipped: PartyRow[] } {
  const reaches = (row: PartyRow) =>
    kind === 'vies' ? viesApplies(row) && row.status !== 'ARCHIVED' : kind === 'block' ? row.status === 'ACTIVE' : row.status === 'ACTIVE' || row.status === 'PROSPECT'
  return { reach: rows.filter(reaches), skipped: rows.filter((row) => !reaches(row)) }
}

/** At most this many rows in one bulk run (one gateway call each for VIES). */
export const BULK_MAX = 50

// ---- view models ------------------------------------------------------------------------------------------------------

export interface ListCan {
  view: boolean
  manage: boolean
  block: boolean
  vies: boolean
}

export type ListDialog = { kind: 'new' } | { kind: 'block'; partyIds: readonly string[] } | { kind: 'archive'; partyIds: readonly string[] } | { kind: 'bulk' } | { kind: 'shortcuts' }

export type LiveState = 'connecting' | 'live' | 'offline'

export interface PartiesListModel {
  side: Side
  prefix: string
  rows: Loaded<PartyRow>
  /** The API's count of the view; null unknown. */
  total: number | null
  /** More pages exist (Show more). */
  more: boolean
  loadingMore?: boolean
  /** Each tile's count; null = unknown (drawn as —). */
  tiles: Partial<Record<TileId, number | null>>
  view: ListView
  filters: ListFilters
  query: string
  asOf: string | null
  live: LiveState
  /** Changes the live stream announced since the rows were read (shown behind "N updates · Show"). */
  updates: number
  selected: readonly string[]
  can: ListCan
  notice?: Notice | null
  dialog?: ListDialog | null
  busy?: boolean
  dialogProblem?: string | null
  /** Fields the API refused in the dialog (`refusedFields`). */
  refused?: readonly string[]
  /** Parties the typed VAT number or name already finds (the duplicate warning). */
  duplicates?: readonly PartyRow[]
  /** A design case's starting form. */
  newDraft?: NewPartyDraft
  /** The companies the person works in (New asks which one a party belongs to when there are several). */
  companies?: ReadonlyArray<{ id: string; name: string }>
  bulk?: BulkRun | null
  /** A design case's focused row (keyboard). */
  focusRow?: number
}

export interface RecordCan {
  view: boolean
  manage: boolean
  block: boolean
  vies: boolean
  quotes: boolean
  orders: boolean
  purchaseOrders: boolean
  price: boolean
  cost: boolean
  threads: boolean
}

export type RecordDialog =
  | { kind: 'edit' }
  | { kind: 'block' }
  | { kind: 'archive' }
  | { kind: 'address'; addressId?: string }
  | { kind: 'contact'; contactId?: string }
  | { kind: 'identity'; mode: 'new' | 'correct' }
  | { kind: 'shortcuts' }

export interface PartyRecordModel {
  side: Side
  prefix: string
  tab: RecordTab
  party: Party | null
  problem?: string | null
  can: RecordCan
  asOf: string | null
  live: LiveState
  /** Someone else changed the record while this person had unsaved work: the banner offers a reload. */
  changedAt?: string | null
  busy?: boolean
  notice?: Notice | null
  dialog?: RecordDialog | null
  dialogProblem?: string | null
  refused?: readonly string[]
  dockOpen?: boolean
  /** Every VIES check of the party (the history), newest first. */
  history: Loaded<ViesCheck>
  quotes: Loaded<QuoteRow>
  orders: Loaded<SalesOrderRow>
  purchaseOrders: Loaded<PurchaseOrderRow>
  viesRunning?: boolean
  /** The address or default being saved in place (its id, or 'billTo' / 'shipTo'). */
  saving?: string | null
  /** The Overview form's starting draft (supplier; design cases). */
  draft?: PartyDraft | null
  /** The Quotes & orders filter. */
  deals?: DealFilter
  /** Design cases: the dialog's starting drafts. */
  addressDraft?: AddressDraft
  contactDraft?: ContactDraft
  identityDraft?: IdentityDraft
  /** A tenant-wide party is checked for one company: the session's companies to choose from. */
  companies?: ReadonlyArray<{ id: string; name: string }>
}

/** The tabs a person sees on a record of this side (Quotes & orders and Orders need their module's read right). */
export function recordTabs(config: SideConfig, can: RecordCan): RecordTab[] {
  return config.tabs.filter((tab) => {
    if (tab === 'orders') return config.side === 'customers' ? can.quotes || can.orders : can.purchaseOrders
    if (tab === 'activity' || tab === 'documents') return can.threads
    return true
  })
}

/** The record's name: its trade name, else its legal name. */
export const partyName = (party: Pick<PartyRow, 'tradeName' | 'legalName'>) => party.tradeName ?? party.legalName

/** The record can be changed: not archived, and the person may manage parties. */
export const writable = (party: Pick<PartyRow, 'status'>, can: Pick<RecordCan, 'manage'>) => can.manage && party.status !== 'ARCHIVED'

/** The current tax identity, and the earlier and later ones. */
export function identitiesOf(party: Party): { current: TaxIdentity | null; others: TaxIdentity[] } {
  const current = party.taxIdentities.find((identity) => identity.current) ?? null
  return { current, others: party.taxIdentities.filter((identity) => identity !== current) }
}

/** The contacts that receive what this side sends (customers: quotes and confirmations; suppliers: POs). */
export const mainContacts = (party: Party, role: ContactRole) => party.contacts.filter((contact) => contact.status === 'ACTIVE' && contact.roles.includes(role))
