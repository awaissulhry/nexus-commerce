import { expect } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { partnerLiveViewFor } from '@nexus/factory-domain/portal/notifications/live'
import { mailedCode, portalBrowser } from '../../platform/auth/portal/testing/portal'
import { addUser, Browser, enrolTotp, type Answer } from '../../platform/auth/sessions/testing/harness'
import { asBrand, BRAND_ALPHA, type BrandFixture, type BrandInWorld, type Marker, type Seen } from '../portal/testing/two-brands'
import { admin, announce, call, ok, pdf, putBytes, stepped, type Method, type Person, type World } from '../testing/world'

/**
 * B-CP-022 — the money-wall sweep's world (customer page plan C4, O1–O3; design customer-page 11 §3; review E9): who is who, what
 * they are given THROUGH THE ROUTES, the made-up money of one order, and the helpers the sweep reads with. The sweep itself is
 * ./money-wall.pg.vitest.test.ts. It runs on the golden world (../testing/world.ts: every base seed, the real app and sign-in, every
 * outside provider FAKE) with the worker's handlers run in-process.
 *
 *   office   Owner · Accountant (prices: a role the Owner makes and gives) · Sales worker · Production manager · Planner ·
 *            Administrator · Finance · Factory designer (office role `designer`); and two for the brand wall and follow-up 2: a
 *            Finance limited to Brand Beta, and a Sales worker with a price role limited to Brand Alpha.
 *   portal   Brand Alpha's Buyer (its main portal person), Designer, Production and Viewer; Brand Beta's Buyer.
 *   money    SEED-SO-0002 (Brand Alpha, CONFIRMED; its work order SEED-WO-0001): the customer's PO ticked "shows prices", the
 *            customer's price per line (one Equal, one Not equal), its confirmation PDF (born priced), an Owner's note carrying the PO
 *            and a plain logo; Brand Beta's own order and its own PO.
 *
 * Every name, address, number and price is made up (example addresses only).
 */

type Json = Record<string, any>

/** The words of the money wall's refusals (the API's own; the sweep reads them back). */
export const WORDS = Object.freeze({
  notAPriceHolder: 'Shown to people who see prices.',
  onlyOwner: 'Only the Owner gives a role that sees prices.',
  fileNotFound: 'File not found.',
  notAFileOfThisOrder: 'Not a file of this order.',
  customerNotFound: 'Customer not found.',
  orderNotFound: 'Order not found.',
  portalNoPrices: 'Prices are not part of your access.',
})

/**
 * The money-looking keys: a selling price, a sum, a difference, a "not equal" flag or a count of disputes. None of them reaches a
 * person without the price grain (money.price on every contract field: the API drops the key, never sends it empty).
 */
export const PRICE_KEYS: readonly string[] = Object.freeze([
  'unitPrice',
  'listUnitPrice',
  'discountPct',
  'netAmount',
  'vatAmount',
  'grossAmount',
  'marginPct',
  'marginAmount',
  'ourPrice',
  'ourAmount',
  'ourUnitPrice',
  'brandPrice',
  'brandAmount',
  'brandUnitPrice',
  'priceMatch',
  'priceDiff',
  'priceNotEqualLines',
  'priceMissingLines',
  'priceOtherCurrency',
  'draftValueAmount',
  'priceNotEqualCount',
  'priceMissingCount',
])

/** Every key of an answer, at any depth. */
export const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
/** The money-looking keys an answer carries (none for a person without the price grain). */
export const priceKeysIn = (value: unknown): string[] => [...new Set(keysOf(value).filter((key) => PRICE_KEYS.includes(key)))].sort()
/** The issue paths of a refusal. */
export const pathsOf = (body: unknown): string[] => (((body as Json)?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))

// ---- who is who --------------------------------------------------------------------------------------------------------------

