'use client'

/**
 * Google Ads step 1b, WB — one Google campaign in the DS `DetailModal` (centred, 1160 px; a full-screen sheet on a
 * phone), opened through the address: `?campaign=<id>&tab=<tab>` (`useGoogleCampaignParam`, the shared
 * `useDetailParam`): opening it is a step in the history, so Back closes it, and a copied address (an alert's Open)
 * opens it on that tab.
 *
 *   header   name · "Read from Google. Changes to this campaign are made in Google Ads." · status, type, bidding, budget
 *   tabs     from the campaign's type (`campaignTabs`); a tab that does not apply is absent
 *   Overview the step-1a window: its settings, and its days in the page's window (a day not read says "Not read")
 *   …        ad groups, keywords, asset groups, products, negatives, search terms, Google acts on its own
 *   Changes  Google's change history for it (R4): when, where it was made, what changed — never who by e-mail
 *
 * An address with a campaign the server does not find in this business (404) says so, with Close and no Try again.
 *
 * A row of the Ad groups tab opens Keywords filtered to that ad group. Read only: no control here changes Google Ads.
 */
import { useCallback, useMemo, useState } from 'react'
import { Banner, EmptyState, KeyValue, PerformanceGraph, SummaryTable, type KeyValueItem, type TabItem } from '@/design-system/components'
import { DetailModal } from '@/design-system/patterns'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { chart } from '@/design-system/tokens'
import {
  fetchGoogleCampaignChanges,
  fetchGoogleCampaignDays,
  type GoogleCampaign,
  type GoogleCampaignChanges,
  type GoogleCampaignDays,
} from '@/lib/google-ads/contract'
import { useDetailParam, type DetailParam } from '../_shared/useDetailParam'
import { GoogleAdGroupsTab } from './GoogleAdGroupsTab'
import { GoogleAssetGroupsTab } from './GoogleAssetGroupsTab'
import { GoogleCampaignActsTab } from './GoogleCampaignActsTab'
import { GoogleKeywordsTab } from './GoogleKeywordsTab'
import { GoogleNegativesTab } from './GoogleNegativesTab'
import { GoogleProductsGrid } from './GoogleProductsGrid'
import { GoogleSearchTermsGrid } from './GoogleSearchTermsGrid'
import {
  CHANGE_COLUMNS,
  DAY_COLUMNS,
  biddingLabel,
  budgetText,
  campaignStatusHint,
  campaignStatusLabel,
  campaignTypeLabel,
  changeRows,
  changesNote,
  chartHasMoney,
  chartPoints,
  coverageNote,
  formatDay,
  formatMoney,
  formatWindow,
  dayRows,
  provisionalDays,
  provisionalNote,
  servingText,
  settingsReadText,
  toMinor,
} from './googleAds'
import { CAMPAIGN_NOT_HERE, CAMPAIGN_TAB_LABEL, campaignTabOf, campaignTabs, campaignWindowBody, type CampaignTab } from './googleGrains'
import { googleReadKey, useGoogleRead, type GoogleReadState } from './useGoogleRead'
import './googleModal.css'

/** The campaign window's address: `?campaign=<id>&tab=<tab>`. */
export const GOOGLE_CAMPAIGN_PARAM = { key: 'campaign', tabKey: 'tab' } as const

/** The page's ONE handle on the campaign window: open a row (`open(id)`, or `open(id, 'overview')` from an alert). */
export function useGoogleCampaignParam(): DetailParam {
  return useDetailParam(GOOGLE_CAMPAIGN_PARAM)
}

export interface GoogleCampaignModalProps {
  /** From `useGoogleCampaignParam()` on the page: the open campaign's id and tab, and how to close it. */
  detail: DetailParam
  /** The page's row for `detail.id`, when the campaigns grid holds it (the header shows at once); else null. */
  campaign: GoogleCampaign | null
  /** The Google connection (as the page reads it); null = the business's one Google Ads account. */
  account: string | null
  /** The page's window (as the server answered it). */
  window: { from: string; to: string }
  currency: string | null
  /** When Nexus reads Google next (the account's `read.nextReadAt`), for "Not read yet". */
  nextReadAt: string | null
}

/** Renders nothing while no campaign is open; one window per campaign (its state starts fresh on another). */
export function GoogleCampaignModal(props: GoogleCampaignModalProps) {
  if (!props.detail.id) return null
  return <CampaignWindow key={props.detail.id} id={props.detail.id} {...props} />
}

type CountTab = Extract<CampaignTab, 'ad-groups' | 'keywords' | 'negatives' | 'asset-groups'>

