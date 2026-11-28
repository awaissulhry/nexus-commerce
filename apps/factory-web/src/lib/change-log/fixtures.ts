import { defineDesignScreen } from '../design/design-screen'
import type { LogRow } from './model'
import { ChangeLogLab, type ChangeLogLabModel } from './view/ChangeLogLab'

/**
 * owb-b4 w4.4 — the change log on the design index (`/design/change-log-parts`): the three faces the server sends (office names and
 * reasons; the customer's "The factory" and no reason; the floor's "You", "Office", a department), every value kind, a PC's table and a
 * phone's list, and the states. Made-up names and data only.
 */

const row = (over: Partial<LogRow> & Pick<LogRow, 'id' | 'action'>): LogRow => ({ at: '2026-11-27T09:14:00.000Z', who: { face: 'SYSTEM', name: null, departmentNo: null }, icon: 'history', subject: { kind: 'ORDER', label: null }, from: null, to: null, reason: null, ...over })

export const OFFICE_ROWS: readonly LogRow[] = [
  row({ id: 'r7', at: '2026-11-28T08:02:00.000Z', action: 'shipping.ship', icon: 'truck', from: { kind: 'LIFE', life: 'READY_TO_SHIP' }, to: { kind: 'LIFE', life: 'SHIPPED' } }),
  row({ id: 'r6', at: '2026-11-27T16:40:00.000Z', who: { face: 'DEPARTMENT', name: null, departmentNo: 2 }, action: 'production.baskets.move', icon: 'route', subject: { kind: 'BASKET', label: 'BSK-0042' }, from: { kind: 'DEPT', no: 2 }, to: { kind: 'DEPT', no: 4 } }),
  row({ id: 'r5', at: '2026-11-27T11:05:00.000Z', who: { face: 'PERSON', name: 'Sam Sales', departmentNo: null }, action: 'orders.changeShipTo', icon: 'map-pin', from: { kind: 'TEXT', text: 'Milan warehouse' }, to: { kind: 'TEXT', text: 'Brand Alpha shop, Rotterdam' } }),
  row({ id: 'r4', at: '2026-11-27T10:30:00.000Z', who: { face: 'PERSON', name: 'Bianca Buyer', departmentNo: null }, action: 'orders.picture.set', icon: 'image', from: { kind: 'PICTURE', fileId: null }, to: { kind: 'PICTURE', fileId: 'f-demo' } }),
  row({ id: 'r3', at: '2026-11-27T09:14:00.000Z', who: { face: 'PERSON', name: 'Sam Sales', departmentNo: null }, action: 'orders.changePromise', icon: 'calendar-clock', from: { kind: 'DATE', date: '2026-12-04' }, to: { kind: 'DATE', date: '2026-12-11' }, reason: 'The leather arrives a week later.' }),
  row({ id: 'r2', at: '2026-11-26T15:20:00.000Z', who: { face: 'PERSON', name: 'Otto Owner', departmentNo: null }, action: 'portalOrdering.confirm', icon: 'circle-check', from: { kind: 'LIFE', life: 'SENT' }, to: { kind: 'LIFE', life: 'CONFIRMED' } }),
  row({ id: 'r1', at: '2026-11-26T09:00:00.000Z', who: { face: 'PERSON', name: 'Bianca Buyer', departmentNo: null }, action: 'portalOrdering.addLines', icon: 'list-plus', subject: { kind: 'LINE', label: 'Race suit · 50' }, from: { kind: 'COUNT', n: 0 }, to: { kind: 'COUNT', n: 3 } }),
]

