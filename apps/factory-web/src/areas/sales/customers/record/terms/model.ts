import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { languageName } from '../../../../parties/_shared/model'
import { money } from '../../../quotes/model'
import { pctOf } from '../../../orders/record/money/view/say'
import type { SectionId } from '../../../orders/record/production/layout'

/**
 * F-CT-101 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §1, §2, §9; 13-backend §6.1; 18-lead-settles Z10, Z28) — the
 * tab's names: its catalogue, its four sections (each its address `…/sales/customers/<id>?tab=terms#<id>` — the four EXISTING anchors
 * Money, the Overview, the list and the tests point at), the rows' own addresses, the reader's rights as the tab reads them, and how
 * its rules say their words (a key of the tab's own catalogue, `customer-terms`, or `namespace:key` for a word reused from another
 * catalogue — never a second word for one thing). Pure.
 */

/** The tab's own words (`messages/<locale>/customer-terms.json`; the new ones under `ct.*`). */
export const CT = 'customer-terms'

/** Every catalogue the tab and the windows it opens say words from (the kit speaks `orders`; "Default deposit" is Money's word). */
export const TERMS_TAB_NAMESPACES: readonly string[] = ['orders', CT, 'sales-customers-depth', 'parties', 'customer-money']

/** The four sections, top to bottom (Z10: Hold ALWAYS first). They stack at every room. */
export const TERMS_SECTIONS = ['party-hold', 'party-commercial', 'party-requirements', 'party-identity'] as const
export type TermsSectionId = (typeof TERMS_SECTIONS)[number]

/** The answer line's own address (above the sections). */
export const TERMS_ANSWER_ID = 'answer'

/**
 * The Production kit's Section (used in place, Kit.tsx untouched) names the addresses of the tabs it was made for in its type; this
 * tab's addresses pass through it as they are (Money's `kitId`, People's `peopleKitId`).
 */
export const termsKitId = (id: TermsSectionId): SectionId => id as string as SectionId

/** A row's own address inside its section (a chip marks exactly its rows; "Copy link to this row"). */
export const holdAnchor = (holdId: string): string => `party-hold-${holdId}`
export const waitAnchor = (quoteId: string): string => `party-wait-${quoteId}`
export const companyAnchor = (companyId: string): string => `party-company-${companyId}`
/** The Tax identity & e-invoice rows a chip marks (drawn from ct-w2 on; today's identity card has none: the chip lands on the section). */
export const IDENTITY_ROWS = { einvoice: 'party-identity-einvoice', vies: 'party-identity-vies' } as const

/** What the reader may do and see here — each act reads its OWN right; a button without its right is not drawn (never held for one). */
export interface TermsCan {
  /** parties.view — the tab at all. */
  readonly view: boolean
  /** parties.manage — Change terms… · Change delivery… · Set terms for… · Back to the customer's terms… · the PO rule. */
  readonly manage: boolean
  /** parties.hold — Put on hold… · Release…. */
  readonly hold: boolean
  /** parties.vies — Check again. */
  readonly vies: boolean
  /** paymentterms.view — the payment terms library to pick from. */
  readonly paymentTerms: boolean
  /** pricelists.view — a price list as a door, the lists to pick from. */
  readonly lists: boolean
  /** pricelists.manage — giving a price list (inside the windows). */
  readonly listsManage: boolean
  /** money.price — the minimum order value (the price grain). */
  readonly price: boolean
  /** quotes.view — the quote numbers of the orders that wait (else their count). */
  readonly quotes: boolean
  /** files.read — a requirement's file as a door. */
  readonly files: boolean
  /** product.styles.view — the styles a requirement names. */
  readonly styles: boolean
  /** audit.read — History of the terms ›. */
  readonly audit: boolean
  /** The Money tab (money.price, receivables.view or sales.credit.view, as the record decides it) — the credit limit's door. */
  readonly money: boolean
  /** invoices.view — Finance › Settings, where the payment terms library lives (its page's right). */
  readonly invoices: boolean
}

export function termsCan(permissions: readonly string[]): TermsCan {
  const held = new Set(permissions)
  return {
    view: held.has('parties.view'),
    manage: held.has('parties.manage'),
    hold: held.has('parties.hold'),
    vies: held.has('parties.vies'),
    paymentTerms: held.has('paymentterms.view'),
    lists: held.has('pricelists.view'),
    listsManage: held.has('pricelists.manage'),
    price: held.has('money.price'),
    quotes: held.has('quotes.view'),
    files: held.has('files.read'),
    styles: held.has('product.styles.view'),
    audit: held.has('audit.read'),
    money: held.has('money.price') || held.has('receivables.view') || held.has('sales.credit.view'),
    invoices: held.has('invoices.view'),
  }
}

