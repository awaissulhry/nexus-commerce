/**
 * The planning board's rules, pure (gap D18): where a card sits, the load per lane and bucket before and after a move,
 * where a keyboard move goes next, whether a drop is held and why, the undo history, and the words for each step.
 * `PlanningBoard.tsx` draws them; the tests read them here. Data in, events out: nothing here calls anything.
 *
 * Two layouts share every rule:
 * - `time`    lanes are rows, buckets (days, weeks) are columns; a card sits at a lane and a start bucket and may span
 *             several buckets. The tray ("Not on the board") is the last row of the keyboard's lane axis.
 * - `columns` lanes are columns (an allocation board: lines, work centres, workshops); a card sits in a lane, its bucket
 *             is kept as it is. The tray is the first column.
 */

import { fillWords, loadView, type LoadBarWords, type LoadView } from './loadBarModel'

export type PlanningLayout = 'time' | 'columns'

/** Where a card is: a lane and a bucket, or the tray (`laneId: null`). In the columns layout the bucket is kept as is. */
export interface PlanningPlace {
  laneId: string | null
  bucketId: string | null
}

export const TRAY_PLACE: PlanningPlace = Object.freeze({ laneId: null, bucketId: null })

export interface PlanningLane {
  id: string
  /** Plain text: said in every announcement ("Line 2"). */
  label: string
  /** Small facts under the name ("8 people · 85%"). */
  detail?: string
  /** Why this lane takes no drops now — a held drop zone ("Not approved for armour pockets"). */
  held?: string | null
  /** Available standard minutes per bucket id: a number, `null` = no working time set, missing = not known. */
  capacity?: Readonly<Record<string, number | null>>
  /** How the capacity is made, per bucket id ("8 people × 450 min × 85% × 5 days = 15,300 min"). */
  capacityWords?: Readonly<Record<string, string>>
  /** Buckets this lane does not work, with the reason ("Shutdown"). A closed cell takes no drop. */
  closed?: Readonly<Record<string, string>>
}

export interface PlanningBucket {
  id: string
  /** Plain text: said in every announcement ("Tue 12 Nov", "Week 46"). */
  label: string
  /** A second line in the column head ("12–16 Nov"). */
  detail?: string
  today?: boolean
  /** A bucket nobody works (a holiday, a shutdown), with the reason. Takes no drop on any lane. */
  closed?: string | null
}

export type PlanningTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A fact on a card, always in words ("Material 14 Nov", "Sample not approved"). */
export interface PlanningMark {
  label: string
  tone?: PlanningTone
}

export interface PlanningCard {
  id: string
  /** Plain text: said in every announcement ("WO-0221"). */
  label: string
  /** The second line ("Aero jacket · 120 pcs"). */
  detail?: string
  /** Standard minutes the card books (SAM × pieces). */
  minutes: number
  /** `null` = in the tray. */
  laneId: string | null
  bucketId: string | null
  /** Buckets the card covers from its start (time layout); default 1. */
  span?: number
  /** Its minutes per covered bucket; default: shared evenly over the span. */
  load?: readonly number[]
  /** A pinned card cannot move. */
  pinned?: boolean
  /** Late: drawn striped and said in words. */
  late?: boolean
  marks?: readonly PlanningMark[]
  /** A last line ("Moved by Marco at 10:42"). */
  note?: string
}

export type PlanningVia = 'pointer' | 'keyboard' | 'list' | 'undo' | 'redo'

export interface PlanningCellLoad {
  laneId: string
  bucketId: string
  booked: number
  available: number | null | undefined
}

/** The event the board sends: the app saves it (or refuses it) and passes the cards back. */
export interface PlanningMove {
  cardId: string
  from: PlanningPlace
  to: PlanningPlace
  via: PlanningVia
  /** The cells the card lands on, with their load after the move (none for the tray). */
  loadAfter: readonly PlanningCellLoad[]
  /** True when a cell the card lands on goes over its capacity. */
  over: boolean
}

