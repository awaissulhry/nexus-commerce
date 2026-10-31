import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RECEIPT_NOTE_CODES, REVERSAL_BLOCKERS } from '@nexus/factory-domain/inventory/receipts/rules'
import { WARNING_CODES } from '@nexus/factory-domain/planning/explode'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { LINE_CHANGES } from '@nexus/factory-domain/purchasing/confirm/answer'
import { PURCHASE_ORDER_STATUSES, SEND_CHECK_CODES } from '@nexus/factory-domain/purchasing/orders'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as planScreen } from '../../planning/mrp/fixtures'
import { inView, decisionPhrase, draftCards, draftHeld, draftReach, heldReason, sortLines, visibleLines, viewOf } from '../../planning/mrp/model'
import { designScreen as ordersScreen } from '../../purchasing/orders/list/fixtures'
import { designScreen as orderScreen } from '../../purchasing/orders/record/fixtures'
import { BLOCKED_DRAFT, order } from '../../purchasing/orders/demo/fixtures'
import { cancelHeld, confirmationPhrase, journeyIndex, leatherSpecs, nextStep, orderQuery, orderViewOf, receivedShare, sendItems } from '../../purchasing/orders/model'
import { designScreen as receiveScreen } from '../../warehouse/receipts/receive/fixtures'
import { designScreen as lotsScreen } from '../../warehouse/receipts/record/fixtures'
import { designScreen as receiptsScreen } from '../../warehouse/receipts/list/fixtures'
import { EXPECTED, receipt, typedDraft } from '../../warehouse/receipts/demo/fixtures'
import {
  hideBaseArea,
  instantOf,
  lineBase,
  lineDiff,
  pasteHides,
  postHeld,
  receiptBody,
  receiptQuery,
  receiptViewOf,
  receiveChecks,
  receiveDraft,
  receiveSelection,
  reversalMoves,
  typedDecimal,
  blankHide,
} from '../../warehouse/receipts/model'
import { canOf } from './fixtures'
import { buyingCan, csvOf, quantity, readProblem, startOfDayIn, todayIn, writeProblem } from './model'

/**
 * The buying screens (SCR-055, SCR-058/059, SCR-061 … 063): their rules, and every design case in both languages with
 * no message key left on screen.
 */

const params = (query: string) => new URLSearchParams(query)

describe('shared: abilities, problems, numbers', () => {
  it('reads the permissions and the cost grain', () => {
    expect(canOf('buyer')).toMatchObject({ planView: true, poManage: true, poSend: true, receive: false, cost: true })
    expect(canOf('warehouse')).toMatchObject({ poView: true, poManage: false, receive: true, reverse: true, cost: false })
    expect(canOf('planner')).toMatchObject({ planRun: true, poManage: false, cost: false })
    expect(buyingCan([])).toMatchObject({ planView: false, poView: false, stockView: false })
  })

  it('says a failed read or write in this app’s words (never the API’s)', () => {
    expect(readProblem(new ApiError('unavailable', 0, 'network', 'down'))).toBe('problem.offline')
    expect(readProblem(new ApiError('forbidden', 403, 'forbidden', 'no'))).toBe('problem.forbidden')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'stale'))).toEqual({ key: 'problem.changed' })
    expect(writeProblem(new ApiError('invalid', 400, 'validation_failed', 'bad', null, [{ path: 'body/lines/0/differenceReason' }]), (paths) => (paths.some((path) => path.includes('differenceReason')) ? { key: 'rc.refusal.over' } : null))).toEqual({ key: 'rc.refusal.over' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'problem.write' })
  })

  it('writes quantities in the person’s language and finds the start of the site’s day', () => {
    expect(quantity('420.0000', 'en')).toBe('420')
    expect(quantity('212.4500', 'it')).toBe('212,45')
    expect(quantity(null, 'en')).toBe('—')
    expect(todayIn('Europe/Rome', new Date('2026-10-29T23:30:00Z'))).toBe('2026-10-30')
    // Rome is UTC+1 in winter: the day starts at 23:00 UTC the evening before.
    expect(startOfDayIn('Europe/Rome', new Date('2026-11-05T10:00:00Z'))).toBe('2026-11-04T23:00:00.000Z')
    expect(csvOf(['a', 'b'], [['x;y', 'z"q']])).toBe('a;b\r\n"x;y";"z""q"')
  })
})

