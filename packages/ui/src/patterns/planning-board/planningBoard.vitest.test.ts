import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PlanningBoard } from './PlanningBoard'
import { minutesFormatter } from './loadBarModel'
import {
  EMPTY_HISTORY,
  PLANNING_BOARD_WORDS as W,
  TRAY_PLACE,
  bookedByCell,
  cardName,
  cellKey,
  dropHeldReason,
  historyStep,
  landingLoads,
  laneCapacity,
  minutesByBucket,
  moveStart,
  moveStep,
  nextFocus,
  packTracks,
  placeWords,
  recordMove,
  samePlace,
  withMove,
  type BoardShape,
  type PlanningBucket,
  type PlanningCard,
  type PlanningLane,
} from './planningBoardModel'

const buckets: PlanningBucket[] = [
  { id: 'd1', label: 'Mon' },
  { id: 'd2', label: 'Tue', today: true },
  { id: 'd3', label: 'Wed' },
  { id: 'd4', label: 'Thu', closed: 'Holiday' },
]
const lanes: PlanningLane[] = [
  { id: 'L1', label: 'Line 1', capacity: { d1: 2880, d2: 2880, d3: 2880, d4: 0 }, closed: { d3: 'Maintenance' } },
  { id: 'L2', label: 'Line 2', capacity: { d1: 2880, d2: 2880, d3: null } },
  { id: 'WB', label: 'Workshop Beta', held: 'Not approved for armour pockets' },
]
const cards: PlanningCard[] = [
  { id: 'A', label: 'WO-0221', detail: 'Aero jacket · 40 pcs', minutes: 1200, laneId: 'L1', bucketId: 'd1' },
  { id: 'B', label: 'WO-0222', minutes: 3000, laneId: 'L1', bucketId: 'd1', span: 2 },
  { id: 'C', label: 'WO-0223', minutes: 2340, laneId: 'L2', bucketId: 'd2', late: true, marks: [{ label: 'Material 14 Nov', tone: 'warning' }] },
  { id: 'P', label: 'WO-0224', minutes: 600, laneId: 'L2', bucketId: 'd1', pinned: true },
  { id: 'T', label: 'WO-0230', minutes: 504, laneId: null, bucketId: null },
]
const time: BoardShape = { lanes, buckets, layout: 'time', tray: true }
const columns: BoardShape = { lanes, buckets, layout: 'columns', tray: true }
const format = { minutes: minutesFormatter('en-GB') }
const card = (id: string) => cards.find((item) => item.id === id)!

describe('load per lane and bucket (D18)', () => {
  it('sums each card over the buckets it covers, evenly unless its load is given', () => {
    const booked = bookedByCell(cards, time)
    expect(booked.get(cellKey('L1', 'd1'))).toBe(2700)
    expect(booked.get(cellKey('L1', 'd2'))).toBe(1500)
    expect(booked.get(cellKey('L2', 'd2'))).toBe(2340)
    expect(booked.get(cellKey('L2', 'd1'))).toBe(600)
    expect(minutesByBucket({ minutes: 3000, span: 2, load: [1000, 2000] })).toEqual([1000, 2000])
    expect(minutesByBucket({ minutes: 3000, span: 2, load: [1000] })).toEqual([1500, 1500])
  })

  it('the columns layout counts a lane over the whole window, capacity summed over known buckets', () => {
    const booked = bookedByCell(cards, columns)
    expect(booked.get(cellKey('L1', '*'))).toBe(4200)
    expect(laneCapacity(lanes[0], buckets)).toBe(8640)
    expect(laneCapacity(lanes[1], buckets)).toBe(5760)
    expect(laneCapacity({ id: 'x', label: 'x', capacity: { d1: null } }, buckets)).toBeNull()
    expect(laneCapacity(lanes[2], buckets)).toBeUndefined()
  })

  it('the load after a move: the card leaves its cells and lands on new ones', () => {
    const after = withMove(cards, 'A', { laneId: 'L2', bucketId: 'd2' })
    const landing = landingLoads(after, 'A', time)
    expect(landing).toEqual([{ laneId: 'L2', bucketId: 'd2', booked: 3540, available: 2880 }])
    expect(bookedByCell(after, time).get(cellKey('L1', 'd1'))).toBe(1500)
    expect(landingLoads(withMove(cards, 'B', { laneId: 'L2', bucketId: 'd1' }), 'B', time).map((cell) => cell.booked)).toEqual([2100, 3840])
    expect(landingLoads(withMove(cards, 'A', TRAY_PLACE), 'A', time)).toEqual([])
  })
})