export interface PlanningBoardWords {
  /** The tray's name. */
  tray: string
  trayEmpty: string
  /** Nothing on the board and nothing in the tray. */
  empty: string
  /** The corner over the lane names. */
  lanes: string
  today: string
  closed: string
  pinned: string
  late: string
  saving: string
  minutes: string
  /** A card's place: `{lane}`, `{bucket}`; a span: `{from}`, `{to}`. */
  place: string
  placeSpan: string
  /** The columns layout: a lane alone. */
  placeLane: string
  instructions: string
  undo: string
  redo: string
  undoNothing: string
  redoNothing: string
  /** The card is no longer where the move put it. */
  undoMovedSince: string
  pick: string
  target: string
  targetTray: string
  targetHeld: string
  edge: string
  /** The columns layout has no up and down. */
  edgeColumns: string
  moved: string
  undone: string
  redone: string
  notMoved: string
  refused: string
  cancelled: string
  pinnedHeld: string
  pinnedNow: string
  unpinnedNow: string
  samePlace: string
  closedHeld: string
  overHeld: string
  readOnly: string
  /** The list fallback (phone width). */
  open: string
  openCard: string
  move: string
  moveTitle: string
  moveLane: string
  moveBucket: string
  moveConfirm: string
  moveCancel: string
  /** The cell popover. */
  cellTitle: string
  cellEmpty: string
  cellCard: string
  showOnBoard: string
}

export const PLANNING_BOARD_WORDS: PlanningBoardWords = {
  tray: 'Not on the board',
  trayEmpty: 'Every work order has a slot',
  empty: 'No work orders on this board in this window',
  lanes: 'Lanes',
  today: 'Today',
  closed: 'Closed',
  pinned: 'Pinned',
  late: 'Late',
  saving: 'Saving',
  minutes: '{minutes} min',
  place: '{lane}, {bucket}',
  placeSpan: '{lane}, {from} to {to}',
  placeLane: '{lane}',
  instructions: 'To move a card, focus it and press Space or M. Arrow keys choose a lane and a time, Enter drops, Escape cancels. Enter opens the card, P pins it, Ctrl+Z undoes the last move.',
  undo: 'Undo move',
  redo: 'Redo move',
  undoNothing: 'Nothing to undo',
  redoNothing: 'Nothing to redo',
  undoMovedSince: '{card} has moved since, so this move cannot be undone here',
  pick: 'Moving {card}, {minutes}, from {place}. Arrow keys choose where, Enter drops, Escape cancels.',
  target: '{place}. {load}',
  targetTray: '{place}: back to the cards without a slot.',
  targetHeld: '{place}: held. {reason}',
  edge: 'No further lane or time that way.',
  edgeColumns: 'Use the left and right arrows to choose a column.',
  moved: '{card} moved to {place}.',
  undone: 'Undone: {card} back to {place}.',
  redone: 'Redone: {card} moved to {place}.',
  notMoved: '{card} was not moved. It stays at {place}.',
  refused: '{card} stays at {place}. {reason}',
  cancelled: 'Move cancelled. {card} stays at {place}.',
  pinnedHeld: '{card} is pinned and cannot move. Unpin it first.',
  pinnedNow: '{card} pinned.',
  unpinnedNow: '{card} unpinned.',
  samePlace: 'Choose another place.',
  closedHeld: '{place} is closed: {reason}',
  overHeld: '{place} would go over its capacity.',
  readOnly: 'This board is read-only.',
  open: 'Open',
  openCard: 'Open {card}',
  move: 'Move',
  moveTitle: 'Move {card}',
  moveLane: 'Lane',
  moveBucket: 'When',
  moveConfirm: 'Move here',
  moveCancel: 'Cancel',
  cellTitle: '{lane} · {bucket}',
  cellEmpty: 'Nothing booked here.',
  cellCard: '{card} · {minutes} · {share}',
  showOnBoard: 'Show {card} on the board',
}

export const placeOf = (card: Pick<PlanningCard, 'laneId' | 'bucketId'>): PlanningPlace =>
  card.laneId === null ? TRAY_PLACE : { laneId: card.laneId, bucketId: card.bucketId }

