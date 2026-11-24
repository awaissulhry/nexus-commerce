import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { ProductionLimitsView } from '../../../../admin/users/partners/api'
import { moneyText } from '../../../../finance/costing/model'
import type { AgeingRow } from '../../../../finance/receivables/api'
import type { Party } from '../../../../parties/_shared/api'
import { languageName, type Loaded } from '../../../../parties/_shared/model'
import type { Glance } from '../../depth/api'
import type { Read as GlanceRead } from '../../depth/model'
import type { CustomerWork } from '../../list/api'
import type { CustomersWorkModel } from '../../list/model'
import type { CustomerComplaint, CustomerReturn, OpenOrderMoney } from '../../money/api'
import type { Read, WorkReads } from '../use-customer-work'

/**
 * F-CO-101 (customer page › Overview, plan §1; 10-design; 13-backend §3.1; lead settles S5–S11, S21–S25, S28) — the customer's
 * Overview, pure: what the tab is GIVEN (`OverviewInput`: the reads the page already makes, each walled to THIS customer by the API
 * and each under its own right) and what it DRAWS (`CustomerOverviewModel`: plain data — words as keys with their figures, doors as
 * addresses or act ids). The rules are in ./headline.ts, ./strips.ts, ./rows.ts and ./doors.ts; the view
 * (../view/overview/CustomerOverviewView.tsx) draws the model with the shared overview kit's parts and nothing else.
 *
 *   a part whose read is not in     is left out (never 0, never "—" in a sentence)
 *   a part without its right        is left out (never "Not shown: your role…")
 *   a button without its right      is not in the model (held with words only by STATE: archived, a check running)
 *   every number                    is this customer's, from a read that carries its id — nothing is counted from a list of orders
 *                                   or quotes in the browser
 *   an amount                       only when the read carries it (the API drops it without the price grain)
 */

// ---- words: a key with its figures (the view says them; the tests say them in both languages) --------------------------------

/** The catalogues the Overview's words live in (the page's own `parties`, and the ones whose existing words it reuses). */
export const OVERVIEW_NAMESPACES: readonly string[] = Object.freeze(['parties', 'sales-customers-depth', 'customers-list', 'customer-money', 'before-order', 'orders-sheet', 'portal-access', 'production'])

/** A calendar day (`YYYY-MM-DD`) or an instant, said as the page writes a day. */
export interface DayParam {
  readonly day: string
}
/** An amount in minor units, said in its currency — only ever built from a field the read carried. */
export interface MoneyParam {
  readonly minor: number
  readonly currency: string
}
/** Words the API sends in both languages (what we asked of the customer). */
export interface LocalParam {
  readonly it: string
  readonly en: string
}
/** A language code, said as its name in the page's language. */
export interface LanguageParam {
  readonly language: string
}
export type Param = string | number | DayParam | MoneyParam | LocalParam | LanguageParam | Say

/** A catalogue's words: `key` of `parties`, or `<namespace>:<key>` of another catalogue (one word per thing: an existing word is reused). */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, Param>>
}
/** Text that is data (a name, a number, the hold's own words): said as it is. */
export interface Literal {
  readonly text: string
}
/** Parts said one after the other (words, a day, an amount per currency). */
export interface Joined {
  readonly join: readonly Param[]
  readonly with: string
}
export type Say = Words | Literal | Joined

export const say = (key: string, params?: Readonly<Record<string, Param>>): Words => (params ? { key, params } : { key })
export const text = (value: string): Literal => ({ text: value })
export const joined = (parts: readonly Param[], separator = ' · '): Joined => ({ join: parts, with: separator })
export const dayOf = (value: string): DayParam => ({ day: value })
export const amountOf = (minor: number, currency: string): MoneyParam => ({ minor, currency })
/** A day said alone (a value that is only its date). */
export const daySay = (value: string): Joined => joined([dayOf(value)], '')

/** The Overview's own new words (`parties.json` › `customers.overview.*`; 10-design §11). */
export const ov = (key: string, params?: Readonly<Record<string, Param>>): Words => say(`customers.overview.${key}`, params)
/** An existing word of the customer's depth catalogue (the hold, the credit, the promises). */
export const depth = (key: string, params?: Readonly<Record<string, Param>>): Words => say(`sales-customers-depth:${key}`, params)

