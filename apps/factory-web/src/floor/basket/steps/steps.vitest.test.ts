import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import type { BasketStep } from '../api'
import { CUTTING, PACKING, PATCH, QUALITY, route, STITCHING } from '../fixtures'
import { deptOf } from '../model'
import { UndoStore } from '../undo/store'
import { UndoBar } from '../undo/view/UndoBar'
import { chosenOf, editsOf, EMPTY_DRAFT, hereDepartmentOf, manyRowsOf, planMany, planOne, READY_KEY, routeViewOf, savedLinesOf, stepRowsOf, turnStep, type ManyBasket } from './model'
import { StepsBody, StepsFoot, type StepsWindowModel } from './view/StepsWindowView'

/**
 * owb-fl6 — the Steps window, Change all, the route editor and the Undo bar (written, run at the end: Owner rule). The rules of design
 * § 5zg: forward asks nothing; back asks why; a worker's back is refused in words; Ready to ship only after the last step is reported
 * (lead settle 7); Change all moves the baskets whose own route has the step and says how many stay; the last step is never skippable;
 * an added step goes before the last; the warning when no quality check is left; ONE Undo bar, also for a group.
 */

const rowsOf = (steps: readonly BasketStep[]) => stepRowsOf(steps, 'en')
const rowAt = (steps: readonly BasketStep[], key: string) => rowsOf(steps).find((row) => row.key === key)!

describe('the Steps window of one basket', () => {
  it('a row per step and Ready to ship: done, "It is here", "Next", later', () => {
    expect(rowsOf(route(3)).map((row) => row.state)).toEqual(['done', 'done', 'done', 'here', 'next', 'later', 'later'])
    expect(rowsOf(route(3)).at(-1)?.key).toBe(READY_KEY)
    expect(rowsOf(route(6)).at(-1)?.state).toBe('here')
  })

  it('forward asks nothing (a worker too); a tap where it is does nothing', () => {
    const steps = route(3)
    expect(planOne(steps, rowsOf(steps), rowAt(steps, 'op-6'), { leader: false })).toEqual({ kind: 'go', move: { kind: 'FORWARD', toOperationId: 'op-6' } })
    expect(planOne(steps, rowsOf(steps), rowAt(steps, 'op-4'), { leader: true })).toEqual({ kind: 'none' })
  })

  it('back asks why (a leader); a worker\'s back is refused in words', () => {
    const steps = route(3)
    expect(planOne(steps, rowsOf(steps), rowAt(steps, 'op-2'), { leader: false })).toEqual({ kind: 'refused', why: 'leaderBack' })
    expect(planOne(steps, rowsOf(steps), rowAt(steps, 'op-2'), { leader: true }).kind).toBe('ask')
    expect(planOne(steps, rowsOf(steps), rowAt(steps, 'op-2'), { leader: true, why: 'REDO' })).toEqual({ kind: 'go', move: { kind: 'BACK', toOperationId: 'op-2', reason: 'REDO' } })
  })

  it('Ready to ship only after the last step is reported (settle 7)', () => {
    const steps = route(3)
    expect(planOne(steps, rowsOf(steps), rowAt(steps, READY_KEY), { leader: true })).toEqual({ kind: 'refused', why: 'packFirst' })
    // A redo after Packing: Packing has its report, the basket is back at Stitching.
    const redo = route(3).map((step) => (step.operationId === 'op-6' ? { ...step, state: 'DONE' as const } : step))
    expect(planOne(redo, rowsOf(redo), rowAt(redo, READY_KEY), { leader: true })).toEqual({ kind: 'go', move: { kind: 'FORWARD', toOperationId: null } })
  })
})

// Three baskets of one order in two work orders: two suits (the six steps), one molded part with no Stitching.
const suit = (id: string, at: number, wo: string): ManyBasket => ({ bundleId: id, code: id.toUpperCase(), steps: route(at).map((step) => ({ ...step, operationId: `${wo}-${step.operationId}` })) })
const molded: ManyBasket = {
  bundleId: 'b3',
  code: 'B3',
  steps: [PATCH, QUALITY, PACKING].map((department, index) => ({ operationId: `wo2-op-${index + 1}`, seq: (index + 1) * 10, name: department.name, department, state: index === 0 ? 'HERE' : index === 1 ? 'NEXT' : 'TODO', added: false })),
}
const ORDER = [suit('b1', 2, 'wo1'), suit('b2', 3, 'wo1'), molded]

