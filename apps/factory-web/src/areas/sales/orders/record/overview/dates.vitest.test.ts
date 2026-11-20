import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { formatDate } from '../../../../../lib/i18n/format'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { order } from '../../_demo/fixtures'
import { abilitiesOf, dayInstant } from '../../model'
import { base } from '../fixtures'
import type { OrderRecordModel } from '../record-model'
import { DatesCard } from '../view/overview/DatesCard'
import type { Order } from '../../api'
import type { Headline, OrderProduction } from './api'
import { FAILED_STATE, HEADLINE, LOADING_STATE, PRODUCTION_READ, ready } from './fixtures'
import { nextDatesOf, planSaysOf, planWarns, promiseRowOf } from './dates'
// ---- F-OO-143: the refused new date and Decide… ----
import { TODAY } from '../../_demo/fixtures'
import type { BandDialog } from '../record-model'
import { OrderDialogs } from '../view/Dialogs'
import { changesBadgeOf, orderWaitingOf, type WaitingState } from './model'
import { ageDaysOf, ageWordsOf, decideDialogOf, followUpOf, refusedDatesOf } from './dates'
// ---- end F-OO-143

/** F-OO-100 (order overview lane: one file per section) — Next dates' rules, moved with dates.ts out of overview.vitest.test.ts. */

const milestone = (id: string, kind: string, target: string | null, late: number | null, state = 'TO_COME') => ({ id, kind, gateId: kind === 'GATE' ? `g-${id}` : null, gateKind: kind === 'GATE' ? 'PP_SAMPLE' : null, label: null, target, actual: null, state, late, owner: null })

describe('Overview’s facts (F-SA-233): Next dates', () => {
  it('next dates: the open gates, three at most — late first (most late first), then by target (F-OO-141: gates only)', () => {
    const dates = { ...PRODUCTION_READ.dates!, milestones: [milestone('a', 'GATE', '2026-11-22', null), milestone('b', 'GATE', '2026-11-15', 3), milestone('c', 'GATE', '2026-11-10', 1), milestone('d', 'GATE', '2026-11-01', null, 'DONE'), milestone('e', 'GATE', '2026-11-20', null)] }
    expect(nextDatesOf(dates).map((row) => row.id)).toEqual(['b', 'c', 'e'])
    expect(nextDatesOf(dates)[0]).toEqual({ id: 'b', gateId: 'g-b', gateKind: 'PP_SAMPLE', label: null, target: '2026-11-15', late: 3 })
    expect(nextDatesOf(null)).toEqual([])
  })
})

