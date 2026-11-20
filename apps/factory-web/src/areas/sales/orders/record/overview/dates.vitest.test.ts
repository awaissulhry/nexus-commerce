import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { formatDate } from '../../../../../lib/i18n/format'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { order } from '../../_demo/fixtures'
import { abilitiesOf, dayInstant, romeToday } from '../../model'
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
// ---- F-OO-145: the steps before production in place ----
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATE_REFUSALS } from '@nexus/factory-domain/planning/milestones/rules'
import type { ApiClient } from '../../../../../lib/api/client'
import { milestonesSchema } from '../../../../planning/milestones/api'
import { DEFAULT_CONTROLS, emptyDraft } from '../../../../planning/milestones/model'
import { sendGateDialog, useGateActs } from '../use-gate-acts'
import type { RecordActsBase } from '../record-model'
import { GATE } from './fixtures'
import type { Gate } from './api'
import { gateChangesOf, gateDatesOf, gateDraftOf, gateMovesOf, gateMovesShown, gateWorldOf, planningGateHref, planningGateOf } from './dates'
// ---- end F-OO-145
import { waitDatesOf } from './dates' // F-OO-146

// ---- F-OO-143 / F-OO-145 (end check fix wave): the DS Modal draws into a portal once hydrated, never on the server, so the promise
// dialog (Decide…) and Planning's gate dialogs could not be read here. As lines-held's, facts' and where's dialog tests do: an open
// Modal draws in place (title, subtitle, body, footer); a closed one draws nothing, so the card without a dialog draws as before.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), subtitle != null ? createElement('p', null, subtitle as never) : null, children as never, footer as never) : null
  return { ...actual, Modal }
})
// ---- end F-OO-143 / F-OO-145

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
      // F-OO-145: + the gate's state between (Planning's words); its Discuss is an item of More ▾ (F-OO-145's tests).
      expect(textOf(html)).toContain(`Pre-production sample target ${day('2026-11-20')} · To come · 3 days late`)
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