function CampaignWindow({ id, detail, campaign, account, window: range, currency, nextReadAt }: GoogleCampaignModalProps & { id: string }) {
  const { from, to } = range
  const days = useGoogleRead<GoogleCampaignDays>(googleReadKey('campaign-days', id, from, to), () => fetchGoogleCampaignDays(id, { from, to }), { keepPrevious: true })

  // The days answer carries the campaign as Google holds it now; until it arrives, the grid's row.
  const c = days.data?.campaign ?? campaign
  const ccy = days.data?.currency ?? currency
  const tabs = c ? campaignTabs(c.type, c.status) : (['overview'] as CampaignTab[])
  const active = campaignTabOf(detail.tab, tabs)

  const changes = useGoogleRead<GoogleCampaignChanges>(active === 'changes' ? googleReadKey('campaign-changes', id) : null, () => fetchGoogleCampaignChanges(id))

  // Counts only for the tabs read so far (null = not known, never 0).
  const [counts, setCounts] = useState<Partial<Record<CountTab, number | null>>>({})
  const onCount = useMemo(() => {
    const of = (tab: CountTab) => (n: number | null) => setCounts((s) => (s[tab] === n ? s : { ...s, [tab]: n }))
    return { adGroups: of('ad-groups'), keywords: of('keywords'), negatives: of('negatives'), assetGroups: of('asset-groups') }
  }, [])

  // An ad group's row opens Keywords filtered to it; the Keywords tab itself shows every keyword.
  const [keywordAdGroup, setKeywordAdGroup] = useState<string | null>(null)
  const showTab = useCallback((tab: string) => {
    setKeywordAdGroup(null)
    detail.setTab(tab === 'overview' ? null : tab)
  }, [detail])
  const hasKeywords = tabs.includes('keywords')
  const openAdGroup = useCallback((externalAdGroupId: string) => {
    setKeywordAdGroup(externalAdGroupId)
    detail.setTab('keywords')
  }, [detail])

  const tabItems: TabItem[] = tabs.map((t) => ({ id: t, label: CAMPAIGN_TAB_LABEL[t], ...(t in counts ? { count: counts[t as CountTab] ?? null } : {}) }))

  const meta = c ? (
    <span className="gads-pills">
      <Pill tone={c.status === 'ENABLED' ? 'success' : 'neutral'} size="sm">{campaignStatusLabel(c.status)}</Pill>
      {/* A type Nexus has not read is no chip ("—" in a chip reads as an empty control). */}
      {campaignTypeLabel(c.type) !== '—' && <Pill tone="neutral" size="sm">{campaignTypeLabel(c.type)}</Pill>}
      {c.biddingStrategy && <Pill tone="neutral" size="sm">{biddingLabel(c.biddingStrategy)}</Pill>}
      {budgetText(c, ccy) !== '—' && <Pill tone="neutral" size="sm">{budgetText(c, ccy)}</Pill>}
    </span>
  ) : undefined

  const grain = { account, window: range, currency: ccy, nextReadAt }
  const body = campaignWindowBody({ hasCampaign: !!c, loading: days.loading, status: days.status })

  return (
    <DetailModal
      open
      onClose={detail.close}
      title={c?.name ?? 'Google campaign'}
      subtitle="Read from Google. Changes to this campaign are made in Google Ads."
      meta={meta}
      tabs={c ? tabItems : undefined}
      activeTab={active}
      onTabChange={showTab}
      tabsLabel="Campaign"
      loading={body === 'loading'}
      error={body === 'error' ? days.error ?? 'Nexus answered without this campaign.' : undefined}
      onRetry={days.reload}
    >
      {body === 'not_here' && <EmptyState title={CAMPAIGN_NOT_HERE} />}
      {c && active === 'overview' && <Overview c={c} days={days} currency={ccy} range={range} />}
      {c && active === 'ad-groups' && (
        <GoogleAdGroupsTab campaignId={id} {...grain} onOpenAdGroup={hasKeywords ? openAdGroup : undefined} onCount={onCount.adGroups} />
      )}
      {c && active === 'keywords' && <GoogleKeywordsTab key={keywordAdGroup ?? '-'} campaignId={id} {...grain} adGroup={keywordAdGroup} onCount={onCount.keywords} />}
      {c && active === 'asset-groups' && <GoogleAssetGroupsTab campaignId={id} {...grain} onCount={onCount.assetGroups} />}
      {c && active === 'products' && <GoogleProductsGrid campaignId={id} {...grain} />}
      {c && active === 'negatives' && <GoogleNegativesTab campaignId={id} account={account} nextReadAt={nextReadAt} onCount={onCount.negatives} />}
      {c && active === 'search-terms' && <GoogleSearchTermsGrid campaignId={id} {...grain} />}
      {c && active === 'on-its-own' && <GoogleCampaignActsTab account={account} externalCampaignId={c.externalCampaignId} nextReadAt={nextReadAt} />}
      {c && active === 'changes' && <Changes c={c} changes={changes} />}
    </DetailModal>
  )
}

