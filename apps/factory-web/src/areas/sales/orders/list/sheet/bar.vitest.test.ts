import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { OrderStatus } from '../../api'
import { BAR_ORDER, BAR_PROMOTED, NO_BAR_CAN, barAllowed, barHeld, barOf, type BarAct, type BarActId, type BarCan, type BarRow } from './bar'
import { NEW_DRAFT, presetDraftOf } from '../../../../production/_shared/notes/model' // cw fx4: the ask's own rule

/**
 * F-CW-202 (customer Work tab plan §4; 10-design §4, §8; 13-backend §8; lead settles S8, S9, S36, S37) — the bar of ticked orders on
 * the ONE Orders sheet (the customer's Work tab, Sales › Orders, Sales › Made to measure): at most three acts with their words, the
 * rest in More ▾; an act without its right is NOT in the bar; an act the ticked orders cannot take now is held with words; the next
 * allowed act moves up. Pure rule: nothing here needs a DOM, an API or a database.
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const row = (n: number, status: OrderStatus = 'IN_PRODUCTION', partyId = ALPHA): BarRow => ({ id: `0190f0e2-0000-7000-8000-${String(n).padStart(12, '0')}`, number: `SEED-SO-${String(n).padStart(4, '0')}`, customerRef: null, partyId, partyName: partyId === ALPHA ? 'Brand Alpha' : 'Brand Beta', companyId: 'c1', status, units: 10, shippedUnits: 0 })
const rows = (count: number, status: OrderStatus = 'IN_PRODUCTION'): BarRow[] => Array.from({ length: count }, (_, index) => row(index + 1, status))
const HOST = { locked: null }
const ids = (acts: readonly BarAct[]): BarActId[] => acts.map((act) => act.id)

/** The roles of 10-design §8, as each act's OWN right (F-CW-301: shipping.manage; F-CW-302: production.brand.override). */
const ROLE: Record<'owner' | 'sales' | 'warehouse' | 'manager' | 'finance' | 'reader', BarCan> = {
  owner: { ship: true, urgency: true, manage: true, close: true, decide: true, post: true, supervisor: true, task: true, todo: true, invoices: true },
  sales: { ship: false, urgency: false, manage: true, close: true, decide: true, post: true, supervisor: false, task: true, todo: true, invoices: false },
  warehouse: { ship: true, urgency: false, manage: false, close: false, decide: true, post: true, supervisor: false, task: true, todo: false, invoices: false },
  manager: { ship: false, urgency: true, manage: false, close: false, decide: true, post: true, supervisor: true, task: true, todo: false, invoices: false },
  finance: { ship: false, urgency: false, manage: false, close: true, decide: true, post: true, supervisor: false, task: false, todo: false, invoices: true },
  reader: NO_BAR_CAN,
}