// ---- F-OO-145 (order overview lane; 10-design §4.2; B-OO-010): the steps before production with Planning's own dialogs in place -----
describe('F-OO-145: gate rows and More ▾ — Planning’s own dialogs from a one-order model of the read, each move held by the gate’s own actions', () => {
  const value = order('IN_PRODUCTION')
  const pt = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, ['planning-milestones'])['planning-milestones']!)
  const en = pt('en')
  const ita = pt('it')
  // Three open gates and a fourth (late first, then by target): each a milestone of the read joined to its gate (version, moves).
  const gateOf = (id: string, over: Partial<Gate> = {}): Gate => ({ ...GATE, id, ...over })
  const row = (id: string, target: string, late: number | null, state = 'WAITING', gateKind = 'PP_SAMPLE') => ({ id: `gate:${id}`, kind: 'GATE', gateId: id, gateKind, label: null, target, actual: null, state, late, owner: null })
  const DATES = {
    ...PRODUCTION_READ.dates!,
    gates: [gateOf('g1'), gateOf('g2', { kind: 'TRIMS_IN' }), gateOf('g3'), gateOf('g4')],
    milestones: [...PRODUCTION_READ.dates!.milestones, row('g1', '2026-11-05', null), row('g2', '2026-10-20', 9, 'WAITING', 'TRIMS_IN'), row('g3', '2026-11-01', null, 'STARTED_BEFORE'), row('g4', '2026-11-20', null)],
  }
  // The ONE waiting list's DATE rows of two gates: g1 waits since 26/10 (3 d on 29/10); g2 is Trims in, so the read calls it material short.
  const WAITS = [
    { place: 'DATE' as const, ref: { type: 'OrderGate', id: 'g1' }, since: '2026-10-26T08:00:00Z' },
    { place: 'DATE' as const, ref: { type: 'OrderGate', id: 'g2' }, since: '2026-10-10T08:00:00Z' },
    { place: 'REQUEST' as const, ref: { type: 'OrderGate', id: 'g3' }, since: '2026-10-01T08:00:00Z' },
  ]
  const SALES_ACTIONS: NonNullable<Gate['actions']> = {
    pass: { allowed: false, refusal: null, needs: 'planning.milestones.manage' },
    startBefore: { allowed: false, refusal: null, needs: 'planning.milestones.override' },
    edit: { allowed: false, refusal: null, needs: 'planning.milestones.manage' },
    remove: { allowed: false, refusal: null, needs: 'planning.milestones.manage' },
  }

  it('the rows: late first, three at most, then "n more"; each with its state, its gate and its age from its own DATE row', () => {
    const { rows, more } = gateDatesOf(DATES, WAITS, TODAY)
    expect(rows.map((entry) => entry.gateId)).toEqual(['g2', 'g3', 'g1'])
    expect(more).toBe(1)
    expect(rows.map((entry) => entry.state)).toEqual(['WAITING', 'STARTED_BEFORE', 'WAITING'])
    expect(rows.map((entry) => entry.age)).toEqual([19, null, 3]) // g3's row is no DATE row: no age claimed
    expect(rows[0]!.gate).toEqual(DATES.gates[1])
    expect(gateDatesOf(DATES, WAITS, TODAY, 10).more).toBe(0)
    expect(gateDatesOf(null, WAITS, TODAY)).toEqual({ rows: [], more: 0 })
    // The ONE list for the ages (never a second rule): nextDatesOf's order and fields kept.
    expect(rows.map(({ id, gateId, gateKind, label, target, late }) => ({ id, gateId, gateKind, label, target, late }))).toEqual(nextDatesOf(DATES))
  })

  it('the moves held by the gate’s own actions in Planning’s words (its needs, its refusal code), never the API’s English message', () => {
    const moves = (gate: Gate | null, t = en, input = { thread: true, planningView: true, busy: false }) => gateMovesOf(gate, value.id, input, t)
    // The planner of the demo gate: Move and Mark done may go; Start before refused (its own gate), in words.
    expect(moves(GATE)).toEqual([
      { id: 'move', held: null },
      { id: 'done', held: null },
      { id: 'startBefore', held: en('refusal.OWN_GATE') },
      { id: 'discuss', held: null },
      { id: 'planning', held: null },
    ])
    expect(moves(GATE, ita)[2]!.held).toBe(ita('refusal.OWN_GATE'))
    expect(en('refusal.OWN_GATE')).not.toBe(GATE.actions!.startBefore.refusal!.message)
    // Sales sees them held: the right each needs (Planning's needs.* words), en + it.
    const sales = moves(gateOf('s', { actions: SALES_ACTIONS }))
    expect(sales.map((move) => move.held)).toEqual([en('needs.planning.milestones.manage'), en('needs.planning.milestones.manage'), en('needs.planning.milestones.override'), null, null])
    expect(moves(gateOf('s', { actions: SALES_ACTIONS }), ita)[0]!.held).toBe(ita('needs.planning.milestones.manage'))
    // No conversation on the page: no Discuss; no planning.view: Open in Planning held in words; busy: Planning's "Saving…".
    expect(moves(GATE, en, { thread: false, planningView: false, busy: false }).map((move) => [move.id, move.held])).toEqual([['move', null], ['done', null], ['startBefore', en('refusal.OWN_GATE')], ['planning', en('needs.planning.view')]])
    expect(moves(GATE, en, { thread: true, planningView: true, busy: true }).slice(0, 3).map((move) => move.held)).toEqual([en('held.busy'), en('held.busy'), en('held.busy')])
    // A gate the read cannot say whole (an older answer, an unknown kind) or none: its dialogs "Not possible now.".
    for (const unknown of [null, gateOf('o', { actions: undefined, version: undefined }), gateOf('k', { kind: 'NEW_KIND' })]) expect(moves(unknown).slice(0, 3).map((move) => move.held), String(unknown?.id)).toEqual([en('held.unknown'), en('held.unknown'), en('held.unknown')])
    // Every refusal code and every right the read can name has catalogue words in both languages.
    for (const t of [en, ita]) {
      for (const code of GATE_REFUSALS) expect(t(`refusal.${code}`), code).not.toBe(`refusal.${code}`)
      for (const needs of ['planning.milestones.manage', 'planning.milestones.override', 'planning.view']) expect(t(`needs.${needs}`), needs).not.toBe(`needs.${needs}`)
    }
  })

  it('Read-only sees no More ▾ unless the read lets this reader move a gate; Open in Planning lands on the gate', () => {
    const rows = (actions: Gate['actions']) => [{ gate: gateOf('x', { actions }) }]
    expect(gateMovesShown(false, rows(SALES_ACTIONS))).toBe(true)
    expect(gateMovesShown(true, rows(SALES_ACTIONS))).toBe(false)
    expect(gateMovesShown(true, rows({ ...SALES_ACTIONS, pass: { allowed: true, refusal: null, needs: null } }))).toBe(true)
    expect(gateMovesShown(true, [{ gate: null }])).toBe(false)
    expect(planningGateHref('/w/DEMO', 'SO-2026-0088', 'g1')).toBe('/w/DEMO/planning/milestones?q=SO-2026-0088&open=gate%3Ag1')
    expect(planningGateHref('/w/DEMO', 'SO-2026-0088', null)).toBe('/w/DEMO/planning/milestones?q=SO-2026-0088')
  })

  it('the one-order model is an honest subset of Planning’s read: its own schema takes it; the read’s values, nothing made up a dialog reads', () => {
    const world = gateWorldOf(value, DATES, TODAY)!
    expect(milestonesSchema.safeParse(world).success).toBe(true)
    expect(world.today).toBe(TODAY)
    expect(world.orders).toHaveLength(1)
    const [one] = world.orders
    expect(one).toMatchObject({ id: value.id, number: value.number, companyId: value.companyId, customer: { id: value.partyId, code: 'MOTO-DEMO', name: 'Moto Demo S.r.l.' }, status: value.status, promiseDate: value.promiseDate })
    // Add a gate is not offered here; no tile is counted; no other order.
    expect(one!.mayAddGate.allowed).toBe(false)
    expect(Object.values(world.tiles).every((count) => count === 0)).toBe(true)
    // Each gate as read: its kind, words, target, round, planner shown, state, version and THIS reader's moves.
    const gate = one!.gates.find((entry) => entry.id === 'g1')!
    expect(gate).toMatchObject({ id: 'g1', salesOrderId: value.id, kind: GATE.kind, label: GATE.label, targetDate: GATE.targetDate, owner: GATE.owner, state: GATE.state, version: GATE.version, actions: GATE.actions })
    // What the order read does not carry is not guessed: the stored planner id and maker, the passing of an open gate, Remove's count.
    expect(gate).toMatchObject({ ownerId: null, makerId: null, passedAt: null, passedBy: null, holds: 0 })
    // An older answer (no version, no moves) or an unknown kind is left out of Planning's model, never half-built.
    expect(planningGateOf(gateOf('o', { version: undefined }), value.id)).toBeNull()
    expect(planningGateOf(gateOf('a', { actions: undefined }), value.id)).toBeNull()
    expect(planningGateOf(gateOf('k', { kind: 'NEW_KIND' }), value.id)).toBeNull()
    expect(gateWorldOf(value, null, TODAY)).toBeNull()
  })

  it('Move the date…: the draft as read; Save sends only what the person changed (the planner only when picked); the kind never', () => {
    const gate = planningGateOf(GATE, value.id)!
    const draft = gateDraftOf(gate)
    expect(draft).toEqual({ kind: 'PP_SAMPLE', label: '', targetDate: '2026-11-20', sampleRoundId: '', ownerId: GATE.owner!.id })
    expect(gateChangesOf(draft, draft)).toEqual({})
    expect(gateChangesOf(draft, { ...draft, targetDate: '2026-11-27' })).toEqual({ targetDate: '2026-11-27' })
    expect(gateChangesOf(draft, { ...draft, label: ' Prototype ' })).toEqual({ label: 'Prototype' })
    // "Me" picked: the planner becomes the reader (null, as Planning's own body says it).
    expect(gateChangesOf(draft, { ...draft, ownerId: '' })).toEqual({ ownerId: null })
    expect(gateChangesOf(emptyDraft('PP_SAMPLE'), { ...emptyDraft('PP_SAMPLE'), targetDate: '' })).toEqual({})
  })

  it('the writes: Planning’s own routes, each with the gate’s version (only the changes; Mark done today without a day; the reason trimmed)', async () => {
    const calls: { method: string; path: string; body: unknown }[] = []
    const answer = { gate: GATE }
    const api = {
      request: async (method: string, path: string, options: { body: unknown }) => (calls.push({ method, path, body: options.body }), answer),
      post: async (path: string, options: { body: unknown }) => (calls.push({ method: 'POST', path, body: options.body }), path.endsWith('/pass') ? { passed: [{ id: GATE.id, version: 4 }] } : answer),
    } as unknown as ApiClient
    const gate = planningGateOf(GATE, value.id)!
    const initial = gateDraftOf(gate)
    const input = { gates: [gate], initial, today: TODAY }
    expect(await sendGateDialog(api, { kind: 'edit', gateId: GATE.id, draft: { ...initial, targetDate: '2026-11-27' }, choices: null, busy: false, problem: null }, input)).toEqual({ key: 'dates.gateEdited' })
    expect(await sendGateDialog(api, { kind: 'pass', gateIds: [GATE.id], on: TODAY, busy: false, problem: null }, input)).toEqual({ key: 'dates.gatePassed', params: { count: 1 } })
    await sendGateDialog(api, { kind: 'pass', gateIds: [GATE.id], on: '2026-10-28', busy: false, problem: null }, input)
    expect(await sendGateDialog(api, { kind: 'startBefore', gateIds: [GATE.id], reason: '  The sample is on its way  ', busy: false, problem: null }, input)).toEqual({ key: 'dates.gateStarted', params: { count: 1 } })
    const at = `/planning/milestones/gates/${GATE.id}`
    expect(calls).toEqual([
      { method: 'PATCH', path: at, body: { version: 3, targetDate: '2026-11-27' } },
      { method: 'POST', path: '/planning/milestones/gates/pass', body: { gates: [{ id: GATE.id, version: 3 }] } },
      { method: 'POST', path: '/planning/milestones/gates/pass', body: { gates: [{ id: GATE.id, version: 3 }], on: '2026-10-28' } },
      { method: 'POST', path: `${at}/start-before`, body: { version: 3, reason: 'The sample is on its way' } },
    ])
    // The page's notices in both languages (Planning's own words).
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const [key, params] of [['dates.gateEdited', {}], ['dates.gatePassed', { count: 2 }], ['dates.gateStarted', { count: 1 }], ['dates.gateMove', {}], ['dates.gateDiscuss', {}], ['dates.gateWaits', { days: 3 }], ['dates.gateWaitsToday', {}], ['dates.gatesMore', { count: 2 }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })

  it('the hook builds Planning’s model from the page’s read (rights, today, no dialog yet) and hands its acts', () => {
    let got: ReturnType<typeof useGateActs> | undefined
    const actsBase = { api: {} as ApiClient, orderId: value.id, current: { current: value }, version: () => value.version, setNotice: () => undefined, load: async () => undefined, loadParts: () => undefined, write: async () => undefined } as unknown as RecordActsBase
    function Harness({ permissions }: { permissions: readonly string[] }) {
      got = useGateActs({ production: ready({ ...PRODUCTION_READ, dates: DATES }), again: () => undefined, permissions, me: 'me', prefix: '/w/DEMO', live: 'live' }, actsBase)
      return null
    }
    render(createElement(Harness, { permissions: ['orders.view', 'planning.view'] }), 'en')
    expect(got!.model?.world).toEqual({ status: 'ready', value: gateWorldOf(value, DATES, romeToday()) })
    expect(got!.model).toMatchObject({ prefix: '/w/DEMO', me: 'me', can: { view: true, manage: false, override: false }, dialog: null, live: 'live' })
    for (const act of ['onEdit', 'onDraft', 'onSaveGate', 'onPass', 'onPassDay', 'onPassConfirm', 'onStartBefore', 'onReason', 'onStartConfirm', 'onCloseDialog'] as const) expect(typeof got!.actions[act], act).toBe('function')
    // No page (a design case): no model.
    function Bare() {
      got = useGateActs(undefined, undefined)
      return null
    }
    render(createElement(Bare), 'en')
    expect(got!.model).toBeNull()
  })

  describe('drawn', () => {
    const day = (date: string, locale: 'en' | 'it' = 'en') => formatDate(dayInstant(date), { locale })
    const read = { ...PRODUCTION_READ, dates: DATES, headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers: [...HEADLINE.waiting.blockers, { kind: 'GATE', on: 'US' as const, words: { en: 'A gate is not passed yet', it: 'Un passaggio non è ancora superato' }, since: '2026-10-26T08:00:00Z', ref: { type: 'OrderGate', id: 'g1' }, sub: null }] } } }
    const waiting = orderWaitingOf(value, { production: ready(read), requests: null, can: { recordPayment: false } }, 'en')
    const card = (role: 'owner' | 'sales' = 'owner', over: Partial<OrderRecordModel> = {}, locale: 'en' | 'it' = 'en') => render(createElement(DatesCard, { order: value, model: base(role, value, { tab: 'overview', production: ready(read), ...over }).record, waiting }), locale)

    it('each gate: target · state · late (or how long it waits) · More ▾ named for the gate; then "1 more in All dates ›"', () => {
      const text = textOf(card())
      expect(text).toContain(`Trims in target ${day('2026-10-20')} · Waiting · 9 days late More`)
      expect(text).toContain(`Pre-production sample target ${day('2026-11-05')} · Waiting · waits 3 d More`)
      expect(text).toContain(`target ${day('2026-11-01')} · Started before More`)
      expect(text).toContain('1 more in All dates ›')
      expect(card()).toContain(`aria-label="${en('row.menu', { name: 'Pre-production sample', order: value.number })}"`)
      const italian = textOf(card('owner', {}, 'it'))
      for (const words of ['In attesa · aspetta da 3 g Altro', 'Partito prima', 'Ancora 1 in Tutte le date ›']) expect(italian, words).toContain(words)
    })

    it('Sales sees More ▾ (its items held in words: the pure moves above); Read-only without a gate right sees none', () => {
      expect(textOf(card('sales'))).toContain('More')
      const readOnly = card('owner', { can: abilitiesOf(['orders.view']) }) // the fixture's gates allow pass and edit: a planner moves them
      expect(textOf(readOnly)).toContain('More')
      const salesRead = { ...read, dates: { ...DATES, gates: DATES.gates.map((gate) => ({ ...gate, actions: SALES_ACTIONS })) } }
      const none = render(createElement(DatesCard, { order: value, model: base('owner', value, { tab: 'overview', production: ready(salesRead), can: abilitiesOf(['orders.view']) }).record, waiting }), 'en')
      expect(none).not.toContain('<button')
    })

    it('Planning’s own dialogs open in place from the one-order model (Change the gate, Mark done, Start before the gate)', () => {
      const world = gateWorldOf(value, DATES, TODAY)!
      const model = (dialog: NonNullable<OrderRecordModel['gateActs']>['dialog']) => ({ prefix: '/w/DEMO', can: { view: true, manage: true, override: true }, me: 'me', controls: DEFAULT_CONTROLS, world: { status: 'ready' as const, value: world }, live: 'live' as const, updates: 0, notice: null, dialog })
      const gate = world.orders[0]!.gates.find((entry) => entry.id === 'g1')!
      const edit = textOf(card('owner', { gateActs: model({ kind: 'edit', gateId: 'g1', draft: gateDraftOf(gate), choices: null, busy: false, problem: null }) }))
      expect(edit).toContain(en('form.editTitle', { name: en('kind.PP_SAMPLE') }))
      expect(edit).toContain(en('form.subtitle', { order: value.number, customer: 'Moto Demo S.r.l.' }))
      const pass = textOf(card('owner', { gateActs: model({ kind: 'pass', gateIds: ['g1'], on: TODAY, busy: false, problem: 'refusal.changed' }) }))
      expect(pass).toContain(en('pass.title', { count: 1 }))
      expect(pass).toContain(en('refusal.changed'))
      const start = textOf(card('owner', { gateActs: model({ kind: 'startBefore', gateIds: ['g1'], reason: '', busy: false, problem: null }) }, 'it'))
      expect(start).toContain(ita('start.title', { count: 1 }))
      expect(textOf(card('owner', { gateActs: model(null) }))).not.toContain(en('form.editTitle', { name: en('kind.PP_SAMPLE') }))
    })

    it('the source: the hook lives in the container’s chain (use-overview-acts), never in a view; GateDialogs is Planning’s, not a copy', () => {
      const here = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(here('../use-overview-acts.ts')).toContain('const gates = useGateActs(input.gates, input.base)')
      expect(here('../OrderRecord.tsx')).toContain('gates: { production: production.state, again: production.again, permissions: session.permissions, me: session.user.id, prefix, live: liveState } /* F-OO-145 */')
      const views = (dir: URL): string[] =>
        readdirSync(dir).flatMap((name) => {
          const at = new URL(name, dir)
          if (statSync(at).isDirectory()) return views(new URL(`${name}/`, dir))
          return /\.tsx?$/.test(name) && !name.includes('.vitest.') && at.pathname.includes('/view/') ? [fileURLToPath(at)] : []
        })
      for (const file of views(new URL('../', import.meta.url))) expect(readFileSync(file, 'utf8'), file).not.toMatch(/from '[^']*\/use-gate-acts'/)
      const view = here('../view/overview/DatesCard.tsx')
      expect(view).toContain("import { GateDialogs } from '../../../../../planning/milestones/view/GateDialogs'")
      expect(view).toContain('<GateDialogs model={model.gateActs} actions={gateActs} words={{ t: p, locale }} />')
      // ONE GateDialogs for Planning's gates: no copy of it under the order page.
      expect(views(new URL('../', import.meta.url)).some((file) => /GateDialogs/.test(file))).toBe(false)
      // The hook opens only Change the gate, Mark done and Start before (never Add, Remove or the keys); its writes are Planning's api.
      const hook = here('../use-gate-acts.ts')
      for (const kind of ["kind: 'add'", "kind: 'remove'", "kind: 'keys'"]) expect(hook, kind).not.toContain(kind)
      for (const call of ['editGate(', 'passGates(', 'startBefore(', 'base.write(']) expect(hook, call).toContain(call)
      expect(hook).not.toMatch(/api\.(post|request|get)\(/)
      expect(hook).not.toContain('.message')
    })
  })
})
// ---- end F-OO-145

