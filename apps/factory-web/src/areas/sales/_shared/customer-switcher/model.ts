/**
 * F-SA-224 (sales page plan N5, pick P18; 12-lists-board §5 rule 4): ONE customer filter for every Sales list — the Customer
 * switcher of the Orders sheet (B-TH-226, moved here from areas/sales/orders/list/sheet), one address term `?party=`. Orders reads
 * the reader's customers with their open and late orders (GET /sales/orders/customers, searched on the server); Quotes, Incoming
 * and Made-to-measure › Riders read the names only (GET /parties?role=CUSTOMER, searched in the page: `localSwitcherState`) — no
 * number rather than a wrong one, until each list has a count read of its own. Names come only from walled reads: a reader limited
 * to some customers sees their own, a reader limited to one a fixed label. Pure: no fetching, no React.
 */

/** Words of the switcher: keys of the `orders-sheet` catalogue (`switcher.*`) with their values. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A customer of the switcher: its name; on Orders its open and late orders too. */
export interface SwitcherCustomer {
  readonly id: string
  readonly name: string
  readonly code?: string
  readonly archived?: boolean
  readonly open?: number
  readonly late?: number
}

export interface SwitcherState<C extends SwitcherCustomer = SwitcherCustomer> {
  /** The first page of the reader's customers (Orders: recent first); null while read. */
  readonly customers: readonly C[] | null
  /** How many customers match the search (or in all, unsearched). */
  readonly total: number
  /** Every grant of the reader's right names its customers. */
  readonly limited: boolean
  readonly problem: string | null
}

/**
 * The switcher's face: hidden while there is no customer yet; a fixed label for a reader limited to one customer; else the
 * button with the customer chosen, "All my customers (n)" for a limited reader, "All customers" for the rest.
 */
export type SwitcherFace = { readonly kind: 'hidden' } | { readonly kind: 'fixed'; readonly name: string } | { readonly kind: 'button'; readonly label: Phrase }

export function switcherFace(state: SwitcherState, party: string | null, partyName: string | null | undefined): SwitcherFace {
  const customers = state.customers
  if (customers && state.limited && state.total === 1 && customers.length === 1 && (!party || party === customers[0]!.id)) return { kind: 'fixed', name: customers[0]!.name }
  if (party) {
    const known = customers?.find((customer) => customer.id === party)?.name ?? partyName
    return { kind: 'button', label: known === null ? { key: 'switcher.unknown' } : known === undefined ? { key: 'switcher.reading' } : { key: 'switcher.chosen', params: { name: known } } }
  }
  if (customers && customers.length === 0 && state.total === 0 && !state.problem) return { kind: 'hidden' }
  return { kind: 'button', label: state.limited ? { key: 'switcher.allMine', params: { count: state.total } } : { key: 'switcher.all' } }
}

export interface SwitcherLine {
  readonly value: string
  readonly label: string
  readonly group?: string
  readonly open?: number
  readonly late?: number
  readonly archived?: boolean
}

/**
 * The switcher's lines: unsearched, "All customers" (or "All my customers (n)") on top, then the `recent` most recent customers
 * (Orders: 2), then the others by name; searched, the matches in their order. Each customer once.
 */
export function switcherLines(customers: readonly SwitcherCustomer[], searched: boolean, words: { all: string; recent: string; others: string }, recent = 2): SwitcherLine[] {
  const line = (customer: SwitcherCustomer, group?: string): SwitcherLine => ({ value: customer.id, label: customer.name, ...(group ? { group } : {}), ...(customer.open !== undefined ? { open: customer.open } : {}), ...(customer.late !== undefined ? { late: customer.late } : {}), ...(customer.archived ? { archived: true } : {}) })
  if (searched) return customers.map((customer) => line(customer))
  const first = customers.slice(0, recent)
  const rest = customers.slice(recent).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return [{ value: '', label: words.all }, ...first.map((customer) => line(customer, words.recent)), ...rest.map((customer) => line(customer, words.others))]
}

/**
 * A names-only list's switcher state (Quotes, Incoming, Riders): the customers it read (null while read), searched here by name or
 * code (the page holds at most the read's page), never limited (the read does not say so: no "All my customers (n)").
 */
export function localSwitcherState(all: readonly SwitcherCustomer[] | null, query: string, problem: string | null = null): SwitcherState {
  if (all === null) return { customers: problem ? [] : null, total: 0, limited: false, problem }
  const words = query.trim().toLowerCase()
  const customers = words ? all.filter((customer) => customer.name.toLowerCase().includes(words) || (customer.code ?? '').toLowerCase().includes(words)) : all
  return { customers, total: customers.length, limited: false, problem }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The one customer term of an address: `?party=` (an id), else the old `?customer=` of a list that used it (its links keep working). */
export function partyOfAddress(params: { get(name: string): string | null } | null | undefined, legacy?: string): string | null {
  for (const name of ['party', ...(legacy ? [legacy] : [])]) {
    const value = params?.get(name)?.trim() ?? ''
    if (UUID.test(value)) return value.toLowerCase()
  }
  return null
}
