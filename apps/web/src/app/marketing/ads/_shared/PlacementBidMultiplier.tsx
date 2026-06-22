'use client'

/**
 * Shared Placement bid-adjustment panel (Helium 10 match). Placement % (Top of Search /
 * Product Pages / Rest of Search, 0–900) + Video / Amazon Business / Audience bid boosts
 * + the Audience Bid Modifier picker. Extracted from the campaign-detail Details tab so
 * the Details tab AND the SP Super Wizard "Bid Multiplier" stay in lockstep — change it
 * once, both update. Renders the inner content only; the parent supplies the card shell.
 * Reuses the `.h10-cd-*` styles already in ads.css.
 */
import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Search, Plus, Check, X } from 'lucide-react'
import { InfoTip } from '../campaigns/InfoTip'

export type PlacementBids = { tos: string; pdp: string; ros: string; videoBoost: boolean; abBoost: boolean; abBoostPct: string; audienceMod: boolean }
export const emptyPlacementBids = (): PlacementBids => ({ tos: '', pdp: '', ros: '', videoBoost: false, abBoost: false, abBoostPct: '', audienceMod: false })

// Verbatim info-icon tooltip copy captured from the recording (dark hover cards).
const TIPS = {
  placement: 'Apply bid adjustments for sales by entering percentage to increase your default bid. These adjustments will apply on all bids in the campaign. Based on your bidding strategy, your bids can change further.',
  videoBoost: 'Further increase bids for video ads. These increases apply on top of your placement adjustments.',
  abBoost: 'Further increase bids across placements on Amazon Business. The percentage value set is the percentage of the original bid including any other bid adjustments such as placement bidding. For example, a placement bidding with 50% adjustment on a $1.00 bid would increase the bid by $1.50, and an Amazon Business with 100% adjustment would further increase the bid to $3.00. On average, advertisers see a 2x to 3x higher return on ad spend on Amazon Business relative to the overall campaign performance (Amazon internal data, 2024).',
  audience: 'Adjust your bids for specific audiences. Audience bid modifiers apply on top of your placement and platform adjustments.',
}

// From-Amazon audience presets shown by the Audience Bid Modifier picker (UI-only).
const AMAZON_AUDIENCES: Array<{ key: string; name: string; desc: string }> = [
  { key: 'cart', name: "Clicked or Added brand's product to cart", desc: "The “clicked or added brand's product to cart” audience includes people who have clicked or added to cart within the last 3 months, but haven't purchased." },
  { key: 'purchased', name: "Purchased brand's product", desc: "The “purchased brand's product” audience includes people who have purchased a product from this brand within the last 3 months." },
  { key: 'highinterest', name: 'High Interest based on shopping history', desc: 'People whose shopping activity indicates a high interest in purchasing the advertised product.' },
]

const PLACEMENTS: Array<{ k: 'tos' | 'pdp' | 'ros'; label: string }> = [
  { k: 'tos', label: 'Top of Search' },
  { k: 'pdp', label: 'Product Pages' },
  { k: 'ros', label: 'Rest of Search' },
]

export function PlacementBidMultiplier({ value, onChange }: { value: PlacementBids; onChange: (patch: Partial<PlacementBids>) => void }) {
  return (
    <>
      <div className="h10-cd-pllbl">Placement</div>
      <div className="h10-cd-placements">
        {PLACEMENTS.map(({ k, label }) => (
          <div className="pl" key={k}>
            <label>{label} {k !== 'ros' ? <InfoTip tip={TIPS.placement} /> : null}</label>
            <div className="h10-cd-pct"><input type="number" min="0" max="900" placeholder="0 - 900" value={value[k]} onChange={(e) => onChange({ [k]: e.target.value })} aria-label={label} /><span className="sf">%</span></div>
          </div>
        ))}
      </div>
      <div className="h10-cd-boost">
        <div className="bl"><b>Further increase bids for video ads <InfoTip tip={TIPS.videoBoost} /></b><span>These increases apply on top of placement adjustments.</span></div>
        <label className="h10-cd-switch"><input type="checkbox" checked={value.videoBoost} onChange={(e) => onChange({ videoBoost: e.target.checked })} /><span className="tk" /> Enable Video Bid Boost</label>
      </div>
      <div className="h10-cd-boost">
        <div className="bl"><b>Amazon Business Bid Boost <InfoTip tip={TIPS.abBoost} /></b><span>Further increase bids across placements on Amazon Business.</span></div>
        <label className="h10-cd-switch"><input type="checkbox" checked={value.abBoost} onChange={(e) => onChange({ abBoost: e.target.checked })} /><span className="tk" /> Enable Amazon Business Bid Boost</label>
      </div>
      {value.abBoost && (
        <div className="h10-cd-boostrev">
          <div className="h10-cd-pct"><input type="number" min="0" max="900" placeholder="0 - 900" value={value.abBoostPct} onChange={(e) => onChange({ abBoostPct: e.target.value })} aria-label="Amazon Business bid boost percentage" /><span className="sf">%</span></div>
        </div>
      )}
      <div className="h10-cd-boost">
        <div className="bl"><b>Audience Bid Modifier <InfoTip tip={TIPS.audience} /></b></div>
        <label className="h10-cd-switch"><input type="checkbox" checked={value.audienceMod} onChange={(e) => onChange({ audienceMod: e.target.checked })} /><span className="tk" /> Enable Audience Bid Modifier</label>
      </div>
      {value.audienceMod && <AudiencePicker />}
    </>
  )
}

