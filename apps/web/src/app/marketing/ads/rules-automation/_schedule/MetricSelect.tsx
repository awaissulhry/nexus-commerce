'use client'

/** Metric dropdown with the H10 colour dot inside the box (Metric 1 navy, Metric 2 blue).
 *  Shared by the schedule builder's chart controls and the list-tab Hourly Performance card. */
import { H10Select } from '../../campaigns/FilterDropdown'
import { CHART_METRICS } from './scheduleConfig'

export function MetricSelect({ value, onChange, dot, label, width = 150 }: { value: string; onChange: (v: string) => void; dot: string; label: string; width?: number }) {
  return (
    <span className="h10-sb-metric">
      <span className="dot" style={{ background: dot }} />
      <H10Select width={width} options={CHART_METRICS} value={value} onChange={onChange} ariaLabel={label} />
    </span>
  )
}