/**
 * Words a rule hands the view: a key (the tab's catalogue, or `namespace:key`), its values, the instants said as a day, the percents
 * said as Money says them ("30 %"), the amounts in their currency, the language codes as names, the inner words said first (or in
 * small letters, inside a sentence), the names said as a list ("A, B and C").
 */
export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly days?: Readonly<Record<string, string>>
  readonly pcts?: Readonly<Record<string, string>>
  readonly amounts?: Readonly<Record<string, { readonly minor: number; readonly currency: string }>>
  readonly languages?: Readonly<Record<string, string>>
  readonly words?: Readonly<Record<string, Said>>
  readonly lower?: Readonly<Record<string, Said>>
  readonly lists?: Readonly<Record<string, readonly string[]>>
  readonly saidLists?: Readonly<Record<string, readonly Said[]>>
}
export const said = (key: string, more: Omit<Said, 'key'> = {}): Said => ({ key, ...more })
/** A text the data holds (a name, a code, the words a person typed), said as it is. */
export const text = (value: string): Said => said('ct.text', { params: { text: value } })

export type Say = (words: Said) => string

/** How the tab says a rule's words in a language (`t` is a scoped translator over the tab's catalogue). ONE percent format: Money's. */
export function sayOf(t: Translate, locale: Locale): Say {
  const list = new Intl.ListFormat(INTL_LOCALE[locale], { type: 'conjunction' })
  const say: Say = (words) => {
    const values: Record<string, string | number> = { ...(words.params ?? {}) }
    for (const [name, at] of Object.entries(words.days ?? {})) values[name] = formatDate(at, { locale })
    for (const [name, pct] of Object.entries(words.pcts ?? {})) values[name] = pctOf(pct, locale)
    for (const [name, amount] of Object.entries(words.amounts ?? {})) values[name] = money(amount.minor, amount.currency, locale)
    for (const [name, code] of Object.entries(words.languages ?? {})) values[name] = languageName(code, INTL_LOCALE[locale])
    for (const [name, inner] of Object.entries(words.words ?? {})) values[name] = say(inner)
    for (const [name, inner] of Object.entries(words.lower ?? {})) values[name] = say(inner).toLocaleLowerCase(INTL_LOCALE[locale])
    for (const [name, names] of Object.entries(words.lists ?? {})) values[name] = list.format(names)
    for (const [name, inner] of Object.entries(words.saidLists ?? {})) values[name] = list.format(inner.map(say))
    return t(words.key, values)
  }
  return say
}

/** The parts of an answer said as one sentence: joined with " · ", the first letter capital, a full stop unless it ends one. */
export function sentenceOf(parts: readonly string[], locale: Locale): string {
  const joined = parts.filter((part) => part !== '').join(' · ')
  if (joined === '') return ''
  const first = joined.charAt(0).toLocaleUpperCase(INTL_LOCALE[locale]) + joined.slice(1)
  return /[.:!?…]$/.test(first) ? first : `${first}.`
}

/** A failed read's key — the depth's (offline, forbidden …) or the orders' (read.*) problem keys — as the kit's `orders` key, for PartFailed. */
export function kitProblemOf(problem: string): string {
  if (problem.startsWith('problem.read.')) return problem
  const kind = problem.replace(/^problem\./, '')
  const known: Readonly<Record<string, string>> = { signedOut: 'signed_out', signed_out: 'signed_out', forbidden: 'forbidden', notFound: 'not_found', not_found: 'not_found', offline: 'unavailable', unavailable: 'unavailable', rateLimited: 'rate_limited', rate_limited: 'rate_limited' }
  return `problem.read.${known[kind] ?? 'internal'}`
}

/** Whole days from `now` to `until` (an end later today is 0 days; null: no end). */
export function daysUntil(until: string | null | undefined, now: string): number | null {
  if (!until) return null
  return Math.floor((Date.parse(until) - Date.parse(now)) / 86_400_000)
}

/** "VIES proof ends in N days" from this many days left (10-design §4). */
export const VIES_ENDS_WITHIN_DAYS = 7

/** The company rows draw "Show N more" from this many (a tenant has few companies; 10-design §5.2). */
export const COMPANY_ROWS = 8