/** The step-1a window, unchanged: the campaign's settings, then its days in the page's window. */
function Overview({ c, days, currency: ccy, range }: { c: GoogleCampaign; days: GoogleReadState<GoogleCampaignDays>; currency: string | null; range: { from: string; to: string } }) {
  const { from, to } = range
  const serving = servingText(c)
  const facts: KeyValueItem[] = [
    { label: 'Status', value: <Pill tone={c.status === 'ENABLED' ? 'success' : 'neutral'} size="sm">{campaignStatusLabel(c.status)}</Pill>, hint: serving ?? campaignStatusHint(c.status) ?? undefined },
    { label: 'Type', value: campaignTypeLabel(c.type) },
    { label: 'Bidding', value: biddingLabel(c.biddingStrategy) },
    { label: 'Daily budget', value: budgetText(c, ccy) },
    { label: 'Starts', value: formatDay(c.startDate) },
    // "No end date" only from settings Nexus read: without them an empty end date says nothing.
    { label: 'Ends', value: c.endDate ? formatDay(c.endDate) : settingsReadText(c) === 'Not read yet' ? '—' : 'No end date' },
    { label: 'Settings read', value: settingsReadText(c), hint: 'When Nexus last read these settings from Google.' },
  ]

  // While another window loads, its days are not these: a skeleton, never the last window's days under this title.
  const d = days.loading ? null : days.data
  const note = d ? provisionalNote(provisionalDays(d.days, d.window.provisionalFrom)) : null
  const gaps = d ? coverageNote(d) : null

  return (
    <div className="gads-modal">
      <KeyValue items={facts} columns={2} />

      <section className="gads-section" aria-labelledby="gads-days-h">
        <h3 id="gads-days-h">Days, {formatWindow(from, to)}</h3>
        {!d && !days.error && <Skeleton height={200} radius="var(--nds-radius-lg)" />}
        {days.error && <Banner tone="danger" title="The days could not be loaded" action={<Button onClick={days.reload}>Try again</Button>}>{days.error}</Banner>}
        {d && <>
          {gaps && <Banner tone="warning">{gaps}</Banner>}
          {chartHasMoney(d.days) && ccy ? (
            <PerformanceGraph
              data={chartPoints(d.days, ccy)}
              xKey="day"
              left={{ key: 'cost', label: 'Cost', axisLabel: `Cost (${ccy})`, color: chart.cap, axis: 'left', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
              right={{ key: 'value', label: 'Conversion value', axisLabel: `Conversion value (${ccy})`, color: chart.actual, axis: 'right', format: (v) => formatMoney(toMinor(v, ccy), ccy) }}
              height={200}
            />
          ) : (
            <p className="gads-meta">No cost or conversion value to draw for these days.</p>
          )}
          {note && <p className="gads-note">{note}</p>}
          <div className="gads-table gads-days" tabIndex={0} role="region" aria-label="Days table">
            <SummaryTable label={`Days of ${c.name}`} columns={DAY_COLUMNS} rows={dayRows(d.days, ccy)} />
          </div>
        </>}
      </section>

      <p className="gads-note">Changes to this campaign are made in Google Ads. Nexus reads them and changes nothing.</p>
    </div>
  )
}

/** Google's change history for the campaign (R4), as in step 1a. */
function Changes({ c, changes }: { c: GoogleCampaign; changes: GoogleReadState<GoogleCampaignChanges> }) {
  const changeItems = changes.data ? changeRows(changes.data.items) : []
  return (
    <section className="gads-section" aria-labelledby="gads-changes-h">
      <h3 id="gads-changes-h">Changes in the last 30 days</h3>
      {!changes.data && !changes.error && <Skeleton height={80} radius="var(--nds-radius-lg)" />}
      {changes.error && <Banner tone="danger" title="The change history could not be loaded" action={<Button onClick={changes.reload}>Try again</Button>}>{changes.error}</Banner>}
      {changes.data && <>
        <p className="gads-meta">{changesNote(changes.data, changes.data.items.length)}</p>
        {changeItems.length > 0 && (
          <div className="gads-table" tabIndex={0} role="region" aria-label="Changes table">
            <SummaryTable label={`Changes to ${c.name}`} columns={CHANGE_COLUMNS} rows={changeItems} />
          </div>
        )}
      </>}
    </section>
  )
}