// ---- F-OO-146 (order overview lane; 10-design §4.2; moved from section 5): the material and workshop waits in Next dates ----------
describe('F-OO-146: material and workshop rows from the ONE waiting list’s DATE place, with their ages and their doors', () => {
  const value = order('IN_PRODUCTION') // its chain names WO-00021
  const WO = value.chain.workOrders[0]!
  const w = (en: string, it: string) => ({ en, it })
  type Blocker = Headline['waiting']['blockers'][number]
  const blocker = (kind: string, since: string | null, ref: Blocker['ref'], words = w(kind, kind), sub: Blocker['sub'] = null): Blocker => ({ kind, on: 'US', words, since, ref, sub })
  const MATERIAL = w('Material short', 'Materiale mancante')
  const WORKSHOP = w('At an outside workshop', 'Presso un laboratorio esterno')
  // A gate g1 open in the read (its own row says it); Trims in on g1 comes as "material short" with the gate's ref.
  const DATES = { ...PRODUCTION_READ.dates!, gates: [{ ...GATE, id: 'g1', kind: 'TRIMS_IN' }], milestones: [...PRODUCTION_READ.dates!.milestones, { id: 'gate:g1', kind: 'GATE', gateId: 'g1', gateKind: 'TRIMS_IN', label: null, target: '2026-11-02', actual: null, state: 'WAITING', late: null, owner: null }] }
  const BLOCKERS: Blocker[] = [
    ...HEADLINE.waiting.blockers,
    blocker('MATERIAL_SHORT', null, null, MATERIAL), // a work order's material is late (no start known)
    blocker('MATERIAL_SHORT', '2026-10-20T08:00:00Z', { type: 'OrderGate', id: 'g1' }, MATERIAL), // Trims in: the gate's own row
    blocker('SUBCONTRACT', '2026-10-24T08:00:00Z', { type: 'WorkOrder', id: WO.id }, WORKSHOP), // out at a workshop since 24/10
    blocker('SUBCONTRACT', '2026-10-27T08:00:00Z', null, WORKSHOP), // another, of a work order this reader does not reach
    blocker('BRAND_REQUEST', '2026-10-27T09:00:00Z', { type: 'ApprovalRequest', id: 'r1' }, w('x', 'x'), 'REPROMISE'), // F-OO-143's row
    blocker('NO_MOVE', '2026-10-25T08:00:00Z', { type: 'WorkOrder', id: WO.id }, w('Production hold', 'Fermo di produzione')), // a hold: section 1
  ]
  const read = { ...PRODUCTION_READ, dates: DATES, headline: { ...HEADLINE, waiting: { ...HEADLINE.waiting, blockers: BLOCKERS } } }
  const waiting = orderWaitingOf(value, { production: ready(read), requests: null, can: { recordPayment: false } }, 'en')
  const dates = waiting.status === 'ready' ? waiting.dates : []
  const numberOf = (id: string) => (id === WO.id ? WO.number : null)

  it('one row per kind from the DATE rows (oldest first), its age the oldest; a refused date, a hold and an open gate’s wait are not here', () => {
    expect(waitDatesOf(dates, DATES, { numberOf, today: TODAY })).toEqual([
      { key: expect.stringMatching(/^SUBCONTRACT:/), kind: 'SUBCONTRACT', words: WORKSHOP, workOrders: [WO.number], age: 5, door: { tab: 'production', anchor: 'holds' } },
      { key: expect.stringMatching(/^MATERIAL_SHORT:/), kind: 'MATERIAL_SHORT', words: MATERIAL, workOrders: [], age: null, door: { tab: 'production', anchor: 'dates' } },
    ])
    // The dates not read: the gate's wait keeps its own row (never hidden) — it joins Material short, with its age.
    expect(waitDatesOf(dates, null, { numberOf, today: TODAY }).find((row) => row.kind === 'MATERIAL_SHORT')?.age).toBe(9)
    // Any other wait with a day (a kind this card has no words for) keeps a row with the read's words and its door.
    const other = waitDatesOf([{ key: 'k', kind: 'CUSTOMER_MATERIAL', sub: null, ref: null, on: 'BRAND', since: '2026-10-28T08:00:00Z', words: { kind: 'api', words: w('The customer’s material is not in yet', 'Materiale del cliente non ancora arrivato') }, door: { kind: 'tab', tab: 'production', anchor: 'holds' }, place: 'DATE' }], null, { numberOf, today: TODAY })
    expect(other).toEqual([{ key: 'CUSTOMER_MATERIAL:k', kind: 'CUSTOMER_MATERIAL', words: w('The customer’s material is not in yet', 'Materiale del cliente non ancora arrivato'), workOrders: [], age: 1, door: { tab: 'production', anchor: 'holds' } }])
    expect(waitDatesOf([], DATES, { numberOf, today: TODAY })).toEqual([])
  })

  describe('drawn', () => {
    const card = (over: Partial<OrderRecordModel> = {}, locale: 'en' | 'it' = 'en', production = ready(read)) => render(createElement(DatesCard, { order: value, model: base('owner', value, { tab: 'overview', production, ...over }).record, waiting: orderWaitingOf(value, { production, requests: null, can: { recordPayment: false } }, locale) }), locale)

    it('after the gates: "At an outside workshop WO-00021 · 5 d", "Material short waits on the supplier", each with Production › at its anchor', () => {
      const html = card()
      const text = textOf(html)
      expect(text).toContain(`At an outside workshop ${WO.number} · 5 d Production ›`)
      expect(text).toContain('Material short waits on the supplier Production ›')
      expect(text.indexOf('Trims in')).toBeLessThan(text.indexOf('At an outside workshop'))
      // The Trims in gate says its own age; its wait is not drawn twice.
      expect(text.match(/Material short/g)).toHaveLength(1)
      expect(html).toMatch(/href="[^"]*production[^"]*#holds"/)
      expect(html).toMatch(/href="[^"]*production[^"]*#dates"/)
      const italian = textOf(card({}, 'it'))
      expect(italian).toContain(`Presso un laboratorio esterno ${WO.number} · 5 g Produzione ›`)
      expect(italian).toContain('Materiale mancante aspetta il fornitore Produzione ›')
    })

    it('a link, so Read-only has it too; with no open gate the block still draws the waits; nothing while the list is read', () => {
      expect(textOf(card({ can: abilitiesOf(['orders.view']) }))).toContain('Material short waits on the supplier Production ›')
      const noGate = ready({ ...read, dates: { ...DATES, gates: [], milestones: PRODUCTION_READ.dates!.milestones } })
      const html = card({}, 'en', noGate)
      expect(html).toContain('<ul class="fw-so-dates-rows is-gates"')
      expect(textOf(html)).toContain('At an outside workshop')
      expect(textOf(card({ production: LOADING_STATE }, 'en', LOADING_STATE))).not.toContain('Material short')
    })

    it('the words, both languages ("tu"); the source keeps the ONE list (no read of its own)', () => {
      for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders']).orders!)('dates.waitsOnSupplier'), locale).not.toBe('dates.waitsOnSupplier')
      const view = readFileSync(new URL('../view/overview/DatesCard.tsx', import.meta.url), 'utf8')
      expect(view).toContain('const waitRows = waitDatesOf(dateRows, read?.dates ?? null, { numberOf, today: model.today })')
      expect(view).toContain("{t(`waiting.go.${row.door.tab}`)}")
    })
  })
})
// ---- end F-OO-146
