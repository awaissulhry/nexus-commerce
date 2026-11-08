import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ALLOCATION_REFUSALS, ALLOCATION_WARNINGS } from '@nexus/factory-domain/production/cutorders/allocation'
import { CUT_ORDER_REFUSALS, CUT_ORDER_STATUSES, CUT_TICKET_STATUSES, LAY_STATUSES } from '@nexus/factory-domain/production/cutorders/rules'
import { TICKET_REFUSALS, ticketLines } from '@nexus/factory-domain/production/cutorders/tickets'
import { CUT_VARIANCE_REASONS, RECONCILE_REFUSALS } from '@nexus/factory-domain/production/lays/reconcile'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { RECORD_PAGES, recordAddress } from '../../../../lib/records/record-links'
import { isWindowPage, OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { CUT_LOG, CUTTING, OPEN_CUTS, WORK_ORDER_YIELD, ALLOCATED } from '../demo/fixtures'
import { designScreen as listScreen } from '../fixtures'
import { allocateRolls, createCutOrder, listCutOrders, printTicket, reconcileCutOrder, voidTicket } from './api'
import {
  CANDIDATES,
  GROUPS,
  ORDER_CUTTING,
  ORDER_LEATHER,
  ORDER_PLANNED,
  ORDER_ROWS,
  ordersCanAs,
  RECONCILIATION,
  RECONCILIATION_UNCONFIRMED,
  RECORD,
  RECORD_CUT,
  RECORD_LEATHER,
  RECORD_PLANNED,
  RECORD_RELEASED,
} from './demo/fixtures'
import {
  againstPlan,
  allocateHeld,
  allowedRolls,
  areaBalance,
  backHeld,
  cancelHeld,
  cellGarments,
  draftGarments,
  draftRatio,
  fabricTiles,
  feedbackHeld,
  groupKeyOf,
  layLength,
  layPlies,
  listCsv,
  listRows,
  NO_DRAFT,
  NO_RECONCILE,
  newOrderBody,
  newOrderHeld,
  orderProblem,
  orderViewOf,
  pickedPlies,
  planPhrase,
  printHeld,
  printManyHeld,
  proposalFor,
  reconcileBody,
  reconcileHeld,
  releaseHeld,
  rollHeld,
  rollsGate,
  shadeLots,
  sheetAddressOf,
  sheetHref,
  ticketFacts,
  underPlan,
  usedAgainstEstimate,
  voidHeld,
  type NewOrderDraft,
} from './model'
import { designScreen as orderScreen } from './record/fixtures'
import { designScreen as sheetScreen } from './sheet/fixtures'

/**
 * Cutting in depth (B-W2b-129): the pure rules of cut orders (the list beside the leather cuts, New cut order, the lays and
 * their rolls by shade and shrinkage group, the tickets, Reconcile cut, the yield's issued vs used vs returned, the supplier lot
 * feedback, the same shade lot check, the lay sheet), the calls as the API of B-W2b-112 / B-W2b-116 takes them (the lay's
 * version, a key per write), the pages in the map, the words of every domain code, and every design case drawn in Italian and
 * English with no message key or placeholder left on screen, no money and no person's name.
 */

const manager = ordersCanAs('manager')
const supervisor = ordersCanAs('supervisor')
const FABRIC = GROUPS[0]!
const LEATHER = GROUPS[1]!
const draft = (over: Partial<NewOrderDraft>): NewOrderDraft => ({ ...NO_DRAFT, groupKey: groupKeyOf(FABRIC), ...over })
const ids = FABRIC.cells.map((cell) => cell.workOrderSizeId)

describe('the list: cut orders beside the work orders’ leather cuts', () => {
  it('maps the saved filters onto the cut orders (held has none; waiting keeps planned and released)', () => {
    expect(orderViewOf('open')).toBe('open')
    expect(orderViewOf('waiting')).toBe('open')
    expect(orderViewOf('cutting')).toBe('cutting')
    expect(orderViewOf('cut')).toBe('cut')
    expect(orderViewOf('held')).toBeNull()
    expect(orderViewOf('all')).toBe('all')
    const rows = listRows('waiting', ORDER_ROWS, OPEN_CUTS)
    expect(rows.filter((row) => row.order).map((row) => row.order!.status)).toEqual(['PLANNED', 'RELEASED'])
    expect(rows.filter((row) => row.cut)).toHaveLength(OPEN_CUTS.length)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(rows[0]!.key).toBe(`CO:${ORDER_PLANNED.id}`)
  })

  it('adds the fabric cut orders to the tiles and says the plan in words', () => {
    expect(fabricTiles({ planned: 1, released: 2, cutting: 3, cut: 4, cancelled: 5 })).toEqual({ waiting: 3, cutting: 3 })
    expect(fabricTiles(null)).toBeNull()
    expect(planPhrase(ORDER_CUTTING)).toEqual({ key: 'plan.fabric', params: { lays: 2, plies: 30, garments: 120 } })
    expect(planPhrase(ORDER_LEATHER)).toEqual({ key: 'plan.leather', params: { count: 18 } })
  })

  it('Export N: both kinds, never who cut', () => {
    const text = listCsv(listRows('open', [ORDER_CUTTING], [CUTTING]), ['a'], () => '192.64 ft²')
    expect(text).toContain('CO-2026-0007')
    expect(text).toContain('WO-26-0040 WO-26-0041')
    expect(text).toContain('WO-26-0031')
    expect(text.split('\n')[1]!.split(',')).toHaveLength(15)
    expect(text).not.toMatch(/Esempio|Prova|worker/i)
  })
})

describe('New cut order', () => {
  it('splits the plies into lays and counts each size’s garments', () => {
    expect(layPlies({ plies: '61', lays: '2' })).toEqual([31, 30])
    expect(layPlies({ plies: '3', lays: '4' })).toBeNull()
    expect(layPlies({ plies: 'x', lays: '1' })).toBeNull()
    const fabric = draft({ picked: ids.slice(0, 3), ratio: { [ids[1]!]: '2' }, plies: '20' })
    expect(cellGarments(fabric, FABRIC, FABRIC.cells[1]!)).toBe(40)
    expect(draftGarments(fabric, FABRIC)).toBe(80)
    expect(draftRatio(fabric, FABRIC)).toBe('48:1 · 50:2 · 52:1')
    const leather = { ...NO_DRAFT, groupKey: groupKeyOf(LEATHER), picked: LEATHER.cells.map((cell) => cell.workOrderSizeId), quantity: { [LEATHER.cells[0]!.workOrderSizeId]: '12' } }
    expect(LEATHER.cells.map((cell) => cellGarments(leather, LEATHER, cell))).toEqual([12, 6])
  })

  it('holds Create with why, in the API’s order of rules', () => {
    const ok = draft({ picked: ids.slice(0, 3), ratio: { [ids[1]!]: '2' }, markerName: 'MK', markerLength: '2,4', plies: '20', lays: '2' })
    expect(newOrderHeld(ok, FABRIC, manager, false)).toBeNull()
    expect(newOrderHeld(ok, FABRIC, supervisor, false)).toEqual({ key: 'held.permission', params: { permission: 'production.cutorders.manage' } })
    expect(newOrderHeld(ok, null, manager, false)).toEqual({ key: 'newOrder.held.group' })
    expect(newOrderHeld({ ...ok, picked: [] }, FABRIC, manager, false)).toEqual({ key: 'newOrder.held.cells' })
    expect(newOrderHeld({ ...ok, markerName: ' ' }, FABRIC, manager, false)).toEqual({ key: 'newOrder.held.markerName' })
    expect(newOrderHeld({ ...ok, markerLength: '51' }, FABRIC, manager, false)?.key).toBe('newOrder.held.markerLength')
    expect(newOrderHeld({ ...ok, markerWidth: '0' }, FABRIC, manager, false)?.key).toBe('newOrder.held.markerWidth')
    expect(newOrderHeld({ ...ok, lays: '30' }, FABRIC, manager, false)?.key).toBe('newOrder.held.lays')
    expect(newOrderHeld({ ...ok, plies: '400', lays: '1' }, FABRIC, manager, false)?.key).toBe('newOrder.held.layTooHigh')
    expect(newOrderHeld({ ...ok, plies: '30' }, FABRIC, manager, false)).toEqual({ key: 'newOrder.held.beyond', params: { cell: 'WO-26-0044 NER 48', garments: 30, left: 20 } })
    expect(newOrderHeld({ ...ok, ratio: { [ids[0]!]: '0' } }, FABRIC, manager, false)?.key).toBe('newOrder.held.ratio')
    const leather = { ...NO_DRAFT, groupKey: groupKeyOf(LEATHER), picked: [LEATHER.cells[1]!.workOrderSizeId], quantity: { [LEATHER.cells[1]!.workOrderSizeId]: '7' } }
    expect(newOrderHeld(leather, LEATHER, manager, false)).toEqual({ key: 'newOrder.held.beyond', params: { cell: 'WO-26-0045 NER 52', garments: 7, left: 6 } })
  })

  it('sends the plan the API takes: fabric with marker, plies, lays and ratios; leather with garments', () => {
    const fabric = draft({ picked: ids.slice(0, 2), ratio: { [ids[1]!]: '2' }, markerName: ' MK-1 ', markerLength: '2,40', markerWidth: '145', plies: '15', lays: '2', stationId: 's1', dueDate: '2026-11-27' })
    expect(newOrderBody(fabric, FABRIC)).toEqual({
      siteId: FABRIC.siteId,
      kind: 'FABRIC',
      itemId: FABRIC.item.id,
      itemColourId: FABRIC.colour!.id,
      stationId: 's1',
      dueDate: '2026-11-27',
      marker: { name: 'MK-1', length: '2.40', uom: 'M', widthCm: '145' },
      plies: 15,
      lays: [8, 7],
      lines: [
        { workOrderSizeId: ids[0], ratio: 1 },
        { workOrderSizeId: ids[1], ratio: 2 },
      ],
    })
    const leather = { ...NO_DRAFT, groupKey: groupKeyOf(LEATHER), picked: [LEATHER.cells[0]!.workOrderSizeId] }
    expect(newOrderBody(leather, LEATHER)).toEqual({ siteId: LEATHER.siteId, kind: 'LEATHER', itemId: LEATHER.item.id, itemColourId: LEATHER.colour!.id, lines: [{ workOrderSizeId: LEATHER.cells[0]!.workOrderSizeId, quantity: 20 }] })
  })
})

describe('the record: lays, rolls, tickets', () => {
  const lay2 = RECORD.lays[1]!
  it('a lay’s length on the table, else the marker’s; Release, Back and Cancel held with why', () => {
    expect(layLength(RECORD.lays[0]!, RECORD.cutOrder.marker)).toBe('2.45')
    expect(layLength(lay2, RECORD.cutOrder.marker)).toBe('2.4')
    expect(layLength({ layLength: '245', lengthUom: 'CM' }, null)).toBe('2.45')
    expect(releaseHeld(RECORD_PLANNED, manager, false)).toBeNull()
    expect(releaseHeld(RECORD, manager, false)).toEqual({ key: 'held.release.status', params: { status: 'IN_PROGRESS' } })
    expect(backHeld(RECORD_RELEASED, manager, false)).toBeNull()
    expect(backHeld(RECORD, manager, false)).toEqual({ key: 'held.back.status' })
    expect(cancelHeld(RECORD_RELEASED, manager, false)).toBeNull()
    expect(cancelHeld(RECORD_RELEASED, supervisor, false)).toEqual({ key: 'held.permission', params: { permission: 'production.cutorders.manage' } })
  })

  it('mixing shade or shrinkage groups in one lay is refused with the reason; the lay full; a roll’s own refusal', () => {
    const [r4, r6, r3, r5, r7, r8, r9] = CANDIDATES.rolls as [never, never, never, never, never, never, never]
    expect(allocateHeld(RECORD, lay2, manager)).toBeNull()
    expect(allocateHeld(RECORD, RECORD.lays[0]!, manager)).toEqual({ key: 'held.rolls.layAtTable', params: { seq: 1 } })
    expect(allocateHeld(RECORD_PLANNED, RECORD_PLANNED.lays[0]!, manager)).toEqual({ key: 'held.rolls.notReleased' })
    expect(allocateHeld(RECORD_LEATHER, lay2, manager)).toEqual({ key: 'held.rolls.leather' })
    expect(rollHeld(r4, lay2, [], RECORD.cutOrder.number)).toBeNull()
    expect(rollHeld(r3, lay2, [], RECORD.cutOrder.number)).toEqual({ key: 'rolls.why.mine', params: { seq: 2 } })
    expect(rollHeld(r5, lay2, [], RECORD.cutOrder.number)).toEqual({ key: 'rolls.why.shade', params: { seq: 2, lay: 'A', roll: 'B' } })
    expect(rollHeld(r7, lay2, [], RECORD.cutOrder.number)).toEqual({ key: 'rolls.why.shrinkage', params: { seq: 2, lay: 'S1', roll: 'S2' } })
    expect(rollHeld(r8, lay2, [], RECORD.cutOrder.number)).toEqual({ key: 'refusal.ROLL_TOO_NARROW' })
    expect(rollHeld(r9, lay2, [], RECORD.cutOrder.number)).toEqual({ key: 'refusal.LOT_HELD' })
    // r4 gives the 9 plies lay 2 still needs: no other roll may be ticked beside it.
    expect(pickedPlies(lay2, [r4, r6])).toEqual(new Map([[(r4 as { id: string }).id, 9], [(r6 as { id: string }).id, 0]]))
    expect(rollHeld(r6, lay2, [r4], RECORD.cutOrder.number)).toEqual({ key: 'rolls.why.full', params: { seq: 2 } })
    // An empty lay takes the first roll's shade.
    const empty = RECORD_RELEASED.lays[1]!
    expect(rollHeld(r5, empty, [r4], RECORD.cutOrder.number)).toEqual({ key: 'rolls.why.shade', params: { seq: 2, lay: 'A', roll: 'B' } })
    expect(proposalFor(CANDIDATES, lay2.id).map((roll) => roll.code)).toEqual(['DEMO-RL-0004'])
    // A selection keeps only what the lay may take, in the order ticked (a stale grid cannot slip a roll of another group in).
    const all = CANDIDATES.rolls
    const pick = (...rolls: never[]) => rolls.map((roll) => (roll as { id: string }).id)
    expect(allowedRolls(pick(r4, r5, r6, r8), all, lay2, RECORD.cutOrder.number)).toEqual(pick(r4))
    expect(allowedRolls(pick(r5, r4), all, empty, RECORD.cutOrder.number)).toEqual(pick(r5))
    // The boxes are drawn again when the group or the fullness changes.
    expect(rollsGate(empty, [])).not.toBe(rollsGate(empty, [r4]))
    expect(rollsGate(lay2, [])).not.toBe(rollsGate(lay2, [r4]))
  })

  it('tickets: a void or done one is neither printed nor voided again', () => {
    const [done, open] = RECORD.tickets as [never, never]
    expect(printHeld(open, manager, false)).toBeNull()
    expect(printHeld(done, manager, false)).toEqual({ key: 'held.ticket.done' })
    expect(voidHeld({ ...(open as object), status: 'VOID' } as never, manager, false)).toEqual({ key: 'held.ticket.void' })
    expect(printManyHeld([open, done], manager, false)).toEqual({ key: 'held.ticket.done' })
    expect(printManyHeld([], manager, false)).toEqual({ key: 'tickets.held.none' })
    expect(printHeld(open, supervisor, false)).toEqual({ key: 'held.permission', params: { permission: 'production.cutorders.manage' } })
  })
})

describe('Reconcile cut and the yield', () => {
  it('holds Reconcile until each line that differs has a reason (Other with words), and sends them', () => {
    expect(reconcileHeld(RECONCILIATION, NO_RECONCILE, manager, false)).toEqual({ key: 'reconcile.held.reason', params: { seq: 10, cut: 28, ordered: 30 } })
    expect(reconcileHeld(RECONCILIATION_UNCONFIRMED, NO_RECONCILE, manager, false)).toEqual({ key: 'refusal.FABRIC_NOT_CONFIRMED' })
    expect(reconcileHeld(RECONCILIATION, NO_RECONCILE, supervisor, false)?.key).toBe('held.permission')
    const [a, b, c] = RECONCILIATION.lines.map((line) => line.id) as [string, string, string]
    const other = { reason: { [a]: 'PLIES_SHORT', [b]: 'OTHER', [c]: 'PLIES_SHORT' }, note: {} }
    expect(reconcileHeld(RECONCILIATION, other, manager, false)).toEqual({ key: 'reconcile.held.note', params: { seq: 20 } })
    const given = { ...other, note: { [b]: ' Roll end flawed ' } }
    expect(reconcileHeld(RECONCILIATION, given, manager, false)).toBeNull()
    expect(reconcileBody(RECONCILIATION, given)).toEqual({
      version: 9,
      lines: [
        { lineId: a, reasonCode: 'PLIES_SHORT' },
        { lineId: b, reasonCode: 'OTHER', note: 'Roll end flawed' },
        { lineId: c, reasonCode: 'PLIES_SHORT' },
      ],
    })
  })

  it('used against the estimate in our words; the leather’s issued vs used vs returned per unit', () => {
    expect(usedAgainstEstimate({ used: '68.9', estimated: '67.2' }, 'en')).toEqual({ key: 'material.more', params: { metres: '1.7', pct: '2.5' } })
    expect(usedAgainstEstimate({ used: '60', estimated: '64' }, 'it')).toEqual({ key: 'material.less', params: { metres: '4', pct: '6,3' } })
    expect(usedAgainstEstimate({ used: '1', estimated: '0' }, 'en')).toBeNull()
    // Issued 220.40, cut 118.80, waste 39.76, back to stock 4.10, still on the hides 57.74 ft².
    const [sum] = areaBalance(CUT_LOG, WORK_ORDER_YIELD)
    expect(sum).toMatchObject({ uom: 'FT2', hides: 4 })
    expect(sum!.issued).toBeCloseTo(220.4, 4)
    expect(sum!.cut).toBeCloseTo(118.8, 4)
    expect(sum!.returned).toBeCloseTo(4.1, 4)
    expect(sum!.left).toBeCloseTo(57.74, 4)
  })

  it('a supplier lot under the plan is raised with its supplier (a claim; the buying side’s right)', () => {
    expect(againstPlan('72.40', '75.00')).toBe(-2.6)
    expect(underPlan(-2.6)).toBe(true)
    expect(underPlan(-1)).toBe(false)
    expect(underPlan(null)).toBe(false)
    expect(feedbackHeld({ supplier: 'Conceria Demo' }, true)).toBeNull()
    expect(feedbackHeld({ supplier: 'Conceria Demo' }, false)).toEqual({ key: 'held.permission', params: { permission: 'purchasing.claims.manage' } })
    expect(feedbackHeld({ supplier: null }, true)).toEqual({ key: 'feedback.held.noSupplier' })
  })

  it('the same shade lot check: lot and shade of the hides cut, the allocated hides of a known lot join it', () => {
    expect(shadeLots([{ lotCode: 'L1', shade: 'N2' }, { lotCode: 'L1', shade: 'N2' }], ALLOCATED)).toEqual([{ lot: 'L1', shade: 'N2', hides: 2 }, { lot: 'DEMO-LOT-0101', shade: null, hides: 2 }])
    expect(shadeLots([{ lotCode: 'DEMO-LOT-0101', shade: 'N2' }], ALLOCATED)).toEqual([{ lot: 'DEMO-LOT-0101', shade: 'N2', hides: 3 }])
    expect(shadeLots([], [])).toEqual([])
  })
})

describe('the lay sheet', () => {
  it('reads its address and names the ticket as the printer prints it', () => {
    expect(sheetAddressOf(new URLSearchParams(`id=${RECORD.cutOrder.id}&lay=nonsense`))).toEqual({ id: RECORD.cutOrder.id, lay: null })
    expect(sheetHref('/w/DEMO', 'c1', 'l1')).toBe('/w/DEMO/production/cutting/sheet?id=c1&lay=l1')
    const facts = ticketFacts(RECORD, RECORD.lays[1]!, 'it', 'Demo Factory')
    expect(facts).toMatchObject({ code: 'CTA-2026-00012', lay: { seq: 2, of: 2, plies: 15 }, ratio: '48:1 · 50:2 · 52:1', garments: 60, workOrders: 'WO-26-0040, WO-26-0041' })
    const lines = ticketLines(facts)
    expect(lines.heading).toBe('Demo Factory · Buono di taglio')
    expect(lines.title).toBe('Materasso 2/2 · 15 strati · DEMO-JKT-01')
    expect(ticketFacts(RECORD_LEATHER, null, 'en', null)).toMatchObject({ code: RECORD_LEATHER.tickets[0]!.code, lay: null, garments: 18 })
  })
})

describe('refusals in our words', () => {
  const refused = (path: string, kind: ConstructorParameters<typeof ApiError>[0] = 'conflict', status = 409) => new ApiError(kind, status, 'refused', 'x', null, [{ path, message: 'English words never shown' }])
  it('says the rule the API named, else the field, else by its kind', () => {
    expect(orderProblem(refused('refusal/MIXED_SHADE'))).toEqual({ key: 'refusal.MIXED_SHADE' })
    expect(orderProblem(refused('refusal/CELL_FULL'))).toEqual({ key: 'refusal.CELL_FULL' })
    expect(orderProblem(refused('refusal/FABRIC_NOT_CONFIRMED'))).toEqual({ key: 'refusal.FABRIC_NOT_CONFIRMED' })
    expect(orderProblem(refused('body/lines/2/reasonCode', 'invalid', 400))).toEqual({ key: 'problem.field.reason' })
    expect(orderProblem(refused('body/marker/length', 'invalid', 400))).toEqual({ key: 'problem.field.marker' })
    expect(orderProblem(refused('body/printerId', 'invalid', 400))).toEqual({ key: 'problem.field.printer' })
    expect(orderProblem(refused('version'))).toEqual({ key: 'problem.changed' })
    expect(orderProblem(new Error('x'))).toEqual({ key: 'problem.write' })
  })

  it('has words for every code of the domain, in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['cutting-orders'])['cutting-orders'] ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const code of [...CUT_ORDER_REFUSALS, ...ALLOCATION_REFUSALS, ...TICKET_REFUSALS, ...RECONCILE_REFUSALS, 'FLOOR_NOT_READY']) has(`refusal.${code}`)
      for (const code of ALLOCATION_WARNINGS) has(`warning.${code}`)
      for (const code of CUT_VARIANCE_REASONS) has(`reason.${code}`)
      for (const status of CUT_ORDER_STATUSES) has(`status.${status}`)
      for (const status of LAY_STATUSES) has(`layStatus.${status}`)
      for (const status of CUT_TICKET_STATUSES) has(`ticketStatus.${status}`)
      for (const kind of ['LEATHER', 'FABRIC']) has(`kind.${kind}`)
      for (const tab of ['lay', 'pieces', 'yield', 'tickets']) has(`tab.${tab}`)
      for (const column of ['cut', 'kind', 'workOrders', 'style', 'material', 'lot', 'state', 'planned', 'piecesCut', 'plies', 'hides', 'area', 'yieldPct', 'table', 'date']) has(`csv.${column}`)
      has('plan.leather', 2)
      has('notice.released', 2)
    }
  })
})

