'use client'

/**
 * E6.1 — campaign detail, 1:1 with the Amazon detail idiom:
 * CampaignDetailHeader (Action ▾: pause/resume/end/clone) + .h10-cd-tabs +
 * AdsDataGrid tabs. Ads tab has INLINE ad-rate editing (hover pencil + bulk
 * Edit toolbar → guardrail-checked setAdRates); keywords tab has bid edit +
 * pause/enable bulk; Settings tab = .h10-cd-card summary (budget w/ 15-day
 * meter, rate strategy, criterion, sandbox note).
 */
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { ExternalLink, Plus } from 'lucide-react'
import { CampaignDetailHeader } from '../../../_shell/CampaignDetailHeader'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../../campaigns/_grid/AdsDataGrid'
import { eur, int, pct, latestReportLabel } from '../../../campaigns/_grid/format'
import '../../ebay.css'
import {
  useEbayAdsFetch, postEbayAds, PRESETS, useWriteMode, SandboxBanner, EBAY_STATUS_PILL,
  type CampaignDetailPayload, type AdRow, type KeywordRow,
} from '../../_shared'
import { AddKeywordsModal, AddNegativesModal, CloneModal, PromoteModal, BudgetModal } from '../../_write-modals'

const pill = (status: string) => {
  const sp = EBAY_STATUS_PILL[status] ?? { label: status, cls: '' }
  return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span>
}