/** The customer's face, as the server sends it: "The factory" for any factory person, its own colleague by name, no reason, no floor row. */
export const PORTAL_ROWS: readonly LogRow[] = [
  row({ id: 'p4', at: '2026-11-28T08:02:00.000Z', who: { face: 'THE_FACTORY', name: null, departmentNo: null }, action: 'shipping.ship', icon: 'truck', from: { kind: 'LIFE', life: 'READY_TO_SHIP' }, to: { kind: 'LIFE', life: 'SHIPPED' } }),
  row({ id: 'p3', at: '2026-11-27T09:14:00.000Z', who: { face: 'THE_FACTORY', name: null, departmentNo: null }, action: 'orders.changePromise', icon: 'calendar-clock', from: { kind: 'DATE', date: '2026-12-04' }, to: { kind: 'DATE', date: '2026-12-11' } }),
  row({ id: 'p2', at: '2026-11-27T10:30:00.000Z', who: { face: 'PERSON', name: 'Bianca Buyer', departmentNo: null }, action: 'orders.picture.set', icon: 'image', from: { kind: 'PICTURE', fileId: null }, to: { kind: 'PICTURE', fileId: 'f-demo' } }),
  row({ id: 'p1', at: '2026-11-26T15:20:00.000Z', who: { face: 'THE_FACTORY', name: null, departmentNo: null }, action: 'portalOrdering.confirm', icon: 'circle-check', from: { kind: 'LIFE', life: 'SENT' }, to: { kind: 'LIFE', life: 'CONFIRMED' } }),
]

/** The floor's face: "You", "Office", a department — never a name. */
export const FLOOR_ROWS: readonly LogRow[] = [
  row({ id: 'f3', at: '2026-11-28T07:40:00.000Z', who: { face: 'YOU', name: null, departmentNo: null }, action: 'production.baskets.move', icon: 'route', subject: { kind: 'BASKET', label: 'BSK-0042' }, from: { kind: 'DEPT', no: 2 }, to: { kind: 'DEPT', no: 3 } }),
  row({ id: 'f2', at: '2026-11-27T17:10:00.000Z', who: { face: 'DEPARTMENT', name: null, departmentNo: 1 }, action: 'production.baskets.move', icon: 'route', subject: { kind: 'BASKET', label: 'BSK-0042' }, from: { kind: 'DEPT', no: 1 }, to: { kind: 'DEPT', no: 2 } }),
  row({ id: 'f1', at: '2026-11-27T09:14:00.000Z', who: { face: 'OFFICE', name: null, departmentNo: null }, action: 'orders.changePromise', icon: 'calendar-clock', from: { kind: 'DATE', date: '2026-12-04' }, to: { kind: 'DATE', date: '2026-12-11' } }),
]

const ready = (rows: readonly LogRow[], over: Partial<ChangeLogLabModel> = {}): ChangeLogLabModel => ({ rows, status: 'ready', more: 'none', ...over })

export const designScreen = defineDesignScreen<ChangeLogLabModel>({
  screen: 'change-log-parts',
  title: 'The change log — office, customer and floor faces (owb-)',
  view: ChangeLogLab,
  cases: [
    { id: 'office', label: 'Office: names, every value kind, a reason; a PC’s table', model: ready(OFFICE_ROWS), note: 'When · who · what · from → to. A life is the StateChip, a department the DeptChip, a picture a small RecordPicture, “Use the design” as words. An action the domain does not name reads “A change”; an icon it does not know draws a plain dot.' },
    { id: 'office-phone', label: 'Office in a phone’s room: the list (the part’s own room, 375 px)', model: ready(OFFICE_ROWS, { narrow: true }) },
    { id: 'portal', label: 'Customer: “The factory”, its own colleague by name, no reason (the server sent none)', model: ready(PORTAL_ROWS) },
    { id: 'floor', label: 'Floor: “You”, “Office”, a department — in a phone’s room', model: ready(FLOOR_ROWS, { narrow: true }) },
    { id: 'more', label: 'More rows: “Load more”', model: ready(OFFICE_ROWS.slice(0, 3), { more: 'idle' }) },
    { id: 'more-failed', label: 'The next page failed: said, “Try again”', model: ready(OFFICE_ROWS.slice(0, 3), { more: 'failed' }) },
    { id: 'empty', label: 'No change yet', model: ready([]) },
    { id: 'reading', label: 'Reading', model: { rows: [], status: 'reading', more: 'none' } },
    { id: 'failed', label: 'The read failed: said, “Try again”', model: { rows: [], status: 'failed', more: 'none' } },
  ],
})