/** Two places are the same spot. In the columns layout only the lane counts. */
export function samePlace(a: PlanningPlace, b: PlanningPlace, layout: PlanningLayout = 'time'): boolean {
  if (a.laneId !== b.laneId) return false
  if (a.laneId === null) return true
  return layout === 'columns' || a.bucketId === b.bucketId
}

/** The key of one lane × bucket cell. */
export const cellKey = (laneId: string, bucketId: string): string => `${laneId}␟${bucketId}`

/** How many buckets a card covers from `start`, inside the window. */
export function spanOf(card: Pick<PlanningCard, 'span'>, start: number, bucketCount: number): number {
  const asked = Number.isFinite(card.span) && (card.span ?? 1) >= 1 ? Math.floor(card.span ?? 1) : 1
  return Math.max(1, Math.min(asked, bucketCount - start))
}

/** A card's minutes per covered bucket (the whole span, inside the window or not). */
export function minutesByBucket(card: Pick<PlanningCard, 'minutes' | 'span' | 'load'>): number[] {
  const span = Number.isFinite(card.span) && (card.span ?? 1) >= 1 ? Math.floor(card.span ?? 1) : 1
  const minutes = Number.isFinite(card.minutes) && card.minutes > 0 ? card.minutes : 0
  if (card.load && card.load.length === span && card.load.every((value) => Number.isFinite(value) && value >= 0)) return [...card.load]
  return Array.from({ length: span }, () => minutes / span)
}

export interface BoardShape {
  lanes: readonly PlanningLane[]
  buckets: readonly PlanningBucket[]
  layout: PlanningLayout
  /** The tray is drawn and takes drops. */
  tray: boolean
}

/** Booked minutes per cell (time layout) — or per lane under `cellKey(lane, '*')` (columns layout: the whole window). */
export function bookedByCell(cards: readonly PlanningCard[], shape: Pick<BoardShape, 'buckets' | 'layout'>): Map<string, number> {
  const out = new Map<string, number>()
  const add = (key: string, value: number) => out.set(key, (out.get(key) ?? 0) + value)
  const index = new Map(shape.buckets.map((bucket, at) => [bucket.id, at]))
  for (const card of cards) {
    if (card.laneId === null) continue
    if (shape.layout === 'columns') {
      add(cellKey(card.laneId, '*'), Number.isFinite(card.minutes) && card.minutes > 0 ? card.minutes : 0)
      continue
    }
    const start = card.bucketId === null ? undefined : index.get(card.bucketId)
    if (start === undefined) continue
    const parts = minutesByBucket(card)
    for (let k = 0; k < parts.length && start + k < shape.buckets.length; k++) add(cellKey(card.laneId, shape.buckets[start + k].id), parts[k])
  }
  return out
}

/** A lane's capacity over the whole window (columns layout): the sum of the known buckets; null / undefined as one. */
export function laneCapacity(lane: PlanningLane, buckets: readonly PlanningBucket[]): number | null | undefined {
  const values = buckets.map((bucket) => lane.capacity?.[bucket.id])
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (known.length > 0) return known.reduce((sum, value) => sum + value, 0)
  return values.some((value) => value === null) ? null : undefined
}

export function capacityOf(lane: PlanningLane, bucketId: string): number | null | undefined {
  const value = lane.capacity?.[bucketId]
  return value === undefined ? undefined : value
}

/** The cards with one of them moved. */
export function withMove(cards: readonly PlanningCard[], cardId: string, to: PlanningPlace, layout: PlanningLayout = 'time'): PlanningCard[] {
  return cards.map((card) => {
    if (card.id !== cardId) return card
    if (to.laneId === null) return { ...card, laneId: null, bucketId: null }
    // The columns layout keeps the bucket (a card from the tray takes the target's, if any).
    const bucketId = layout === 'columns' ? (card.laneId === null ? to.bucketId : card.bucketId) : to.bucketId
    return { ...card, laneId: to.laneId, bucketId }
  })
}

