'use client'

/**
 * EV1 — the type-card chooser on the FULL Amazon .h10-cb anatomy (ER2 built
 * the skeleton; EV1 closes the gaps found in EV0 §1a): 26px/800 title via the
 * .t span + eBay mark, the .h10-cb-profile marketplace selector (not a raw
 * select), shared 17px section headers with intro lines, balanced card copy,
 * HoverCard tips on template chips, class-based disabled state.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Shield, Rocket, Sparkles, Globe, ChevronDown } from 'lucide-react'
import '../../ebay.css'
import { EbayMark } from '../../../_shell/EbayMark'
import { HoverCard } from '../../../campaigns/FilterDropdown'
import { getEbayAds, EBAY_MARKETS } from '../../_lib'
import type { BuilderTemplate } from './_wizard/plan'

const FLAG: Record<string, string> = { EBAY_IT: '🇮🇹', EBAY_DE: '🇩🇪', EBAY_FR: '🇫🇷', EBAY_ES: '🇪🇸', EBAY_GB: '🇬🇧' }

const CARDS = [
  { key: 'general', Icon: Shield, title: 'General (CPS)', bestFor: 'always-on coverage with zero-risk fees', desc: 'Pay a % of the sale only when an ad leads to one. Key-based (pick listings) or rules-based (auto-enrolls future inventory). Works on auctions too.' },
  { key: 'priority-manual', Icon: Rocket, title: 'Priority — Manual (CPC)', bestFor: 'owning specific searches', desc: 'Keyword bids under ad groups — the only strategy eligible for the first ad slot in search. Pay per click; fixed-price listings only.' },
  { key: 'priority-smart', Icon: Sparkles, title: 'Priority — Smart (CPC)', bestFor: 'CPC reach without keyword management', desc: 'eBay picks targets and bids under your max-CPC cap. On-site placements only; no keyword control by design.' },
  { key: 'offsite', Icon: Globe, title: 'Offsite (CPC)', bestFor: 'reach beyond eBay', desc: 'eBay manages placement and CPC on external networks (Google, social). Budget is the only lever.' },
] as const

const TEMPLATE_TO_TYPE: Record<string, string> = { catch_all: 'general', clearance: 'general', hero: 'priority-manual', defend: 'priority-manual' }

/** Marketplace selector on the shared .h10-cb-profile anatomy (EV0 §1a). */
function MarketSelect({ market, onChange }: { market: string; onChange: (m: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const markets = EBAY_MARKETS.filter((m) => m.id !== 'all')
  const current = markets.find((m) => m.id === market)
  return (
    <div className={`h10-cb-profile ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="h10-cb-profile-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="amz" style={{ display: 'inline-flex' }}><EbayMark /></span>
        <span className="nm">{FLAG[market] ?? '🏳️'} {current?.label ?? market}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="h10-cb-profile-pop" role="listbox">
          {markets.map((m) => (
            <button key={m.id} type="button" role="option" aria-selected={m.id === market} className={`opt ${m.id === market ? 'on' : ''}`}
              onClick={() => { onChange(m.id); setOpen(false) }}>
              {FLAG[m.id] ?? '🏳️'} {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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
        <div className="h10-cb-h">
          <span className="t">Campaign Builder</span>
          <span style={{ display: 'inline-flex' }}><EbayMark /></span>
        </div>
        <Link className="h10-cb-exit" href="/marketing/ads/ebay/campaigns">Exit Builder</Link>
      </div>
      <div className="h10-cb-panel">
        <div className="h10-cb-sec">
          <h3>Marketplace</h3>
          <p>Campaigns live on one marketplace — its currency drives rates, bids and budgets.</p>
          <MarketSelect market={market} onChange={setMarket} />
        </div>

        <div className="h10-cb-sec">
          <h3>Campaign type</h3>
          <p>To get started, select how the campaign should work. Every type launches through the guarded write layer.</p>
          <div className="h10-cb-cards">
            {CARDS.map((c) => {
              const disabled = es && (c.key === 'priority-manual' || c.key === 'priority-smart')
              return (
                <button key={c.key} type="button" className="h10-cb-card" disabled={disabled}
                  title={disabled ? 'Priority campaigns are not available on eBay Spain' : undefined}
                  onClick={() => !disabled && pick(c.key)}>
                  <span className="h10-cb-ic"><c.Icon size={44} strokeWidth={1.6} /></span>
                  <span className="h10-cb-ttl">{c.title}</span>
                  <span className="h10-cb-bf"><b>Best for:</b> {c.bestFor}</span>
                  <span className="h10-cb-desc">{c.desc}</span>
                  {disabled && <span className="h10-pill warn" style={{ marginTop: 8 }}>unavailable on eBay Spain</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="h10-cb-sec">
          <h3>Start from a template</h3>
          <p>Pre-fills a type with proven settings — everything stays editable before launch.</p>
          <div className="eb-tpl-row" style={{ marginBottom: 0 }}>
            {templates.map((t) => {
              const type = TEMPLATE_TO_TYPE[t.key] ?? 'general'
              const disabled = es && t.strategy === 'CPC'
              return (
                <HoverCard key={t.key} placement="below"
                  text={`${t.strategy === 'CPS' ? 'General (CPS)' : 'Priority manual (CPC)'} · ${t.rulePacks.length} rule pack(s)${t.endDays ? ` · ${t.endDays}-day end date` : ''}${t.key === 'catch_all' ? ' · rules-based with auto-select ON (the true catch-all)' : ''}${disabled ? ' · unavailable on eBay Spain' : ''}`}>
                  <button type="button" className="h10-am-btn" disabled={disabled} onClick={() => pick(type, t.key)}>
                    {t.label}
                  </button>
                </HoverCard>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
