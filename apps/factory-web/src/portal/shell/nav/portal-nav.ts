import { Archive, Calculator, ClipboardList, FileText, Home, IdCard, Package, RotateCcw, ShoppingBag, Truck, UserRound, type LucideIcon } from 'lucide-react'
import { areaNavForPerson, findAreaNavPlace, type AreaNav, type AreaNavArea, type AreaNavItem, type AreaNavSection } from '@nexus/ui/patterns/shell/index'

/**
 * The Portal navigation (B-W2b-173; design portal.frame › rail, bottom-bar, band; the views' `portal` areas) — THE merge point
 * of every portal page: a step that builds a page sets its `built` here (and a record page its line in RECORD_PAGES), nothing
 * else. Addresses are the portal's own, without `/p/<party code>` (the frame adds it).
 *
 *   Customer       Home · Orders (Orders & tracking, New order & reorder) · Quotes & samples (Quotes & requests, Catalogue)
 *                  · Documents · Returns & claims · Account
 *   Supplier       Home · Orders & jobs (Purchase orders for a supplier, Jobs for a workshop) · Deliveries · Documents · Profile
 *   Subcontractor  Home · Jobs · Documents · Profile
 *   Guest          Home · Accounting (the accountant) · Audit room (an auditor)
 *
 * It FAILS CLOSED (the DS's `areaNavForPerson`, view `portal`): an area or page shows only to the partner kinds it names and
 * only with its permission, and only once it is BUILT — navigation never shows a door that leads nowhere. An area whose
 * person keeps one page of several takes that page's name and address ("Orders & jobs" is "Jobs" for a workshop). Labels
 * are `portal` message keys (`translatePortalNav`). Each area names the rail badge it carries: the area of the one task
 * list (factory-domain portal/tasks/kinds.ts PORTAL_AREAS), so the rail, the bottom bar and Home count the same requests.
 */

export const PORTAL_KINDS = ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const
export type PortalKind = (typeof PORTAL_KINDS)[number]
export const isPortalKind = (value: unknown): value is PortalKind => typeof value === 'string' && (PORTAL_KINDS as readonly string[]).includes(value)

/** Permissions a page names before the step that builds it declares them: nobody holds them, so the page stays hidden. */
export const PORTAL_PENDING_PERMISSIONS: ReadonlySet<string> = new Set(['portal.quotes.view', 'portal.accounting.view', 'portal.auditRoom.view'])

/** One page of the portal. */
export interface PortalPageDef {
  id: string
  /** A `portal` message key. */
  label: string
  /** The page's address in the portal (`/orders`). */
  href: string
  permission: string
  kinds?: readonly PortalKind[]
  /** The page exists on main: until then it is hidden (the step that builds it sets this). */
  built: boolean
}

/** One area of the portal: a rail row, a bottom-bar slot, and — with two or more pages — the band's Pages button. */
export interface PortalAreaDef {
  id: string
  label: string
  href: string
  icon: LucideIcon
  permission: string
  kinds: readonly PortalKind[]
  /** The task list's area its badge counts (`badges[].area` of GET /portal/tasks). */
  badge?: string
  /** On a phone: a tab of the bottom bar, or a row under More. */
  phone: 'tab' | 'more'
  /** The second key of its `g` chord (`g o` Orders). */
  key?: string
  built: boolean
  /** Two or more pages: the area's Pages (the band's button); each page's own permission and kinds. */
  pages?: readonly PortalPageDef[]
}

const ALL: readonly PortalKind[] = PORTAL_KINDS
const SUPPLIERS: readonly PortalKind[] = ['SUPPLIER', 'SUBCONTRACTOR']