describe('drop checks, in words (D18)', () => {
  const held = (id: string, to: { laneId: string | null; bucketId: string | null }, extra: Partial<Parameters<typeof dropHeldReason>[0]> = {}) =>
    dropHeldReason({ card: card(id), to, shape: time, cards, words: W, ...extra })

  it('a pinned card does not move; the same place is not a move', () => {
    expect(held('P', { laneId: 'L1', bucketId: 'd2' })).toBe('WO-0224 is pinned and cannot move. Unpin it first.')
    expect(held('A', { laneId: 'L1', bucketId: 'd1' })).toBe('Choose another place.')
  })

  it('a held lane and a closed cell refuse with their reason (a span checks every bucket it covers)', () => {
    expect(held('A', { laneId: 'WB', bucketId: 'd1' })).toBe('Not approved for armour pockets')
    expect(held('A', { laneId: 'L2', bucketId: 'd4' })).toBe('Line 2, Thu is closed: Holiday')
    expect(held('B', { laneId: 'L1', bucketId: 'd2' })).toBe('Line 1, Wed is closed: Maintenance')
  })

  it('read-only first, then the app\'s own check; over capacity only when the board blocks it', () => {
    expect(held('P', { laneId: 'L1', bucketId: 'd2' }, { heldReason: 'Offline — moves wait to be sent' })).toBe('Offline — moves wait to be sent')
    expect(held('A', { laneId: 'L2', bucketId: 'd2' }, { appHeld: 'Leather arrives 14 Nov' })).toBe('Leather arrives 14 Nov')
    expect(held('A', { laneId: 'L2', bucketId: 'd2' })).toBeNull()
    expect(held('A', { laneId: 'L2', bucketId: 'd2' }, { overload: 'block' })).toBe('Line 2, Tue would go over its capacity.')
    expect(held('A', TRAY_PLACE)).toBeNull()
  })
})

describe('keyboard moves (D18)', () => {
  it('time: ← → a bucket, ↑ ↓ a lane, the tray after the last lane, Home / End, edges said', () => {
    const from = { laneId: 'L1', bucketId: 'd1' }
    expect(moveStep(from, 'ArrowRight', time)).toEqual({ target: { laneId: 'L1', bucketId: 'd2' }, edge: false })
    expect(moveStep(from, 'ArrowLeft', time)).toMatchObject({ edge: true, why: 'edge' })
    expect(moveStep(from, 'ArrowUp', time)).toMatchObject({ edge: true })
    expect(moveStep(from, 'ArrowDown', time)).toEqual({ target: { laneId: 'L2', bucketId: 'd1' }, edge: false })
    expect(moveStep(from, 'End', time)).toEqual({ target: { laneId: 'L1', bucketId: 'd4' }, edge: false })
    expect(moveStep({ laneId: 'WB', bucketId: 'd3' }, 'ArrowDown', time)).toEqual({ target: TRAY_PLACE, edge: false })
    expect(moveStep(TRAY_PLACE, 'ArrowDown', time)).toMatchObject({ edge: true })
    expect(moveStep(TRAY_PLACE, 'ArrowLeft', time)).toMatchObject({ edge: true })
    expect(moveStep(TRAY_PLACE, 'ArrowUp', time, 'd3')).toEqual({ target: { laneId: 'WB', bucketId: 'd3' }, edge: false })
    expect(moveStep({ laneId: 'L1', bucketId: 'd1' }, 'ArrowDown', { ...time, tray: false })).toEqual({ target: { laneId: 'L2', bucketId: 'd1' }, edge: false })
  })

  it('columns: ← → a column with the tray first; ↑ ↓ say to use ← →', () => {
    expect(moveStep(TRAY_PLACE, 'ArrowRight', columns)).toEqual({ target: { laneId: 'L1', bucketId: null }, edge: false })
    expect(moveStep({ laneId: 'L1', bucketId: 'd1' }, 'ArrowLeft', columns)).toEqual({ target: TRAY_PLACE, edge: false })
    expect(moveStep({ laneId: 'L1', bucketId: 'd1' }, 'ArrowUp', columns)).toMatchObject({ edge: true, why: 'columns' })
    expect(moveStep({ laneId: 'WB', bucketId: null }, 'ArrowRight', columns)).toMatchObject({ edge: true, why: 'edge' })
  })

  it('a card from the tray starts on the first lane that takes drops, today', () => {
    expect(moveStart(card('T'), time)).toEqual({ laneId: 'L1', bucketId: 'd2' })
    expect(moveStart(card('A'), time)).toEqual({ laneId: 'L1', bucketId: 'd1' })
    expect(moveStart(card('T'), columns)).toEqual(TRAY_PLACE)
  })

  it('focus between cards: along the lane, to the nearest card of the next lane, the tray last', () => {
    expect(nextFocus('A', 'ArrowRight', cards, time)).toBe('B')
    expect(nextFocus('A', 'ArrowLeft', cards, time)).toBeNull()
    expect(nextFocus('A', 'ArrowDown', cards, time)).toBe('P')
    expect(nextFocus('C', 'ArrowDown', cards, time)).toBe('T')
    expect(nextFocus('T', 'ArrowUp', cards, time)).toBe('P')
    expect(nextFocus('P', 'End', cards, time)).toBe('C')
    expect(nextFocus('T', 'ArrowRight', cards, columns)).toBe('A')
    expect(nextFocus('A', 'ArrowDown', cards, columns)).toBe('B')
  })
})

