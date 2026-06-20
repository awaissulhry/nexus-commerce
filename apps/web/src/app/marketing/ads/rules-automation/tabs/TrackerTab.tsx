'use client'

/**
 * TrackerTab — the two tracking sub-tabs (Share of Voice · Keyword Tracker). Unlike the rule
 * tabs these list tracked keywords with rank/visibility metrics (not automation rules), so they
 * render numeric metric columns through the shared AdsDataGrid with an "Add Keywords" action and
 * a "Remove" bulk action. Placeholder rows until a tracker endpoint exists (no recording yet).
 */
import { useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'

interface TrackRow { id: string; keyword: string; searchVolume: number; organicRank: number | null; sponsoredRank: number | null; sov: number; rankDelta: number }

const SOV_SEED: TrackRow[] = [
  { id: 'v1', keyword: 'motorcycle jacket', searchVolume: 40500, organicRank: 14, sponsoredRank: 3, sov: 28, rankDelta: 2 },
  { id: 'v2', keyword: 'leather biker gloves', searchVolume: 8100, organicRank: 7, sponsoredRank: 1, sov: 41, rankDelta: -1 },
  { id: 'v3', keyword: 'full face helmet', searchVolume: 27100, organicRank: 33, sponsoredRank: 8, sov: 12, rankDelta: 0 },
]
const TRK_SEED: TrackRow[] = [
  { id: 't1', keyword: 'motorcycle jacket', searchVolume: 40500, organicRank: 14, sponsoredRank: 3, sov: 28, rankDelta: 3 },
  { id: 't2', keyword: 'motorbike gloves', searchVolume: 6600, organicRank: 9, sponsoredRank: 2, sov: 35, rankDelta: -2 },
  { id: 't3', keyword: 'racing leathers', searchVolume: 3600, organicRank: 21, sponsoredRank: 5, sov: 18, rankDelta: 5 },
]

const rank = (n: number | null) => (n == null ? '—' : `#${n}`)
const num = (n: number) => n.toLocaleString('en-US')

export function TrackerTab({ kind }: { kind: 'sov' | 'tracker' }) {
  const isSov = kind === 'sov'
  const [rows, setRows] = useState<TrackRow[]>(isSov ? SOV_SEED : TRK_SEED)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const noun = isSov ? 'Keyword' : 'Tracked Keyword'

  const columns: GridColumn<TrackRow>[] = useMemo(() => {
    const base: GridColumn<TrackRow>[] = [
      { key: 'searchVolume', label: 'Search Volume', sortable: true, render: (r) => num(r.searchVolume), sortValue: (r) => r.searchVolume },
      { key: 'organicRank', label: 'Organic Rank', sortable: true, render: (r) => rank(r.organicRank), sortValue: (r) => r.organicRank ?? 9999 },
      { key: 'sponsoredRank', label: 'Sponsored Rank', sortable: true, render: (r) => rank(r.sponsoredRank), sortValue: (r) => r.sponsoredRank ?? 9999 },
    ]
    if (isSov) {
      base.push({ key: 'sov', label: 'Share of Voice', sortable: true, render: (r) => <span className="h10-trk-sov">{r.sov}%</span>, sortValue: (r) => r.sov })
    } else {
      base.push({
        key: 'rankDelta', label: 'Rank Δ', sortable: true, sortValue: (r) => r.rankDelta,
        render: (r) => {
          const d = r.rankDelta, cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat'
          return <span className={`h10-trk-delta ${cls}`}>{d > 0 ? <ArrowUp size={12} /> : d < 0 ? <ArrowDown size={12} /> : <Minus size={12} />}{Math.abs(d) || ''}</span>
        },
      })
    }
    return base
  }, [isSov])

  const removeSelected = (ids: string[], clear: () => void) => { setRows((rs) => rs.filter((r) => !ids.includes(r.id))); clear() }

  return (
    <AdsDataGrid<TrackRow>
      rows={rows}
      rowId={(r) => r.id}
      noun={noun}
      firstColLabel="Keyword"
      renderFirst={(r) => <a className="h10-nt-name" href="#" onClick={(e) => e.preventDefault()}>{r.keyword}</a>}
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
      defaultSort={{ key: 'searchVolume', dir: 'desc' }}
      emptyLabel="No keywords tracked yet."
      toolbarRight={<button type="button" className="h10-am-btn primary"><Plus size={13} /> Add Keywords</button>}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow"><button type="button" className="h10-am-btn bulk" onClick={() => removeSelected(ids, clear)}><Trash2 size={13} /> Remove</button></span>
      )}
    />
  )
}
