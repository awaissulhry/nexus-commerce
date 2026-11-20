import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { BRN, order, STYLE, STYLE_ROWS } from '../_demo/fixtures'
import type { OrderStyleRow } from '../api'
import { EMPTY_HISTORY } from './lines-draft'
import type { AddStyleState } from './lines-tab-model'
import { base } from './fixtures'
import { requestedBodyOf, requestedProblem, type OrderRecordModel } from './record-model'
import { AddStyleDialog } from './view/lines/AddStyleDialog'
import { CustomerRefDialog, ShipToDialog } from './view/OrderFactsDialogs'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OL-04 (Order LINES lane; 11-design-dialogs §1.1–§1.5, D-a; 18-lead-settles F1, F24, F26): the row ⋯ opens TODAY's windows (the
 * options window by its door, the promise dialog on the line, close / reopen with the line ticked and the reason optional, the split
 * with the line's pieces), Add a style lists only the order's own search (Sales: an unpriced colour held in the dialog), and the doors
 * land in place — the band's "Change the lines", Money's "Change our price ›", Order facts' Customer PO and Ship to windows, the
 * requested date's Why optional. Every name and number is made up.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const value = order('CONFIRMED')

describe('F-OL-04: Add a style — the order\'s own search; a colour on the order already, or one no list prices for Sales, held in words', () => {
  const row: OrderStyleRow = { ...STYLE_ROWS[0]!, colourways: STYLE.colourways.map((colourway) => ({ id: colourway.id, listPriced: colourway.id !== BRN.id })) }
  const state: AddStyleState = { query: 'DEMO', results: [row], searching: false, problem: null, row, chosen: STYLE, picked: [BRN.id] }
  const draw = (seesPrices: boolean, locale: (typeof LOCALES)[number] = 'en') => render(createElement(AddStyleDialog, { order: value, draft: EMPTY_HISTORY.draft, state, seesPrices }), locale)

  it('Sales: brown has no list price for the customer — held in the dialog, "Add 0 colours" held "Pick at least one colour"', () => {
    const text = textOf(draw(false))
    expect(text).toContain('Add a style to SO-2026-0088')
    expect(text).toContain("Our collection and Moto Demo S.r.l.'s own styles.")
    expect(text).toContain('No list price for Moto Demo S.r.l.: someone who sees prices adds it')
    expect(text).toContain('Already on this order')
    expect(draw(false)).toContain('aria-description="Pick at least one colour"')
  })

  it('the Owner: brown may be added (the price is typed in the table); black and red are on the order already', () => {
    const html = draw(true)
    expect(textOf(html)).not.toContain('No list price')
    expect(textOf(html)).toContain('Add 1 colour')
    expect(textOf(draw(true, 'it'))).toContain('Già su questo ordine')
  })

  it('the container searches with ?forOrder (never the company-wide list) and Sales never adds an unpriced colour', () => {
    const hook = read('./use-lines-draft.ts')
    expect(hook).toContain('findStylesForOrder(api, orderId, query)')
    expect(hook).not.toContain('findStyles(api')
    expect(hook).toContain("can.price || open.row?.colourways?.find((entry) => entry.id === id)?.listPriced !== false")
    expect(read('../api.ts')).toContain("query: { forOrder: orderId, q: query.trim() || undefined, limit: 20 }")
  })
})

