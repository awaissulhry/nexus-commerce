import { BEFORE_ORDER_GROUPS, CLOSED_GROUPS, INCOMING_TILE_OF, LIVE_GROUPS, QUOTE_GROUP_TERMS, type BeforeOrderGroup, type QuoteGroupTerm } from '@nexus/factory-domain/sales/before-order/groups'
import type { BeforeOrderCountsAnswer } from '@nexus/factory-domain/sales/before-order/contracts'
import type { IncomingTile } from '@nexus/factory-domain/sales/incoming/rules'

/**
 * F-CQ-101 (customer page › Quotes & incoming, 10-design §2; 13-backend ★(1), §11 rows 1–2; settles C3, C8, C20, C25, C26, C34,
 * C35) — the band "Before an order · <customer>", pure: the counts (GET /sales/before-order/counts: one read) → the doors in life
 * order (the six live groups, then Won · Moved to a quote · Lost apart and quiet), each a door `?tab=quotes&group=<G>` that filters the
 * lists below to exactly the rows it counts; the page term `group` → each list's own term (the quotes' `group`, Incoming's saved row,
 * the drafts); what each section says in its head. A group the reader holds no right of is LEFT OUT (the server's null), never 0; a 0
 * stays a quiet 0 (the band keeps its shape). No amount, no person: numbers of records only.
 *
 *   door              Requests & portal orders     Quotes                drafts (W1: Work › "Drafts of <customer>")
 *   (none)            Open                         LIVE ("Not closed")   —
 *   WRITING           folded                       folded                the drafts
 *   TO_ANSWER         To answer                    folded                —
 *   PREPARING         folded                       PREPARING             —
 *   APPROVAL          folded                       APPROVAL              —
 *   WAITING_CUSTOMER  Need info                    WAITING_CUSTOMER      —
 *   ORDER_WAITS       folded                       ORDER_WAITS           —
 *   WON               Ordered                      WON                   —
 *   MOVED             Quoted                       folded                —
 *   LOST              Ended                        LOST                  —
 *   OPEN_QUOTES       folded                       OPEN_QUOTES           —
 */

/** The page term of a door (`?group=`), agreed with the Work and Customers list lanes: FIXED. */
export const GROUP_TERM = 'group'

/** Every door the page opens: the nine groups and the set OPEN_QUOTES (Overview's "Open quotes", the Work line's). */
export const DOORS = [...BEFORE_ORDER_GROUPS, 'OPEN_QUOTES'] as const
export type Door = (typeof DOORS)[number]

/** The door an address opens (anything else: none — the lists open on their live rows). */
export function doorOf(params: { get(name: string): string | null } | null): Door | null {
  const value = params?.get(GROUP_TERM) ?? null
  return value !== null && (DOORS as readonly string[]).includes(value) ? (value as Door) : null
}

/** What the reader may read on this tab (each kind its OWN right, as the lists and the counts read them). */
export interface TabRights {
  /** quotes.view: the Quotes section, its groups. */
  readonly quotes: boolean
  /** sales.inquiries.view: the Requests & portal orders section, its groups. */
  readonly requests: boolean
  /** orders.view: the customer's portal drafts (Customer is writing). */
  readonly drafts: boolean
  /** sales.samples.view: the sample rounds' quiet line. */
  readonly samples: boolean
  /** quotes.manage: "New quote for <customer>…". */
  readonly newQuote: boolean
  /** sales.inquiries.manage: "New request for <customer>…". */
  readonly newRequest: boolean
}

export function tabRightsOf(permissions: readonly string[]): TabRights {
  const held = new Set(permissions)
  return {
    quotes: held.has('quotes.view'),
    requests: held.has('sales.inquiries.view'),
    drafts: held.has('orders.view'),
    samples: held.has('sales.samples.view'),
    newQuote: held.has('quotes.manage'),
    newRequest: held.has('sales.inquiries.manage'),
  }
}

/** The groups each section of the tab can show (a group no section of this reader shows is left out of the band, C35). */
const QUOTE_ONLY: readonly BeforeOrderGroup[] = ['PREPARING', 'APPROVAL', 'ORDER_WAITS']
const REQUEST_ONLY: readonly BeforeOrderGroup[] = ['TO_ANSWER', 'MOVED']
/** The two groups that wait on US: their count in an amber pill when > 0 (words say it too). */
export const WAITS_ON_US: readonly BeforeOrderGroup[] = ['TO_ANSWER', 'ORDER_WAITS']

/** Whether the reader's sections can show a group at all (else it is left out, whatever the count says). */
export function groupShown(group: BeforeOrderGroup, rights: Pick<TabRights, 'quotes' | 'requests' | 'drafts'>): boolean {
  if (group === 'WRITING') return rights.drafts
  if (QUOTE_ONLY.includes(group)) return rights.quotes
  if (REQUEST_ONLY.includes(group)) return rights.requests
  return rights.quotes || rights.requests
}

