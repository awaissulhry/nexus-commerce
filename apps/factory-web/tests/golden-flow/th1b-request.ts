import { expect, test, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../../src/lib/testing/two-brands'
import { expectNothingOf, pageWords } from './_harness/brand-scan'
import { seen, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { setUpBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { words } from './_harness/words'

/**
 * B-TH-227 — UI golden flow TH-1b (threads plan; P-CUS-NEW.send, X-P-CUS-REQ.state, O-SAL-INQ-LIST.pane-actions; wall W00, W02,
 * W05, W10, W37 — the screens' twin of the API's golden flow B-TH-021). On the local stack the browser golden flow starts (its own
 * throwaway database, every outside service FAKE), it needs no W1 stage before it:
 *   S   the sales office makes the seeded P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal
 *       and its buyer, who signs in through the portal's screens (./_harness/two-brands.ts);
 *   1   customer A writes a request like an e-mail on New order (subject, message, its PO, the day it wants the goods) and Sends:
 *       the receipt says "your request N" — its own count, never the office's INQ-… series;
 *   2   the office (sales) reads it in Sales › Incoming's reading pane and asks for information: the pane's Ask for info turns the
 *       thread's box into "Reply to <customer>"; Send puts the question in customer A's portal (no address, no send check);
 *   3   customer A reads "We need something from you" and the question on its request page and answers in the request's thread;
 *       the answer takes the request up again by itself ("Being reviewed");
 *   4   the office makes a quote from the pane (a DRAFT: the customer is not told yet); customer A's request page reads "Quote being
 *       prepared" and no quote number;
 *   T00 customer B sends its own request (its own count) and visits its Home, Orders & requests, its own request and the address of
 *       customer A's request ("Request not found", neutral words): every page passes the DOM name scan — no name, code, number,
 *       PO, words, id or file of customer A, nor the office number of A's request or of its quote.
 * Writes outside the screens: only the two customers' set-up (names, contact, address, portal, invitation) as the sales office.
 */

const ORDERING = words('portal-ordering')
const COMPOSE = words('request-compose')
const REQUEST = words('portal-requests')
const INCOMING = words('sales-inquiries')
const BOX = words('record-thread-composer')
const DS = words('ds-words')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence as a regular expression: its placeholders match anything. */
const shaped = (text: string) => new RegExp(escape(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.+'))

const SUBJECT = 'Made-up: ten team jackets for the spring'
const QUESTION = 'Made-up question: which colour, black or red?'
const ANSWER = 'Made-up answer: black, please.'

/** The day 15 of next month (always ahead; the date picker opens on this month): its ISO date and the picker's day name. */
function wantedDay(): { iso: string; label: RegExp } {
  const now = new Date()
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15))
  const month = day.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
  return { iso: day.toISOString().slice(0, 10), label: new RegExp(`15 ${month} ${day.getUTCFullYear()}$`) }
}

/**
 * New order as an e-mail (B-TH-220): the subject, the message, and under "Add details" the PO and the wanted day; Send. Returns the
 * receipt's own number and the request's id (from the receipt's "Open the request").
 */
async function sendRequest(desk: PortalDesk, input: { subject: string; message: string; customerRef: string; wanted?: boolean }): Promise<{ seq: number; id: string }> {
  const { page } = desk
  await desk.go('/orders/new')
  await page.getByLabel(COMPOSE('subject.label'), { exact: true }).fill(input.subject)
  // The message is required: its label carries a mark (the field's accessible name is the label alone).
  await page.getByRole('textbox', { name: COMPOSE('message.label'), exact: true }).fill(input.message)
  await page.getByText(COMPOSE('details.title'), { exact: true }).click()
  await page.getByLabel(COMPOSE('details.ref'), { exact: true }).fill(input.customerRef)
  if (input.wanted) {
    const day = wantedDay()
    await page.locator('.fw-rqc-details button[aria-haspopup="dialog"]').first().click()
    await page.getByRole('button', { name: DS('date.nextMonth') }).click()
    await page.getByRole('button', { name: day.label }).click()
  }
  await page.getByRole('button', { name: COMPOSE('send.send'), exact: true }).click()
  const title = await seen(page.getByText(shaped(ORDERING('receipt.title'))), 60_000)
  const seq = Number(/(\d+)\.$/.exec((await title.textContent()) ?? '')?.[1])
  expect(seq, 'the receipt names the customer’s own number').toBeGreaterThan(0)
  const href = await page.getByRole('link', { name: ORDERING('receipt.open') }).first().getAttribute('href')
  const id = /\/orders\/requests\/([0-9a-f-]{36})/.exec(href ?? '')?.[1]
  expect(id, `the receipt opens the request (${href})`).toBeTruthy()
  return { seq, id: id! }
}

/** The page shows nothing of `brand` nor the run's own words of it (numbers, ids, subject); a screenshot for the record. */
async function scanned(flow: Flow, page: Page, brand: BrandFixture, extra: readonly string[], where: string): Promise<void> {
  await expectNothingOf(page, brand, extra, where)
  await flow.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
}

export default defineStage({
  proves:
    'customer A sends a text request from the portal; the office reads it in Incoming’s reading pane and asks for info; customer A answers on its request page and reads “Quote being prepared” after Make quote; every page customer B visits passes the DOM name scan (nothing of customer A)',
  async run(flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')
    type Run = { id: string; seq: number; office: string; quote: string | null }
    const run = {} as Run

    await flow.step('the sales office makes P1 Brand Alpha and P3 Brand Beta, each with its portal and its buyer', async () => {
      await setUpBrand(flow, sales, BRAND_ALPHA, alphaId)
      await setUpBrand(flow, sales, BRAND_BETA, betaId)
      await flow.settle()
    })

    // Not a kept step: a run attached to a kept stack (FACTORY_BGF_RESUME) signs both buyers in again in its new browser.
    const { alpha, beta } = await test.step('each buyer signs in through the portal’s screens (the mailed link, Continue, the first visit)', async () => {
      const signedIn = { alpha: await signInToPortal(flow, BRAND_ALPHA, alphaId), beta: await signInToPortal(flow, BRAND_BETA, betaId) }
      await flow.shot(signedIn.alpha.page, 'alpha-home')
      return signedIn
    })

    Object.assign(
      run,
      await flow.step('customer A sends a text request on New order: the receipt says its own number, never the office series', async () => {
        const sent = await sendRequest(alpha, { subject: SUBJECT, message: `${BRAND_ALPHA.message}\nWe need ten jackets, sizes 50 to 54.`, customerRef: BRAND_ALPHA.customerRef, wanted: true })
        const record = (await flow.read(sales.page, `/sales/inquiries/${sent.id}`)).inquiry
        expect(record).toMatchObject({ status: 'NEW', source: 'PORTAL', party: { id: alphaId }, customerRef: BRAND_ALPHA.customerRef })
        expect(record.wantedDate).toBe(wantedDay().iso)
        expect(await pageWords(alpha.page)).not.toContain(record.number as string)
        await flow.shot(alpha.page, 'alpha-receipt')
        await flow.settle()
        return { ...sent, office: record.number as string, quote: null }
      }),
    )

    await flow.step('the office reads it in Incoming’s reading pane and asks for info: the box becomes the reply, the question goes to the portal', async () => {
      const { page } = sales
      await sales.go(`/sales/incoming?open=${run.id}`)
      await seen(page.getByText(SUBJECT).first(), 60_000)
      // Sales takes it (⋯ Assign… → Me): the customer's answer then brings it back to this person ("Being reviewed").
      await page.getByRole('button', { name: INCOMING('record.more'), exact: true }).last().click()
      await page.getByRole('menuitem', { name: INCOMING('verb.assignKey') }).click()
      const assign = page.getByRole('dialog', { name: INCOMING('assign.title') })
      await assign.getByRole('option', { name: INCOMING('assign.me', { name: 'Sara Sales' }) }).click()
      await seen(page.getByText(INCOMING('done.assignMe', { number: run.office })))
      await page.getByRole('button', { name: INCOMING('pane.action.askInfo'), exact: true }).first().click()
      // The box (a combobox: it offers @mentions in notes) is now the reply to the customer.
      const box = page.getByRole('combobox', { name: shaped(BOX('mode.reply')) })
      await box.waitFor({ state: 'visible' })
      await box.fill(QUESTION)
      await page.getByRole('button', { name: shaped(BOX('send.reply')) }).click()
      await seen(page.getByText(shaped(INCOMING('done.askInfoPortal'))))
      await flow.settle()
      expect((await flow.read(page, `/sales/inquiries/${run.id}`)).inquiry.status).toBe('NEED_INFO')
      await flow.shot(page, 'office-asked')
    })

    await flow.step('customer A reads “We need something from you” and the question, and answers in the request’s thread', async () => {
      const { page } = alpha
      await alpha.go(`/orders/requests/${run.id}`)
      await seen(page.getByRole('heading', { name: REQUEST('title', { seq: run.seq }) }), 60_000)
      await seen(page.getByText(REQUEST('question.title')).first())
      await seen(page.getByText(QUESTION).first())
      await page.getByRole('textbox', { name: DS('partnerThread.composer'), exact: true }).fill(ANSWER)
      await page.getByRole('button', { name: DS('partnerThread.send'), exact: true }).click()
      await seen(page.getByText(ANSWER).first())
      await flow.settle()
      expect((await flow.read(sales.page, `/sales/inquiries/${run.id}`)).inquiry.status).toBe('ASSIGNED')
      await page.reload()
      await seen(page.getByText('Being reviewed').first(), 60_000)
      await flow.shot(page, 'alpha-answered')
    })

    run.quote = await flow.step('the office makes a quote from the pane: a draft, the customer not told yet', async () => {
      const { page } = sales
      await sales.go(`/sales/incoming?open=${run.id}`)
      await seen(page.getByText(ANSWER).first(), 60_000)
      await page.getByRole('button', { name: INCOMING('pane.action.quote'), exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: INCOMING('quote.title') })
      await dialog.getByRole('button', { name: INCOMING('quote.go'), exact: true }).click()
      await seen(page.getByText(/as a draft/).first())
      const record = (await flow.read(page, `/sales/inquiries/${run.id}`)).inquiry
      expect(record.status).toBe('QUOTED')
      await flow.settle()
      await flow.shot(page, 'office-quoted')
      return (record.quote?.number as string | undefined) ?? null
    })

    await flow.step('customer A’s request page reads “Quote being prepared” and no quote number', async () => {
      const { page } = alpha
      await alpha.go(`/orders/requests/${run.id}`)
      await seen(page.getByText('Quote being prepared').first(), 60_000)
      await seen(page.getByText(REQUEST('hint.QUOTE_BEING_PREPARED')).first())
      const shown = await pageWords(page)
      if (run.quote) expect(shown).not.toContain(run.quote)
      expect(shown).not.toContain(run.office)
      await flow.shot(page, 'alpha-quote-being-prepared')
    })

    await flow.step('T00: customer B sends its own request (its own number) and every page it visits holds nothing of customer A', async () => {
      const extra = [run.office, run.id, SUBJECT, QUESTION, ANSWER, ...(run.quote ? [run.quote] : [])]
      const own = await sendRequest(beta, { subject: 'Made-up: a size chart question', message: BRAND_BETA.message, customerRef: BRAND_BETA.customerRef })
      await flow.settle()
      const { page } = beta
      await scanned(flow, page, BRAND_ALPHA, extra, 'beta receipt')
      await beta.go('')
      await seen(page.getByRole('heading', { name: words('portal-customer-home')('title'), exact: true }), 60_000)
      await scanned(flow, page, BRAND_ALPHA, extra, 'beta home')
      await beta.go('/orders')
      await seen(page.getByText('Made-up: a size chart question').first(), 60_000)
      await scanned(flow, page, BRAND_ALPHA, extra, 'beta orders and requests')
      await beta.go(`/orders/requests/${own.id}`)
      await seen(page.getByRole('heading', { name: REQUEST('title', { seq: own.seq }) }), 60_000)
      await scanned(flow, page, BRAND_ALPHA, extra, 'beta own request')
      // Customer A's request by its address: the neutral page, as for any id that is not theirs.
      await beta.go(`/orders/requests/${run.id}`)
      await seen(page.getByText(REQUEST('missing.title')).first(), 60_000)
      await seen(page.getByText(REQUEST('missing.body')).first())
      await scanned(flow, page, BRAND_ALPHA, extra, 'beta address of A request')
    })
  },
})
