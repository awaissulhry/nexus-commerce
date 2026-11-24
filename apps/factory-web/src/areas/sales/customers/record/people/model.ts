import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { SectionId } from '../../../orders/record/production/layout'

/**
 * F-CA-101 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §1, §2; 18-lead-settles Z2, Z16, Z20) — the tab's names: its
 * catalogue, its sections (each its address: `…/sales/customers/<id>?tab=people#<id>`, the anchors the Overview points at), the
 * reader's rights as the tab reads them, and how its rules say their words (a key of the tab's own catalogue, or `namespace:key` for a
 * word reused from another catalogue — never a second word for one thing). Pure.
 */

/** The tab's own words (`messages/<locale>/customer-people.json`, Z20). */
export const CP = 'customer-people'

/** Every catalogue the tab and the windows it opens say words from (the kit speaks `orders`). */
export const PEOPLE_TAB_NAMESPACES: readonly string[] = ['orders', CP, 'parties', 'portal-access', 'sales-customers-depth', 'sales-mtm' /* F-CA-203: Riders & measurements reuse its words */]

/** The four sections, top to bottom (Z2: they stack at every room). Riders & measurements and Personal data are drawn from ca-w2 on. */
export const PEOPLE_SECTIONS = ['people', 'addresses', 'riders', 'personal-data'] as const
export type PeopleSectionId = (typeof PEOPLE_SECTIONS)[number]

/** The answer line's own address (above the sections). */
export const PEOPLE_ANSWER_ID = 'answer'

/**
 * The Production kit's Section (used in place, Kit.tsx untouched) names the addresses of the tabs it was made for in its type; this
 * tab's addresses pass through it as they are (the Shipments tab's own way, `rec/shipments/view/hrefs.ts` kitId).
 */
export const peopleKitId = (id: PeopleSectionId): SectionId => id as string as SectionId

/** A row's own address inside its section (a chip's door, "Copy link to this row", a scroll that marks the row). */
export const personAnchor = (rowId: string): string => `person-${rowId}`
export const addressAnchor = (addressId: string): string => `address-${addressId}`

/** What the reader may do here — each act reads its OWN right; a button without its right is not drawn (never held for a right). */
export interface PeopleCan {
  /** parties.view — the tab at all. */
  readonly view: boolean
  /** parties.manage — Add / Edit / Archive / Restore a contact or an address, the defaults. */
  readonly manage: boolean
  /** orders.manage — Approve / Refuse an address the customer added in the portal. */
  readonly ordersManage: boolean
  /** partners.view — the portal column, its chips, the seats. */
  readonly portal: boolean
  /** partners.invite — Invite, send again, revoke. */
  readonly invite: boolean
  /** partners.manage — change access, suspend, reactivate, deactivate. */
  readonly portalManage: boolean
  /** audit.read — History ›. */
  readonly audit: boolean
  // ---- F-CA-201 (ca-w2 W2.1–W2.4): Riders & measurements and Personal data
  /** sales.measurements.view — measurement profiles at all (body data: without it, the riders' names only). */
  readonly measurements: boolean
  /** sales.mtm.record — New measurements. */
  readonly mtmRecord: boolean
  /** sales.measurements.manage — Send a measurement link. */
  readonly mtmLink: boolean
  /** sales.mtm.review — the factory review. */
  readonly mtmReview: boolean
  /** sales.fittings.manage — Book a fitting. */
  readonly fittings: boolean
  /** orders.view — a rider's orders. */
  readonly ordersView: boolean
  /** parties.privacy — lawful basis, objection, access copy. */
  readonly privacy: boolean
  /** parties.erase — erase a contact. */
  readonly erase: boolean
  /** privacy.view + privacy.requests.manage — a full data request in Admin › Privacy. */
  readonly privacyRequests: boolean
}