describe('F-CW-202: three acts with words, then More ▾ — per role (10-design §4)', () => {
  const three = rows(3)

  // F-CW-301 (S8): "Ship N together…" leads.
  // F-CW-302 (S7): the customer's urgency as we steer it is its own group, before money.
  it('the ONE order of the acts: Ship · Ask · Set priority, then Reply · Assign supervisor · Add task · Note ‖ Mark ready · Close · Confirm ‖ Customer urgency ×2 ‖ Invoice', () => {
    expect(BAR_ORDER.map((entry) => entry.id)).toEqual(['ship', 'ask', 'priority', 'reply', 'assign', 'task', 'note', 'ready', 'close', 'confirm', 'urgencyRegular', 'urgencyUnlock', 'invoice'])
    expect(BAR_PROMOTED).toBe(3)
    // More ▾ draws a rule where the group changes: what people read and write · the order's own commands · the customer's urgency · money.
    expect(BAR_ORDER.map((entry) => entry.group)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4])
  })

  it('Owner: Ship 3 together… · Ask ▾ · Set priority — More ▾ holds the rest in order, Reply first', () => {
    const bar = barOf(ROLE.owner, three, HOST)
    expect(ids(bar.promoted)).toEqual(['ship', 'ask', 'priority'])
    expect(ids(bar.more)).toEqual(['reply', 'assign', 'task', 'note', 'ready', 'close', 'confirm', 'urgencyRegular', 'urgencyUnlock', 'invoice'])
    expect(bar.none).toBe(false)
  })

  it('Sales (no shipping right, S23): Ask ▾ · Set priority · Reply moved up — no Ship, no Assign supervisor, no Invoice (not drawn)', () => {
    const bar = barOf(ROLE.sales, three, HOST)
    expect(ids(bar.promoted)).toEqual(['ask', 'priority', 'reply'])
    expect(ids(bar.more)).toEqual(['task', 'note', 'ready', 'close', 'confirm'])
  })

  it('Warehouse: Ship 3 together… · Ask ▾ · Reply — no orders.manage: Set priority, Mark ready and Close are not drawn', () => {
    const bar = barOf(ROLE.warehouse, three, HOST)
    expect(ids(bar.promoted)).toEqual(['ship', 'ask', 'reply'])
    expect(ids(bar.more)).toEqual(['task', 'note', 'confirm'])
  })

  it('Production manager: Ask ▾ · Reply · Assign supervisor… — More ▾: Add task · Note · Confirm ‖ Customer urgency ×2', () => {
    const bar = barOf(ROLE.manager, three, HOST)
    expect(ids(bar.promoted)).toEqual(['ask', 'reply', 'assign'])
    expect(ids(bar.more)).toEqual(['task', 'note', 'confirm', 'urgencyRegular', 'urgencyUnlock'])
  })

  it('Finance: closes, confirms and invoices; changes no order (no Set priority, no Mark ready), makes no task', () => {
    const bar = barOf(ROLE.finance, three, HOST)
    expect(ids(bar.promoted)).toEqual(['ask', 'reply', 'note'])
    expect(ids(bar.more)).toEqual(['close', 'confirm', 'invoice'])
  })

  it('Read-only: no act at all — the bar says so in one sentence, never a row of greyed buttons', () => {
    const bar = barOf(ROLE.reader, three, HOST)
    expect(bar).toEqual({ promoted: [], more: [], none: true })
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)('bar.none'), locale).not.toBe('bar.none')
    expect(createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)('bar.none')).toBe('Your role reads the orders and changes none: there is no act for the ticked rows.')
  })

  it('each act reads its OWN right (never a page-level "read only"): one right gives exactly its acts', () => {
    const only = (can: Partial<BarCan>) => BAR_ORDER.map((entry) => entry.id).filter((id) => barAllowed(id, { ...NO_BAR_CAN, ...can }))
    expect(only({ ship: true })).toEqual(['ship'])
    expect(only({ post: true })).toEqual(['ask', 'reply', 'note'])
    expect(only({ manage: true })).toEqual(['priority', 'ready', 'close'])
    expect(only({ close: true })).toEqual(['close'])
    expect(only({ decide: true })).toEqual(['confirm'])
    expect(only({ supervisor: true })).toEqual(['assign'])
    expect(only({ task: true })).toEqual(['task'])
    expect(only({ invoices: true })).toEqual(['invoice'])
    expect(only({ urgency: true })).toEqual(['urgencyRegular', 'urgencyUnlock']) // F-CW-302: no urgency act for Sales, Warehouse or Read-only
    expect(only({ todo: true })).toEqual([]) // F-CW-203: an entry of Ask ▾, never an act of its own (it needs threads.post too)
    expect(only({})).toEqual([])
    // Fewer than four acts: no More ▾ at all.
    expect(barOf({ ...NO_BAR_CAN, post: true }, three, HOST)).toMatchObject({ more: [], none: false })
  })
})