describe('What to buy & make (SCR-055)', () => {
  const plan = planScreen.cases.find((item) => item.id === 'plan')!.model.model
  const lines = plan.plan.status === 'ready' ? plan.plan.value.lines : []

  it('views: open short lines by default, the tiles as saved views, a search over material, supplier and orders', () => {
    expect(viewOf('late')).toBe('late')
    expect(viewOf('nonsense')).toBe('open')
    expect(visibleLines(lines, 'open', '').map((line) => line.item.code)).toEqual(['DEMO-LEA-01', 'DEMO-LEA-01', 'DEMO-ZIP-04', 'DEMO-IMB-09'])
    expect(visibleLines(lines, 'late', '')).toHaveLength(1)
    expect(visibleLines(lines, 'inDraft', '').map((line) => line.purchaseOrder?.number)).toEqual(['PO-2026-0007'])
    expect(visibleLines(lines, 'held', '').every((line) => Number(line.heldStock) > 0)).toBe(true)
    expect(visibleLines(lines, 'all', 'SO-DEMO-0044').length).toBeGreaterThan(0)
    expect(inView(lines[6]!, 'setAside')).toBe(true)
    // Sorted by supplier (none last), then the order-by day.
    expect(sortLines(lines).at(-1)!.supplier).toBeNull()
  })

  it('a decision in words, and what an action cannot reach (with why)', () => {
    expect(decisionPhrase(lines[2]!)).toEqual({ key: 'decision.inDraft', params: { number: 'PO-2026-0007' } })
    expect(decisionPhrase(lines[4]!)).toEqual({ key: 'decision.ordered', params: { number: 'PO-2026-0005', status: 'poStatus.SENT' } })
    expect(decisionPhrase(lines[6]!)).toEqual({ key: 'decision.setAside.STOCK_NOT_IN_SYSTEM' })
    const buyer = canOf('buyer')
    expect(heldReason(lines[2]!, buyer)).toBe('held.ordered')
    expect(heldReason(lines[0]!, buyer)).toBeNull()
    expect(draftHeld(lines[0]!, canOf('planner'))).toBe('held.noPurchasing')
    expect(draftHeld(lines[5]!, buyer)).toBe('held.makeLine')
  })

  it('Draft POs: one card per supplier with its open draft; lines with no supplier apart; the reach', () => {
    const drafts = [{ id: 'd1', number: 'PO-2026-0008', partyId: lines[0]!.supplier!.id, supplierName: 'x', lineCount: 1, siteId: 's', currency: 'EUR' }]
    const cards = draftCards(lines, drafts)
    expect(cards.map((card) => [card.supplierName, card.lines.length, card.draft?.number ?? null])).toEqual([
      ['Conceria Demo S.r.l.', 2, 'PO-2026-0008'],
      [null, 1, null],
    ])
    expect(draftReach(lines)).toEqual({ lines: 3, suppliers: 1, noSupplier: 1 })
  })
})

