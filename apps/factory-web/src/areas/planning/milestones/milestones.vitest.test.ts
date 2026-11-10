import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { refusalOf as boardRefusalOf } from '../board/model'
import { FIXTURES } from './fixtures'
import { bodyOf, canOf, controlsOf, draftHeld, emptyDraft, heldOf, kindsLeft, milestoneName, queryOf, reasonHeld, refusalOf, rowsOf, selectableHeld, stateTone, trackerSteps, visibleOrders, visibleRows } from './model'

/** Time & action's screen rules (B-W2b-263, SCR-253): made-up data from the design cases. */

const t = (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key)
const conflict = (paths: string[]) => new ApiError('conflict', 409, 'conflict', 'English for logs', null, paths.map((path) => ({ path, message: 'x' })))

describe('the address', () => {
  it('keeps the view, the tile, the search, the open milestone and Add gate; the calendar is the default', () => {
    const controls = controlsOf(new URLSearchParams('view=orders&tile=SAMPLE&q=SO-1&open=gate:1&add=1'))
    expect(controls).toEqual({ view: 'orders', tile: 'SAMPLE', q: 'SO-1', open: 'gate:1', add: '1' })
    expect(queryOf(controls)).toBe('view=orders&tile=SAMPLE&q=SO-1&open=gate%3A1&add=1')
    expect(controlsOf(new URLSearchParams('view=week&tile=NOPE'))).toMatchObject({ view: 'calendar', tile: null })
    expect(queryOf(controlsOf(new URLSearchParams('')))).toBe('')
  })
})

describe('rows and filters', () => {
  const rows = rowsOf(FIXTURES.WORLD)
  it('flattens every order’s milestones with its gate', () => {
    expect(rows.filter((row) => row.kind === 'GATE').every((row) => row.gate !== null)).toBe(true)
    expect(rows.filter((row) => row.kind !== 'GATE').every((row) => row.gate === null)).toBe(true)
  })
  it('a tile keeps the waiting gates of its group; the search the orders that match', () => {
    const sample = visibleRows(rows, { view: 'list', tile: 'SAMPLE', q: '', open: null, add: null })
    expect(sample.map((row) => row.gateKind)).toEqual(['PP_SAMPLE'])
    expect(visibleRows(rows, { view: 'list', tile: 'LEATHER_NOT_PASSED', q: '', open: null, add: null }).map((row) => row.gate?.leather)).toEqual(['NOT_PASSED'])
    expect(visibleOrders(FIXTURES.WORLD, { view: 'orders', tile: 'LEATHER_NOT_RECEIVED', q: '', open: null, add: null })).toHaveLength(1)
    expect(visibleOrders(FIXTURES.WORLD, { view: 'orders', tile: null, q: 'po-demo-77', open: null, add: null }).map((order) => order.number)).toEqual(['SO-DEMO-2041'])
  })
  it('names a milestone: a gate by its kind (Other by its words), start and ship by theirs', () => {
    expect(milestoneName({ kind: 'GATE', gateKind: 'OTHER', label: 'Hang tag' }, t)).toBe('Hang tag')
    expect(milestoneName({ kind: 'GATE', gateKind: 'PP_SAMPLE', label: null }, t)).toBe('kind.PP_SAMPLE')
    expect(milestoneName({ kind: 'SHIP', gateKind: null, label: null }, t)).toBe('milestone.SHIP')
    expect(stateTone({ state: 'WAITING', late: 3 })).toBe('danger')
    expect(stateTone({ state: 'STARTED_BEFORE', late: null })).toBe('info')
  })
  it('the dots of an order: done, started before (skipped), the next one current', () => {
    const order = FIXTURES.ORDERS[0]!
    const steps = trackerSteps(order, t, (iso) => iso)
    expect(steps.find((step) => step.id === `gate:${FIXTURES.TRIMS_STARTED.id}`)?.state).toBe('skipped')
    expect(steps.find((step) => step.id === `gate:${FIXTURES.LEATHER_PASSED.id}`)?.state).toBe('done')
    expect(steps.filter((step) => step.current)).toHaveLength(1)
  })
})

describe('held in our words', () => {
  it('says the permission missing first, then the refusal code', () => {
    expect(heldOf({ allowed: false, refusal: null, needs: 'planning.milestones.override' }, t)).toBe('needs.planning.milestones.override')
    expect(heldOf({ allowed: false, refusal: { code: 'OWN_GATE', message: 'English' }, needs: null }, t)).toBe('refusal.OWN_GATE')
    expect(heldOf({ allowed: true, refusal: null, needs: null }, t)).toBeNull()
  })
  it('only a gate that may be marked done now can be ticked', () => {
    const rows = rowsOf(FIXTURES.WORLD)
    expect(selectableHeld(rows.find((row) => row.gateId === FIXTURES.ARTWORK.id)!, t)).toBeNull()
    expect(selectableHeld(rows.find((row) => row.gateId === FIXTURES.PP_WAITING.id)!, t)).toBe('refusal.ROUND_NOT_APPROVED')
    expect(selectableHeld(rows.find((row) => row.kind === 'SHIP')!, t)).toBe('held.notAGate')
  })
  it('a reason says enough; Other says what it is; a round only on a sample gate', () => {
    expect(reasonHeld('ok', t)).toMatch(/^held.reasonShort/)
    expect(reasonHeld('The brand said go.', t)).toBeNull()
    expect(draftHeld(emptyDraft('OTHER'), t)).toBe('refusal.LABEL_NEEDED')
    expect(draftHeld({ ...emptyDraft('LAB_PASSED'), sampleRoundId: 'x' }, t)).toBe('refusal.ROUND_ONLY_SAMPLE')
    expect(bodyOf({ ...emptyDraft('LAB_PASSED'), sampleRoundId: 'x', label: '  ' })).toEqual({ kind: 'LAB_PASSED', label: null, targetDate: null, sampleRoundId: null, ownerId: null })
    expect(kindsLeft(FIXTURES.ORDERS[1]!)).toEqual(['SAMPLE_APPROVED', 'TRIMS_IN', 'PP_SAMPLE', 'OTHER'])
  })
  it('a refused write becomes a key of our catalogue; the board knows a held drop by its code', () => {
    expect(refusalOf(conflict(['refusal/GATE_EXISTS']))).toBe('refusal.GATE_EXISTS')
    expect(refusalOf(conflict(['version']))).toBe('refusal.changed')
    expect(refusalOf(new Error('x'))).toBe('refusal.failed')
    expect(boardRefusalOf(conflict(['gate/g1', 'gate/g2', 'refusal/GATE_NOT_PASSED']))).toEqual({ code: 'GATE_NOT_PASSED', gates: ['g1', 'g2'] })
    expect(canOf(['planning.view', 'planning.milestones.manage'])).toEqual({ view: true, manage: true, override: false })
  })
})
