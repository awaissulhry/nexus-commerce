'use client'

/**
 * RC.2 — the Rule Setting "Control preview". Renders the SAME shared AutopilotCanvas (RC.1) the AI
 * Control step uses, but driven by the Rule-Setting config: Signals → Bid Strategy → rule levers
 * (Harvest · Negate · Product · Bid) → Performance Criteria → Actions. Clicking a lever edits the
 * underlying rule config (harvest/negate Automate, bid strategy on/off, product graduation), so the
 * operator can manage + optimise the whole set straight from the canvas.
 */
import type { Dispatch, SetStateAction } from 'react'
import { InfoTip } from '../../campaigns/InfoTip'
import { AutopilotCanvas, type CanvasSpec } from '../../autopilot/AutopilotCanvas'
import type { RulesConfig, BidConfig } from './LaunchStep'
import type { SpwCampaign } from './CampaignSetup'

const BID_LABEL: Record<string, string> = { maxImpressions: 'Max Impressions', targetAcos: 'Target ACoS', maxOrders: 'Max Orders', custom: 'Custom', none: 'None' }
const emptyRow = () => ({ st: false, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: false, nBox: false })

export function RuleControlPanel({ rules, setRules, bidConfig, setBidConfig, campaigns }: {
  rules: { harvest: RulesConfig; negative: RulesConfig }
  setRules: Dispatch<SetStateAction<{ harvest: RulesConfig; negative: RulesConfig }>>
  bidConfig: BidConfig
  setBidConfig: Dispatch<SetStateAction<BidConfig>>
  campaigns: SpwCampaign[]
}) {
  const h = rules.harvest, n = rules.negative
  const nSources = Object.values(h.sel).filter((s) => s.st).length
  const anyProduct = Object.values(h.sel).some((s) => s.tBox)
  const conds = h.perf?.conditions ?? []
  const perfSub = conds.length
    ? `${conds[0].metric ?? 'threshold'} ${conds[0].value || ''}`.trim() + (conds.length > 1 ? ` +${conds.length - 1}` : '')
    : 'optional'
  const bidOn = bidConfig.strategy !== 'none'
  const bidLabel = BID_LABEL[bidConfig.strategy] ?? 'None'

  const spec: CanvasSpec = {
    signals: [
      { id: 'rc-terms', label: 'Search terms', sub: 'converting · wasteful' },
      { id: 'rc-src', label: 'Source ad groups', sub: nSources ? `${nSources} harvested` : 'none selected' },
      { id: 'rc-perf', label: 'Performance', sub: 'spend · orders · ACoS' },
    ],
    goalEyebrow: 'Bid Strategy',
    goalLabel: bidLabel,
    modules: [
      { key: 'harvest', label: 'Keyword Harvest', sub: 'auto → exact / phrase', on: h.automate },
      { key: 'negate', label: 'Negative Targeting', sub: 'isolate + waste', on: n.automate },
      { key: 'product', label: 'Product Targets', sub: 'ASIN harvest', on: anyProduct },
      { key: 'bid', label: 'Bid Strategy', sub: bidLabel, on: bidOn },
    ],
    guardrailLabel: 'Performance Criteria',
    guardrailSub: perfSub,
    outputLabel: 'Actions',
    outputSub: 'targets + negatives · write-gated',
  }

  // Interactive — clicking a lever edits the underlying rule config.
  const onToggle = (key: string) => {
    if (key === 'harvest') setRules((r) => ({ ...r, harvest: { ...r.harvest, automate: !r.harvest.automate } }))
    else if (key === 'negate') setRules((r) => ({ ...r, negative: { ...r.negative, automate: !r.negative.automate } }))
    else if (key === 'bid') setBidConfig((b) => ({ ...b, strategy: b.strategy === 'none' ? 'targetAcos' : 'none' }))
    else if (key === 'product') setRules((r) => {
      const turnOn = !Object.values(r.harvest.sel).some((s) => s.tBox) // bulk: flip product graduation on the PAT rows
      const sel = { ...r.harvest.sel }
      for (const c of campaigns) {
        if (!c.id) continue
        sel[c.id] = { ...(sel[c.id] ?? emptyRow()), tBox: turnOn && c.kind === 'pat' }
      }
      return { ...r, harvest: { ...r.harvest, sel } }
    })
  }

  return (
    <div className="h10-spw-card">
      <h3>Control preview <InfoTip tip="The same control canvas as AI Control, driven by your rules. Click a lever to turn it on or off." /></h3>
      <p className="h10-spw-desc">How these rules run this set: Signals → Bid Strategy → rule levers → Performance Criteria → Actions. Click a lever to manage it.</p>
      <AutopilotCanvas spec={spec} onToggleModule={onToggle} compact />
    </div>
  )
}