type AddedAud = { key: string; name: string; pct: string }
/** Audience Bid Modifier picker (UI-only). From AMC / From Amazon tabs, search, +Add
 *  rows with pagination, and the "Audience Added 0/1" panel (1-audience cap). */
function AudiencePicker() {
  const [src, setSrc] = useState<'AMC' | 'AMAZON'>('AMAZON')
  const [q, setQ] = useState('')
  const [added, setAdded] = useState<AddedAud[]>([])
  const cap = 1
  const list = src === 'AMAZON' ? AMAZON_AUDIENCES : []
  const ql = q.trim().toLowerCase()
  const shown = ql ? list.filter((a) => a.name.toLowerCase().includes(ql) || a.desc.toLowerCase().includes(ql)) : list
  const addedKeys = new Set(added.map((a) => a.key))
  const full = added.length >= cap
  const add = (a: { key: string; name: string }) => { if (full || addedKeys.has(a.key)) return; setAdded((p) => [...p, { key: a.key, name: a.name, pct: '' }]) }
  const remove = (key: string) => setAdded((p) => p.filter((a) => a.key !== key))
  const setPct = (key: string, pct: string) => setAdded((p) => p.map((a) => (a.key === key ? { ...a, pct } : a)))

  return (
    <div className="h10-cd-aud">
      <div className="aud-left">
        <div className="aud-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={src === 'AMC'} className={src === 'AMC' ? 'on' : ''} onClick={() => setSrc('AMC')}>From AMC</button>
          <button type="button" role="tab" aria-selected={src === 'AMAZON'} className={src === 'AMAZON' ? 'on' : ''} onClick={() => setSrc('AMAZON')}>From Amazon</button>
        </div>
        {src === 'AMC' ? (
          <>
            <div className="aud-amc-row">
              <button type="button" className="aud-type"><span>Select a Type</span><ChevronDown size={15} /></button>
              <div className="aud-search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by Audience" aria-label="Search by Audience" /><Search size={15} /></div>
            </div>
            <div className="aud-amc-empty">
              <EmptyAudienceArt />
              <b>No data</b>
              <span>The profile has not been added to the AMC instance. Please create an AMC instance first.</span>
              <button type="button" className="aud-instance"><Plus size={15} /> Instance</button>
            </div>
          </>
        ) : (
          <>
            <div className="aud-search"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by Audience" aria-label="Search by Audience" /><Search size={15} /></div>
            <div className="aud-list">
              {shown.length === 0 ? (
                <div className="aud-none">No audiences match your search.</div>
              ) : shown.map((a) => {
                const on = addedKeys.has(a.key)
                return (
                  <div className="aud-item" key={a.key}>
                    <div className="ai-tx"><b>{a.name}</b><span>{a.desc}</span></div>
                    <button type="button" className={`aud-add ${on ? 'added' : ''}`} disabled={on || (full && !on)} onClick={() => add(a)}>
                      {on ? <><Check size={14} /> Added</> : <><Plus size={14} /> Add</>}
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="aud-pager">
              <button type="button" className="pg-nav" disabled aria-label="Previous page"><ChevronLeft size={15} /></button>
              <span className="pg-n">1</span>
              <button type="button" className="pg-nav" disabled aria-label="Next page"><ChevronRight size={15} /></button>
              <span className="pg-rpp">Rows per page: <span className="rpp-sel">10 <ChevronRight size={11} style={{ transform: 'rotate(90deg)' }} /></span></span>
            </div>
          </>
        )}
      </div>

      <div className="aud-right">
        <div className="ar-head">Audience Added {added.length}/{cap}</div>
        <div className="ar-thead"><span>Audience Name</span><span>Size</span><span>Percentage</span></div>
        {added.length === 0 ? (
          <div className="ar-empty"><EmptyAudienceArt /><span>No Audience Added</span></div>
        ) : (
          <div className="ar-rows">
            {added.map((a) => (
              <div className="ar-row" key={a.key}>
                <div className="arn"><b>{a.name}</b><span>Amazon</span></div>
                <span className="arsize">—</span>
                <div className="h10-cd-pct sm"><input type="number" min="1" max="900" placeholder="1-900" value={a.pct} onChange={(e) => setPct(a.key, e.target.value)} aria-label={`${a.name} percentage`} /><span className="sf">%</span></div>
                <button type="button" className="ar-x" onClick={() => remove(a.key)} aria-label={`Remove ${a.name}`}><X size={15} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Empty-state illustration for the Audience Added panel. */
function EmptyAudienceArt() {
  return (
    <svg className="ar-art" width="88" height="64" viewBox="0 0 88 64" fill="none" aria-hidden focusable="false">
      <rect x="12" y="10" width="50" height="38" rx="4" fill="#eef2f7" stroke="#d7dee7" strokeWidth="1.5" />
      <path d="M18 40 L30 28 L38 35 L48 23 L58 33 L58 44 L18 44 Z" fill="#cdd7e3" />
      <circle cx="28" cy="22" r="4" fill="#bcc8d6" />
      <circle cx="58" cy="44" r="13" fill="#fff" stroke="#9fb0c4" strokeWidth="2.5" />
      <line x1="67" y1="53" x2="76" y2="62" stroke="#9fb0c4" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="64" cy="14" r="7" fill="#2bbf6a" />
      <path d="M61 14.2 L63.3 16.5 L67.2 11.8" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}
