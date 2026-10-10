'use client'

/**
 * WeekHourGrid — a week × hour editor with locks (ads brain page D1, 2026-10-10).
 *
 * Controlled, and it never saves: Paint hands the hours and the brush to `onPaint`, Lock hands the hours and the new
 * state to `onLock`; the page keeps them in its draft. `Heatmap` only shows — this one edits.
 *
 *  - Pointer: drag selects a rectangle, release applies the brush (Paint) or flips the lock (Lock). A day label does
 *    its whole day, an hour label its hour across the week, the corner the whole week.
 *  - Keyboard: ONE tab stop (roving focus). Arrows move (they follow the screen, also on its side), Home/End = first /
 *    last hour, PageUp/PageDown = previous / next day, Shift grows the selection, Space or Enter applies, Esc clears
 *    the selection (with nothing selected it is left to the host: a drawer closes), Ctrl/⌘+A = the whole week, 1–6
 *    pick a brush — only while the grid has focus.
 *  - Paint never writes a locked hour; it says how many it kept. A polite live region says what each edit did.
 *  - Each cell's name: "Tuesday 20:00, Push, locked, was Base, 9 orders". Hover or focus shows the same words under
 *    the grid.
 *  - Below 640 px of its own width the week turns on its side (rows = hours, columns = days): 7 columns fit 390 px.
 *  - Colour: brush tones on the `-soft` grounds with their `-text` inks (the 7:1 status pairs); research shading is a
 *    6-step mix of `--nds-primary` into the surface, and a null is hatched — no data, never a 0. Tokens only, so it
 *    works in both themes; the ads shell pins it light.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Lock } from 'lucide-react'

import { SegmentedControl } from '../primitives/SegmentedControl'
import { Kbd } from '../primitives/Kbd'
import { Listbox } from './Listbox'
import {
  DAY_HOURS, MONDAY_FIRST, WEEK_DAYS, WEEK_HOUR_MAX_BRUSHES,
  addressOf, brushLabel, brushMark, cellAt, dayName, dayRect, dayShort, heatMax, heatStep, hourRect, hourShort, hourText,
  inRect, isChanged, lockAnnouncement, lockPlan, orientationFor, paintAnnouncement, paintPlan, rectAddresses, rectOf,
  selectionOf, weekHourCellParts, weekHourKeyReducer, weekRect,
  type WeekHourAddress, type WeekHourBrush, type WeekHourCell, type WeekHourCursor, type WeekHourMode,
  type WeekHourOrientation, type WeekHourPos, type WeekHourRect,
} from './weekHourModel'

export interface WeekHourMetric { id: string; label: string }

export interface WeekHourGridProps {
  /** Accessible name of the grid ("Hourly plan, JACKET-A, IT"). */
  label: string
  /** `cells[day][hour]`, day 0..6 with 0 = Sunday (the hourly plans' address), hour 0..23. */
  cells: WeekHourCell[][]
  /** Default Monday first: [1, 2, 3, 4, 5, 6, 0]. */
  dayOrder?: number[]
  /** At most 6 (keys 1–6). */
  brushes: WeekHourBrush[]
  mode: 'view' | 'paint' | 'lock'
  /** Shown when given: the Edit control (View · Paint · Lock). Without it the page owns the mode. */
  onMode?(mode: WeekHourMode): void
  brush?: string
  onBrush?(id: string): void
  onPaint?(hours: { day: number; hour: number }[], brush: string): void
  onLock?(hours: { day: number; hour: number }[], locked: boolean): void
  /** `brush` colours the plan; `heat` shades the research (the cells' `heat`). */
  shade?: 'brush' | 'heat'
  formatHeat?(v: number | null): string
  heatLabel?: string
  /** The ONE metric picker ("Shade by"): shown when `metrics` and `onMetric` are given. The page supplies `heat` for it. */
  metrics?: WeekHourMetric[]
  metric?: string
  onMetric?(id: string): void
  metricLabel?: string
  /** Drives a side "this hour" panel: fired when the focused hour changes (keys or a click). */
  onFocusHour?(day: number, hour: number): void
  /** "Times in Europe/Rome". */
  timeZoneLabel?: string
  /** View mode with an explanation ("The plan waits for your approval"). Said again when Space is pressed. */
  readOnlyReason?: string
  /** The word for an hour with no value. Default "Base". */
  baseLabel?: string
  /** `auto` (default) turns on its side below 640 px of the grid's own width. */
  orientation?: 'auto' | WeekHourOrientation
  className?: string
}

