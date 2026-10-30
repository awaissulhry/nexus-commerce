import { defineDesignScreen } from '../../../lib/design/design-screen'
import { PlanningBoardLabView, type LabBucket, type LabCard, type LabLane, type PlanningBoardLabModel } from './view/PlanningBoardLabView'

/**
 * SCR-243 — the planning board and the load bar (DS parts D18 + LoadBar, B-W2a-14; NEW id: the DS part has no screen of
 * its own; the Planning board SCR-122 and Lines & subcontractors SCR-126 use it, B-W2a-45). Made-up lines, work orders
 * and minutes (SAM × pieces); the week of 8 December has the Immacolata closed, as the Italian calendar does. In the
 * browser the moves work for real (kept in the view only): drag, the keyboard (Space or M, arrows, Enter, Esc), the
 * list's Move dialog, Undo / Redo. Each case is one state of the design: a week, over capacity, a keyboard move under
 * way, refusals with their reason, the allocation layout, the phone list, empty, loading, a failed read, read-only,
 * offline, and the load bar's states.
 */

const lanes: LabLane[] = [
  {
    id: 'line-1',
    name: { it: 'Linea 1', en: 'Line 1' },
    kind: { it: 'Linea', en: 'Line' },
    people: 8,
    minutesPerDay: 450,
    efficiency: 80,
    capacity: { mon7: 2880, tue8: 0, wed9: 2880, thu10: 2880, fri11: 2880, mon14: 2880 },
  },
  {
    id: 'line-2',
    name: { it: 'Linea 2', en: 'Line 2' },
    kind: { it: 'Linea', en: 'Line' },
    people: 6,
    minutesPerDay: 450,
    efficiency: 85,
    capacity: { mon7: 2295, tue8: 0, wed9: 2295, thu10: 2295, fri11: 2295, mon14: 2295 },
  },
  {
    id: 'cutting',
    name: { it: 'Taglio', en: 'Cutting' },
    kind: { it: 'Centro di lavoro', en: 'Work centre' },
    people: 3,
    minutesPerDay: 450,
    efficiency: 90,
    capacity: { mon7: 1215, tue8: 0, wed9: 1215, thu10: 1215, fri11: 1215, mon14: null },
  },
  {
    id: 'beta',
    name: { it: 'Laboratorio Beta', en: 'Workshop Beta' },
    kind: { it: 'Terzista', en: 'Subcontractor' },
    held: { it: 'Non approvato per le tasche porta-protezioni', en: 'Not approved for armour pockets' },
  },
]

const IMMACOLATA = { it: 'Immacolata Concezione', en: 'Feast of the Immaculate Conception' }
const buckets: LabBucket[] = [
  { id: 'mon7', date: '2026-12-07', today: true },
  { id: 'tue8', date: '2026-12-08', closed: IMMACOLATA },
  { id: 'wed9', date: '2026-12-09' },
  { id: 'thu10', date: '2026-12-10' },
  { id: 'fri11', date: '2026-12-11' },
  { id: 'mon14', date: '2026-12-14' },
]

const cards: LabCard[] = [
  { id: 'wo-201', number: 'WO-0201', style: { it: 'Giacca Aria', en: 'Aria jacket' }, pieces: 40, minutes: 1680, laneId: 'line-1', bucketId: 'mon7' },
  { id: 'wo-202', number: 'WO-0202', style: { it: 'Giacca Strada', en: 'Strada jacket' }, pieces: 120, minutes: 5040, laneId: 'line-1', bucketId: 'wed9', span: 2, load: [2880, 2160] },
  { id: 'wo-203', number: 'WO-0203', style: { it: 'Pantalone Pioggia', en: 'Pioggia trousers' }, pieces: 60, minutes: 1800, laneId: 'line-2', bucketId: 'mon7', late: true },
  {
    id: 'wo-204',
    number: 'WO-0204',
    style: { it: 'Guanto Corsa', en: 'Corsa glove' },
    pieces: 50,
    minutes: 1200,
    laneId: 'line-2',
    bucketId: 'wed9',
    pinned: true,
    marks: [{ text: { it: 'Campione approvato', en: 'Sample approved' }, tone: 'success' }],
  },
  { id: 'wo-205', number: 'WO-0205', style: { it: 'Taglio Giacca Aria', en: 'Cut Aria jacket' }, pieces: 40, minutes: 900, laneId: 'cutting', bucketId: 'mon7' },
  { id: 'wo-206', number: 'WO-0206', style: { it: 'Taglio Giacca Strada', en: 'Cut Strada jacket' }, pieces: 120, minutes: 1080, laneId: 'cutting', bucketId: 'wed9' },
  {
    id: 'wo-207',
    number: 'WO-0207',
    style: { it: 'Giacca Tempesta', en: 'Tempesta jacket' },
    pieces: 24,
    minutes: 1320,
    laneId: null,
    bucketId: null,
    marks: [{ text: { it: 'Pelle in arrivo il 10 dic', en: 'Leather arrives 10 Dec' }, tone: 'warning' }],
  },
  {
    id: 'wo-208',
    number: 'WO-0208',
    style: { it: 'Gilet Vento', en: 'Vento vest' },
    pieces: 80,
    minutes: 960,
    laneId: null,
    bucketId: null,
    marks: [{ text: { it: 'Oltre l’ultimo inizio sicuro', en: 'Past its latest safe start' }, tone: 'danger' }],
  },
]

