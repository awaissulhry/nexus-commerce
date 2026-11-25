import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA } from '../../src/lib/testing/two-brands'
import { expectNothingOf } from './_harness/brand-scan'
import { COMPANY, seen, TENANT, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { words } from './_harness/words'

/**
 * F-CP-158 — UI golden flow CP-PORTAL-DRAFT: THE BRAND'S ONE DRAFT ORDER (customer page plan C5, C7; design customer-page 12 §2–§3, §5;
 * picture 22; money wall M-CP-2; brand wall W-CP-1). Runs right after th9-order-page (stages.ts AFTER_STAGES '16-close') or alone on a
 * fresh stack (`--stages cp-portal-draft`): it makes the world it needs — the seeded P1 as Brand Alpha with its portal buyer
 * (two-brands.ts), the brand's Designer invited by the office, Sara Sales named the brand's factory designer (Who looks after). Then,
 * KEYBOARD ONLY (focus and Enter / Space; no pointer on the screens the stage proves):
 *   1  the Designer starts a new draft — od-fx5, THE SIMPLE ORDER START (R1): a mail and ONE products table, no Start button and no
 *      ways; below the brand's drafts to continue (the seed's own among them). "Add a product", reached by Tab, draws an empty row
 *      and starts NOTHING (no draft on a click); the row's Product in its own words, Enter, is the first input that makes the draft
 *      (the address keeps it). It reads no price anywhere (no Price card, no Your price field, no amount, no currency), and finds
 *      Send held in words (a colleague who may order sends it; nothing required, so no missing cell holds it);
 *   2  the Designer asks the factory designer in the draft's own conversation (the box "Ask <name>, factory designer"): "We asked
 *      <name>." — the office's thread of the draft carries the office-only note that mentions the designer (never shown in the portal);
 *   3  the Buyer opens the same draft (the address keeps it), reads its Your price part, and sends it to the factory: the office reads
 *      the request SENT;
 *   4  every page of the stage shows nothing of Brand Beta (the DOM name scan, brand-scan.ts).
 * Every name and word is made up.
 */

const OR = words('portal-ordering')
const DW = words('order-draft') // od-fx5: the ONE draft order's shared part (the mail, the products table, Send, Your price)
const PT = words('portal')
const RTP = words('record-thread-partner') // pt-w2 W2.4: the portal box's own words (the partner face's)
const SIGN_IN = words('portal-signin')

/** Brand Alpha's Designer (made up): starts and fills drafts, sees no price, never sends. */
const DESIGNER = { name: 'Dora Alfieri', email: 'dora.alfieri.cp158@brand-alpha.example' }
/** The draft's own words (none of them a fixture marker of either brand). */
const DRAFT_START = 'Made-up: team jackets CP-158 with the yellow piping'
const DRAFT_WORDS = `${DRAFT_START} on the collar`
const ASK_WORDS = 'Made-up: can our factory designer check the yellow of the piping?'

/** The keyboard: focus a control and press a key (Enter: a button or a row; Space: a checkbox). */
async function keyOn(control: Locator, key: 'Enter' | 'Space' = 'Enter'): Promise<void> {
  await control.waitFor({ state: 'visible', timeout: 60_000 })
  await control.focus()
  await control.page().keyboard.press(key)
}
/**
 * F-CP-158 follow-up (cp-fx10): Tab from where the page left the focus until `control` holds it — the keyboard's own way to a control
 * (fails when Tab never reaches it).
 */
async function tabTo(control: Locator, most = 80): Promise<void> {
  await control.waitFor({ state: 'visible', timeout: 60_000 })
  for (let press = 0; press < most; press++) {
    await control.page().keyboard.press('Tab')
    if (await control.evaluate((element) => element === document.activeElement)) return
  }
  throw new Error(`Tab never reached ${String(control)} in ${most} presses`)
}
/** Types into a field from the keyboard (focus, then the characters). */
async function typeInto(field: Locator, text: string): Promise<void> {
  await field.waitFor({ state: 'visible', timeout: 60_000 })
  await field.focus()
  await field.page().keyboard.type(text)
}

/** A desktop portal context of its own (English, the company's time zone), traced, closed at the end of the run. */
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

/** A brand person other than its buyer signs in through the portal's screens (the e-mail, the mailed link, Continue, the first visit). */
async function signInAs(flow: Flow, partyId: string, member: { name: string; email: string }): Promise<PortalDesk> {
  const { context, page } = await portalContext(flow, 'portal-alpha-designer')
  const before = await flow.mailsTo(member.email)
  await page.goto(`/p/signin?tenant=${TENANT}&company=${COMPANY}&next=${encodeURIComponent(`/p/${BRAND_ALPHA.code}`)}`)
  await page.getByLabel(SIGN_IN('email.label'), { exact: true }).fill(member.email)
  await page.getByRole('button', { name: SIGN_IN('email.submit'), exact: true }).click()
  await expect(page.getByRole('heading', { name: SIGN_IN('code.title') })).toBeVisible({ timeout: 60_000 })
  const link = await flow.linkSentTo(member.email, before)
  await page.goto(link.url.replace(/^https?:\/\/[^/]+/, flow.web))
  await page.getByRole('button', { name: SIGN_IN('link.continue'), exact: true }).click({ timeout: 60_000 })
  const accept = page.getByRole('checkbox', { name: new RegExp(`^${SIGN_IN('first.accept', { company: '__' }).split('__')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
  const home = new RegExp(`/p/${BRAND_ALPHA.code}(/|$|\\?)`)
  let due = false
  await expect(async () => {
    due = await accept.isVisible()
    expect(due || home.test(page.url()), 'the first visit or the portal').toBe(true)
  }).toPass({ timeout: 60_000 })
  if (due) {
    const name = page.getByLabel(SIGN_IN('first.name'), { exact: true })
    if ((await name.inputValue()).trim() === '') await name.fill(member.name)
    await accept.check()
    await page.getByRole('button', { name: SIGN_IN('first.submit'), exact: true }).click()
  }
  await page.waitForURL(home, { timeout: 120_000 })
  return { brand: BRAND_ALPHA, partyId, code: BRAND_ALPHA.code, context, page, go: async (path) => void (await page.goto(`/p/${BRAND_ALPHA.code}${path}`)) }
}

/** The portal record frame's docked conversation of the page. */
const dockOf = (page: Page): Locator => page.locator('.fw-prf[data-mode="docked"] > aside#messages')

export default defineStage({
  proves:
    'the brand’s one draft order, keyboard only: its Designer starts it in its own words and reads no price, finds Send held in words, asks the factory designer in the draft’s conversation (the office-only note mentions the designer); its Buyer opens the same draft and sends it; nothing of Brand Beta on any page',
  async run(flow: Flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const designerOfOffice = await flow.person('sales')

    const set = await flow.step('set-up: P1 as Brand Alpha with its buyer; its Designer invited; Sara Sales named the brand’s factory designer', async () => {
      await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
      const tab = await flow.read(sales.page, `/partners/${alphaId}`)
      const known = JSON.stringify(tab).toLowerCase().includes(DESIGNER.email)
      if (!known) {
        await flow.write(sales.page, 'POST', '/auth/office/step-up', { code: await flow.code(sales.person) })
        await flow.write(sales.page, 'POST', `/partners/${alphaId}/people`, { email: DESIGNER.email, displayName: DESIGNER.name, locale: 'en', roleKey: 'customer-designer', capabilities: ['comment', 'upload'], companyId: flow.companyId })
      }
      const slot = (await flow.read(sales.page, `/partners/${alphaId}/factory-designer`)).factoryDesigner
      const named = (await flow.write(sales.page, 'PUT', `/partners/${alphaId}/factory-designer`, { designerId: designerOfOffice.id, backupId: null, version: slot.version })).factoryDesigner
      return { designerName: named.designer.name as string }
    })

    const designer = await signInAs(flow, alphaId, DESIGNER)
    // F-CP-158 follow-up (cp-fx10): the brand's drafts as the office lists them (design 12 §3: per customer).
    const draftsOfAlpha = async () => ((await flow.read(sales.page, `/sales/order-requests?status=DRAFT&partyId=${alphaId}`)).requests as { id: string }[]).map((row) => row.id)
    const draftId = await flow.step('1 · the Designer starts the draft in its own words (keyboard only) and reads no price; Send held in words', async () => {
      const { page } = designer
      // od-fx5 (R1): the start is the mail and ONE products table — no ways, no Start button — below the brand's drafts to continue
      // (the seed's own draft among them, never deleted). Nothing is saved until the first input: a keyboard user Tabs to "Add a
      // product", Enter draws an empty row (its Product focused) and starts NO draft; the row's words, then Enter, make a NEW draft.
      const before = await draftsOfAlpha()
      await designer.go('/orders/new')
      if (before.length > 0) await seen(page.getByRole('heading', { name: DW('start.continue'), exact: true }), 60_000)
      await seen(page.getByRole('heading', { name: DW('tbl.title'), exact: true }), 60_000)
      const add = page.getByRole('button', { name: DW('add.product'), exact: true })
      await tabTo(add)
      await page.keyboard.press('Enter')
      const product = page.getByLabel(DW('col.product'), { exact: true })
      await expect(product, '"Add a product" draws one empty row, its Product focused').toHaveCount(1, { timeout: 60_000 })
      await expect(product).toBeFocused()
      await page.waitForTimeout(1_500) // a draft made on the click would be there by now
      expect(page.url(), '"Add a product" alone starts no draft').not.toMatch(/[?&]draft=/)
      expect(await draftsOfAlpha(), '"Add a product" alone starts no draft').toEqual(before)
      await page.keyboard.type(DRAFT_WORDS)
      await page.keyboard.press('Enter') // the row's first input: it makes the draft and the row
      await expect(page).toHaveURL(/[?&]draft=[0-9a-f-]{36}/, { timeout: 60_000 })
      const id = new URL(page.url()).searchParams.get('draft')!
      await expect(page.getByLabel(DW('col.product'), { exact: true }).first()).toHaveValue(DRAFT_WORDS, { timeout: 60_000 })
      // F-CP-158 follow-up (cp-fx10): a new draft beside the ones there were; those stay.
      expect(before, 'the first input starts a new draft').not.toContain(id)
      await expect.poll(draftsOfAlpha, { timeout: 60_000 }).toEqual(expect.arrayContaining([...before, id]))
      // M-CP-2: no price anywhere — no Price card, no Your price field, no amount, no currency on the page.
      const send = page.getByRole('button', { name: DW('send.title'), exact: true }).first()
      await seen(send, 60_000)
      await expect(page.getByRole('heading', { name: DW('price.title'), exact: true })).toHaveCount(0)
      await expect(page.getByLabel(DW('price.yours'))).toHaveCount(0)
      expect(await page.locator('body').innerText(), 'no money on the Designer’s draft').not.toMatch(/€|\bEUR\b/)
      // Send held for one who may not order, said in words (the colleagues who may send it, or "ask your admin") — never by a cell.
      await expect(send).toHaveAttribute('aria-disabled', 'true')
      const heldPrefix = OR('draftPage.sendHeldNone').split(':')[0]!
      await expect(send).toHaveAttribute('aria-description', new RegExp(`^${heldPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      await expectNothingOf(page, BRAND_BETA, [], 'Brand Alpha’s Designer: the draft')
      await flow.shot(page, 'cp-draft-designer')
      return id
    })

    await flow.step('2 · the Designer asks the factory designer in the draft’s conversation: "We asked <name>." — the office-only note mentions the designer', async () => {
      const { page } = designer
      const dock = dockOf(page)
      await seen(dock, 60_000)
      await typeInto(dock.getByRole('textbox', { name: RTP('box'), exact: true }), ASK_WORDS)
      const ask = page.getByRole('checkbox', { name: PT('thread.designer.ask', { name: set.designerName }) })
      await keyOn(ask, 'Space')
      await expect(ask).toBeChecked()
      await keyOn(dock.getByRole('button', { name: RTP('send'), exact: true }))
      await seen(page.getByText(PT('thread.designer.asked', { name: set.designerName })).first(), 60_000)
      await seen(dock.getByText(ASK_WORDS).first(), 60_000)
      await flow.settle()
      // The office reads the office-only note that mentions its designer; the portal never shows it.
      const thread = JSON.stringify(await flow.read(sales.page, `/threads/PortalOrderRequest/${draftId}`))
      expect(thread).toContain('asks the factory designer')
      expect(await page.locator('body').innerText()).not.toContain('asks the factory designer')
      await expectNothingOf(page, BRAND_BETA, [], 'Brand Alpha’s Designer: the draft’s conversation')
      await flow.shot(page, 'cp-draft-designer-asked')
    })

    await flow.step('3 · the Buyer opens the same draft (keyboard only), reads its Your price part, and sends it to the factory', async () => {
      const buyer = await signInToPortal(flow, BRAND_ALPHA, alphaId)
      const { page } = buyer
      await buyer.go(`/orders/new?draft=${draftId}`)
      // F-CP-158 follow-up (cp-fx10): a row in its own words names the draft, cut at 60 characters (od- R2: the band's "Draft order ·
      // <title>"): the start of the Designer's words names the same draft; od-fx5 (R1): its Product cell holds them whole.
      await seen(page.getByText(DRAFT_START).first(), 60_000)
      await expect(page.getByLabel(DW('col.product'), { exact: true }).first()).toHaveValue(DRAFT_WORDS, { timeout: 60_000 })
      // od-fx5 (R1): the Buyer's own card "Your price" (a price holder's, one row per product).
      await seen(page.getByRole('heading', { name: DW('price.title'), exact: true }), 60_000)
      await expectNothingOf(page, BRAND_BETA, [], 'Brand Alpha’s Buyer: the draft')
      await keyOn(page.getByRole('button', { name: DW('send.title'), exact: true }).first())
      await expect.poll(async () => ((await flow.read(sales.page, `/sales/order-requests/${draftId}`)).request as { status: string }).status, { timeout: 60_000 }).toBe('SENT')
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await seen(page.getByText(new RegExp(`${escape(OR('band.sentTitle'))}|${escape(OR('draftPage.sentThread'))}`)).first(), 60_000)
      await expectNothingOf(page, BRAND_BETA, [], 'Brand Alpha’s Buyer: the sent draft')
      await flow.shot(page, 'cp-draft-sent')
      await flow.settle()
    })
  },
})
