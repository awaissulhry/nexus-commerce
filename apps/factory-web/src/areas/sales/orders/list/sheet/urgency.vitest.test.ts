import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { CARD_LIMITS } from '../../../../_shared/customer-urgency/model'
import type { OrderRow } from '../../api'
import { urgentRuleOf } from '../../model'
import { barHeld, NO_BAR_CAN } from './bar'
import { askedHrefOf, rowUrgencyActs, urgencyDialogOf, urgencyHeld, urgencyLeftOf, urgencyTargetsOf, type UrgencyRow } from './urgency'

/**
 * F-CW-302 (customer Work tab plan §4; 10-design §4, §5; lead settles S7, S14, S35) — the customer's urgency as WE steer it, on the ONE
 * Orders sheet: Set to regular… · Lock… · Unlock… in a row's ⋯ and under More ▾. The window, its rules and its write are the SHARED
 * ones (areas/_shared/customer-urgency: their own tests); here: which act a row offers, which ticked orders an act runs on, why it is
 * held before the click, where "Urgent – asked" leads — and that the sheet mounts the shared window and copies none. Made-up orders.
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
type State = NonNullable<OrderRow['customerUrgencyState']>
const state = (kind: State['state'], over: Partial<State> = {}): State => ({ state: kind, urgentRank: kind === 'URGENT' ? 1 : null, locked: false, requestId: null, ...over })
const row = (n: number, urgency: State | null | undefined, partyId = ALPHA): UrgencyRow => ({ id: `o${n}`, number: `SEED-SO-000${n}`, customerRef: n === 2 ? 'PO-7' : null, partyId, partyName: partyId === ALPHA ? 'Seed Racing' : 'Brand Beta', ...(urgency === undefined ? {} : { customerUrgencyState: urgency }) })
const HOST = { locked: null }

describe('F-CW-302: the acts a row offers — the Customer card\'s own rule', () => {
  it('Set to regular… on an order the customer marks Urgent; Lock… while not locked, Unlock… while locked; none without a state that counts', () => {
    expect(rowUrgencyActs(row(1, state('URGENT')))).toEqual(['regular', 'lock'])
    expect(rowUrgencyActs(row(1, state('URGENT', { locked: true })))).toEqual(['regular', 'unlock'])
    expect(rowUrgencyActs(row(1, state('ASKED', { requestId: 'req-1' })))).toEqual(['lock'])
    expect(rowUrgencyActs(row(1, state('REGULAR')))).toEqual(['lock'])
    expect(rowUrgencyActs(row(1, state('SET_BACK', { locked: true })))).toEqual(['unlock'])
    expect(rowUrgencyActs(row(1, state('SET_BACK')))).toEqual(['lock'])
    // The order left production, or the customer's switch is off (the API answers null); an older answer without the field.
    expect(rowUrgencyActs(row(1, null))).toEqual([])
    expect(rowUrgencyActs(row(1, undefined))).toEqual([])
  })

  it('an act over ticked orders runs on exactly those that take it — the window names them, with the customer\'s PO', () => {
    const picked = [row(1, state('URGENT')), row(2, state('URGENT', { urgentRank: 2 })), row(3, state('SET_BACK', { locked: true })), row(4, null)]
    expect(urgencyTargetsOf('regular', picked)).toEqual([{ id: 'o1', number: 'SEED-SO-0001', customerRef: null }, { id: 'o2', number: 'SEED-SO-0002', customerRef: 'PO-7' }])
    expect(urgencyTargetsOf('unlock', picked).map((order) => order.id)).toEqual(['o3'])
    expect(urgencyTargetsOf('lock', picked).map((order) => order.id)).toEqual(['o1', 'o2'])
    expect(urgencyDialogOf('regular', picked)).toEqual({ act: 'regular', partyId: ALPHA, orders: urgencyTargetsOf('regular', picked) })
    expect(urgencyDialogOf('unlock', [row(1, state('URGENT'))])).toBeNull() // nothing to unlock: no window
    expect(urgencyDialogOf('regular', [])).toBeNull()
  })

  // F-CW-304 (10-design §6 W4): the window says which ticked orders it does not run on, each with why — never silently dropped.
  it('"Runs on 2 · Not on 2: why is beside each": not marked urgent, not locked, no urgency that counts; one row or all taking it: nothing', () => {
    const picked = [row(1, state('URGENT')), row(2, state('URGENT', { urgentRank: 2 })), row(3, state('SET_BACK', { locked: true })), row(4, null)]
    expect(urgencyLeftOf('regular', picked)).toEqual([{ id: 'o3', label: 'SEED-SO-0003', why: 'notUrgent' }, { id: 'o4', label: 'SEED-SO-0004', why: 'none' }])
    expect(urgencyLeftOf('unlock', picked)).toEqual([{ id: 'o1', label: 'SEED-SO-0001', why: 'notLocked' }, { id: 'o2', label: 'SEED-SO-0002 (PO-7)', why: 'notLocked' }, { id: 'o4', label: 'SEED-SO-0004', why: 'none' }])
    expect(urgencyLeftOf('lock', [row(3, state('SET_BACK', { locked: true }))])).toEqual([{ id: 'o3', label: 'SEED-SO-0003', why: 'locked' }])
    expect(urgencyLeftOf('regular', [row(1, state('URGENT'))])).toEqual([])
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      for (const key of ['urgency.left.label', 'urgency.left.notUrgent', 'urgency.left.notLocked', 'urgency.left.locked', 'urgency.left.none']) expect(s(key), `${locale} ${key}`).not.toBe(key)
      for (const count of [1, 2]) for (const key of ['commands.runs', 'commands.notOn']) expect(s(key, { count }), `${locale} ${key}`).not.toBe(key)
    }
    // The shared window only gains a slot for a host's own lines: the work order's Customer card gives none (it looks as before).
    const dialog = readFileSync(new URL('../../../../_shared/customer-urgency/view/UrgencyOverrideDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain('        {above}\n        {model.problem && <Banner')
    expect(readFileSync(new URL('../../../../production/work-orders/record/customer/view/CustomerCard.tsx', import.meta.url), 'utf8')).not.toContain('above=')
  })
})

describe('F-CW-302: held before the click by a state only — never by a missing right (the act is not drawn then)', () => {
  it('orders of two customers; the customer\'s switch off; none urgent; none locked; more than the write takes', () => {
    const urgent = [row(1, state('URGENT')), row(2, state('REGULAR')), row(3, state('SET_BACK', { locked: true }))]
    expect(urgencyHeld('regular', urgent, HOST)).toBeNull()
    expect(urgencyHeld('unlock', urgent, HOST)).toBeNull()
    expect(urgencyHeld('regular', [row(1, state('URGENT')), row(2, state('URGENT'), BETA)], HOST)).toEqual({ key: 'bulk.oneCustomer', params: { count: 2 } })
    expect(urgencyHeld('regular', [row(1, state('URGENT'), BETA)], { locked: ALPHA })).toEqual({ key: 'bulk.notThisCustomer' })
    // Only the customer's Work tab knows the switch: every urgency act says it then.
    expect(urgencyHeld('regular', urgent, { locked: ALPHA, urgencyOff: true })).toEqual({ key: 'urgency.held.off', params: { customer: 'Seed Racing' } })
    expect(urgencyHeld('unlock', urgent, { locked: ALPHA, urgencyOff: true })).toEqual({ key: 'urgency.held.off', params: { customer: 'Seed Racing' } })
    expect(urgencyHeld('regular', [row(1, state('REGULAR')), row(2, null), row(3, state('ASKED'))], HOST)).toEqual({ key: 'urgency.held.noneUrgent', params: { count: 3, customer: 'Seed Racing' } })
    expect(urgencyHeld('unlock', [row(1, state('URGENT')), row(2, state('SET_BACK'))], HOST)).toEqual({ key: 'urgency.held.noneLocked', params: { count: 2 } })
    expect(CARD_LIMITS.orders).toBe(100)
    expect(urgencyHeld('regular', Array.from({ length: 101 }, (_, index) => row(index + 1, state('URGENT'))), HOST)).toEqual({ key: 'bulk.tooMany', params: { max: 100 } })
    expect(urgencyHeld('regular', Array.from({ length: 100 }, (_, index) => row(index + 1, state('URGENT'))), HOST)).toBeNull()
    expect(urgencyHeld('regular', [], HOST)).toBeNull()
    // The bar says it with the sheet's words.
    const picked = [{ ...row(1, state('REGULAR')), companyId: 'c1', status: 'IN_PRODUCTION' as const, units: 10, shippedUnits: 0 }]
    expect(barHeld('urgencyRegular', picked, { ...NO_BAR_CAN, urgency: true }, HOST)).toEqual({ ns: 'sheet', key: 'urgency.held.noneUrgent', params: { count: 1, customer: 'Seed Racing' } })
    expect(barHeld('urgencyUnlock', picked, { ...NO_BAR_CAN, urgency: true }, HOST)).toEqual({ ns: 'sheet', key: 'urgency.held.noneLocked', params: { count: 1 } })
  })

  it('the words, in both languages: the two labels of More ▾, the three holds; the row\'s acts and head are existing words', () => {
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      for (const key of ['bar.urgencyRegular', 'bar.urgencyUnlock', 'col.customerUrgency', 'row.answer', 'sort.urgentRuleOff']) expect(s(key), `${locale} ${key}`).not.toBe(key)
      for (const count of [1, 3]) for (const key of ['urgency.held.noneUrgent', 'urgency.held.noneLocked']) expect(s(key, { count, customer: 'Seed Racing' }), `${locale} ${key} ${count}`).not.toBe(key)
      expect(s('urgency.held.off', { customer: 'Seed Racing' }), locale).toContain('Seed Racing')
      const p = createTranslator(locale, messagesFor(locale, ['production']).production!)
      for (const act of ['regular', 'lock', 'unlock']) expect(p(`customerCard.urgency.act.${act}`), `${locale} ${act}`).not.toBe(`customerCard.urgency.act.${act}`)
    }
    const en = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const it_ = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect([en('bar.urgencyRegular'), en('bar.urgencyUnlock')]).toEqual(['Customer urgency: Set to regular…', 'Customer urgency: Unlock…'])
    expect([it_('bar.urgencyRegular'), it_('bar.urgencyUnlock')]).toEqual(['Urgenza cliente: Riporta a normale…', 'Urgenza cliente: Sblocca…'])
    expect(en('urgency.held.noneUrgent', { count: 3, customer: 'Seed Racing' })).toBe('None of the 3 is urgent for Seed Racing.')
    expect(en('urgency.held.noneLocked', { count: 3 })).toBe('None of the 3 is locked.')
    expect(en('urgency.held.off', { customer: 'Seed Racing' })).toBe('Customer urgency is off for Seed Racing.')
  })

  it('"Most urgent first" has no middle part while the customer\'s switch is off (only its own Work tab knows it)', () => {
    expect(urgentRuleOf('Seed Racing')).toEqual({ key: 'sort.urgentRule', params: { customer: 'Seed Racing' } })
    expect(urgentRuleOf('Seed Racing', true)).toEqual({ key: 'sort.urgentRuleOff' })
    expect(urgentRuleOf(null, true)).toEqual({ key: 'sort.urgentRuleAll' }) // several customers: no one switch
    expect(createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)('sort.urgentRuleOff')).toBe('(our priority, then promise date)')
  })
})

describe('F-CW-302: "Urgent – asked" is a door (S7)', () => {
  it('the review window in place where the page holds it; the order\'s Changes tab on the other two hosts; nothing for another state', () => {
    const asked = row(1, state('ASKED', { requestId: 'req-9' }))
    expect(askedHrefOf('/office', asked, (requestId) => `/office/sales/customers/c1?tab=work&request=${requestId}`)).toBe('/office/sales/customers/c1?tab=work&request=req-9')
    expect(askedHrefOf('/office', asked, null)).toBe('/office/sales/orders/o1?tab=changes')
    expect(askedHrefOf('/office', asked)).toBe('/office/sales/orders/o1?tab=changes')
    // An older answer names no request: the order's Changes tab even on the page with the door.
    expect(askedHrefOf('/office', row(1, state('ASKED')), () => '/never')).toBe('/office/sales/orders/o1?tab=changes')
    for (const other of [state('URGENT'), state('SET_BACK'), state('REGULAR'), null, undefined]) expect(askedHrefOf('/office', row(1, other), () => '/never')).toBeNull()
  })
})

describe('F-CW-302: the sheet mounts the SHARED window — never a copy (source)', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the same hook and the same dialog as the work order\'s Customer card; no dialog of its own', () => {
    const hook = read('../use-orders-sheet.ts')
    expect(hook).toContain("import { useUrgencyOverride } from '../../../_shared/customer-urgency/use-urgency-override' // F-CW-302")
    expect(hook).toContain('const urgency = useUrgencyOverride(api, urgencyStepUp.guard, urgencyAgain, urgencyAgain)')
    const window = read('../view/UrgencyWindow.tsx')
    expect(window).toContain("import { UrgencyOverrideDialog } from '../../../../_shared/customer-urgency/view/UrgencyOverrideDialog'")
    expect(window).toContain("import { UrgencyOutcome } from '../../../../_shared/customer-urgency/view/UrgencyOutcome'")
    expect(window).toContain('{model.dialog && <UrgencyOverrideDialog model={model} actions={actions} above={<UrgencyAbove model={model} />} />}')
    expect(window).not.toMatch(/<Modal\b|<Input\b|<Checkbox\b|setBackUrgency|unlockUrgency/)
    const card = read('../../../../production/work-orders/record/customer/use-customer-card.ts')
    expect(card).toContain('const urgency = useUrgencyOverride(')
    // No second copy of the write anywhere in the sales area.
    for (const file of ['../use-orders-sheet.ts', './urgency.ts', '../view/OrdersListView.tsx']) expect(read(file), file).not.toMatch(/brand-orders\/urgency|setBackUrgency|unlockUrgency/)
  })

  it('hidden without production.brand.override; a fresh code by this page\'s own step-up; the orders named are read again in place', () => {
    const hook = read('../use-orders-sheet.ts')
    expect(hook).toContain("const urgencyCan = session.permissions.includes('production.brand.override')")
    expect(hook).toContain('urgency: urgencyCan ? { ...urgency.model, can: true, stepUp: urgencyStepUp.stepUp, left: urgencyLeft /* F-CW-304 */ } : null, // F-CW-302')
    expect(hook).toContain('const urgencyStepUp = useStepUp(api)')
    expect(hook).toContain('const urgencyAgain = () => rereadInPlace(urgencyAsked.current)')
    const view = read('../view/OrdersListView.tsx')
    expect(view).toContain('urgency: !!model.urgency?.can /* F-CW-302 */,')
    expect(view).toContain('const urgencyActs = latest.current.model.urgency?.can && act()?.onUrgency ? rowUrgencyActs(data) : []')
    // The step-up sentence is the one the work order page says (one sentence for one act), in both languages.
    expect(read('../view/UrgencyWindow.tsx')).toContain("sentence={model.stepUp.sentence ? w(model.stepUp.sentence) : ''}")
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['production-work-orders'])['production-work-orders']!)('stepUp.urgencySentence'), locale).not.toBe('stepUp.urgencySentence')
  })

  it('the row ⋯: its own head, the card\'s act words, "Answer request…" once for an order whose "Urgent – asked" waits', () => {
    const view = read('../view/OrdersListView.tsx')
    expect(view).toContain("{ id: 'head-urgency', heading: true, label: s('col.customerUrgency') },")
    expect(view).toContain('label: pw(`customerCard.urgency.act.${kind}`)')
    expect(view).toContain("...(askedHref ? [{ id: 'urgency-answer', label: s('row.answer'), href: askedHref }] : []),")
    expect(view).toContain('...answerItem(data).filter((item) => !(urgencyItems.length > 0 && item.href === askedHref)),')
    expect(view).toContain("...(urgencyItems.length > 0 ? [{ id: 'sep-urgency', separator: true }, ...urgencyItems] : []), // F-CW-302")
  })

  it('the switch is the customer\'s Work tab\'s own read: Sales › Orders and Made to measure never set it (S35)', () => {
    expect(read('../../../customers/record/view/WorkTab.tsx')).toContain('urgencyOff: urgencyFoot !== null && !urgencyFoot.on,')
    for (const host of ['../OrdersPage.tsx', '../../../mtm/MtmPage.tsx', '../use-orders-sheet.ts']) expect(read(host), host).not.toMatch(/urgencyOff|getCustomerUrgency|useUrgencyFoot/)
  })
})