describe('Purchase orders (SCR-058/059)', () => {
  it('reads the view from the address, as Today links it', () => {
    expect(orderViewOf(params('status=SENT'))).toBe('waiting')
    expect(orderViewOf(params('status=CHANGES_PROPOSED'))).toBe('proposed')
    expect(orderViewOf(params('waitingOver48h=true'))).toBe('late')
    expect(orderViewOf(params('view=drafts'))).toBe('drafts')
    expect(orderQuery('late', 'po')).toEqual({ status: 'SENT', waitingOver48h: true, q: 'po', cursor: null })
  })

  it('the supplier’s answer in words; the journey; the next step held with its reason', () => {
    const now = new Date('2026-10-29T11:00:00Z')
    expect(confirmationPhrase({ status: 'SENT', sentAt: '2026-10-26T10:00:00Z', confirmedAt: null, confirmedVia: null, confirmedByName: null, declinedAt: null }, now)).toEqual({ key: 'po.confirm.sentDays', params: { count: 3 } })
    expect(confirmationPhrase({ status: 'CONFIRMED', sentAt: null, confirmedAt: '2026-10-28T08:40:00Z', confirmedVia: 'LINK', confirmedByName: 'Marta Demo', declinedAt: null })).toEqual({ key: 'po.confirm.byLinkName', params: { name: 'Marta Demo' } })
    expect(journeyIndex('DRAFT')).toBe(0)
    expect(journeyIndex('PARTLY_RECEIVED')).toBe(3)
    expect(nextStep(BLOCKED_DRAFT(), canOf('buyer'))).toEqual({ kind: 'send', held: { key: 'po.check.LINE_NOT_PRICED' } })
    expect(nextStep(order('DRAFT'), canOf('planner')).held).toEqual({ key: 'held.noSend' })
    expect(nextStep(order('CHANGES_PROPOSED'), canOf('buyer'))).toEqual({ kind: 'review', held: null })
    expect(nextStep(order('CONFIRMED'), canOf('buyer'))).toEqual({ kind: 'receive', held: { key: 'held.noReceive' } })
    expect(cancelHeld(order('CONFIRMED'), canOf('buyer'))).toBeNull() // W2a (B-W2a-52): a confirmed order may be cancelled
    expect(cancelHeld(order('SENT'), canOf('buyer'))).toBeNull()
  })

  it('a leather line’s specs, what has come per line, the send checks as the dialog’s items', () => {
    const line = order('PARTLY_RECEIVED').lines[0]!
    expect(leatherSpecs(line).map((spec) => spec.key)).toEqual(['po.spec.grade', 'po.spec.thicknessRange', 'po.spec.oneDyeBatch', 'po.spec.tolerance', 'po.spec.crVi'])
    expect(receivedShare(line)).toBeCloseTo(212.4 / 420, 5)
    const checks = sendItems(BLOCKED_DRAFT().send!.checks, (key) => key, '/w/DEMO/purchasing/orders/x')
    expect(checks.status).toBe('ready')
    if (checks.status === 'ready') {
      expect(checks.items.filter((item) => item.state === 'blocks').map((item) => item.fix?.href)).toEqual(['/w/DEMO/purchasing/orders/x?tab=lines', '/w/DEMO/purchasing/orders/x?tab=lines'])
      // What failed is never also said to pass.
      expect(checks.items.some((item) => item.id === 'pass-linesPriced')).toBe(false)
    }
  })
})