/** Line 2 over on Wednesday: 1,200 + 1,500 = 2,700 of 2,295 min. */
const overCards: LabCard[] = [
  ...cards,
  { id: 'wo-209', number: 'WO-0209', style: { it: 'Giacca Aria', en: 'Aria jacket' }, pieces: 50, minutes: 1500, laneId: 'line-2', bucketId: 'wed9', note: { it: 'Spostato da Marco alle 10:42', en: 'Moved by Marco at 10:42' } },
]

const base = (patch: Partial<PlanningBoardLabModel> = {}): PlanningBoardLabModel => ({ layout: 'time', lanes, buckets, cards, load: 'ready', ...patch })

export const designScreen = defineDesignScreen<PlanningBoardLabModel>({
  screen: 'SCR-243',
  title: 'Planning board and load bar (DS parts D18, LoadBar)',
  view: PlanningBoardLabView,
  cases: [
    {
      id: 'week',
      label: 'Lanes × days',
      model: base(),
      note: 'Lines, a work centre and a subcontractor (held: not approved) over six working days; today marked, the Immacolata closed, a lane with no calendar on the last day, a work order over two days, late, pinned, with a mark; two work orders not on the board. Drag, or Tab to a card and press Space.',
    },
    {
      id: 'over',
      label: 'Over capacity',
      model: base({ cards: overCards }),
      note: 'Line 2 on Wednesday is booked past its capacity: the cell says "+405 min over" and hatches the part past the line, not only red. A last line on a card says who moved it.',
    },
    {
      id: 'moving',
      label: 'Keyboard move under way',
      model: base({ defaultMove: { cardId: 'wo-201', to: { laneId: 'line-2', bucketId: 'wed9' } } }),
      note: 'WO-0201 picked up and taken to Line 2, Wednesday: the ghost shows where it lands and the cell shows the load after the drop (over). Focus the card: arrows go on, Enter drops, Esc cancels.',
    },
    {
      id: 'held',
      label: 'Refused with the reason',
      model: base({ overload: 'block', materialHeld: { cardId: 'wo-207', from: 'thu10', text: { it: 'La pelle arriva il 10 dic: inizio possibile da giovedì 10', en: 'Leather arrives on 10 Dec: the earliest start is Thursday 10' } } }),
      note: 'This site blocks a drop over capacity; WO-0207 cannot start before its leather arrives; WO-0204 is pinned; Workshop Beta is not approved; the Immacolata is closed. Each refusal says why, on the ghost and in words.',
    },
    {
      id: 'allocation',
      label: 'Allocation (lanes as columns)',
      model: base({ layout: 'columns' }),
      note: 'The same part as the allocation board (Lines & subcontractors, SCR-126): the cards not on the board first, then one column per lane with its load over the window. Arrows left and right move a card between columns.',
    },
    {
      id: 'list',
      label: 'Phone: the list',
      model: base({ layout: 'list' }),
      note: 'Below 640 px of its own width the board becomes this list (also at Phone 390): each lane and day with its load, each work order with Move — a dialog with the lane, the day and the load after the move.',
    },
    { id: 'empty', label: 'Empty', model: base({ cards: [] }), note: 'No work orders on the site in this window; the tray says every work order has a slot. The load is still drawn.' },
    { id: 'loading', label: 'Loading', model: base({ load: 'loading' }), note: 'Lane names and days first, skeleton cells and cards after.' },
    { id: 'error', label: 'Read failed', model: base({ load: 'error' }), note: 'A failed read is never drawn as an empty board: the reason in words and Try again.' },
    { id: 'read-only', label: 'No permission (read-only)', model: base({ held: 'readOnly' }), note: 'A production manager without the planner permission: the board is drawn, the reason is said at rest and on the first drag or Space; cards still open.' },
    { id: 'offline', label: 'Offline', model: base({ held: 'offline' }), note: 'Moves are held until the connection is back; said at rest and on every attempt.' },
    { id: 'load-bars', label: 'The load bar’s states', model: base({ loadBars: true, cards: overCards }), note: 'The LoadBar alone: under, full, over (in words), during a move, no calendar, a closed day, not known yet ("—", never 0).' },
  ],
})