/** The cells a card covers at a place, with their load after it is there. */
export function landingLoads(cardsAfter: readonly PlanningCard[], cardId: string, shape: Pick<BoardShape, 'lanes' | 'buckets' | 'layout'>): PlanningCellLoad[] {
  const card = cardsAfter.find((item) => item.id === cardId)
  if (!card || card.laneId === null) return []
  const lane = shape.lanes.find((item) => item.id === card.laneId)
  if (!lane) return []
  const booked = bookedByCell(cardsAfter, shape)
  if (shape.layout === 'columns') {
    return [{ laneId: lane.id, bucketId: '*', booked: booked.get(cellKey(lane.id, '*')) ?? 0, available: laneCapacity(lane, shape.buckets) }]
  }
  const start = shape.buckets.findIndex((bucket) => bucket.id === card.bucketId)
  if (start < 0) return []
  const span = spanOf(card, start, shape.buckets.length)
  return shape.buckets.slice(start, start + span).map((bucket) => ({
    laneId: lane.id,
    bucketId: bucket.id,
    booked: booked.get(cellKey(lane.id, bucket.id)) ?? 0,
    available: capacityOf(lane, bucket.id),
  }))
}

export const isOver = (cell: Pick<PlanningCellLoad, 'booked' | 'available'>): boolean =>
  typeof cell.available === 'number' && Number.isFinite(cell.available) && cell.booked > cell.available

/* ─────────────────────────── words ─────────────────────────── */

export interface Formatter {
  minutes: (minutes: number) => string
}

/** "Line 2, Tue 12 Nov", "Line 2, Tue 12 Nov to Wed 13 Nov", "Not on the board"; the columns layout names the lane. */
export function placeWords(place: PlanningPlace, shape: Pick<BoardShape, 'lanes' | 'buckets' | 'layout'>, words: PlanningBoardWords, span = 1): string {
  if (place.laneId === null) return words.tray
  const lane = shape.lanes.find((item) => item.id === place.laneId)
  const laneLabel = lane?.label ?? place.laneId
  if (shape.layout === 'columns') return fillWords(words.placeLane, { lane: laneLabel })
  const start = shape.buckets.findIndex((bucket) => bucket.id === place.bucketId)
  if (start < 0) return fillWords(words.placeLane, { lane: laneLabel })
  const end = Math.min(shape.buckets.length - 1, start + Math.max(1, span) - 1)
  if (end > start) return fillWords(words.placeSpan, { lane: laneLabel, from: shape.buckets[start].label, to: shape.buckets[end].label })
  return fillWords(words.place, { lane: laneLabel, bucket: shape.buckets[start].label })
}

/** The span a card has at a place (1 in the tray and in the columns layout). */
export function spanAt(card: PlanningCard, place: PlanningPlace, shape: Pick<BoardShape, 'buckets' | 'layout'>): number {
  if (place.laneId === null || shape.layout === 'columns') return 1
  const start = shape.buckets.findIndex((bucket) => bucket.id === place.bucketId)
  return start < 0 ? 1 : spanOf(card, start, shape.buckets.length)
}