describe('Receipts and receiving (SCR-061 … 063)', () => {
  it('views from the address; one receipt per order', () => {
    expect(receiptViewOf(params(''), true)).toBe('expected')
    expect(receiptViewOf(params(''), false)).toBe('all')
    expect(receiptViewOf(params('status=POSTED'), true)).toBe('posted')
    expect(receiptQuery('today', '', '2026-10-28T23:00:00.000Z')).toMatchObject({ status: 'POSTED', postedFrom: '2026-10-28T23:00:00.000Z' })
    expect(receiveSelection([EXPECTED[0]!, EXPECTED[1]!])).toEqual({ orderId: EXPECTED[0]!.purchaseOrderId, held: null })
    expect(receiveSelection([EXPECTED[0]!, EXPECTED[2]!]).held).toBe('several')
  })

  it('a hide’s area in the base unit (m² → ft²), the line’s total and its difference against the tolerance', () => {
    expect(hideBaseArea({ area: '1', areaUom: 'M2' }, 'FT2')!.toFixed(4)).toBe('10.7639')
    expect(hideBaseArea({ area: 'abc', areaUom: 'M2' }, 'FT2')).toBeNull()
    expect(typedDecimal('22,5')).toBe('22.5')
    expect(typedDecimal('0')).toBeNull()
    const typed = typedDraft('typed')
    // 209.7 ft² more on 212.4 received of 420 expected (± 5 %): within the tolerance.
    expect(lineBase(typed.lines[0]!).toFixed(4)).toBe('209.7000')
    expect(lineDiff(typed.lines[0]!)).toMatchObject({ kind: 'WITHIN_TOLERANCE', after: '422.1000' })
    expect(lineDiff(typedDraft('over').lines[0]!).kind).toBe('OVER')
    // A lot of lining (by lot): 60 m.
    expect(lineBase(typed.lines[1]!).toFixed(4)).toBe('60.0000')
  })

  it('Ready to post: a hide with no area holds it; more than the tolerance needs its reason; a held lot its reason', () => {
    expect(postHeld(receiveChecks(typedDraft('typed')))).toEqual({ key: 'rc.check.hideArea', params: { seq: 10, count: 1 } })
    expect(postHeld(receiveChecks(typedDraft('over')))).toEqual({ key: 'rc.check.over', params: { seq: 10 } })
    const held = typedDraft('held')
    expect(postHeld(receiveChecks(held))).toBeNull()
    const noReason = { ...held, lines: held.lines.map((entry, index) => (index === 0 ? { ...entry, lots: entry.lots.map((lot) => ({ ...lot, holdReason: '' })) } : entry)) }
    expect(postHeld(receiveChecks(noReason))).toEqual({ key: 'rc.check.holdReason', params: { seq: 10 } })
    const none = receiveDraft(EXPECTED[0]!.purchaseOrderId, EXPECTED).lines.map((entry) => ({ ...entry, include: false }))
    expect(postHeld(receiveChecks({ ...held, lines: none }))).toEqual({ key: 'rc.check.noLine' })
  })

  it('the body the API takes: included lines; leather lots of hides, a lot with its quantity; empty fields left out', () => {
    const body = receiptBody(typedDraft('held'), 'Europe/Rome')
    expect(body).toMatchObject({ purchaseOrderId: EXPECTED[0]!.purchaseOrderId, supplierDdtNumber: 'DDT-DEMO-571', supplierDdtDate: '2026-10-29' })
    expect(body.lines).toHaveLength(2)
    const leather = body.lines[0]!
    expect(leather.quantity).toBeUndefined()
    expect(leather.lots![0]).toMatchObject({ supplierLotRef: 'CD-7745', dyeBatch: 'TB-345', holdReason: 'Colour looks lighter than the sample' })
    expect(leather.lots![0]!.hides![0]).toEqual({ area: '22.9', areaUom: 'FT2', supplierCode: 'T-88201', grade: 'A', thicknessMm: '1.2' })
    expect(body.lines[1]!.lots![0]).toEqual({ supplierLotRef: 'TE-2210', quantity: '60' })
    expect(instantOf('2026-10-29T08:15', 'Europe/Rome')).toBe('2026-10-29T07:15:00.000Z')
    expect(instantOf('', 'Europe/Rome')).toBeUndefined()
  })

  it('a pasted column fills the hides down (new rows as needed); a tab-separated row fills the columns to the right', () => {
    const line = EXPECTED[0]!
    const start = [blankHide(line)]
    const pasted = pasteHides(start, 0, 'area', '23,4\n24.1\n22.8\n', () => blankHide(line))
    expect(pasted.map((hide) => hide.area)).toEqual(['23.4', '24.1', '22.8'])
    const row = pasteHides(start, 0, 'supplierCode', 'T-1\t23.5\tA', () => blankHide(line))
    expect(row[0]).toMatchObject({ supplierCode: 'T-1', area: '23.5', grade: 'A' })
    expect(pasteHides(start, 0, 'area', 'one value', () => blankHide(line))).toEqual(start)
  })

  it('what a reversal posts: one move per hide, per lot, or per untracked line', () => {
    expect(reversalMoves(receipt())).toBe(10)
  })
})

const LEFT_KEY = /\b(?:common|plan|why|po|rc|held|problem|record|decision|uom|kind|poStatus|rcStatus|lotStatus|crVi|party|live)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
/** Permission names are said on purpose ("needs purchasing.view"): not keys. */
const PERMISSIONS = /\b(?:planning\.(?:view|run|decide)|purchasing\.(?:view|manage|send)|inventory\.(?:stock\.view|receive|reverse|locations\.view)|quality\.lots\.view|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'buying', 'lists', 'records', 'send']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [planScreen, ordersScreen, orderScreen, receiveScreen, lotsScreen, receiptsScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages (states, units, checks, notes, blockers, changes, warnings)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['buying']).buying!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of PURCHASE_ORDER_STATUSES) has(`poStatus.${status}`)
      for (const unit of UOMS) has(`uom.${unit}`)
      for (const code of SEND_CHECK_CODES) has(`po.check.${code}`)
      for (const code of RECEIPT_NOTE_CODES) has(`rc.note.${code}`)
      for (const code of REVERSAL_BLOCKERS) has(`rc.blocker.${code}`, 1)
      for (const change of LINE_CHANGES) has(`po.answer.change.${change}`)
      for (const code of WARNING_CODES) has(`plan.warning.${code}`, 2)
    }
  })
})
