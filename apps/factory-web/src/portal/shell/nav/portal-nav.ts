import { Archive, Calculator, Factory, FileText, Home, IdCard, Landmark, Package, Plus, RotateCcw, Shirt, ShoppingBag, Tag, Truck, UserCheck, UserRound, Users, Wallet, type LucideIcon } from 'lucide-react'
import { areaNavForPerson, findAreaNavPlace, type AreaNav, type AreaNavArea, type AreaNavItem, type AreaNavPlace, type AreaNavSection } from '@nexus/ui/patterns/shell/index'

/**
 * The Portal navigation (B-W2b-173; design portal.frame › rail, bottom-bar, band; the views' `portal` areas) — THE merge point
 * of every portal page: a step that builds a page sets its `built` here (and a record page its line in RECORD_PAGES), nothing
 * else. Addresses are the portal's own, without `/p/<party code>` (the frame adds it).
 *
 *   Customer       owb-po4 (order workflow plan § 5 "Customer portal", PORTAL_NAV; the office's rail + sub-sidebar):
 *                  Home · Orders (Orders, Prices*, Agreed prices*, New order, Production, Returns & claims) · Customers (Your
 *                  customers*, Payments*) · Products (Products = the Catalogue, Samples & tech packs) · People (Your people) ·
 *                  Documents · Account          (* not built yet: hidden; Prices, Agreed prices and Payments only with prices)
 *                  Nothing is lost (plan § 5 F): Production and Returns are rows under Orders, the Catalogue and Samples are
 *                  Products, Waiting for you is Home's card "What waits for you" (its page stays: `menu: false`).
 *   Supplier       Home · Orders & jobs (Purchase orders for a supplier, Jobs for a workshop) · Deliveries · Documents · Profile
 *   Subcontractor  Home · Jobs · Documents · Profile
 *   Guest          Home · Accounting (the accountant) · Audit room (an auditor)
 *
 * It FAILS CLOSED (the DS's `areaNavForPerson`, view `portal`): an area or page shows only to the partner kinds it names and
 * only with its permission, and only once it is BUILT — navigation never shows a door that leads nowhere. A money page shows
 * only to a person who sees prices (`money`; unknown = no). An area whose person keeps one page of several takes that page's
 * name and address ("Orders & jobs" is "Jobs" for a workshop). Labels are `portal` message keys (`translatePortalNav`). Each
 * area names the rail badge it carries: the area of the one task list (factory-domain portal/tasks/kinds.ts PORTAL_AREAS), so
 * the rail, the bottom bar and Home count the same requests; a page that moved into an area brings its own (owb-po4.4: the row
 * counts both, one key joined by `+`, read with shell/model.ts `badgeOf`).
 */

export const PORTAL_KINDS = ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const
export type PortalKind = (typeof PORTAL_KINDS)[number]
export const isPortalKind = (value: unknown): value is PortalKind => typeof value === 'string' && (PORTAL_KINDS as readonly string[]).includes(value)

/** Permissions a page names before the step that builds it declares them: nobody holds them, so the page stays hidden. */
// B-W2b-201 declared portal.accounting.view. owb-po4: Your customers + Payments (plan § 6: a later session) name theirs.
export const PORTAL_PENDING_PERMISSIONS: ReadonlySet<string> = new Set(['portal.quotes.view', 'portal.auditRoom.view', 'portal.brandCustomers.view'])

/** owb-po4.4: the task-list areas one rail row counts, joined (`orders+production+returns`). */
export const BADGE_JOIN = '+'

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
  /**
   * F-CP-152: a page that opens with any of these permissions (its `permission` is the first of them): New order opens for who
   * keeps drafts (portal.orderDrafts.edit: the brand's Buyer and Designer) and for who may order (portal.orderRequests.manage).
   */
  anyOf?: readonly string[]
  /**
   * owb-po4.1 (plan § 5 F): false — the menu draws no row for it; a card or a link opens it (Waiting for you is Home's card
   * "What waits for you"). The page stays built for its links, and its address still lights its area.
   */
  menu?: false
  /** owb-po4.1: a money page (the price grain): only a person who sees prices keeps the row. */
  money?: true
  /** owb-po4.4: the task-list area this page shows: its count on the row, and on its area's rail row. */
  badge?: string
  /** owb-po4.2: on a phone, a tab of the bottom bar (New order: plan § 5 "Home · Orders · New order · Account"). */
  phone?: 'tab' | 'more'
  icon?: LucideIcon
  /** owb-po4.1: the second key of its `g` chord, kept when the page moved inside an area (`g p` Production). */
  key?: string
}

