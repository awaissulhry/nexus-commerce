import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { productRowsOf } from '../../../../lib/order-draft/model'
import { DRAFT_NS } from '../../../../lib/order-draft/words'
import { describedLine, kindsRecord, TODAY } from '../../../../portal/customer/neworder/design-data'
import { ORDER_FLOW_NS } from '../record/flow-words'
import { confirmRowsOf, openDetailsOf, productHeldOf, promiseProblemOf, promiseStartOf } from './confirm-model'

/**
 * owb-of5 step 4 — THE Confirm window (design plan § 5g, § 5zl A; L1 pick A): the promised day (a past day refused in words, an empty
 * one too), the open details as yellow lines (only what is NOT a stop today), a line without a product → "Pick the product first" and
 * the main button held (A-5). ONE window for the band, the sheet and Incoming. Written, not run (Owner rule).
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const t = createTranslator('en', CATALOGUE.en[DRAFT_NS] ?? {})

describe('owb-of5 step 4: the promised day', () => {
  it('a past day is refused in words; an empty one too; today and later go', () => {
    expect(promiseProblemOf('2026-11-27', '2026-11-28')).toBe('cf.promisePast')
    expect(promiseProblemOf('', '2026-11-28')).toBe('cf.promiseEmpty')
    expect(promiseProblemOf('28/11/2026', '2026-11-28')).toBe('cf.promiseEmpty')
    expect(promiseProblemOf('2026-11-28', '2026-11-28')).toBeNull()
    expect(promiseProblemOf('2026-12-22', '2026-11-28')).toBeNull()
    for (const locale of LOCALES) for (const key of ['cf.promisePast', 'cf.promiseEmpty']) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
  it('the field opens on the day the customer wants when it is not past, else empty', () => {
    expect(promiseStartOf('2026-12-22', '2026-11-28')).toBe('2026-12-22')
    expect(promiseStartOf('2026-11-01', '2026-11-28')).toBe('')
    expect(promiseStartOf(null, '2026-11-28')).toBe('')
  })
  it('the send carries the promised day and waits while it is refused (the hook), and the window shows the field', () => {
    const hook = read('./use-confirm-order.ts')
    expect(hook).toContain('promiseDate: now.promise.trim()')
    expect(hook).toContain('if (productHeldOf(rows, now.entries) || promiseProblemOf(now.promise, today) || confirmHeldOf(rows, now.entries)) return')
    expect(read('./view/ConfirmOrderWindowView.tsx')).toContain("<Field label={f('cf.promised')} error={promise ? f(promise) : undefined}")
  })
})

describe('owb-of5 step 4: a line without a product → no Confirm (A-5)', () => {
  const record = kindsRecord({ seesPrices: false, custom: [describedLine({ seq: 2, description: 'Team gloves as in the mail', colourText: null, quantity: 10, pieces: 10 })] })
  const rows = productRowsOf(record.request)
  const entries = Object.fromEntries(confirmRowsOf(rows).map((entry) => [entry.rowId, entry]))
  it('the first row without a product holds the window ("Pick the product first: line n"); a product picked lifts it', () => {
    const lacking = rows.find((row) => !entries[row.id]!.styleId)!
    expect(productHeldOf(rows, entries)).toEqual({ seq: lacking.seq })
    const picked = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { ...entry, styleId: entry.styleId ?? 'style-1' }]))
    expect(productHeldOf(rows, picked)).toBeNull()
  })
  it('the main button is held with those words first (before the day and the colour); the window says it in a red line', () => {
    const view = read('./view/ConfirmOrderWindowView.tsx')
    expect(view).toContain("(product ? f('cf.pickProduct', { seq: product.seq }) : null)")
    expect(view.indexOf("f('cf.pickProduct'")).toBeLessThan(view.indexOf('(promise ? f(promise) : null)'))
    expect(view).toContain("<Banner tone=\"danger\" title={f('cf.pickProductTitle')}>")
  })
})

describe('owb-of5 step 4: the open details are yellow lines (only what is not a stop today)', () => {
  it('a still-open item the order does not need (an option, the date) is a yellow line; a stop (pieces) is not', () => {
    const line = describedLine({ seq: 2, description: 'Jackets', colourText: null, quantity: 5, pieces: 5 })
    const record = kindsRecord({
      seesPrices: false,
      custom: [line],
      request: {
        stillOpen: {
          openCount: 3,
          confirmHeld: true,
          items: [
            { kind: 'CHOICE', lineId: line.id, seq: 2, topic: 'Leather', state: 'NOT_DECIDED', confirmNeeds: false },
            { kind: 'PIECES', lineId: line.id, seq: 2, topic: null, state: 'NOT_DECIDED', confirmNeeds: true },
            { kind: 'DATE', lineId: null, seq: null, topic: null, state: 'NOT_DECIDED', confirmNeeds: false },
          ],
        },
      },
    })
    const open = openDetailsOf(record.request.stillOpen, productRowsOf(record.request), t)
    expect(open.map((entry) => entry.id)).toEqual([`row-${line.id}`, 'date'])
    expect(open[0]!.what).toBe('Leather')
    expect(openDetailsOf(undefined, [], t)).toEqual([])
  })
})

describe('owb-of5 step 4: ONE window in so/draft/ — the draft page, the band, the sheet and Incoming', () => {
  it('the draft page draws it through the hook; the band and the host card open it; other pages mount ConfirmOrderWindow', () => {
    expect(read('./view/OfficeDraftView.tsx')).toContain('<ConfirmOrderWindowView model={{ record, confirm: model.confirm')
    expect(read('./view/OfficeDraftView.tsx')).not.toContain('function ConfirmWindow(')
    expect(read('./OfficeDraftPage.tsx')).toContain('const confirmOrder = useConfirmOrder({')
    const container = read('./ConfirmOrderWindow.tsx')
    expect(container).toContain('export function ConfirmOrderWindow(props: ConfirmOrderWindowProps)')
    expect(container).toContain('<ConfirmOrderWindowView')
    expect(container).toContain('confirmDraft(api, requestId,')
  })
  it('every window word in English and Italian', () => {
    const keys = ['cf.windowTitle', 'cf.promised', 'cf.promiseHint', 'cf.wanted', 'cf.wantedNone', 'cf.openTitle_one', 'cf.openTitle_other', 'cf.openWhy', 'cf.pickProduct', 'cf.pickProductTitle', 'cf.pickProductWhy', 'cf.noProduct', 'cf.failed', 'cf.readFailed']
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
  it('today and its fixtures', () => {
    expect(TODAY).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('owb-of6 (lead S2, shared-asks 09:04): `&confirm=1` opens THE Confirm window on arrival', () => {
  it('once, for one who may confirm, on a Draft or Sent order; then the term leaves the address', () => {
    const page = read('./OfficeDraftPage.tsx')
    expect(page).toContain("const confirmAsked = search?.get('confirm') === '1'")
    expect(page).toContain("if (record.request.status !== 'DRAFT' && record.request.status !== 'SENT') return")
    expect(page).toContain('if (mayConfirm) confirmOrder.actions.onOpen?.()')
    expect(page).toContain("next.delete('confirm')")
  })
})
