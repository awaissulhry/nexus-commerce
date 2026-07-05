export interface HeatmapProps {
  /** values as rows × cols */
  data: number[][]
  rowLabels: string[]
  colLabels?: string[]
  format?: (v: number) => string
  className?: string
}

/** Intensity heatmap (H10 dayparting): cell opacity scales with value/max. */
export function Heatmap({ data, rowLabels, colLabels, format, className }: HeatmapProps) {
  const max = Math.max(...data.flat(), 1)
  const cellColor = (v: number) => `rgba(31, 111, 222, ${(0.05 + (v / max) * 0.95).toFixed(3)})`
  return (
    <div className={`h10-ds-heat${className ? ` ${className}` : ''}`}>
      {colLabels && (
        <div className="h10-ds-heat-cols">
          {colLabels.map((c, i) => (
            <span key={i} className="h10-ds-heat-col">
              {c}
            </span>
          ))}
        </div>
      )}
      {data.map((row, r) => (
        <div className="h10-ds-heat-row" key={r}>
          <span className="h10-ds-heat-lbl">{rowLabels[r]}</span>
          {row.map((v, c) => (
            <span
              key={c}
              className="h10-ds-heat-cell"
              style={{ background: cellColor(v) }}
              title={`${rowLabels[r]}${colLabels ? ' · ' + colLabels[c] : ''}: ${format ? format(v) : v}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
