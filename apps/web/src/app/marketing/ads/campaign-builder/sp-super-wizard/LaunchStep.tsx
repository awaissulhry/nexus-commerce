'use client'

/**
 * SPW.6 — Step 3 "Automation & Launch" (Helium 10 match). Three sections:
 *  • Product Group Details (name · # products · Bid Strategy "Scale" · Bid Algorithm) + Portfolio Association.
 *  • Sponsored Campaign Set — read-only summary table with grouped Amazon / Helium 10 Ads headers.
 *  • Rules — Keyword Harvesting / Negative Targeting tabs · Rule Name · Automate toggle · the
 *    Ad-Group × create-target matrix (B/P/E keyword + box product targets, P/E + box negatives,
 *    enabled per campaign kind) · Performance Criteria.
 * Launch itself (creating the campaigns) is wired in SPW.7.
 */
import { useState } from 'react'
import { ChevronDown, Package, Layers, BarChart3 } from 'lucide-react'
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

type RowSel = { st: boolean; tB: boolean; tP: boolean; tE: boolean; tBox: boolean; nP: boolean; nE: boolean; nBox: boolean }
const emptySel = (): RowSel => ({ st: false, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: false, nBox: false })

export function LaunchStep({ campaigns, productGroupName, productCount, currency }: {
  campaigns: SpwCampaign[]
  productGroupName: string
  productCount: number
  currency: string
}) {
  const [portfolioOpen, setPortfolioOpen] = useState(false)
  const [tab, setTab] = useState<'harvest' | 'negative'>('harvest')
  const [ruleName, setRuleName] = useState('')
  const [automate, setAutomate] = useState(false)
  const [sel, setSel] = useState<Record<string, RowSel>>({})
  const [perfOpen, setPerfOpen] = useState(false)

  const rowSel = (id: string) => sel[id] ?? emptySel()
  const setRow = (id: string, patch: Partial<RowSel>) => setSel((s) => ({ ...s, [id]: { ...rowSel(id), ...patch } }))
  const tEnabled = (k: SpwCampaign['kind']) => ({ B: k === 'keyword', P: k === 'keyword', E: k === 'keyword', box: k === 'pat' })
  const nEnabled = (k: SpwCampaign['kind']) => ({ P: k !== 'pat', E: k !== 'pat', box: k !== 'keyword' })

  return (
    <div className="h10-spw-launch">
      {/* Product Group Details */}
      <div className="h10-spw-card h10-spw-pgd">
        <h3>Product Group Details</h3>
        <div className="grid">
          <div className="f"><span className="l">Product Group Name</span><span className="v">{productGroupName.trim() || '—'}</span></div>
          <div className="f"><span className="l">Number of Products</span><span className="v">{productCount}</span></div>
          <div className="f"><span className="l">Bid Strategy</span><span className="v"><BarChart3 size={16} className="bi" /> Scale</span></div>
          <div className="f"><span className="l">Bid Algorithm</span><span className="v">Target ACoS</span></div>
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
              <span>Target ACoS</span>
              <span>30.00%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Rules */}
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
              <select aria-label="Metric"><option>Orders</option><option>Clicks</option><option>ACoS</option><option>Spend</option></select>
              <select aria-label="Operator"><option>is greater than</option><option>is less than</option></select>
              <input inputMode="decimal" placeholder="Value" aria-label="Value" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
