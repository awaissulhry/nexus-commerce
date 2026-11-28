/**
 * owb-of5 step 1 (design plan § 5p point 2 "Back goes where you came from") — the band's Back SAYS where it goes ("‹ Orders",
 * "‹ Seed Racing", "‹ Design desk") and goes there, on the tab the person was on. Pure: the page before this one in the tab's own
 * history (use-back.ts reads it) → the place to go back to; nothing before (a link from outside, a new tab) → null, and the page's
 * band keeps its list ("‹ Orders"). A change of tab on the same page is not a step: entries of this same record are skipped.
 */

/** Where Back goes: the address (path + search, the tab kept), what it is, and the name a customer page carries. */
export interface BackPlace {
  readonly href: string
  readonly kind: BackKind
  /** The customer's name when the place is this order's customer page (else absent: the kind's word says it). */
  readonly name?: string
}

export const BACK_KINDS = ['orders', 'customer', 'customers', 'designDesk', 'incoming', 'readyToShip', 'today', 'order', 'page'] as const
export type BackKind = (typeof BACK_KINDS)[number]

export interface BackInput {
  /** The office prefix of the page (`/w/<company>`). */
  readonly prefix: string
  /** This record's own path (`/w/<company>/sales/orders/<id>`): an entry of the same path is a change of tab, never a step back. */
  readonly here: string
  /** The order's customer: a step back to ITS page says its name. */
  readonly customer?: { readonly id: string; readonly name: string } | null
}

/** The page parts this band names (after the prefix); anything else of the office is "Back" (still the right address). */
const PLACES: readonly { readonly test: RegExp; readonly kind: BackKind }[] = [
  { test: /^\/sales\/orders\/?$/, kind: 'orders' },
  { test: /^\/sales\/orders\/[^/]+\/?$/, kind: 'order' },
  { test: /^\/sales\/customers\/?$/, kind: 'customers' },
  { test: /^\/sales\/customers\/[^/]+\/?$/, kind: 'customer' },
  { test: /^\/home\/design-desk\/?$/, kind: 'designDesk' },
  { test: /^\/sales\/incoming(?:\/.*)?$/, kind: 'incoming' },
  { test: /^\/warehouse\/ready-to-ship\/?$/, kind: 'readyToShip' },
  { test: /^\/home\/today\/?$/, kind: 'today' },
]

/**
 * The place to go back to among `previous` (newest first, absolute or root-relative addresses): the first one that is not this same
 * record and lies inside this office (`prefix`); null when none does.
 */
export function backPlaceOf(previous: readonly (string | null | undefined)[], input: BackInput): BackPlace | null {
  for (const raw of previous) {
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw, 'http://office.invalid')
    } catch {
      continue
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path === input.here.replace(/\/+$/, '')) continue // a change of tab on this same page is not a step
    if (!path.startsWith(`${input.prefix}/`)) return null // another company, the portal, outside: the band's list
    const rest = path.slice(input.prefix.length)
    const href = `${path}${url.search}`
    const place = PLACES.find((entry) => entry.test.test(rest))
    if (!place) return { href, kind: 'page' }
    if (place.kind === 'customer') {
      const id = decodeURIComponent(rest.split('/')[3] ?? '')
      return input.customer && id === input.customer.id ? { href, kind: 'customer', name: input.customer.name } : { href, kind: 'customers' }
    }
    return { href, kind: place.kind }
  }
  return null
}
