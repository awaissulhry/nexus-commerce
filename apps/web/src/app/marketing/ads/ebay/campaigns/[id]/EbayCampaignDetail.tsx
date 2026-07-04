'use client'

/**
 * ER1 — campaign detail v2 SHELL (SPEC-campaign-detail §2–§4): thin routed
 * shell in the Amazon anatomy — fetch → CampaignDetailHeader → .h10-cd-tabs
 * (?tab= routing, default Details paramless) → .h10-cd-body → one component
 * per tab in tabs/. Strategy-aware tab set from tabs.ts; DateRangePicker
 * owns a real {start,end} range (D1) shown on grid tabs only.
 */
import { useCallback, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CampaignDetailHeader, type DetailHeaderAction } from '../../../_shell/CampaignDetailHeader'
import '../../ebay.css'
import { useEbayAdsFetch, postEbayAds, useWriteMode, SandboxBanner, FreshnessLine, type CampaignDetailPayload } from '../../_lib'
import { strategyOf, STRATEGY_BADGE, TABS_BY_STRATEGY, type TabKey } from './tabs'
import { DetailsTab } from './tabs/DetailsTab'
import { AdsTab } from './tabs/AdsTab'
import { AdGroupsTab } from './tabs/AdGroupsTab'
import { KeywordsTab } from './tabs/KeywordsTab'
import { NegativeKeywordsTab } from './tabs/NegativeKeywordsTab'
import { SearchTermsTab } from './tabs/SearchTermsTab'
import { AutomationTab } from './tabs/AutomationTab'
import { ActivityTab } from './tabs/ActivityTab'
import { CloneModal } from './modals/CloneModal'
import { EndCampaignModal } from './modals/EndCampaignModal'
import { CreateAdGroupModal } from './modals/CreateAdGroupModal'
import { PromoteModal } from '../../_modals/PromoteModal'

const defaultRange = () => { const e = new Date(); e.setHours(0, 0, 0, 0); const s = new Date(e); s.setDate(s.getDate() - 29); return { start: s, end: e } }

