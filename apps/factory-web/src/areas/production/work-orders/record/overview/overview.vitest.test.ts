import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { leftKeys, renderView, textOf } from '../../../../../lib/record-thread/parts/testing'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { workOrder } from '../../../_shared/fixtures'
import { FINISHED, NOTHING_TO_FINISH } from '../../daily/demo/fixtures'
import { designScreen, healthView, MILESTONES } from '../fixtures'
import { gateRowsOf, waitingGates } from '../gates/model'
import {
  bandHealthOf,
  bandWaitingOf,
  clearHeld,
  healthInputOf,
  healthOrdersOf,
  healthStateOf,
  raiseHeld,
  raiseOpenHeld,
  raiseProblem,
  type HealthPart,
} from '../health/model'
import { customerFactOf, doneFact, previewHeld, previewRecord, progressCell, progressTableOf, reportFirst } from './model'

/**
 * F-PR-05a — the work order record's band facts and Overview body (production plan §5; 06-tree A.4; B-PR-35's health): % done, the
 * customer fact, Report finished as the main step while released garments wait, Preview as <customer>, ONE progress table (the 6-way
 * switch went), Gates & readiness, Health with Raise to At risk (reason the customer reads, note office-only). Wall PW-03 (web side):
 * only the work order's own orders are read; a work order the person may not open says nothing of whose it is; without parties.view
 * the customer is its code.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const CUSTOMER = { id: '0190f0e2-6666-7000-8000-000000000001', code: 'ALPHA', name: 'Moto Demo S.r.l.' }
const part = (value: ReturnType<typeof healthView> | null, problem: string | null = null, orderId = value?.orderId ?? 'o-1'): HealthPart => ({ orderId, number: value?.number ?? 'SO-X', read: { value, problem } })

describe('F-PR-05a — the band facts', () => {
  it('% done = finished ÷ pieces (6 of 26 → 23 %); a draft is not released; a site that counts no finish says so', () => {
    expect(doneFact(workOrder('IN_PROGRESS'))).toEqual({ key: 'band.done', params: { percent: 23 } })
    expect(doneFact(workOrder('DRAFT'))).toEqual({ key: 'progress.notFrozen' })
    expect(doneFact(workOrder('RELEASED'))).toEqual({ key: 'band.doneUnknown' })
  })

  it('the customer fact: its one customer, a work order made before the one-customer rule, or none', () => {
    expect(customerFactOf({ customer: CUSTOMER, mixedCustomers: false })).toEqual({ kind: 'customer', ...CUSTOMER })
    expect(customerFactOf({ customer: null, mixedCustomers: true })).toEqual({ kind: 'mixed' })
    expect(customerFactOf({})).toEqual({ kind: 'none' })
  })

  it('Report finished is the primary while released garments wait (not a repair, not on hold, not finished)', () => {
    expect(reportFirst(workOrder('IN_PROGRESS'), FINISHED)).toBe(FINISHED.garments.canReport > 0)
    expect(FINISHED.garments.canReport).toBeGreaterThan(0)
    expect(reportFirst(workOrder('IN_PROGRESS'), NOTHING_TO_FINISH)).toBe(false)
    expect(reportFirst(workOrder('IN_PROGRESS'), null)).toBe(false)
    expect(reportFirst(workOrder('COMPLETED'), FINISHED)).toBe(true)
    expect(reportFirst(workOrder('ON_HOLD'), FINISHED)).toBe(false)
    expect(reportFirst(workOrder('CLOSED'), FINISHED)).toBe(false)
    expect(reportFirst(workOrder('IN_PROGRESS', { kind: 'REPAIR' }), FINISHED)).toBe(false)
  })

  it('Preview as <customer>: held without the right or without one customer; it opens the one order, else the portal home', () => {
    const fact = customerFactOf({ customer: CUSTOMER })
    expect(previewHeld(fact, true, false)).toBeNull()
    expect(previewHeld(fact, false, false)).toEqual({ key: 'band.previewNoRight' })
    expect(previewHeld({ kind: 'mixed' }, true, false)).toEqual({ key: 'band.previewNoCustomer' })
    expect(previewHeld(fact, true, true)).toEqual({ key: 'held.busy' })
    const wo = workOrder('IN_PROGRESS')
    expect(previewRecord(wo)).toEqual({ type: 'SalesOrder', id: wo.orders[0]!.id })
    expect(previewRecord({ orders: [...wo.orders, { ...wo.orders[0]!, id: 'other-order' }] })).toBeNull()
  })
})

describe('F-PR-05a — ONE progress table (the 6-way switch went)', () => {
  it('per colourway: Ordered · Cut · In bundles · Sewn · Finished · Still to finish × sizes + Total; a Total block over all', () => {
    const table = progressTableOf(workOrder('IN_PROGRESS'))
    expect(table.sizes).toEqual(['48', '50', '52', '54'])
    const blk = table.blocks[0]!
    expect(blk.rows.map((row) => [row.step, row.cells, row.total])).toEqual([
      ['quantity', [4, 6, 6, 4], 20],
      ['cut', [4, 6, 6, 4], 20],
      ['bundled', [4, 6, 6, 4], 20],
      ['sewn', [4, 4, 4, 0], 12],
      ['finished', [2, 2, 2, 0], 6],
      ['balance', [2, 4, 4, 4], 14],
    ])
    // RED has no 48 and no 54: empty there, never 0.
    expect(table.blocks[1]!.rows.find((row) => row.step === 'quantity')).toEqual({ step: 'quantity', cells: [undefined, 3, 3, undefined], total: 6 })
    expect(table.totals.find((row) => row.step === 'quantity')!.total).toBe(26)
    expect(table.totals.find((row) => row.step === 'finished')!.total).toBe(6)
    expect(table.totals.find((row) => row.step === 'balance')!.total).toBe(20)
  })

  it('a step the floor does not count is "—" (never 0); a size a colourway lacks is empty', () => {
    const released = progressTableOf(workOrder('RELEASED'))
    expect(released.totals.find((row) => row.step === 'cut')).toEqual({ step: 'cut', cells: [null, null, null, null], total: null })
    expect(released.totals.find((row) => row.step === 'balance')!.total).toBeNull()
    expect([progressCell(undefined), progressCell(null), progressCell(0), progressCell(7)]).toEqual(['', '—', '0', '7'])
  })
})

describe('F-PR-05a — Gates & readiness', () => {
  it('each gate of the order by target: its state, planner, target, passed day, lateness, a door to Time & action', () => {
    const rows = gateRowsOf([MILESTONES], '/w/DEMO')
    expect(rows.map((row) => [row.kind, row.state, row.target, row.actual, row.late])).toEqual([
      ['PP_SAMPLE', 'DONE', '2026-10-20', '2026-10-22', 2],
      ['LEATHER_APPROVED', 'DONE', '2026-10-21', '2026-10-21', 0],
      ['LAB_PASSED', 'WAITING', '2026-10-25', null, 4],
    ])
    expect(rows[2]!.href).toBe(`/w/DEMO/planning/milestones?q=${encodeURIComponent(MILESTONES.orders[0]!.number)}&open=gate%3A${rows[2]!.id}`)
    expect(waitingGates(rows)).toBe(1)
    expect(gateRowsOf([], '/w/DEMO')).toEqual([])
  })
})

describe('F-PR-05a — Health and Raise to At risk (B-PR-35)', () => {
  it('PW-03: only the work order’s own orders are read, each once', () => {
    const wo = workOrder('IN_PROGRESS')
    expect(healthOrdersOf(wo)).toEqual([{ orderId: wo.orders[0]!.id, number: wo.orders[0]!.number }])
    expect(healthOrdersOf({ orders: [wo.orders[0]!, wo.orders[0]!] })).toHaveLength(1)
    expect(healthOrdersOf({ orders: [] })).toEqual([])
  })

  it('the customer’s words: Late, At risk, No date yet, On track; a raise counts while it stands, with the office’s note', () => {
    expect([healthStateOf('LATE'), healthStateOf('AT_RISK'), healthStateOf('NO_DATE'), healthStateOf('ON_TRACK'), healthStateOf(null)]).toEqual(['LATE', 'AT_RISK', 'NOT_PROMISED', 'ON_TIME', null])
    const raise = { reasonCode: 'CAPACITY' as const, note: 'Linea ferma', setAt: '2026-10-27T15:20:00Z', setBy: { id: 'u', name: 'Bea Esempio' }, until: '2026-11-03', stands: true }
    expect(healthInputOf(healthView({ raise, health: 'AT_RISK' }), null)).toEqual({ computed: 'ON_TIME', daysLate: null, raised: { reason: 'CAPACITY', note: 'Linea ferma', by: 'Bea Esempio', at: '2026-10-27T15:20:00Z' } })
    expect(healthInputOf(healthView({ raise: { ...raise, stands: false } }), null).raised).toBeNull()
    expect(healthInputOf(healthView({ computed: 'LATE', health: 'LATE' }), 3)).toMatchObject({ computed: 'LATE', daysLate: 3 })
    // Not followed yet: not known, never "on track".
    expect(healthInputOf(healthView({ kept: false, computed: null, health: null }), null).computed).toBeUndefined()
  })

  it('the band: the worst order the customer reads, loading while read, not known when every read failed; none without an order', () => {
    expect(bandHealthOf([], 0)).toBeNull()
    expect(bandHealthOf([part(null)], 0)).toBe('loading')
    expect(bandHealthOf([part(null, 'error.offline')], 0)).toEqual({ computed: undefined })
    const worst = bandHealthOf([part(healthView({ orderId: 'a' })), part(healthView({ orderId: 'b', computed: 'LATE', health: 'LATE' }))], 2)
    expect(worst).toMatchObject({ computed: 'LATE', daysLate: 2 })
  })

  it('waiting on across orders: the customer first, then supplier, workshop, us; since the earliest', () => {
    const waiting = bandWaitingOf([
      part(healthView({ orderId: 'a', waitingOn: 'US', waitingSince: '2026-10-20T08:00:00Z' })),
      part(healthView({ orderId: 'b', waitingOn: 'BRAND', waitingSince: '2026-10-27T08:00:00Z' })),
      part(healthView({ orderId: 'c', waitingOn: 'BRAND', waitingSince: '2026-10-26T08:00:00Z' })),
    ])
    expect(waiting).toEqual({ who: 'BRAND', since: '2026-10-26T08:00:00Z' })
    expect(bandWaitingOf([part(healthView({ waitingOn: null, waitingSince: null }))])).toEqual({ who: undefined })
  })

  it('Raise to At risk: held without the right, before the order is followed, when late or at risk already; a reason and a one-line note', () => {
    const fine = healthView()
    expect(raiseOpenHeld(fine, true)).toBeNull()
    expect(raiseOpenHeld(fine, false)).toEqual({ key: 'raise.held.noRight' })
    expect(raiseOpenHeld(healthView({ kept: false }), true)).toEqual({ key: 'raise.held.notKept' })
    expect(raiseOpenHeld(healthView({ computed: null }), true)).toEqual({ key: 'raise.held.nothingLeft' })
    expect(raiseOpenHeld(healthView({ computed: 'LATE' }), true)).toEqual({ key: 'raise.held.late' })
    expect(raiseOpenHeld(healthView({ computed: 'AT_RISK' }), true)).toEqual({ key: 'raise.held.atRisk' })
    expect(raiseHeld(fine, true, '', '', false)).toEqual({ key: 'raise.held.pick' })
    expect(raiseHeld(fine, true, 'EARLIER', '', false)).toEqual({ key: 'raise.held.pick' })
    expect(raiseHeld(fine, true, 'CAPACITY', 'two\nlines', false)).toEqual({ key: 'raise.held.note', params: { max: 200 } })
    expect(raiseHeld(fine, true, 'CAPACITY', 'x'.repeat(201), false)).toEqual({ key: 'raise.held.note', params: { max: 200 } })
    expect(raiseHeld(fine, true, 'CAPACITY', 'Linea ferma', true)).toEqual({ key: 'held.busy' })
    expect(raiseHeld(fine, true, 'CAPACITY', '', false)).toBeNull()
    expect(clearHeld(fine, true, false)).toEqual({ key: 'raise.held.noRaise' })
  })

  it('a refused raise in this app’s words (never the API’s English)', () => {
    expect(raiseProblem(new Error('x'))).toEqual({ key: 'error.write' })
  })
})

describe('F-PR-05a — the screen (both languages) and PW-03', () => {
  const IDS = ['band-facts', 'band-code', 'overview-gates', 'overview-gates-loading', 'overview-gates-failed', 'overview-progress', 'health-raised', 'health-raise-dialog', 'health-raise-refused', 'health-late', 'health-not-kept', 'health-failed', 'health-no-right', 'mixed', 'in-progress', 'in-progress-nothing-released', 'ready-to-complete']

  it('every F-PR-05a case draws with no key left on screen, in it and en', () => {
    for (const id of IDS) {
      for (const locale of LOCALES) expect(leftKeys(draw(id, locale), ['band', 'health', 'raise', 'gates', 'size', 'parts', 'progress', 'customer', 'step', 'finished']), `${id} ${locale}`).toEqual([])
    }
  })

  it('the band: customer (a link with parties.view), the sales order and its PO, % done; Report finished as the main step', () => {
    const html = draw('band-facts')
    const text = textOf(html)
    expect(html).toContain(`/sales/customers/${CUSTOMER.id}`)
    expect(text).toContain('Moto Demo S.r.l.')
    expect(text).toContain('SO-DEMO-0042')
    expect(text).toContain('PO PO-ESEMPIO-7')
    expect(text).toContain('23 % done')
    expect(text).toMatch(/Report \d+ finished/)
    // Nothing released yet: the next step is the primary again.
    expect(textOf(draw('ready-to-complete'))).not.toMatch(/Report \d+ finished/)
  })

  it('without parties.view the customer is its code, no link (06-tree A.0)', () => {
    const html = draw('band-code')
    expect(textOf(html)).toContain('ALPHA')
    expect(html).not.toContain(`/sales/customers/${CUSTOMER.id}`)
  })

  it('ONE progress table: every step as a row, no layer switch left', () => {
    const text = textOf(draw('overview-progress'))
    for (const words of ['Quantity', 'Cut', 'In bundles', 'Sewn', 'Finished', 'Still to finish', 'Step']) expect(text).toContain(words)
    expect(textOf(draw('overview-progress', 'it'))).toContain('Fase')
  })

  it('the Health card: the reason the customer reads, the note marked Office only, until when; the gates with their doors', () => {
    const text = textOf(draw('health-raised'))
    expect(text).toContain('Office only')
    expect(text).toContain('Pelle rossa in ritardo dalla conceria')
    expect(text).toContain('Material delivery late')
    expect(textOf(draw('overview-gates'))).toContain('Gates & readiness')
    expect(draw('overview-gates')).toContain('/planning/milestones?q=')
  })

  it('PW-03: a work order the person may not open (another customer’s, or one mixed for a limited person) names nobody', () => {
    for (const id of ['not-found', 'no-permission']) {
      for (const locale of LOCALES) {
        const html = draw(id, locale)
        expect(html).not.toContain('Moto Demo')
        expect(html).not.toContain('ALPHA')
        expect(html).not.toContain('SO-DEMO-0042')
      }
    }
  })

  it('a work order made before the one-customer rule: Mixed customers in the band, one banner; no customer link', () => {
    const html = draw('mixed')
    const text = textOf(html)
    expect(text).toContain('Mixed customers (made before the rule)')
    expect(text).toContain('Made before the one-customer rule')
    expect(html).not.toContain(`/sales/customers/${CUSTOMER.id}`)
  })
})
