import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WeekHourGrid, type WeekHourGridProps } from './WeekHourGrid'

import {
  MONDAY_FIRST, addressOf, cellAt, dayRect, fromVisual, heatMax, heatStep, hourRect, inRect, lockAnnouncement, lockPlan,
  orientationFor, paintAnnouncement, paintPlan, parseWeekHourKey, posOf, rectAddresses, rectOf, rectSize, selectionOf,
  toVisual, visualSize, weekHourCellName, weekHourCellParts, weekHourKey, weekHourKeyReducer, weekRect,
  type WeekHourBrush, type WeekHourCell, type WeekHourCursor, type WeekHourOrientation,
} from './weekHourModel'

const BRUSHES: WeekHourBrush[] = [
  { id: 'base', label: 'Base', tone: 'neutral' },
  { id: 'lower', label: 'Lower', tone: 'info' },
  { id: 'push', label: 'Push', tone: 'success' },
  { id: 'defend', label: 'Defend top', tone: 'accent' },
]

const week = (fill: (day: number, hour: number) => WeekHourCell = () => ({ brush: null })): WeekHourCell[][] =>
  Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => fill(d, h)))

const at = (dayIndex: number, hour: number) => ({ dayIndex, hour })
const cursor = (focus: { dayIndex: number; hour: number }, anchor: { dayIndex: number; hour: number } | null = null): WeekHourCursor => ({ focus, anchor })
const press = (c: WeekHourCursor, key: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}, orientation: WeekHourOrientation = 'week', brushCount = 4) =>
  weekHourKeyReducer(c, { key, ...mods }, { orientation, brushCount })

describe('the address: d<0-6>h<0-23>, 0 = Sunday, shown Monday first', () => {
  it('Monday first: the first row is Monday (1), the last is Sunday (0)', () => {
    expect(addressOf(at(0, 3))).toEqual({ day: 1, hour: 3 })
    expect(addressOf(at(6, 3))).toEqual({ day: 0, hour: 3 })
    expect(weekHourKey(addressOf(at(6, 3)).day, 3)).toBe('d0h3')
    expect(posOf({ day: 0, hour: 23 })).toEqual(at(6, 23))
    expect(posOf({ day: 2, hour: 20 })).toEqual(at(1, 20))
  })

  it('round-trips the key, and refuses what is not an hour of the week', () => {
    expect(parseWeekHourKey('d2h20')).toEqual({ day: 2, hour: 20 })
    expect(parseWeekHourKey(weekHourKey(0, 0))).toEqual({ day: 0, hour: 0 })
    expect(parseWeekHourKey('d7h1')).toBeNull()
    expect(parseWeekHourKey('d1h24')).toBeNull()
    expect(parseWeekHourKey('mon-20')).toBeNull()
  })

  it('a caller-given order is followed (Sunday first)', () => {
    const sundayFirst = [0, 1, 2, 3, 4, 5, 6]
    expect(addressOf(at(0, 5), sundayFirst)).toEqual({ day: 0, hour: 5 })
    expect(rectAddresses(dayRect(0), sundayFirst).every((a) => a.day === 0)).toBe(true)
  })

  it('a short cells array reads as empty hours, never a crash', () => {
    expect(cellAt([], 3, 4)).toEqual({ brush: null })
    expect(cellAt([[{ brush: 'push' }]], 0, 0).brush).toBe('push')
  })
})

describe('turned on its side', () => {
  it('below 640 px the week stands on its side; an unmeasured width keeps the week', () => {
    expect(orientationFor(390)).toBe('side')
    expect(orientationFor(639)).toBe('side')
    expect(orientationFor(640)).toBe('week')
    expect(orientationFor(1440)).toBe('week')
    expect(orientationFor(0)).toBe('week')
  })

  it('rows are hours and columns are days on its side; the mapping round-trips', () => {
    expect(visualSize('week')).toEqual({ rows: 7, cols: 24 })
    expect(visualSize('side')).toEqual({ rows: 24, cols: 7 })
    expect(toVisual(at(1, 20), 'week')).toEqual({ row: 1, col: 20 })
    expect(toVisual(at(1, 20), 'side')).toEqual({ row: 20, col: 1 })
    for (const o of ['week', 'side'] as const) {
      for (const p of [at(0, 0), at(6, 23), at(3, 11)]) {
        const v = toVisual(p, o)
        expect(fromVisual(v.row, v.col, o)).toEqual(p)
      }
    }
  })
})