const MODE_OPTIONS = [
  { value: 'view', label: 'View', title: 'Look only: nothing changes on a click' },
  { value: 'paint', label: 'Paint', title: 'Drag or press Space to paint the chosen brush; locked hours are kept' },
  { value: 'lock', label: 'Lock', title: 'Drag or press Space to lock or unlock hours: the brain never writes a locked hour' },
]

const cellId = (base: string, p: WeekHourPos) => `${base}-c${p.dayIndex}-${p.hour}`
const samePos = (a: WeekHourPos | null, b: WeekHourPos | null) => !!a && !!b && a.dayIndex === b.dayIndex && a.hour === b.hour

function posFromElement(el: Element | null): WeekHourPos | null {
  const cell = el?.closest<HTMLElement>('[data-wh-cell]')
  if (!cell) return null
  const dayIndex = Number(cell.dataset.whDay)
  const hour = Number(cell.dataset.whHour)
  return Number.isInteger(dayIndex) && Number.isInteger(hour) ? { dayIndex, hour } : null
}

export function WeekHourGrid({
  label, cells, dayOrder = MONDAY_FIRST as number[], brushes: allBrushes, mode, onMode, brush, onBrush, onPaint, onLock,
  shade = 'brush', formatHeat, heatLabel, metrics, metric, onMetric, metricLabel = 'Shade by', onFocusHour,
  timeZoneLabel, readOnlyReason, baseLabel = 'Base', orientation: orientationProp = 'auto', className,
}: WeekHourGridProps) {
  const baseId = useId().replace(/:/g, '')
  const rootRef = useRef<HTMLDivElement>(null)
  const brushes = useMemo(() => allBrushes.slice(0, WEEK_HOUR_MAX_BRUSHES), [allBrushes])
  const words = useMemo(() => ({ brushes, baseLabel, formatHeat, heatLabel }), [brushes, baseLabel, formatHeat, heatLabel])
  const editing = mode !== 'view'

  /* ── orientation: measured on the grid's own width, before paint ── */
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const orientation: WeekHourOrientation = orientationProp === 'auto' ? orientationFor(width) : orientationProp
  // On its side the day header sticks to the page while you scroll the hours, so the grid does not scroll sideways —
  // unless its host is narrower than 7 day columns (under ~310 px): then it scrolls rather than being cut off.
  const [tight, setTight] = useState(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) setTight(el.scrollWidth > el.clientWidth + 1)
  }, [width, orientation])

  /* ── cursor, hover, the live line ── */
  const [cursor, setCursor] = useState<WeekHourCursor>({ focus: { dayIndex: 0, hour: 0 }, anchor: null })
  const [hover, setHover] = useState<WeekHourPos | null>(null)
  const [focusWithin, setFocusWithin] = useState(false)
  const [said, setSaid] = useState('')
  const say = useCallback((text: string) => setSaid((prev) => (prev === text ? `${text} ` : text)), [])
  const focusPending = useRef(false)
  const lastFocusHour = useRef<string>('')

  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    document.getElementById(cellId(baseId, cursor.focus))?.focus()
  }, [cursor.focus, baseId])

  useEffect(() => {
    if (!focusWithin || !onFocusHour) return
    const a = addressOf(cursor.focus, dayOrder)
    const key = `${a.day}-${a.hour}`
    if (key === lastFocusHour.current) return
    lastFocusHour.current = key
    onFocusHour(a.day, a.hour)
  }, [cursor.focus, focusWithin, onFocusHour, dayOrder])

  const selection: WeekHourRect = selectionOf(cursor)
  const hasSelection = cursor.anchor !== null && !samePos(cursor.anchor, cursor.focus)

  /* ── applying an edit ── */
  const apply = useCallback((rect: WeekHourRect) => {
    const hours: WeekHourAddress[] = rectAddresses(rect, dayOrder)
    if (mode === 'view') {
      say(readOnlyReason ?? 'View only.')
      return
    }
    if (mode === 'paint') {
      if (!brush || !onPaint) { say('Pick a brush first.'); return }
      const plan = paintPlan(cells, hours)
      if (plan.hours.length) onPaint(plan.hours, brush)
      say(paintAnnouncement(brushLabel(brush, words), plan.hours.length, plan.skipped))
      return
    }
    if (!onLock) return
    const plan = lockPlan(cells, hours)
    if (plan.hours.length) onLock(plan.hours, plan.locked)
    say(lockAnnouncement(plan.hours.length, plan.locked))
  }, [mode, brush, onPaint, onLock, cells, dayOrder, readOnlyReason, say, words])

  const pickBrush = useCallback((index: number) => {
    const b = brushes[index]
    if (!b || !onBrush || mode !== 'paint') return
    onBrush(b.id)
    say(`Brush: ${b.label}`)
  }, [brushes, onBrush, mode, say])

  /* ── keyboard ── */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!posFromElement(e.target as Element)) return
    const r = weekHourKeyReducer(cursor, e, { orientation, brushCount: mode === 'paint' && onBrush ? brushes.length : 0 })
    if (!r.handled) return
    e.preventDefault()
    if (r.cursor !== cursor) {
      if (!samePos(r.cursor.focus, cursor.focus)) focusPending.current = true
      setCursor(r.cursor)
    }
    if (r.effect?.kind === 'apply') apply(selectionOf(cursor))
    else if (r.effect?.kind === 'brush') pickBrush(r.effect.index)
    else if (r.effect?.kind === 'clear') say('Selection cleared.')
    if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) say('The whole week is selected.')
  }

  /* ── pointer: drag a rectangle, release applies ── */
  const drag = useRef<{ anchor: WeekHourPos; focus: WeekHourPos } | null>(null)

  useEffect(() => {
    const end = (e: globalThis.PointerEvent) => {
      const d = drag.current
      if (!d) return
      drag.current = null
      if (e.type === 'pointerup' && editing) apply(rectOf(d.anchor, d.focus))
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [apply, editing])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const pos = posFromElement(e.target as Element)
    if (!pos) return
    drag.current = editing ? { anchor: pos, focus: pos } : null
    focusPending.current = true
    setCursor({ focus: pos, anchor: editing ? pos : null })
  }

  /** A day label does its whole day, an hour label its hour across the week, the corner the whole week. */
  const onHeadClick = (e: MouseEvent<HTMLDivElement>) => {
    const head = (e.target as Element).closest<HTMLElement>('[data-wh-head]')
    if (!head) return
    const n = Number(head.dataset.whIndex)
    const rect = head.dataset.whHead === 'day' ? dayRect(n) : head.dataset.whHead === 'hour' ? hourRect(n) : weekRect()
    focusPending.current = true
    setCursor({ anchor: { dayIndex: rect.dayFrom, hour: rect.hourFrom }, focus: { dayIndex: rect.dayTo, hour: rect.hourTo } })
    if (editing) apply(rect)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) {
      const pos = posFromElement(e.target as Element)
      if (!samePos(pos, hover)) setHover(pos)
      return
    }
    const pos = posFromElement(document.elementFromPoint(e.clientX, e.clientY))
    if (!pos || samePos(pos, d.focus)) return
    d.focus = pos
    setHover(pos)
    setCursor({ anchor: d.anchor, focus: pos })
  }

  /* ── drawing ── */
  const max = useMemo(() => heatMax(cells), [cells])
  const anyChanged = useMemo(() => cells.some((row) => row?.some((c) => c && isChanged(c))), [cells])
  const anyNoData = shade === 'heat' && cells.some((row) => row?.some((c) => c && c.heat === null))
  const brushById = useMemo(() => new Map(brushes.map((b) => [b.id, b])), [brushes])

  const toneOf = (c: WeekHourCell) => (c.brush == null ? 'base' : brushById.get(c.brush)?.tone ?? 'neutral')

  const renderCell = (pos: WeekHourPos) => {
    const addr = addressOf(pos, dayOrder)
    const c = cellAt(cells, addr.day, addr.hour)
    const parts = weekHourCellParts(addr, c, words)
    const step = shade === 'heat' ? heatStep(c.heat, max) : null
    const selected = inRect(pos, selection)
    const b = c.brush == null ? null : brushById.get(c.brush)
    const cls = [
      'nds-weekhour-cell',
      shade === 'heat' ? (step == null ? 'is-nodata' : `heat-${step}`) : `tone-${toneOf(c)}`,
      c.locked ? 'is-locked' : '',
      isChanged(c) ? 'is-changed' : '',
      selected ? 'is-selected' : '',
    ].filter(Boolean).join(' ')
    return (
      <div
        key={`${pos.dayIndex}-${pos.hour}`}
        id={cellId(baseId, pos)}
        role="gridcell"
        className={cls}
        tabIndex={samePos(pos, cursor.focus) ? 0 : -1}
        aria-label={parts.join(', ')}
        aria-selected={selected}
        data-wh-cell=""
        data-wh-day={pos.dayIndex}
        data-wh-hour={pos.hour}
      >
        {c.locked
          ? <Lock size={10} strokeWidth={2.5} className="nds-weekhour-lock" aria-hidden />
          : shade === 'brush' && b && <span className="nds-weekhour-mark" aria-hidden>{brushMark(b)}</span>}
      </div>
    )
  }

  const headTitle = (what: string) => (mode === 'paint' ? `Paint all of ${what}` : mode === 'lock' ? `Lock or unlock all of ${what}` : `Select all of ${what}`)
  const dayHead = (dayIndex: number, as: 'row' | 'col') => {
    const day = dayOrder[dayIndex] ?? dayIndex
    return (
      <div
        key={`d${dayIndex}`}
        role={as === 'row' ? 'rowheader' : 'columnheader'}
        className={as === 'row' ? 'nds-weekhour-rowhead' : 'nds-weekhour-colhead'}
        aria-label={dayName(day)}
        title={headTitle(dayName(day))}
        data-wh-head="day"
        data-wh-index={dayIndex}
      >
        {dayShort(day)}
      </div>
    )
  }
  const hourHead = (hour: number, as: 'row' | 'col') => (
    <div
      key={`h${hour}`}
      role={as === 'row' ? 'rowheader' : 'columnheader'}
      className={as === 'row' ? 'nds-weekhour-rowhead' : 'nds-weekhour-colhead'}
      aria-label={hourText(hour)}
      title={headTitle(`${hourText(hour)} across the week`)}
      data-wh-head="hour"
      data-wh-index={hour}
    >
      {hourShort(hour)}
    </div>
  )

  const rows: ReactNode[] = []
  if (orientation === 'week') {
    rows.push(
      <div role="row" className="nds-weekhour-row is-head" key="head">
        <div role="columnheader" className="nds-weekhour-corner" aria-label="Day" title={headTitle('the week')} data-wh-head="week" data-wh-index={0} />
        {Array.from({ length: DAY_HOURS }, (_, h) => hourHead(h, 'col'))}
      </div>,
    )
    for (let d = 0; d < WEEK_DAYS; d++) {
      rows.push(
        <div role="row" className="nds-weekhour-row" key={`r${d}`}>
          {dayHead(d, 'row')}
          {Array.from({ length: DAY_HOURS }, (_, h) => renderCell({ dayIndex: d, hour: h }))}
        </div>,
      )
    }
  } else {
    rows.push(
      <div role="row" className="nds-weekhour-row is-head" key="head">
        <div role="columnheader" className="nds-weekhour-corner" aria-label="Hour" title={headTitle('the week')} data-wh-head="week" data-wh-index={0} />
        {Array.from({ length: WEEK_DAYS }, (_, d) => dayHead(d, 'col'))}
      </div>,
    )
    for (let h = 0; h < DAY_HOURS; h++) {
      rows.push(
        <div role="row" className="nds-weekhour-row" key={`r${h}`}>
          {hourHead(h, 'row')}
          {Array.from({ length: WEEK_DAYS }, (_, d) => renderCell({ dayIndex: d, hour: h }))}
        </div>,
      )
    }
  }

  const detailPos = hover ?? (focusWithin ? cursor.focus : null)
  const detailAddr = detailPos ? addressOf(detailPos, dayOrder) : null
  const detail = detailAddr ? weekHourCellParts(detailAddr, cellAt(cells, detailAddr.day, detailAddr.hour), words).join(' · ') : null
  const selectedCount = hasSelection ? (selection.dayTo - selection.dayFrom + 1) * (selection.hourTo - selection.hourFrom + 1) : 0

  const keysHelp = mode === 'paint'
    ? 'Arrow keys move, Shift with an arrow selects, Space paints the selection with the brush, Escape clears the selection, 1 to 6 pick a brush.'
    : mode === 'lock'
      ? 'Arrow keys move, Shift with an arrow selects, Space locks or unlocks the selection, Escape clears the selection.'
      : 'Arrow keys move from hour to hour; Home and End go to the first and last hour, Page Up and Page Down to the previous and next day.'

  const showBrushPicker = mode === 'paint' && !!onBrush && brushes.length > 0
  const showMetric = !!metrics?.length && !!onMetric

  return (
    <div
      ref={rootRef}
      className={['nds-weekhour', `is-${orientation}`, tight ? 'is-tight' : '', editing ? 'is-edit' : '', shade === 'heat' ? 'is-heat' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      {(onMode || showBrushPicker || showMetric || timeZoneLabel) && (
        <div className="nds-weekhour-bar">
          {onMode && (
            <span className="nds-weekhour-ctl">
              <span className="nds-weekhour-lbl" aria-hidden>Edit</span>
              <SegmentedControl size="sm" ariaLabel="Edit" options={MODE_OPTIONS} value={mode} onChange={(v) => onMode(v as WeekHourMode)} />
            </span>
          )}
          {showBrushPicker && (
            <span className="nds-weekhour-ctl">
              <span className="nds-weekhour-lbl" aria-hidden>Brush</span>
              <SegmentedControl
                size="sm"
                wrap
                ariaLabel="Brush"
                value={brush ?? ''}
                onChange={(v) => onBrush?.(v)}
                options={brushes.map((b, i) => ({
                  value: b.id,
                  title: b.description,
                  label: (
                    <span className="nds-weekhour-brush">
                      <span className={`nds-weekhour-swatch tone-${b.tone}`} aria-hidden>{brushMark(b)}</span>
                      {b.label}
                      <Kbd className="nds-weekhour-kbd">{i + 1}</Kbd>
                    </span>
                  ),
                }))}
              />
            </span>
          )}
          {showMetric && (
            <span className="nds-weekhour-ctl">
              <span className="nds-weekhour-lbl" aria-hidden>{metricLabel}</span>
              <Listbox size="sm" ariaLabel={metricLabel} options={metrics!.map((m) => ({ value: m.id, label: m.label }))} value={metric} onChange={(v) => onMetric?.(v)} />
            </span>
          )}
          {timeZoneLabel && <span className="nds-weekhour-tz">{timeZoneLabel}</span>}
        </div>
      )}
      {mode === 'view' && readOnlyReason && <p className="nds-weekhour-note">{readOnlyReason}</p>}

      <div className="nds-weekhour-scroll" ref={scrollRef}>
        <div
          role="grid"
          aria-label={label}
          aria-describedby={`${baseId}-keys`}
          aria-multiselectable={editing || undefined}
          aria-readonly={!editing || undefined}
          className="nds-weekhour-grid"
          data-orient={orientation}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onClick={onHeadClick}
          onPointerLeave={() => { if (!drag.current) setHover(null) }}
          onFocus={(e) => {
            const pos = posFromElement(e.target as Element)
            setFocusWithin(true)
            if (pos && !samePos(pos, cursor.focus)) setCursor((c) => ({ focus: pos, anchor: c.anchor }))
          }}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false) }}
        >
          {rows}
        </div>
      </div>

      <div className="nds-weekhour-foot">
        <div className="nds-weekhour-legend">
          {shade === 'brush' && !showBrushPicker && (
            <>
              <span className="nds-weekhour-key"><span className="nds-weekhour-swatch tone-base" aria-hidden />{baseLabel}</span>
              {brushes.map((b) => (
                <span key={b.id} className="nds-weekhour-key" title={b.description}>
                  <span className={`nds-weekhour-swatch tone-${b.tone}`} aria-hidden>{brushMark(b)}</span>{b.label}
                </span>
              ))}
            </>
          )}
          {shade === 'heat' && (
            <span className="nds-weekhour-key">
              <span className="nds-weekhour-ramp" aria-hidden>
                {[0, 1, 2, 3, 4, 5].map((s) => <span key={s} className={`nds-weekhour-swatch heat-${s}`} />)}
              </span>
              {heatLabel ? `${heatLabel}: none → most` : 'None → most'}
            </span>
          )}
          {anyNoData && <span className="nds-weekhour-key"><span className="nds-weekhour-swatch is-nodata" aria-hidden />No data</span>}
          <span className="nds-weekhour-key"><Lock size={11} strokeWidth={2.25} className="nds-weekhour-lock" aria-hidden />Locked: the brain never writes it</span>
          {anyChanged && <span className="nds-weekhour-key"><span className="nds-weekhour-swatch tone-base is-changed" aria-hidden />Changed</span>}
        </div>
        <div className="nds-weekhour-detail" aria-hidden>
          {detail ?? (editing ? 'Drag across hours, or move with the arrow keys and press Space.' : 'Point at an hour, or move to it with the arrow keys, to read it.')}
          {selectedCount > 1 && <span className="nds-weekhour-count"> · {selectedCount} hours selected</span>}
        </div>
      </div>

      <p id={`${baseId}-keys`} className="nds-vh">{keysHelp}</p>
      <div className="nds-vh" aria-live="polite" aria-atomic="true">{said}</div>
    </div>
  )
}