describe('F-CW-202: held with words only by a state, a cap or orders of more than one customer — never by a missing right', () => {
  it('a state: "None of the 3 is in production." (the commands\' own sentence); one in the state is enough', () => {
    expect(barHeld('ready', rows(3, 'READY'), ROLE.owner, HOST)).toEqual({ ns: 'sheet', key: 'bulk.noneInState', params: { count: 3 }, states: ['IN_PRODUCTION'] })
    expect(barHeld('ready', [row(1, 'READY'), row(2, 'IN_PRODUCTION')], ROLE.owner, HOST)).toBeNull()
    expect(barHeld('confirm', rows(2, 'CONFIRMED'), ROLE.owner, HOST)).toMatchObject({ key: 'bulk.noneInState', states: ['PENDING_APPROVAL'] })
    expect(barHeld('close', rows(2, 'SHIPPED'), ROLE.owner, HOST)).toBeNull()
  })

  it('the caps, each said in its own words: 50 (the commands, Reply), 100 (Note, Assign supervisor, Invoice), 200 (Set priority)', () => {
    expect(barHeld('ready', rows(51), ROLE.owner, HOST)).toEqual({ ns: 'sheet', key: 'bulk.tooMany', params: { max: 50 } })
    expect(barHeld('reply', rows(51), ROLE.owner, HOST)).toEqual({ ns: 'sheet', key: 'reply.tooMany', params: { max: 50 } })
    expect(barHeld('note', rows(101), ROLE.owner, HOST)).toMatchObject({ ns: 'notes', key: 'held.tooMany', params: { max: 100 } })
    expect(barHeld('assign', rows(101), ROLE.owner, HOST)).toMatchObject({ ns: 'supervisor', key: 'held.tooMany', params: { max: 100 } })
    expect(barHeld('invoice', rows(101), ROLE.owner, HOST)).toEqual({ ns: 'sheet', key: 'invoiceShipped.tooMany' })
    expect(barHeld('priority', rows(201), ROLE.owner, HOST)).toEqual({ ns: 'depth', key: 'held.tooMany', params: { max: 200 } })
    // Inside the caps: nothing holds.
    for (const id of ['priority', 'reply', 'assign', 'task', 'note', 'ready', 'invoice'] as const) expect(barHeld(id, rows(50), ROLE.owner, HOST), id).toBeNull()
    // The words exist where the rule says, in both languages.
    for (const locale of LOCALES) {
      const say = (ns: string, key: string, params: Record<string, number>) => createTranslator(locale, messagesFor(locale, [ns])[ns]!)(key, params)
      expect(say('orders-sheet', 'bulk.tooMany', { max: 50 }), locale).toContain('50')
      expect(say('orders-sheet', 'reply.tooMany', { max: 50 }), locale).toContain('50')
      expect(say('production-notes', 'held.tooMany', { count: 101, max: 100 }), locale).toContain('100')
      expect(say('production-supervisor', 'held.tooMany', { count: 101, max: 100 }), locale).toContain('100')
      expect(say('sales-orders-depth', 'held.tooMany', { max: 200 }), locale).toContain('200')
      expect(say('orders-sheet', 'invoiceShipped.tooMany', {}), locale).not.toBe('invoiceShipped.tooMany')
    }
  })

  it('orders of two customers hold the acts that open ONE window for ONE customer; the commands run across customers', () => {
    const mixed = [row(1), row(2, 'IN_PRODUCTION', BETA)]
    for (const id of ['priority', 'assign', 'task', 'note'] as const) expect(barHeld(id, mixed, ROLE.owner, HOST), id).toEqual({ ns: 'sheet', key: 'bulk.oneCustomer', params: { count: 2 } })
    expect(barHeld('reply', mixed, ROLE.owner, HOST)).toEqual({ ns: 'sheet', key: 'reply.oneCustomer' })
    expect(barHeld('ready', mixed, ROLE.owner, HOST)).toBeNull()
    // On the customer's own page a ticked order of another customer says so.
    expect(barHeld('note', [row(1, 'IN_PRODUCTION', BETA)], ROLE.owner, { locked: ALPHA })).toEqual({ ns: 'sheet', key: 'bulk.notThisCustomer' })
    expect(barHeld('reply', [row(1, 'IN_PRODUCTION', BETA)], ROLE.owner, { locked: ALPHA })).toEqual({ ns: 'sheet', key: 'bulk.notThisCustomer' })
  })

  it('a missing right is never a hold: whatever the role and the ticked orders, no act says "your role may not"', () => {
    const RIGHT_WORDS = ['held.noManage', 'held.noClose', 'held.noRight', 'reply.noRight', 'tasks.held.noManage', 'tasks.held.noPost']
    for (const can of Object.values(ROLE)) {
      for (const picked of [rows(1), rows(3, 'SHIPPED'), rows(60), [row(1), row(2, 'READY', BETA)]]) {
        const bar = barOf(can, picked, HOST)
        for (const act of [...bar.promoted, ...bar.more]) {
          expect(RIGHT_WORDS, `${act.id}`).not.toContain(act.held?.key ?? '')
          for (const entry of act.entries ?? []) expect(RIGHT_WORDS, entry.id).not.toContain(entry.held?.key ?? '')
        }
      }
    }
  })

  it('a held act keeps its place (it does not jump into More ▾, and nothing moves up over it)', () => {
    const bar = barOf(ROLE.owner, rows(60), HOST) // over the 20 of a shipment, the 50 of Reply and of the commands
    expect(ids(bar.promoted)).toEqual(['ship', 'ask', 'priority'])
    expect(bar.promoted[0]!.held).toEqual({ ns: 'sheet', key: 'ship.cap', params: { max: 20 } }) // F-CW-301: the cap, said before the click
    expect(bar.more.find((act) => act.id === 'reply')!.held).toEqual({ ns: 'sheet', key: 'reply.tooMany', params: { max: 50 } })
    expect(bar.more.find((act) => act.id === 'ready')!.held).toEqual({ ns: 'sheet', key: 'bulk.tooMany', params: { max: 50 } })
    expect(bar.more.find((act) => act.id === 'note')!.held).toBeNull()
  })
})

