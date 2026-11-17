import { expect } from 'vitest'
import { textOf } from '../../../adapters/ses/fake'
import { mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { Browser } from '../../../platform/auth/sessions/testing/harness'
import { admin, call, ok, stepped, type Method, type Person, type World } from '../../testing/world'

/**
 * B-TH-002 (threads plan TH-0, §0 the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all."): TWO BRANDS IN ONE FACTORY, for every golden
 * flow that proves the wall (brand-wall.pg here, and the TH golden flows after it).
 *
 *   - TWO_BRANDS: the two made-up customers' identities — Brand Alpha (brand A, the one whose data must never show) and Brand
 *     Beta (brand B, the reader): legal and trade names, codes, contacts, portal people, addresses, a file name, a purchase-order
 *     reference and a message. apps/factory-web/src/lib/testing/two-brands.ts holds the SAME list for the screens (B-TH-203):
 *     change both together.
 *   - setUpBrand: an office person makes a seeded customer into one of them THROUGH THE ROUTES (names and code, a contact, an
 *     address, the portal opened, its admin invited and signed in by code, the first visit's terms taken).
 *   - markersOf: everything of a brand that must never reach the other — the fixture's words, and what the database holds of the
 *     party's records (numbers, references, file names, contacts' addresses, address lines, ids), read by SQL (reads only).
 *   - findMarkers: the T00 name scan of one answer, mail or link page (a marker counts only as a whole token, so `SO-0001` is not
 *     found inside `SO-00012`).
 *
 * Every name, address and number is invented (`example.com` addresses; no real company).
 */

export interface BrandFixture {
  readonly key: 'alpha' | 'beta'
  readonly legalName: string
  readonly tradeName: string
  readonly code: string
  /** The office's contact at the brand (orders and invoices). */
  readonly contact: { readonly name: string; readonly email: string }
  /** The brand's portal admin. */
  readonly portalPerson: { readonly name: string; readonly email: string }
  readonly address: { readonly line1: string; readonly postalCode: string; readonly city: string; readonly province?: string; readonly country: string }
  /** A file of the brand's (a tech pack, a size chart). */
  readonly fileName: string
  /** The brand's own purchase-order reference. */
  readonly customerRef: string
  /** Words the brand writes in its thread. */
  readonly message: string
}

export const BRAND_ALPHA: BrandFixture = Object.freeze({
  key: 'alpha',
  legalName: 'Brand Alpha S.r.l.',
  tradeName: 'Brand Alpha',
  code: 'BRAND-ALPHA',
  contact: { name: 'Alma Alfieri', email: 'alma.alfieri@brand-alpha.example' },
  portalPerson: { name: 'Anna Alfieri', email: 'anna.alfieri@brand-alpha.example' },
  address: { line1: 'Via Alfa 11', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  fileName: 'Brand Alpha tech pack AX-100.pdf',
  customerRef: 'ALPHA-PO-0042',
  message: 'Alpha asks: keep the yellow piping on the collar of AX-100.',
})

export const BRAND_BETA: BrandFixture = Object.freeze({
  key: 'beta',
  legalName: 'Brand Beta GmbH',
  tradeName: 'Brand Beta',
  code: 'BRAND-BETA',
  contact: { name: 'Bruno Becker', email: 'bruno.becker@brand-beta.example' },
  portalPerson: { name: 'Berta Becker', email: 'berta.becker@brand-beta.example' },
  address: { line1: 'Betastrasse 22', postalCode: '10115', city: 'Berlin', country: 'DE' },
  fileName: 'Brand Beta size chart BX-200.pdf',
  customerRef: 'BETA-PO-0077',
  message: 'Beta asks: the size chart BX-200 is the new one.',
})

export const TWO_BRANDS = Object.freeze({ alpha: BRAND_ALPHA, beta: BRAND_BETA })

/** One thing of a brand that must never reach the other: what it is (for the failure) and its text. */
export interface Marker {
  readonly label: string
  readonly text: string
}

/** The fixture's own words of a brand (names, code, addresses, the file, the reference, the message). */
export function fixtureMarkers(brand: BrandFixture): Marker[] {
  return [
    { label: 'legal name', text: brand.legalName },
    { label: 'trade name', text: brand.tradeName },
    { label: 'code', text: brand.code },
    { label: 'contact address', text: brand.contact.email },
    { label: 'contact name', text: brand.contact.name },
    { label: 'portal person address', text: brand.portalPerson.email },
    { label: 'portal person name', text: brand.portalPerson.name },
    { label: 'address line', text: brand.address.line1 },
    { label: 'file name', text: brand.fileName },
    { label: 'purchase-order reference', text: brand.customerRef },
    { label: 'message', text: brand.message },
  ]
}

/**
 * What the database holds of a party (SQL reads only, never a step): its names and code, its contacts' and portal people's
 * addresses, its address lines, the numbers and references of its records, the names of its files, and the ids of its
 * records (a record id in another brand's answer is a leak too). Short values (under 6 characters) are left out: they would
 * match by chance.
 */
export async function recordMarkers(w: World, partyId: string): Promise<Marker[]> {
  const rows = await admin<{ label: string; text: string | null }>(
    w,
    `SELECT 'legal name' AS label, "legalName" AS text FROM "Party" WHERE id = $1
     UNION ALL SELECT 'trade name', "tradeName" FROM "Party" WHERE id = $1
     UNION ALL SELECT 'code', code FROM "Party" WHERE id = $1
     UNION ALL SELECT 'contact address', email FROM "PartyContact" WHERE "partyId" = $1
     UNION ALL SELECT 'contact name', name FROM "PartyContact" WHERE "partyId" = $1
     UNION ALL SELECT 'address line', line1 FROM "PartyAddress" WHERE "partyId" = $1
     UNION ALL SELECT 'portal person address', email FROM "User" WHERE "partyId" = $1
     UNION ALL SELECT 'sales order', number FROM "SalesOrder" WHERE "partyId" = $1
     UNION ALL SELECT 'sales order', id::text FROM "SalesOrder" WHERE "partyId" = $1
     UNION ALL SELECT 'purchase-order reference', "customerRef" FROM "SalesOrder" WHERE "partyId" = $1
     UNION ALL SELECT 'quote', number FROM "Quote" WHERE "partyId" = $1
     UNION ALL SELECT 'quote', id::text FROM "Quote" WHERE "partyId" = $1
     UNION ALL SELECT 'shipment', number FROM "Shipment" WHERE "partyId" = $1
     UNION ALL SELECT 'shipment', id::text FROM "Shipment" WHERE "partyId" = $1
     UNION ALL SELECT 'invoice', number FROM "Invoice" WHERE "partyId" = $1
     UNION ALL SELECT 'invoice', id::text FROM "Invoice" WHERE "partyId" = $1
     UNION ALL SELECT 'return', number FROM "ReturnAuthorisation" WHERE "partyId" = $1
     UNION ALL SELECT 'return', id::text FROM "ReturnAuthorisation" WHERE "partyId" = $1
     UNION ALL SELECT 'complaint', number FROM "Complaint" WHERE "partyId" = $1
     UNION ALL SELECT 'complaint', id::text FROM "Complaint" WHERE "partyId" = $1
     UNION ALL SELECT 'repair', number FROM "RepairOrder" WHERE "partyId" = $1
     UNION ALL SELECT 'repair', id::text FROM "RepairOrder" WHERE "partyId" = $1
     UNION ALL SELECT 'order request', number FROM "PortalOrderRequest" WHERE "partyId" = $1
     UNION ALL SELECT 'order request', id::text FROM "PortalOrderRequest" WHERE "partyId" = $1
     UNION ALL SELECT 'private style', code FROM "Style" WHERE "brandPartyId" = $1
     UNION ALL SELECT 'private style', id::text FROM "Style" WHERE "brandPartyId" = $1
     UNION ALL SELECT 'file name', "originalName" FROM "StoredFile" WHERE "partyId" = $1
     UNION ALL SELECT 'file', id::text FROM "StoredFile" WHERE "partyId" = $1
     UNION ALL SELECT 'thread', id::text FROM "Thread" WHERE "partyId" = $1
     UNION ALL SELECT 'message', id::text FROM "Message" WHERE "partyId" = $1`,
    [partyId],
  )
  return rows.filter((row): row is Marker => typeof row.text === 'string' && row.text.trim().length >= 6).map((row) => ({ label: row.label, text: row.text.trim() }))
}

/** A brand's fixture words and its records' markers, without repeats. */
export async function markersOf(w: World, brand: BrandFixture, partyId: string): Promise<Marker[]> {
  const all = [...fixtureMarkers(brand), ...(await recordMarkers(w, partyId))]
  const seen = new Set<string>()
  return all.filter((marker) => {
    const key = marker.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The T00 name scan: the markers found in an answer, a mail or a link page (any value: it is read as its JSON, a string as
 * it is), each as `label: text`. A marker counts only as a whole token (not inside a longer word or number), any case.
 */
export function findMarkers(value: unknown, markers: readonly Marker[]): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return markers.filter((marker) => new RegExp(`(?<![A-Za-z0-9])${escape(marker.text)}(?![A-Za-z0-9])`, 'i').test(text)).map((marker) => `${marker.label}: ${marker.text}`)
}

/** The words of a raw mail a brand gets: its headers (subject, attachment names) and its text, for the scan. */
export const mailText = (raw: string): string => `${raw.split('\r\n\r\n', 1)[0] ?? ''}\n${textOf(raw)}\n${raw.match(/filename="?[^"\r\n;]+/g)?.join('\n') ?? ''}`

// ---- a brand in the world --------------------------------------------------------------------------------------------------

/** One answer a brand's person or link got: kept for the scan. */
export interface Seen {
  readonly who: string
  readonly method: Method
  readonly url: string
  readonly status: number
  readonly body: unknown
}

export interface BrandInWorld {
  readonly fixture: BrandFixture
  readonly partyId: string
  /** The portal admin's browser (portal cookie and the CSRF). */
  readonly browser: Browser
  userId?: string
}

/** A brand person's call: every answer kept in `seen` for the scan. */
export async function asBrand(brand: BrandInWorld, seen: Seen[], method: Method, url: string, body?: unknown, status: number | null = 200): Promise<any> {
  const answer = await call(brand.browser, method, url, body)
  seen.push({ who: `${brand.fixture.key} portal`, method, url, status: answer.status, body: answer.body })
  if (status !== null) expect(answer.status, `${brand.fixture.key} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}

/** A brand's link call (the token in `x-factory-link`): every answer kept in `seen` for the scan. */
export async function viaBrandLink(w: World, brand: BrandInWorld, token: string, seen: Seen[], method: Method, url: string, body?: unknown, status: number | null = 200): Promise<any> {
  const answer = await call(new Browser(w.h.app), method, url, body, { 'x-factory-link': token })
  seen.push({ who: `${brand.fixture.key} link`, method, url, status: answer.status, body: answer.body })
  if (status !== null) expect(answer.status, `${brand.fixture.key} link ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body
}

let network = 60

// ---- B-TH-021 / B-TH-037: a brand's portal person may be its buyer (who sends requests: portal.orderRequests.manage) and may
// write in its threads (the comment capability); default as before: the customer's admin.
export interface BrandAccess {
  readonly roleKey?: 'customer-admin' | 'customer-buyer'
  readonly capabilities?: readonly ('comment' | 'upload' | 'approve')[]
}
// ---- end B-TH-021 / B-TH-037

/**
 * The office makes a seeded customer into a brand of the fixture, through the routes: its names, code and the customer and brand
 * roles (PATCH /parties), the
 * fixture's contact (orders and invoices) and address, its portal opened (customer-admin allowed), the fixture's portal person
 * invited as its admin, signed in by the mailed code and through the first visit's terms. `office` holds parties.manage and
 * partners.* (the sales office).
 */
export async function setUpBrand(w: World, office: Person, brand: BrandFixture, partyId: string, companyId: string, access: BrandAccess = {}): Promise<BrandInWorld> {
  const party = (await ok(office, 'GET', `/parties/${partyId}`)).party
  await ok(office, 'PATCH', `/parties/${partyId}`, { version: party.version, legalName: brand.legalName, tradeName: brand.tradeName, code: brand.code, roles: ['CUSTOMER', 'BRAND'] })
  await ok(office, 'POST', `/parties/${partyId}/contacts`, { name: brand.contact.name, email: brand.contact.email, roles: ['ORDERS', 'INVOICES'] }, 201)
  await ok(office, 'POST', `/parties/${partyId}/addresses`, { kinds: ['BILL_TO', 'SHIP_TO'], name: brand.legalName, ...brand.address }, 201)
  const tab = await ok(office, 'GET', `/partners/${partyId}`)
  await stepped(w, office)
  await ok(office, 'POST', `/partners/${partyId}/settings`, {
    portalOn: true,
    version: tab.settings?.version ?? 0,
    allowedRoleKeys: ['customer-buyer', 'customer-viewer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-admin'],
  })
  await stepped(w, office)
  await ok(office, 'POST', `/partners/${partyId}/people`, { email: brand.portalPerson.email, displayName: brand.portalPerson.name, locale: 'en', roleKey: access.roleKey ?? 'customer-admin', ...(access.capabilities ? { capabilities: access.capabilities } : {}), companyId })
  const made: BrandInWorld = { fixture: brand, partyId, browser: await portalBrowser(w.h, `203.0.113.${++network}`) }
  expect((await call(made.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: brand.portalPerson.email })).status).toBe(200)
  await w.h.auth.settled()
  const signedIn = await call(made.browser, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email: brand.portalPerson.email, code: mailedCode(w.h, brand.portalPerson.email)!.code })
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  const terms = (await call(made.browser, 'GET', '/portal/terms?locale=en')).body
  expect((await call(made.browser, 'POST', '/portal/first-visit', { noticeId: terms.notice.id, noticeLocale: terms.notice.locale, sha256: terms.notice.sha256 })).status).toBe(200)
  const me = (await call(made.browser, 'GET', '/portal/me')).body
  expect(me).toMatchObject({ termsDue: false, party: { id: partyId } })
  made.userId = me.user.id
  return made
}

/** Every address of a brand the office may write to (its fixture contact and portal person, and its seeded contacts). */
export async function addressesOf(w: World, brand: BrandInWorld): Promise<string[]> {
  const rows = await admin<{ email: string }>(
    w,
    `SELECT lower(email) AS email FROM "PartyContact" WHERE "partyId" = $1 AND email IS NOT NULL UNION SELECT lower(email) FROM "User" WHERE "partyId" = $1`,
    [brand.partyId],
  )
  return [...new Set([brand.fixture.contact.email, brand.fixture.portalPerson.email, ...rows.map((row) => row.email)].map((email) => email.toLowerCase()))]
}
