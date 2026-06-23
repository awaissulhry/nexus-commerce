'use client'

/**
 * SPW.6 / AT.4a / S3 — Step 3 "Automation & Launch" (Helium 10 match), top-to-bottom:
 *  • Automation mode — Rule Setting / AI Control (DS RadioCard).
 *  • Bid Strategy — Max Impressions / Target ACoS / Max Orders / Custom / None (DS RadioCard),
 *    + conditional Target ACoS + Min/Max Bid (DS Input). The Helium 10 automation layer.
 *  • Product Group Details recap + Sponsored Campaign Set summary — driven by the strategy.
 *  • Rules — Keyword Harvesting / Negative Targeting (persisted at launch as AutomationRules).
 * AI Control collapses the manual config to an "AI handles it" note.
 */
import { type Dispatch, type SetStateAction, useState } from 'react'
import { ChevronDown, BarChart3 } from 'lucide-react'
import { RadioCard, Input } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import { InfoTip } from '../../campaigns/InfoTip'
import { pcDefaultGroup, type CriteriaGroup } from '../../rules-automation/_shared/PerformanceCriteria'
import { HarvestRules } from '../../_shared/HarvestRules'
import { PortfolioPicker } from './PortfolioPicker'
import { RuleControlPanel } from './RuleControlPanel'
import { AiControlPreview } from './AiControlPreview'
import type { SpwCampaign } from './CampaignSetup'
import { AiControlPanel, type AiControlConfig } from './AiControlPanel'
import { BidStrategyCardGrid, BID_STRATEGIES, defaultBidConfig, type BidConfig, type BidStrategy } from '../../_shared/BidStrategy'

const money = (cur: string, n: number) => `${cur}${n.toFixed(2)}`

function KindBadge({ kind }: { kind: SpwCampaign['kind'] }) {
  const auto = kind === 'auto'
  return <><span className={`h10-spw-kb ${auto ? 'a' : 'm'}`}>{auto ? 'A' : 'M'}</span><span className="h10-spw-spb">SP</span></>
}

export type RuleRowSel = { st: boolean; tB: boolean; tP: boolean; tE: boolean; tBox: boolean; nP: boolean; nE: boolean; nBox: boolean }
export const emptyRuleRow = (): RuleRowSel => ({ st: false, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: false, nBox: false })
export type RulesConfig = {
  ruleName: string
  automate: boolean
  sel: Record<string, RuleRowSel>
  perf: CriteriaGroup
}
export const defaultRulesConfig = (slug = 'keyword-harvesting'): RulesConfig => ({ ruleName: '', automate: true, sel: {}, perf: pcDefaultGroup(slug) })
/** True once the operator has set up a harvest rule worth persisting. */
export const rulesConfigured = (r: RulesConfig): boolean =>
  r.ruleName.trim().length > 0 || Object.values(r.sel).some((s) => s.st || s.tB || s.tP || s.tE || s.tBox || s.nP || s.nE || s.nBox)

// ── S3 — bid strategy: model + card selector now live in ../../_shared/BidStrategy (one
// source of truth shared with the Single Campaign builder). Re-exported so existing imports
// from './LaunchStep' (SpSuperWizard, RuleControlPanel) keep working unchanged.
export { defaultBidConfig }
export type { BidConfig, BidStrategy }