describe('F-OL-04: Order facts\' small windows and the requested date — the amendment with no lines, Why optional', () => {
  const sales = base('sales', order('IN_PRODUCTION')).record
  const production = (sales.order as { value: typeof value }).value

  it('the requested date: no lines (every line stays as it is now), the date, the version, the reason only when typed', () => {
    expect(requestedBodyOf(production, '2026-12-20', '  ')).toEqual({ version: production.version, requestedDate: '2026-12-20' })
    expect(requestedBodyOf(production, '2026-12-20', ' Il negozio apre dopo. ')).toEqual({ version: production.version, requestedDate: '2026-12-20', reason: 'Il negozio apre dopo.' })
    expect(requestedProblem({ date: '2026-12-20', reason: '', today: '2026-10-29', current: '2026-12-10' })).toBeNull()
  })

  it('Customer PO of SO-2026-0088: the PO, Why (optional), "Applies at once"; held while it is the PO already (en, it)', () => {
    const draw = (model: OrderRecordModel, locale: (typeof LOCALES)[number]) => render(createElement(CustomerRefDialog, { order: production, model: { ...model, dialog: { kind: 'customerRef' } } }), locale)
    const en = draw(sales, 'en')
    for (const words of ['Customer PO of SO-2026-0088', 'Why (optional)', 'Applies at once — no approval']) expect(textOf(en), words).toContain(words)
    expect(en).toContain('aria-description="It is the customer PO already"')
    expect(textOf(draw(sales, 'it'))).toContain('Ordine del cliente di SO-2026-0088')
  })

  it('Where SO-2026-0088 ships: held in words without the right to see customers; the addresses as cards when read', () => {
    const held = render(createElement(ShipToDialog, { order: production, model: { ...sales, dialog: { kind: 'shipTo' }, split: { addresses: null, refusals: [], made: null } } }), 'en')
    expect(textOf(held)).toContain('Another delivery address needs the right to see customers')
    const address = { id: 'a1', kinds: ['SHIP_TO'], name: 'Magazzino Esempio', line1: 'Via Prova 1', postalCode: '00100', city: 'Roma', country: 'IT', status: 'ACTIVE', isDefaultShipTo: false, approval: null }
    const read0 = render(createElement(ShipToDialog, { order: production, model: { ...sales, dialog: { kind: 'shipTo' }, split: { addresses: { value: [address], problem: null }, refusals: [], made: null } } }), 'en')
    expect(textOf(read0)).toContain('Magazzino Esempio · Via Prova 1 · 00100 Roma')
    expect(read0).toContain('aria-description="Pick an address"')
  })

  it('the sources: the amendment with no lines for the PO and the address; the doors open the windows', () => {
    const acts = read('./use-lines-acts.ts')
    expect(acts).toContain('applyAmendment(api, orderId, { version: current0.version, customerRef: value || null, ...(reason ? { reason } : {}) }, key)')
    expect(acts).toContain('applyAmendment(api, orderId, { version: current0.version, shipToAddressId: addressId }, key)')
    expect(read('./use-overview-acts.ts')).toContain("onCustomerRefChange: () => input.setDialog?.({ kind: 'customerRef' })")
    const dialogs = read('./view/Dialogs.tsx')
    expect(dialogs).toContain("case 'customerRef': // F-OL-04")
    expect(dialogs).toContain("case 'shipTo': // F-OL-04")
  })
})

describe('F-OL-04: the line ⋯ opens TODAY\'s windows; the band and Money land on Lines', () => {
  it('the promise dialog on the line (Chosen lines, it ticked); the split with the line\'s pieces; the options window by its door', () => {
    const dialogs = read('./view/Dialogs.tsx')
    expect(dialogs).toContain("const asked = model.dialog?.kind === 'promise' ? (model.dialog.lineIds ?? null) : null")
    expect(dialogs).toContain("reasonCode: isPromiseReasonCode(reasonCode) ? reasonCode : null")
    expect(read('./view/SplitOrderDialog.tsx')).toContain("const asked = model.dialog?.kind === 'split' ? model.dialog.lineId : undefined")
    expect(read('./configurator/OrderLineOptions.tsx')).toContain('if (props.opened)')
    expect(read('./OrderRecord.tsx')).toContain('createElement(OrderLineOptions, { key: `options-${lineId}`, api, order: value, line, permissions: session.permissions, onReload: () => void load(), opened: true, onClose })')
    expect(read('./view/OrderRecordView.tsx')).toContain('{model.linesTab?.options}')
  })

  it('close / reopen: the reason optional (sent only when typed); the band\'s "Change the lines" and Money\'s "Change our price ›" land on Lines', () => {
    const acts = read('./use-lines-acts.ts')
    expect(acts).toContain('...(reason.trim() ? { reason: reason.trim() } : {})')
    expect(read('./view/DailyDialogs.tsx')).not.toContain("t('reopen.held.reason')")
    expect(read('./view/OrderRecordView.tsx')).toContain("label: t('lineMenu.changeLines')")
    const money = read('./view/PriceCheckSection.tsx')
    expect(money).toContain("onChangeOurs={() => actions?.linesTab?.onLand?.({ lineId: null, box: 'price' })}")
    expect(money).toContain('changeHeld={amendHeld(order, record.can)}')
  })
})