describe('Change all on an order', () => {
  it('All · the ones at one step · Choose', () => {
    expect(chosenOf(ORDER, { mode: 'all' })).toHaveLength(3)
    expect(chosenOf(ORDER, { mode: 'at', departmentId: PATCH.id }).map((basket) => basket.bundleId)).toEqual(['b1', 'b3'])
    expect(chosenOf(ORDER, { mode: 'chosen', ids: ['b2'] }).map((basket) => basket.bundleId)).toEqual(['b2'])
    expect(hereDepartmentOf(ORDER[1]!)).toBe(STITCHING.id)
  })

  it('the rows: the departments of their routes in route order, how many are at each, Ready to ship', () => {
    const rows = manyRowsOf(ORDER, 'en')
    expect(rows.map((row) => row.dept?.no ?? READY_KEY)).toEqual([1, 2, 3, 4, 5, 6, READY_KEY])
    expect(rows.find((row) => row.key === PATCH.id)?.here).toBe(2)
  })

  it('a basket whose own route lacks the step stays, and the window says how many; one call per target step', () => {
    const plan = planMany(ORDER, STITCHING.id, { leader: true })
    expect(plan.stay).toBe(1)
    expect(plan.ask).toBe(false)
    expect(plan.groups).toEqual([{ kind: 'FORWARD', toOperationId: 'wo1-op-4', bundleIds: ['b1'] }])
  })

  it('any going back asks why first (a leader); a worker\'s back stays', () => {
    expect(planMany(ORDER, CUTTING.id, { leader: true })).toMatchObject({ ask: true, groups: [] })
    const told = planMany(ORDER, CUTTING.id, { leader: true, why: 'MISTAKE' })
    // b1 and b2 share their work order's Cutting step; the molded part has no Cutting: it stays.
    expect(told.groups).toEqual([{ kind: 'BACK', toOperationId: 'wo1-op-2', bundleIds: ['b1', 'b2'], reason: 'MISTAKE' }])
    expect(told.stay).toBe(1)
    expect(planMany(ORDER, CUTTING.id, { leader: false }).stay).toBe(3)
  })

  it('Ready to ship: only baskets whose last step is reported; the others stay', () => {
    expect(planMany(ORDER, READY_KEY, { leader: true })).toMatchObject({ stay: 3, groups: [] })
  })
})

describe('the route editor', () => {
  const steps = route(3)

  it('lists what is still to come; the last step apart and never skippable', () => {
    const view = routeViewOf(steps, EMPTY_DRAFT, 'en')
    expect(view.ahead.map((step) => step.operationId)).toEqual(['op-5'])
    expect(view.last?.operationId).toBe('op-6')
    expect(turnStep(EMPTY_DRAFT, view, 'op-6')).toBe(EMPTY_DRAFT)
  })

  it('Skip, Put back, Add a step (before the last); Save waits for a change and a reason', () => {
    const view = routeViewOf(steps, EMPTY_DRAFT, 'en')
    const skipped = turnStep(EMPTY_DRAFT, view, 'op-5')
    expect(routeViewOf(steps, skipped, 'en').ahead[0]?.skipped).toBe(true)
    expect(routeViewOf(steps, skipped, 'en').canSave).toBe(false)
    const ready = { ...skipped, adds: [CUTTING.id], why: 'NOT_NEEDED' as const }
    expect(routeViewOf(steps, ready, 'en').canSave).toBe(true)
    expect(editsOf(steps, ready)).toEqual([
      { kind: 'SKIP', operationId: 'op-5', departmentId: QUALITY.id },
      { kind: 'ADD', departmentId: CUTTING.id },
    ])
    const before = steps.map((step) => (step.operationId === 'op-5' ? { ...step, state: 'SKIPPED' as const } : step))
    expect(editsOf(before, turnStep(EMPTY_DRAFT, routeViewOf(before, EMPTY_DRAFT, 'en'), 'op-5'))).toEqual([{ kind: 'PUT_BACK', operationId: 'op-5', departmentId: QUALITY.id }])
  })

  it('after Save: saved; how many stay; the warning when no quality check is left (a warning, not a stop)', () => {
    expect(savedLinesOf({ stay: 0, warnings: [] })).toEqual(['saved'])
    expect(savedLinesOf({ stay: 2, warnings: ['NO_QUALITY_LEFT'] })).toEqual(['saved', 'stay', 'noQuality'])
  })
})

