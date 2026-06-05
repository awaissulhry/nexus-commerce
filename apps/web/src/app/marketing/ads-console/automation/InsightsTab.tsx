'use client'

/**
 * RC6.6 + RC6.8 — Insights. One surface that merges the five formerly-separate
 * reporting tabs (Performance · Efficiency · Anomalies · Health · Competitive)
 * AND the search-term/schedule tools (Dayparting · Harvest · Negatives) behind a
 * single sub-nav (a "Tools" divider separates reports from action tools). Each
 * pane is the existing, proven component — a faithful merge, just unified
 * navigation. Legacy ?tab= keys deep-link straight to the matching pane.
 */

import { Fragment, useEffect, useState } from 'react'
import { BarChart3, Gauge, AlertTriangle, HeartPulse, Swords, Clock, Sprout, Ban } from 'lucide-react'
import { AnalyticsTab } from './AnalyticsTab'
import { EfficiencyTab } from './EfficiencyTab'
import { AnomalyTab } from './AnomalyTab'
import { HealthTab } from './HealthTab'
import { SovTab } from './SovTab'
import { DaypartingTab } from './DaypartingTab'
import { HarvestTab } from './HarvestTab'
import { NegativeMiningTab } from './NegativeMiningTab'

const VIEWS = [
  { k: 'performance', label: 'Performance', Icon: BarChart3, Comp: AnalyticsTab, blurb: 'Spend, sales, ACOS & ROAS trends across your campaigns.', kind: 'report' },
  { k: 'efficiency', label: 'Efficiency', Icon: Gauge, Comp: EfficiencyTab, blurb: 'Where every euro goes — wasted spend, harvest gains, profit lift.', kind: 'report' },
  { k: 'anomalies', label: 'Anomalies', Icon: AlertTriangle, Comp: AnomalyTab, blurb: 'Sudden swings the engine flagged for a closer look.', kind: 'report' },
  { k: 'health', label: 'Health', Icon: HeartPulse, Comp: HealthTab, blurb: 'Account & campaign health signals at a glance.', kind: 'report' },
  { k: 'competitive', label: 'Competitive', Icon: Swords, Comp: SovTab, blurb: 'Share-of-voice and where rivals are winning impressions.', kind: 'report' },
  { k: 'dayparting', label: 'Dayparting', Icon: Clock, Comp: DaypartingTab, blurb: 'Set hour-of-day bid multipliers — bid more when shoppers convert, less when they don’t.', kind: 'tool' },
  { k: 'harvest', label: 'Harvest terms', Icon: Sprout, Comp: HarvestTab, blurb: 'Mine converting search terms and promote them to their own keywords.', kind: 'tool' },
  { k: 'negatives', label: 'Negatives', Icon: Ban, Comp: NegativeMiningTab, blurb: 'Find wasteful search terms and block them as negatives.', kind: 'tool' },
] as const

export function InsightsTab({ initialView = 'performance' }: { initialView?: string }) {
  const [view, setView] = useState(VIEWS.some((v) => v.k === initialView) ? initialView : 'performance')
  // Sync the pane when the URL-driven initialView changes (e.g. a legacy deep-link
  // → clicking the left "Insights" nav). Internal sub-tab clicks don't change
  // initialView, so they're preserved.
  useEffect(() => { if (VIEWS.some((v) => v.k === initialView)) setView(initialView) }, [initialView])
  const active = VIEWS.find((v) => v.k === view) ?? VIEWS[0]
  const Active = active.Comp

  return (
    <div className="az-ins" style={{ paddingTop: 4 }}>
      <div className="az-ins-nav" role="tablist" aria-label="Insights & tools">
        {VIEWS.map((v, i) => (
          <Fragment key={v.k}>
            {v.kind === 'tool' && VIEWS[i - 1]?.kind === 'report' && <span className="az-ins-div" aria-hidden="true">Tools</span>}
            <button role="tab" aria-selected={view === v.k} className={`az-ins-tab ${view === v.k ? 'on' : ''}`} onClick={() => setView(v.k)}>
              <v.Icon size={14} />{v.label}
            </button>
          </Fragment>
        ))}
      </div>
      <div className="az-ins-blurb">{active.blurb}</div>
      <Active />
    </div>
  )
}