describe('selection rectangles', () => {
  it('from any two corners, the same rectangle', () => {
    expect(rectOf(at(4, 2), at(1, 9))).toEqual({ dayFrom: 1, dayTo: 4, hourFrom: 2, hourTo: 9 })
    expect(rectOf(at(1, 9), at(4, 2))).toEqual(rectOf(at(4, 2), at(1, 9)))
    expect(rectSize(rectOf(at(1, 2), at(4, 9)))).toBe(32)
  })

  it('a day, an hour across the week, and the whole week', () => {
    expect(rectSize(dayRect(2))).toBe(24)
    expect(rectAddresses(hourRect(20)).map((a) => a.day)).toEqual([...MONDAY_FIRST])
    expect(rectSize(weekRect())).toBe(168)
    expect(inRect(at(6, 23), weekRect())).toBe(true)
    expect(inRect(at(2, 19), hourRect(20))).toBe(false)
  })

  it('addresses come day by day, then hour by hour, as on screen', () => {
    expect(rectAddresses(rectOf(at(0, 22), at(1, 23)))).toEqual([
      { day: 1, hour: 22 }, { day: 1, hour: 23 }, { day: 2, hour: 22 }, { day: 2, hour: 23 },
    ])
  })
})

describe('the key reducer', () => {
  it('arrows follow the screen in both orientations, and stop at the edge', () => {
    expect(press(cursor(at(1, 5)), 'ArrowRight').cursor.focus).toEqual(at(1, 6))
    expect(press(cursor(at(1, 5)), 'ArrowDown').cursor.focus).toEqual(at(2, 5))
    expect(press(cursor(at(1, 5)), 'ArrowRight', {}, 'side').cursor.focus).toEqual(at(2, 5))
    expect(press(cursor(at(1, 5)), 'ArrowDown', {}, 'side').cursor.focus).toEqual(at(1, 6))
    expect(press(cursor(at(0, 0)), 'ArrowUp').cursor.focus).toEqual(at(0, 0))
    expect(press(cursor(at(6, 23)), 'ArrowRight').cursor.focus).toEqual(at(6, 23))
    expect(press(cursor(at(6, 23)), 'ArrowDown', {}, 'side').cursor.focus).toEqual(at(6, 23))
  })

  it('Home/End go to the first/last hour, PageUp/PageDown to the previous/next day — in either orientation', () => {
    for (const o of ['week', 'side'] as const) {
      expect(press(cursor(at(3, 12)), 'Home', {}, o).cursor.focus).toEqual(at(3, 0))
      expect(press(cursor(at(3, 12)), 'End', {}, o).cursor.focus).toEqual(at(3, 23))
      expect(press(cursor(at(3, 12)), 'PageUp', {}, o).cursor.focus).toEqual(at(2, 12))
      expect(press(cursor(at(3, 12)), 'PageDown', {}, o).cursor.focus).toEqual(at(4, 12))
    }
    expect(press(cursor(at(3, 12)), 'Home', { ctrlKey: true }).cursor.focus).toEqual(at(0, 0))
    expect(press(cursor(at(3, 12)), 'End', { metaKey: true }).cursor.focus).toEqual(at(6, 23))
  })

  it('Shift grows the selection from where it started; a plain move drops it', () => {
    let c = cursor(at(1, 5))
    c = press(c, 'ArrowRight', { shiftKey: true }).cursor
    c = press(c, 'ArrowDown', { shiftKey: true }).cursor
    expect(c.anchor).toEqual(at(1, 5))
    expect(selectionOf(c)).toEqual({ dayFrom: 1, dayTo: 2, hourFrom: 5, hourTo: 6 })
    c = press(c, 'End', { shiftKey: true }).cursor
    expect(selectionOf(c)).toEqual({ dayFrom: 1, dayTo: 2, hourFrom: 5, hourTo: 23 })
    c = press(c, 'ArrowLeft').cursor
    expect(c.anchor).toBeNull()
    expect(selectionOf(c)).toEqual({ dayFrom: 2, dayTo: 2, hourFrom: 22, hourTo: 22 })
  })

  it('Space or Enter applies; Escape clears a selection and otherwise lets the key go (a drawer may close)', () => {
    const sel = cursor(at(2, 4), at(1, 1))
    expect(press(sel, ' ').effect).toEqual({ kind: 'apply' })
    expect(press(sel, 'Enter').effect).toEqual({ kind: 'apply' })
    expect(press(sel, ' ').cursor).toBe(sel)
    const esc = press(sel, 'Escape')
    expect(esc).toMatchObject({ handled: true, effect: { kind: 'clear' }, cursor: { focus: at(2, 4), anchor: null } })
    expect(press(cursor(at(2, 4)), 'Escape').handled).toBe(false)
  })

  it('1–6 pick a brush, only as many as there are, never with a modifier', () => {
    expect(press(cursor(at(0, 0)), '3').effect).toEqual({ kind: 'brush', index: 2 })
    expect(press(cursor(at(0, 0)), '5').handled).toBe(false)
    expect(press(cursor(at(0, 0)), '7', {}, 'week', 6).handled).toBe(false)
    expect(press(cursor(at(0, 0)), '1', { ctrlKey: true }).handled).toBe(false)
  })

  it('Ctrl/⌘ + A selects the whole week; Tab, letters and Alt combinations are not the grid\'s', () => {
    const all = press(cursor(at(3, 3)), 'a', { metaKey: true })
    expect(selectionOf(all.cursor)).toEqual(weekRect())
    expect(press(cursor(at(3, 3)), 'Tab').handled).toBe(false)
    expect(press(cursor(at(3, 3)), 'a').handled).toBe(false)
    expect(press(cursor(at(3, 3)), 'ArrowRight', { altKey: true }).handled).toBe(false)
  })
})

