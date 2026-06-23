'use client'

/**
 * CBN — Campaign Builder (Helium 10 Ads match). The "+ Campaign" entry: pick a
 * builder type. AI Goal is wired to the AI-Advertising New Product Goal builder;
 * the other types land in later phases. Reuses the shared `.h10-*` design system.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { IconAtom, IconQuick, IconCubes, IconRocket, IconCube } from '../_shell/builder-icons'

const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪', TR: '🇹🇷', US: '🇺🇸' }
const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland', TR: 'Türkiye', US: 'United States' }

type TypeCard = { key: string; title: string; Icon: typeof IconAtom; bestFor: string; desc: string }
const TYPES: TypeCard[] = [
  { key: 'ai-goal', title: 'AI Goal', Icon: IconAtom, bestFor: 'Starter or Experienced sellers', desc: 'Set your goal, and Product Goal AI will automatically manage and optimize your ads to achieve it. Save time and get better results—no manual work needed.' },
  { key: 'quick', title: 'Quick', Icon: IconQuick, bestFor: 'New Sellers', desc: 'Quickly create Sponsored Product campaigns leveraging the Auto campaign for targets.' },
  { key: 'guided', title: 'Guided', Icon: IconCubes, bestFor: 'Experienced Sellers', desc: 'Set up multiple campaign types at once with your specific goals in mind.' },
  { key: 'sp-super-wizard', title: 'SP Super Wizard', Icon: IconRocket, bestFor: 'Sellers with customized needs', desc: 'Quickly create multiple campaigns, customize naming rules, ie match types, keyword types ( Brand, Category, Competitor),structure templates.' },
]
const SINGLE: TypeCard = { key: 'single', title: 'Single Campaign', Icon: IconCube, bestFor: 'Experienced Sellers', desc: 'Set up a single Sponsored Product, Sponsored Brand or Sponsored Display campaign that can be added to an existing Rule.' }

/** The small Amazon "smile" mark shown in the profile chip. */
function AmazonMark() {
  return (
    <svg viewBox="0 0 24 16" width="17" height="12" aria-hidden style={{ display: 'block' }}>
      <text x="0" y="12" fontSize="13" fontWeight="700" fill="#232f3e" fontFamily="Arial, sans-serif">a</text>
      <path d="M2 13.5c3.2 2 7.5 2 10.6-.2" stroke="#ff9900" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** Profile picker — amazon mark + flag + profile name + chevron. Markets are the
 *  marketplaces the account advertises in; defaults to the first (primary market). */
function ProfileSelect() {
  const [markets, setMarkets] = useState<string[]>(['IT'])
  const [sel, setSel] = useState('IT')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`)
      .then((r) => r.json()).then((j) => {
        if (!alive) return
        const ms = Array.from(new Set((j?.items ?? []).map((c: { marketplace?: string | null }) => (c.marketplace ?? '').toUpperCase()).filter(Boolean))) as string[]
        if (ms.length) { setMarkets(ms); setSel(ms.includes('IT') ? 'IT' : ms[0]) }
      }).catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  const label = (m: string) => `${FLAG[m] ?? '🏳️'} ${MARKET_NAME[m] ?? m}`
  return (
    <div className={`h10-cb-profile ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className="h10-cb-profile-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="amz"><AmazonMark /></span>
        <span className="nm">{label(sel)}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="h10-cb-profile-pop" role="listbox">
          {markets.map((m) => (
            <button type="button" key={m} role="option" aria-selected={m === sel} className={`opt ${m === sel ? 'on' : ''}`} onClick={() => { setSel(m); setOpen(false) }}>
              <span className="amz"><AmazonMark /></span><span>{label(m)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TypeCardView({ t, onPick }: { t: TypeCard; onPick: (k: string) => void }) {
  return (
    <button type="button" className="h10-cb-card" onClick={() => onPick(t.key)}>
      <span className="h10-cb-ic"><t.Icon size={46} /></span>
      <span className="h10-cb-ttl">{t.title}</span>
      <span className="h10-cb-bf"><b>Best for:</b> {t.bestFor}</span>
      <span className="h10-cb-desc">{t.desc}</span>
    </button>
  )
}

export function CampaignBuilder() {
  const router = useRouter()
  const pick = (key: string) => {
    if (key === 'ai-goal') router.push('/marketing/ads/ai-advertising/new-goal')
    else if (key === 'sp-super-wizard') router.push('/marketing/ads/campaign-builder/sp-super-wizard')
    else if (key === 'single') router.push('/marketing/ads/campaign-builder/single')
    else if (key === 'quick') router.push('/marketing/ads/campaign-builder/quick')
    else if (key === 'guided') router.push('/marketing/ads/campaign-builder/guided')
  }
  return (
    <div className="h10-cb">
      <div className="h10-cb-top">
        <div className="h10-cb-h"><span className="t">Campaign Builder</span><span className="beta">BETA</span></div>
        <Link href="/marketing/ads/campaigns" className="h10-cb-exit">Exit Builder</Link>
      </div>
      <div className="h10-cb-panel">
        <section className="h10-cb-sec">
          <h3>Profile</h3>
          <p>Select a profile for your campaigns</p>
          <ProfileSelect />
        </section>
        <section className="h10-cb-sec">
          <h3>Campaign Builder Type</h3>
          <p>To get started, select one of the campaign builder types below.</p>
          <div className="h10-cb-cards">
            {TYPES.map((t) => <TypeCardView key={t.key} t={t} onPick={pick} />)}
            <TypeCardView t={SINGLE} onPick={pick} />
          </div>
        </section>
      </div>
    </div>
  )
}