/** What says the words: a translator over `<namespace>:<key>` (falling back to `parties`), the page's days and amounts. */
export interface SayTools {
  readonly locale: Locale
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly day: (value: string) => string
  readonly money: (minor: number, currency: string) => string
  readonly language: (code: string) => string
}

/** The page's way to say a day, an amount and a language, around a translator (the view's and the tests' one builder). */
export function sayToolsOf(locale: Locale, t: SayTools['t']): SayTools {
  return {
    locale,
    t,
    day: (value) => formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, { locale }),
    money: (minor, currency) => moneyText(minor, currency, locale),
    language: (code) => languageName(code, locale),
  }
}

function paramOf(param: Param, tools: SayTools): string | number {
  if (typeof param === 'string' || typeof param === 'number') return param
  if ('day' in param) return tools.day(param.day)
  if ('minor' in param) return tools.money(param.minor, param.currency)
  if ('it' in param) return param[tools.locale]
  if ('language' in param) return tools.language(param.language)
  return sayOf(param, tools)
}

/** The words as a person reads them. */
export function sayOf(words: Say, tools: SayTools): string {
  if ('text' in words) return words.text
  if ('join' in words) return words.join.map((part) => String(paramOf(part, tools))).join(words.with)
  if (!words.params) return tools.t(words.key)
  return tools.t(words.key, Object.fromEntries(Object.entries(words.params).map(([name, value]) => [name, paramOf(value, tools)])))
}

// ---- what the tab is given ---------------------------------------------------------------------------------------------------

/** What the reader may read and do here — each part and each act reads its OWN right (never a page-level "read only"). */
export interface OverviewCan {
  /** orders.view: the board (the standing, the band), the joined read. */
  readonly orders: boolean
  /** quotes.view or sales.inquiries.view: Quotes & incoming opens (every before-order door lands there). */
  readonly quotesTab: boolean
  /** The Money tab opens (money.price, receivables.view or sales.credit.view): the money doors. */
  readonly moneyTab: boolean
  /** receivables.view: Overdue, "Receivables & credit ›". */
  readonly receivables: boolean
  /** money.price: an amount is said only with it AND when the read carries the field (the money wall: web and server). */
  readonly price: boolean
  /** sales.returns.view · quality.complaints.view: the two after-sales kinds. */
  readonly returns: boolean
  readonly complaints: boolean
  /** partners.view: the Portal tab's door, what we asked of the customer, the customer's urgency. */
  readonly partners: boolean
  /** parties.manage: Edit, Add tax identity, Add address, Add contact. */
  readonly manage: boolean
  /** parties.block: the line that names the ⋯ menu's Unblock. */
  readonly block: boolean
  /** parties.vies: Check VIES. */
  readonly vies: boolean
  /** workorders.view: "Work orders of <customer> ›". */
  readonly workorders: boolean
}

/** The money reads the page already makes (../../money/hooks.ts), each under its own right. */
export interface OverviewMoney {
  readonly ageing: Loaded<AgeingRow>
  readonly returns: Loaded<CustomerReturn>
  readonly complaints: Loaded<CustomerComplaint>
  /** The open orders' deposits (orders.view); absent: not read here. */
  readonly orders: Loaded<OpenOrderMoney> | null
  /** The returns list with this customer (null: no such page). */
  readonly returnsHref: string | null
}

/** The customer's own urgency as its production limits say it (partners.view; office only). */
export type UrgencyState = ProductionLimitsView['urgency']