/** The card's accessible name: every fact the card shows, in words. */
export function cardName(card: PlanningCard, shape: Pick<BoardShape, 'lanes' | 'buckets' | 'layout'>, words: PlanningBoardWords, format: Formatter): string {
  const place = placeOf(card)
  return [
    card.label,
    card.detail,
    fillWords(words.minutes, { minutes: format.minutes(Number.isFinite(card.minutes) ? card.minutes : 0) }),
    placeWords(place, shape, words, spanAt(card, place, shape)),
    card.pinned ? words.pinned : '',
    card.late ? words.late : '',
    ...(card.marks ?? []).map((mark) => mark.label),
    card.note,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ')
}

/** The load words of the cells a card lands on (one sentence, the worst cell first). */
export function landingWords(cells: readonly PlanningCellLoad[], shape: Pick<BoardShape, 'lanes' | 'buckets'>, loadWords: LoadBarWords, format: Formatter): string {
  const views = cells.map((cell) => {
    const lane = shape.lanes.find((item) => item.id === cell.laneId)
    const bucket = shape.buckets.find((item) => item.id === cell.bucketId)
    const label = bucket ? `${lane?.label ?? cell.laneId}, ${bucket.label}` : lane?.label ?? cell.laneId
    return loadView({ booked: cell.booked, available: cell.available }, loadWords, format.minutes, label)
  })
  const rank = (view: LoadView) => (view.state === 'over' ? 0 : view.state === 'full' ? 1 : 2)
  return [...views].sort((a, b) => rank(a) - rank(b)).map((view) => view.sentence).join(' ')
}

/* ─────────────────────────── drop check ─────────────────────────── */

export interface DropInput {
  card: PlanningCard
  to: PlanningPlace
  shape: BoardShape
  cards: readonly PlanningCard[]
  words: PlanningBoardWords
  /** Why nothing on the board can move now (read-only, offline). */
  heldReason?: string | null
  /** Refuse a drop that takes a cell over its capacity (else the app is told, `move.over`). */
  overload?: 'allow' | 'block'
  /** The app's own check of this card at this place (material, gate, an approved workshop). */
  appHeld?: string | null
}

/** Why this drop cannot be made, in words — or null when it can. */
export function dropHeldReason({ card, to, shape, cards, words, heldReason, overload = 'allow', appHeld }: DropInput): string | null {
  if (heldReason) return heldReason
  if (card.pinned) return fillWords(words.pinnedHeld, { card: card.label })
  if (samePlace(placeOf(card), to, shape.layout)) return words.samePlace
  if (to.laneId === null) return shape.tray ? appHeld || null : words.samePlace
  const lane = shape.lanes.find((item) => item.id === to.laneId)
  if (!lane) return words.samePlace
  const place = placeWords(to, shape, words, spanAt(card, to, shape))
  if (lane.held) return lane.held
  if (shape.layout === 'time') {
    const start = shape.buckets.findIndex((bucket) => bucket.id === to.bucketId)
    if (start < 0) return words.samePlace
    const span = spanOf(card, start, shape.buckets.length)
    for (const bucket of shape.buckets.slice(start, start + span)) {
      const reason = bucket.closed || lane.closed?.[bucket.id]
      if (reason) return fillWords(words.closedHeld, { place: fillWords(words.place, { lane: lane.label, bucket: bucket.label }), reason })
    }
  }
  if (appHeld) return appHeld
  if (overload === 'block' && landingLoads(withMove(cards, card.id, to, shape.layout), card.id, shape).some(isOver)) {
    return fillWords(words.overHeld, { place })
  }
  return null
}

/* ─────────────────────────── keyboard moves ─────────────────────────── */

export type MoveKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const isMoveKey = (key: string): key is MoveKey =>
  key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'

/** The lane axis of a keyboard move: lanes, with the tray last (time) or first (columns). `null` is the tray. */
export function laneAxis(shape: BoardShape): (string | null)[] {
  const lanes = shape.lanes.map((lane) => lane.id)
  if (!shape.tray) return lanes
  return shape.layout === 'columns' ? [null, ...lanes] : [...lanes, null]
}

export type MoveStep = { target: PlanningPlace; edge: false } | { target: PlanningPlace; edge: true; why: 'edge' | 'columns' }

/**
 * Where a keyboard move goes on one key. Time: ← → one bucket, Home / End the first / last bucket, ↑ ↓ one lane (the tray
 * after the last lane). Columns: ← → one column (the tray first), ↑ ↓ say to use ← →. Leaving the tray, the move goes
 * back to the bucket it had (`lastBucketId`), else the first bucket.
 */
export function moveStep(target: PlanningPlace, key: MoveKey, shape: BoardShape, lastBucketId: string | null = null): MoveStep {
  const axis = laneAxis(shape)
  const at = axis.indexOf(target.laneId)
  const stay = (why: 'edge' | 'columns' = 'edge'): MoveStep => ({ target, edge: true, why })
  const bucketFor = (laneId: string | null): string | null => {
    if (laneId === null) return null
    if (target.bucketId !== null) return target.bucketId
    return lastBucketId ?? shape.buckets[0]?.id ?? null
  }
  const toLane = (next: number): MoveStep => {
    if (next < 0 || next >= axis.length) return stay()
    const laneId = axis[next]
    if (laneId === null) return { target: TRAY_PLACE, edge: false }
    return { target: { laneId, bucketId: shape.layout === 'columns' ? target.bucketId : bucketFor(laneId) }, edge: false }
  }
  if (shape.layout === 'columns') {
    if (key === 'ArrowLeft') return toLane(at - 1)
    if (key === 'ArrowRight') return toLane(at + 1)
    if (key === 'Home') return at === 0 ? stay() : toLane(0)
    if (key === 'End') return at === axis.length - 1 ? stay() : toLane(axis.length - 1)
    return stay('columns')
  }
  if (key === 'ArrowUp') return toLane(at - 1)
  if (key === 'ArrowDown') return toLane(at + 1)
  if (target.laneId === null) return stay()
  const index = shape.buckets.findIndex((bucket) => bucket.id === target.bucketId)
  const last = shape.buckets.length - 1
  const next = key === 'ArrowLeft' ? index - 1 : key === 'ArrowRight' ? index + 1 : key === 'Home' ? 0 : last
  if (next < 0 || next > last || next === index) return stay()
  return { target: { laneId: target.laneId, bucketId: shape.buckets[next].id }, edge: false }
}

/**
 * Where a keyboard move starts: the card's own place — except a card in the tray on the time layout (the tray is the
 * last row there), which starts on the first lane that takes drops, today. On the columns layout the tray is the first
 * column, so → goes to the first lane.
 */
export function moveStart(card: PlanningCard, shape: BoardShape): PlanningPlace {
  if (card.laneId !== null || shape.layout === 'columns') return placeOf(card)
  const lane = shape.lanes.find((item) => !item.held) ?? shape.lanes[0]
  if (!lane) return TRAY_PLACE
  const today = shape.buckets.find((bucket) => bucket.today && !bucket.closed)
  const open = shape.buckets.find((bucket) => !bucket.closed && !lane.closed?.[bucket.id])
  return { laneId: lane.id, bucketId: (today ?? open ?? shape.buckets[0])?.id ?? null }
}

/* ─────────────────────────── focus between cards ─────────────────────────── */

interface Spot { id: string; row: number; col: number; order: number }

/** Each drawn card's row and column on the keyboard's grid (time: lanes then tray; columns: tray then lanes, swapped). */
export function cardSpots(cards: readonly PlanningCard[], shape: BoardShape): Spot[] {
  const axis = laneAxis(shape)
  const bucketIndex = new Map(shape.buckets.map((bucket, at) => [bucket.id, at]))
  const spots: Spot[] = []
  const trayOrder = new Map<string | null, number>()
  cards.forEach((card, order) => {
    const lane = axis.indexOf(card.laneId)
    if (lane < 0) return
    if (card.laneId === null || shape.layout === 'columns') {
      const n = trayOrder.get(card.laneId) ?? 0
      trayOrder.set(card.laneId, n + 1)
      spots.push({ id: card.id, row: lane, col: n, order })
      return
    }
    const col = card.bucketId === null ? undefined : bucketIndex.get(card.bucketId)
    if (col === undefined) return
    spots.push({ id: card.id, row: lane, col, order })
  })
  return spots
}

/**
 * The card the focus goes to on an arrow key when nothing is moving. Time: ← → the previous / next card in the lane,
 * ↑ ↓ the nearest card in the next lane that has one (the tray last). Columns: ↑ ↓ within a column, ← → the nearest
 * card in the next column that has one. Home / End: the first / last card of the lane or column.
 */
export function nextFocus(currentId: string, key: MoveKey, cards: readonly PlanningCard[], shape: BoardShape): string | null {
  const spots = cardSpots(cards, shape)
  const here = spots.find((spot) => spot.id === currentId)
  if (!here) return spots[0]?.id ?? null
  const byPlace = (a: Spot, b: Spot) => a.col - b.col || a.order - b.order
  const same = spots.filter((spot) => spot.row === here.row).sort(byPlace)
  const at = same.findIndex((spot) => spot.id === here.id)
  const along = shape.layout === 'columns' ? { back: 'ArrowUp', forward: 'ArrowDown' } : { back: 'ArrowLeft', forward: 'ArrowRight' }
  if (key === along.back) return same[at - 1]?.id ?? null
  if (key === along.forward) return same[at + 1]?.id ?? null
  if (key === 'Home') return at > 0 ? same[0].id : null
  if (key === 'End') return at < same.length - 1 ? same[same.length - 1].id : null
  const step = key === (shape.layout === 'columns' ? 'ArrowLeft' : 'ArrowUp') ? -1 : 1
  const rows = [...new Set(spots.map((spot) => spot.row))].sort((a, b) => a - b)
  const nextRow = step < 0 ? [...rows].reverse().find((row) => row < here.row) : rows.find((row) => row > here.row)
  if (nextRow === undefined) return null
  const there = spots.filter((spot) => spot.row === nextRow).sort((a, b) => Math.abs(a.col - here.col) - Math.abs(b.col - here.col) || byPlace(a, b))
  return there[0]?.id ?? null
}

/* ─────────────────────────── rows inside a lane ─────────────────────────── */

/** Tracks inside a lane: each item gets the first track where it does not overlap (start, span in buckets). */
export function packTracks(items: readonly { id: string; start: number; span: number }[]): Map<string, number> {
  const ends: number[] = []
  const out = new Map<string, number>()
  for (const item of [...items].sort((a, b) => a.start - b.start || b.span - a.span)) {
    let track = ends.findIndex((end) => end <= item.start)
    if (track < 0) {
      track = ends.length
      ends.push(0)
    }
    ends[track] = item.start + item.span
    out.set(item.id, track)
  }
  return out
}

/* ─────────────────────────── undo ─────────────────────────── */

export interface HistoryEntry {
  cardId: string
  from: PlanningPlace
  to: PlanningPlace
}

export interface PlanningHistory {
  done: readonly HistoryEntry[]
  undone: readonly HistoryEntry[]
}

export const EMPTY_HISTORY: PlanningHistory = Object.freeze({ done: [], undone: [] })

/** A move made by hand (not an undo or redo) goes on the history and clears the redo side. */
export function recordMove(history: PlanningHistory, entry: HistoryEntry, via: PlanningVia): PlanningHistory {
  if (via === 'undo') return { done: history.done.slice(0, -1), undone: [...history.undone, entry] }
  if (via === 'redo') return { done: [...history.done, entry], undone: history.undone.slice(0, -1) }
  return { done: [...history.done, entry].slice(-50), undone: [] }
}

export type UndoCheck = { entry: HistoryEntry; move: { cardId: string; from: PlanningPlace; to: PlanningPlace }; reason: null } | { entry: HistoryEntry | null; move: null; reason: string }

/**
 * The undo (or redo) that can run now: only while the card is still where that move put it (another planner may have
 * moved it since) and is not pinned.
 */
export function historyStep(history: PlanningHistory, kind: 'undo' | 'redo', cards: readonly PlanningCard[], layout: PlanningLayout, words: PlanningBoardWords, heldReason?: string | null): UndoCheck {
  const list = kind === 'undo' ? history.done : history.undone
  const entry = list[list.length - 1] ?? null
  if (!entry) return { entry: null, move: null, reason: kind === 'undo' ? words.undoNothing : words.redoNothing }
  if (heldReason) return { entry, move: null, reason: heldReason }
  const card = cards.find((item) => item.id === entry.cardId)
  const label = card?.label ?? entry.cardId
  const expected = kind === 'undo' ? entry.to : entry.from
  if (!card || !samePlace(placeOf(card), expected, layout)) return { entry, move: null, reason: fillWords(words.undoMovedSince, { card: label }) }
  if (card.pinned) return { entry, move: null, reason: fillWords(words.pinnedHeld, { card: label }) }
  const move = kind === 'undo' ? { cardId: card.id, from: entry.to, to: entry.from } : { cardId: card.id, from: entry.from, to: entry.to }
  return { entry, move, reason: null }
}
