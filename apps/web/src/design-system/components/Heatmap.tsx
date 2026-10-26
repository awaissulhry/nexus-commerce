import { heatAlpha, heatCellWords, heatMax, isHeatMarked } from './heatmapModel'

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
  className?: string
}

/** Intensity heatmap (H10 dayparting): cell opacity scales with value/max. */
export function Heatmap({ data, rowLabels, colLabels, colTitles, format, emptyLabel = 'no data', marked, cellWords, className }: HeatmapProps) {
  // Nulls are excluded from the scale — one absent cell must not flatten the whole ramp.
  const max = heatMax(data)
  const cellColor = (v: number) => `rgba(31, 111, 222, ${heatAlpha(v, max).toFixed(3)})`
  // Falls back to the axis label, so a fully-labelled axis needs no second array.
  const colName = (c: number) => colTitles?.[c] ?? colLabels?.[c] ?? ''
  return (
    <div className={`nds-heat${className ? ` ${className}` : ''}`}>
      {colLabels && (
        <div className="nds-heat-cols">
          {colLabels.map((c, i) => (
            <span key={i} className="nds-heat-col">
              {c}
            </span>
          ))}
        </div>
      )}
      {data.map((row, r) => (
        <div className="nds-heat-row" key={r}>
          <span className="nds-heat-lbl">{rowLabels[r]}</span>
          {row.map((v, c) => (
            <span
              key={c}
              className={`nds-heat-cell${v == null ? ' is-empty' : ''}${isHeatMarked(marked, r, c) ? ' is-marked' : ''}`}
              style={v == null ? undefined : { background: cellColor(v) }}
              title={cellWords ? cellWords(r, c, v) : heatCellWords(rowLabels[r], colName(c), v, format, emptyLabel)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