describe('F-CW-202: Ask ▾ — a menu for every role that writes (S37)', () => {
  it('"Ask production about N…": a note to each order\'s supervisor that needs an answer; held like Note to N (one customer, 100)', () => {
    // cw fx4: the RULE, not a fragment of a line (W3 added a field to that line and a literal pin broke) — the ask is the Note
    // window's own preset: "Needs an answer" ticked, each record's supervisor asked, the text left to the writer.
    const asked = presetDraftOf(NEW_DRAFT, { title: 'Ask production about 3 orders', body: '', needsAnswer: true, send: 'Write on 3' })
    expect([asked.needsAnswer, asked.askSupervisor, asked.body]).toEqual([true, true, ''])
    expect(NEW_DRAFT.needsAnswer).toBe(false) // a plain Note to N does not ask
    // Its title and its Send word are handed by the view — the Send word the Note window's own ("Write on 3"), whatever else the
    // preset carries (source; any other field may stand beside them).
    const view = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toMatch(/askProduction: \(\) => actions\?\.onAskProduction\?\.\(pickedIds, \{[^\n]*title: s\('bar\.askProductionTitle', \{ count: picked\.length \}\)[^\n]*send: n\('send', \{ count: picked\.length \}\)/)
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['production-notes'])['production-notes']!)('send', { count: 3 }), locale).toContain('3')
    const askOf = (bar: ReturnType<typeof barOf>): BarAct => bar.promoted.find((act) => act.id === 'ask')!
    const ask = askOf(barOf(ROLE.warehouse, rows(3), HOST))
    expect(ask).toMatchObject({ id: 'ask', held: null })
    expect(ask.entries!.map((entry) => entry.id)).toContain('askProduction')
    expect(ask.entries!.find((entry) => entry.id === 'askProduction')!.held).toBeNull()
    const many = askOf(barOf(ROLE.owner, rows(101), HOST))
    expect(many.entries!.find((entry) => entry.id === 'askProduction')!.held).toMatchObject({ ns: 'notes', key: 'held.tooMany' })
    const mixed = askOf(barOf(ROLE.owner, [row(1), row(2, 'READY', BETA)], HOST))
    expect(mixed.entries!.find((entry) => entry.id === 'askProduction')!.held).toEqual({ ns: 'sheet', key: 'bulk.oneCustomer', params: { count: 2 } })
  })

  // F-CW-203 (S8, S37): the second entry only for a reader who may make a customer's to-dos (partners.tasks.manage).
  it('"Ask <customer> about N…" only with partners.tasks.manage — Owner and Sales; Warehouse and Production manager get the first entry alone', () => {
    const entries = (role: keyof typeof ROLE) => barOf(ROLE[role], rows(3), HOST).promoted.find((act) => act.id === 'ask')!.entries!.map((entry) => entry.id)
    expect(entries('owner')).toEqual(['askProduction', 'askCustomer'])
    expect(entries('sales')).toEqual(['askProduction', 'askCustomer'])
    expect(entries('warehouse')).toEqual(['askProduction'])
    expect(entries('manager')).toEqual(['askProduction'])
    // Without the to-do right the customer is still asked by the plain reply: "Reply to <customer> on N…" stays an act of the bar.
    expect(ids(barOf(ROLE.warehouse, rows(3), HOST).promoted)).toContain('reply')
    // It is Reply to N with the tick ON: held exactly as Reply to N is (one customer, this page's customer, 50).
    const held = (picked: readonly BarRow[], locked: string | null = null) => barOf(ROLE.owner, picked, { locked }).promoted.find((act) => act.id === 'ask')!.entries!.find((entry) => entry.id === 'askCustomer')!.held
    expect(held(rows(3))).toBeNull()
    expect(held(rows(51))).toEqual({ ns: 'sheet', key: 'reply.tooMany', params: { max: 50 } })
    expect(held([row(1), row(2, 'READY', BETA)])).toEqual({ ns: 'sheet', key: 'reply.oneCustomer' })
    expect(held([row(1, 'READY', BETA)], ALPHA)).toEqual({ ns: 'sheet', key: 'bulk.notThisCustomer' })
    const view = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('askCustomer: () => actions?.onReplyMany?.(pickedIds, { todo: true }),')
    expect(view).toContain('todo: !!model.bulkCan?.todo /* F-CW-203 */')
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      expect(s('bar.askCustomer', { customer: 'Brand Alpha', count: 3 }), locale).toContain('Brand Alpha')
      for (const key of ['bar.askCustomerAny', 'bar.askCustomerWho']) expect(s(key, { count: 3 }), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const it_ = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect([en('bar.askCustomer', { customer: 'Seed Racing', count: 3 }), it_('bar.askCustomer', { customer: 'Seed Racing', count: 3 })]).toEqual(['Ask Seed Racing about 3…', 'Chiedi a Seed Racing su 3…'])
  })

  it('it opens production\'s ONE Note window as an ask — the supervisor asked, "Needs an answer" ticked (source)', () => {
    const hook = readFileSync(new URL('../use-orders-sheet.ts', import.meta.url), 'utf8')
    // cw fx4: the rule (the same Note window, over the ticked orders, opened with "Needs an answer" and an empty text) — whatever
    // other field the preset carries.
    expect(hook).toMatch(/onAskProduction: \(ids, words\) => note\.open\(noteTargetsOf\(pickedRows\(ids\)\), 'selection', undefined, \{[^\n]*body: ''[^\n]*needsAnswer: true[^\n]*send: words\.send/)
    expect(hook).not.toMatch(/onAskProduction:[^\n]*needsAnswer: false/)
    const notes = readFileSync(new URL('../../../../production/_shared/notes/model.ts', import.meta.url), 'utf8')
    expect(notes).toContain('askSupervisor: preset.askSupervisor ?? true')
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      for (const key of ['bar.ask', 'bar.more', 'bar.askProductionWho']) expect(s(key), `${locale} ${key}`).not.toBe(key)
      expect(s('bar.askProduction', { count: 3 }), locale).toContain('3')
      for (const count of [1, 3]) expect(s('bar.askProductionTitle', { count }), locale).toContain(String(count))
    }
    const en = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const it_ = createTranslator('it', messagesFor('it', ['orders-sheet'])['orders-sheet']!)
    expect([en('bar.ask'), it_('bar.ask'), en('bar.more'), it_('bar.more')]).toEqual(['Ask', 'Chiedi', 'More', 'Altro'])
    expect([en('bar.askProduction', { count: 3 }), it_('bar.askProduction', { count: 3 })]).toEqual(['Ask production about 3…', 'Chiedi alla produzione su 3…'])
  })
})

describe('F-CW-202: the view draws the rule — on every host of the sheet (source)', () => {
  const view = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')

  it('the promoted acts are buttons whose words stay at every width; More ▾ sits in the frame\'s trailing slot, last before Clear', () => {
    expect(view).toContain('actions: barActs, // F-CW-202: at most three acts with words')
    expect(view).toContain('trailing: barMore, // F-CW-202')
    expect(view).toContain("<Button key={act.id} size=\"sm\" variant={act.id === 'ship' ? 'primary' : undefined /* F-CW-301: the leading act */} heldReason={sayBar(act.held)} onClick={barRun[act.id]}>")
    // The DS hides a SelectionLabel when the bar is short of room: the sheet's own acts do not use one (the frame's Edit N, Export N
    // and Clear give way first).
    expect(view).not.toContain('<SelectionLabel>')
    // A held act in More ▾ says why under its name (never a tooltip only).
    expect(view).toContain('...(held ? { disabled: true, description: held } : { onSelect: barRun[id] })')
    // The old flat row of buttons is gone.
    expect(view).not.toMatch(/SetPriorityButton|manyShown\(model\.can/)
  })

  it('the rights come from the one hook, each act its own: shipping.manage, production.brand.override, threads.post, production.brand.manage, tasks.manage, partners.tasks.manage, approvals.decide, orders.manage / close, invoices.manage', () => {
    expect(view).toContain('{ ship: !!model.ship?.can.manage /* F-CW-301 */, urgency: !!model.urgency?.can /* F-CW-302 */, manage: model.can.manage, close: model.can.close, decide: !!model.commands?.decide, post: !!model.bulkCan?.note, supervisor: !!model.bulkCan?.supervisor, task: model.bulkCan?.task === null, todo: !!model.bulkCan?.todo /* F-CW-203 */, invoices: model.can.manageInvoices },')
    const hook = readFileSync(new URL('../use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toContain("bulkCan: { supervisor: session.permissions.includes('production.brand.manage'), note: noteCan, task: taskHeld")
    expect(hook).toContain("const noteCan = session.permissions.includes('threads.post')")
    // No host draws a bar of its own: the three hosts embed the ONE view.
    for (const host of ['../../../customers/record/view/WorkTab.tsx', '../OrdersPage.tsx', '../../../mtm/MtmPage.tsx']) expect(readFileSync(new URL(host, import.meta.url), 'utf8'), host).not.toMatch(/barOf\(|GridSelectionActions/)
  })

  it('Edit N is the frame\'s own act: not drawn without orders.manage (S9); Export N stays the frame\'s, by the export right', () => {
    expect(view).toContain("...(model.can.manage ? { bulk: { noun: { one: s('cells.nounOne'), other: s('cells.nounOther') } } } : {}),")
    expect(view).toContain('exportSelected: true')
  })

  it('the key v (List ⇄ Board) only where the switch is drawn: off on the customer\'s Work tab, and out of its keys list (S36)', () => {
    expect(view).toContain("...(model.layoutSwitch === false ? [] : [{ keys: ['v'], does: t('list.keyView') }]),")
    expect(view).toContain("if (event.key === 'v' && model.layoutSwitch !== false")
    const tab = readFileSync(new URL('../../../customers/record/view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('layoutSwitch: false,')
    for (const host of ['../OrdersPage.tsx', '../../../mtm/MtmPage.tsx']) expect(readFileSync(new URL(host, import.meta.url), 'utf8'), host).not.toContain('layoutSwitch')
  })
})
