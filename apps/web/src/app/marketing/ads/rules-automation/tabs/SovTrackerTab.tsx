'use client'

/**
 * SovTrackerTab — the "Share of Voice" and "Keyword Tracker" sub-tabs.
 *
 * Each is both a *rule* type (a keyword-bid-adjustment rule driven by SOV / rank data) and a
 * *report* (the SOV / keyword-tracker data table). So the tab carries a [Rules | Report]
 * segmented toggle: "Rules" lists the live rules of this type through the shared RuleListTab
 * (so a rule you just created is visible + manageable), and "Report" shows the data table.
 *
 * Rules-first by default: the tab's primary job here is automation, and a freshly-created rule
 * should be on screen. The report is one click away. Shared by both kinds (slug + copy differ).
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { RuleListTab } from './RuleListTab'
import { TrackerTab } from './TrackerTab'
import { NoDataIllus } from '../_shared/NoDataIllus'

const CONFIG = {
  sov: {
    slug: 'sov',
    noun: 'SOV Rule',
    empty: 'Create an SOV Rule to adjust keyword bids from Share-of-Voice data!',
  },
  tracker: {
    slug: 'keyword-tracker',
    noun: 'Keyword Tracker Rule',
    empty: 'Create a Keyword Tracker Rule to adjust keyword bids from organic & paid rank!',
  },
} as const

export function SovTrackerTab({ kind }: { kind: 'sov' | 'tracker' }) {
  const [view, setView] = useState<'rules' | 'report'>('rules')
  const cfg = CONFIG[kind]
  const builderHref = `/marketing/ads/rules-automation/builder/${cfg.slug}`

  return (
    <div className="h10-svt">
      <div className="h10-svt-seg" role="tablist" aria-label={`${cfg.noun} view`}>
        <button type="button" role="tab" aria-selected={view === 'rules'} className={`seg ${view === 'rules' ? 'on' : ''}`} onClick={() => setView('rules')}>Rules</button>
        <button type="button" role="tab" aria-selected={view === 'report'} className={`seg ${view === 'report' ? 'on' : ''}`} onClick={() => setView('report')}>Report</button>
      </div>
      {view === 'rules' ? (
        <RuleListTab
          noun={cfg.noun}
          seed={[]}
          liveType={cfg.slug}
          editHref={(id) => `${builderHref}?ruleId=${id}`}
          onAddRule={() => { window.location.href = builderHref }}
          emptyNode={(
            <span className="h10-rr-empty">
              <NoDataIllus size={104} />
              <b>{cfg.empty}</b>
              <a className="h10-am-btn primary" href={builderHref}><Plus size={13} /> Create Rule</a>
            </span>
          )}
        />
      ) : (
        <TrackerTab kind={kind} />
      )}
    </div>
  )
}