describe('the calls', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }

  it('lists, creates, allocates at the lay’s version, prints, voids and reconciles with their keys', async () => {
    const { api, calls } = recorder({
      '/production/cut-orders': RECORD,
      '/rolls': RECORD,
      '/print': { ticket: RECORD.tickets[1], label: { heading: 'h', title: 't', fields: [] }, job: null, problem: 'shown' },
      '/void': { voided: RECORD.tickets[1], replacement: null },
      '/reconcile': RECONCILIATION,
    })
    const { api: listApi, calls: listCalls } = recorder({ '/production/cut-orders': { rows: ORDER_ROWS, nextCursor: null, tiles: { planned: 1, released: 0, cutting: 1, cut: 0, cancelled: 0 } } })
    expect((await listCutOrders(listApi, { view: 'cutting', q: ' WO-26 ', limit: 50, kind: 'FABRIC' })).rows).toHaveLength(3)
    expect(listCalls[0]!.url).toContain('view=cutting')
    expect(listCalls[0]!.url).toContain('q=WO-26')
    expect(listCalls[0]!.url).toContain('kind=FABRIC')
    await createCutOrder(api, { siteId: 's', kind: 'LEATHER', itemId: 'i', itemColourId: null, lines: [{ workOrderSizeId: 'c', quantity: 2 }] }, 'k-create')
    expect(calls[0]).toMatchObject({ method: 'POST', key: 'k-create', body: { kind: 'LEATHER', lines: [{ workOrderSizeId: 'c', quantity: 2 }] } })
    const lay2 = RECORD.lays[1]!
    await allocateRolls(api, RECORD.cutOrder.id, lay2.id, { version: lay2.version, rolls: [{ rollId: 'r4', plies: 9 }] }, 'k-rolls')
    expect(calls[1]!.url).toContain(`/production/cut-orders/${RECORD.cutOrder.id}/lays/${lay2.id}/rolls`)
    expect(calls[1]).toMatchObject({ key: 'k-rolls', body: { version: 3, rolls: [{ rollId: 'r4', plies: 9 }] } })
    expect((await printTicket(api, 't2', { printerId: null, language: 'it' }, 'k-print')).problem).toBe('shown')
    expect(calls[2]).toMatchObject({ key: 'k-print', body: { printerId: null, language: 'it' } })
    await voidTicket(api, 't2', { version: 1, reason: 'Lost at the table', replace: true }, 'k-void')
    expect(calls[3]).toMatchObject({ key: 'k-void', body: { version: 1, reason: 'Lost at the table', replace: true } })
    await reconcileCutOrder(api, RECORD_CUT.cutOrder.id, { version: 9, lines: [{ lineId: 'l', reasonCode: 'PLIES_SHORT' }] }, 'k-rec')
    expect(calls[4]).toMatchObject({ key: 'k-rec', body: { version: 9, lines: [{ lineId: 'l', reasonCode: 'PLIES_SHORT' }] } })
  })
})

