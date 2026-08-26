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
  className?: string
}

/** Intensity heatmap (H10 dayparting): cell opacity scales with value/max. */
export function Heatmap({ data, rowLabels, colLabels, colTitles, format, emptyLabel = 'no data', className }: HeatmapProps) {
  // Nulls are excluded from the scale — one absent cell must not flatten the whole ramp.
  const max = Math.max(...data.flat().filter((v): v is number => v != null), 1)
  const cellColor = (v: number) => `rgba(31, 111, 222, ${(0.05 + (v / max) * 0.95).toFixed(3)})`
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
              className={`nds-heat-cell${v == null ? ' is-empty' : ''}`}
              style={v == null ? undefined : { background: cellColor(v) }}
              title={`${rowLabels[r]}${colName(c) ? ' · ' + colName(c) : ''}: ${v == null ? emptyLabel : (format ? format(v) : v)}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