export function EbayCampaignDetail({ campaignId }: { campaignId: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const writeMode = useWriteMode()
  const [dateRange, setDateRange] = useState(defaultRange)
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignDetailPayload>(`/campaigns/${campaignId}`, 'all', dateRange)
  const [modal, setModal] = useState<null | 'clone' | 'end' | 'addListings' | 'addGroup'>(null)
  const [toast, setToast] = useState<string | null>(null)
  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 5000) }, [])

  const c = data?.campaign
  const strategy = c ? strategyOf(c) : 'GEN'
  const TABS = TABS_BY_STRATEGY[strategy]
  const tabParam = (search.get('tab') ?? 'details') as TabKey
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'details'
  const setTab = (key: TabKey) => {
    const q = new URLSearchParams(search.toString())
    if (key === 'details') q.delete('tab'); else q.set('tab', key)
    router.replace(`/marketing/ads/ebay/campaigns/${campaignId}${q.size ? `?${q}` : ''}`, { scroll: false })
  }
  const gridTab = tab !== 'details' && tab !== 'automation' && tab !== 'activity'

  const lifecycle = useCallback(async (action: 'pause' | 'resume') => {
    try {
      const out = await postEbayAds<{ status: string; mode: string }>(`/campaigns/${campaignId}/action`, { action })
      say(`${action} ✓ → ${out.status} (${out.mode})`)
      reload()
    } catch (e) { say((e as Error).message) }
  }, [campaignId, reload, say])

  const actions = useMemo<DetailHeaderAction[]>(() => {
    if (!c) return []
    const a: DetailHeaderAction[] = []
    if (strategy === 'GEN' || strategy === 'PRI_SMART') a.push({ label: 'Add listings', onClick: () => setModal('addListings') })
    if (strategy === 'PRI_MANUAL') a.push({ label: 'Add ad group', onClick: () => setModal('addGroup') })
    a.push({ label: 'Clone campaign', onClick: () => setModal('clone') })
    if (c.status === 'RUNNING') a.push({ label: 'Pause campaign', onClick: () => void lifecycle('pause') })
    if (c.status === 'PAUSED') a.push({ label: 'Resume campaign', onClick: () => void lifecycle('resume') })
    if (c.status !== 'ENDED') a.push({ label: 'End campaign', danger: true, onClick: () => setModal('end') })
    return a
  }, [c, strategy, lifecycle])

  const policy = c?.automationPolicy

  return (
    <div className="h10-am eb-root">
      <CampaignDetailHeader
        channel="ebay"
        badge={c ? STRATEGY_BADGE[strategy] : undefined}
        title={c?.name ?? ''}
        titleBadges={c ? <>
          {policy?.protected && <span className="h10-pill warn" title="Protected — excluded from ALL automation (rules, coverage guard, discovery)">Protected</span>}
          {c.nexusManaged && <span className="h10-pill arch" title="Created and managed by Nexus">nexus</span>}
        </> : null}
        markets={[c?.marketplace ?? 'EBAY_IT']}
        market={c?.marketplace ?? 'EBAY_IT'}
        onMarketChange={() => {}}
        showDateRange={gridTab}
        dateRange={dateRange}
        onDateRange={(start, end) => setDateRange({ start, end })}
        actions={actions}
        backLabel="Back to eBay Ad Manager"
        backHref="/marketing/ads/ebay/campaigns"
      />

      <nav className="h10-cd-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`h10-cd-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </nav>

      <div className="h10-cd-body">
        {error ? (
          <div className="h10-cd-error">Couldn&apos;t load this campaign — {error}. <button type="button" className="h10-am-link" onClick={reload}>Retry</button></div>
        ) : loading || !data || !c ? (
          <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-line w70" /><div className="sk-block" /></div>
        ) : (
          <>
            <SandboxBanner mode={writeMode} />
            {tab === 'details' && <DetailsTab data={data} campaignId={campaignId} strategy={strategy} onSaved={reload} say={say} />}
            {tab === 'ads' && <AdsTab data={data} campaignId={campaignId} strategy={strategy} reload={reload} say={say} onAddListings={() => setModal('addListings')} />}
            {tab === 'ad-groups' && <AdGroupsTab data={data} campaignId={campaignId} onCreate={() => setModal('addGroup')} />}
            {tab === 'keywords' && <KeywordsTab data={data} campaignId={campaignId} reload={reload} say={say} />}
            {tab === 'negatives' && <NegativeKeywordsTab data={data} campaignId={campaignId} reload={reload} />}
            {tab === 'search-terms' && <SearchTermsTab data={data} campaignId={campaignId} reload={reload} say={say} />}
            {tab === 'automation' && <AutomationTab campaignId={campaignId} campaignStatus={c.status} say={say} onPolicyChange={reload} />}
            {tab === 'activity' && <ActivityTab externalCampaignId={c.externalCampaignId} />}
            {gridTab && <FreshnessLine f={data.freshness} />}
          </>
        )}
      </div>

      {c && <CloneModal open={modal === 'clone'} onClose={() => setModal(null)} campaignId={campaignId} sourceName={c.name} onDone={(id) => router.push(`/marketing/ads/ebay/campaigns/${id}`)} />}
      {c && <EndCampaignModal open={modal === 'end'} onClose={() => setModal(null)} campaignId={campaignId} campaignName={c.name} onDone={() => { say('campaign ended'); reload() }} />}
      <CreateAdGroupModal open={modal === 'addGroup'} onClose={() => setModal(null)} campaignId={campaignId} onDone={() => { say('ad group created'); reload() }} />
      <PromoteModal open={modal === 'addListings'} onClose={() => setModal(null)} presetCampaignId={campaignId} onDone={reload} />

      {toast && <div className="h10-am-toast" role="status">{toast}</div>}
    </div>
  )
}
