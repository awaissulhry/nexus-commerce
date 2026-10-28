'use client'

/**
 * SizeGridEditor (gap G9) — enter quantities by colour and size in one grid, from the keyboard.
 *
 * Rows are the colourways (swatch + name), columns the sizes in scale order, then the row totals; the last row holds
 * the column totals and the grand total. The screen owns the values: `value` in, the FULL matrix out through
 * `onChange` on every change. Rules (totals, curve fill, paste, clamping, movement) are in `sizeGridModel.ts`.
 *
 * ## Accessibility: a table with labelled inputs
 *
 * A real `<table>`: size column headers, colour row headers, a totals row in `<tfoot>`. Every cell that takes an entry
 * is an `<input>` whose accessible name is colour + size ("Black, size M"); a size the colourway is not made in is a
 * plain cell reading "– not offered", never a disabled input. Tab walks the cells row by row; the arrows move between
 * cells (left and right once the caret is at the edge of the number, or the number is selected, as it is on arrival);
 * Enter moves down and Shift+Enter up; Escape puts back the quantity the cell had when it was entered. After a change,
 * a polite status region reads the row's, the column's and the grand total. A cell the screen flags (`issues`) is
 * `aria-invalid` (errors) and described by its message, which is also listed under the grid with a button that
 * returns to the cell.
 *
 * ## Paste
 *
 * A block copied from a spreadsheet (tab between values, newline between rows) lands with its first value on the cell
 * pasted into. What could not land (a size not offered, outside the grid, not a whole number) is counted and said.
 *
 * ## Density
 *
 * Every size reads the page density (`--nds-density-*`): on `standard` (the console) a cell is 28 px high in 13 px
 * type; on `comfortable` (the portal) 44 px in 16 px, so a phone never zooms into it. The grid scrolls sideways
 * inside its own box; the page never does.
 *
 * ## Made to measure
 *
 * With `onMtmChange` the editor shows a switch, "One made-to-measure unit". On, the grid and the curve fill are
 * hidden and `mtmSlot` (the app's measurement-profile picker) is shown instead. The quantities are left as they are:
 * the screen decides what an MTM line stores.
 */
import { useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'

import { Button } from '../../primitives/Button'
import { Input } from '../../primitives/Input'
import { Select } from '../../primitives/Select'
import { Toggle } from '../../primitives/Toggle'
import { Field } from '../../components/Field'
import {
  SIZE_GRID_MAX_QUANTITY,
  clampSizeGridQuantity,
  curveFillSizeGrid,
  curveShareText,
  formatSizeGridQuantity,
  parseSizeGridQuantity,
  pasteIntoSizeGrid,
  setSizeGridCell,
  sizeGridCell,
  sizeGridCopy,
  sizeGridIssueTone,
  sizeGridIssuesFor,
  sizeGridOffered,
  sizeGridStep,
  sizeGridTotals,
  sizeGridOffers,
  type SizeGridColour,
  type SizeGridCopy,
  type SizeGridCurve,
  type SizeGridDirection,
  type SizeGridIssue,
  type SizeGridSize,
  type SizeGridValue,
} from './sizeGridModel'
import { SizeGridFoot, SizeGridHead, SizeGridIssueGlyph, SizeGridIssueList, SizeGridRowHead, SizeGridScroll, useOverflowX, type SizeGridIssueLine } from './sizeGridParts'
import './size-grid.css'

export interface SizeGridEditorProps {
  /** The rows, in the order shown. */
  colours: readonly SizeGridColour[]
  /** The columns, in scale order. */
  sizes: readonly SizeGridSize[]
  value: SizeGridValue
  /** The full matrix after every change: every colour × every size, a size not offered at 0. */
  onChange: (next: Record<string, Record<string, number>>) => void
  /** Size curves for "Fill by curve". None: no curve fill is shown. */
  curves?: readonly SizeGridCurve[]
  /** Messages per cell (or per colourway, `size` omitted), from the screen. */
  issues?: readonly SizeGridIssue[]
  /** The most one cell takes. Default 99 999. */
  max?: number
  /** The table's name. Default "Quantities by colour and size". */
  caption?: string
  /** Show the caption above the grid. Default: for screen readers only (the screen's own heading names it). */
  showCaption?: boolean
  /** The line is one made-to-measure unit: the grid is hidden and `mtmSlot` is shown. */
  mtm?: boolean
  /** Shows the made-to-measure switch. Omitted: no switch (the style is not made to measure). */
  onMtmChange?: (next: boolean) => void
  /** What a made-to-measure line shows instead of the grid: the app's measurement-profile picker. */
  mtmSlot?: ReactNode
  /** Groups the totals (`1,248`). Default `en-GB`. */
  locale?: string
  /** The words, for another language. */
  copy?: Partial<SizeGridCopy>
  className?: string
}

/** The curve-fill target that means every colour (an option value no colour key is expected to take). */
const EVERY = '__size-grid-every-colour__'
const keyOf = (row: number, col: number) => `${row}:${col}`

export function SizeGridEditor({
  colours,
  sizes,
  value,
  onChange,
  curves,
  issues,
  max = SIZE_GRID_MAX_QUANTITY,
  caption,
  showCaption = false,
  mtm = false,
  onMtmChange,
  mtmSlot,
  locale,
  copy: copyIn,
  className,
}: SizeGridEditorProps) {
  const copy = useMemo(() => sizeGridCopy(copyIn), [copyIn])
  const uid = useId()
  const captionId = `${uid}-caption`
  const mtmId = `${uid}-mtm`
  const noteId = `${uid}-note`
  const scrollRef = useRef<HTMLDivElement>(null)
  const empty = !colours.length || !sizes.length
  const overflowing = useOverflowX(scrollRef, !mtm && !empty)
  const cells = useRef(new Map<string, HTMLInputElement>())
  /** Text in a cell that differs from its quantity while it is being typed (a blank, or not a whole number yet). */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  /** The quantity a cell had when it was entered — Escape puts it back. */
  const entered = useRef<{ key: string; quantity: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [note, setNote] = useState('')

  const offered = useMemo(() => sizeGridOffered(colours, sizes), [colours, sizes])
  const totals = useMemo(() => sizeGridTotals(value, colours, sizes, max), [value, colours, sizes, max])
  const maxText = formatSizeGridQuantity(max, locale)
  const fmt = (n: number) => formatSizeGridQuantity(n, locale)

  const focusCell = (row: number, col: number) => {
    const el = cells.current.get(keyOf(row, col))
    if (!el) return
    el.focus()
    el.select()
  }

  const announceTotals = (next: SizeGridValue, row: number, col: number) => {
    const t = sizeGridTotals(next, colours, sizes, max)
    const c = colours[row]
    const s = sizes[col]
    setAnnouncement(copy.totalsAnnouncement({ colour: c.label, rowTotal: fmt(t.rows[c.key] ?? 0), size: s.label, columnTotal: fmt(t.columns[s.key] ?? 0), grand: fmt(t.grand) }))
  }

  const commit = (row: number, col: number, quantity: number) => {
    const next = setSizeGridCell(value, colours, sizes, colours[row].key, sizes[col].key, quantity, max)
    onChange(next)
    announceTotals(next, row, col)
  }

  const setDraft = (key: string, text: string | null) =>
    setDrafts((d) => {
      if (text === null) {
        if (!(key in d)) return d
        const rest = { ...d }
        delete rest[key]
        return rest
      }
      return d[key] === text ? d : { ...d, [key]: text }
    })

  const onCellChange = (row: number, col: number, text: string) => {
    const key = keyOf(row, col)
    const cell = copy.cellName(colours[row].label, sizes[col].label)
    const n = parseSizeGridQuantity(text)
    if (n === null) {
      setDraft(key, text)
      setNote(copy.notWhole(cell, maxText))
      return
    }
    const q = clampSizeGridQuantity(n, max)
    if (q !== n && n > 0) setNote(copy.cutToMax(cell, maxText))
    else setNote('')
    // Keep what was typed while it reads as the quantity ('' and '007' stay as typed); show the quantity otherwise.
    setDraft(key, q === n && text !== String(q) ? text : null)
    commit(row, col, q)
  }

  const onCellKeyDown = (e: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    const input = e.currentTarget
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? 0
    const len = input.value.length
    const all = start === 0 && end === len
    let dir: SizeGridDirection | null = null
    if (e.altKey || e.ctrlKey || e.metaKey) return
    switch (e.key) {
      case 'ArrowUp':
        dir = 'up'
        break
      case 'ArrowDown':
        dir = 'down'
        break
      case 'ArrowLeft':
        if (all || (start === 0 && end === 0)) dir = 'left'
        break
      case 'ArrowRight':
        if (all || (start === len && end === len)) dir = 'right'
        break
      case 'Enter':
        dir = e.shiftKey ? 'up' : 'down'
        break
      case 'Escape': {
        const key = keyOf(row, col)
        const was = entered.current?.key === key ? entered.current.quantity : null
        const now = sizeGridCell(value, colours[row], sizes[col].key, max)
        if (was === null || (was === now && !(key in drafts))) return // nothing to put back: let a dialog close
        e.preventDefault()
        e.stopPropagation()
        setDraft(key, null)
        setNote('')
        if (was !== now) commit(row, col, was)
        requestAnimationFrame(() => input.select())
        return
      }
      default:
        return
    }
    if (!dir) return
    e.preventDefault()
    const next = sizeGridStep(offered, { row, col }, dir)
    if (next) focusCell(next.row, next.col)
  }

  const onCellPaste = (e: ClipboardEvent<HTMLInputElement>, row: number, col: number) => {
    const text = e.clipboardData.getData('text/plain')
    e.preventDefault()
    const result = pasteIntoSizeGrid(value, colours, sizes, { colour: colours[row].key, size: sizes[col].key }, text, max)
    setDrafts({})
    const values = result.applied + result.notOffered + result.outside + result.invalid
    if (result.applied) {
      onChange(result.value)
      announceTotals(result.value, row, col)
    }
    // One value that landed is ordinary typing: no note. A block, or anything that did not land, is said.
    if (values > 1 || result.applied !== values || result.clamped) {
      const said = copy.pasteResult(result)
      setNote(said)
      setAnnouncement(said)
    } else setNote('')
  }

  const issueLines: SizeGridIssueLine[] = []
  const issueIds = new Map<string, string[]>()
  ;(issues ?? []).forEach((issue, i) => {
    const row = colours.findIndex((c) => c.key === issue.colour)
    if (row < 0) return
    const col = issue.size == null ? -1 : sizes.findIndex((s) => s.key === issue.size)
    if (issue.size != null && col < 0) return
    const id = `${uid}-issue-${i}`
    const cellKey = col < 0 ? `row:${row}` : keyOf(row, col)
    issueIds.set(cellKey, [...(issueIds.get(cellKey) ?? []), id])
    const takesFocus = col >= 0 && offered[row][col] && !mtm
    issueLines.push({
      id,
      issue,
      where: col < 0 ? colours[row].label : copy.cellName(colours[row].label, sizes[col].label),
      onGo: takesFocus ? () => focusCell(row, col) : undefined,
    })
  })

  return (
    <div className={['nds-size-grid', className].filter(Boolean).join(' ')} data-mode="edit">
      {onMtmChange ? (
        <label className="nds-size-grid-mtm" htmlFor={mtmId}>
          <Toggle id={mtmId} checked={mtm} onChange={onMtmChange} />
          <span>{copy.mtmSwitch}</span>
        </label>
      ) : null}

      {mtm ? (
        <div className="nds-size-grid-mtm-body">
          <p className="nds-size-grid-mtm-hint">{copy.mtmHint}</p>
          {mtmSlot}
        </div>
      ) : empty ? (
        <p className="nds-size-grid-note">{copy.empty}</p>
      ) : (
        <>
          {curves?.length ? (
            <CurveFill colours={colours} sizes={sizes} value={value} curves={curves} max={max} copy={copy} locale={locale} onFill={(next, said) => {
              setDrafts({})
              onChange(next)
              setNote(said)
              setAnnouncement(said)
            }} />
          ) : null}
          {/* Shown outside the scroll box, so it never scrolls away with the sizes; the <caption> names the table. */}
          {showCaption ? (
            <p className="nds-size-grid-caption" aria-hidden>
              {caption ?? copy.caption}
            </p>
          ) : null}
          <SizeGridScroll scrollRef={scrollRef} labelledBy={captionId} focusable={overflowing}>
            <table className="nds-size-grid-table">
              <caption id={captionId} className="nds-vh">
                {caption ?? copy.caption}
              </caption>
              <SizeGridHead sizes={sizes} copy={copy} />
              <tbody>
                {colours.map((c, row) => {
                  const rowIssues = sizeGridIssuesFor(issues, c.key, null)
                  return (
                    <tr key={c.key}>
                      <SizeGridRowHead colour={c} tone={sizeGridIssueTone(rowIssues)} describedBy={issueIds.get(`row:${row}`)?.join(' ')} />
                      {sizes.map((s, col) => {
                        const name = copy.cellName(c.label, s.label)
                        if (!sizeGridOffers(c, s.key)) {
                          return (
                            <td key={s.key} className="nds-size-grid-off">
                              <span aria-hidden>–</span>
                              <span className="nds-vh">{`${name}: ${copy.notOffered}`}</span>
                            </td>
                          )
                        }
                        const key = keyOf(row, col)
                        const q = sizeGridCell(value, c, s.key, max)
                        const cellIssues = sizeGridIssuesFor(issues, c.key, s.key)
                        const notWhole = key in drafts && parseSizeGridQuantity(drafts[key]) === null
                        const tone = notWhole ? 'error' : sizeGridIssueTone(cellIssues)
                        const describedBy = [...(issueIds.get(key) ?? []), ...(notWhole ? [noteId] : [])].join(' ') || undefined
                        const text = drafts[key] ?? String(q)
                        return (
                          <td key={s.key} className="nds-size-grid-cell" data-tone={tone ?? undefined}>
                            <input
                              ref={(el) => {
                                if (el) cells.current.set(key, el)
                                else cells.current.delete(key)
                              }}
                              className="nds-size-grid-input"
                              type="text"
                              inputMode="numeric"
                              autoComplete="off"
                              spellCheck={false}
                              aria-label={name}
                              aria-invalid={tone === 'error' ? true : undefined}
                              aria-describedby={describedBy}
                              data-zero={q === 0 && !(key in drafts) ? '' : undefined}
                              value={text}
                              onFocus={(e) => {
                                entered.current = { key, quantity: q }
                                e.currentTarget.select()
                              }}
                              onBlur={() => {
                                if (key in drafts) {
                                  setDraft(key, null)
                                  if (parseSizeGridQuantity(drafts[key]) === null) setNote('')
                                }
                              }}
                              onChange={(e) => onCellChange(row, col, e.currentTarget.value)}
                              onKeyDown={(e) => onCellKeyDown(e, row, col)}
                              onPaste={(e) => onCellPaste(e, row, col)}
                            />
                            {tone ? (
                              <span className="nds-size-grid-mark">
                                <SizeGridIssueGlyph tone={tone} size={10} />
                              </span>
                            ) : null}
                          </td>
                        )
                      })}
                      <td className="nds-size-grid-num nds-size-grid-total">{fmt(totals.rows[c.key] ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <SizeGridFoot sizes={sizes} totals={totals} copy={copy} locale={locale} />
            </table>
          </SizeGridScroll>
          {note ? (
            <p className="nds-size-grid-note" id={noteId}>
              {note}
            </p>
          ) : null}
        </>
      )}

      <SizeGridIssueList lines={issueLines} heading={copy.issuesHeading} />
      <div role="status" className="nds-vh">
        {announcement}
      </div>
    </div>
  )
}

/* ── curve fill ──────────────────────────────────────────────────────────────────────────── */

function CurveFill({
  colours,
  sizes,
  value,
  curves,
  max,
  copy,
  locale,
  onFill,
}: {
  colours: readonly SizeGridColour[]
  sizes: readonly SizeGridSize[]
  value: SizeGridValue
  curves: readonly SizeGridCurve[]
  max: number
  copy: SizeGridCopy
  locale?: string
  onFill: (next: Record<string, Record<string, number>>, said: string) => void
}) {
  const [target, setTarget] = useState<string>(colours.length > 1 ? EVERY : (colours[0]?.key ?? EVERY))
  const [totalText, setTotalText] = useState('')
  const [curveKey, setCurveKey] = useState(curves[0]?.key ?? '')
  const curve = curves.find((c) => c.key === curveKey) ?? curves[0]
  const colourKeys = target === EVERY ? colours.map((c) => c.key) : [target]
  const parsed = totalText.trim() === '' ? null : parseSizeGridQuantity(totalText)
  const total = parsed !== null && parsed >= 0 ? parsed : null
  const result = total === null || !curve ? null : curveFillSizeGrid(value, colours, sizes, { colourKeys, total, curve }, max)
  const maxText = formatSizeGridQuantity(max, locale)
  const held =
    total === null
      ? copy.curveNeedsTotal
      : result && !result.ok
        ? copy.curveRefused(result.reason, colours.find((c) => c.key === result.colour)?.label ?? '', maxText)
        : null
  const totalError = totalText.trim() !== '' && total === null ? copy.curveNeedsTotal : null
  const uid = useId()
  const sharesId = `${uid}-shares`
  const errorId = `${uid}-error`
  const shares = curve ? curveShareText(curve, sizes) : ''

  // No Field hint or error: a line under one control would push the Fill button off the controls' baseline. The
  // shares and the error sit under the whole row, tied to their controls by aria-describedby.
  return (
    <div className="nds-size-grid-curve-wrap">
      <div className="nds-size-grid-curve">
        <Field label={copy.curveColour} className="nds-size-grid-curve-colour">
          <Select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
            {colours.length > 1 ? <option value={EVERY}>{copy.everyColour}</option> : null}
            {colours.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={copy.curveTotal} className="nds-size-grid-curve-total">
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={totalText}
            aria-invalid={totalError ? true : undefined}
            aria-describedby={totalError ? errorId : undefined}
            onChange={(e) => setTotalText(e.currentTarget.value)}
          />
        </Field>
        <Field label={copy.curvePick} className="nds-size-grid-curve-pick">
          <Select value={curve?.key ?? ''} aria-describedby={shares ? sharesId : undefined} onChange={(e) => setCurveKey(e.currentTarget.value)}>
            {curves.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          heldReason={held}
          onClick={() => {
            if (!result?.ok || total === null || !curve) return
            const names = target === EVERY ? copy.everyColour.toLowerCase() : (colours.find((c) => c.key === target)?.label ?? '')
            onFill(result.value, copy.curveFilled({ colours: names, total: formatSizeGridQuantity(total, locale), curve: curve.label }))
          }}
        >
          {copy.curveButton}
        </Button>
      </div>
      {totalError ? (
        <p className="nds-size-grid-error" id={errorId}>
          <SizeGridIssueGlyph tone="error" size={14} />
          <span>{totalError}</span>
        </p>
      ) : null}
      {shares ? (
        <p className="nds-size-grid-note" id={sharesId}>
          {`${curve?.label}: ${shares}`}
        </p>
      ) : null}
    </div>
  )
}