/** One door of the band. */
export interface BandDoor {
  readonly group: BeforeOrderGroup
  readonly count: number
  /** It waits on us (amber when > 0). */
  readonly ours: boolean
  /** The door the lists show now (pressed again, or ✕: everything). */
  readonly active: boolean
}

export interface Band {
  /** The live groups in life order (the pipeline). */
  readonly live: readonly BandDoor[]
  /** Won · Moved to a quote · Lost, apart and quiet. */
  readonly closed: readonly BandDoor[]
  /** The sample rounds in progress (the quiet second line), or null: not shown (no right, or none). */
  readonly samples: number | null
  /** Every record the band counts (0: the customer has nothing before an order yet). */
  readonly total: number
}

/** The band from the counts: a group the server left out (null) or the reader's sections cannot show is not drawn; 0 stays 0. */
export function bandOf(counts: Pick<BeforeOrderCountsAnswer, 'groups' | 'sampleRounds'> | null, rights: Pick<TabRights, 'quotes' | 'requests' | 'drafts' | 'samples'>, door: Door | null): Band | null {
  if (!counts) return null
  const doorOfGroup = (group: BeforeOrderGroup): BandDoor | null => {
    const count = counts.groups[group]
    if (count === null || !groupShown(group, rights)) return null
    return { group, count, ours: WAITS_ON_US.includes(group), active: door === group }
  }
  const live = LIVE_GROUPS.map(doorOfGroup).filter((entry): entry is BandDoor => entry !== null)
  const closed = CLOSED_GROUPS.map(doorOfGroup).filter((entry): entry is BandDoor => entry !== null)
  const samples = rights.samples && counts.sampleRounds !== null && counts.sampleRounds > 0 ? counts.sampleRounds : null
  return { live, closed, samples, total: [...live, ...closed].reduce((sum, entry) => sum + entry.count, 0) }
}

/** The count a door opens (the band's own number; OPEN_QUOTES = the open quotes). null: not known (not read, or left out). */
export function doorCount(counts: Pick<BeforeOrderCountsAnswer, 'groups' | 'openQuotes'> | null, door: Door): number | null {
  if (!counts) return null
  return door === 'OPEN_QUOTES' ? counts.openQuotes : counts.groups[door]
}

/** Each list's terms under a door: null = the section folds to one quiet line ("No … in this group."). */
export interface DoorTerms {
  readonly quotes: QuoteGroupTerm | null
  readonly incoming: IncomingTile | null
  /** The drafts show (only WRITING; W1: the door opens Work › "Drafts of <customer>", their home today). */
  readonly drafts: boolean
}

/** No door: the lists open on their live rows (quotes "Not closed" = LIVE; Incoming's Open). */
export const NO_DOOR: DoorTerms = Object.freeze({ quotes: 'LIVE', incoming: 'OPEN', drafts: false })

/** The lists' terms of a door — the quotes' `group` term, Incoming's saved row (INCOMING_TILE_OF: the server's one map), the drafts. */
export function termsOfDoor(door: Door | null): DoorTerms {
  if (door === null) return NO_DOOR
  const quotes = (QUOTE_GROUP_TERMS as readonly string[]).includes(door) ? (door as QuoteGroupTerm) : null
  const tiles: Readonly<Partial<Record<Door, IncomingTile>>> = INCOMING_TILE_OF
  return { quotes, incoming: tiles[door] ?? null, drafts: door === 'WRITING' }
}

/** The page's address with a door (or none: ✕, the same door again): the page's other terms (tab, dock) stay. */
export function doorAddress(base: string, params: { toString(): string } | null, door: Door | null): string {
  const query = new URLSearchParams(params?.toString() ?? '')
  query.set('tab', 'quotes')
  if (door) query.set(GROUP_TERM, door)
  else query.delete(GROUP_TERM)
  return `${base}?${query.toString()}`
}

/** A door's click: the door, or none when it is the open one (pressed again shows everything). */
export const toggledDoor = (open: Door | null, clicked: Door): Door | null => (open === clicked ? null : clicked)

// ---- the sections' heads (10-design §3.1): a quiet count that never hides a record ----

