'use client'

/**
 * Rank Schedules list — the Dayparting Schedules tab's real content. A rank schedule is now ONE
 * NAMED GROUP (RankScheduleGroup, GET /advertising/rank-schedule-groups) that binds MANY campaigns;
 * the API materializes one AdSchedule row per member for the rank-defend cron to run (engine
 * untouched), but this list shows a single named row per group with a member count — so "test over
 * 12 campaigns" is one row, not twelve. Rendered on the shared AdsDataGrid (same grid/filters/
 * toolbar/customize/selection chrome as Apply Rules + Ads Manager): a truncating name + Manage link
 * (contained in the sticky first column), a Campaigns count, a colored Baseline chip matching the
 * builder's target palette, and persisted group-level enable/pause.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'
import { getBackendUrl } from '@/lib/backend-url'

interface SchedWindow { targetKey?: string }
interface RankRow { id: string; name: string; baseline: string; baselineKey: string; baselineColor: string | null; windows: number; campaigns: number; enabled: boolean; portfolioId: string | null; portfolioName: string | null }
type TargetMeta = { name: string; color: string | null }

// Fallbacks used until /rank-targets resolves (built-in keys + the builder palette colors).
const FALLBACK: Record<string, TargetMeta> = {
  'own-top': { name: 'Own Top of Search', color: '#0a7d48' },
  'defend-top': { name: 'Defend Top', color: '#3aa873' },
  'rest-of-search': { name: 'Rest of Search', color: '#e6b067' },
  'pause': { name: 'Min bid', color: '#d97757' },
  'own-top-allout': { name: 'Own Top — All-Out', color: '#b91c1c' },
}
const builderHref = (id?: string) => `/marketing/ads/rules-automation/builder/dayparting-schedule${id ? `?groupId=${id}` : ''}`

export function RankGoalsList() {
  const [rows, setRows] = useState<RankRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [gj, tj, pj] = await Promise.all([
          fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/rank-targets`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`${getBackendUrl()}/api/advertising/portfolios`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
        ])
        // real target name + color (falls back to built-in palette for any missing key)
        const tmeta: Record<string, TargetMeta> = { ...FALLBACK }
        const titems = (Array.isArray(tj?.items) ? tj.items : Array.isArray(tj) ? tj : []) as Array<{ key?: string; name?: string; color?: string | null }>
        for (const t of titems) if (t.key) tmeta[t.key] = { name: String(t.name ?? t.key), color: t.color ?? null }
        // portfolio id → name (the list returns { portfolios: [{ portfolioId, name }] })
        const pmeta: Record<string, string> = {}
        const praw = (pj?.portfolios ?? pj?.items ?? (Array.isArray(pj) ? pj : [])) as Array<{ portfolioId?: string | number; id?: string | number; name?: string }>
        for (const p of Array.isArray(praw) ? praw : []) { const pid = String(p.portfolioId ?? p.id ?? ''); if (pid) pmeta[pid] = String(p.name ?? pid) }
        const groups = (Array.isArray(gj?.items) ? gj.items : Array.isArray(gj) ? gj : []) as Array<Record<string, unknown>>
        const mapped = groups.map((g): RankRow => {
          const key = String(g.defaultTargetKey ?? '')
          const meta = tmeta[key]
          const wins = Array.isArray(g.windows) ? (g.windows as SchedWindow[]) : []
          const pid = g.portfolioId ? String(g.portfolioId) : null
          return {
            id: String(g.id),
            name: String(g.name ?? 'Rank schedule'),
            baseline: meta?.name ?? (key || '—'),
            baselineKey: key,
            baselineColor: meta?.color ?? null,
            windows: wins.filter((w) => !!w?.targetKey).length,
            campaigns: Number(g.campaignCount ?? 0),
            enabled: g.enabled !== false,
            portfolioId: pid,
            portfolioName: pid ? (pmeta[pid] ?? pid) : null,
          }
        })
        if (alive) setRows(mapped)
      } catch { if (alive) setRows([]) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  // Persisted group-level enable/pause (PATCH cascades to every member schedule). Optimistic; reverts
  // the affected row(s) if the PATCH fails.
  const setEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    const idset = new Set(ids)
    setRows((rs) => rs.map((r) => (idset.has(r.id) ? { ...r, enabled } : r)))
    const results = await Promise.all(ids.map((id) =>
      fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
        .then((r) => r.ok).catch(() => false)))
    const failed = new Set(ids.filter((_, i) => !results[i]))
    if (failed.size) setRows((rs) => rs.map((r) => (failed.has(r.id) ? { ...r, enabled: !enabled } : r)))
  }, [])

  const columns: GridColumn<RankRow>[] = useMemo(() => [
    {
      key: 'baseline', label: 'Baseline rank', metric: false, sortable: true, sortValue: (r) => r.baseline,
      render: (r) => (
        <span className="h10-rg-chip" style={r.baselineColor ? { borderColor: r.baselineColor } : undefined} title={r.baseline}>
          <span className="sw" style={{ background: r.baselineColor ?? '#99a1ac' }} />
          <span className="lbl">{r.baseline}</span>
        </span>
      ),
    },
    { key: 'campaigns', label: 'Campaigns', metric: true, sortable: true, sortValue: (r) => r.campaigns, render: (r) => <span>{r.campaigns}</span> },
    { key: 'windows', label: 'Windows', metric: true, sortable: true, sortValue: (r) => r.windows, render: (r) => <span>{r.windows}</span> },
    { key: 'status', label: 'Status', metric: false, sortable: true, sortValue: (r) => (r.enabled ? 0 : 1), render: (r) => <span className={`h10-pill ${r.enabled ? 'ok' : 'warn'}`}>{r.enabled ? 'Active' : 'Paused'}</span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const filters: GridFilter[] = useMemo(() => {
    const baselines = Array.from(new Set(rows.map((r) => r.baselineKey).filter(Boolean)))
    const nameOf = (k: string) => rows.find((r) => r.baselineKey === k)?.baseline ?? k
    return [
      { key: 'status', label: 'Status', kind: 'select', placeholder: 'Any status', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }], value: (r) => ((r as RankRow).enabled ? 'active' : 'paused') },
      { key: 'baseline', label: 'Baseline', kind: 'multiselect', placeholder: 'Any baseline', options: baselines.map((k) => ({ value: k, label: nameOf(k) })), value: (r) => (r as RankRow).baselineKey },
    ]
  }, [rows])

  // Mirrors Ads Manager's first-column: a max-width name wrapper so a long name truncates with an
  // ellipsis and the hover Manage button stays inside the column (not spilling into the next one).
  const renderFirst = (r: RankRow) => (
    <span className="rg-namecell">
      <span className="rg-namew">
        <a className="h10-nt-name rg-name" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={r.name}>{r.name}</a>
        <a className="h10-nt-open" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Manage</a>
      </span>
      {r.portfolioName && <span className="rg-pfbadge" title={`Portfolio schedule · ${r.portfolioName}`}>Portfolio · {r.portfolioName}</span>}
    </span>
  )

  return (
    <AdsDataGrid<RankRow>
      rows={rows}
      loading={loading}
      rowId={(r) => r.id}
      noun="Rank Schedule"
      firstColLabel="Rank Schedule"
      renderFirst={renderFirst}
      firstSortValue={(r) => r.name}
      columns={columns}
      filters={filters}
      filtersDefaultOpen={false}
      selectable
      selected={sel}
      onSelectedChange={setSel}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setEnabled(ids, true); clear() }}>Enable</button>
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setEnabled(ids, false); clear() }}>Pause</button>
        </span>
      )}
      customizable
      storageKey="rank-goals-grid"
      searchable
      searchPlaceholder="Search rank schedules…"
      searchValue={(r) => r.name}
      pagerCentered
      defaultSort={{ key: '__first', dir: 'asc' }}
      emptyLabel="No rank schedules yet."
      emptyNode={(
        <span className="h10-rr-empty">
          <NoDataIllus size={104} />
          <b>No rank schedules yet — create one named schedule to hold a rank across many campaigns.</b>
          <a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Create Rank Schedule</a>
        </span>
      )}
      toolbarRight={<a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Rank Schedule</a>}
    />
  )
}
