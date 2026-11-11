import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { SCHEDULE_REFUSALS, SKIP_CODES } from '../schedule/refusals'
import { PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE } from './permissions'
import {
  gateStateOf,
  holdWords,
  lateDays,
  leatherStateOf,
  milestoneOrder,
  milestoneStateOf,
  passRefusal,
  productionStartOf,
  reasonOf,
  removeRefusal,
  shapeRefusal,
  startBeforeRefusal,
  tileCounts,
  tileOf,
  workOrdersByKind,
  type GateFacts,
} from './rules'

/** Time & action's rules (B-W2b-263; PLN-186). Made-up numbers only. */

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({ number: 'SO-DEMO-1', kind: 'OTHER', orderStatus: 'CONFIRMED', passedAt: null, overriddenAt: null, ownerId: 'owner', createdById: 'maker', round: null, ...over })

describe('gates', () => {
  it('a gate is waiting, passed or started before (passed wins)', () => {
    expect(gateStateOf({ passedAt: null, overriddenAt: null })).toBe('WAITING')
    expect(gateStateOf({ passedAt: null, overriddenAt: new Date() })).toBe('STARTED_BEFORE')
    expect(gateStateOf({ passedAt: new Date(), overriddenAt: new Date() })).toBe('PASSED')
  })

  it('passing: once, never on a day to come, a named round only once approved, never on a closed order', () => {
    expect(passRefusal(facts(), '2026-11-10', '2026-11-10')).toBeNull()
    expect(passRefusal(facts(), '2026-11-11', '2026-11-10')?.code).toBe('FUTURE_DAY')
    expect(passRefusal(facts({ passedAt: new Date() }), '2026-11-10', '2026-11-10')?.code).toBe('PASSED')
    expect(passRefusal(facts({ kind: 'PP_SAMPLE', round: { number: 'SR-DEMO-3', decision: null, kind: 'PRE_PRODUCTION' } }), '2026-11-10', '2026-11-10')?.code).toBe('ROUND_NOT_APPROVED')
    expect(passRefusal(facts({ kind: 'PP_SAMPLE', round: { number: 'SR-DEMO-3', decision: 'REJECTED', kind: 'PRE_PRODUCTION' } }), '2026-11-10', '2026-11-10')?.code).toBe('ROUND_NOT_APPROVED')
    expect(passRefusal(facts({ kind: 'PP_SAMPLE', round: { number: 'SR-DEMO-3', decision: 'APPROVED_WITH_COMMENTS', kind: 'PRE_PRODUCTION' } }), '2026-11-10', '2026-11-10')).toBeNull()
    expect(passRefusal(facts({ orderStatus: 'SHIPPED' }), '2026-11-10', '2026-11-10')?.code).toBe('ORDER_CLOSED')
  })

  it("starting before: not passed, once, never by the gate's owner or maker", () => {
    expect(startBeforeRefusal(facts(), 'colleague')).toBeNull()
    expect(startBeforeRefusal(facts(), 'owner')?.code).toBe('OWN_GATE')
    expect(startBeforeRefusal(facts(), 'maker')?.code).toBe('OWN_GATE')
    expect(startBeforeRefusal(facts({ overriddenAt: new Date() }), 'colleague')?.code).toBe('STARTED_BEFORE')
    expect(startBeforeRefusal(facts({ passedAt: new Date() }), 'colleague')?.code).toBe('PASSED')
    expect(reasonOf('  ok ')).toBeNull()
    expect(reasonOf('  The brand said go.  ')).toBe('The brand said go.')
    expect(reasonOf('x'.repeat(1001))).toBeNull()
  })

  it('the shape: Other says what it is; a round only on a sample gate; a PP sample gate a pre-production round', () => {
    expect(shapeRefusal('OTHER', ' ', null)?.code).toBe('LABEL_NEEDED')
    expect(shapeRefusal('OTHER', 'Hang tag', null)).toBeNull()
    expect(shapeRefusal('LAB_PASSED', null, { number: 'SR-1', decision: null, kind: 'FIT' })?.code).toBe('ROUND_ONLY_SAMPLE')
    expect(shapeRefusal('PP_SAMPLE', null, { number: 'SR-1', decision: null, kind: 'FIT' })?.code).toBe('ROUND_KIND')
    expect(shapeRefusal('SAMPLE_APPROVED', null, { number: 'SR-1', decision: null, kind: 'FIT' })).toBeNull()
  })

  it('a passed or started-before gate is kept', () => {
    expect(removeRefusal(facts())).toBeNull()
    expect(removeRefusal(facts({ overriddenAt: new Date() }))?.code).toBe('KEPT')
  })

  it("the leather of an order and the tiles: orders waiting per group, each counted once", () => {
    expect(leatherStateOf([])).toBe('NOT_RECEIVED')
    expect(leatherStateOf([{ qualityStatus: 'RELEASED' }, { qualityStatus: 'QUARANTINE' }])).toBe('NOT_PASSED')
    expect(leatherStateOf([{ qualityStatus: 'RELEASED' }])).toBe('PASSED')
    expect(tileOf('PP_SAMPLE', null)).toBe('SAMPLE')
    expect(tileOf('LEATHER_APPROVED', 'NOT_RECEIVED')).toBe('LEATHER_NOT_RECEIVED')
    expect(tileOf('LEATHER_APPROVED', 'NOT_PASSED')).toBe('LEATHER_NOT_PASSED')
    expect(tileOf('LAB_PASSED', null)).toBe('OTHER')
    expect(
      tileCounts([
        { salesOrderId: 'a', kind: 'SAMPLE_APPROVED', state: 'WAITING', leather: null },
        { salesOrderId: 'a', kind: 'PP_SAMPLE', state: 'WAITING', leather: null },
        { salesOrderId: 'b', kind: 'PP_SAMPLE', state: 'PASSED', leather: null },
        { salesOrderId: 'b', kind: 'TRIMS_IN', state: 'WAITING', leather: null },
        { salesOrderId: 'c', kind: 'LEATHER_APPROVED', state: 'STARTED_BEFORE', leather: 'NOT_RECEIVED' },
      ]),
    ).toEqual({ SAMPLE: 1, LEATHER_NOT_RECEIVED: 0, LEATHER_NOT_PASSED: 0, TRIMS: 1, OTHER: 0 })
  })
})

