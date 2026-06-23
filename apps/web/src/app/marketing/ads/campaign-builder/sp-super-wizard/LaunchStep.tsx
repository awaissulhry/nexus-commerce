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
import { ChevronDown, Package, Layers, BarChart3, Sparkles, Megaphone, Target, ShoppingCart, SlidersHorizontal } from 'lucide-react'
import { RadioCard, Input } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import { InfoTip } from '../../campaigns/InfoTip'
import type { SpwCampaign } from './CampaignSetup'

const money = (cur: string, n: number) => `${cur}${n.toFixed(2)}`

function KindBadge({ kind }: { kind: SpwCampaign['kind'] }) {
  const auto = kind === 'auto'
  return <><span className={`h10-spw-kb ${auto ? 'a' : 'm'}`}>{auto ? 'A' : 'M'}</span><span className="h10-spw-spb">SP</span></>
}

/** small round match-type / product badge in the matrix header */
function MBadge({ tone, letter }: { tone: 'green' | 'slate' | 'navy' | 'blue' | 'maroon'; letter?: string }) {
  return <span className={`h10-spw-mb ${tone}`}>{letter ?? <Package size={11} strokeWidth={2.4} />}</span>
}

function Check({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  if (disabled) return <span className="h10-spw-mx-ck dis" aria-hidden />
  return <input type="checkbox" className="h10-spw-mx-ck" checked={on} onChange={onChange} aria-label={label} />
}

export type RuleRowSel = { st: boolean; tB: boolean; tP: boolean; tE: boolean; tBox: boolean; nP: boolean; nE: boolean; nBox: boolean }
export const emptyRuleRow = (): RuleRowSel => ({ st: false, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: false, nBox: false })
export type RulesConfig = {
  ruleName: string
  automate: boolean
  sel: Record<string, RuleRowSel>
  perf: { metric: string; op: string; value: string }
}
export const defaultRulesConfig = (): RulesConfig => ({ ruleName: '', automate: false, sel: {}, perf: { metric: 'Orders', op: 'is greater than', value: '' } })
/** True once the operator has set up a harvest rule worth persisting. */
export const rulesConfigured = (r: RulesConfig): boolean =>
  r.ruleName.trim().length > 0 || Object.values(r.sel).some((s) => s.st || s.tB || s.tP || s.tE || s.tBox || s.nP || s.nE || s.nBox)

// ── S3 — bid strategy / Helium 10 automation config ──────────────────────
export type BidStrategy = 'maxImpressions' | 'targetAcos' | 'maxOrders' | 'custom' | 'none'
export type BidConfig = { strategy: BidStrategy; targetAcos: string; minBid: string; maxBid: string }
export const defaultBidConfig = (): BidConfig => ({ strategy: 'targetAcos', targetAcos: '30', minBid: '', maxBid: '' })
const BID_STRATEGIES: Array<{ key: Exclude<BidStrategy, 'none'>; label: string; desc: string; stage: string; recommended?: boolean; Icon: typeof Target }> = [
  { key: 'maxImpressions', label: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.', stage: 'Launch', Icon: Megaphone },
  { key: 'targetAcos', label: 'Target ACoS', desc: 'A bid algorithm for products in a performance stage that should target an ACoS for scalable advertising.', stage: 'Scale', recommended: true, Icon: Target },
  { key: 'maxOrders', label: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage that should bid for maximum orders to clear out inventory.', stage: 'Liquidate', Icon: ShoppingCart },
  { key: 'custom', label: 'Custom', desc: 'Create a custom rule that adjusts a target’s bid based on your set performance criteria.', stage: 'Custom', Icon: SlidersHorizontal },
]

export function LaunchStep({ campaigns, productGroupName, productCount, currency, automationMode, setAutomationMode, bidConfig, setBidConfig, rules, setRules }: {
  campaigns: SpwCampaign[]
  productGroupName: string
  productCount: number
  currency: string
  automationMode: 'rule' | 'ai'
  setAutomationMode: (m: 'rule' | 'ai') => void
  bidConfig: BidConfig
  setBidConfig: Dispatch<SetStateAction<BidConfig>>
  rules: RulesConfig
  setRules: Dispatch<SetStateAction<RulesConfig>>
}) {
  const [portfolioOpen, setPortfolioOpen] = useState(false)
  const [tab, setTab] = useState<'harvest' | 'negative'>('harvest')
  const [perfOpen, setPerfOpen] = useState(false)
  const ai = automationMode === 'ai'
  const setBid = (patch: Partial<BidConfig>) => setBidConfig((b) => ({ ...b, ...patch }))

  const { ruleName, automate, sel, perf } = rules
  const setRuleName = (v: string) => setRules((r) => ({ ...r, ruleName: v }))
  const setAutomate = (v: boolean) => setRules((r) => ({ ...r, automate: v }))
  const rowSel = (id: string) => sel[id] ?? emptyRuleRow()
  const setRow = (id: string, patch: Partial<RuleRowSel>) => setRules((r) => ({ ...r, sel: { ...r.sel, [id]: { ...(r.sel[id] ?? emptyRuleRow()), ...patch } } }))
  const setPerf = (patch: Partial<RulesConfig['perf']>) => setRules((r) => ({ ...r, perf: { ...r.perf, ...patch } }))
  const tEnabled = (k: SpwCampaign['kind']) => ({ B: k === 'keyword', P: k === 'keyword', E: k === 'keyword', box: k === 'pat' })
  const nEnabled = (k: SpwCampaign['kind']) => ({ P: k !== 'pat', E: k !== 'pat', box: k !== 'keyword' })

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
        <div className="h10-spw-card h10-spw-ainote"><Sparkles size={18} /><span><b>AI Control is on.</b> Helium 10 will manage bids, budgets, and targeting for these campaigns automatically. Review the set below, then launch.</span></div>
      ) : (
        <>
          {/* Bid Strategy */}
          <div className="h10-spw-card">
            <h3>Bid Strategy <InfoTip tip="The Helium 10 bid algorithm applied to every campaign in this set." /></h3>
            <p className="h10-spw-desc">Select a bid algorithm based on your product &amp; campaign goals.</p>
            <div className="h10-spw-bidstrat">
              {BID_STRATEGIES.map((s) => (
                <RadioCard key={s.key} className="h10-spw-bidcard" name="spw-bidstrat" selected={bidConfig.strategy === s.key} checked={bidConfig.strategy === s.key} onChange={() => setBid({ strategy: s.key })}
                  title={<span className="h10-spw-bc-t">{s.recommended && <span className="rec">Recommended</span>}<span className="ic"><s.Icon size={16} /></span><span className="lbl">{s.label}</span></span>}
                  description={s.desc} />
              ))}
            </div>
            <RadioCard className="h10-spw-bidcard none" name="spw-bidstrat" title={<span className="h10-spw-bc-t"><span className="ic none"><Package size={15} /></span><span className="lbl">None</span></span>} description="Don't apply a bid algorithm — manage bids yourself." selected={bidConfig.strategy === 'none'} checked={bidConfig.strategy === 'none'} onChange={() => setBid({ strategy: 'none' })} />
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
        {portfolioOpen && <div className="h10-spw-pgd-portbody">No portfolio selected.</div>}
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

      {/* Rules — Rule Setting only (AI Control handles rules itself) */}
      {!ai && (
        <div className="h10-spw-rules">
          <h3>Rules</h3>
          <p className="h10-spw-desc">All rules affecting an ad group will appear underneath it. Suggestions generated by rules will appear on the Suggestions Page.</p>
          <div className="h10-spw-rules-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'harvest'} className={tab === 'harvest' ? 'on' : ''} onClick={() => setTab('harvest')}>Keyword Harvesting</button>
            <button type="button" role="tab" aria-selected={tab === 'negative'} className={tab === 'negative' ? 'on' : ''} onClick={() => setTab('negative')}>Negative Targeting</button>
          </div>

          <label className="h10-spw-rules-rn">
            <span className="l">Rule Name</span>
            <input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="Enter a rule name" aria-label="Rule name" />
          </label>
          <label className="h10-spw-rules-auto">
            <input type="checkbox" className="h10-spw-sw" checked={automate} onChange={(e) => setAutomate(e.target.checked)} />
            <span>Automate</span>
          </label>

          <div className="h10-spw-mx">
            <div className="h10-spw-mx-grid grp">
              <span className="ql">What Ad Groups would you like included in this rule?</span>
              <span className="qr">What targets would you like created? <InfoTip tip="New keyword/product targets created from harvested search terms." /></span>
            </div>
            <div className="h10-spw-mx-grid sub">
              <span className="c-ag">Ad Group</span>
              <span className="c-st">Look for Search Terms in These Ad Groups <InfoTip tip="Harvest converting search terms from these ad groups." /></span>
              <span className="c-t">Create New Targets <InfoTip tip="Match types of new positive targets to create." /></span>
              <span className="c-n">Create New Negative Targets</span>
            </div>
            <div className="h10-spw-mx-grid badges">
              <span className="b3"><MBadge tone="green" letter="B" /></span>
              <span className="b4"><MBadge tone="slate" letter="P" /></span>
              <span className="b5"><MBadge tone="navy" letter="E" /></span>
              <span className="b6"><MBadge tone="blue" /></span>
              <span className="b8"><MBadge tone="maroon" letter="P" /></span>
              <span className="b9"><MBadge tone="maroon" letter="E" /></span>
              <span className="b10"><MBadge tone="maroon" /></span>
            </div>
            {campaigns.map((c) => {
              const r = rowSel(c.id); const te = tEnabled(c.kind); const ne = nEnabled(c.kind)
              return (
                <div className="h10-spw-mx-grid row" key={c.id}>
                  <div className="c-ag id"><KindBadge kind={c.kind} /><div className="nm"><span className="t">{c.name}</span><span className="ag"><Layers size={12} /> {c.adGroupName}</span></div></div>
                  <div className="c-st"><Check on={r.st} onChange={() => setRow(c.id, { st: !r.st })} label={`Look for search terms in ${c.name}`} /></div>
                  <div className="b3"><Check on={r.tB} disabled={!te.B} onChange={() => setRow(c.id, { tB: !r.tB })} label={`Create Broad target for ${c.name}`} /></div>
                  <div className="b4"><Check on={r.tP} disabled={!te.P} onChange={() => setRow(c.id, { tP: !r.tP })} label={`Create Phrase target for ${c.name}`} /></div>
                  <div className="b5"><Check on={r.tE} disabled={!te.E} onChange={() => setRow(c.id, { tE: !r.tE })} label={`Create Exact target for ${c.name}`} /></div>
                  <div className="b6"><Check on={r.tBox} disabled={!te.box} onChange={() => setRow(c.id, { tBox: !r.tBox })} label={`Create product target for ${c.name}`} /></div>
                  <div className="b8"><Check on={r.nP} disabled={!ne.P} onChange={() => setRow(c.id, { nP: !r.nP })} label={`Create negative Phrase for ${c.name}`} /></div>
                  <div className="b9"><Check on={r.nE} disabled={!ne.E} onChange={() => setRow(c.id, { nE: !r.nE })} label={`Create negative Exact for ${c.name}`} /></div>
                  <div className="b10"><Check on={r.nBox} disabled={!ne.box} onChange={() => setRow(c.id, { nBox: !r.nBox })} label={`Create negative product for ${c.name}`} /></div>
                </div>
              )
            })}
          </div>

          <button type="button" className="h10-spw-perf" onClick={() => setPerfOpen((o) => !o)}><ChevronDown size={16} className={perfOpen ? 'up' : ''} /> Performance Criteria</button>
          {perfOpen && (
            <div className="h10-spw-perf-body">
              <p>Only harvest search terms that meet these performance thresholds (optional).</p>
              <div className="h10-spw-perf-row">
                <select aria-label="Metric" value={perf.metric} onChange={(e) => setPerf({ metric: e.target.value })}><option>Orders</option><option>Clicks</option><option>ACoS</option><option>Spend</option></select>
                <select aria-label="Operator" value={perf.op} onChange={(e) => setPerf({ op: e.target.value })}><option>is greater than</option><option>is less than</option></select>
                <input inputMode="decimal" placeholder="Value" aria-label="Value" value={perf.value} onChange={(e) => setPerf({ value: e.target.value })} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