describe('ONE Undo bar', () => {
  it('keeps this person\'s last change; a new one replaces it; another person sees nothing; an Undo moves the screens\' count', () => {
    const store = new UndoStore()
    store.put('w1', { kind: 'move', groupIds: ['g1', 'g2'], code: null, count: 3, from: null, to: deptOf(QUALITY, 'en'), toReady: false })
    expect(store.getSnapshot().entry?.kind).toBe('move')
    store.forget('w2')
    expect(store.getSnapshot().entry).toBeNull()
    store.put('w1', { kind: 'move', groupIds: ['g3'], code: 'B-0431', count: 1, from: deptOf(STITCHING, 'en'), to: deptOf(QUALITY, 'en'), toReady: false })
    store.start()
    store.finish('undone')
    expect(store.getSnapshot()).toMatchObject({ entry: null, changes: 1, said: null })
    store.put('w1', { kind: 'move', groupIds: ['g4'], code: 'B-0431', count: 1, from: null, to: null, toReady: true })
    store.finish('moved')
    expect(store.getSnapshot()).toMatchObject({ entry: null, said: 'moved' })
  })

  const draw = (element: ReactElement, locale: (typeof LOCALES)[number] = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['floor', 'floor-basket']) }, element))

  it('a group says how many and offers Undo; a give nobody held before has no Undo (today\'s API)', () => {
    const many = draw(createElement(UndoBar, { model: { entry: { kind: 'move', groupIds: ['g1'], code: null, count: 3, from: null, to: deptOf(QUALITY, 'en'), toReady: false }, busy: false, said: null }, onUndo: () => undefined, onClose: () => undefined }))
    expect(many).toContain('3 baskets')
    expect(many).toContain('Undo')
    const give = draw(createElement(UndoBar, { model: { entry: { kind: 'give', code: 'B-0431', from: null, to: 'Person 2', assignment: { id: 'a1', version: 1 }, backTo: null }, busy: false, said: null }, onUndo: () => undefined, onClose: () => undefined }))
    expect(give).toContain('Person 2')
    expect(give).not.toContain('>Undo<')
  })

  it('the Steps window: a worker reads who changes the route; a leader has Change the route; back asks why in three taps', () => {
    const base: StepsWindowModel = { open: true, title: 'Steps · B-0431', state: 'ready', mode: 'steps', one: { rows: rowsOf(route(3)), offRoute: false }, many: null, leader: false, canRoute: false, whyTo: null, route: null, said: null, done: [], busy: false }
    // The window itself draws only in a browser (the DS Modal waits for hydration): its body and its foot are drawn here.
    const both = (model: StepsWindowModel, locale: (typeof LOCALES)[number] = 'en') => draw(createElement(StepsBody, { model, onAction: () => undefined }), locale) + draw(createElement(StepsFoot, { model, onAction: () => undefined }), locale)
    for (const locale of LOCALES) expect(both(base, locale).match(/(?:^|[\s>"])(?:steps|route|stepBar|state)\.[a-zA-Z]+/)?.[0] ?? null).toBeNull()
    const worker = both(base)
    expect(worker).toContain('Only the team leader changes the route.')
    expect(worker).toContain('It is here')
    expect(both({ ...base, leader: true, canRoute: true })).toContain('Change the route')
    const why = both({ ...base, leader: true, mode: 'why', whyTo: { dept: deptOf(CUTTING, 'en'), ready: false, name: 'Cutting' } })
    for (const words of ['Work again', 'Moved by mistake', 'Other']) expect(why).toContain(words)
  })
})
