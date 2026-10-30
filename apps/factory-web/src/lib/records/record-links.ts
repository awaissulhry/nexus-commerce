/**
 * Where a record opens (design 00 §2.3, "one detail rule"): the record's own page when its area has built it, else the
 * record panel route `/records/<type>/<id>` (SCR-006: its thread, files and history), which every record has. Addresses
 * are company-free; the caller adds `/w/<company>`. Every opener is a real link, so ⌘-click opens a new tab.
 *
 * A step that builds a record page (or a list page) adds ONE line here, and its page's address to OFFICE_PAGES
 * (shell/nav/office-nav.ts): the opener follows by itself. `[id]` stands for the record's id, `[companyId]` for its
 * company (a record that lives under its company's page); a `?…` part is kept. The navigation test
 * (shell/nav/navigation-map.vitest.test.ts) holds that every built record page has its line here.
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
  // Products › Materials & trims (SCR-048; the API's model is Item) and the libraries (SCR-049).
  Item: '/products/materials/[id]',
  Operation: '/products/operations/[id]',
  SizeScale: '/products/sizes/[id]',
  WorkOrder: '/production/work-orders/[id]',
  // Quality › Inspections (SCR-076); a release is reviewed in its DetailModal on the list (design §2.3).
  Inspection: '/quality/inspections/[id]',
  QualityRelease: '/quality/inspections?open=[id]',
  // Warehouse › Lots & traceability (SCR-201): a lot's stock, trace and moves; its tests, documents and release stay in
  // Compliance › Tests & substances (SCR-054), which the lot record links.
  Lot: '/warehouse/lots/[id]',
  // Warehouse › Hides (SCR-200) and Settings › Locations (SCR-065).
  Hide: '/warehouse/hides/[id]',
  Location: '/warehouse/locations/[id]',
  // Warehouse › Counts (SCR-132): a cycle count or the year-end inventory.
  StockCount: '/warehouse/counts/[id]',
  // Compliance › PPE register & recalls (SCR-113).
  PpeRegisterEntry: '/compliance/register/[id]',
  // Finance › Invoices (SCR-081: invoices, deposit invoices, credit notes) and Payments (SCR-082: a payment's placements).
  Invoice: '/finance/invoices/[id]',
  Payment: '/finance/payments/[id]',
  // Compliance › Certificates (SCR-051) and Labels & marking (SCR-053).
  Certificate: '/compliance/certificates/[id]',
  LabelTemplate: '/compliance/labels/[id]',
  // Warehouse › Shipments (SCR-067): a shipment's record.
  Shipment: '/warehouse/shipments/[id]',
  // Purchasing › the PO studio (SCR-059); Warehouse › a goods receipt (SCR-063).
  PurchaseOrder: '/purchasing/orders/[id]',
  GoodsReceipt: '/warehouse/receipts/[id]',
  // Admin (B-W0-27/28): a company, a site (its address names its company: `[companyId]` is the record's own company), a
  // device or printer, an office user, a floor worker, a role, a connection.
  Company: '/admin/companies/[id]',
  Site: '/admin/companies/[companyId]/sites/[id]',
  Device: '/admin/devices/[id]',
  User: '/admin/users/[id]',
  Worker: '/admin/users/floor/[id]',
  Role: '/admin/roles/[id]',
  IntegrationAccount: '/admin/connections/[id]',
  // Home › My tasks (SCR-233, B-W2a-40): a task opens in its DetailModal on the list.
  Task: '/home/tasks?open=[id]',
  // B-W2a-53 Plant › Maintenance: a machine (SCR-150), a maintenance job (SCR-149); a request opens in its DetailModal on
  // the queue (SCR-148).
  Machine: '/plant/machines/[id]',
  MaintenanceJob: '/plant/jobs/[id]',
  MaintenanceRequest: '/plant/requests?open=[id]',
})

/**
 * A Today row whose work is done on a page other than its record's: attention kind → that page (`[id]` = the row's
 * record id). A company's open privacy duties are worked on Admin › Privacy & notices for that company, not on the
 * company's record.
 */
export const ATTENTION_PAGES: Readonly<Record<string, string>> = Object.freeze({
  PRIVACY_DUTY: '/admin/privacy?company=[id]',
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
  '/product/materials': '/products/materials',
  '/product/operations': '/products/operations',
  '/product/size-scales': '/products/sizes',
  '/compliance/certificates': '/compliance/certificates',
  '/compliance/labels': '/compliance/labels',
  '/production/work-orders': '/production/work-orders',
  // The pages read the API's own filters from the address (`?onHold=true`, `?waitingRelease=true`, `?status=OPEN`).
  '/quality/inspections': '/quality/inspections',
  '/quality/lots': '/compliance/tests',
  '/compliance/register': '/compliance/register',
  // The invoice list reads the API's own filters from the address (`?status=REJECTED`, `?docType=TD04`).
  '/invoicing/invoices': '/finance/invoices',
  '/payments': '/finance/payments',
  // The shipments list (SCR-066) reads `?rows=` and `?q=` from the address.
  '/shipping/shipments': '/warehouse/shipments',
  // The PO list reads `status` (one state, as the API) and `waitingOver48h`; Receipts reads `status`, `view=expected`.
  '/purchasing/orders': '/purchasing/orders',
  '/inventory/receipts': '/warehouse/receipts',
  // The stock screens read the API's own filters from the address.
  '/inventory/stock': '/warehouse/stock',
  '/inventory/hides': '/warehouse/hides',
  '/inventory/lots': '/warehouse/lots',
  '/inventory/ledger': '/warehouse/moves',
  '/inventory/locations': '/warehouse/locations',
  // Counts (SCR-132) reads `?view=`, `?q=` and `?site=`.
  '/inventory/stock-counts': '/warehouse/counts',
  '/planning/runs/latest': '/planning/mrp',
  // B-W2a-45: the schedule's board and the allocation board.
  '/planning/schedule': '/planning/board',
  '/planning/allocation': '/planning/allocation',
  // B-W2a-53: the plant's lists (the requests queue reads `?tile=`, the jobs `?view=`, the machines `?view=` and `?q=`).
  '/plant/requests': '/plant/requests',
  '/plant/jobs': '/plant/jobs',
  '/plant/machines': '/plant/machines',
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

/** The record's own page address, or null when its page needs what the reference lacks (a site without its company). */
function ownPage(page: string, record: RecordRef): string | null {
  if (page.includes('[companyId]') && !record.companyId) return null
  return page.replace('[companyId]', encodeURIComponent(record.companyId ?? '')).replace('[id]', encodeURIComponent(record.id))
}

/**
 * The company-free address a record opens at: its own page when built, else its panels (with what the panels need to
 * show it: its label, company and site).
 */
export function recordAddress(record: RecordRef, built: ReadonlySet<string>): string {
  const page = RECORD_PAGES[record.type]
  const own = page && hasRecordPage(record.type, built) ? ownPage(page, record) : null
  if (own) return own
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

/** Where a Today row opens: its kind's own page when built (ATTENTION_PAGES), else its record (`recordAddress`). */
export function attentionAddress(kind: string, record: RecordRef, built: ReadonlySet<string>): string {
  const page = ATTENTION_PAGES[kind]
  if (page && isBuilt(page, built)) return page.replace('[id]', encodeURIComponent(record.id))
  return recordAddress(record, built)
}
