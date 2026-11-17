import { EVERY_PARTY_WORDS } from '@nexus/factory-domain/core/permissions'
import { isApiError } from '../../../../lib/api/errors'
import { splitOfficePath } from '../../../../lib/session/session'

/**
 * F-PR-02 — the ONE customer filter of the Production pages, without a screen (production plan §5, 06-tree A.0: "One customer
 * filter, address key carried between Floor now and every production list; its options are the customers in the person's
 * scope only"; L27: office screens say "Customer"). The address key is `?party=` (the work orders file reads the same key,
 * B-PR-03, so an export follows the screen); the API filter is `partyId`. The options come from GET /production/customers
 * for the page's own permission: never a customer the person cannot reach (Owner rule 2026-11-16, the brand wall).
 *
 * A Customer cell names the customer (the reader with `parties.view`, 11-10 Q2) or its code (anyone else, L13); shared
 * floor surfaces (Dispatch, Bundles) say the code only. A view that adds up every customer and is refused to a person limited
 * to some (403 in the API's EVERY_PARTY words, B-PR-07) is said in our words, never drawn as an empty table.
 */

/** The address key every production page reads and carries. */
export const PARTY_KEY = 'party'

/**
 * The production pages that take the filter (company-free paths); a move between two of them keeps it. Work orders joins
 * when its list reads `?party=` (F-PR-03): its export already does, so carrying it there first would narrow the file only.
 */
export const CUSTOMER_PAGES = [
  '/production/cutting',
  '/production/bundles',
  '/production/scrap',
  '/production/calls',
  '/production/instructions',
  '/production/reports',
  '/production/dispatch',
] as const

/** The API's page names (GET /production/customers?view=). */
export type CustomerView = 'floor' | 'work-orders' | 'cutting' | 'bundles' | 'scrap' | 'calls' | 'instructions' | 'reports' | 'dispatch'

export interface CustomerOption {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** A row's customer as the API sends it (null: none), with the flag of a work order made before the one-customer rule. */
export interface RowCustomer {
  readonly customer?: CustomerOption | null | undefined
  readonly mixedCustomers?: boolean | undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Params {
  get(name: string): string | null
}

/** The customer the address narrows to (`?party=`, an id only; anything else: every customer). */
export function partyOf(params: Params | null | undefined): string | null {
  const value = params?.get(PARTY_KEY)?.trim() ?? ''
  return UUID.test(value) ? value.toLowerCase() : null
}

/** A page address's customer term: `{ party }` when the address names one, else nothing (every customer). */
export function partyTerm(params: Params | null | undefined): { readonly party?: string } {
  const party = partyOf(params)
  return party ? { party } : {}
}

/** An address with the customer set (or taken away), every other term kept. */
export function withParty(href: string, party: string | null): string {
  const hash = href.indexOf('#')
  const base = hash >= 0 ? href.slice(0, hash) : href
  const fragment = hash >= 0 ? href.slice(hash) : ''
  const query = base.indexOf('?')
  const path = query >= 0 ? base.slice(0, query) : base
  const params = new URLSearchParams(query >= 0 ? base.slice(query + 1) : '')
  if (party) params.set(PARTY_KEY, party)
  else params.delete(PARTY_KEY)
  const text = params.toString()
  return `${path}${text ? `?${text}` : ''}${fragment}`
}

const pathOf = (href: string): string => {
  const plain = href.split(/[?#]/)[0] ?? ''
  const { company, path } = splitOfficePath(plain)
  return (company !== null ? path : plain).replace(/(.)\/+$/, '$1')
}

/** Whether a (company-free or full) address is a production page that takes the filter (a page, not a record under it). */
export function takesParty(href: string): boolean {
  return (CUSTOMER_PAGES as readonly string[]).includes(pathOf(href))
}

/**
 * Where a move goes with the filter carried: from a production page narrowed to a customer to another production page that
 * takes it (and names no customer of its own), the same `?party=`. Anything else goes as it was.
 */
export function carryParty(href: string, currentPath: string, current: Params | null | undefined): string {
  const party = partyOf(current)
  if (!party || !takesParty(currentPath) || !takesParty(href)) return href
  const query = href.indexOf('?')
  if (query >= 0 && new URLSearchParams(href.slice(query + 1).split('#')[0]).has(PARTY_KEY)) return href
  return withParty(href, party)
}

/** What a Customer cell says: the name (with `parties.view`) or the code; a work order made before the rule; none: null. */
export function customerText(row: RowCustomer, names: boolean): { readonly text: string; readonly mixed: boolean } | null {
  if (row.customer) return { text: names ? row.customer.name : row.customer.code, mixed: false }
  return row.mixedCustomers ? { text: '', mixed: true } : null
}

/** Several customers (a cut order of two): their names or codes, in order; none: null. */
export function customersText(customers: readonly CustomerOption[] | null | undefined, names: boolean): string | null {
  if (!customers || customers.length === 0) return null
  return customers.map((customer) => (names ? customer.name : customer.code)).join(', ')
}

/** The filter's state for the page: the options read, the one picked, and whether the picked one is in them. */
export interface CustomerFilterState {
  /** The customers the person may pick (null: not read yet, or the read failed). */
  readonly options: readonly CustomerOption[] | null
  /** The customer the address names (null: every customer). */
  readonly party: string | null
  /** Whether the person reaches every customer with this page's permission (null: not known yet). */
  readonly everyCustomer: boolean | null
  /** Whether a customer cell names the customer (parties.view) rather than its code. */
  readonly names: boolean
}

/**
 * The filter's choices: "All customers" (or "All my customers" for a person limited to some), then each customer; a customer
 * in the address that is not among them (an old link, or one the person may not see) is "Not in your customers" — the same
 * words for both, so nothing says another customer exists.
 */
export function filterChoices(state: CustomerFilterState): { readonly value: string; readonly label: string | null; readonly key: 'all' | 'allMine' | 'unknown' | null }[] {
  const all = { value: '', label: null, key: state.everyCustomer === false ? ('allMine' as const) : ('all' as const) }
  const options = state.options ?? []
  const listed = options.map((option) => ({ value: option.id, label: state.names ? option.name : option.code, key: null }))
  const unknown = state.party && state.options !== null && !options.some((option) => option.id === state.party) ? [{ value: state.party, label: null, key: 'unknown' as const }] : []
  return [all, ...unknown, ...listed]
}

/** The filter's name for the page's words ("Customer: Brand Alpha"): the picked customer's, or null for every customer. */
export function pickedLabel(state: CustomerFilterState): string | null {
  if (!state.party) return null
  const option = state.options?.find((entry) => entry.id === state.party)
  return option ? (state.names ? option.name : option.code) : null
}

/**
 * Whether an answer is the refusal of a view that adds up every customer (403 in the API's EVERY_PARTY words, B-PR-02/07):
 * the page then says so in its own words instead of an empty table or a generic "no right".
 */
export function isEveryCustomerRefusal(error: unknown): boolean {
  return isApiError(error) && error.status === 403 && (error.message === EVERY_PARTY_WORDS.en || error.message === EVERY_PARTY_WORDS.it)
}
