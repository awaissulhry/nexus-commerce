import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../../../../lib/i18n/messages'
import { canFor, PROSPECT_VIEW, QUOTED_VIEW, VIEW } from '../../../demo/fixtures'
import type { InquiryView } from '../../../api'
import { paneActions, paneHeld } from './model'
// B-TH-228
import { ORDERABLE_VIEW, ORDERED_VIEW } from '../../../demo/fixtures'
import { orderBodyOf, orderDonePhrase, orderDraftOf, orderHeld, priceOf, receiptStays, styleDraftBodyOf, styleDraftDialogHeld, styleDraftOf } from '../../../model'

/**
 * B-TH-218 (threads plan TH-1b; O-SAL-INQ-LIST.pane-actions; wall W20, W21, W37): ONE main button that follows the request, the
 * other actions held with their reasons, the production manager's held set (B-TH-014), Ask for info only toward the request's own
 * customer (a prospect first becomes one), a closed request's outcome in words. B-TH-228: Make order (held in the API's words while
 * a line is not ready; the order's own state in the receipt) and Make style draft (the production manager may).
 */

const words = CATALOGUE.en['sales-inquiries']!
const owner = canFor('owner')

describe('the actions row (B-TH-218)', () => {
  it('the main button follows the request: something to quote → Make quote; nothing that can go on a quote → Ask for info', () => {
    const row = paneActions(VIEW, owner, false)
    expect(row.main).toBe('quote')
    expect(row.others).toEqual(['order', 'styleDraft', 'askInfo', 'decline'])
    const nothingToQuote: InquiryView = { ...VIEW, lines: [] }
    const ask = paneActions(nothingToQuote, owner, false)
    expect(ask.main).toBe('askInfo')
    expect(ask.others).toEqual(['quote', 'order', 'styleDraft', 'decline'])
    // B-TH-228: every action of the request in one row, the main one first.
    expect([row.main, ...row.others]).toEqual(['quote', 'order', 'styleDraft', 'askInfo', 'decline'])
  })

  it('the production manager sees every action, held "Needs the sales permission" — never hidden', () => {
    const production = canFor('production')
    const row = paneActions(VIEW, production, false)
    expect(row.main).toBe('quote')
    for (const action of ['quote', 'order', 'askInfo', 'decline'] as const) expect(row.held[action]).toEqual({ key: 'held.right', params: { right: 'right.sales.inquiries.manage' } })
    // B-TH-228: Make style draft is the product office's: the production manager may make one.
    expect(row.held.styleDraft).toBeNull()
    expect(words['held.right']).toBe('Needs the sales permission ({right})')
    expect(row.menu.every((item) => item.held !== null)).toBe(true)
  })

  it('Ask for info goes only to the request\'s own customer: a prospect is held "Make the customer first" (W20, W21)', () => {
    expect(paneHeld(PROSPECT_VIEW, 'askInfo', owner, false)).toEqual({ key: 'pane.held.prospect' })
    expect(paneActions(PROSPECT_VIEW, owner, false).menu.map((item) => item.id)).toContain('match')
    expect(paneHeld(VIEW, 'askInfo', owner, false)).toBeNull()
    expect(paneHeld(VIEW, 'askInfo', owner, true)).toEqual({ key: 'held.offline' })
    // Without email.send a mail request cannot be asked; a portal request needs no mail.
    const noMail = { ...owner, email: false }
    expect(paneHeld({ ...VIEW, source: 'MAIL' }, 'askInfo', noMail, false)).toEqual({ key: 'held.right', params: { right: 'right.email.send' } })
    expect(paneHeld({ ...VIEW, source: 'PORTAL' }, 'askInfo', noMail, false)).toBeNull()
  })

  it('a closed request shows what it became (the quote with ITS own status), and no buttons', () => {
    const row = paneActions(QUOTED_VIEW, owner, false)
    expect(row.main).toBeNull()
    expect(row.others).toEqual([])
    expect(row.outcome?.key).toMatch(/^pane\.outcome\.quoted/)
    // B-TH-022 (main): a request made straight into an order says so, never "Lost".
    expect(paneActions({ ...QUOTED_VIEW, status: 'ORDERED', quote: null, quoteDetail: null }, owner, false).outcome).toEqual({ key: 'pane.outcome.ordered' })
  })

  it('Make quote says the quote is a DRAFT and the customer reads "Quote being prepared" (not told yet)', () => {
    expect(words['done.quote']).toContain('as a draft')
    expect(words['done.quote']).toContain('Quote being prepared')
    expect(CATALOGUE.it['sales-inquiries']!['done.quote']).toContain('Preventivo in preparazione')
    expect(words['pane.ask.portal']).toContain('portal')
  })
})

