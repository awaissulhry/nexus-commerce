import { expect, test, type Locator, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../../src/lib/testing/two-brands'
import { brandMarkersIn, expectNothingOf, pageWords } from './_harness/brand-scan'
import { seen, type Desk, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { day, dialog, press } from './_harness/ui'
import { startsWith, words } from './_harness/words'

/**
 * B-TH-281 — UI golden flow TH-6: THE RECORD PAGES ON THE RECORD FRAME (threads plan TH-6; P-CUS-ORD.thread, O-SAL-QUO-REC.thread,
 * PL1, PL3, R-ACT; wall W02, W08, W09, W10, W36 — the screens' side of the record frame rollout, B-TH-255…277 and B-TH-280). On the
 * local stack the browser golden flow starts (its own throwaway database, every outside service FAKE); it needs no other stage
 * before it and runs after th1b-request / th7-files / th4-sheet / th5-projects too (the two customers are made once: ensureBrand):
 *   S   the sales office makes the seeded P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal
 *       buyer; set-up: an order for A (the seeded jacket) and a quote for A; the buyer opens the seeded supplier P2's portal with an
 *       order desk of this stage; every portal person signs in through the portal's screens;
 *   1   customer A's buyer opens its order in the portal: at 1440 px the order's ONE conversation is DOCKED beside the tabs
 *       (`#messages`, the portal record frame), no Messages tab; the band names the order by A's own reference ("Your order
 *       ALPHA-PO-0042"), never the office's SO- series; at 1024 px the "Messages" button opens the conversation full width and Back
 *       returns; A writes in the docked conversation;
 *   2   the same buyer reports a quality problem on the order (Returns & claims' start, the claim's type): the case page docks its
 *       conversation the same way and A writes there;
 *   3   the office (sales) opens the order on the record frame: the thread docked (`.fw-rcf-dock`), A's message in it; the reply to
 *       Brand Alpha goes through the send check, which lists A's contact only; a message "In the portal only" follows; the Head's ⋯
 *       holds Activity's doors (R-ACT): "Ask a partner to approve" opens the Ask dialog to Brand Alpha only (cancelled: every kind an
 *       order takes needs a file — TH-7 proves the files), "Share with a partner" offers A's contacts only and invites A's contact;
 *       the quote opens on the record frame with its thread docked, the box offering Brand Alpha only, and takes an office note;
 *   4   customer A reads the office's portal message in its order's docked conversation;
 *   T00 customer B (Home, Orders & requests, Returns & claims, the addresses of A's order, case and quote, and the generic `/open/`
 *       addresses of A's records) and the supplier's order desk (Home and the generic `/open/` addresses of A's order, quote and case):
 *       every page passes the DOM name scan — no name, code, contact, reference, number or id of Brand Alpha, nor the run's numbers,
 *       ids and messages — and each address of A's records answers the neutral refusal ("Order not found", "Case not found",
 *       "Record not found"), which never names another customer.
 * Writes outside the screens (no screen of this stage does them; set-up only): the brands' set-up (two-brands.ts), A's order (POST
 * /sales/orders/manual) and quote (POST /sales/quotes) as sales, the supplier portal and its order desk's invitation as the buyer with
 * their step-ups. A return (RMA) needs delivered goods (a shipment): the case of this stage is the claim, the other case kind of the
 * same Returns & claims pages (CaseRecordView, the same docked frame).
 */

const PO = words('portal-orders')
const RET = words('portal-returns')
const PORTAL = words('portal')
const HOME = words('portal-customer-home')
const SUPPLIER = words('portal-supplier-orders')
const BOX = words('record-thread-composer')
const CHECK = words('record-thread-send')
const HEAD = words('record-thread-head')
const ASK = words('record-approvals')
const SHARE = words('record-shares')
const DS = words('ds-words')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence as a regular expression: its placeholders match anything. */
const shaped = (text: string) => new RegExp(escape(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.+'))

/** The made-up words of this stage (each its own, so the scans can name them). */
const FROM_ALPHA = 'Made-up from Brand Alpha on its order: can the sleeves be two centimetres longer?'
const CASE_TEXT = 'Made-up claim of Brand Alpha: the zip of one jacket opens by itself.'
const CASE_MORE = 'Made-up from Brand Alpha on its claim: the jacket is size 52.'
const REPLY = 'Made-up reply by mail: yes, the sleeves can be two centimetres longer.'
const TO_ALPHA = 'Made-up to Brand Alpha in the portal: the longer sleeves are noted on your order.'
const NOTE = 'Made-up office note on the quote: wait for the new sleeve length before the price.'
/** The seeded supplier's order desk of THIS stage (another address than TH-5's: both may run on one stack). */
const DESK = { name: 'Delia Desk', email: 'desk.th6@supplier-p2.example.com' }

type Json = Record<string, any>
type Made = { id: string; number: string }

/**
 * How customer A's portal names its order (B-TH-275, plan §0.5): "Your order <its own number>" when the order has the customer's own
 * count, else "Your order <its own reference>" — never the office's series.
 */
function ownOrderName(): RegExp {
  const [before, after] = PO('record.titleRef', { ref: '§' }).split('§')
  return new RegExp(`^${escape(before!)}(?:\\d+|${escape(BRAND_ALPHA.customerRef)})${escape(after ?? '')}$`)
}

/** The page shows nothing of `brand` nor the run's own words of it; a screenshot for the record. */
async function scanned(flow: Flow, page: Page, brand: BrandFixture, extra: readonly string[], where: string): Promise<void> {
  await expectNothingOf(page, brand, extra, where)
  await flow.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
}

/** A fresh office step-up (the next authenticator code) before a signing act of the set-up. */
async function steppedUp(flow: Flow, office: Desk): Promise<void> {
  await flow.write(office.page, 'POST', '/auth/office/step-up', { code: await flow.code(office.person) })
}

/** The buyer opens P2's supplier portal (once) and invites this stage's order desk (once); writes outside the screens. */
async function ensureDesk(flow: Flow, buyer: Desk, supplierId: string): Promise<void> {
  const { page } = buyer
  const tab = await flow.read(page, `/partners/${supplierId}`)
  if (!tab.settings?.portalOn) {
    await steppedUp(flow, buyer)
    await flow.write(page, 'POST', `/partners/${supplierId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0 })
  }
  const people = ((await flow.read(page, `/partners/${supplierId}`)).people ?? []) as Json[]
  if (people.some((person) => String(person.email).toLowerCase() === DESK.email)) return
  await steppedUp(flow, buyer)
  await flow.write(page, 'POST', `/partners/${supplierId}/people`, { email: DESK.email, displayName: DESK.name, locale: 'en', kind: 'SUPPLIER', roleKey: 'supplier-orders', capabilities: ['comment'], companyId: flow.companyId })
}

/** The portal record frame's docked conversation (B-TH-273): `#messages` beside the body, from 1280 px. */
function portalDock(page: Page): Locator {
  return page.locator('.fw-prf[data-mode="docked"] > aside#messages')
}

/** Writes in a portal page's docked conversation (the DS PartnerThread's box) and waits for the message in it. */
async function writeInDock(page: Page, text: string): Promise<void> {
  const dock = portalDock(page)
  await dock.getByRole('textbox', { name: DS('partnerThread.composer'), exact: true }).fill(text)
  await dock.getByRole('button', { name: DS('partnerThread.send'), exact: true }).click()
  await seen(dock.getByText(text), 60_000)
}

/** The office record frame's docked thread (B-TH-213): the dock beside the body at 1440 px, with its Head. */
function officeDock(page: Page): Locator {
  return page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock')
}

/** Opens the Head's ⋯ (Thread tools) and picks one of Activity's doors (R-ACT): a menu line that must not be held. */
async function openDoor(page: Page, record: string, door: 'act.approve' | 'act.share'): Promise<void> {
  const head = officeDock(page).getByRole('group', { name: HEAD('label', { record }) })
  await seen(head, 60_000)
  await head.getByRole('button', { name: HEAD('more.label'), exact: true }).click()
  const line = page.getByRole('menuitem', { name: startsWith(HEAD(door)) })
  await seen(line)
  await expect(line, `${HEAD(door)} is offered (R-ACT), not held`).toBeEnabled()
  await line.click()
}

export default defineStage({
  proves:
    'customer A writes in its order’s and its claim’s docked conversation in the portal (its own reference, never the SO- series; the Messages button below 1280 px); the office reads it on the order’s record frame, replies through the send check (A’s contact only), posts in the portal, and the Head’s ⋯ asks and shares with Brand Alpha only; the quote’s thread is docked too; A reads the answer; customer B’s and the supplier’s pages pass the DOM name scan and A’s records answer the neutral refusal',
  async run(flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')
    const supplierId = await flow.seedId('party:P2')
    type Run = { order: Made; quote: Made; claim: Made; supplierCode: string }
    const run = {} as Run

    Object.assign(
      run,
      await flow.step('the sales office makes P1 Brand Alpha and P3 Brand Beta; set-up: an order and a quote for A, P2’s supplier portal with an order desk', async () => {
        await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
        await ensureBrand(flow, sales, BRAND_BETA, betaId)
        const made = await flow.write(
          sales.page,
          'POST',
          '/sales/orders/manual',
          {
            companyId: flow.companyId,
            partyId: alphaId,
            customerRef: BRAND_ALPHA.customerRef,
            promiseDate: day(45),
            depositPct: null,
            lines: [{ styleId: await flow.seedId('product:style:JKT-01'), colourwayId: await flow.seedId('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }],
          },
          201,
        )
        const quoted = await flow.write(sales.page, 'POST', '/sales/quotes', { companyId: flow.companyId, partyId: alphaId }, 201)
        const buyer = await flow.desk('buyer')
        await ensureDesk(flow, buyer, supplierId)
        await flow.settle()
        const supplierCode = (await flow.read(buyer.page, `/parties/${supplierId}`)).party.code as string
        return {
          order: { id: made.order.id as string, number: made.order.number as string },
          quote: { id: quoted.quote.id as string, number: quoted.quote.number as string },
          supplierCode,
        }
      }),
    )

    // Not a kept step: a run attached to a kept stack (FACTORY_BGF_RESUME) signs every portal person in again in its new browser.
    const { alpha, beta, desk } = await test.step('each portal person signs in through the portal’s screens (the mailed link, Continue, the first visit)', async () => {
      const supplier = { ...BRAND_BETA, key: 'supplier' as unknown as BrandFixture['key'], code: run.supplierCode, portalPerson: DESK } satisfies BrandFixture
      return {
        alpha: await signInToPortal(flow, BRAND_ALPHA, alphaId),
        beta: await signInToPortal(flow, BRAND_BETA, betaId),
        desk: await signInToPortal(flow, supplier, supplierId),
      }
    })

    await flow.step('customer A opens its order: the conversation docked at 1440 px, its own reference only, the Messages button at 1024 px; A writes', async () => {
      const { page } = alpha
      await alpha.go(`/orders/${run.order.id}`)
      // The band names the order as A knows it: its own number ("Your order 3") or, without one, its own reference.
      await seen(page.locator('.fw-pband').getByText(ownOrderName()), 60_000)
      // ONE conversation, docked beside the four tabs (B-TH-275): no Messages tab, no "Messages" button at this width.
      const dock = portalDock(page)
      await seen(dock, 60_000)
      await expect(dock).toHaveAttribute('aria-label', new RegExp(`^${escape(PO('messages.label', { name: '§' })).replace('§', ownOrderName().source.slice(1, -1))}$`))
      await expect(page.getByRole('tab', { name: startsWith(PO('row.messages')) })).toHaveCount(0)
      await expect(page.locator('.fw-prf-bar')).toHaveCount(0)
      // The customer's own number only (plan §0.5): never the office's SO- series, never its id in words.
      expect(await pageWords(page), 'A’s order page names the office number').not.toContain(run.order.number)
      await flow.shot(page, 'alpha-order-docked')

      // Below 1280 px: the body leads, "Messages" opens the conversation full width, Back returns to the same tab.
      await page.setViewportSize({ width: 1024, height: 900 })
      await seen(page.locator('.fw-prf[data-mode="stacked"]'), 30_000)
      const open = page.locator('.fw-prf-bar').getByRole('button', { name: startsWith(PORTAL('record.frame.messages')) })
      await seen(open)
      await open.click()
      await page.waitForURL(/[?&]thread=open/, { timeout: 30_000 })
      await seen(page.locator('.fw-prf[data-mode="stacked"][data-view="thread"]'))
      await flow.shot(page, 'alpha-order-narrow-thread')
      await page.locator('.fw-prf-back').getByRole('button', { name: PORTAL('record.frame.back'), exact: true }).click()
      await seen(page.locator('.fw-prf[data-mode="stacked"][data-view="body"]'))
      await page.setViewportSize({ width: 1440, height: 900 })
      await seen(portalDock(page), 30_000)

      await writeInDock(page, FROM_ALPHA)
      await flow.settle()
      await flow.shot(page, 'alpha-order-wrote')
    })

    run.claim = await flow.step('customer A reports a quality problem on the order: the claim’s page docks its conversation; A writes there', async () => {
      const { page } = alpha
      // Returns & claims' start, opened on the claim's type for this order (`?start=COMPLAINT&order=`: an order line links here).
      await alpha.go(`/returns?start=COMPLAINT&order=${run.order.id}`)
      const start = page.getByRole('dialog', { name: RET('start.title') })
      await seen(start, 60_000)
      await start.getByRole('textbox', { name: RET('start.description'), exact: true }).fill(CASE_TEXT)
      await press(start.getByRole('button', { name: RET('start.next'), exact: true }))
      await seen(start.getByText(RET('start.review.complaint')))
      await press(start.getByRole('button', { name: RET('start.sendComplaint'), exact: true }))
      // The end state says the case's number ("Complaint <number> opened": a case has no customer series of its own).
      const [sentBefore, sentAfter] = RET('start.sent.complaint', { number: '§' }).split('§')
      const sentLine = await seen(page.getByText(shaped(RET('start.sent.complaint'))), 60_000)
      const number = new RegExp(`${escape(sentBefore!)}(.+?)${escape(sentAfter ?? '')}`).exec((await sentLine.textContent()) ?? '')?.[1]?.trim()
      expect(number, 'the end state names the case').toBeTruthy()
      const href = await page.getByRole('link', { name: RET('start.sent.openComplaint') }).first().getAttribute('href')
      const id = /\/returns\/complaints\/([0-9a-f-]{36})/.exec(href ?? '')?.[1]
      expect(id, `the end state opens the claim (${href})`).toBeTruthy()
      await page.getByRole('link', { name: RET('start.sent.openComplaint') }).first().click()
      await page.waitForURL(new RegExp(`/returns/complaints/${id}`), { timeout: 60_000 })
      await seen(page.locator('.fw-pband').getByText(RET('record.titleComplaint', { number: number! })), 60_000)
      const dock = portalDock(page)
      await seen(dock, 60_000)
      await expect(dock).toHaveAttribute('aria-label', RET('messages.labelComplaint', { number: number! }))
      await writeInDock(page, CASE_MORE)
      await flow.settle()
      await flow.shot(page, 'alpha-claim-docked')
      return { id: id!, number: number! }
    })

    await flow.step('the office opens the order on the record frame: A’s message docked; the reply (A’s contact only), a portal message, Ask and Share to Brand Alpha only', async () => {
      const { page } = sales
      const party = BRAND_ALPHA.legalName
      await sales.go(`/sales/orders/${run.order.id}`)
      const dock = officeDock(page)
      await seen(dock, 60_000)
      await seen(dock.getByRole('group', { name: HEAD('label', { record: run.order.number }) }), 60_000)
      await seen(dock.getByText(FROM_ALPHA).first(), 60_000)
      // The thread holds this order's customer only: nothing of customer B anywhere on the page.
      expect(brandMarkersIn(await pageWords(page), BRAND_BETA), 'A’s order page shows customer B').toEqual([])
      await flow.shot(page, 'office-order-docked')

      // The reply to Brand Alpha: the box's way "Reply to <party>", then the send check, which names A's contact only (W08).
      const modes = dock.getByRole('radiogroup', { name: BOX('modeLabel') })
      await seen(modes, 60_000)
      await modes.getByRole('radio', { name: BOX('mode.reply', { party }), exact: true }).click()
      await dock.getByRole('combobox', { name: shaped(BOX('mode.reply')) }).fill(REPLY)
      await dock.getByRole('button', { name: BOX('send.reply', { party }), exact: true }).click()
      const check = dialog(page)
      await seen(check, 60_000)
      // End check (fix-browser-1): a reply opens with To = A's first contact with an address (the thread's defaultTo; P1's seeded
      // buyer comes before the fixture's contact). The check, read once it has answered, names each recipient "name (organisation)",
      // never the address: it names that contact of A, and the mailbox below proves the address.
      const contacts = (await flow.read(page, `/parties/${alphaId}`)).party.contacts as { name: string; email: string | null; status: string }[]
      const to = contacts.find((contact) => contact.email && contact.status === 'ACTIVE')
      expect(to, 'A has a contact with an address').toBeTruthy()
      await expect(check.getByText(CHECK('check.checking'))).toHaveCount(0, { timeout: 60_000 })
      const said = await check.innerText()
      expect(said, 'the send check names A’s contact').toMatch(new RegExp(`${escape(to!.name)} \\(${escape(BRAND_ALPHA.tradeName)}`))
      expect(brandMarkersIn(said, BRAND_BETA), 'the send check names customer B').toEqual([])
      await flow.shot(page, 'office-send-check')
      const before = await flow.mailsTo(to!.email!)
      await press(check.getByRole('button', { name: CHECK('check.send', { party }), exact: true }), 60_000)
      await check.waitFor({ state: 'hidden', timeout: 60_000 })
      await seen(dock.getByText(REPLY).first(), 60_000)
      // The mail leaves after its ten seconds of Undo: the FAKE mailbox holds it for A's contact.
      await expect
        .poll(
          async () => {
            await flow.settle()
            return flow.mailsTo(to!.email!)
          },
          { timeout: 90_000, intervals: [3_000] },
        )
        .toBeGreaterThan(before)

      // A message for A's portal readers (B-TH-237): "In the portal only", Post to Brand Alpha.
      await modes.getByRole('radio', { name: BOX('mode.portal'), exact: true }).click()
      await dock.getByRole('combobox', { name: BOX('mode.portal'), exact: true }).fill(TO_ALPHA)
      await dock.getByRole('button', { name: BOX('send.portal', { party }), exact: true }).click()
      await seen(dock.getByText(TO_ALPHA).first(), 60_000)
      await flow.settle()

      // R-ACT: Ask a partner to approve — the Ask dialog reaches Brand Alpha only (no other customer to choose). Cancelled: every
      // kind an order takes needs a file of the order (approvals-out kinds), which this stage does not upload.
      await openDoor(page, run.order.number, 'act.approve')
      const ask = page.getByRole('dialog', { name: ASK('ask.title') })
      await seen(ask, 60_000)
      await seen(ask.getByText(ASK('ask.to', { partner: party })))
      expect(brandMarkersIn(await ask.innerText(), BRAND_BETA), 'the Ask dialog names customer B').toEqual([])
      await flow.shot(page, 'office-ask-dialog')
      await ask.getByRole('button', { name: ASK('ask.cancel'), exact: true }).click()
      await ask.waitFor({ state: 'hidden', timeout: 30_000 })

      // R-ACT: Share with a partner — its contacts are Brand Alpha's on file only; A's contact is invited by e-mail.
      await openDoor(page, run.order.number, 'act.share')
      const invite = page.getByRole('dialog', { name: SHARE('invite.title') })
      await seen(invite, 60_000)
      await invite.getByRole('radio', { name: startsWith(SHARE('invite.toContact')) }).check()
      const contact = invite.getByRole('combobox', { name: SHARE('invite.contact') })
      await seen(contact)
      const offered = (await contact.locator('option').allTextContents()).filter((text) => text !== SHARE('invite.contactPick'))
      // End check (fix-browser-1): every contact of A on file with an address (P1's two seeded ones and the fixture's), none other.
      const onFile = contacts.filter((entry) => entry.email && entry.status === 'ACTIVE').map((entry) => `${entry.name} · ${entry.email}`)
      expect(onFile, 'the fixture’s contact is on file').toContain(`${BRAND_ALPHA.contact.name} · ${BRAND_ALPHA.contact.email}`)
      expect([...offered].sort(), 'A’s contacts on file').toEqual([...onFile].sort())
      expect(brandMarkersIn(await invite.innerText(), BRAND_BETA), 'the Share dialog names customer B').toEqual([])
      await contact.selectOption({ label: `${BRAND_ALPHA.contact.name} · ${BRAND_ALPHA.contact.email}` })
      await invite.getByRole('radio', { name: startsWith(SHARE('invite.mail')) }).check()
      await flow.shot(page, 'office-share-dialog')
      const mailsBefore = await flow.mailsTo(BRAND_ALPHA.contact.email)
      await press(invite.getByRole('button', { name: SHARE('invite.goMail'), exact: true }))
      await invite.waitFor({ state: 'hidden', timeout: 60_000 })
      await flow.settle()
      const shares = (await flow.read(page, `/shares?recordType=SalesOrder&recordId=${run.order.id}`)).shares as Json[]
      expect(shares.length, 'the invitation is listed').toBeGreaterThan(0)
      expect([...new Set(shares.map((share) => String(share.email).toLowerCase()))], 'the order is shared with A’s contact only').toEqual([BRAND_ALPHA.contact.email])
      await expect
        .poll(
          async () => {
            await flow.settle()
            return flow.mailsTo(BRAND_ALPHA.contact.email)
          },
          { timeout: 60_000, intervals: [3_000] },
        )
        .toBeGreaterThan(mailsBefore)
      await flow.shot(page, 'office-order-shared')
    })

    await flow.step('the office opens the quote on the record frame: its thread docked, the box offers Brand Alpha only; an office note', async () => {
      const { page } = sales
      const party = BRAND_ALPHA.legalName
      await sales.go(`/sales/quotes/${run.quote.id}`)
      const dock = officeDock(page)
      await seen(dock, 60_000)
      await seen(dock.getByRole('group', { name: HEAD('label', { record: run.quote.number }) }), 60_000)
      const modes = dock.getByRole('radiogroup', { name: BOX('modeLabel') })
      await seen(modes, 60_000)
      await seen(modes.getByRole('radio', { name: BOX('mode.reply', { party }), exact: true }))
      expect(brandMarkersIn(await modes.innerText(), BRAND_BETA), 'the quote’s box offers customer B').toEqual([])
      await modes.getByRole('radio', { name: BOX('mode.note'), exact: true }).click()
      await dock.getByRole('combobox', { name: BOX('mode.note'), exact: true }).fill(NOTE)
      await dock.getByRole('button', { name: BOX('send.note'), exact: true }).click()
      await seen(dock.getByText(NOTE).first(), 60_000)
      await flow.settle()
      expect(brandMarkersIn(await pageWords(page), BRAND_BETA), 'A’s quote page shows customer B').toEqual([])
      await flow.shot(page, 'office-quote-docked')
    })

    await flow.step('customer A reads the office’s portal message in its order’s docked conversation', async () => {
      const { page } = alpha
      await alpha.go(`/orders/${run.order.id}`)
      const dock = portalDock(page)
      await seen(dock, 60_000)
      await seen(dock.getByText(TO_ALPHA).first(), 60_000)
      await seen(dock.getByText(FROM_ALPHA).first())
      // An office note never reaches the portal (PR-15: the portal thread has two sides only).
      expect(await pageWords(page)).not.toContain(NOTE)
      await flow.shot(page, 'alpha-order-answered')
    })

    await flow.step('T00 / W02 W08 W09 W10 W36: customer B and the supplier’s order desk see nothing of Brand Alpha; A’s records answer the neutral refusal', async () => {
      const ofAlpha = [run.order.number, run.order.id, run.quote.number, run.quote.id, run.claim.number, run.claim.id, FROM_ALPHA, CASE_TEXT, CASE_MORE, REPLY, TO_ALPHA, NOTE]
      /** Opens an address of A's record and waits for its neutral words (they name nobody); the page holds nothing of A. */
      const refused = async (who: PortalDesk, path: string, title: string, body: string, where: string) => {
        await who.go(path)
        await seen(who.page.getByText(title).first(), 60_000)
        await seen(who.page.getByText(body).first())
        expect(brandMarkersIn(`${title}\n${body}`, BRAND_ALPHA), 'the refusal’s words name customer A').toEqual([])
        await scanned(flow, who.page, BRAND_ALPHA, ofAlpha, where)
      }

      // Customer B: its own pages, then every address of A's records (its own page and the generic /open/ one).
      await beta.go('')
      await seen(beta.page.getByRole('heading', { name: HOME('title'), exact: true }), 60_000)
      await scanned(flow, beta.page, BRAND_ALPHA, ofAlpha, 'beta home')
      await beta.go('/orders')
      // The band's title (the rail names the same page: the band is the page's own).
      await seen(beta.page.locator('.fw-pband').getByText(PO('list.title')), 60_000)
      await scanned(flow, beta.page, BRAND_ALPHA, ofAlpha, 'beta orders and requests')
      await beta.go('/returns')
      await seen(beta.page.locator('.fw-pband').getByText(RET('list.title')), 60_000)
      await scanned(flow, beta.page, BRAND_ALPHA, ofAlpha, 'beta returns and claims')
      await refused(beta, `/orders/${run.order.id}`, PO('record.missing'), PO('record.missingBody'), 'beta address of A order')
      await expect(portalDock(beta.page), 'no conversation for an order that is not theirs').toHaveCount(0)
      await refused(beta, `/returns/complaints/${run.claim.id}`, RET('record.missing'), RET('record.missingBody'), 'beta address of A claim')
      await expect(portalDock(beta.page)).toHaveCount(0)
      await refused(beta, `/open/SalesOrder/${run.order.id}`, PO('record.missing'), PO('record.missingBody'), 'beta open A order')
      await refused(beta, `/open/Complaint/${run.claim.id}`, RET('record.missing'), RET('record.missingBody'), 'beta open A claim')
      await refused(beta, `/open/Quote/${run.quote.id}`, PORTAL('record.missingTitle'), PORTAL('record.missing'), 'beta open A quote')

      // The supplier's order desk: its Home, then the generic page of each of A's records (no page of theirs: the summary refuses).
      await desk.go('')
      await seen(desk.page.getByRole('heading', { name: SUPPLIER('home.glance') }), 60_000)
      await scanned(flow, desk.page, BRAND_ALPHA, ofAlpha, 'supplier home')
      await refused(desk, `/open/SalesOrder/${run.order.id}`, PORTAL('record.missingTitle'), PORTAL('record.missing'), 'supplier open A order')
      await refused(desk, `/open/Quote/${run.quote.id}`, PORTAL('record.missingTitle'), PORTAL('record.missing'), 'supplier open A quote')
      await refused(desk, `/open/Complaint/${run.claim.id}`, PORTAL('record.missingTitle'), PORTAL('record.missing'), 'supplier open A claim')
    })
  },
})