export function LaunchStep({ campaigns, productGroupName, productCount, currency, automationMode, setAutomationMode, bidConfig, setBidConfig, rules, setRules, portfolioId, setPortfolioId, aiControl, setAiControl }: {
  campaigns: SpwCampaign[]
  productGroupName: string
  productCount: number
  currency: string
  automationMode: 'rule' | 'ai'
  setAutomationMode: (m: 'rule' | 'ai') => void
  bidConfig: BidConfig
  setBidConfig: Dispatch<SetStateAction<BidConfig>>
  rules: { harvest: RulesConfig; negative: RulesConfig }
  setRules: Dispatch<SetStateAction<{ harvest: RulesConfig; negative: RulesConfig }>>
  portfolioId: string
  setPortfolioId: (id: string) => void
  aiControl: AiControlConfig
  setAiControl: (v: AiControlConfig) => void
}) {
  const [portfolioOpen, setPortfolioOpen] = useState(false)
  const ai = automationMode === 'ai'
  const setBid = (patch: Partial<BidConfig>) => setBidConfig((b) => ({ ...b, ...patch }))

  // Recap + summary values, driven by the chosen strategy (or AI).
  const strat = BID_STRATEGIES.find((s) => s.key === bidConfig.strategy)
  const stageLabel = ai ? 'AI Control' : bidConfig.strategy === 'none' ? 'None' : strat?.stage ?? '—'
  const algoLabel = ai ? 'AI' : bidConfig.strategy === 'none' ? 'None' : strat?.label ?? '—'
  const targetValue = ai ? 'AI' : bidConfig.strategy === 'targetAcos' && bidConfig.targetAcos.trim() ? `${bidConfig.targetAcos}%` : '—'

  return (
    <div className="h10-spw-launch">
      {/* Automation mode */}
      <div className="h10-spw-autom">
        <RadioCard name="spw-autom" title="Rule Setting" description="Manually add custom rules to these campaigns" selected={!ai} checked={!ai} onChange={() => setAutomationMode('rule')} />
        <RadioCard name="spw-autom" title="AI Control" description="Let AI run these campaigns automatically — handling bid adjustments, budget allocation." selected={ai} checked={ai} onChange={() => setAutomationMode('ai')} />
      </div>

      {ai ? (
        <AiControlPanel value={aiControl} onChange={setAiControl} />
      ) : (
        <>
          {/* Bid Strategy */}
          <div className="h10-spw-card">
            <h3>Bid Strategy <InfoTip tip="The Helium 10 bid algorithm applied to every campaign in this set." /></h3>
            <p className="h10-spw-desc">Select a bid algorithm based on your product &amp; campaign goals.</p>
            <BidStrategyCardGrid value={bidConfig} onChange={setBid} />
          </div>

          {bidConfig.strategy === 'targetAcos' && (
            <div className="h10-spw-card">
              <h3>Target ACoS <InfoTip tip="The advertising cost of sales the algorithm steers toward." /></h3>
              <p className="h10-spw-desc">Set a target ACoS value</p>
              <label className="h10-spw-bidfield"><span className="l">Target ACoS</span><Input inputMode="decimal" value={bidConfig.targetAcos} onChange={(e) => setBid({ targetAcos: e.target.value })} suffix="%" aria-label="Target ACoS" fieldClassName="h10-spw-bidnum" /></label>
            </div>
          )}

          {/* Min/Max Bid */}
          <div className="h10-spw-card">
            <h3>Min/Max Bid <InfoTip tip="Optional bounds — the algorithm never bids below Min or above Max." /></h3>
            <p className="h10-spw-desc">Set the floor and ceiling for automated bids (optional).</p>
            <div className="h10-spw-bidrow">
              <label className="h10-spw-bidfield"><span className="l">Min Bid</span><Input inputMode="decimal" value={bidConfig.minBid} onChange={(e) => setBid({ minBid: e.target.value })} prefix={currency} placeholder="Min" aria-label="Min bid" fieldClassName="h10-spw-bidnum" /></label>
              <label className="h10-spw-bidfield"><span className="l">Max Bid</span><Input inputMode="decimal" value={bidConfig.maxBid} onChange={(e) => setBid({ maxBid: e.target.value })} prefix={currency} placeholder="Max" aria-label="Max bid" fieldClassName="h10-spw-bidnum" /></label>
            </div>
          </div>
        </>
      )}

      {/* Product Group Details */}
      <div className="h10-spw-card h10-spw-pgd">
        <h3>Product Group Details</h3>
        <div className="grid">
          <div className="f"><span className="l">Product Group Name</span><span className="v">{productGroupName.trim() || '—'}</span></div>
          <div className="f"><span className="l">Number of Products</span><span className="v">{productCount}</span></div>
          <div className="f"><span className="l">Bid Strategy</span><span className="v"><BarChart3 size={16} className="bi" /> {stageLabel}</span></div>
          <div className="f"><span className="l">Bid Algorithm</span><span className="v">{algoLabel}</span></div>
        </div>
        <button type="button" className="h10-spw-pgd-port" onClick={() => setPortfolioOpen((o) => !o)}><ChevronDown size={15} className={portfolioOpen ? 'up' : ''} /> Portfolio Association (Optional)</button>
        {portfolioOpen && <div className="h10-spw-pgd-portbody"><PortfolioPicker value={portfolioId} onChange={setPortfolioId} /></div>}
      </div>

      {/* Sponsored Campaign Set */}
      <div className="h10-spw-card h10-spw-sum">
        <h3>Sponsored Campaign Set</h3>
        <div className="h10-spw-sum-tbl">
          <div className="grp">
            <span className="g0" />
            <span className="g1">Amazon Settings <InfoTip tip="Settings sent to Amazon for each campaign." /></span>
            <span className="g2">Helium 10 Ads Settings <InfoTip tip="Helium 10 automation applied to each campaign." /></span>
          </div>
          <div className="hd">
            <span>Campaign</span><span>Type</span><span>Targeting</span><span>Target Type</span><span>Daily Budget</span><span>Default Bid</span><span>Bid Algorithm</span><span>Target Value</span>
          </div>
          {campaigns.map((c) => (
            <div className="row" key={c.id}>
              <span className="cmp"><KindBadge kind={c.kind} />{c.name}</span>
              <span>SP</span>
              <span>{c.kind === 'auto' ? 'Auto' : 'Manual'}</span>
              <span>{c.kind === 'pat' ? 'Product' : 'Keyword'}</span>
              <span>{money(currency, Number(c.budget) || 0)}</span>
              <span>{money(currency, Number(c.bid) || 0)}</span>
              <span>{algoLabel}</span>
              <span>{targetValue}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Rules — Rule Setting only (AI Control handles rules itself). Shared HarvestRules component
          (the Keyword-Harvesting / Negative-Targeting matrix + Performance Criteria) — one source of
          truth with the Guided builder. */}
      {!ai && <HarvestRules rules={rules} setRules={setRules} campaigns={campaigns} />}

      {/* RC.3 — Rule Setting control preview (shared canvas, interactive) */}
      {!ai && <RuleControlPanel rules={rules} setRules={setRules} bidConfig={bidConfig} setBidConfig={setBidConfig} campaigns={campaigns} />}
      {/* RC.4 — AI Control preview at the end, interactive (mirrors the rule preview) */}
      {ai && <AiControlPreview value={aiControl} onChange={setAiControl} />}
    </div>
  )
}