// ---- B-TH-228 (threads plan TH-2; pane-actions-F02 / F04; wall W11, W12, W37) ---------------------------------------------------
describe('B-TH-228 — Make order and Make style draft from a request', () => {
  it('Make order is held in the API\'s words while a line is not ready ("make the style draft first"); with every line ready it goes', () => {
    expect(paneHeld(VIEW, 'order', owner, false)).toEqual({ key: 'refusal.LINES_NOT_READY', params: { number: VIEW.number } })
    expect(words['refusal.LINES_NOT_READY']).toContain('make the style draft first')
    expect(paneHeld(ORDERABLE_VIEW, 'order', owner, false)).toBeNull()
    expect(paneHeld(ORDERABLE_VIEW, 'order', owner, true)).toEqual({ key: 'held.offline' })
    // A prospect: the customer first. No orders.manage: said with the right.
    expect(paneHeld(PROSPECT_VIEW, 'order', owner, false)).toEqual({ key: 'refusal.NEEDS_CUSTOMER', params: { number: PROSPECT_VIEW.number } })
    const noOrders: InquiryView = { ...ORDERABLE_VIEW, actions: { ...ORDERABLE_VIEW.actions, order: { allowed: false, refusal: null } } }
    expect(paneHeld(noOrders, 'order', { ...owner, orders: false }, false)).toEqual({ key: 'held.right', params: { right: 'right.orders.manage' } })
  })

  it('a line asked in words and nothing to quote: Make style draft is the main button — for sales and for the production manager', () => {
    const inWords: InquiryView = { ...VIEW, lines: VIEW.lines.slice(3) }
    expect(paneActions(inWords, owner, false).main).toBe('styleDraft')
    expect(paneActions(inWords, canFor('production'), false).main).toBe('styleDraft')
    // Without product.styles.manage it is held with that right (not the sales one), and the main falls back to Ask for info.
    const noStyles = { ...owner, stylesManage: false }
    expect(paneHeld(inWords, 'styleDraft', noStyles, false)).toEqual({ key: 'held.needs', params: { right: 'right.product.styles.manage' } })
    expect(paneActions(inWords, noStyles, false).main).toBe('askInfo')
    expect(paneHeld(PROSPECT_VIEW, 'styleDraft', owner, false)).toEqual({ key: 'refusal.NEEDS_CUSTOMER', params: { number: PROSPECT_VIEW.number } })
  })

  it('the Make order dialog starts from the request: the price the customer was shown (price grain only), their date and PO; sends only what was typed', () => {
    const draft = orderDraftOf(ORDERABLE_VIEW, owner)
    expect(draft).toEqual({ prices: { 10: '139.00', 20: '' }, promiseDate: ORDERABLE_VIEW.wantedDate, customerRef: 'PO-DEMO-0042', carryFiles: true })
    expect(orderDraftOf(ORDERABLE_VIEW, { ...owner, price: false }).prices).toEqual({ 10: '', 20: '' })
    expect(orderBodyOf(ORDERABLE_VIEW, draft, owner)).toEqual({ version: ORDERABLE_VIEW.version, lines: [{ seq: 10, unitPrice: '139.00' }], customerRef: 'PO-DEMO-0042', carryFiles: true })
    // A price typed with a comma goes as a decimal; a word holds the button; no price grain → no price ever sent.
    expect(priceOf('12,5')).toBe('12.5')
    expect(orderHeld(ORDERABLE_VIEW, { ...draft, prices: { 10: 'cheap', 20: '' } }, owner, false)).toEqual({ key: 'order.badPrice', params: { n: 1 } })
    expect(orderBodyOf(ORDERABLE_VIEW, { ...draft, prices: { 10: '99', 20: '88' } }, { ...owner, price: false })).not.toHaveProperty('lines')
    // The body never names a customer, company, contact or address: the order is the request's own (W37).
    expect(Object.keys(orderBodyOf(ORDERABLE_VIEW, { ...draft, promiseDate: '2027-02-01', carryFiles: false }, owner)).sort()).toEqual(['carryFiles', 'customerRef', 'lines', 'promiseDate', 'version'])
  })

  it('the receipt says the order\'s own state: confirmed, or waiting for approval and why — never "confirmed" while it waits (L2-G06)', () => {
    expect(orderDonePhrase({ order: { number: 'SO-1', status: 'CONFIRMED', waitsFor: null } }, 'INQ-1')).toEqual({ key: 'done.orderConfirmed', params: { order: 'SO-1', number: 'INQ-1' } })
    expect(orderDonePhrase({ order: { number: 'SO-1', status: 'PENDING_APPROVAL', waitsFor: 'CREDIT' } }, 'INQ-1').key).toBe('done.orderCredit')
    expect(orderDonePhrase({ order: { number: 'SO-1', status: 'PENDING_APPROVAL', waitsFor: 'APPROVAL' } }, 'INQ-1').key).toBe('done.orderApproval')
    for (const locale of ['en', 'it'] as const) {
      const catalogue = CATALOGUE[locale]['sales-inquiries']!
      expect(catalogue['done.orderCredit']).not.toMatch(/confirmed|confermato/i)
      expect(catalogue['done.orderApproval']).not.toMatch(/confirmed|confermato/i)
    }
    // The receipt stays on the page when the queue moves on to the next request (found by the browser check: it was dropped).
    for (const key of ['done.orderConfirmed', 'done.orderCredit', 'done.orderApproval', 'done.quote', 'done.decline', 'done.lost']) expect(receiptStays(key), key).toBe(true)
    expect(receiptStays('done.styleDraft')).toBe(false)
    // A closed request made straight into an order shows the order with ITS own status.
    expect(paneActions(ORDERED_VIEW, owner, false).outcome).toEqual({ key: 'pane.outcome.orderedStatus', params: { order: 'SO-2026-0142', status: 'orderStatus.PENDING_APPROVAL' } })
  })

  it('the style draft dialog: the request\'s first line as name, every file ticked; a code and a type hold it; never a brand in the body (W12)', () => {
    const draft = styleDraftOf(VIEW)
    expect(draft.name).toBe('RFQ SS27: touring jacket in black and sand, private label')
    expect(draft.fileIds).toEqual([...VIEW.files, ...VIEW.mailFiles].map((file) => file.id))
    expect(styleDraftDialogHeld(VIEW, draft, owner, false)).toEqual({ key: 'styleDraft.held.code' })
    expect(styleDraftDialogHeld(VIEW, { ...draft, code: 'gl-ss27' }, owner, false)).toEqual({ key: 'styleDraft.held.type' })
    // The size scale is asked (the style library takes the range from it; most product types give none).
    expect(styleDraftDialogHeld(VIEW, { ...draft, code: 'gl-ss27', productType: 'GLOVES' }, owner, false)).toEqual({ key: 'styleDraft.held.scale' })
    const ready = { ...draft, code: 'gl-ss27', productType: 'GLOVES', sizeScaleId: 'scale-1' }
    expect(styleDraftDialogHeld(VIEW, ready, canFor('production'), false)).toBeNull()
    const body = styleDraftBodyOf(VIEW, ready)
    expect(body).toMatchObject({ version: VIEW.version, code: 'GL-SS27', productType: 'GLOVES', sizeScaleId: 'scale-1' })
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['brandPartyId']))
    expect(JSON.stringify(body)).not.toMatch(/brand|party|company/i)
  })
})

