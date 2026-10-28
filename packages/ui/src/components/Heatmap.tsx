import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { firstHeatCell, heatAlpha, heatCellWords, heatKey, heatLabelWidth, heatMax, heatMove, isHeatMarked, isHeatPressable } from './heatmapModel'

export interface HeatmapProps {
  /**
   * Values as rows × cols. `null` means NO MEASUREMENT for that cell, which is not the same as a
   * measured zero and must not look like one: a null renders as a hatched cell rather than the
   * palest shade of the ramp. On a dayparting grid the difference is the whole point — "we hold
   * no data for Sunday 03:00" and "nothing was spent at Sunday 03:00" lead to opposite decisions.
   */
  data: Array<Array<number | null>>
  rowLabels: string[]
  colLabels?: string[]
  /**
   * Full names for the tooltip, when `colLabels` is deliberately sparse.
   *
   * A 24-column axis can only carry a label every few columns before they collide, so callers
   * pass blanks for the rest — and the tooltip, built from the same array, then said
   * "Sun · : 4 days" for two cells out of three. On a grid whose entire question is WHICH HOUR,
   * that is the one thing it must not leave out. Defaults to `colLabels`, so a caller with a
   * fully-labelled axis passes nothing.
   */
  colTitles?: string[]
  format?: (v: number) => string
  /** Shown in a cell's tooltip where the value is null. */
  emptyLabel?: string
  /**
   * Cells to outline, keyed `"row:col"` (Reviews parts, 2026-10-26): the send-hour grid marks the hour each day sends at.
   * The outline sits on top of the shade, so the value still shows.
   */
  marked?: ReadonlySet<string>
  /** A cell's words (its tooltip). Default "Mon · 14:00: 12", or `emptyLabel` for a null. Say the mark here too. */
  cellWords?: (row: number, col: number, value: number | null) => string
  /**
   * The row-label column's width in px (Reviews Insights, 2026-10-26; default 36, a weekday). Theme names need about 120;
   * the column headers move with it (`--nds-heat-lbl-w`).
   */
  labelWidth?: number
  /**
   * Makes every measured cell a button named by its words (`cellWords`) that calls this (Reviews Insights: a cell opens
   * the Inbox for that day and theme). The map is then ONE Tab stop: the arrows move between measured cells, Home / End
   * go to a row's ends, Enter or Space presses. A null cell has nothing to open and stays a plain cell.
   */
  onCellClick?: (row: number, col: number) => void
  /** The map's name for a reader when its cells are buttons ("When themes come up"). */
  label?: string
  className?: string
}

/** Intensity heatmap (H10 dayparting): cell opacity scales with value/max. */
export function Heatmap({ data, rowLabels, colLabels, colTitles, format, emptyLabel = 'no data', marked, cellWords, labelWidth, onCellClick, label, className }: HeatmapProps) {
  // Nulls are excluded from the scale — one absent cell must not flatten the whole ramp.
  const max = heatMax(data)
  const cellColor = (v: number) => `rgba(31, 111, 222, ${heatAlpha(v, max).toFixed(3)})`
  // Falls back to the axis label, so a fully-labelled axis needs no second array.
  const colName = (c: number) => colTitles?.[c] ?? colLabels?.[c] ?? ''
  const words = (r: number, c: number, v: number | null) => (cellWords ? cellWords(r, c, v) : heatCellWords(rowLabels[r], colName(c), v, format, emptyLabel))
  // One Tab stop for a pressable map: the cell last moved to, else the first measured one.
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null)
  const cells = useRef(new Map<string, HTMLButtonElement>())
  const first = onCellClick ? firstHeatCell(data) : null
  const tabStop = focus && isHeatPressable(data[focus.row]?.[focus.col]) ? focus : first
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, r: number, c: number) => {
    const next = heatMove(data, r, c, event.key)
    if (!next) return
    event.preventDefault()
    setFocus(next)
    cells.current.get(heatKey(next.row, next.col))?.focus()
  }
  const style = labelWidth != null ? ({ '--nds-heat-lbl-w': `${heatLabelWidth(labelWidth)}px` } as CSSProperties) : undefined
  return (
    <div
      className={`nds-heat${onCellClick ? ' is-pressable' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      role={onCellClick ? 'group' : undefined}
      aria-label={onCellClick ? label : undefined}
    >
      {colLabels && (
        <div className="nds-heat-cols" aria-hidden={onCellClick ? true : undefined}>
          {colLabels.map((c, i) => (
            <span key={i} className="nds-heat-col">
              {c}
            </span>
          ))}
        </div>
      )}
      {data.map((row, r) => (
        <div className="nds-heat-row" key={r}>
          <span className="nds-heat-lbl" title={rowLabels[r]}>{rowLabels[r]}</span>
          {row.map((v, c) => {
            const cls = `nds-heat-cell${v == null ? ' is-empty' : ''}${isHeatMarked(marked, r, c) ? ' is-marked' : ''}`
            const shade = v == null ? undefined : { background: cellColor(v) }
            const text = words(r, c, v)
            if (onCellClick && isHeatPressable(v)) {
              const key = heatKey(r, c)
              return (
                <button
                  key={c}
                  type="button"
                  ref={(el) => {
                    if (el) cells.current.set(key, el)
                    else cells.current.delete(key)
                  }}
                  className={`${cls} is-button`}
                  style={shade}
                  title={text}
                  aria-label={text}
                  tabIndex={tabStop && tabStop.row === r && tabStop.col === c ? 0 : -1}
                  onFocus={() => setFocus({ row: r, col: c })}
                  onKeyDown={(event) => onKey(event, r, c)}
                  onClick={() => onCellClick(r, c)}
                />
              )
            }
            return <span key={c} className={cls} style={shade} title={text} />
          })}
        </div>
      ))}
    </div>
  )
}
