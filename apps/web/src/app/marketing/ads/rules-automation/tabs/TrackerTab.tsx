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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown, Minus, X } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { H10Select } from '../../campaigns/FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'

// Markets a keyword can be tracked in (the EU set Xavia sells in).
const TRACK_MARKETS = [['DE', 'Germany'], ['IT', 'Italy'], ['FR', 'France'], ['ES', 'Spain'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['SE', 'Sweden'], ['PL', 'Poland']].map(([v, n]) => ({ value: v, label: `${n} (${v})` }))

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
  // "Add Keywords to Track" dialog (tracker only) — registers keywords so they appear on the
  // report; ranks fill in as data is ingested (the chosen pluggable/manual source).
  const [addOpen, setAddOpen] = useState(false)
  const [addText, setAddText] = useState('')
  const [addMarket, setAddMarket] = useState('DE')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (signal?: { aborted: boolean }) => {
    setLoading(true)
    try {
      if (isSov) {
        const j = await fetch(`${getBackendUrl()}/api/advertising/share-of-voice?limit=300`).then((r) => r.json())
        const raw = (Array.isArray(j?.rows) ? j.rows : []) as Array<Record<string, unknown>>
        if (!signal?.aborted) setRows(raw.map((r, i) => ({
          id: `sov-${i}-${String(r.query ?? '')}`, keyword: String(r.query ?? ''),
          impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0),
          sovPct: r.sovPct != null ? Number(r.sovPct) : null, topSharePct: r.topCampaignSharePct != null ? Number(r.topCampaignSharePct) : null,
          campaignCount: r.campaignCount != null ? Number(r.campaignCount) : null,
          searchVolume: null, organicRank: null, sponsoredRank: null, rankDelta: 0,
        })).filter((r) => r.keyword))
      } else {
        const j = await fetch(`${getBackendUrl()}/api/advertising/keyword-ranks?limit=500`).then((r) => r.json())
        const raw = (Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>
        if (!signal?.aborted) setRows(raw.map((r) => ({
          id: String(r.id), keyword: String(r.keyword ?? ''),
          searchVolume: r.searchVolume != null ? Number(r.searchVolume) : null,
          organicRank: r.organicRank != null ? Number(r.organicRank) : null,
          sponsoredRank: r.sponsoredRank != null ? Number(r.sponsoredRank) : null,
          rankDelta: Number(r.rankDelta ?? 0),
          impressions: null, clicks: null, sovPct: null, topSharePct: null, campaignCount: null,
        })).filter((r) => r.keyword))
      }
    } catch { if (!signal?.aborted) setRows([]) }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [isSov])

  useEffect(() => {
    const signal = { aborted: false }
    void load(signal)
    return () => { signal.aborted = true }
  }, [load])

  const addKeywords = async () => {
    const kws = [...new Set(addText.split(/[\n,]/).map((t) => t.trim()).filter(Boolean))]
    if (!kws.length || adding) return
    setAdding(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/keyword-ranks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ranks: kws.map((keyword) => ({ keyword, marketplace: addMarket, source: 'manual' })) }),
      })
      setAddOpen(false); setAddText('')
      await load()
    } finally { setAdding(false) }
  }
  // Esc closes the Add-Keywords dialog
  useEffect(() => {
    if (!addOpen) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [addOpen])

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
    <>
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
        emptyLabel={isSov ? 'No Share-of-Voice data for this window yet.' : 'No rank data yet — add keywords to track (or ingest ranks via POST /advertising/keyword-ranks).'}
        toolbarRight={!isSov ? <button type="button" className="h10-am-btn primary" onClick={() => setAddOpen(true)}><Plus size={13} /> Add Keywords</button> : undefined}
        selectionActions={(ids, clear) => (
          <span className="h10-bulkrow"><button type="button" className="h10-am-btn bulk" onClick={() => removeSelected(ids, clear)}><Trash2 size={13} /> Remove</button></span>
        )}
      />
      {addOpen && (
        <div className="h10-rb-prevback" onClick={() => setAddOpen(false)}>
          <div className="h10-rb-tmpl-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add keywords to track">
            <div className="ph"><b>Add Keywords to Track</b><button type="button" onClick={() => setAddOpen(false)} aria-label="Close"><X size={18} /></button></div>
            <div className="tmbody">
              <label htmlFor="trk-add-mkt">Marketplace</label>
              <H10Select width={220} options={TRACK_MARKETS} value={addMarket} onChange={setAddMarket} ariaLabel="Marketplace" />
              <label htmlFor="trk-add-kw" style={{ marginTop: 12 }}>Keywords</label>
              <textarea id="trk-add-kw" className="h10-rb-ta" value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="Enter or paste keywords here (one per line or comma-separated)" aria-label="Keywords to track" autoFocus />
              <p className="tmhint">Registers these keywords for the {TRACK_MARKETS.find((m) => m.value === addMarket)?.label ?? addMarket} report. Ranks fill in as data is ingested.</p>
              <div className="tmfoot">
                <button type="button" className="h10-rb-btn ghost" onClick={() => setAddOpen(false)}>Cancel</button>
                <button type="button" className="h10-rb-create" disabled={!addText.trim() || adding} onClick={addKeywords}>{adding ? 'Adding…' : 'Add Keywords'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
