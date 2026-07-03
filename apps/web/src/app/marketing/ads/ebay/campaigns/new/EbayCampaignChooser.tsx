'use client'

/**
 * ER2 — the type-card chooser (SPEC §2, mirrors Amazon's CampaignBuilder
 * §PL-7 on .h10-cb chrome): four STRATEGY cards + the former goal presets as
 * an unobtrusive "Start from a template" chips row (pre-fills, never gates).
 * EBAY_ES disables the Priority cards with the stated reason.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Shield, Rocket, Sparkles, Globe } from 'lucide-react'
import '../../ebay.css'
import { getEbayAds, EBAY_MARKETS } from '../../_lib'
import type { BuilderTemplate } from './_wizard/plan'

const CARDS = [
  { key: 'general', Icon: Shield, title: 'General (CPS)', bestFor: 'always-on coverage with zero-risk fees', desc: 'Pay a % of the sale only when an ad leads to one — any-click attribution means most sales carry the fee, so margin discipline is the whole game. Key-based or rules-based (auto-enrolls future listings). Works on auctions too.' },
  { key: 'priority-manual', Icon: Rocket, title: 'Priority — Manual (CPC)', bestFor: 'owning specific searches', desc: 'Keyword bids under ad groups; the only strategy eligible for the first ad slot in search (exclusive on IT/FR/ES/UK since Jun 2025). Pay per click; fixed-price listings only.' },
  { key: 'priority-smart', Icon: Sparkles, title: 'Priority — Smart (CPC)', bestFor: 'CPC reach without keyword management', desc: 'eBay picks targets and bids under your max-CPC cap. On-site placements only; no keyword control by design.' },
  { key: 'offsite', Icon: Globe, title: 'Offsite (CPC)', bestFor: 'reach beyond eBay', desc: 'eBay manages placement and CPC on external networks (Google, social). Budget is the only lever.' },
] as const

const TEMPLATE_TO_TYPE: Record<string, string> = { catch_all: 'general', clearance: 'general', hero: 'priority-manual', defend: 'priority-manual' }

export function EbayCampaignChooser() {
  const router = useRouter()
  const [market, setMarket] = useState('EBAY_IT')
  const [templates, setTemplates] = useState<BuilderTemplate[]>([])
  useEffect(() => {
    getEbayAds<{ templates: BuilderTemplate[] }>('/builder/templates').then((j) => setTemplates(j.templates)).catch(() => {})
  }, [])
  const es = market === 'EBAY_ES'
  const pick = (key: string, template?: string) =>
    router.push(`/marketing/ads/ebay/campaigns/new/${key}?market=${market}${template ? `&template=${template}` : ''}`)

  return (
    <div className="h10-cb">
      <div className="h10-cb-top">
        <div className="h10-cb-h">Campaign Builder</div>
        <Link className="h10-cb-exit" href="/marketing/ads/ebay/campaigns">Exit Builder</Link>
      </div>
      <div className="h10-cb-panel">
        <div className="h10-cb-sec">
          <h3 style={{ fontSize: 13.5, color: '#37495b', margin: '0 0 8px' }}>Marketplace</h3>
          <select className="h10-cd-input" value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Marketplace" style={{ minWidth: 220 }}>
            {EBAY_MARKETS.filter((m) => m.id !== 'all').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>

        <div className="h10-cb-sec">
          <h3 style={{ fontSize: 13.5, color: '#37495b', margin: '0 0 8px' }}>Campaign type</h3>
          <div className="h10-cb-cards">
            {CARDS.map((c) => {
              const disabled = es && (c.key === 'priority-manual' || c.key === 'priority-smart')
              return (
                <button key={c.key} type="button" className="h10-cb-card" disabled={disabled}
                  style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                  title={disabled ? 'Priority campaigns are not available on eBay Spain' : undefined}
                  onClick={() => !disabled && pick(c.key)}>
                  <span className="h10-cb-ic"><c.Icon size={40} strokeWidth={1.5} /></span>
                  <span className="h10-cb-ttl">{c.title}</span>
                  <span className="h10-cb-bf"><b>Best for:</b> {c.bestFor}</span>
                  <span className="h10-cb-desc">{c.desc}</span>
                  {disabled && <span className="h10-pill warn" style={{ marginTop: 6 }}>unavailable on eBay Spain</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="h10-cb-sec">
          <h3 style={{ fontSize: 13.5, color: '#37495b', margin: '0 0 8px' }}>Start from a template <span style={{ fontWeight: 400, color: '#8a93a1' }}>— pre-fills only, everything stays editable</span></h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {templates.map((t) => {
              const type = TEMPLATE_TO_TYPE[t.key] ?? 'general'
              const disabled = es && t.strategy === 'CPC'
              return (
                <button key={t.key} type="button" className="h10-am-btn" disabled={disabled}
                  title={`${t.strategy === 'CPS' ? 'General' : 'Priority manual'} · ${t.rulePacks.length} rule pack(s)${t.endDays ? ` · ${t.endDays}-day end date` : ''}${t.key === 'catch_all' ? ' · rules-based with auto-select ON (the true catch-all)' : ''}`}
                  onClick={() => pick(type, t.key)}>
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
