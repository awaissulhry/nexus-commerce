import { describe, expect, it } from 'vitest'
import { templateOf } from '../../auth/roles/templates'
import type { Actor } from '../../core/permissions'
import { kpiFileOf } from '../kpis/registry'
import { kpiReaders, ownedReaders } from '../kpis/readers'
import {
  BOARDS,
  boardOf,
  boardsInOrder,
  chooseNumbers,
  DASHBOARD_KEYS,
  defaultLayout,
  isPinnable,
  kpisOfBoard,
  layoutKey,
  layoutOf,
  layoutProblems,
  LOCKED_PANEL,
  mayReadKpi,
  ON_TIME_KPI,
  REPORT_PANELS,
  SHOWN_NUMBERS,
  WIP_KPI,
} from './boards'

const owner = boardOf('owner-group')!
const PACK = new Set(['sales.late-orders', 'production.daily'])
const actor = (permissions: readonly string[], grains: readonly string[] = []): Actor =>
  ({ audience: 'office', tenantId: 't', grants: [{ permissions: [...permissions, ...grains.map((grain) => `money.${grain}`)], companies: 'all', sites: 'all', parties: 'all' }] }) as unknown as Actor

describe('the dashboards (ANA-002, design home.dashboards)', () => {
  it('has one ready dashboard per role and the Owner’s group view, each of known KPIs and office roles', () => {
    expect(BOARDS.map((board) => board.key)).toEqual([...DASHBOARD_KEYS])
    for (const board of BOARDS) {
      expect(board.numbers.length, board.key).toBeGreaterThanOrEqual(SHOWN_NUMBERS)
      expect(new Set(board.numbers).size, board.key).toBe(board.numbers.length)
      for (const key of board.numbers) expect(kpiFileOf(key), `${board.key} reads ${key}`).not.toBeNull()
      for (const role of board.roles) expect(templateOf(role)?.audience, `${board.key} role ${role}`).toBe('office')
      expect(board.panels[0]?.id).toBe(LOCKED_PANEL)
      expect(board.panels.some((panel) => panel.id === 'by-company')).toBe(board.group)
    }
    // The design's Owner numbers: Orders in · Shipped · Late lines · WIP value (cost) · Margin (margin).
    expect(owner.numbers.slice(0, SHOWN_NUMBERS)).toEqual(['sales.orders_in', 'delivery.shipped_on_time', 'delivery.otif', 'production.wip_value', 'sales.order_margin'])
    expect(BOARDS.filter((board) => board.group).map((board) => board.key)).toEqual(['owner-group'])
  })

  it('puts the person’s own roles first, the others after in the design’s order', () => {
    expect(boardsInOrder(['planner']).map((entry) => `${entry.key}${entry.mine ? '*' : ''}`)).toEqual(['planner*', 'owner-group', 'plant-manager', 'sales', 'buyer', 'quality', 'finance', 'line-leader'])
    expect(boardsInOrder(['finance', 'sales']).slice(0, 2).map((entry) => entry.key)).toEqual(['sales', 'finance'])
    expect(boardsInOrder([]).every((entry) => !entry.mine)).toBe(true)
  })

  it('gives a number the person may not read to the next allowed one, never a locked tile', () => {
    // A planner reads orders and production, not costing: the WIP value (cost) and the margin move away.
    const planner = actor(['orders.view', 'production.reports.view'], ['price'])
    const chosen = chooseNumbers(owner, (key) => mayReadKpi(planner, key))
    expect(chosen.shown).toEqual([
      { kpiKey: 'sales.orders_in', standsFor: null },
      { kpiKey: 'delivery.shipped_on_time', standsFor: null },
      { kpiKey: 'delivery.otif', standsFor: null },
      { kpiKey: 'production.output', standsFor: 'production.wip_value' },
      { kpiKey: 'production.wip_pieces', standsFor: 'sales.order_margin' },
    ])
    expect(chosen.withheld).toEqual(['production.wip_value', 'sales.order_margin'])
    // Without the price grain, orders in goes too; nobody reads more than five.
    const noPrice = chooseNumbers(owner, (key) => mayReadKpi(actor(['orders.view', 'production.reports.view']), key))
    expect(noPrice.shown.map((item) => item.kpiKey)).toEqual(['production.output', 'delivery.shipped_on_time', 'delivery.otif', 'production.wip_pieces', 'sales.order_lines_in'])
    // Nothing readable: no number at all.
    expect(chooseNumbers(owner, () => false)).toEqual({ shown: [], withheld: owner.numbers.slice(0, SHOWN_NUMBERS) })
  })

  it('reads a stored arrangement against the dashboard today: unknown panels out, new ones in, the numbers always shown', () => {
    expect(layoutOf(owner, null, PACK)).toEqual(defaultLayout(owner))
    // The seeded owner's layout (its panels as B-W2b-381 wrote them) plus a pinned report and an unknown id.
    const stored = [
      { id: 'numbers', hidden: true, width: 'FULL' as const },
      { id: 'report:sales.late-orders', hidden: false, width: 'TWO_THIRDS' as const },
      { id: 'trends', hidden: false, width: 'HALF' as const },
      { id: 'gone', hidden: false, width: 'HALF' as const },
      { id: 'by-company', hidden: true, width: 'FULL' as const },
    ]
    expect(layoutOf(owner, stored, PACK)).toEqual([
      { id: 'numbers', hidden: false, width: 'FULL' },
      { id: 'report:sales.late-orders', hidden: false, width: 'TWO_THIRDS' },
      { id: 'trends', hidden: false, width: 'HALF' },
      { id: 'by-company', hidden: true, width: 'FULL' },
      { id: 'needs-action', hidden: false, width: 'HALF' },
      { id: 'wip', hidden: false, width: 'FULL' },
    ])
  })

  it('says in words what is wrong with an arrangement', () => {
    const good = defaultLayout(owner)
    expect(layoutProblems(owner, good, PACK)).toEqual([])
    expect(layoutProblems(owner, [...good, { id: 'report:sales.intake', hidden: false, width: 'HALF' }, { id: 'report:production.daily', hidden: false, width: 'FULL' }], PACK)).toEqual([])
    expect(layoutProblems(owner, [], PACK).map((problem) => problem.path)).toContain('body/panels')
    const bad = layoutProblems(owner, [{ id: 'numbers', hidden: true, width: 'WIDE' }, { id: 'numbers', hidden: false, width: 'FULL' }, { id: 'report:nope', hidden: false, width: 'HALF' }], PACK)
    expect(bad.map((problem) => problem.path)).toEqual(['body/panels/0/width', 'body/panels/0/hidden', 'body/panels/1/id', 'body/panels/2/id'])
    expect(layoutProblems(boardOf('sales')!, [{ id: 'numbers', hidden: false, width: 'FULL' }, { id: 'by-company', hidden: false, width: 'FULL' }], PACK).map((problem) => problem.path)).toEqual(['body/panels/1/id'])
    expect(layoutKey('u1', 'sales')).toBe('dashboard:u1:sales')
  })

  it('lets a person pin a W2b-5 report panel or a report of the pack', () => {
    expect(REPORT_PANELS.map((panel) => panel.id)).toContain('report:sales.intake')
    for (const panel of REPORT_PANELS) expect(panel.id).toMatch(/^[a-z0-9]+([.:_-][a-z0-9]+)*$/)
    expect(isPinnable('report:warehouse.ageing', PACK)).toBe(true)
    expect(isPinnable('report:sales.late-orders', PACK)).toBe(true)
    expect(isPinnable('report:sales.unknown', PACK)).toBe(false)
  })

  it('names every KPI it reads as a dashboard use in the KPI library', () => {
    expect(kpisOfBoard(owner)).toEqual([...new Set([...owner.numbers, ON_TIME_KPI, WIP_KPI])].sort())
    const readers = kpiReaders()
    for (const board of BOARDS) {
      const named = readers.filter((reader) => reader.usedIn === 'DASHBOARD' && reader.useKey === board.key).map((reader) => reader.kpiKey)
      expect([...named].sort(), board.key).toEqual(kpisOfBoard(board))
      expect(ownedReaders().has(`DASHBOARD:${board.key}`)).toBe(true)
    }
  })
})
