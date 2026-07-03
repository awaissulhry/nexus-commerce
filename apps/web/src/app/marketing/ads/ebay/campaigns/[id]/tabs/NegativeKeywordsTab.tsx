'use client'

/**
 * ER1 — "Campaign Negative Keywords" (D5 wording). eBay negatives are
 * group-scoped (EXACT + PHRASE only — verified, teardown §6 #5); this
 * campaign-level tab is the rollup across groups with group links, matching
 * the Keywords-tab pattern. Group-scoped management lives in the drill-down.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AdsDataGrid, type GridColumn } from '../../../../campaigns/_grid/AdsDataGrid'
import type { CampaignDetailPayload, NegativeKeywordRow } from '../../../_lib'
import { ebayStatusPill } from '../../../_lib/status'
import { StatusPill } from '../../../../_shared/StatusPill'
import { AddNegativeKeywordsModal } from '../modals/AddNegativeKeywordsModal'

export function NegativeKeywordsTab({ data, campaignId, reload }: { data: CampaignDetailPayload; campaignId: string; reload: () => void }) {
  const rows = data.negativeKeywords
  const groupsById = useMemo(() => new Map(data.adGroups.map((g) => [g.id, g.name])), [data.adGroups])
  const [addOpen, setAddOpen] = useState(false)

  const columns: GridColumn<NegativeKeywordRow>[] = useMemo(() => [
    { key: 'match', label: 'Match', metric: false, sortValue: (r) => r.matchType, render: (r) => <span className="h10-pill arch">{r.matchType}</span> },
    {
      key: 'group', label: 'Ad Group', metric: false, sortValue: (r) => (r.adGroupId ? groupsById.get(r.adGroupId) ?? '' : ''),
      render: (r) => r.adGroupId
        ? <Link className="h10-am-link" href={`/marketing/ads/ebay/campaigns/${campaignId}/ad-groups/${r.adGroupId}`} onClick={(e) => e.stopPropagation()}>{groupsById.get(r.adGroupId) ?? 'group'}</Link>
        : <span className="h10-pill arch">campaign</span>,
    },
    { key: 'state', label: 'State', metric: false, sortValue: (r) => r.status, render: (r) => { const p = ebayStatusPill(r.status); return <StatusPill label={p.label} cls={p.cls} /> } },
  ], [groupsById, campaignId])

  return (
    <>
      <AdsDataGrid<NegativeKeywordRow>
        rows={rows}
        rowId={(r) => r.id}
        noun="Negative Keyword"
        firstColLabel="Negative Keyword"
        renderFirst={(r) => <div className="nmw"><span className="t">{r.text}</span></div>}
        firstSortValue={(r) => r.text.toLowerCase()}
        columns={columns}
        toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setAddOpen(true)}>+ Negative keywords</button>}
        storageKey="er1-ebay-detail-negatives"
        emptyLabel="No negative keywords (eBay supports EXACT and PHRASE — broad is not supported)."
        searchable
        searchValue={(r) => r.text}
        selectable={false}
      />
      <AddNegativeKeywordsModal open={addOpen} onClose={() => setAddOpen(false)} campaignId={campaignId} adGroups={data.adGroups} onDone={reload} />
    </>
  )
}