// ---- F-OO-141 (order overview lane; 10-design §4; review F8): Promised, Plan says ready, Requested; no SHIP row, no Production start -
describe('F-OO-141: Next dates — the promise first, what the plan says against it, the requested date, then the open gates', () => {
  const promised = (date: string | null) => ({ promiseDate: date })
  const planned = (finish: string | null) => ({ planned: { cutStart: null, sewStart: null, finish } })
  const status = (value: Order['status']) => ({ status: value })

  it('the shipping milestone (its target IS the promise) and the plan’s start are never listed; no ex-factory filler', () => {
    const dates = { ...PRODUCTION_READ.dates!, milestones: [milestone('s', 'START', '2026-11-22', null), milestone('x', 'SHIP', '2026-12-15', null), milestone('g', 'GATE', '2026-11-25', null)] }
    expect(nextDatesOf(dates).map((row) => row.id)).toEqual(['g'])
    // The demo order's read: two gates done, the start done, shipping to come — nothing to list.
    expect(nextDatesOf(PRODUCTION_READ.dates)).toEqual([])
  })

  it('promiseRowOf: the promise in force (the read’s, else the order’s) and how it moved — a first promise is no move', () => {
    expect(promiseRowOf(promised('2026-12-01'), HEADLINE)).toEqual({ date: '2026-12-15', moved: { key: 'dates.promisedMoved', params: { date: '2026-12-15', count: 2, days: '+6' } } })
    const promise = (moves: number, slipDays: number | null) => ({ promise: { ...HEADLINE.promise, moves, slipDays } })
    expect(promiseRowOf(promised(null), promise(1, 0))).toEqual({ date: '2026-12-15', moved: { key: 'dates.promisedMovedOnly', params: { date: '2026-12-15', count: 1 } } })
    expect(promiseRowOf(promised(null), promise(3, -2))?.moved).toEqual({ key: 'dates.promisedMoved', params: { date: '2026-12-15', count: 3, days: '-2' } })
    expect(promiseRowOf(promised(null), promise(0, null))).toEqual({ date: '2026-12-15', moved: null })
    expect(promiseRowOf(promised('2026-12-20'), null)).toEqual({ date: '2026-12-20', moved: null })
    expect(promiseRowOf(promised(null), { promise: { ...HEADLINE.promise, date: null } })).toBeNull()
  })

  it('planSaysOf: after / before / same day / none — derived from the published plan; with no promise its day alone', () => {
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-11', planned('2026-12-13'))).toEqual({ kind: 'after', date: '2026-12-13', days: 2 })
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-15', planned('2026-12-10'))).toEqual({ kind: 'before', date: '2026-12-10', days: 5 })
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-15', planned('2026-12-15'))).toEqual({ kind: 'same', date: '2026-12-15' })
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-30', planned('2027-01-02'))).toEqual({ kind: 'after', date: '2027-01-02', days: 3 })
    expect(planSaysOf(status('IN_PRODUCTION'), null, planned('2026-12-13'))).toEqual({ kind: 'plain', date: '2026-12-13' })
    // Nothing plans it yet: amber when the order has a promise (the cause of "At risk"); a waiting order is simply not planned yet.
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-15', planned(null))).toEqual({ kind: 'none', warn: true })
    expect(planSaysOf(status('PENDING_APPROVAL'), '2026-12-15', planned(null))).toEqual({ kind: 'none', warn: false })
    expect(planSaysOf(status('CONFIRMED'), null, planned(null))).toEqual({ kind: 'none', warn: false })
    // Not read: no claim. After production the plan is history.
    expect(planSaysOf(status('IN_PRODUCTION'), '2026-12-15', null)).toBeNull()
    for (const after of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(planSaysOf(status(after), '2026-12-15', planned('2026-12-20')), after).toBeNull()
    expect(planWarns({ kind: 'after', date: '2026-12-13', days: 2 })).toBe(true)
    expect(planWarns({ kind: 'before', date: '2026-12-10', days: 5 })).toBe(false)
    expect(planWarns({ kind: 'same', date: '2026-12-15' })).toBe(false)
    expect(planWarns({ kind: 'none', warn: true })).toBe(true)
    expect(planWarns({ kind: 'none', warn: false })).toBe(false)
  })

  it('the words in both languages ("tu"); "moved 1×" / "spostata 1 volta" by its count', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['dates.promisedExFactory', 'dates.planSays', 'dates.planNone', 'dates.fromPlan', 'dates.requestedByCustomer']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const key of ['dates.planAfter', 'dates.planBefore', 'dates.planSame', 'dates.promisedMoved', 'dates.promisedMovedOnly']) expect(t(key, { date: 'D', days: 2, count: 2 }), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(en('dates.promisedMoved', { date: 'D', count: 2, days: '+6' })).toBe('D · moved 2× · +6 d since first promised')
    expect(it('dates.promisedMoved', { date: 'D', count: 1, days: '+6' })).toBe('D · spostata 1 volta · +6 g dalla prima promessa')
    expect(it('dates.promisedMovedOnly', { date: 'D', count: 2 })).toBe('D · spostata 2 volte')
    expect(en('dates.planAfter', { date: 'D', days: 2 })).toBe('D · 2 d after the promise')
    expect(it('dates.fromPlan')).toBe('(dal piano)')
    // The old "No dates set yet" went: with no open gate the gates' block is left out.
    expect(en('overview.dates.none')).toBe('overview.dates.none')
  })

  describe('the card drawn', () => {
    const value = order('IN_PRODUCTION') // promised 15/12/2026, requested 10/12/2026
    const day = (date: string, locale: 'en' | 'it' = 'en') => formatDate(dayInstant(date), { locale })
    const card = (over: Partial<OrderRecordModel> = {}, locale: 'en' | 'it' = 'en', of = value) => render(createElement(DatesCard, { order: of, model: base('sales', of, { tab: 'overview', production: ready(), ...over }).record }), locale)
    const withPlan = (finish: string | null, extra: Partial<OrderProduction['dates'] & object> = {}) => ready({ ...PRODUCTION_READ, dates: { ...PRODUCTION_READ.dates!, planned: { ...PRODUCTION_READ.dates!.planned, finish }, ...extra } })

    it('Promised (ex-factory) first with its moves and Change…, Plan says ready under it "(from the plan)", then Requested by customer', () => {
      const text = textOf(card())
      const at = (words: string) => text.indexOf(words)
      expect(text).toContain(`Promised (ex-factory) ${day('2026-12-15')} · moved 2× · +6 d since first promised Change…`)
      expect(text).toContain(`Plan says ready ${day('2026-12-10')} · 5 d before the promise (from the plan)`)
      expect(text).toContain(`Requested by customer ${day('2026-12-10')} Change…`)
      expect(at('Promised (ex-factory)')).toBeLessThan(at('Plan says ready'))
      expect(at('Plan says ready')).toBeLessThan(at('Requested by customer'))
      // No shipping row, no Production start, no "No dates set yet", no ex-factory filler; no open gate: no gates' block.
      for (const gone of ['Shipping', 'Production start', 'No dates set yet', 'Ex-factory']) expect(text, gone).not.toContain(gone)
      expect(card()).not.toContain('is-gates')
      const it = textOf(card({}, 'it'))
      for (const words of ['Promesso (franco fabbrica)', 'spostata 2 volte', 'Il piano dice pronto', '5 g prima della promessa', '(dal piano)', 'Richiesto dal cliente', 'Cambia…']) expect(it, words).toContain(words)
    })

    it('the plan after the promise is amber (the cause of "At risk"); nothing planned: "Nothing plans it yet", amber', () => {
      const late = card({ production: withPlan('2026-12-20') })
      expect(textOf(late)).toContain(`${day('2026-12-20')} · 5 d after the promise`)
      expect(late).toContain('<span class="fw-so-dates-warn">')
      const none = card({ production: withPlan(null) })
      expect(textOf(none)).toContain('Plan says ready Nothing plans it yet')
      expect(none).toContain('<span class="fw-so-dates-warn">')
      expect(card()).not.toContain('fw-so-dates-warn')
    })

    it('the open gates after a rule, late first, each with its target and lateness (Discuss stays the gate’s by its reference)', () => {
      const html = card({ production: withPlan('2026-12-10', { milestones: [...PRODUCTION_READ.dates!.milestones, milestone('late', 'GATE', '2026-11-20', 3)] }) })
      expect(html).toContain('<ul class="fw-so-dates-rows is-gates"')
      expect(textOf(html)).toContain(`Pre-production sample target ${day('2026-11-20')} 3 days late`)
    })

    it('Read-only: the dates and what the plan says, no Change…; reading: the own dates and a line; failed: said, with Try again', () => {
      const readOnly = card({ can: abilitiesOf(['orders.view', 'workorders.view']) })
      expect(readOnly).not.toContain('<button')
      expect(textOf(readOnly)).toContain('Plan says ready')
      const reading = card({ production: LOADING_STATE })
      expect(textOf(reading)).toContain('Promised (ex-factory)')
      expect(textOf(reading)).not.toContain('Plan says ready')
      expect(reading).toContain('aria-busy="true"')
      const failed = textOf(card({ production: FAILED_STATE }))
      expect(failed).toContain('Couldn’t read the milestones')
      expect(failed).toContain('Try again')
      expect(failed).toContain('Requested by customer')
      expect(failed).not.toContain('Plan says ready')
      // After production the plan is history: no Plan says ready.
      const shipped = order('SHIPPED')
      expect(textOf(card({}, 'en', shipped))).not.toContain('Plan says ready')
    })

    it('the source: the ONE promise dialog and the requested date’s door; its own css: the grid, the rows on it, 375 stacks, tokens only', () => {
      const view = readFileSync(new URL('../view/overview/DatesCard.tsx', import.meta.url), 'utf8')
      expect(view).toContain("onClick={() => actions?.onDialog?.({ kind: 'promise' })}")
      expect(view).toContain('onClick={() => actions?.onRequestedChange?.()}')
      expect(view).toContain("import './dates.css'")
      for (const gone of ['overview.dates.none', 'milestone.kind.', 'exFactory']) expect(view, gone).not.toContain(gone)
      const css = readFileSync(new URL('../view/overview/dates.css', import.meta.url), 'utf8')
      expect(css).toMatch(/\.fw-so-dates-grid \{\s*display: grid;\s*grid-template-columns: max-content minmax\(0, 1fr\) auto;/)
      expect(css).toMatch(/\.fw-so-dates-rows > \.fw-so-ov-row \{\s*grid-column: 1 \/ -1;\s*grid-template-columns: subgrid;/)
      expect(css).toMatch(/@container fw-so-ov-card \(max-width: 359px\) \{\s*\.fw-so-dates-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/)
      expect(css).toContain('color: var(--nds-warning-text);')
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
      expect(css).not.toMatch(/container(-type)?:/)
    })
  })
})
// ---- end F-OO-141

// ---- F-OO-143 (order overview lane; 10-design §4.2; review F1, F3; replaces F-OP-105): the new date the customer refused ----------
describe('F-OO-143: a refused new date under the promise, and Decide… → the ONE promise dialog with the follow-up named', () => {
  const w = (en: string, it: string) => ({ en, it })
  const REQUEST_ID = '0190f0e2-9393-7000-8000-000000000001'
  // The customer refused the new date two days before the demo's today (29/10/2026): its follow-up task is open (B-PR-28).
  const repromise = (since: string | null = '2026-10-27T09:00:00Z') => ({ kind: 'BRAND_REQUEST', on: 'US' as const, words: w('A customer request waits for our answer', 'Una richiesta del cliente aspetta la nostra risposta'), since, ref: { type: 'ApprovalRequest', id: REQUEST_ID }, sub: 'REPROMISE' as const })
  const readWith = (blockers: Headline['waiting']['blockers']): OrderProduction => ({ ...PRODUCTION_READ, headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers } } })
  const value = order('IN_PRODUCTION') // promised 15/12/2026; the customer Moto Demo S.r.l.
  const waitingOf = (read: OrderProduction): WaitingState => orderWaitingOf(value, { production: ready(read), requests: null, can: { recordPayment: false } }, 'en')
  const ready_ = (state: WaitingState) => {
    if (state.status !== 'ready') throw new Error('the waiting list is not ready')
    return state
  }

  it('the DATE row → the refused date (its request, its age); not in the Changes badge (F3); Decide… → the dialog state', () => {
    const state = ready_(waitingOf(readWith([...HEADLINE.waiting.blockers, repromise()])))
    const row = state.rows.find((entry) => entry.sub === 'REPROMISE')!
    expect(row.place).toBe('DATE')
    expect(state.dates).toContain(row)
    expect(state.card.onUs.some((entry) => entry.sub === 'REPROMISE')).toBe(false)
    // The badge counts the request rows and Still to do only: the refused date added nothing.
    expect(changesBadgeOf(state.card)).toBe(changesBadgeOf(ready_(waitingOf(readWith(HEADLINE.waiting.blockers))).card))
    expect(refusedDatesOf(state.dates, TODAY)).toEqual([{ key: row.key, requestId: REQUEST_ID, age: 2 }])
    // Only a REPROMISE of the ONE list is one (a gate's date, a request, a row with no request named: never).
    expect(refusedDatesOf(state.rows.filter((entry) => entry.sub !== 'REPROMISE'), TODAY)).toEqual([])
    expect(refusedDatesOf([{ ...row, ref: null }], TODAY)).toEqual([])
    expect(refusedDatesOf([{ ...row, place: 'REQUEST' }], TODAY)).toEqual([])
    // Decide…: the ONE promise dialog (the band's), the follow-up named; Change… opens it without one.
    const dialog: BandDialog = decideDialogOf({ requestId: REQUEST_ID })
    expect(dialog).toEqual({ kind: 'promise', followUp: { requestId: REQUEST_ID } })
    expect(followUpOf(dialog)).toEqual({ requestId: REQUEST_ID })
    expect(followUpOf({ kind: 'promise' })).toBeNull()
    expect(followUpOf({ kind: 'ready' })).toBeNull()
    expect(followUpOf(null)).toBeNull()
  })

  it('the age: whole Rome days to today (0: "today"); unknown start: none — never negative', () => {
    expect(ageDaysOf('2026-10-27T09:00:00Z', TODAY)).toBe(2)
    // 23:30 UTC on the 28th is already the 29th in Rome: today.
    expect(ageDaysOf('2026-10-28T23:30:00Z', TODAY)).toBe(0)
    expect(ageDaysOf('2026-11-02T09:00:00Z', TODAY)).toBe(0)
    expect(ageDaysOf(null, TODAY)).toBeNull()
    expect(ageDaysOf('not a time', TODAY)).toBeNull()
    expect(ageWordsOf(0)).toEqual({ key: 'dates.ageToday' })
    expect(ageWordsOf(17)).toEqual({ key: 'dates.age', params: { days: 17 } })
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect([en('dates.age', { days: 17 }), it('dates.age', { days: 17 }), en('dates.ageToday'), it('dates.ageToday')]).toEqual(['17 d', '17 g', 'today', 'oggi'])
  })

  describe('drawn', () => {
    const day = (date: string, locale: 'en' | 'it' = 'en') => formatDate(dayInstant(date), { locale })
    const read = readWith([...HEADLINE.waiting.blockers, repromise()])
    const card = (over: Partial<OrderRecordModel> = {}, locale: 'en' | 'it' = 'en', waiting: WaitingState = waitingOf(read)) => render(createElement(DatesCard, { order: value, model: base('owner', value, { tab: 'overview', production: ready(read), ...over }).record, waiting }), locale)

    it('under the promise (after Plan says ready, before Requested): "{customer} refused the new date · 2 d" — no date (F1) — and Decide…', () => {
      const text = textOf(card())
      expect(text).toContain('Moto Demo S.r.l. refused the new date · 2 d Decide…')
      expect(text.indexOf('Plan says ready')).toBeLessThan(text.indexOf('refused the new date'))
      expect(text.indexOf('refused the new date')).toBeLessThan(text.indexOf('Requested by customer'))
      expect(card()).toContain('<span class="fw-so-dates-wide is-under fw-so-dates-warn">')
      expect(textOf(card({}, 'it'))).toContain('Moto Demo S.r.l. ha rifiutato la nuova data · 2 g Decidi…')
      // Unknown start: the words alone. Nothing refused, or the list not read yet: no row.
      expect(textOf(card({}, 'en', waitingOf(readWith([...HEADLINE.waiting.blockers, repromise(null)]))))).toContain('Moto Demo S.r.l. refused the new date Decide…')
      expect(textOf(card({}, 'en', waitingOf(readWith(HEADLINE.waiting.blockers))))).not.toContain('refused')
      expect(textOf(card({}, 'en', { status: 'loading' }))).not.toContain('refused')
      expect(textOf(render(createElement(DatesCard, { order: value, model: base('owner', value, { tab: 'overview', production: ready(read) }).record }), 'en'))).not.toContain('refused')
    })

    it('held by promiseHeld (as Change…): without orders.manage in words; busy; Read-only sees the row and no Decide…', () => {
      const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
      const finance = render(createElement(DatesCard, { order: value, model: base('finance', value, { tab: 'overview', production: ready(read) }).record, waiting: waitingOf(read) }), 'en')
      expect(finance).toContain(`aria-description="${en('held.noManage').replace(/'/g, '&#x27;')}"`)
      expect(textOf(finance)).toContain('Decide…')
      expect(card({ busy: true })).toContain(`aria-description="${en('held.busy')}"`)
      const readOnly = card({ can: abilitiesOf(['orders.view', 'workorders.view']) })
      expect(textOf(readOnly)).toContain('Moto Demo S.r.l. refused the new date · 2 d')
      expect(textOf(readOnly)).not.toContain('Decide…')
    })

    it('the dialog line: opened by Decide…, the refusal said first (the promise stays until changed; a new date closes it); Change…: none', () => {
      const dialog = (open: BandDialog, locale: 'en' | 'it' = 'en') => textOf(render(createElement(OrderDialogs, { order: value, model: base('owner', value, { dialog: open }).record }), locale))
      const decide = decideDialogOf({ requestId: REQUEST_ID })
      expect(dialog(decide)).toContain(`Moto Demo S.r.l. refused the new date: the promise stays ${day('2026-12-15')} until you change it. A new date closes this.`)
      expect(dialog(decide, 'it')).toContain(`Moto Demo S.r.l. ha rifiutato la nuova data: la promessa resta il ${day('2026-12-15', 'it')} finché non la cambi. Una nuova data chiude questa richiesta.`)
      // Chosen lines (the design case's typed scope): only a new date for its line closes it.
      expect(textOf(render(createElement(OrderDialogs, { order: value, model: base('owner', value, { dialog: decide, draft: { scope: 'lines' } }).record }), 'en'))).toContain('A new date for its line closes this.')
      // The same ONE dialog: its title, fields and Go as Change… opens them; no "Keep the date" (N14 dropped).
      const change = dialog({ kind: 'promise' })
      expect(change).not.toContain('refused')
      for (const words of ['Change the promise of SO-2026-0088', 'New promise date', 'Change the date']) {
        expect(dialog(decide), words).toContain(words)
        expect(change, words).toContain(words)
      }
      expect(dialog(decide)).not.toMatch(/keep the date/i)
    })

    it('the source: Decide… opens the band dialog with the follow-up; OverviewTab hands the card the ONE list; the follow-up stays a field', () => {
      const view = readFileSync(new URL('../view/overview/DatesCard.tsx', import.meta.url), 'utf8')
      expect(view).toContain('onClick={() => actions?.onDialog?.(decideDialogOf(row))}')
      expect(view).not.toContain('orderWaitingOf(')
      expect(readFileSync(new URL('../view/OverviewTab.tsx', import.meta.url), 'utf8')).toContain('<DatesCard order={order} model={model} actions={actions} waiting={waiting')
      const dialogs = readFileSync(new URL('../view/Dialogs.tsx', import.meta.url), 'utf8')
      expect(dialogs).toContain('const followUp = followUpOf(model.dialog)')
      // The F-CP-108 exports stay (the Orders sheet mounts them).
      for (const name of ['export type CommandDialogModel', 'export type CommandDialogActions', 'export /* F-CP-108 */ function ReadyDialog(', 'export /* F-CP-108 */ function CloseDialog(']) expect(dialogs, name).toContain(name)
      const model = readFileSync(new URL('../record-model.ts', import.meta.url), 'utf8')
      expect(model).toContain("{ kind: 'promise'; followUp?: { readonly requestId: string } }")
    })
  })
})
// ---- end F-OO-143
