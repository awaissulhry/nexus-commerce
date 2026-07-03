'use client'

/**
 * ER1 — Ads tab (GEN / PRI-smart / OFF): the v1 grid preserved (AdsDataGrid
 * + GridEditMode hover-pencil/bulk rate edit + break-even beside every rate)
 * with the spec's additions — OOS "Hidden" state chips from hiddenReason,
 * product/eBay deep links, RemoveAdsModal instead of window.confirm, and the
 * OverrideReasonModal flow for guardrail-blocked rate edits. OFF renders
 * read-only (eBay manages Offsite CPC).
 */
import { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../../../campaigns/_grid/AdsDataGrid'
import { pct, money } from '../../../../campaigns/_grid/format'
import { postEbayAds, type AdRow, type CampaignDetailPayload, type WriteItemOutcome } from '../../../_lib'
import { ebayStatusPill } from '../../../_lib/status'
import { StatusPill } from '../../../../_shared/StatusPill'
import { metricColumns } from './metric-columns'
import { OverrideReasonModal } from '../../../_modals/OverrideReasonModal'
import { RemoveAdsModal } from '../modals/RemoveAdsModal'
import type { Strategy } from '../tabs'

export function AdsTab({ data, campaignId, strategy, reload, say, onAddListings }: {
  data: CampaignDetailPayload; campaignId: string; strategy: Strategy
  reload: () => void; say: (m: string) => void; onAddListings: () => void
}) {
  const currency = data.currency
  const rows = data.ads
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removeIds, setRemoveIds] = useState<string[] | null>(null)
  const [blocked, setBlocked] = useState<Array<{ listingId: string; ratePct: number; reason: string }> | null>(null)
  const editable = strategy !== 'OFF' && data.campaign.fundingModel === 'COST_PER_SALE'

  const applyRates = async (items: Array<{ listingId: string; ratePct: number }>, override?: { reason: string }) => {
    const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${campaignId}/ad-rates`, { items, ...(override ? { override } : {}) })
    const blockedItems = out.results.filter((r) => r.blocked)
    const ok = out.results.filter((r) => r.ok).length
    if (blockedItems.length && !override) {
      setBlocked(blockedItems.map((b) => ({ listingId: b.key, ratePct: items.find((i) => i.listingId === b.key)?.ratePct ?? 0, reason: b.blocked! })))
    }
    if (ok) { say(`${ok} rate(s) updated`); reload() }
    else if (!blockedItems.length) say(out.results[0]?.error ?? 'no changes applied')
  }

  const editMode: GridEditMode<AdRow> | undefined = editable ? {
    label: 'Edit Ad Rates',
    fields: [{
      key: 'rate',
      initial: (r) => (r.bidPercentage != null ? String(r.bidPercentage) : ''),
      render: (value, set) => <input className="h10-edit-in" type="number" min={2} max={100} step={0.1} value={value} onChange={(e) => set(e.target.value)} aria-label="Ad rate %" />,
    }],
    onApply: async (edits) => {
      const items = edits.map((e) => ({ listingId: rows.find((r) => r.id === e.id)?.listingId ?? '', ratePct: Number(e.values.rate) })).filter((i) => i.listingId && Number.isFinite(i.ratePct))
      if (items.length) await applyRates(items)
    },
  } : undefined

  const columns: GridColumn<AdRow>[] = useMemo(() => [
    {
      key: 'state', label: 'State', metric: false, sortValue: (r) => r.status,
      render: (r) => {
        if (r.hiddenReason || (r.quantity != null && r.quantity <= 0 && r.status === 'ACTIVE')) {
          return <StatusPill label="Hidden — out of stock" cls="warn" title="eBay auto-hides ads for out-of-stock listings and resurfaces them on restock — a state, not an error." />
        }
        const p = ebayStatusPill(r.status)
        return <StatusPill label={p.label} cls={p.cls} />
      },
    },
    ...(editable ? [{
      key: 'rate', label: 'Ad Rate', tip: 'CPS rate = % of the total sale charged when an attributed sale happens. The guardrail blocks rates above break-even without a named reason.',
      render: (r: AdRow) => (r.bidPercentage != null ? pct(r.bidPercentage / 100) : '—'), sortValue: (r: AdRow) => r.bidPercentage ?? -1,
    }] : []),
    {
      key: 'breakeven', label: 'Break-even', tip: 'Max profitable rate = contribution margin ÷ total sale amount, from your product costs.',
      render: (r) => (r.breakEvenAdRatePct != null ? pct(r.breakEvenAdRatePct / 100) : r.economicsStatus === 'MISSING_PRICE' ? <span className="h10-pill arch">no price</span> : <span className="h10-pill warn" title="No product cost on file — enter it on the Products page">add cost</span>),
      sortValue: (r) => r.breakEvenAdRatePct ?? -1,
    },
    { key: 'price', label: 'Price', render: (r) => money(r.priceCents, currency), sortValue: (r) => r.priceCents ?? -1 },
    { key: 'qty', label: 'Qty', render: (r) => (r.quantity != null ? String(r.quantity) : '—'), sortValue: (r) => r.quantity ?? -1 },
    ...metricColumns<AdRow>(rows, currency),
  ], [rows, currency, editable])

  return (
    <>
      {strategy === 'OFF' && <p className="eb-be-hint" style={{ marginBottom: 10 }}>Promoted Offsite — eBay manages placement and CPC on external networks; ads here are read-only.</p>}
      <AdsDataGrid<AdRow>
        rows={rows}
        rowId={(r) => r.id}
        noun="Ad"
        firstColLabel="Listing"
        renderFirst={(r) => (
          <div className="nmw">
            <span className="t" title={r.title ?? r.listingId ?? r.id}>{r.title ?? r.listingId ?? r.inventoryReference ?? '—'}</span>
            {r.listingId && <span className="mk">{r.listingId.slice(-6)}</span>}
            {r.listingId && <a className="h10-open" href={`https://www.ebay.it/itm/${r.listingId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> eBay</a>}
            {r.productId && <a className="h10-open" href="/marketing/ads/ebay/products" onClick={(e) => e.stopPropagation()}>Product</a>}
          </div>
        )}
        firstSortValue={(r) => (r.title ?? r.listingId ?? '').toLowerCase()}
        columns={columns}
        editMode={editMode}
        selectable={editable}
        selected={selected}
        onSelectedChange={setSelected}
        selectionActions={editable ? (ids, clear) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" onClick={() => { setRemoveIds(rows.filter((r) => ids.includes(r.id)).map((r) => r.listingId!).filter(Boolean)); clear() }}>Remove ads</button>
          </span>
        ) : undefined}
        toolbarRight={editable ? <button type="button" className="h10-am-btn primary" onClick={onAddListings}>+ Add listings</button> : undefined}
        storageKey="er1-ebay-detail-ads"
        emptyLabel={editable ? 'No ads — Add listings, or let the coverage guard propose enrollment.' : 'No ads.'}
        searchable
        searchValue={(r) => `${r.title ?? ''} ${r.listingId ?? ''}`}
        defaultSort={{ key: 'spend', dir: 'desc' }}
        showTotal
      />
      <RemoveAdsModal open={removeIds != null} onClose={() => setRemoveIds(null)} campaignId={campaignId} listingIds={removeIds ?? []} onDone={() => { say('ads removed'); reload() }} />
      <OverrideReasonModal
        open={blocked != null}
        onClose={() => setBlocked(null)}
        title="Rates above break-even"
        blockedItems={(blocked ?? []).map((b) => `${b.listingId} → ${b.ratePct}% — ${b.reason}`)}
        onSubmit={async (reason) => {
          const items = (blocked ?? []).map((b) => ({ listingId: b.listingId, ratePct: b.ratePct }))
          setBlocked(null)
          await applyRates(items, { reason })
        }}
      />
    </>
  )
}
