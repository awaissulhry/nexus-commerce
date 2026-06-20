'use client'

/**
 * Ad Group Details page shell (drill-in from the campaign's Ad Groups grid). Mirrors the
 * Campaign Detail shell: the shared detail header ("← Back to Campaign" + ad-group name +
 * Learn/Feedback/date/account/Action) and the H10 ad-group tab bar (Targets · Search Terms ·
 * Ad Group Negative Targets · Ad Group Negative Keywords · Ads), ?tab=-routed. Each tab body
 * fills in over follow-up phases, all rendered through the shared <AdsDataGrid> so the
 * campaign- and ad-group-level grids stay in lockstep.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignDetailHeader } from '../../../../_shell/CampaignDetailHeader'
import { TargetsTab } from './tabs/TargetsTab'
import { AgSearchTermsTab } from './tabs/AgSearchTermsTab'
import { AgNegativesTab } from './tabs/AgNegativesTab'
import { AgAdsTab } from './tabs/AgAdsTab'

export interface AdGroupDetailData {
  id: string
  name: string
  status?: string
  defaultBidCents?: number | null
  externalAdGroupId?: string | null
  campaign?: { id: string; name?: string; marketplace?: string | null; externalCampaignId?: string | null } | null
  metrics?: Record<string, unknown>
  ads?: Array<Record<string, unknown>>
  targets?: Array<Record<string, unknown>>
  dataThrough?: string | null
}

type TabKey = 'targets' | 'search-terms' | 'ad-group-negative-targets' | 'ad-group-negative-keywords' | 'ads'
const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'targets', label: 'Targets' },
  { key: 'search-terms', label: 'Search Terms' },
  { key: 'ad-group-negative-targets', label: 'Ad Group Negative Targets' },
  { key: 'ad-group-negative-keywords', label: 'Ad Group Negative Keywords' },
  { key: 'ads', label: 'Ads' },
]

const fmtISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function AdGroupDetail({ campaignId, adGroupId }: { campaignId: string; adGroupId: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const tabParam = (search.get('tab') ?? 'targets') as TabKey
  const activeTab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'targets'

  const [ag, setAg] = useState<AdGroupDetailData | null>(null)
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
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-groups/${adGroupId}${qs}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      const a = (d.adGroup ?? d) as AdGroupDetailData
      setAg(a)
      if (a?.campaign?.marketplace) setMarket(a.campaign.marketplace)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ad group')
    } finally {
      setLoading(false)
    }
  }, [adGroupId, dateRange])

  useEffect(() => { void load() }, [load])

  const setTab = (key: TabKey) => {
    const sp = new URLSearchParams(Array.from(search.entries()))
    if (key === 'targets') sp.delete('tab'); else sp.set('tab', key)
    const q = sp.toString()
    router.replace(`/marketing/ads/campaigns/${campaignId}/ad-groups/${adGroupId}${q ? `?${q}` : ''}`, { scroll: false })
  }

  const markets = useMemo(() => (ag?.campaign?.marketplace ? [ag.campaign.marketplace] : ['IT', 'DE', 'FR', 'ES']), [ag])
  const backHref = `/marketing/ads/campaigns/${campaignId}?tab=ad-groups`

  return (
    <div className="h10-cd">
      <CampaignDetailHeader
        title={loading && !ag ? 'Loading…' : (ag?.name ?? 'Ad Group')}
        label="Ad Group Details"
        backLabel="Back to Campaign"
        backHref={backHref}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showDateRange
        dateRange={dateRange}
        onDateRange={(s, e) => setDateRange({ start: s, end: e })}
        actions={[
          { label: 'Refresh data', onClick: () => void load() },
          { label: 'View Campaign', href: backHref },
        ]}
      />

      <nav className="h10-cd-tabs" role="tablist" aria-label="Ad group sections">
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
          </button>
        ))}
      </nav>

      <div className="h10-cd-body">
        {error
          ? <div className="h10-cd-error">Couldn’t load this ad group — {error}. <button type="button" onClick={() => void load()}>Retry</button></div>
          : loading && !ag
            ? <TabSkeleton loading />
            : activeTab === 'targets'
              ? <TargetsTab adGroup={ag} onRefresh={() => void load()} />
              : activeTab === 'search-terms'
                ? <AgSearchTermsTab adGroup={ag} dateRange={dateRange} />
                : activeTab === 'ad-group-negative-targets'
                  ? <AgNegativesTab adGroup={ag} mode="targets" onRefresh={() => void load()} />
                  : activeTab === 'ad-group-negative-keywords'
                    ? <AgNegativesTab adGroup={ag} mode="keywords" onRefresh={() => void load()} />
                    : activeTab === 'ads'
                      ? <AgAdsTab adGroup={ag} onRefresh={() => void load()} />
                      : <TabSkeleton loading={loading} />}
      </div>
    </div>
  )
}

function TabSkeleton({ loading }: { loading: boolean }) {
  return (
    <div className="h10-cd-skel" aria-busy={loading}>
      <div className="sk-line w40" />
      <div className="sk-line w70" />
      <div className="sk-block" />
    </div>
  )
}
