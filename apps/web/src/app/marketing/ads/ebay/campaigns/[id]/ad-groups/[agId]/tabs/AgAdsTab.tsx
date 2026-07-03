'use client'

/**
 * ER1 — listings (ads) in this ad group, with OOS-hidden state chips and
 * deep links. Read-focused; CPC ads carry no editable rate (bids live on
 * keywords).
 */
import { useMemo } from 'react'
import { ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../../../../../campaigns/_grid/AdsDataGrid'
import { money } from '../../../../../../campaigns/_grid/format'
import type { AdGroupDetailPayload } from '../../../../../_lib'
import { ebayStatusPill } from '../../../../../_lib/status'
import { StatusPill } from '../../../../../../_shared/StatusPill'
import { metricColumns } from '../../../tabs/metric-columns'

type Row = AdGroupDetailPayload['ads'][number]

export function AgAdsTab({ data }: { data: AdGroupDetailPayload }) {
  const currency = data.currency
  const rows = data.ads
  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'state', label: 'State', metric: false, sortValue: (r) => r.status,
      render: (r) => {
        if (r.hiddenReason || (r.quantity != null && r.quantity <= 0 && r.status === 'ACTIVE')) {
          return <StatusPill label="Hidden — out of stock" cls="warn" title="eBay auto-hides ads for out-of-stock listings and resurfaces them on restock." />
        }
        const p = ebayStatusPill(r.status)
        return <StatusPill label={p.label} cls={p.cls} />
      },
    },
    { key: 'price', label: 'Price', render: (r) => money(r.priceCents, currency), sortValue: (r) => r.priceCents ?? -1 },
    { key: 'qty', label: 'Qty', render: (r) => (r.quantity != null ? String(r.quantity) : '—'), sortValue: (r) => r.quantity ?? -1 },
    ...metricColumns<Row>(rows, currency),
  ], [rows, currency])

  return (
    <AdsDataGrid<Row>
      rows={rows}
      rowId={(r) => r.id}
      noun="Ad"
      firstColLabel="Listing"
      renderFirst={(r) => (
        <div className="nmw">
          <span className="t" title={r.title ?? r.listingId ?? r.id}>{r.title ?? r.listingId ?? '—'}</span>
          {r.listingId && <span className="mk">{r.listingId.slice(-6)}</span>}
          {r.listingId && <a className="h10-open" href={`https://www.ebay.it/itm/${r.listingId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> eBay</a>}
        </div>
      )}
      firstSortValue={(r) => (r.title ?? r.listingId ?? '').toLowerCase()}
      columns={columns}
      storageKey="er1-ebay-ag-ads"
      emptyLabel="No listings in this ad group."
      selectable={false}
      showTotal
    />
  )
}
