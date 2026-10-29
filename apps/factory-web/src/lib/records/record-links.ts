/**
 * Where a record opens (design 00 §2.3, "one detail rule"): the record's own page when its area has built it, else the
 * record panel route `/records/<type>/<id>` (SCR-006: its thread, files and history), which every record has. Addresses
 * are company-free; the caller adds `/w/<company>`. Every opener is a real link, so ⌘-click opens a new tab.
 *
 * A step that builds a record page (or a list page) adds ONE line here, and its page's address to OFFICE_PAGES
 * (shell/nav/office-nav.ts): the opener follows by itself. `[id]` stands for the record's id; a `?…` part is kept.
 */

/** Record type (the API's model name) → its own page. W1 so far: a received mail opens in Mail to sort's review. */
export const RECORD_PAGES: Readonly<Record<string, string>> = Object.freeze({
  InboundEmail: '/home/mail-to-sort?open=[id]',
  WorkOrder: '/production/work-orders/[id]',
})

/** An API list route → the web page that shows it (with the same query). */
export const LIST_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/email/inbound': '/home/mail-to-sort',
  '/production/work-orders': '/production/work-orders',
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

/** Whether a record has its own page yet (else it opens in its panels). */
export function hasRecordPage(type: string, built: ReadonlySet<string>): boolean {
  const page = RECORD_PAGES[type]
  return page !== undefined && built.has(pathOf(page))
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
  if (!page || !built.has(pathOf(page))) return null
  const qs = new URLSearchParams(query ?? {}).toString()
  return `${page}${qs ? `?${qs}` : ''}`
}
