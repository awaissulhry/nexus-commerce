import type { ReactNode } from 'react'

export interface Metric {
  label: ReactNode
  value: ReactNode
  /** optional change indicator */
  delta?: { value: ReactNode; positive?: boolean }
}

export interface MetricStripProps {
  metrics: Metric[]
}

/** Row of KPI tiles (H10 metric strip). Auto-fits to the container width. */
export function MetricStrip({ metrics }: MetricStripProps) {
  return (
    <div className="h10-ds-metrics">
      {metrics.map((m, i) => (
        <div key={i} className="h10-ds-metric">
          <div className="lbl">{m.label}</div>
          <div className="val">{m.value}</div>
          {m.delta != null && <div className={`dlt ${m.delta.positive ? 'up' : 'down'}`}>{m.delta.value}</div>}
        </div>
      ))}
    </div>
  )
}