/** A section's words (`before-order` catalogue) with their parameters. */
export interface TabWords {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** What each kind counts, from the counts' `byKind` (null: the reader holds no right of it). */
export interface KindCounts {
  readonly open: number
  readonly closed: number
}

/** The quotes' live (not closed) and closed numbers; null without quotes.view. */
export function quoteCountsOf(counts: Pick<BeforeOrderCountsAnswer, 'byKind'> | null): KindCounts | null {
  const quotes = counts?.byKind.quotes ?? null
  if (!quotes) return null
  return { open: quotes.PREPARING + quotes.APPROVAL + quotes.WAITING_CUSTOMER + quotes.ORDER_WAITS, closed: quotes.WON + quotes.LOST }
}

/** The requests' and portal orders' open and closed numbers (the portal orders only as the reader may read them, C20). */
export function incomingCountsOf(counts: Pick<BeforeOrderCountsAnswer, 'byKind'> | null): KindCounts | null {
  const requests = counts?.byKind.requests ?? null
  if (!requests) return null
  const portal = counts?.byKind.portalOrders ?? null
  return {
    open: requests.TO_ANSWER + requests.WAITING_CUSTOMER + (portal?.TO_ANSWER ?? 0),
    closed: requests.WON + requests.MOVED + requests.LOST + (portal ? portal.WON + portal.MOVED + portal.LOST : 0),
  }
}

/** The closed groups of one kind, each a door (the foot "Closed ones are left out (7): Won 2 · Moved to a quote 3 · Lost 2"). */
export function closedDoorsOf(counts: Pick<BeforeOrderCountsAnswer, 'byKind'> | null, kind: 'quotes' | 'incoming'): ReadonlyArray<{ readonly group: BeforeOrderGroup; readonly count: number }> {
  if (!counts) return []
  if (kind === 'quotes') {
    const quotes = counts.byKind.quotes
    return quotes ? (['WON', 'LOST'] as const).map((group) => ({ group, count: quotes[group] })).filter((entry) => entry.count > 0) : []
  }
  const requests = counts.byKind.requests
  if (!requests) return []
  const portal = counts.byKind.portalOrders
  return (['WON', 'MOVED', 'LOST'] as const).map((group) => ({ group, count: requests[group] + (portal ? portal[group] : 0) })).filter((entry) => entry.count > 0)
}

/** How one section stands under the door: the list, folded (the door holds none of its kind), none at all, or only closed ones. */
export type SectionState = 'list' | 'folded' | 'none' | 'onlyClosed'

/** A section's state (the list stays the judge while the counts are not read: null counts draw the list). */
export function sectionStateOf(kind: KindCounts | null, folded: boolean, door: Door | null): SectionState {
  if (folded) return 'folded'
  if (!kind) return 'list'
  if (kind.open + kind.closed === 0) return 'none'
  if (door === null && kind.open === 0) return 'onlyClosed'
  return 'list'
}

/** The quiet count of a section head: "4 open · 7 closed left out", "3 in “To answer”", "11, every state". */
export function sectionCountOf(kind: KindCounts | null, section: 'quotes' | 'incoming', door: Door | null, inDoor: number | null, groupWords: string | null): TabWords | null {
  if (!kind) return null
  if (door !== null) return inDoor === null || groupWords === null ? null : { key: 'sec.countGroup', params: { count: inDoor, group: groupWords } }
  return { key: section === 'quotes' ? 'sec.countNotClosed' : 'sec.countOpen', params: { open: kind.open, closed: kind.closed } }
}

/** The live re-read: the events that move a count (a draft's change too: it is counted in WRITING). */
export const COUNTS_EVENTS = /^(quote\.|inquiry\.|portal_order_request\.)/

/**
 * Whether a live change moves this customer's counts: a quote, a request, a portal order (its draft too). A message that names a
 * customer counts only when it is this one (a quote's message names none: it is read again, coalesced).
 */
export function countsMoved(change: { readonly type: string; readonly fields: Readonly<Record<string, unknown>> }, partyId: string): boolean {
  if (!COUNTS_EVENTS.test(change.type)) return false
  const party = change.fields.partyId
  return typeof party !== 'string' || party === partyId
}

/** The coalescing wait of the live re-read (the Work strip's and the lists' time). */
export const COUNTS_WAIT_MS = 800

/** F-CQ-104 (P0-B5): each list's own working layout on this tab (Sales › Quotes / Sales › Incoming keep theirs). */
export const QUOTES_LAYOUT_KEY = 'sales.quotes:customer-quotes'
export const INQUIRIES_LAYOUT_KEY = 'sales.inquiries:customer-quotes'
/** F-CQ-103: the kinds on this tab — requests and portal orders (a change request changes a confirmed order: it is answered there). */
export const TAB_KINDS = Object.freeze(['REQUEST', 'CATALOGUE_ORDER'] as const)

/** F-CQ-101: one section's own number under a door (a mixed group counts each kind apart: the head says what ITS list shows). */
export function kindDoorCount(counts: Pick<BeforeOrderCountsAnswer, 'byKind' | 'openQuotes'> | null, kind: 'quotes' | 'incoming', door: Door): number | null {
  if (!counts) return null
  if (kind === 'quotes') {
    const quotes = counts.byKind.quotes
    if (!quotes) return null
    if (door === 'OPEN_QUOTES') return counts.openQuotes
    return door in quotes ? quotes[door as keyof typeof quotes] : null
  }
  const requests = counts.byKind.requests
  if (!requests) return null
  const portal = counts.byKind.portalOrders
  const mine = door in requests ? requests[door as keyof typeof requests] : null
  const theirs = portal && door in portal ? portal[door as keyof typeof portal] : null
  return mine === null && theirs === null ? null : (mine ?? 0) + (theirs ?? 0)
}
