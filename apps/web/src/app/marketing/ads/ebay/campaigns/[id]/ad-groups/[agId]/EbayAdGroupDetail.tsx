'use client'

/**
 * ER1 — ad-group drill-down shell (SPEC §6; mirrors Amazon's AdGroupDetail
 * §PL-6): CampaignDetailHeader with "Back to Campaign", same ?tab= idiom
 * (default keywords — THE primary keyword surface), tabs: Keywords · Ads ·
 * Negative Keywords · Search Terms (PRI-only report gate applies upstream).
 */
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CampaignDetailHeader, type DetailHeaderAction } from '../../../../../_shell/CampaignDetailHeader'
import '../../../../ebay.css'
import { useEbayAdsFetch, useWriteMode, SandboxBanner, FreshnessLine, type AdGroupDetailPayload } from '../../../../_lib'
import { AgKeywordsTab } from './tabs/AgKeywordsTab'
import { AgAdsTab } from './tabs/AgAdsTab'
import { AgNegativeKeywordsTab } from './tabs/AgNegativeKeywordsTab'
import { AgSearchTermsTab } from './tabs/AgSearchTermsTab'
import { AddKeywordsModal } from '../../modals/AddKeywordsModal'
import { AddNegativeKeywordsModal } from '../../modals/AddNegativeKeywordsModal'

const TABS = [
  { key: 'keywords', label: 'Keywords' },
  { key: 'ads', label: 'Ads' },
  { key: 'negatives', label: 'Ad Group Negative Keywords' },
  { key: 'search-terms', label: 'Search Terms' },
] as const
type TabKey = (typeof TABS)[number]['key']

const defaultRange = () => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 29); return { start: s, end: e } }

export function EbayAdGroupDetail({ campaignId, adGroupId }: { campaignId: string; adGroupId: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const writeMode = useWriteMode()
  const [dateRange, setDateRange] = useState(defaultRange)
  const { data, error, loading, reload } = useEbayAdsFetch<AdGroupDetailPayload>(`/ad-groups/${adGroupId}`, 'all', dateRange)
  const [modal, setModal] = useState<null | 'keywords' | 'negatives'>(null)
  const [toast, setToast] = useState<string | null>(null)
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 5000) }

  const tabParam = (search.get('tab') ?? 'keywords') as TabKey
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'keywords'
  const setTab = (key: TabKey) => {
    const q = new URLSearchParams(search.toString())
    if (key === 'keywords') q.delete('tab'); else q.set('tab', key)
    router.replace(`/marketing/ads/ebay/campaigns/${campaignId}/ad-groups/${adGroupId}${q.size ? `?${q}` : ''}`, { scroll: false })
  }

  const actions = useMemo<DetailHeaderAction[]>(() => [
    { label: 'Add keywords', onClick: () => setModal('keywords') },
    { label: 'Add negative keywords', onClick: () => setModal('negatives') },
    { label: 'View campaign', href: `/marketing/ads/ebay/campaigns/${campaignId}` },
  ], [campaignId])

  const groups = data ? [{ id: data.adGroup.id, name: data.adGroup.name }] : []

  return (
    <div className="h10-am">
      <CampaignDetailHeader
        channel="ebay"
        label="Ad Group Details"
        title={data?.adGroup.name ?? ''}
        markets={[data?.campaign.marketplace ?? 'EBAY_IT']}
        market={data?.campaign.marketplace ?? 'EBAY_IT'}
        onMarketChange={() => {}}
        showDateRange
        dateRange={dateRange}
        onDateRange={(start, end) => setDateRange({ start, end })}
        actions={actions}
        backLabel="Back to Campaign"
        backHref={`/marketing/ads/ebay/campaigns/${campaignId}?tab=ad-groups`}
      />

      <nav className="h10-cd-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`h10-cd-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </nav>

      <div className="h10-cd-body">
        {error ? (
          <div className="h10-cd-error">Couldn&apos;t load this ad group — {error}. <button type="button" className="h10-am-link" onClick={reload}>Retry</button></div>
        ) : loading || !data ? (
          <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-line w70" /><div className="sk-block" /></div>
        ) : (
          <>
            <SandboxBanner mode={writeMode} />
            {tab === 'keywords' && <AgKeywordsTab data={data} campaignId={campaignId} reload={reload} say={say} onAdd={() => setModal('keywords')} />}
            {tab === 'ads' && <AgAdsTab data={data} />}
            {tab === 'negatives' && <AgNegativeKeywordsTab data={data} onAdd={() => setModal('negatives')} />}
            {tab === 'search-terms' && <AgSearchTermsTab data={data} campaignId={campaignId} />}
            <FreshnessLine f={data.freshness} />
          </>
        )}
      </div>

      <AddKeywordsModal open={modal === 'keywords'} onClose={() => setModal(null)} campaignId={campaignId} adGroups={groups} prefillAdGroupId={adGroupId} onDone={() => { say('keywords added'); reload() }} />
      <AddNegativeKeywordsModal open={modal === 'negatives'} onClose={() => setModal(null)} campaignId={campaignId} adGroups={groups} prefillAdGroupId={adGroupId} onDone={() => { say('negatives added'); reload() }} />

      {toast && <div className="h10-am-toast" role="status">{toast}</div>}
    </div>
  )
}