export const PORTAL_AREAS: readonly PortalAreaDef[] = [
  // B-W2b-173: Home is the frame's own page until the Home steps (B-W2b-187 customer, B-W2b-179 supplier) draw theirs.
  { id: 'home', label: 'nav.home', href: '/', icon: Home, permission: 'portal.home.view', kinds: ALL, badge: 'home', phone: 'tab', key: 'h', built: true },
  {
    id: 'orders',
    label: 'nav.orders',
    href: '/orders',
    icon: ShoppingBag,
    permission: 'portal.salesOrders.view',
    kinds: ['CUSTOMER'],
    badge: 'orders',
    phone: 'tab',
    key: 'o',
    // B-W2b-191: the customer's Orders & tracking.
    built: true,
    pages: [
      // B-W2b-191: the customer's Orders & tracking (SCR-184).
      { id: 'orders.list', label: 'nav.ordersTracking', href: '/orders', permission: 'portal.salesOrders.view', built: true },
      { id: 'orders.new', label: 'nav.newOrder', href: '/orders/new', permission: 'portal.orderRequests.manage', built: false },
    ],
  },
  {
    id: 'quotes',
    label: 'nav.quotesSamples',
    href: '/quotes',
    icon: ClipboardList,
    // The area is any of its pages: each page keeps its own permission.
    permission: 'portal.home.view',
    kinds: ['CUSTOMER'],
    badge: 'quotes',
    phone: 'more',
    built: false,
    pages: [
      { id: 'quotes.list', label: 'nav.quotes', href: '/quotes', permission: 'portal.quotes.view', built: false },
      { id: 'quotes.catalogue', label: 'nav.catalogue', href: '/catalogue', permission: 'portal.catalogue.view', built: false },
    ],
  },
  { id: 'documents', label: 'nav.documents', href: '/documents', icon: FileText, permission: 'portal.customerDocuments.view', kinds: ['CUSTOMER'], badge: 'documents', phone: 'tab', key: 'd', built: false },
  { id: 'returns', label: 'nav.returns', href: '/returns', icon: RotateCcw, permission: 'portal.returns.view', kinds: ['CUSTOMER'], badge: 'returns', phone: 'tab', built: false },
  // B-W2b-196: the customer's Account (SCR-188).
  { id: 'account', label: 'nav.account', href: '/account', icon: UserRound, permission: 'portal.colleagues.view', kinds: ['CUSTOMER'], badge: 'account', phone: 'more', built: true },
  {
    id: 'work',
    label: 'nav.ordersJobs',
    href: '/orders',
    icon: Package,
    permission: 'portal.home.view',
    kinds: SUPPLIERS,
    badge: 'orders',
    phone: 'tab',
    key: 'o',
    built: false,
    pages: [
      // B-W2b-179: the supplier's purchase orders.
      { id: 'work.orders', label: 'nav.purchaseOrders', href: '/orders', permission: 'portal.purchaseOrders.view', kinds: ['SUPPLIER'], built: true },
      { id: 'work.jobs', label: 'nav.jobs', href: '/jobs', permission: 'portal.jobs.view', kinds: ['SUBCONTRACTOR'], built: false },
    ],
  },
  // B-W2b-186: the supplier's Ship notices (SCR-227).
  { id: 'deliveries', label: 'nav.deliveries', href: '/deliveries', icon: Truck, permission: 'portal.shipNotices.view', kinds: ['SUPPLIER'], badge: 'deliveries', phone: 'tab', built: true },
  { id: 'supplier-documents', label: 'nav.documents', href: '/documents', icon: FileText, permission: 'portal.supplierDocuments.view', kinds: SUPPLIERS, badge: 'documents', phone: 'tab', key: 'd', built: false },
  { id: 'profile', label: 'nav.profile', href: '/profile', icon: IdCard, permission: 'portal.supplierProfile.view', kinds: SUPPLIERS, badge: 'account', phone: 'more', built: false },
  { id: 'accounting', label: 'nav.accounting', href: '/accounting', icon: Calculator, permission: 'portal.accounting.view', kinds: ['GUEST'], badge: 'documents', phone: 'tab', key: 'd', built: false },
  { id: 'audit-room', label: 'nav.auditRoom', href: '/audit-room', icon: Archive, permission: 'portal.auditRoom.view', kinds: ['GUEST'], badge: 'documents', phone: 'tab', built: false },
]

/**
 * Where a record opens in the portal, by the partner kind that reads it and the record's type (the API's links are
 * `/open/<type>/<id>`). A step that builds a record page sets its `built`; until then the frame's own record page opens
 * (its band and its Messages: every record has its conversation, COL-059).
 */
export interface PortalRecordPage {
  kinds: readonly PortalKind[]
  type: string
  href: (id: string) => string
  built: boolean
}

export const RECORD_PAGES: readonly PortalRecordPage[] = [
  // B-W2b-191: the customer's order (Status & progress first).
  { kinds: ['CUSTOMER'], type: 'SalesOrder', href: (id) => `/orders/${id}`, built: true },
  { kinds: ['CUSTOMER'], type: 'Quote', href: (id) => `/quotes/${id}`, built: false },
  // B-W2b-179: the supplier's purchase order (its Lines tab first).
  { kinds: ['SUPPLIER'], type: 'PurchaseOrder', href: (id) => `/orders/${id}`, built: true },
  { kinds: ['SUBCONTRACTOR'], type: 'SubcontractOrder', href: (id) => `/jobs/${id}`, built: false },
  // B-W2b-186: a supplier's ship notice.
  { kinds: ['SUPPLIER'], type: 'ShipNotice', href: (id) => `/deliveries/${id}`, built: true },
  // B-W2b-196: our check of a delivery address (F15's notification) opens the Account's Delivery addresses on that row.
  { kinds: ['CUSTOMER'], type: 'PartyAddress', href: (id) => `/account?address=${encodeURIComponent(id)}#addresses`, built: true },
]