export interface OverviewInput {
  /** `/w/<company>`. */
  readonly prefix: string
  readonly party: Party
  readonly can: OverviewCan
  /** Today in Europe/Rome (`YYYY-MM-DD`). */
  readonly today: string
  /** The Work tab's five reads (use-customer-work.ts): the board, requests, replies, our asks, tasks. */
  readonly reads: WorkReads
  /** The page's ONE before-order count read (a part without its right is null: left out). */
  readonly counts: { readonly counts: BeforeOrderCountsAnswer | null; readonly failed: boolean }
  /** The customer at a glance (the screen's company): holds, credit, samples, repairs, riders, requirements, a rider's team. */
  readonly glance: GlanceRead<Glance>
  readonly money: OverviewMoney
  /**
   * The ONE read that joins on this tab (S11): THIS customer's row of GET /sales/orders/customers/work — the next promise over every
   * company, the last order, Priority Top / High, the customer-urgent count. `off`: no orders.view (never asked); ready with `null`:
   * the reader's orders do not reach the customer — ABSENT, never zeros.
   */
  readonly standing: Read<CustomerWork | null>
  /** `off`: not read on this tab (no partners.view). */
  readonly urgency: Read<UrgencyState>
  /** The party's projects (threads.read; null: not read or not readable). */
  readonly projects: { readonly open: number; readonly all: number } | null
  /** A VIES check runs now (its button is held with words). */
  readonly viesRunning: boolean
}

// ---- what the tab draws ------------------------------------------------------------------------------------------------------

/** The acts of the page the Overview's buttons run (the record's own commands and dialogs — never a copy). */
export type OverviewAct = 'edit' | 'identity' | 'correctIdentity' | 'checkVies' | 'retryGlance'
/** The Work tab's two windows (they open ON the Work tab: the page goes there first). */
export type OverviewWindow = 'customer' | 'tasks'

export type OverviewDoor = { readonly kind: 'href'; readonly href: string } | { readonly kind: 'window'; readonly window: OverviewWindow } | { readonly kind: 'act'; readonly act: OverviewAct }

/** A door or a button with its words. Not in the model at all when the reader lacks its right. */
export interface LabelledDoor {
  readonly key: string
  readonly label: Say
  /** Said "<label> ›" (the kit's own word): it leaves the card. */
  readonly arrow: boolean
  readonly door: OverviewDoor
  /** Held by STATE, in words (archived, a check running); null: it runs. */
  readonly held: Say | null
}

/** A door that leaves the card for the place it names ("Money ›"). */
export const linkDoor = (key: string, label: Say, href: string): LabelledDoor => ({ key, label, arrow: true, door: { kind: 'href', href }, held: null })
/** A step's button (today's own dialog, command or page), held by state with words. */
export const stepDoor = (key: string, label: Say, door: OverviewDoor, held: Say | null = null): LabelledDoor => ({ key, label, arrow: false, door, held })

/** The ladder's line that says the standing (10-design §2.1). */
export type StandingLine = 'ARCHIVED' | 'BLOCKED' | 'ON_HOLD' | 'PROSPECT' | 'NO_ORDER' | 'NO_OPEN' | 'OPEN' | 'STATUS'

export interface OverviewHeadline {
  /** null: still read (a skeleton line); else the parts, joined by " · " (four at most). */
  readonly sentence: readonly Say[] | null
  readonly quiet: Say | null
  readonly line: StandingLine | null
}

export type StripKind = 'blocked' | 'hold' | 'credit' | 'invoice' | 'vies' | 'overdue' | 'orderWaits' | 'urgency'
export type StripTone = 'danger' | 'warning' | 'info'

export interface OverviewStrip {
  readonly key: string
  readonly kind: StripKind
  readonly tone: StripTone
  readonly title: Say
  /** Since when (an instant); null: no age. */
  readonly since: string | null
  readonly lines: readonly Say[]
  readonly doors: readonly LabelledDoor[]
}

export interface OverviewStrips {
  /** Most blocking first. */
  readonly rows: readonly OverviewStrip[]
  /** The glance still reads: one quiet row under the strips the party already gives. */
  readonly reading: boolean
  /** The glance could not be read: a hold never goes silent. */
  readonly failed: Say | null
}

/** A part of a row's value: plain words, or words that are a door. */
export interface RowPart {
  readonly say: Say
  readonly door?: OverviewDoor
  /** Quiet words inside the value. */
  readonly quiet?: boolean
}
export interface RowTag {
  readonly say: Say
  readonly tone: 'danger' | 'warning' | 'neutral'
}

/** One row of People, Next dates or Linked records: label · value · its own buttons. */
export interface OverviewRow {
  readonly key: string
  readonly label: Say
  /** The value's parts, joined by " · ". */
  readonly parts: readonly RowPart[]
  readonly tag?: RowTag
  /** Quiet lines under the value. */
  readonly under?: readonly Say[]
  readonly doors?: readonly LabelledDoor[]
  /** The value is still read (a skeleton) or could not be read ("Could not be read"). */
  readonly state?: 'reading' | 'unread'
}

