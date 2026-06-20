'use client'

/**
 * CBN.3.1 — Campaign Details page shell. Fetches one campaign and renders the detail
 * header + the Helium 10 tab bar (Details · Ad Groups · Search Terms · Campaign Negative
 * Targets · Ads · Audience[NEW]) with ?tab= routing (linkable + back-button friendly).
 * Tab bodies are skeletons in 3.1; they fill in over CBN.3.3–3.6, all sharing the
 * <AdsDataGrid> extracted in 3.2.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignDetailHeader } from '../../_shell/CampaignDetailHeader'
import { DetailsTab } from './tabs/DetailsTab'
import { AdGroupsTab } from './tabs/AdGroupsTab'
import { SearchTermsTab } from './tabs/SearchTermsTab'
import { NegativeTargetsTab } from './tabs/NegativeTargetsTab'
import { AdsTab } from './tabs/AdsTab'

export interface CampaignDetailData {
  id: string
  name: string
  type?: string | null
  status?: string
  marketplace?: string | null
  externalCampaignId?: string | null
  dailyBudget?: number | string | null
  dailyBudgetCurrency?: string | null
  biddingStrategy?: string | null
  startDate?: string | null
  endDate?: string | null
  targetingType?: string | null
  adProduct?: string | null
  portfolioId?: string | null
  impressions?: number
  clicks?: number
  spend?: number
  sales?: number
  acos?: number | null
  roas?: number | null
  adGroups?: Array<Record<string, unknown>>
  dataThrough?: string | null
}

type TabKey = 'details' | 'ad-groups' | 'search-terms' | 'negative-targets' | 'ads' | 'audience'
const TABS: ReadonlyArray<{ key: TabKey; label: string; badge?: string }> = [
  { key: 'details', label: 'Details' },
  { key: 'ad-groups', label: 'Ad Groups' },
  { key: 'search-terms', label: 'Search Terms' },
  { key: 'negative-targets', label: 'Campaign Negative Targets' },
  { key: 'ads', label: 'Ads' },
  { key: 'audience', label: 'Audience', badge: 'NEW' },
]

/** Targeting-type tile shown in the title (A = Auto, M = Manual), per H10. */
const badgeLetter = (c: CampaignDetailData | null): string => {
  const t = `${c?.targetingType ?? ''} ${c?.type ?? ''} ${c?.name ?? ''}`.toUpperCase()
  if (t.includes('MANUAL')) return 'M'
  return 'A'
}

const fmtISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function CampaignDetail({ id }: { id: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const tabParam = (search.get('tab') ?? 'details') as TabKey
  const activeTab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'details'

  const [camp, setCamp] = useState<CampaignDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dateRange, setDateRange] = useState(() => {
    const e = new Date(); e.setHours(0, 0, 0, 0)
    const s = new Date(e); s.setDate(s.getDate() - 29)
    return { start: s, end: e }
  })
  const [market, setMarket] = useState('all')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const qs = `?startDate=${fmtISO(dateRange.start)}&endDate=${fmtISO(dateRange.end)}`
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${id}${qs}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      const c = (d.campaign ?? d) as CampaignDetailData
      setCamp(c)
      if (c?.marketplace) setMarket(c.marketplace)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load campaign')
    } finally {
      setLoading(false)
    }
  }, [id, dateRange])

  useEffect(() => { void load() }, [load])

  const setTab = (key: TabKey) => {
    const sp = new URLSearchParams(Array.from(search.entries()))
    if (key === 'details') sp.delete('tab'); else sp.set('tab', key)
    const q = sp.toString()
    router.replace(`/marketing/ads/campaigns/${id}${q ? `?${q}` : ''}`, { scroll: false })
  }

  const markets = useMemo(() => (camp?.marketplace ? [camp.marketplace] : ['IT', 'DE', 'FR', 'ES']), [camp])

  return (
    <div className="h10-cd">
      <CampaignDetailHeader
        badge={badgeLetter(camp)}
        title={loading && !camp ? 'Loading…' : (camp?.name ?? 'Campaign')}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showDateRange={activeTab !== 'details'}
        dateRange={dateRange}
        onDateRange={(s, e) => setDateRange({ start: s, end: e })}
        actions={[
          { label: 'Refresh data', onClick: () => void load() },
          { label: 'View in Ad Manager', href: '/marketing/ads/campaigns' },
        ]}
      />

      <nav className="h10-cd-tabs" role="tablist" aria-label="Campaign sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`h10-cd-tab ${activeTab === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.badge ? <span className="h10-cd-new">{t.badge}</span> : null}
          </button>
        ))}
      </nav>

      <div className="h10-cd-body">
        {error
          ? <div className="h10-cd-error">Couldn’t load this campaign — {error}. <button type="button" onClick={() => void load()}>Retry</button></div>
          : activeTab === 'details'
            ? <DetailsTab campaign={camp} campaignId={id} onSaved={() => void load()} />
            : activeTab === 'ad-groups'
              ? <AdGroupsTab campaign={camp} campaignId={id} onRefresh={() => void load()} />
              : activeTab === 'search-terms'
                ? <SearchTermsTab campaign={camp} dateRange={dateRange} />
                : activeTab === 'negative-targets'
                  ? <NegativeTargetsTab campaign={camp} />
                  : activeTab === 'ads'
                    ? <AdsTab campaign={camp} dateRange={dateRange} />
                    : <TabPlaceholder tab={activeTab} loading={loading} />}
      </div>
    </div>
  )
}

function TabPlaceholder({ tab, loading }: { tab: TabKey; loading: boolean }) {
  if (tab === 'audience') {
    return (
      <div className="h10-cd-empty">
        <h3>Audience insights are coming soon</h3>
        <p>Audience targeting and reporting for this campaign will appear here.</p>
      </div>
    )
  }
  return (
    <div className="h10-cd-skel" aria-busy={loading}>
      <div className="sk-line w40" />
      <div className="sk-line w70" />
      <div className="sk-block" />
    </div>
  )
}