// ---- B-TH-234 (threads plan TH-3; pane-actions-F06/F08/F11, on B-TH-043, B-TH-042, B-TH-051; wall W20, W23, W37) ------------------
import { declineBodyOf, declineHeld, emptyDecline, messageReach, taskHeld, taskRefusal } from '../../../model'

describe('B-TH-234 — decline in words, Not an order, Ask the customer for…', () => {
  const portal = { ...VIEW, messageTo: { via: 'PORTAL' as const, to: [], language: 'en', refusal: null } }
  const mail = { ...VIEW, messageTo: { via: 'MAIL' as const, to: ['buyer@brand-demo.example.com'], language: 'it', refusal: null } }

  it('the decline\'s message goes only to the request\'s own customer, as the request says (portal or its contact), and only when ticked', () => {
    expect(messageReach(portal, owner)).toEqual({ to: null, via: 'PORTAL', language: 'en', held: null })
    expect(messageReach(mail, owner)).toEqual({ to: 'buyer@brand-demo.example.com', via: 'MAIL', language: 'it', held: null })
    // A prospect has no customer to write to: the request's own refusal, in words (W20).
    const prospect = { ...PROSPECT_VIEW, messageTo: { via: null, to: [], language: null, refusal: { code: 'NEEDS_CUSTOMER' as const, message: 'x' } } }
    expect(messageReach(prospect, owner).held?.key).toBe('refusal.NEEDS_CUSTOMER')
    // Not ticked: nothing goes, whatever is typed.
    const typed = { ...emptyDecline, reason: 'CAPACITY' as const, message: 'We cannot make it in time.' }
    expect(declineBodyOf(mail, typed, owner)).toEqual({ version: VIEW.version, reason: 'CAPACITY' })
    expect(declineBodyOf(mail, { ...typed, send: true }, owner)).toEqual({ version: VIEW.version, reason: 'CAPACITY', message: { body: 'We cannot make it in time.' } })
    // A mail needs email.send; the portal reply does not.
    expect(messageReach(mail, { email: false, thread: true }).held).toEqual({ key: 'held.right', params: { right: 'right.email.send' } })
    expect(messageReach(portal, { email: false, thread: true }).held).toBeNull()
  })

  it('"Not an order" sends nothing (held if ticked; the body never carries a message); a ticked message needs words', () => {
    const notAnOrder = { ...emptyDecline, reason: 'NOT_AN_ORDER' as const, message: 'x', send: true }
    expect(declineHeld(notAnOrder, false)).toEqual({ key: 'refusal.SENDS_NOTHING' })
    expect(declineBodyOf(portal, notAnOrder, owner)).toEqual({ version: VIEW.version, reason: 'NOT_AN_ORDER' })
    expect(declineHeld({ ...emptyDecline, reason: 'PRICE', send: true, message: '  ' }, false)).toEqual({ key: 'decline.held.message' })
    expect(words['decline.message.notAnOrder']).toBeTruthy()
  })

  it('a selection never sends: Decline N says so (one customer at a time)', () => {
    expect(messageReach(null, owner)).toEqual({ to: null, via: null, language: null, held: { key: 'decline.message.many' } })
    expect(words['decline.message.many']).toContain('sends nothing')
  })

  it('⋯ holds Make or match the customer for a prospect, Ask <customer> for…, Not an order — each held with its reason', () => {
    const menu = paneActions(PROSPECT_VIEW, owner, false).menu.map((item) => item.id)
    expect(menu).toEqual(expect.arrayContaining(['match', 'task', 'notAnOrder', 'lost']))
    expect(paneActions(VIEW, owner, false).menu.map((item) => item.id)).not.toContain('match')
    const withTasks = { ...owner, tasks: true }
    expect(taskHeld(PROSPECT_VIEW, null, withTasks, false, '2026-11-12')).toEqual({ key: 'task.held.prospect' })
    expect(taskHeld(QUOTED_VIEW, null, withTasks, false, '2026-11-12')).toEqual({ key: 'task.held.closed' })
    expect(taskHeld(VIEW, null, { ...owner, tasks: false }, false, '2026-11-12')).toEqual({ key: 'held.needs', params: { right: 'right.partners.tasks.manage' } })
    expect(taskHeld(VIEW, { kind: null, due: null }, withTasks, false, '2026-11-12')).toEqual({ key: 'task.held.kind' })
    expect(taskHeld(VIEW, { kind: 'UPLOAD_DOCUMENT', due: '2026-11-12' }, withTasks, false, '2026-11-12')).toEqual({ key: 'task.held.due' })
    expect(taskHeld(VIEW, { kind: 'UPLOAD_DOCUMENT', due: '2026-11-20' }, withTasks, false, '2026-11-12')).toBeNull()
    // The API's refusals in the page's words; anything else stays the general refusal (another customer's request names nobody).
    expect(taskRefusal('REQUEST_CLOSED')).toEqual({ key: 'task.refusal.REQUEST_CLOSED' })
    expect(taskRefusal('SOMETHING')).toBeNull()
    for (const key of ['task.refusal.REQUEST_PROSPECT', 'task.refusal.REQUEST_CLOSED', 'pane.action.task', 'pane.action.notAnOrder', 'task.kind.SEND_MEASUREMENTS']) expect(words[key], key).toBeTruthy()
    // A request its customer withdrew says so (never "lost" by us).
    expect(paneActions({ ...VIEW, status: 'WITHDRAWN' }, owner, false).outcome).toEqual({ key: 'pane.outcome.withdrawn' })
  })
})
// ---- end B-TH-234
