/**
 * Where a record opens (design 00 §2.3, "one detail rule"): the record's own page when its area has built it, else the
 * record panel route `/records/<type>/<id>` (SCR-006: its thread, files and history), which every record has. Addresses
 * are company-free; the caller adds `/w/<company>`. Every opener is a real link, so ⌘-click opens a new tab.
 *
 * A step that builds a record page (or a list page) adds ONE line here, and its page's address to OFFICE_PAGES
 * (shell/nav/office-nav.ts): the opener follows by itself. `[id]` stands for the record's id; a `?…` part is kept.
 */

/**
 * Record type (the API's model name) → its own page. W1 so far: a received mail opens in Mail to sort's review; a party
 * (customer or supplier: one record) opens on the Customers record page (the type does not say which side; the Suppliers
 * record page shows the same party from the buying side); a quote opens its studio (SCR-035), a sales order its studio
 * (SCR-039).
 */
export const RECORD_PAGES: Readonly<Record<string, string>> = Object.freeze({
  InboundEmail: '/home/mail-to-sort?open=[id]',
  Party: '/sales/customers/[id]',
  Quote: '/sales/quotes/[id]',
  SalesOrder: '/sales/orders/[id]',
  Style: '/products/styles/[id]',
  WorkOrder: '/production/work-orders/[id]',
  // Quality › Inspections (SCR-076); a release is reviewed in its DetailModal on the list (design §2.3).
  Inspection: '/quality/inspections/[id]',
  QualityRelease: '/quality/inspections?open=[id]',
  // Compliance › Tests & substances (SCR-054): a lot's tests, documents and release, until Warehouse › Lots is built.
  Lot: '/compliance/tests/[id]',
  // Compliance › PPE register & recalls (SCR-113).
  PpeRegisterEntry: '/compliance/register/[id]',
  // Warehouse › Shipments (SCR-067): a shipment's record.
  Shipment: '/warehouse/shipments/[id]',
})

/** An API list route → the web page that shows it (with the same query). */
export const LIST_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/email/inbound': '/home/mail-to-sort',
  '/parties': '/sales/customers',
  // The quote list (SCR-034) reads `status` and `q` as the API does; the approvals queue (SCR-030) reads `view`.
  '/sales/quotes': '/sales/quotes',
  '/sales/quote-approvals': '/home/approvals',
  // The order list (SCR-038) reads the API's own filters from the address (`?late=true`, `?deposit=OPEN`, `?status=`).
  '/sales/orders': '/sales/orders',
  '/product/styles': '/products/styles',
  '/production/work-orders': '/production/work-orders',
  // The pages read the API's own filters from the address (`?onHold=true`, `?waitingRelease=true`, `?status=OPEN`).
  '/quality/inspections': '/quality/inspections',
  '/quality/lots': '/compliance/tests',
  '/compliance/register': '/compliance/register',
  // The shipments list (SCR-066) reads `?rows=` and `?q=` from the address.
  '/shipping/shipments': '/warehouse/shipments',
})

export interface RecordRef {
  readonly type: string
  readonly id: string
  /** Its number or code (the panel route shows it as the title). */
  readonly label?: string
  readonly companyId?: string | null
  readonly siteId?: string | null
}

const pathOf = (address: string): string => address.split('?')[0]!

/** An address with every dynamic segment written `[id]`: `/sales/customers/[partyId]` (a page folder) = `/sales/customers/[id]`. */
const shapeOf = (address: string): string => pathOf(address).replace(/\[[^\]/]+\]/g, '[id]')

/** The page is built: OFFICE_PAGES lists it, whatever its dynamic segment is called there. */
function isBuilt(page: string, built: ReadonlySet<string>): boolean {
  const shape = shapeOf(page)
  for (const address of built) if (shapeOf(address) === shape) return true
  return false
}

/** Whether a record has its own page yet (else it opens in its panels). */
export function hasRecordPage(type: string, built: ReadonlySet<string>): boolean {
  const page = RECORD_PAGES[type]
  return page !== undefined && isBuilt(page, built)
}

/**
 * The company-free address a record opens at: its own page when built, else its panels (with what the panels need to
 * show it: its label, company and site).
 */
export function recordAddress(record: RecordRef, built: ReadonlySet<string>): string {
  const page = RECORD_PAGES[record.type]
  if (page && hasRecordPage(record.type, built)) return page.replace('[id]', encodeURIComponent(record.id))
  const query = new URLSearchParams()
  if (record.label) query.set('label', record.label)
  if (record.companyId) query.set('company', record.companyId)
  if (record.siteId) query.set('site', record.siteId)
  const qs = query.toString()
  return `/records/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}${qs ? `?${qs}` : ''}`
}

/**
 * The web page of an API list with its query (`/sales/orders` + `{ late: 'true' }`), or null while no page shows that
 * list (a link to a page that does not exist is never drawn).
 */
export function listAddress(apiList: string | null, query: Readonly<Record<string, string>> | null, built: ReadonlySet<string>): string | null {
  if (apiList === null) return null
  const page = LIST_PAGES[apiList]
  if (!page || !isBuilt(page, built)) return null
  const qs = new URLSearchParams(query ?? {}).toString()
  return `${page}${qs ? `?${qs}` : ''}`
}
