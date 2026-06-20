'use client'

/**
 * TrackerTab — the two tracking *report* views (Share of Voice · Keyword Tracker), shown under the
 * "Report" segment of each tab. Both render numeric metric columns through the shared AdsDataGrid.
 *
 *   • Share of Voice  → GET /advertising/share-of-voice (real within-account impression share, AX2.6):
 *                       per query — Impressions · Clicks · Share of Voice% · Top-Campaign Share% · Campaigns.
 *   • Keyword Tracker → GET /advertising/keyword-ranks (SK3 rank backend): per tracked keyword —
 *                       Search Volume · Organic Rank · Sponsored Rank · Rank Δ. Empty until rank data is
 *                       ingested (Amazon's API doesn't expose organic rank — pluggable source).
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'

interface TrackRow {
  id: string; keyword: string
  // keyword-tracker fields
  searchVolume: number | null; organicRank: number | null; sponsoredRank: number | null; rankDelta: number
  // share-of-voice fields
  impressions: number | null; clicks: number | null; sovPct: number | null; topSharePct: number | null; campaignCount: number | null
}

const rank = (n: number | null) => (n == null ? '—' : `#${n}`)
const num = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'))
const pct = (f: number | null) => (f == null ? '—' : `${(f * 100).toFixed(1)}%`)

export function TrackerTab({ kind }: { kind: 'sov' | 'tracker' }) {
  const isSov = kind === 'sov'
  const [rows, setRows] = useState<TrackRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const noun = isSov ? 'Keyword' : 'Tracked Keyword'

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        if (isSov) {
          const j = await fetch(`${getBackendUrl()}/api/advertising/share-of-voice?limit=300`).then((r) => r.json())
          const raw = (Array.isArray(j?.rows) ? j.rows : []) as Array<Record<string, unknown>>
          if (alive) setRows(raw.map((r, i) => ({
            id: `sov-${i}-${String(r.query ?? '')}`, keyword: String(r.query ?? ''),
            impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
            sovPct: r.sovPct != null ? Number(r.sovPct) : null, topSharePct: r.topCampaignSharePct != null ? Number(r.topCampaignSharePct) : null,
            campaignCount: r.campaignCount != null ? Number(r.campaignCount) : null,
            searchVolume: null, organicRank: null, sponsoredRank: null, rankDelta: 0,
          })).filter((r) => r.keyword))
        } else {
          const j = await fetch(`${getBackendUrl()}/api/advertising/keyword-ranks?limit=500`).then((r) => r.json())
          const raw = (Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>
          if (alive) setRows(raw.map((r) => ({
            id: String(r.id), keyword: String(r.keyword ?? ''),
            searchVolume: r.searchVolume != null ? Number(r.searchVolume) : null,
            organicRank: r.organicRank != null ? Number(r.organicRank) : null,
            sponsoredRank: r.sponsoredRank != null ? Number(r.sponsoredRank) : null,
            rankDelta: Number(r.rankDelta ?? 0),
            impressions: null, clicks: null, sovPct: null, topSharePct: null, campaignCount: null,
          })).filter((r) => r.keyword))
        }
      } catch { if (alive) setRows([]) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [isSov])

  const columns: GridColumn<TrackRow>[] = useMemo(() => {
    if (isSov) {
      return [
        { key: 'impressions', label: 'Impressions', sortable: true, render: (r) => num(r.impressions), sortValue: (r) => r.impressions ?? 0 },
        { key: 'clicks', label: 'Clicks', sortable: true, render: (r) => num(r.clicks), sortValue: (r) => r.clicks ?? 0 },
        { key: 'sov', label: 'Share of Voice', sortable: true, render: (r) => <span className="h10-trk-sov">{pct(r.sovPct)}</span>, sortValue: (r) => r.sovPct ?? 0 },
        { key: 'topShare', label: 'Top Campaign Share', sortable: true, render: (r) => pct(r.topSharePct), sortValue: (r) => r.topSharePct ?? 0 },
        { key: 'campaignCount', label: 'Campaigns', sortable: true, render: (r) => num(r.campaignCount), sortValue: (r) => r.campaignCount ?? 0 },
      ]
    }
    return [
      { key: 'searchVolume', label: 'Search Volume', sortable: true, render: (r) => num(r.searchVolume), sortValue: (r) => r.searchVolume ?? 0 },
      { key: 'organicRank', label: 'Organic Rank', sortable: true, render: (r) => rank(r.organicRank), sortValue: (r) => r.organicRank ?? 9999 },
      { key: 'sponsoredRank', label: 'Sponsored Rank', sortable: true, render: (r) => rank(r.sponsoredRank), sortValue: (r) => r.sponsoredRank ?? 9999 },
      {
        key: 'rankDelta', label: 'Rank Δ', sortable: true, sortValue: (r) => r.rankDelta,
        render: (r) => {
          const d = r.rankDelta, cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat'
          return <span className={`h10-trk-delta ${cls}`}>{d > 0 ? <ArrowUp size={12} /> : d < 0 ? <ArrowDown size={12} /> : <Minus size={12} />}{Math.abs(d) || ''}</span>
        },
      },
    ]
  }, [isSov])

  const removeSelected = (ids: string[], clear: () => void) => { setRows((rs) => rs.filter((r) => !ids.includes(r.id))); clear() }

  return (
    <AdsDataGrid<TrackRow>
      rows={rows}
      loading={loading}
      rowId={(r) => r.id}
      noun={noun}
      firstColLabel="Keyword"
      renderFirst={(r) => <span className="h10-nt-name">{r.keyword}</span>}
      firstSortValue={(r) => r.keyword}
      columns={columns}
      selectable
      selected={sel}
      onSelectedChange={setSel}
      customizable={false}
      searchable
      searchPlaceholder="Search keywords…"
      searchValue={(r) => r.keyword}
      pagerCentered
      defaultSort={isSov ? { key: 'impressions', dir: 'desc' } : { key: 'searchVolume', dir: 'desc' }}
      emptyLabel={isSov ? 'No Share-of-Voice data for this window yet.' : 'No rank data yet — ingest keyword ranks (POST /advertising/keyword-ranks) to start tracking.'}
      toolbarRight={!isSov ? <button type="button" className="h10-am-btn primary"><Plus size={13} /> Add Keywords</button> : undefined}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow"><button type="button" className="h10-am-btn bulk" onClick={() => removeSelected(ids, clear)}><Trash2 size={13} /> Remove</button></span>
      )}
    />
  )
}