/** One area of the portal: a rail row, a bottom-bar slot, and — with two or more pages — the area's sub-sidebar. */
export interface PortalAreaDef {
  id: string
  label: string
  href: string
  icon: LucideIcon
  permission: string
  kinds: readonly PortalKind[]
  /** The task list's area its badge counts (`badges[].area` of GET /portal/tasks). */
  badge?: string
  /**
   * B-W2b-203: the pages that show what the badge counts. Given, the row carries its badge only while the person keeps one
   * of them: a count must lead to its requests (Home lists every one of them anyway).
   */
  badgePages?: readonly string[]
  /** On a phone: a tab of the bottom bar, or a row under More. */
  phone: 'tab' | 'more'
  /** The second key of its `g` chord (`g o` Orders). */
  key?: string
  built: boolean
  /** Two or more pages: the area's sub-sidebar (the band's toggle); each page's own permission and kinds. */
  pages?: readonly PortalPageDef[]
}

const ALL: readonly PortalKind[] = PORTAL_KINDS
const SUPPLIERS: readonly PortalKind[] = ['SUPPLIER', 'SUBCONTRACTOR']

export const PORTAL_AREAS: readonly PortalAreaDef[] = [
  // B-W2b-173: Home is the frame's own page until the Home steps (B-W2b-187 customer, B-W2b-179 supplier) draw theirs.
  {
    id: 'home',
    label: 'nav.home',
    href: '/',
    icon: Home,
    permission: 'portal.home.view',
    kinds: ALL,
    badge: 'home',
    phone: 'tab',
    key: 'h',
    built: true,
    pages: [
      { id: 'home.overview', label: 'nav.home', href: '/', permission: 'portal.home.view', built: true },
      // F-PR-14 built /waiting (`app/(portal)/p/[party]/waiting`). owb-po4.1 (plan § 5 F): Waiting for you is Home's card now
      // ("What waits for you" → its page); the menu draws no row for it, its page and every link to it stay.
      { id: 'home.waiting', label: 'nav.waiting', href: '/waiting', permission: 'portal.approvals.view', kinds: ['CUSTOMER'], menu: false, built: true /* F-PR-14 */ },
    ],
  },
  {
    id: 'orders',
    label: 'nav.orders',
    href: '/orders',
    icon: ShoppingBag,
    // F-CP-152 (customer page plan C5, 12 §2 Doors): the area is any of its pages — the brand's Designer keeps New order only
    // (its start lists the drafts); the orders list keeps portal.salesOrders.view.
    permission: 'portal.home.view',
    kinds: ['CUSTOMER'],
    badge: 'orders',
    // F-CP-152: the count is of orders and requests: it shows where the orders list does (a Designer's New order carries none).
    badgePages: ['orders.list'],
    phone: 'tab',
    key: 'o',
    built: true,
    pages: [
      // B-W2b-191: the customer's Orders & tracking (SCR-184). owb-po4.1: the design's one name, "Orders".
      { id: 'orders.list', label: 'nav.orders', href: '/orders', permission: 'portal.salesOrders.view', built: true },
      // owb-po4.1 (plan § 5d, § 6): Prices and Agreed prices are a later session's pages; money only.
      { id: 'orders.prices', label: 'nav.prices', href: '/prices', icon: Landmark, permission: 'portal.salesOrders.view', money: true, built: false },
      { id: 'orders.agreedPrices', label: 'nav.agreedPrices', href: '/agreed-prices', icon: Tag, permission: 'portal.salesOrders.view', money: true, built: false },
      // B-W2b-194: New order & reorder (SCR-185). F-CP-152: the draft order's start for who keeps drafts, the request like an
      // e-mail for who may order. owb-po4.2: a tab of the phone's bottom bar.
      { id: 'orders.new', label: 'nav.newOrder', href: '/orders/new', icon: Plus, permission: 'portal.orderDrafts.edit', anyOf: ['portal.orderDrafts.edit', 'portal.orderRequests.manage'], phone: 'tab', built: true },
      // F-PR-11: My production — owb-po4.1 (plan § 5 F): a row under Orders (and the order's Overview, owb-po5). Its id, its key
      // `g p` and its count stay.
      { id: 'production', label: 'nav.production', href: '/production', icon: Factory, permission: 'portal.production.view', badge: 'production', key: 'p', built: true },
      // B-W2b-197: Returns & claims (SCR-187) — owb-po4.1: a row under Orders (and "Report a complaint or a return…" on the
      // order's Shipments, owb-po6). Its id and its count stay.
      { id: 'returns', label: 'nav.returns', href: '/returns', icon: RotateCcw, permission: 'portal.returns.view', badge: 'returns', built: true },
    ],
  },
  // owb-po4.1 (plan § 6, R31 a): Your customers and Payments are a later session's: the area is hidden while both rows are.
  {
    id: 'customers',
    label: 'nav.customers',
    href: '/customers',
    icon: Users,
    permission: 'portal.home.view',
    kinds: ['CUSTOMER'],
    phone: 'more',
    built: false,
    pages: [
      { id: 'customers.list', label: 'nav.yourCustomers', href: '/customers', icon: Users, permission: 'portal.brandCustomers.view', built: false },
      { id: 'customers.payments', label: 'nav.payments', href: '/customers/payments', icon: Wallet, permission: 'portal.brandCustomers.view', money: true, built: false },
    ],
  },
  // owb-po4.1 (plan § 5 F): Products = the Catalogue, Samples & tech packs its second page (S4 builds those pages; this file
  // only names their rows). Quotes & requests waits for its step. Approvals are answered on Samples: the badge stays here.
  {
    id: 'products',
    label: 'nav.products',
    href: '/catalogue',
    icon: Shirt,
    // The area is any of its pages: each page keeps its own permission.
    permission: 'portal.home.view',
    kinds: ['CUSTOMER'],
    badge: 'quotes',
    // B-W2b-203: quotes to accept and approvals are answered on Quotes & requests (W3) or Samples & tech packs (W2b-4); the
    // Catalogue alone shows neither, so it carries no badge then (Home lists them).
    badgePages: ['products.quotes', 'products.samples'],
    phone: 'more',
    built: true,
    pages: [
      // B-W2b-194: the Catalogue (SCR-226) — the design's "Products".
      { id: 'products.catalogue', label: 'nav.products', href: '/catalogue', permission: 'portal.catalogue.view', built: true },
      // B-W2b-262: the brand's Samples & tech packs (SCR-225): what waits for its decision, its styles, its rounds.
      { id: 'products.samples', label: 'nav.samples', href: '/samples', permission: 'portal.samples.view', built: true },
      { id: 'products.quotes', label: 'nav.quotes', href: '/quotes', permission: 'portal.quotes.view', built: false },
    ],
  },
  // owb-po4.3: People › Your people — the customer's own people (today's team cards), its own page.
  { id: 'people', label: 'nav.people', href: '/people', icon: UserCheck, permission: 'portal.colleagues.view', kinds: ['CUSTOMER'], phone: 'more', built: true },
  // B-W2b-195: the customer's Documents (SCR-186). owb-po4.2: under More on a phone (the design's four tabs).
  { id: 'documents', label: 'nav.documents', href: '/documents', icon: FileText, permission: 'portal.customerDocuments.view', kinds: ['CUSTOMER'], badge: 'documents', phone: 'more', key: 'd', built: true },
  // B-W2b-196: the customer's Account (SCR-188). owb-po4.2: a tab on a phone (Home · Orders · New order · Account).
  { id: 'account', label: 'nav.account', href: '/account', icon: UserRound, permission: 'portal.colleagues.view', kinds: ['CUSTOMER'], badge: 'account', phone: 'tab', built: true },
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
      // B-W2b-181: a workshop's Jobs (SCR-192, SCR-193).
      { id: 'work.jobs', label: 'nav.jobs', href: '/jobs', permission: 'portal.jobs.view', kinds: ['SUBCONTRACTOR'], built: true },
    ],
  },
  // B-W2b-186: the supplier's Ship notices (SCR-227).
  { id: 'deliveries', label: 'nav.deliveries', href: '/deliveries', icon: Truck, permission: 'portal.shipNotices.view', kinds: ['SUPPLIER'], badge: 'deliveries', phone: 'tab', built: true },
  // B-W2b-193: a supplier's and a workshop's Documents (SCR-190) and Profile (SCR-191).
  { id: 'supplier-documents', label: 'nav.documents', href: '/documents', icon: FileText, permission: 'portal.supplierDocuments.view', kinds: SUPPLIERS, badge: 'documents', phone: 'tab', key: 'd', built: true },
  { id: 'profile', label: 'nav.profile', href: '/profile', icon: IdCard, permission: 'portal.supplierProfile.view', kinds: SUPPLIERS, badge: 'account', phone: 'more', built: true },
  // B-W2b-201: the accountant's room (SCR-268).
  { id: 'accounting', label: 'nav.accounting', href: '/accounting', icon: Calculator, permission: 'portal.accounting.view', kinds: ['GUEST'], badge: 'documents', phone: 'tab', key: 'd', built: true },
  { id: 'audit-room', label: 'nav.auditRoom', href: '/audit-room', icon: Archive, permission: 'portal.auditRoom.view', kinds: ['GUEST'], badge: 'documents', phone: 'tab', built: false },
]