/** The office people of the sweep, by key. */
export type OfficeKey = 'owner' | 'accountant' | 'sales' | 'manager' | 'planner' | 'admin' | 'finance' | 'designer' | 'betaFinance' | 'alphaPriced'
/** The office people who see our prices (the Owner and the people the Owner names). */
export const PRICE_HOLDERS: readonly OfficeKey[] = Object.freeze(['owner', 'accountant', 'finance'])
/** The office people who see no price at all: the wall stands in front of every one of them on every surface. */
export const NO_PRICE: readonly OfficeKey[] = Object.freeze(['sales', 'manager', 'planner', 'admin', 'designer'])
/** "As Sales worker" and "as Production manager": the two the plan names on every surface. */
export const SALES_AND_MANAGER: readonly OfficeKey[] = Object.freeze(['sales', 'manager'])

/** Brand Alpha's people beside its Buyer (its main portal person, BRAND_ALPHA.portalPerson): made up. */
export const ALPHA_PEOPLE = Object.freeze({
  designer: { name: 'Dora Alfieri', email: 'dora.alfieri@brand-alpha.example' },
  production: { name: 'Pia Alfieri', email: 'pia.alfieri@brand-alpha.example' },
  viewer: { name: 'Vera Alfieri', email: 'vera.alfieri@brand-alpha.example' },
})
/** Brand Alpha's people who see no price (M-CP-2): its Designer, its Production person, its Viewer. */
export type AlphaNoPrice = keyof typeof ALPHA_PEOPLE

/** Every role key a customer's portal may offer (setUpBrand opens six; the sweep adds the customer's Production person). */
export const CUSTOMER_ROLE_KEYS = Object.freeze(['customer-buyer', 'customer-viewer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-production', 'customer-admin'])

/** The made-up words and names of the sweep's money (each found by the scan and the search, never by a person without prices). */
export const MONEY = Object.freeze({
  alphaPo: 'Brand Alpha PO MW-4471 ZQXMWPO.pdf',
  alphaPoToken: 'ZQXMWPO',
  // B-CP-022 (fix wave cp-fx8): the plain logo's token shares no letter triple with the priced PO's. The search finds a word that is
  // only similar (pg_trgm word_similarity ≥ 0.45): ZQXMWLOGO was 0.6 like ZQXMWPO, so M10's search for the priced name found the
  // note by its logo ("similar") — the priced name itself was never indexed (search/indexers/message.ts, B-CP-023).
  logo: 'Brand Alpha logo MW-4471 VKJLOGOBT.pdf',
  logoToken: 'VKJLOGOBT',
  betaPo: 'Brand Beta PO MW-7701.pdf',
  betaRef: 'BETA-PO-MW-7701',
  priceNote: 'MW: the customer’s PO, page 2',
  ownerNote: 'For the order file: the customer’s paper and the logo of the jackets.',
  draftRef: 'ALPHA-PO-MW-0001',
  draftWords: 'MW team jackets with the yellow piping on the collar',
})

let network = 120

/** A portal person of a brand, invited by the office through the routes (its role), signed in by the mailed code, first visit taken. */
export async function invitePortalPerson(w: World, office: Person, brand: BrandInWorld, member: { readonly name: string; readonly email: string }, roleKey: string, companyId: string): Promise<BrandInWorld> {
  await stepped(w, office)
  await ok(office, 'POST', `/partners/${brand.partyId}/people`, { email: member.email, displayName: member.name, locale: 'en', roleKey, companyId })
  return portalSignIn(w, brand.fixture, brand.partyId, member.email)
}

/** The portal's sign-in by code (as two-brands' setUpBrand signs its admin in), on a network of its own. */
export async function portalSignIn(w: World, fixture: BrandFixture, partyId: string, email: string): Promise<BrandInWorld> {
  const made: BrandInWorld = { fixture, partyId, browser: await portalBrowser(w.h, `198.51.100.${++network}`) }
  expect((await call(made.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email })).status).toBe(200)
  await w.h.auth.settled()
  const signedIn = await call(made.browser, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email, code: mailedCode(w.h, email)!.code })
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  const terms = (await call(made.browser, 'GET', '/portal/terms?locale=en')).body
  expect((await call(made.browser, 'POST', '/portal/first-visit', { noticeId: terms.notice.id, noticeLocale: terms.notice.locale, sha256: terms.notice.sha256 })).status).toBe(200)
  const me = (await call(made.browser, 'GET', '/portal/me')).body
  expect(me).toMatchObject({ termsDue: false, party: { id: partyId } })
  made.userId = me.user.id
  return made
}