export interface PeopleCard {
  readonly rows: readonly OverviewRow[]
  /** "People & addresses ›" in the card's head. */
  readonly head: LabelledDoor
}

export interface DatesCard {
  readonly rows: readonly OverviewRow[]
  /** No row yet and a read still out: a skeleton. */
  readonly reading: boolean
  /** The glance failed: its rows are left out and this line says so, with Try again. */
  readonly failed: Say | null
}

export interface RequestRow {
  readonly key: string
  readonly words: Say
  /** As drawn: "2", "100+". */
  readonly count: string
  /** The oldest one's start (its age); null: no age. */
  readonly since: string | null
  readonly door: LabelledDoor | null
}
export interface RequestGroup {
  readonly key: 'us' | 'them' | 'tasks'
  readonly title: Say
  /** The group's rows added up, as drawn ("4", "100+"). */
  readonly count: string
  readonly rows: readonly RequestRow[]
}
export interface RequestsCard {
  readonly state: 'ready' | 'reading' | 'failed'
  readonly groups: readonly RequestGroup[]
}

export interface LinkedCard {
  readonly rows: readonly OverviewRow[]
  /** The kinds with nothing ("None yet: Returns · Complaints"). */
  readonly none: readonly Say[]
  /** Plain doors with no count read ("Work orders of <customer> ›", "Receivables & credit ›"). */
  readonly quiet: readonly LabelledDoor[]
}

export interface FactRow {
  readonly key: string
  readonly label: Say
  /** A tag beside the label ("Only the office sees it"). */
  readonly labelTag?: Say
  readonly parts: readonly RowPart[]
  readonly under?: readonly Say[]
  /** The whole row (a warning to complete, the office note). */
  readonly wide?: boolean
  /** Quiet words (no note, no requirement). */
  readonly empty?: boolean
  readonly door?: LabelledDoor
}
export interface FactsCard {
  readonly rows: readonly FactRow[]
  /** The ONE Edit of the head (parties.manage; absent without). */
  readonly edit: LabelledDoor | null
}

/** Card 2: the Work tab's band; `none`: no order at all (one quiet line + the "Before an order" doors); `off`: no orders.view. */
export type BandState = 'off' | 'band' | 'none'

export interface CustomerOverviewModel {
  readonly customer: string
  readonly headline: OverviewHeadline
  readonly strips: OverviewStrips
  readonly band: BandState
  readonly people: PeopleCard
  /** null: no date at all — the card is LEFT OUT and People takes the row (S24). */
  readonly dates: DatesCard | null
  /** null: nothing waits — the card is LEFT OUT and Linked records takes the row (S24). */
  readonly requests: RequestsCard | null
  readonly linked: LinkedCard
  readonly facts: FactsCard
}

// ---- small readers shared by the rules ---------------------------------------------------------------------------------------

/** A read's value once it is in; null otherwise (reading, failed, off). */
export const readyOf = <T>(read: Read<T>): T | null => (read.status === 'ready' ? read.value : null)
/** The glance once it is in. */
export const glanceOf = (read: GlanceRead<Glance>): Glance | null => (read.status === 'ready' ? read.value : null)

/**
 * S11: THIS customer's row of the joined read (the Customers list's own hook, asked for ONE id — only on the Overview, only with
 * orders.view). `off`: never asked; ready with null: the answer holds no row for this customer (the reader's orders do not reach
 * it) — ABSENT, never zeros. Only this id's row is ever read.
 */
export function standingOf(enabled: boolean, work: Pick<CustomersWorkModel, 'byParty' | 'problem'>, partyId: string): Read<CustomerWork | null> {
  if (!enabled) return { status: 'off' }
  if (work.byParty) return { status: 'ready', value: work.byParty.get(partyId) ?? null }
  return work.problem ? { status: 'failed' } : { status: 'reading' }
}

/** Whole days from one calendar day to another (`YYYY-MM-DD`; an instant counts by its day): negative when `to` is before `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / 86_400_000)
}
