'use client'

/**
 * ER1 — this ad group's negative keywords (EXACT + PHRASE only).
 */
import { useMemo } from 'react'
import { AdsDataGrid, type GridColumn } from '../../../../../../campaigns/_grid/AdsDataGrid'
import type { AdGroupDetailPayload, NegativeKeywordRow } from '../../../../../_lib'
import { ebayStatusPill } from '../../../../../_lib/status'
import { StatusPill } from '../../../../../../_shared/StatusPill'

export function AgNegativeKeywordsTab({ data, onAdd }: { data: AdGroupDetailPayload; onAdd: () => void }) {
  const rows = data.negativeKeywords
  const columns: GridColumn<NegativeKeywordRow>[] = useMemo(() => [
    { key: 'match', label: 'Match', metric: false, sortValue: (r) => r.matchType, render: (r) => <span className="h10-pill arch">{r.matchType}</span> },
    { key: 'state', label: 'State', metric: false, sortValue: (r) => r.status, render: (r) => { const p = ebayStatusPill(r.status); return <StatusPill label={p.label} cls={p.cls} /> } },
  ], [])

  return (
    <AdsDataGrid<NegativeKeywordRow>
      rows={rows}
      rowId={(r) => r.id}
      noun="Negative Keyword"
      firstColLabel="Negative Keyword"
      renderFirst={(r) => <div className="nmw"><span className="t">{r.text}</span></div>}
      firstSortValue={(r) => r.text.toLowerCase()}
      columns={columns}
      toolbarRight={<button type="button" className="h10-am-btn primary" onClick={onAdd}>+ Negative keywords</button>}
      storageKey="er1-ebay-ag-negatives"
      emptyLabel="No negative keywords in this ad group (EXACT and PHRASE supported — broad is not)."
      searchable
      searchValue={(r) => r.text}
      selectable={false}
    />
  )
}