export function EbayCampaignDetail({ campaignId }: { campaignId: string }) {
  const router = useRouter()
  const search = useSearchParams()
  const [preset, setPreset] = useState('last30')
  const { data, error, loading, reload } = useEbayAdsFetch<CampaignDetailPayload>(`/campaigns/${campaignId}`, 'all', preset)
  const writeMode = useWriteMode()
  const [modal, setModal] = useState<null | 'keywords' | 'negatives' | 'clone' | 'addListings' | 'budget'>(null)
  const [toast, setToast] = useState<string | null>(null)

  const c = data?.campaign
  const isOffsite = (c?.channels ?? []).includes('OFF_SITE')
  const isCps = c?.fundingModel === 'COST_PER_SALE'
  const isManualCpc = !isCps && !isOffsite && c?.targetingType !== 'SMART'

  const TABS = useMemo(() => {
    const t: Array<{ key: string; label: string }> = []
    if (!isOffsite) t.push({ key: 'ads', label: `Ads${data ? ` (${data.ads.length})` : ''}` })
    if (isManualCpc) {
      t.push({ key: 'keywords', label: `Keywords${data ? ` (${data.keywords.length})` : ''}` })
      t.push({ key: 'negatives', label: `Negative Keywords${data ? ` (${data.negativeKeywords.length})` : ''}` })
    }
    t.push({ key: 'settings', label: 'Settings' })
    return t
  }, [isOffsite, isManualCpc, data])
  const tab = search.get('tab') ?? TABS[0]?.key ?? 'ads'
  const setTab = (key: string) => {
    const q = new URLSearchParams(search.toString())
    if (key === TABS[0]?.key) q.delete('tab'); else q.set('tab', key)
    router.replace(`/marketing/ads/ebay/campaigns/${campaignId}${q.size ? `?${q}` : ''}`, { scroll: false })
  }

  const lifecycle = useCallback(async (action: 'pause' | 'resume' | 'end') => {
    if (action === 'end' && !window.confirm('End this campaign? Ended campaigns cannot be resumed (clone instead).')) return
    try {
      const out = await postEbayAds<{ status: string; mode: string }>(`/campaigns/${campaignId}/action`, { action })
      setToast(`${action} ✓ → ${out.status} (${out.mode})`)
      reload()
    } catch (e) { setToast((e as Error).message) }
  }, [campaignId, reload])

  // ── Ads tab ────────────────────────────────────────────────────────────────
  const adColumns: GridColumn<AdRow>[] = useMemo(() => {
    const ads = data?.ads ?? []
    return [
      {
        key: 'status', label: 'State', metric: false, sortValue: (a) => a.status,
        render: (a) => <span>{pill(a.status)}{a.listingEnded && <span className="h10-pill warn" style={{ marginLeft: 6 }} title="The listing behind this ad is no longer live">listing ended</span>}</span>,
      },
      {
        key: 'rate', label: 'Ad Rate', metric: false, sortValue: (a) => a.bidPercentage ?? -1,
        render: (a) => (
          <span title={a.bidPercentage == null && c?.bidPercentage != null ? `Inherits campaign default ${c.bidPercentage}%` : 'Ad-level rate (authoritative)'}>
            {a.bidPercentage != null ? `${a.bidPercentage}%` : c?.bidPercentage != null ? `(${c.bidPercentage}%)` : '—'}
          </span>
        ),
      },
      {
        key: 'breakeven', label: 'Break-even', metric: false, sortValue: (a) => a.breakEvenAdRatePct ?? -1,
        tip: 'Max profitable rate for this listing. Rates above it are blocked for automations and need a named override for operators.',
        render: (a) => a.breakEvenAdRatePct != null ? <span>{pct(a.breakEvenAdRatePct / 100)}</span> : a.economicsStatus === 'MISSING_PRICE' ? <span className="h10-pill arch">no price</span> : <span className="h10-pill warn">add cost</span>,
      },
      { key: 'price', label: 'Price', render: (a) => (a.priceCents != null ? eur(a.priceCents / 100) : '—'), sortValue: (a) => a.priceCents ?? -1 },
      { key: 'qty', label: 'Qty', render: (a) => (a.quantity != null ? int(a.quantity) : '—'), sortValue: (a) => a.quantity ?? -1 },
      { key: 'impressions', label: 'Impressions', render: (a) => int(a.metrics.impressions), sortValue: (a) => a.metrics.impressions, total: int(ads.reduce((x, a) => x + a.metrics.impressions, 0)) },
      { key: 'clicks', label: 'Clicks', render: (a) => int(a.metrics.clicks), sortValue: (a) => a.metrics.clicks, total: int(ads.reduce((x, a) => x + a.metrics.clicks, 0)) },
      { key: 'ctr', label: 'CTR', render: (a) => (a.metrics.ctrPct != null ? pct(a.metrics.ctrPct / 100) : '—'), sortValue: (a) => a.metrics.ctrPct ?? -1 },
      { key: 'spend', label: 'Ad Fees', render: (a) => eur(a.metrics.adFeesCents / 100), sortValue: (a) => a.metrics.adFeesCents, total: eur(ads.reduce((x, a) => x + a.metrics.adFeesCents, 0) / 100) },
      { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales.', render: (a) => eur(a.metrics.salesCents / 100), sortValue: (a) => a.metrics.salesCents, total: eur(ads.reduce((x, a) => x + a.metrics.salesCents, 0) / 100) },
      { key: 'acos', label: 'ACOS', render: (a) => (a.metrics.acosPct != null ? pct(a.metrics.acosPct / 100) : '—'), sortValue: (a) => a.metrics.acosPct ?? -1 },
      { key: 'sold', label: 'Sold', render: (a) => int(a.metrics.soldQty), sortValue: (a) => a.metrics.soldQty, total: int(ads.reduce((x, a) => x + a.metrics.soldQty, 0)) },
    ]
  }, [data, c])

  const adEditMode: GridEditMode<AdRow> | undefined = useMemo(() => (!isCps ? undefined : {
    label: 'Edit Ad Rates',
    fields: [{
      key: 'rate',
      initial: (a) => (a.bidPercentage != null ? String(a.bidPercentage) : c?.bidPercentage != null ? String(c.bidPercentage) : ''),
      render: (value, set) => (
        <input className="h10-cd-input" style={{ width: 72 }} type="number" min={2} max={100} step={0.1} value={value} onChange={(e) => set(e.target.value)} aria-label="Ad rate %" />
      ),
    }],
    onApply: async (edits) => {
      const ads = data?.ads ?? []
      const items = edits
        .map((e) => ({ listingId: ads.find((a) => a.id === e.id)?.listingId, ratePct: Number(e.values.rate) }))
        .filter((x): x is { listingId: string; ratePct: number } => !!x.listingId && Number.isFinite(x.ratePct))
      if (!items.length) return
      const out = await postEbayAds<{ results: Array<{ key: string; ok: boolean; blocked?: string | null; error?: string | null; warning?: string | null }> }>(`/campaigns/${campaignId}/ad-rates`, { items })
      const bad = out.results.filter((r) => !r.ok)
      setToast(bad.length ? `${bad.length} blocked/failed — ${bad[0]!.blocked ?? bad[0]!.error ?? ''}` : `rates updated (${out.results.length})`)
      reload()
    },
  }), [isCps, data, c, campaignId, reload])

  // ── Keywords tab ───────────────────────────────────────────────────────────
  const kwColumns: GridColumn<KeywordRow>[] = useMemo(() => {
    const ks = data?.keywords ?? []
    return [
      { key: 'match', label: 'Match', metric: false, sortValue: (k) => k.matchType, render: (k) => <span className="h10-pill arch">{k.matchType}</span> },
      { key: 'group', label: 'Ad Group', metric: false, sortValue: (k) => k.adGroupName ?? '', render: (k) => k.adGroupName ?? '—' },
      { key: 'bid', label: 'Bid', metric: false, sortValue: (k) => k.bidCents ?? -1, render: (k) => (k.bidCents != null ? eur(k.bidCents / 100) : '—') },
      { key: 'status', label: 'Status', metric: false, sortValue: (k) => k.status, render: (k) => pill(k.status) },
      { key: 'impressions', label: 'Impressions', render: (k) => int(k.metrics.impressions), sortValue: (k) => k.metrics.impressions, total: int(ks.reduce((x, k) => x + k.metrics.impressions, 0)) },
      { key: 'clicks', label: 'Clicks', render: (k) => int(k.metrics.clicks), sortValue: (k) => k.metrics.clicks, total: int(ks.reduce((x, k) => x + k.metrics.clicks, 0)) },
      { key: 'spend', label: 'Ad Fees', render: (k) => eur(k.metrics.adFeesCents / 100), sortValue: (k) => k.metrics.adFeesCents, total: eur(ks.reduce((x, k) => x + k.metrics.adFeesCents, 0) / 100) },
      { key: 'sales', label: 'Ad Sales', render: (k) => eur(k.metrics.salesCents / 100), sortValue: (k) => k.metrics.salesCents, total: eur(ks.reduce((x, k) => x + k.metrics.salesCents, 0) / 100) },
    ]
  }, [data])

  const kwEditMode: GridEditMode<KeywordRow> = useMemo(() => ({
    label: 'Edit Bids',
    fields: [{
      key: 'bid',
      initial: (k) => (k.bidCents != null ? (k.bidCents / 100).toFixed(2) : ''),
      render: (value, set) => (
        <input className="h10-cd-input" style={{ width: 72 }} type="number" min={0.02} max={100} step={0.01} value={value} onChange={(e) => set(e.target.value)} aria-label="Bid EUR" />
      ),
    }],
    onApply: async (edits) => {
      const updates = edits
        .map((e) => ({ keywordId: e.id, bidCents: Math.round(Number(e.values.bid) * 100) }))
        .filter((u) => Number.isFinite(u.bidCents) && u.bidCents >= 2)
      if (!updates.length) return
      await postEbayAds(`/campaigns/${campaignId}/keywords/update`, { updates })
      setToast(`bids updated (${updates.length})`)
      reload()
    },
  }), [campaignId, reload])

  const patchKeywords = useCallback(async (ids: string[], status: 'ACTIVE' | 'PAUSED', clear: () => void) => {
    await postEbayAds(`/campaigns/${campaignId}/keywords/update`, { updates: ids.map((keywordId) => ({ keywordId, status })) })
    setToast(`${ids.length} keyword(s) → ${status.toLowerCase()}`)
    clear()
    reload()
  }, [campaignId, reload])

  const removeAds = useCallback(async (ids: string[], clear: () => void) => {
    const ads = data?.ads ?? []
    const listingIds = ids.map((id) => ads.find((a) => a.id === id)?.listingId).filter((x): x is string => !!x)
    if (!listingIds.length || !window.confirm(`Remove ${listingIds.length} ad(s) from this campaign?`)) return
    await postEbayAds(`/campaigns/${campaignId}/ads/remove`, { listingIds })
    setToast(`removed ${listingIds.length} ad(s)`)
    clear()
    reload()
  }, [data, campaignId, reload])

  return (
    <div className="h10-cd">
      <CampaignDetailHeader
        title={c?.name ?? 'Campaign'}
        label="Campaign Details"
        backLabel="Back to eBay Ad Manager"
        backHref="/marketing/ads/ebay/campaigns"
        markets={c ? [c.marketplace] : []}
        market={c?.marketplace ?? ''}
        onMarketChange={() => {}}
        showDateRange={false}
        dateRange={{ start: new Date(), end: new Date() }}
        onDateRange={() => {}}
        actions={[
          ...(c?.status === 'RUNNING' ? [{ label: 'Pause', onClick: () => void lifecycle('pause') }] : []),
          ...(c?.status === 'PAUSED' || c?.status === 'DRAFT' ? [{ label: c?.status === 'DRAFT' ? 'Activate' : 'Enable', onClick: () => void lifecycle('resume') }] : []),
          { label: 'Clone', onClick: () => setModal('clone') },
          ...(isCps && !c?.isRulesBased ? [{ label: 'Add listings', onClick: () => setModal('addListings') }] : []),
          ...(isManualCpc ? [{ label: 'Add keywords', onClick: () => setModal('keywords') }, { label: 'Add negatives', onClick: () => setModal('negatives') }] : []),
          ...(!isCps && !isOffsite ? [{ label: 'Edit budget', onClick: () => setModal('budget') }] : []),
          ...(c?.status !== 'ENDED' ? [{ label: 'End campaign', onClick: () => void lifecycle('end'), danger: true }] : []),
        ]}
      />

      <nav className="h10-cd-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`h10-cd-tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </nav>

      <div className="h10-cd-body">
        <SandboxBanner mode={writeMode} />
        {error && <div className="h10-am-latest" role="alert"><b>Load failed:</b> {error} · <button className="h10-am-link" onClick={reload}>Retry</button></div>}
        {loading && !data && <div className="h10-cd-skel"><span className="sk-line w40" /><span className="sk-line w70" /><span className="sk-block" /></div>}

        {data && c && tab === 'ads' && (
          <AdsDataGrid<AdRow>
            rows={data.ads}
            rowId={(a) => a.id}
            noun="Ad"
            firstColLabel="Listing"
            renderFirst={(a) => (
              <div className="nmw">
                <span className="t" title={a.title ?? a.listingId ?? ''}>{a.title ?? a.inventoryReference ?? a.listingId ?? '—'}</span>
                {a.listingId && <span className="mk">{a.listingId.slice(-6)}</span>}
                {a.createdVia === 'DISCOVERED' && <span className="mk" title="Created in Seller Hub">hub</span>}
                {a.listingId && <a className="h10-open" href={`https://www.ebay.it/itm/${a.listingId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>}
              </div>
            )}
            firstSortValue={(a) => (a.title ?? a.listingId ?? '').toLowerCase()}
            columns={adColumns}
            showTotal
            defaultSort={{ key: 'spend', dir: 'desc' }}
            storageKey="h10-ebay-cd-ads-cols"
            editMode={adEditMode}
            selectionActions={isCps ? (ids, clear) => (
              <span className="h10-bulkrow">
                <button type="button" className="h10-am-btn bulk" onClick={() => void removeAds(ids, clear)}>Remove</button>
              </span>
            ) : undefined}
            reportLabel={latestReportLabel([data.freshness.factsReportedAt])}
            toolbarLeft={
              <select className="h10-am-btn" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range" style={{ paddingRight: 8 }}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            }
            toolbarRight={isCps && !c.isRulesBased ? <button type="button" className="h10-am-btn primary" onClick={() => setModal('addListings')}><Plus size={13} /> Add listings</button> : undefined}
            emptyLabel={c.isRulesBased ? 'Rules-based: eBay attaches matching listings daily; the hourly sync mirrors them here.' : 'No ads yet — Add listings to promote.'}
          />
        )}

        {data && tab === 'keywords' && (
          <AdsDataGrid<KeywordRow>
            rows={data.keywords}
            rowId={(k) => k.id}
            noun="Keyword"
            firstColLabel="Keyword"
            renderFirst={(k) => <div className="nmw"><span className="t" title={k.text}>{k.text}</span></div>}
            firstSortValue={(k) => k.text.toLowerCase()}
            columns={kwColumns}
            showTotal
            defaultSort={{ key: 'clicks', dir: 'desc' }}
            storageKey="h10-ebay-cd-kw-cols"
            editMode={kwEditMode}
            selectionActions={(ids, clear) => (
              <span className="h10-bulkrow">
                <button type="button" className="h10-am-btn bulk" onClick={() => void patchKeywords(ids, 'ACTIVE', clear)}>Enable</button>
                <button type="button" className="h10-am-btn bulk" onClick={() => void patchKeywords(ids, 'PAUSED', clear)}>Pause</button>
              </span>
            )}
            reportLabel={latestReportLabel([data.freshness.factsReportedAt])}
            toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setModal('keywords')}><Plus size={13} /> Add keywords</button>}
            emptyLabel="No keywords — add some, or use suggested keywords from the Add dialog."
          />
        )}

        {data && tab === 'negatives' && (
          <AdsDataGrid<CampaignDetailPayload['negativeKeywords'][number]>
            rows={data.negativeKeywords}
            rowId={(n) => n.id}
            noun="Negative Keyword"
            firstColLabel="Negative Keyword"
            renderFirst={(n) => <div className="nmw"><span className="t">−{n.text}</span></div>}
            firstSortValue={(n) => n.text.toLowerCase()}
            columns={[
              { key: 'match', label: 'Match', metric: false, render: (n) => <span className="h10-pill arch">{n.matchType}</span> },
              { key: 'status', label: 'Status', metric: false, render: (n) => pill(n.status) },
            ]}
            storageKey="h10-ebay-cd-neg-cols"
            toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setModal('negatives')}><Plus size={13} /> Add negatives</button>}
            emptyLabel="No negative keywords (eBay supports EXACT and PHRASE — no broad)."
          />
        )}

        {data && c && tab === 'settings' && (
          <div className="h10-cd-card pad" style={{ maxWidth: 760 }}>
            <div className="eb-headstats">
              <div><span className="k">Strategy</span><span className="v">{isOffsite ? 'Offsite' : isCps ? `General · ${c.adRateStrategy?.toLowerCase() ?? 'fixed'}` : `Priority · ${c.targetingType?.toLowerCase() ?? 'manual'}`}</span></div>
              <div><span className="k">Status</span><span className="v">{pill(c.status)}</span></div>
              {isCps && <div><span className="k">Campaign rate</span><span className="v">{c.bidPercentage != null ? `${c.bidPercentage}%` : 'per-ad'}</span></div>}
              {!isCps && <div><span className="k">Daily budget</span><span className="v">{c.dailyBudgetCents != null ? `${eur(c.dailyBudgetCents / 100)}/day` : '—'} <button type="button" className="h10-am-link" onClick={() => setModal('budget')}>edit</button></span></div>}
              {!isCps && <div><span className="k">Budget edits today</span><span className="v" title="eBay hard limit: 15 per campaign per day">{c.budgetUpdatesToday} / 15</span></div>}
              <div><span className="k">Started</span><span className="v">{new Date(c.startDate).toLocaleDateString('en-GB')}</span></div>
              {c.endDate && <div><span className="k">Ended</span><span className="v">{new Date(c.endDate).toLocaleDateString('en-GB')}</span></div>}
              <div><span className="k">Managed by</span><span className="v">{c.nexusManaged ? 'Nexus' : 'Seller Hub'}</span></div>
            </div>
            {c.isRulesBased && (
              <p className="eb-be-hint" style={{ marginTop: 12 }}>
                Rules-based campaign — selection rules are immutable on eBay; <b>Clone</b> (Action ▾) is how you change them.
                Criterion: <code>{JSON.stringify(c.campaignCriterion)}</code>
              </p>
            )}
            {isOffsite && <p className="eb-be-hint" style={{ marginTop: 12 }}>Promoted Offsite is campaign-level only: eBay manages placement and CPC on external networks. No per-listing ads or keywords exist.</p>}
            {c.adRateStrategy === 'DYNAMIC' && <p className="eb-be-hint" style={{ marginTop: 12 }}>Dynamic rate follows eBay's suggestion daily under your hard cap: <code>{JSON.stringify(c.dynamicAdRatePrefs)}</code></p>}
          </div>
        )}

        {toast && <div className="h10-am-toast" role="status">{toast}</div>}
      </div>

      <AddKeywordsModal open={modal === 'keywords'} onClose={() => setModal(null)} campaignId={campaignId} adGroups={data?.adGroups ?? []} onDone={reload} />
      <AddNegativesModal open={modal === 'negatives'} onClose={() => setModal(null)} campaignId={campaignId} adGroups={data?.adGroups ?? []} onDone={reload} />
      <CloneModal open={modal === 'clone'} onClose={() => setModal(null)} campaignId={campaignId} sourceName={c?.name ?? ''} onDone={(id) => router.push(`/marketing/ads/ebay/campaigns/${id}`)} />
      <PromoteModal open={modal === 'addListings'} onClose={() => setModal(null)} presetCampaignId={campaignId} onDone={reload} />
      {c && <BudgetModal open={modal === 'budget'} onClose={() => setModal(null)} campaignId={campaignId} currentCents={c.dailyBudgetCents} usedToday={c.budgetUpdatesToday} onDone={reload} />}
    </div>
  )
}