describe('milestones', () => {
  it('late: done after the target, or not done and the target passed', () => {
    expect(lateDays('2026-11-10', null, '2026-11-12')).toBe(2)
    expect(lateDays('2026-11-10', null, '2026-11-10')).toBeNull()
    expect(lateDays('2026-11-10', '2026-11-13', '2026-11-20')).toBe(3)
    expect(lateDays('2026-11-10', '2026-11-09', '2026-11-20')).toBeNull()
    expect(lateDays(null, null, '2026-11-20')).toBeNull()
  })

  it('states and order: by target date (none last), gates before start before ship', () => {
    expect(milestoneStateOf('GATE', 'STARTED_BEFORE', null)).toBe('STARTED_BEFORE')
    expect(milestoneStateOf('SHIP', null, '2026-11-10')).toBe('DONE')
    expect(milestoneStateOf('START', null, null)).toBe('TO_COME')
    const rows = [
      { id: 'ship', kind: 'SHIP' as const, target: '2026-12-04' },
      { id: 'start', kind: 'START' as const, target: null },
      { id: 'g2', kind: 'GATE' as const, target: '2026-12-04' },
      { id: 'g1', kind: 'GATE' as const, target: '2026-11-25' },
    ]
    expect(rows.sort(milestoneOrder).map((row) => row.id)).toEqual(['g1', 'g2', 'ship', 'start'])
  })

  it('B-W2b-284: production start follows the production work orders only, never a sample or a repair; the order counts its work orders per kind', () => {
    const at = (iso: string) => new Date(iso)
    const sample = { kind: 'SAMPLE', status: 'IN_PROGRESS', startedAt: at('2026-11-02T08:00:00Z'), firstBar: at('2026-11-01T07:00:00Z') }
    const repair = { kind: 'REPAIR', status: 'RELEASED', startedAt: null, firstBar: at('2026-11-03T07:00:00Z') }
    expect(productionStartOf([sample, repair])).toBeNull()
    const grid = { kind: 'SIZE_GRID', status: 'RELEASED', startedAt: null, firstBar: at('2026-11-20T07:00:00Z') }
    const mtm = { kind: 'MADE_TO_MEASURE', status: 'IN_PROGRESS', startedAt: at('2026-11-18T09:00:00Z'), firstBar: null }
    expect(productionStartOf([sample, repair, grid])).toEqual({ firstBar: grid.firstBar, firstStart: null })
    expect(productionStartOf([sample, grid, mtm])).toEqual({ firstBar: grid.firstBar, firstStart: mtm.startedAt })
    expect(workOrdersByKind([sample, repair, grid, { ...grid, status: 'CANCELLED' }, mtm])).toEqual([
      { kind: 'SIZE_GRID', count: 2, notStarted: 1 },
      { kind: 'MADE_TO_MEASURE', count: 1, notStarted: 0 },
      { kind: 'SAMPLE', count: 1, notStarted: 0 },
      { kind: 'REPAIR', count: 1, notStarted: 1 },
    ])
    expect(workOrdersByKind([])).toEqual([])
  })

  it("the board's hold names the work order and its gates", () => {
    expect(holdWords('WO-DEMO-2', [{ orderNumber: 'SO-DEMO-1', kind: 'PP_SAMPLE', label: null }])).toMatch(/^WO-DEMO-2 waits on a gate not passed \(SO-DEMO-1 pp sample\)/)
  })
})

describe('the catalogues', () => {
  it('declares the permissions, gives them to the planner and the production manager, and the event', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PLANNING_MILESTONES_MANAGE)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(PLANNING_MILESTONES_OVERRIDE)).toBe(true)
    const template = (key: string) => ROLE_TEMPLATES.find((role) => role.key === key)!.permissions
    expect(template('planner')).toContain(PLANNING_MILESTONES_MANAGE)
    expect(template('planner')).not.toContain(PLANNING_MILESTONES_OVERRIDE)
    expect(template('production_manager')).toEqual(expect.arrayContaining([PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE]))
    expect(template('read_only')).not.toContain(PLANNING_MILESTONES_MANAGE)
    expect(EVENT_CATALOGUE.find('order_gate.changed', 1)).toBeDefined()
    expect(SCHEDULE_REFUSALS).toContain('GATE_NOT_PASSED')
    expect(SKIP_CODES).toContain('GATE_NOT_PASSED')
  })
})
