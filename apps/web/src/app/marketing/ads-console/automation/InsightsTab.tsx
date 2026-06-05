'use client'

/**
 * RC6.6 — Insights. One reporting surface that merges the five formerly-separate
 * tabs (Analytics/Performance · Efficiency · Anomalies · Health · Competitive)
 * behind a single sub-nav. Each pane is the existing, proven component — this is
 * a faithful merge (no functionality changed), just unified navigation so the
 * operator stops hunting across five top-level tabs. Legacy ?tab= keys deep-link
 * straight to the matching pane via initialView.
 */

import { useState } from 'react'
import { BarChart3, Gauge, AlertTriangle, HeartPulse, Swords } from 'lucide-react'
import { AnalyticsTab } from './AnalyticsTab'
import { EfficiencyTab } from './EfficiencyTab'
import { AnomalyTab } from './AnomalyTab'
import { HealthTab } from './HealthTab'
import { SovTab } from './SovTab'

const VIEWS = [
  { k: 'performance', label: 'Performance', Icon: BarChart3, Comp: AnalyticsTab, blurb: 'Spend, sales, ACOS & ROAS trends across your campaigns.' },
  { k: 'efficiency', label: 'Efficiency', Icon: Gauge, Comp: EfficiencyTab, blurb: 'Where every euro goes — wasted spend, harvest gains, profit lift.' },
  { k: 'anomalies', label: 'Anomalies', Icon: AlertTriangle, Comp: AnomalyTab, blurb: 'Sudden swings the engine flagged for a closer look.' },
  { k: 'health', label: 'Health', Icon: HeartPulse, Comp: HealthTab, blurb: 'Account & campaign health signals at a glance.' },
  { k: 'competitive', label: 'Competitive', Icon: Swords, Comp: SovTab, blurb: 'Share-of-voice and where rivals are winning impressions.' },
] as const

export function InsightsTab({ initialView = 'performance' }: { initialView?: string }) {
  const [view, setView] = useState(VIEWS.some((v) => v.k === initialView) ? initialView : 'performance')
  const active = VIEWS.find((v) => v.k === view) ?? VIEWS[0]
  const Active = active.Comp

  return (
    <div className="az-ins" style={{ paddingTop: 4 }}>
      <div className="az-ins-nav" role="tablist" aria-label="Insights views">
        {VIEWS.map((v) => (
          <button key={v.k} role="tab" aria-selected={view === v.k} className={`az-ins-tab ${view === v.k ? 'on' : ''}`} onClick={() => setView(v.k)}>
            <v.Icon size={14} />{v.label}
          </button>
        ))}
      </div>
      <div className="az-ins-blurb">{active.blurb}</div>
      <Active />
    </div>
  )
}