/** The customer's portal offers every role (its Production person included): the office's settings, at their version. */
export async function offerEveryRole(w: World, office: Person, partyId: string): Promise<void> {
  const tab = await ok(office, 'GET', `/partners/${partyId}`)
  await stepped(w, office)
  await ok(office, 'POST', `/partners/${partyId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0, allowedRoleKeys: [...CUSTOMER_ROLE_KEYS] })
}

/** An office role's id by its key (`finance`, `sales`, `custom.accountant_prices`). */
export async function roleIdOf(by: Person, key: string): Promise<string> {
  const roles = (await ok(by, 'GET', '/auth/roles')).roles as Json[]
  const role = roles.find((entry) => entry.key === key)
  if (!role) throw new Error(`no role ${key} (roles: ${roles.map((entry) => entry.key).join(', ')})`)
  return role.id as string
}

/** A gift of a role: who gives it (a fresh step-up each), which role, limited to some customers or not. */
export interface Gift {
  readonly by: Person
  readonly roleId: string
  readonly partyIds?: readonly string[]
}

/**
 * An office person whose roles are GIVEN through the routes (POST /auth/users/:id/roles: only the Owner gives a role that sees prices),
 * signed in through the real sign-in, two-factor set up (a price role always asks it).
 */
export async function givenPerson(w: World, key: string, gifts: readonly Gift[]): Promise<Person> {
  const email = `${key.replace(/[A-Z]/g, (letter) => `.${letter.toLowerCase()}`)}@golden.example.com`
  const user = await addUser(w.h, w.tenant, { email })
  for (const gift of gifts) {
    await stepped(w, gift.by)
    await ok(gift.by, 'POST', `/auth/users/${user.id}/roles`, { roleId: gift.roleId, allCompanies: true, ...(gift.partyIds ? { partyIds: [...gift.partyIds] } : {}) })
  }
  const browser = new Browser(w.h.app)
  const answer = await browser.signIn(w.tenant.slug, user.email, user.password)
  if (answer.body?.status !== 'signed_in') throw new Error(`sign-in of ${key}: ${answer.status} ${JSON.stringify(answer.body)}`)
  const secret = await enrolTotp(w.h, browser)
  const made: Person = { key, id: user.id, email, role: 'given', browser, secret }
  w.people[key] = made
  return made
}

// ---- calls -------------------------------------------------------------------------------------------------------------------

/** An office person's call: the whole answer (the sweep asserts the status itself). */
export const as = (who: Person, method: Method, url: string, body?: unknown): Promise<Answer> => call(who.browser, method, url, body)

/**
 * A read behind the money wall for someone who sees no price: either it is refused by right (403 / 404: a wall too) or it answers
 * 200 and carries no money-looking key. Returns the body of a 200 (null when refused) for further checks.
 */
export async function noPriceIn(who: Person, url: string): Promise<Json | null> {
  const answer = await as(who, 'GET', url)
  if (answer.status !== 200) {
    expect([403, 404], `${who.key} GET ${url}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`).toContain(answer.status)
    return null
  }
  expect(priceKeysIn(answer.body), `${who.key} GET ${url}: a price key reached a person who sees no price`).toEqual([])
  return answer.body as Json
}

/** The same for a brand's portal person (every answer kept for the T00 scan). */
export async function brandNoPriceIn(brand: BrandInWorld, seen: Seen[], who: string, url: string): Promise<Json | null> {
  const body = await asBrand(brand, seen, 'GET', url, undefined, null)
  const last = seen.at(-1)!
  if (last.status !== 200) {
    expect([403, 404], `${who} GET ${url}: ${last.status} ${JSON.stringify(body).slice(0, 300)}`).toContain(last.status)
    return null
  }
  expect(priceKeysIn(body), `${who} GET ${url}: a price key reached a brand person who sees no price`).toEqual([])
  return body as Json
}

/** A file of a record through the real routes as the Owner: announced (shared as asked, ticked "shows prices" or not), bytes sent, completed. */
export async function upload(w: World, by: Person, companyId: string, owner: Json, name: string): Promise<Json> {
  const body = pdf(name)
  const announced = await ok(by, 'POST', '/files', { companyId, kind: 'DOCUMENT', ...owner, ...announce(name, body) }, 201)
  await putBytes(w, announced, body)
  const done = await ok(by, 'POST', `/files/${announced.file.id}/complete`)
  expect(done.file.status).toBe('AVAILABLE')
  return done.file as Json
}

// ---- the live wall -----------------------------------------------------------------------------------------------------------

/** What a portal session may ever hold (every partner permission): the most a brand person could see live. */
const PORTAL_PERMISSIONS = FACTORY_PERMISSIONS.all.filter((definition) => definition.partner === true).map((definition) => definition.name) as Permission[]

/** An office person's live viewer: the permissions its session holds now (GET /auth/office/me), over every customer. */
export async function officeActor(w: World, who: Person): Promise<Actor> {
  const me = await ok(who, 'GET', '/auth/office/me')
  return { audience: 'office', tenantId: w.tenant.id, grants: [{ permissions: me.permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' }] }
}
/** A brand's live viewer with every partner permission (the most a portal person of that brand could hold). */
export const portalActor = (w: World, partyId: string): Actor => ({ audience: 'partner', tenantId: w.tenant.id, partyId, grants: [{ permissions: PORTAL_PERMISSIONS, companies: 'all', sites: 'all', parties: [partyId] }] })

interface OutboxRow {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly context: string
  readonly tenantId: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly subject: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly source: string
  readonly occurredAt: Date
  readonly payload: Json
}

/** The live messages of an event type about one subject (as the live relay would make them), null where the event has no live rule. */
export async function liveMessagesOf(w: World, type: string, subject: string) {
  const rows = await admin<OutboxRow>(
    w,
    `SELECT id::text AS id, type, version, context, "tenantId"::text AS "tenantId", "companyId"::text AS "companyId", "siteId"::text AS "siteId", subject, "correlationId", "causationId", source, "occurredAt", payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`,
    [w.tenant.id, type, subject],
  )
  return rows.map((row) => {
    const definition = EVENT_CATALOGUE.find(row.type, row.version)
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload } as EventEnvelope
    return { row, message: definition ? liveMessageFor(envelope, definition) : null }
  })
}
export const officeLive = (message: NonNullable<Awaited<ReturnType<typeof liveMessagesOf>>[number]['message']>, viewer: Actor) => liveViewFor(message, viewer, EVENT_CATALOGUE)
export const portalLive = (message: NonNullable<Awaited<ReturnType<typeof liveMessagesOf>>[number]['message']>, viewer: Actor) => partnerLiveViewFor(message, viewer, EVENT_CATALOGUE)

// ---- the brand wall's scan ---------------------------------------------------------------------------------------------------

/** Brand Alpha's own people's names and addresses: markers Brand Beta must never read. */
export const alphaPeopleMarkers = (): Marker[] => [
  ...Object.values(ALPHA_PEOPLE).flatMap((member) => [
    { label: 'portal person name', text: member.name },
    { label: 'portal person address', text: member.email },
  ]),
  { label: 'file name', text: MONEY.alphaPo },
  { label: 'file name', text: MONEY.logo },
  { label: 'order request reference', text: MONEY.draftRef },
  { label: 'draft words', text: MONEY.draftWords },
]

/** The fixture of Brand Alpha (its legal name is what the office's answers name it by). */
export const ALPHA = BRAND_ALPHA