export function peopleCan(permissions: readonly string[]): PeopleCan {
  const held = new Set(permissions)
  return {
    view: held.has('parties.view'),
    manage: held.has('parties.manage'),
    ordersManage: held.has('orders.manage'),
    portal: held.has('partners.view'),
    invite: held.has('partners.invite'),
    portalManage: held.has('partners.manage'),
    audit: held.has('audit.read'),
    measurements: held.has('sales.measurements.view'),
    mtmRecord: held.has('sales.mtm.record'),
    mtmLink: held.has('sales.measurements.manage'),
    mtmReview: held.has('sales.mtm.review'),
    fittings: held.has('sales.fittings.manage'),
    ordersView: held.has('orders.view'),
    privacy: held.has('parties.privacy'),
    erase: held.has('parties.erase'),
    privacyRequests: held.has('privacy.view') && held.has(PRIVACY_REQUESTS_RIGHT), // the page (privacy.view) and a new request
  }
}

/** The right of a new data request in Admin › Privacy › Requests (admin/privacy/requests). */
export const PRIVACY_REQUESTS_RIGHT = 'privacy.requests.manage'

/** A read the tab makes or is handed: reading, failed (a key), or its value. A read the reader may not make is `null` (left out). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }
export const READING = { status: 'loading' } as const
export const readyRead = <T>(value: T): Read<T> => ({ status: 'ready', value })
export const failedRead = (problem: string): Read<never> => ({ status: 'error', problem })
export const valueOf = <T>(read: Read<T> | null | undefined): T | null => (read && read.status === 'ready' ? read.value : null)

/**
 * Words a rule hands the view: a key (the tab's own catalogue, or `namespace:key`), its values, the instants said as a day, the inner
 * words said first, the names said as a list ("Anna, Bruno and Carla").
 */
export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly days?: Readonly<Record<string, string>>
  readonly words?: Readonly<Record<string, Said>>
  readonly lists?: Readonly<Record<string, readonly string[]>>
}
export const said = (key: string, more: Omit<Said, 'key'> = {}): Said => ({ key, ...more })

export type Say = (words: Said) => string

/** How the tab says a rule's words in a language (`t` is a scoped translator over the tab's catalogue). */
export function sayOf(t: Translate, locale: Locale): Say {
  const list = new Intl.ListFormat(INTL_LOCALE[locale], { type: 'conjunction' })
  const say: Say = (words) => {
    const values: Record<string, string | number> = { ...(words.params ?? {}) }
    for (const [name, at] of Object.entries(words.days ?? {})) values[name] = formatDate(at, { locale })
    for (const [name, inner] of Object.entries(words.words ?? {})) values[name] = say(inner)
    for (const [name, names] of Object.entries(words.lists ?? {})) values[name] = list.format(names)
    return t(words.key, values)
  }
  return say
}

/** A failed read's key (the portal's, the record's) as the kit's `orders` key (`problem.read.*`), for its PartFailed. */
export function kitProblemOf(problem: string): string {
  if (problem.startsWith('problem.read.')) return problem
  const kind = problem.replace(/^problem\./, '')
  const known: Readonly<Record<string, string>> = { signedOut: 'signed_out', signed_out: 'signed_out', forbidden: 'forbidden', notFound: 'not_found', not_found: 'not_found', unavailable: 'unavailable', rateLimited: 'rate_limited', rate_limited: 'rate_limited' }
  return `problem.read.${known[kind] ?? 'internal'}`
}

/** Days from `now` to `until`, rounded up (an end later today is "in 1 d"); null: no end. */
export function daysUntil(until: string | null | undefined, now: string): number | null {
  if (!until) return null
  return Math.ceil((Date.parse(until) - Date.parse(now)) / 86_400_000)
}

/** "Access ends within 14 days" (the answer line's chip, 10-design §4). */
export const ACCESS_ENDS_WITHIN_DAYS = 14

/** A refused address stays in view this long after the decision, then only under Show archived (Z17, P9). */
export const REFUSED_IN_VIEW_DAYS = 30

/** The People list shows this many rows, then "Show N more people"; Addresses this many (10-design §5.1, the picture). */
export const PEOPLE_ROWS = 10
export const ADDRESS_ROWS = 6
/** F-CA-203: Riders & measurements shows this many riders, then "Show N more riders" (10-design §5.3). */
export const RIDER_ROWS = 10