describe('what an edit does', () => {
  const cells = week((d, h) => ({ brush: null, locked: d === 2 && h < 2 }))

  it('paint skips locked hours and counts them', () => {
    const hours = [{ day: 2, hour: 0 }, { day: 2, hour: 1 }, { day: 2, hour: 2 }]
    expect(paintPlan(cells, hours)).toEqual({ hours: [{ day: 2, hour: 2 }], skipped: 2 })
    expect(paintAnnouncement('Push', 1, 2)).toBe('Push applied to 1 hour; 2 hours locked, kept.')
    expect(paintAnnouncement('Push', 12, 0)).toBe('Push applied to 12 hours.')
    expect(paintAnnouncement('Push', 0, 2)).toBe('All 2 hours are locked; unlock first to paint.')
    expect(paintAnnouncement('Push', 0, 1)).toBe('That hour is locked; unlock first to paint.')
  })

  it('lock flips the whole selection: all locked → unlock; any open → lock only the open ones', () => {
    expect(lockPlan(cells, [{ day: 2, hour: 0 }, { day: 2, hour: 1 }])).toEqual({ locked: false, hours: [{ day: 2, hour: 0 }, { day: 2, hour: 1 }] })
    expect(lockPlan(cells, [{ day: 2, hour: 1 }, { day: 2, hour: 2 }])).toEqual({ locked: true, hours: [{ day: 2, hour: 2 }] })
    expect(lockAnnouncement(1, true)).toBe('1 hour locked.')
    expect(lockAnnouncement(3, false)).toBe('3 hours unlocked.')
  })
})

describe('research shading: null is NO DATA, never a 0', () => {
  it('a measured 0 has step 0; a null has no step (hatched); the ramp is 1..5', () => {
    expect(heatStep(null, 10)).toBeNull()
    expect(heatStep(undefined, 10)).toBeNull()
    expect(heatStep(0, 10)).toBe(0)
    expect(heatStep(0.1, 10)).toBe(1)
    expect(heatStep(5, 10)).toBe(3)
    expect(heatStep(10, 10)).toBe(5)
    expect(heatStep(4, 0)).toBe(0)
  })

  it('the max leaves nulls out', () => {
    expect(heatMax(week((d, h) => ({ brush: null, heat: d === 0 && h === 0 ? null : d + h })))).toBe(6 + 23)
    expect(heatMax(week())).toBe(0)
  })
})