/**
 * Where a record opens in the portal, by the partner kind that reads it and the record's type (the API's links are
 * `/open/<type>/<id>`). A step that builds a record page sets its `built`; until then the frame's generic page opens (B-TH-274:
 * the record's summary and its conversation as the main column — every record has its conversation, COL-059).
 * B-TH-273: a built record page has NO Messages tab: it docks the record's conversation in the portal record frame
 * (shell/record/PortalRecordFrame), and an old `?tab=messages` address opens its first tab with the conversation shown.
 */
export interface PortalRecordPage {
  kinds: readonly PortalKind[]
  type: string
  href: (id: string) => string
  built: boolean
}

export const RECORD_PAGES: readonly PortalRecordPage[] = [
  // B-W2b-191: the customer's order (Overview first; pp-w1).
  { kinds: ['CUSTOMER'], type: 'SalesOrder', href: (id) => `/orders/${id}`, built: true },
  // B-TH-222: the customer's request (its true state and its thread; SCR-185-request).
  { kinds: ['CUSTOMER'], type: 'Inquiry', href: (id) => `/orders/requests/${id}`, built: true },
  { kinds: ['CUSTOMER'], type: 'Quote', href: (id) => `/quotes/${id}`, built: false },
  // B-W2b-179: the supplier's purchase order (its Lines tab first).
  { kinds: ['SUPPLIER'], type: 'PurchaseOrder', href: (id) => `/orders/${id}`, built: true },
  // B-W2b-181: a workshop's job opens its own page.
  { kinds: ['SUBCONTRACTOR'], type: 'SubcontractOrder', href: (id) => `/jobs/${id}`, built: true },
  // B-W2b-186: a supplier's ship notice.
  { kinds: ['SUPPLIER'], type: 'ShipNotice', href: (id) => `/deliveries/${id}`, built: true },
  // B-W2b-197: a customer's return and complaint open their own pages (Status first).
  { kinds: ['CUSTOMER'], type: 'ReturnAuthorisation', href: (id) => `/returns/${id}`, built: true },
  { kinds: ['CUSTOMER'], type: 'Complaint', href: (id) => `/returns/complaints/${id}`, built: true },
  // B-W2b-342: a customer's repair or alteration opens its own page (Status first; SCR-358).
  { kinds: ['CUSTOMER'], type: 'RepairOrder', href: (id) => `/returns/repairs/${id}`, built: true },
  // B-W2b-196: our check of a delivery address (F15's notification) opens the Account's Delivery addresses on that row.
  { kinds: ['CUSTOMER'], type: 'PartyAddress', href: (id) => `/account?address=${encodeURIComponent(id)}#addresses`, built: true },
  // B-W2b-195: an invoice (a "Pay invoice" request, a notification) opens Documents on it: its Pay pop-up, or why not.
  { kinds: ['CUSTOMER'], type: 'Invoice', href: (id) => `/documents?invoice=${encodeURIComponent(id)}`, built: true },
  // ---- B-TH-253 (threads plan TH-5, PROJ.portal): a project the person was ADDED to opens its own page (the generic record page
  // grown: the summary and the thread as the main column) — the same page for a customer, a supplier and a workshop; a person
  // who is not a member reads "not found" there (the API's check).
  { kinds: ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR'], type: 'Project', href: (id) => `/projects/${encodeURIComponent(id)}`, built: true },
  // ---- end B-TH-253
]

// B-TH-220: whether a page is built (an area without pages, or one page of an area): its links may lead there.
export const pageBuilt = (id: string, areas: readonly PortalAreaDef[] = PORTAL_AREAS): boolean => areas.some((area) => (area.id === id && area.built) || (area.pages ?? []).some((page) => page.id === id && page.built))

/** Who is looking: their permissions and partner kind(s) (a preview: every kind of the party). */
export interface PortalAccess {
  can: (permission: string) => boolean
  kinds: readonly PortalKind[]
  /** Every page as if built (the design review: the frame as it will be). Default: only built pages. */
  everyPage?: boolean
  /** owb-po4.1: the person sees prices (their role's price grain). Unknown or false: no money page (fails closed). */
  prices?: boolean
}

const toArea = (def: PortalAreaDef): AreaNavArea => {
  const pages = def.pages ?? []
  const items: AreaNavItem[] = pages.map((page) => ({
    id: page.id,
    label: page.label,
    href: page.href,
    permission: page.permission,
    ...(page.kinds ? { kinds: page.kinds } : {}),
    // owb-po4.2/4.4: a row's own icon (the sub-sidebar, the phone), its phone mark and its count.
    ...(page.icon ? { icon: page.icon } : {}),
    ...(page.phone ? { phone: page.phone } : {}),
    ...(page.badge ? { badge: page.badge } : {}),
    exact: page.href === def.href && pages.some((other) => other !== page && other.href.startsWith(`${page.href}/`)),
  }))
  const sections: AreaNavSection[] = items.length > 0 ? [{ id: `${def.id}.pages`, label: def.label, hideLabel: true, noCrumb: true, items }] : []
  return { id: def.id, label: def.label, href: def.href, icon: def.icon, permission: def.permission, kinds: def.kinds, phone: def.phone, ...(def.badge ? { badge: def.badge } : {}), ...(sections.length > 0 ? { sections } : {}) }
}

/** An area left with one page of several takes that page's name and address and has no sub-sidebar. */
const collapse = (area: AreaNavArea): AreaNavArea => {
  const items = area.sections?.flatMap((section) => section.items) ?? []
  if (items.length !== 1) return area
  const { sections: _sections, ...rest } = area
  return { ...rest, label: items[0].label, href: items[0].href }
}

/** B-W2b-262: an area whose own address is a page the person does not keep (not built, or not theirs) opens its first page. */
const firstPage = (area: AreaNavArea): AreaNavArea => {
  const items = area.sections?.flatMap((section) => section.items) ?? []
  return items.length === 0 || items.some((item) => item.href === area.href) ? area : { ...area, href: items[0].href }
}

/**
 * What a rail row counts. B-W2b-203: its own badge only while the person keeps a page that shows what it counts (`badgePages`).
 * owb-po4.4 (plan § 5 F): + each kept page's own (Production and Returns moved under Orders with their counts) — one key, the
 * task-list areas joined by BADGE_JOIN (`orders+production+returns`), so no count is lost when a door moves.
 */
const counted = (area: AreaNavArea, def: PortalAreaDef | undefined): AreaNavArea => {
  const items = area.sections?.flatMap((section) => section.items) ?? []
  const showing = def?.badgePages
  const own = area.badge && (!showing || items.some((item) => showing.includes(item.id))) ? [area.badge] : []
  const keys = [...new Set([...own, ...items.flatMap((item) => (item.badge ? [item.badge] : []))])]
  const { badge: _badge, ...rest } = area
  return keys.length > 0 ? { ...rest, badge: keys.join(BADGE_JOIN) } : rest
}

/** The navigation this person may open, in rail order (fails closed; unbuilt pages hidden unless `everyPage`). */
export function portalNavFor(access: PortalAccess, defs: readonly PortalAreaDef[] = PORTAL_AREAS): AreaNav {
  // F-CP-152: a page that opens with any of several permissions asks the one the person holds (else its own: fails closed).
  const held = (page: PortalPageDef): PortalPageDef => (page.anyOf ? { ...page, permission: page.anyOf.find((name) => access.can(name)) ?? page.permission } : page)
  // owb-po4.1: a page a card opens has no row; a money page only for a person who sees prices (even in the design review).
  const inMenu = (page: PortalPageDef): boolean => page.menu !== false && (!page.money || access.prices === true)
  const built = defs.flatMap((def): PortalAreaDef[] => {
    const pages = def.pages?.filter((page) => inMenu(page) && (access.everyPage || page.built)).map(held)
    if (def.pages) return pages && pages.length > 0 ? [{ ...def, pages }] : []
    return access.everyPage || def.built ? [def] : []
  })
  const nav: AreaNav = { view: 'portal', areas: built.map(toArea) }
  // A preview reads as every kind of its party: the union of each kind's areas, the first of an address kept.
  const ids = new Set<string>()
  const hrefs = new Set<string>()
  const defOf = new Map(defs.map((def) => [def.id, def]))
  const areas = access.kinds.flatMap((kind) => areaNavForPerson(nav, { can: access.can, kind }).areas.map((area) => firstPage(collapse(counted(area, defOf.get(area.id))))))
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

/** Where a portal address is; `card`: a page with no menu row (owb-po4.1), placed in its area so the rail and the bar still light it. */
export type PortalPlace = AreaNavPlace & { card?: true }

/**
 * Where a portal address is: the area (rail row, bottom-bar slot) and the row of its sub-sidebar. owb-po4.1: an address no row
 * owns that is a card's page (`menu: false`, Waiting for you) is placed in its area — Home stays lit on /waiting.
 */
export function portalPlace(nav: AreaNav, path: string, defs: readonly PortalAreaDef[] = PORTAL_AREAS): PortalPlace | null {
  const place = findAreaNavPlace(nav, path)
  if (place) return place
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/'
  const owner = defs.find((def) => (def.pages ?? []).some((page) => page.menu === false && page.built && (clean === page.href || clean.startsWith(`${page.href}/`))))
  const area = owner ? nav.areas.find((entry) => entry.id === owner.id) : undefined
  return area ? { area, card: true } : null
}

/**
 * The `g` chords of the person's areas (`g h` Home, `g o` Orders or Jobs, `g d` Documents): key → address. owb-po4.1: + a page
 * that moved inside an area keeps its key (`g p` Production, a row under Orders), after the areas' own.
 */
export function portalChords(nav: AreaNav, defs: readonly PortalAreaDef[] = PORTAL_AREAS): Record<string, string> {
  const keyOf = new Map<string, string | undefined>(defs.flatMap((def) => [[def.id, def.key] as const, ...(def.pages ?? []).map((page) => [page.id, page.key] as const)]))
  const chords: Record<string, string> = {}
  for (const area of nav.areas) {
    const key = keyOf.get(area.id)
    if (key && !chords[key]) chords[key] = area.href
  }
  for (const area of nav.areas) {
    for (const item of area.sections?.flatMap((section) => section.items) ?? []) {
      const key = keyOf.get(item.id)
      if (key && !chords[key]) chords[key] = item.href
    }
  }
  return chords
}

/** owb-po4.1: the label of the area or row a chord opens (the shortcuts list names it: "Go to Production"). */
export function portalChordLabel(nav: AreaNav, href: string): string | null {
  for (const area of nav.areas) {
    const item = area.sections?.flatMap((section) => section.items).find((row) => row.href === href)
    if (item) return item.label
    if (area.href === href) return area.label
  }
  return null
}

/** Where a record opens for this person: its own page once built, else null (the frame's record page). */
export function recordPageOf(kinds: readonly PortalKind[], type: string, id: string, pages: readonly PortalRecordPage[] = RECORD_PAGES): string | null {
  const page = pages.find((entry) => entry.built && entry.type === type && entry.kinds.some((kind) => kinds.includes(kind)))
  return page ? page.href(id) : null
}

/** Every permission the manifest names (the test checks each is declared, or pending). */
export function portalNavPermissions(defs: readonly PortalAreaDef[] = PORTAL_AREAS): string[] {
  return [...new Set(defs.flatMap((def) => [def.permission, ...(def.pages ?? []).flatMap((page) => [page.permission, ...(page.anyOf ?? [])])]))]
}

/** Every label key the manifest uses. */
export function portalNavLabelKeys(defs: readonly PortalAreaDef[] = PORTAL_AREAS): string[] {
  return [...new Set(defs.flatMap((def) => [def.label, ...(def.pages ?? []).map((page) => page.label)]))]
}
