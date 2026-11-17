import { expect, type BrowserContext, type Page } from '@playwright/test'
import type { BrandFixture } from '../../../src/lib/testing/two-brands'
import { COMPANY, TENANT, type Desk, type Flow } from './flow'
import { words } from './words'

/**
 * B-TH-227 — TWO CUSTOMERS IN THEIR PORTALS for the browser golden flows of the threads plan (TH-1b and after; the screens' twin
 * of the API's golden-flow/portal/testing/two-brands.ts setUpBrand). An office person makes a seeded customer into one of the two
 * made-up brands of src/lib/testing/two-brands.ts THROUGH THE ROUTES (its names, code and the customer and brand roles, the
 * fixture's contact and address, its portal opened, its portal person invited as the customer's buyer — who sends requests —
 * with the comment capability), then that person signs in THROUGH THE PORTAL'S SCREENS in a browser context of their own: the
 * work e-mail on Sign in, the sign-in link the FAKE mailbox holds, Continue, and the first visit (name, the portal terms ticked,
 * "Go to my portal"). Every name and address is made up (`example.com`-style addresses of the fixture).
 */

const SIGN_IN = words('portal-signin')

/** The portal roles the customer's portal offers (the API golden flow's list). */
const OFFERED = ['customer-buyer', 'customer-viewer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-admin']

export interface PortalDesk {
  readonly brand: BrandFixture
  readonly partyId: string
  /** The party's code: its portal lives at `/p/<code>`. */
  readonly code: string
  readonly context: BrowserContext
  readonly page: Page
  /** Opens a page of the customer's portal: `/p/<code><path>`. */
  go(path: string): Promise<void>
}

/** A fresh office step-up (the next authenticator code) before a signing act of the set-up. */
async function steppedUp(flow: Flow, office: Desk): Promise<void> {
  await flow.write(office.page, 'POST', '/auth/office/step-up', { code: await flow.code(office.person) })
}

/** The office makes the seeded party into `brand` with its portal open and its buyer invited (writes outside the screens). */
export async function setUpBrand(flow: Flow, office: Desk, brand: BrandFixture, partyId: string): Promise<void> {
  const { page } = office
  const party = (await flow.read(page, `/parties/${partyId}`)).party
  await flow.write(page, 'PATCH', `/parties/${partyId}`, { version: party.version, legalName: brand.legalName, tradeName: brand.tradeName, code: brand.code, roles: ['CUSTOMER', 'BRAND'] })
  await flow.write(page, 'POST', `/parties/${partyId}/contacts`, { name: brand.contact.name, email: brand.contact.email, roles: ['ORDERS', 'INVOICES'] }, 201)
  await flow.write(page, 'POST', `/parties/${partyId}/addresses`, { kinds: ['BILL_TO', 'SHIP_TO'], name: brand.legalName, ...brand.address }, 201)
  const tab = await flow.read(page, `/partners/${partyId}`)
  await steppedUp(flow, office)
  await flow.write(page, 'POST', `/partners/${partyId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0, allowedRoleKeys: OFFERED })
  await steppedUp(flow, office)
  await flow.write(page, 'POST', `/partners/${partyId}/people`, { email: brand.portalPerson.email, displayName: brand.portalPerson.name, locale: 'en', roleKey: 'customer-buyer', capabilities: ['comment'], companyId: flow.companyId })
}

// ---- B-TH-284 / B-TH-247 / B-TH-254 (UI golden flows TH-7, TH-4, TH-5): each stage runs alone on a fresh stack (`--stages th7-files`)
// or after another stage of the same run (th1b-request made the two brands already): the set-up runs once per party.
/** setUpBrand unless the party is that brand already (its code): a later stage of the run, or a kept stack, reuses it. */
export async function ensureBrand(flow: Flow, office: Desk, brand: BrandFixture, partyId: string): Promise<void> {
  const party = (await flow.read(office.page, `/parties/${partyId}`)).party as { code?: string }
  if (party.code === brand.code) return
  await setUpBrand(flow, office, brand, partyId)
}
// ---- end B-TH-284 / B-TH-247 / B-TH-254

/** A desktop browser context of the portal (English, the company's time zone), traced, closed at the end of the run. */
async function portalContext(flow: Flow, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await flow.browser.newContext({ baseURL: flow.web, viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/Rome', colorScheme: 'light' })
  await context.addCookies([{ name: 'factory_locale', value: 'en', url: flow.web }])
  await context.tracing.start({ screenshots: true, snapshots: true, title: name })
  flow.onClose(async () => {
    await context.tracing.stop({ path: `${flow.out}/traces/${name}.zip` }).catch(() => {})
    await context.close().catch(() => {})
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => flow.problems.push(`${flow.stage} ${name}: page error: ${error.message}`))
  return { context, page }
}

/** The brand's portal person signs in through the portal's screens: e-mail → the mailed link → Continue → the first visit. */
export async function signInToPortal(flow: Flow, brand: BrandFixture, partyId: string): Promise<PortalDesk> {
  const { context, page } = await portalContext(flow, `portal-${brand.key}`)
  const email = brand.portalPerson.email
  const before = await flow.mailsTo(email)
  await page.goto(`/p/signin?tenant=${TENANT}&company=${COMPANY}&next=${encodeURIComponent(`/p/${brand.code}`)}`)
  await page.getByLabel(SIGN_IN('email.label'), { exact: true }).fill(email)
  await page.getByRole('button', { name: SIGN_IN('email.submit'), exact: true }).click()
  await expect(page.getByRole('heading', { name: SIGN_IN('code.title') })).toBeVisible({ timeout: 60_000 })
  // The mail holds a link and a code; the link opens the page that signs in only on Continue.
  const link = await flow.linkSentTo(email, before)
  await page.goto(link.url.replace(/^https?:\/\/[^/]+/, flow.web))
  await page.getByRole('button', { name: SIGN_IN('link.continue'), exact: true }).click({ timeout: 60_000 })
  // The first visit: the name (prefilled from the invitation), the summaries, the portal terms ticked.
  const accept = page.getByRole('checkbox', { name: new RegExp(`^${SIGN_IN('first.accept', { company: '__' }).split('__')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
  await accept.waitFor({ state: 'visible', timeout: 60_000 })
  const name = page.getByLabel(SIGN_IN('first.name'), { exact: true })
  if ((await name.inputValue()).trim() === '') await name.fill(brand.portalPerson.name)
  await accept.check()
  await page.getByRole('button', { name: SIGN_IN('first.submit'), exact: true }).click()
  await page.waitForURL(new RegExp(`/p/${brand.code}(/|$|\\?)`), { timeout: 120_000 })
  return { brand, partyId, code: brand.code, context, page, go: async (path) => void (await page.goto(`/p/${brand.code}${path}`)) }
}