/** Who is looking: their permissions and partner kind(s) (a preview: every kind of the party). */
export interface PortalAccess {
  can: (permission: string) => boolean
  kinds: readonly PortalKind[]
  /** Every page as if built (the design review: the frame as it will be). Default: only built pages. */
  everyPage?: boolean
}

const toArea = (def: PortalAreaDef): AreaNavArea => {
  const pages = def.pages ?? []
  const items: AreaNavItem[] = pages.map((page) => ({ id: page.id, label: page.label, href: page.href, permission: page.permission, ...(page.kinds ? { kinds: page.kinds } : {}), exact: page.href === def.href && pages.some((other) => other !== page && other.href.startsWith(`${page.href}/`)) }))
  const sections: AreaNavSection[] = items.length > 0 ? [{ id: `${def.id}.pages`, label: def.label, hideLabel: true, noCrumb: true, items }] : []
  return { id: def.id, label: def.label, href: def.href, icon: def.icon, permission: def.permission, kinds: def.kinds, phone: def.phone, ...(def.badge ? { badge: def.badge } : {}), ...(sections.length > 0 ? { sections } : {}) }
}

/** An area left with one page of several takes that page's name and address and has no Pages button. */
const collapse = (area: AreaNavArea): AreaNavArea => {
  const items = area.sections?.flatMap((section) => section.items) ?? []
  if (items.length !== 1) return area
  const { sections: _sections, ...rest } = area
  return { ...rest, label: items[0].label, href: items[0].href }
}

/** The navigation this person may open, in rail order (fails closed; unbuilt pages hidden unless `everyPage`). */
export function portalNavFor(access: PortalAccess, defs: readonly PortalAreaDef[] = PORTAL_AREAS): AreaNav {
  const built = defs.flatMap((def): PortalAreaDef[] => {
    if (access.everyPage) return [def]
    const pages = def.pages?.filter((page) => page.built)
    if (def.pages) return pages && pages.length > 0 ? [{ ...def, pages }] : []
    return def.built ? [def] : []
  })
  const nav: AreaNav = { view: 'portal', areas: built.map(toArea) }
  // A preview reads as every kind of its party: the union of each kind's areas, the first of an address kept.
  const ids = new Set<string>()
  const hrefs = new Set<string>()
  const areas = access.kinds.flatMap((kind) => areaNavForPerson(nav, { can: access.can, kind }).areas.map(collapse))
  return {
    view: 'portal',
    areas: areas.filter((area) => {
      if (ids.has(area.id) || hrefs.has(area.href)) return false
      ids.add(area.id)
      hrefs.add(area.href)
      return true
    }),
  }
}

/** The labels drawn by `t`; ids, addresses, icons and badges stay. */
export function translatePortalNav(nav: AreaNav, t: (key: string) => string): AreaNav {
  const row = (item: AreaNavItem): AreaNavItem => ({ ...item, label: t(item.label) })
  return { ...nav, areas: nav.areas.map((area) => ({ ...area, label: t(area.label), ...(area.sections ? { sections: area.sections.map((section) => ({ ...section, label: t(section.label), items: section.items.map(row) })) } : {}) })) }
}

/** Where a portal address is: the area (rail row, bottom-bar slot) and the page of its Pages. */
export const portalPlace = (nav: AreaNav, path: string) => findAreaNavPlace(nav, path)

/** The `g` chords of the person's areas (`g h` Home, `g o` Orders or Jobs, `g d` Documents): key → address. */
export function portalChords(nav: AreaNav, defs: readonly PortalAreaDef[] = PORTAL_AREAS): Record<string, string> {
  const keyOf = new Map(defs.map((def) => [def.id, def.key]))
  const chords: Record<string, string> = {}
  for (const area of nav.areas) {
    const key = keyOf.get(area.id)
    if (key && !chords[key]) chords[key] = area.href
  }
  return chords
}

/** Where a record opens for this person: its own page once built, else null (the frame's record page). */
export function recordPageOf(kinds: readonly PortalKind[], type: string, id: string, pages: readonly PortalRecordPage[] = RECORD_PAGES): string | null {
  const page = pages.find((entry) => entry.built && entry.type === type && entry.kinds.some((kind) => kinds.includes(kind)))
  return page ? page.href(id) : null
}

/** Every permission the manifest names (the test checks each is declared, or pending). */
export function portalNavPermissions(defs: readonly PortalAreaDef[] = PORTAL_AREAS): string[] {
  return [...new Set(defs.flatMap((def) => [def.permission, ...(def.pages ?? []).map((page) => page.permission)]))]
}

/** Every label key the manifest uses. */
export function portalNavLabelKeys(defs: readonly PortalAreaDef[] = PORTAL_AREAS): string[] {
  return [...new Set(defs.flatMap((def) => [def.label, ...(def.pages ?? []).map((page) => page.label)]))]
}