describe('the pages in the map', () => {
  it('a cut order opens its record; the lay sheet is a new tab in its own window', () => {
    expect(OFFICE_PAGES.has('/production/cutting/orders/[id]')).toBe(true)
    expect(OFFICE_PAGES.has('/production/cutting/sheet')).toBe(true)
    expect(isWindowPage('/production/cutting/sheet?id=x')).toBe(true)
    expect(RECORD_PAGES.CutOrder).toBe('/production/cutting/orders/[id]')
    expect(recordAddress({ type: 'CutOrder', id: 'c1', companyId: 'k' }, OFFICE_PAGES)).toBe('/production/cutting/orders/c1')
  })
})

const LEFT_KEY = /\b(?:common|noAccess|live|kind|status|layStatus|ticketStatus|reason|warning|refusal|problem|held|plan|tile|col|list|csv|newOrder|record|tab|part|marker|lays|lines|hides|pieces|yield|material|tickets|print|language|void|back|cancel|rolls|reconcile|notice|sheet|shadeLot|ofWorkOrder|balance|feedback|state|view|alloc)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs production.cutorders.manage"). */
const SAID = /\b(?:production\.[a-z.]+|inventory\.[a-z.]+|workorders\.[a-z.]+|purchasing\.[a-z.]+|print\.view|money\.cost)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'cutting', 'cutting-orders', 'ds-words']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen, no money, no person', () => {
  for (const screen of [orderScreen, sheetScreen, listScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
          expect(html, `${screen.screen}/${item.id} money`).not.toMatch(/€|\bEUR\b/)
        }
      }
    })
  }
})