describe('tracks, places, names (D18)', () => {
  it('packs cards inside a lane into the fewest tracks', () => {
    const tracks = packTracks([{ id: 'a', start: 0, span: 1 }, { id: 'b', start: 0, span: 2 }, { id: 'c', start: 1, span: 1 }, { id: 'd', start: 2, span: 1 }])
    expect(Object.fromEntries(tracks)).toEqual({ b: 0, a: 1, c: 1, d: 0 })
  })

  it('names a place, a span, the tray and a column', () => {
    expect(placeWords({ laneId: 'L1', bucketId: 'd1' }, time, W, 2)).toBe('Line 1, Mon to Tue')
    expect(placeWords({ laneId: 'L2', bucketId: 'd2' }, time, W)).toBe('Line 2, Tue')
    expect(placeWords(TRAY_PLACE, time, W)).toBe('Not on the board')
    expect(placeWords({ laneId: 'L2', bucketId: 'd2' }, columns, W)).toBe('Line 2')
    expect(samePlace({ laneId: 'L1', bucketId: 'd1' }, { laneId: 'L1', bucketId: 'd2' }, 'columns')).toBe(true)
  })

  it('a card is named with every fact it shows', () => {
    expect(cardName(card('C'), time, W, format)).toBe('WO-0223, 2,340 min, Line 2, Tue, Late, Material 14 Nov')
    expect(cardName(card('B'), time, W, format)).toBe('WO-0222, 3,000 min, Line 1, Mon to Tue')
    expect(cardName(card('P'), time, W, format)).toBe('WO-0224, 600 min, Line 2, Mon, Pinned')
  })
})

describe('undo while the card is where the move put it (D18)', () => {
  it('undo, then redo; a new move clears redo', () => {
    const entry = { cardId: 'A', from: { laneId: 'L1', bucketId: 'd1' }, to: { laneId: 'L2', bucketId: 'd2' } }
    const moved = withMove(cards, 'A', entry.to)
    let history = recordMove(EMPTY_HISTORY, entry, 'keyboard')
    const undo = historyStep(history, 'undo', moved, 'time', W)
    expect(undo.move).toEqual({ cardId: 'A', from: entry.to, to: entry.from })
    history = recordMove(history, entry, 'undo')
    expect(history).toEqual({ done: [], undone: [entry] })
    expect(historyStep(history, 'undo', cards, 'time', W).reason).toBe('Nothing to undo')
    expect(historyStep(history, 'redo', cards, 'time', W).move).toEqual({ cardId: 'A', from: entry.from, to: entry.to })
    history = recordMove(history, entry, 'redo')
    expect(history).toEqual({ done: [entry], undone: [] })
    expect(recordMove({ done: [], undone: [entry] }, entry, 'pointer').undone).toEqual([])
  })

  it('held when the card has moved since, is pinned now, or the board is read-only', () => {
    const entry = { cardId: 'A', from: { laneId: 'L1', bucketId: 'd1' }, to: { laneId: 'L2', bucketId: 'd2' } }
    const history = recordMove(EMPTY_HISTORY, entry, 'pointer')
    expect(historyStep(history, 'undo', cards, 'time', W).reason).toBe('WO-0221 has moved since, so this move cannot be undone here')
    const pinned = withMove(cards, 'A', entry.to).map((item) => (item.id === 'A' ? { ...item, pinned: true } : item))
    expect(historyStep(history, 'undo', pinned, 'time', W).reason).toBe('WO-0221 is pinned and cannot move. Unpin it first.')
    expect(historyStep(history, 'undo', withMove(cards, 'A', entry.to), 'time', W, 'Offline').reason).toBe('Offline')
  })
})