describe('the accessible cell names', () => {
  const ctx = { brushes: BRUSHES, formatHeat: (v: number | null) => (v == null ? 'no data' : `${v} orders`) }

  it('day and hour, the brush, the lock, the change, the research', () => {
    expect(weekHourCellName({ day: 2, hour: 20 }, { brush: 'push', locked: true, before: 'base', heat: 9 }, ctx)).toBe('Tuesday 20:00, Push, locked, was Base, 9 orders')
  })

  it('no value reads as Base; a zero reads as a zero, a null as no data', () => {
    expect(weekHourCellName({ day: 0, hour: 3 }, { brush: null, heat: 0 }, ctx)).toBe('Sunday 03:00, Base, 0 orders')
    expect(weekHourCellName({ day: 0, hour: 3 }, { brush: null, heat: null }, ctx)).toBe('Sunday 03:00, Base, no data')
    expect(weekHourCellName({ day: 0, hour: 3 }, { brush: null }, { brushes: BRUSHES, baseLabel: 'No change' })).toBe('Sunday 03:00, No change')
  })

  it('"was" only when the brush really changed; no research shown, no research said', () => {
    expect(weekHourCellParts({ day: 1, hour: 0 }, { brush: 'push', before: 'push' }, ctx)).toEqual(['Monday 00:00', 'Push'])
    expect(weekHourCellParts({ day: 1, hour: 0 }, { brush: 'push', before: null }, ctx)).toEqual(['Monday 00:00', 'Push', 'was Base'])
    expect(weekHourCellParts({ day: 1, hour: 0 }, { brush: 'push' }, { brushes: BRUSHES, heatLabel: 'Orders' })).toEqual(['Monday 00:00', 'Push'])
    expect(weekHourCellParts({ day: 1, hour: 0 }, { brush: 'push', heat: 4 }, { brushes: BRUSHES, heatLabel: 'Orders' })).toEqual(['Monday 00:00', 'Push', 'Orders 4'])
  })
})

describe('the markup (server render)', () => {
  const cells = week((d, h) => ({
    brush: d === 2 && h === 20 ? 'push' : null,
    locked: d === 1 && h < 2,
    heat: d === 0 ? null : h,
    before: d === 2 && h === 20 ? 'base' : undefined,
  }))
  const html = (p: Partial<WeekHourGridProps> = {}) => renderToStaticMarkup(createElement(WeekHourGrid, {
    label: 'Hourly plan', cells, brushes: BRUSHES, mode: 'paint', brush: 'push', ...p,
  }))

  it('one grid, 168 hours, ONE tab stop', () => {
    const out = html()
    expect(out.match(/role="grid"/g)).toHaveLength(1)
    expect(out.match(/role="gridcell"/g)).toHaveLength(168)
    expect(out.match(/tabindex="0"/g)).toHaveLength(1)
    expect(out).toContain('aria-label="Monday 00:00, Base, locked, 0"')
  })

  it('the cell is named in words; the lock is the outline icon, never an emoji', () => {
    const out = html({ formatHeat: (v) => (v == null ? 'no data' : `${v} orders`) })
    expect(out).toContain('aria-label="Tuesday 20:00, Push, was Base, 20 orders"')
    expect(out).toContain('aria-label="Sunday 05:00, Base, no data"')
    expect(out).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
    expect(out).toMatch(/<svg[^>]*nds-weekhour-lock/)
  })

  it('research shading: a null is hatched (no data), a measured 0 is step 0', () => {
    const out = html({ shade: 'heat', orientation: 'week' })
    expect(out).toMatch(/class="nds-weekhour-cell is-nodata[^"]*"[^>]*aria-label="Sunday 00:00/)
    expect(out).toMatch(/class="nds-weekhour-cell heat-0[^"]*"[^>]*aria-label="Tuesday 00:00/)
  })

  it('on its side: 24 hour rows under the day header', () => {
    const out = html({ orientation: 'side' })
    expect(out.match(/role="row"/g)).toHaveLength(25)
    expect(out.match(/role="rowheader"/g)).toHaveLength(24)
    expect(out).toContain('nds-weekhour is-side')
  })

  it('the brush picker shows only in Paint with a handler; view mode says why', () => {
    expect(html({ onBrush: () => {} })).toContain('aria-label="Brush"')
    expect(html({ mode: 'lock', onBrush: () => {} })).not.toContain('aria-label="Brush"')
    expect(html({ mode: 'view', readOnlyReason: 'The plan waits for your approval.' })).toContain('The plan waits for your approval.')
  })
})