describe('PlanningBoard markup (D18)', () => {
  const board = (extra: Partial<Parameters<typeof PlanningBoard>[0]> = {}) =>
    render(h(PlanningBoard, { label: 'Planning board', lanes, buckets, cards, onMove: () => undefined, ...extra }))

  it('a named region: lanes, buckets with today and closed in words, the tray, one tab stop among the cards', () => {
    const out = board()
    expect(out).toContain('role="region" aria-label="Planning board"')
    for (const text of ['Line 1', 'Line 2', 'Workshop Beta', 'Not approved for armour pockets', '>Today<', 'Closed: Holiday', 'Not on the board']) expect(out).toContain(text)
    expect(out.match(/data-pb-card="[^"]+"/g)).toHaveLength(5)
    expect(out.match(/role="button" tabindex="0"/g)).toHaveLength(1)
    expect(out).toContain('aria-label="WO-0223, 2,340 min, Line 2, Tue, Late, Material 14 Nov"')
    expect(out).toContain(W.instructions)
  })

  it('the load per cell is drawn (over said in words) and opens its popover', () => {
    const out = board({ cards: [...cards, { id: 'X', label: 'WO-0300', minutes: 2000, laneId: 'L2', bucketId: 'd2' }] })
    expect(out).toContain('>+1,460 min over<')
    expect(out).toContain('aria-label="Line 2, Tue: 4,340 of 2,880 min booked, 151%, 1,460 min over capacity."')
    expect(out).toContain('aria-label="Line 2, Wed: no working time set, 0 min booked."')
  })

  it('a keyboard move under way draws the ghost and the load after the drop', () => {
    const out = board({ defaultMove: { cardId: 'A', to: { laneId: 'L2', bucketId: 'd2' } } })
    expect(out).toContain('data-pb-ghost=""')
    expect(out).toContain('nds-pb-cell is-today is-over-target')
    expect(out).toContain('After the move, Line 2, Tue: 3,540 of 2,880 min booked, 123%, 660 min over capacity. Now Line 2, Tue: 2,340 of 2,880 min booked, 81%.')
  })

  it('read-only says why at rest; undo and redo are held with their reason', () => {
    const out = board({ heldReason: 'Read-only: only planners move work' })
    expect(out).toContain('Read-only: only planners move work')
    expect(out).toContain('aria-description="Nothing to undo"')
    expect(out).toContain('aria-description="Nothing to redo"')
    expect(board({ onMove: undefined })).toContain('This board is read-only.')
  })

  it('the columns layout: the tray first, a column per lane with its load', () => {
    const out = board({ layout: 'columns' })
    expect(out).toContain('class="nds-pb-tray is-column"')
    expect(out.match(/class="nds-pb-column[ "]/g)).toHaveLength(3)
    expect(out).toContain('<span class="nds-vh">Line 1: 4,200 of 8,640 min booked, 49%.</span>')
  })

  it('the list: a Move button per card, held with its reason for a pinned one', () => {
    const out = board({ layout: 'list' })
    expect(out).toContain('class="nds-pb is-list"')
    expect(out.match(/data-pb-move="/g)).toHaveLength(5)
    expect(out).toMatch(/aria-label="Move WO-0224"[^>]*aria-description="WO-0224 is pinned and cannot move. Unpin it first."|aria-description="WO-0224 is pinned and cannot move. Unpin it first."[^>]*aria-label="Move WO-0224"/)
  })

  it('empty and loading say so; a failed read is not drawn as empty (the app shows its error instead)', () => {
    expect(board({ cards: [] })).toContain('No work orders on this board in this window')
    expect(board({ cards: [] })).toContain('Every work order has a slot')
    const loading = board({ cards: [], loading: true })
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain('No work orders on this board in this window')
    expect(loading).toContain('nds-skeleton')
  })
})

describe('planning-board.css (D18)', () => {
  const css = readFileSync(new URL('./planning-board.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('semantic tokens only: no raw colour, no numbered ramp', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
    expect(css).not.toMatch(/rgba?\(/)
  })

  it('over capacity is hatched past the capacity line, late cards striped, and motion can be reduced', () => {
    expect(css).toMatch(/\.nds-loadbar-excess \{[^}]*repeating-linear-gradient/)
    expect(css).toMatch(/\.nds-pb-card\.is-late \{[^}]*repeating-linear-gradient/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('Commerce pages do not carry the board (D18)', () => {
  it('the patterns barrel does not re-export this folder; it is its own entry point', () => {
    const barrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const code = barrel.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/planning-board/)
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(entry).toMatch(/export \{ PlanningBoard/)
    expect(entry).toMatch(/export \{ LoadBar/)
  })

  it('no shared stylesheet imports the board\'s rules', () => {
    for (const sheet of ['primitives.css', 'components.css', 'patterns.css', 'a11y.css']) {
      const text = readFileSync(new URL(`../../styles/${sheet}`, import.meta.url), 'utf8')
      expect(text, sheet).not.toMatch(/planning-board|nds-pb-|nds-loadbar/)
    }
  })
})
