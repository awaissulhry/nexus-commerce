'use client'

/**
 * HX.5 — the account-wide Amazon Change Log.
 *
 * This route existed as a stub ("being rebuilt to match Adtomic") and is now filled. It is NOT a
 * new page and gets NO sidebar entry: the sidebar's changelog slot already points at the eBay log
 * and stays there. Entry is contextual — a quiet "View all changes →" from the places that show a
 * narrower slice of the same feed (the schedule Activity drawer, later the campaign History tab),
 * opening in a new tab so you never lose what you were reading.
 *
 * Chrome deliberately mirrors `ebay/change-log`: same AdsDataGrid, same "Change source" + "Change
 * type" filter idiom, same first column (when · target). Two channels, one way of reading a change.
 *
 * WHAT MAKES THIS ONE DIFFERENT FROM EVERY COMPETITOR'S CHANGE LOG
 * Google and Amazon log a change because they applied it — they ARE the platform. We push over an
 * API, so intent and outcome are different facts: a change can be recorded locally and never reach
 * Amazon. `Delivery` is therefore its own column, never folded into the change itself, and it is
 * filterable — "show me everything that failed to land" is the question this page exists for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'

interface Origin { kind: string; id: string | null; name: string }
interface Delivery { state: string; attempts: number; lastError: string | null }
interface ChangeRow {
  id: string; at: string; actor: string | null; source: string
  origin: Origin
  entity: { type: string; id: string; name: string | null }
  field: string; oldValue: string | null; newValue: string | null; reason: string | null
  delivery: Delivery | null; undoable: boolean
}

const SOURCE_LABELS: Record<string, { label: string; cls: string; tip: string }> = {
  automation: { label: 'Automation', cls: 'ok', tip: 'Made by a rank schedule, family plan, rule or standing job' },
  operator: { label: 'Operator', cls: 'arch', tip: 'Made by a person in the console' },
  system: { label: 'System', cls: 'arch', tip: 'No actor recorded' },
  external: { label: 'External', cls: 'warn', tip: 'Originated outside Nexus (e.g. Seller Central) and was accepted' },
}
const ORIGIN_LABELS: Record<string, string> = {
  schedule: 'Rank schedule', plan: 'Family plan', rule: 'Rule', job: 'Standing job', manual: 'Manual', unknown: '—',
}
// Delivery, not intent. APPLIED is the only state meaning Amazon took the change.
const DELIVERY_TONE: Record<string, string> = { APPLIED: 'ok', FAILED: 'bad', PENDING: 'warn', IN_FLIGHT: 'warn', CANCELLED: 'arch', SUPERSEDED: 'arch' }

const FIELD_LABEL: Record<string, string> = {
  PLACEMENT_TOP: 'Top-of-search bias', PLACEMENT_REST_OF_SEARCH: 'Rest-of-search bias', PLACEMENT_PRODUCT_PAGE: 'Product-page bias',
  bid: 'Bid', defaultBid: 'Ad-group bid', dailyBudget: 'Daily budget', status: 'Status',
}
const PCT = new Set(['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE'])
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ')
const val = (v: string | null, f: string) => (v == null ? '—' : PCT.has(f) ? `${v}%` : v)

const WINDOWS = [
  { value: '1', label: 'Last 24 hours' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
]

export function ChangeLogClient() {
  const [rows, setRows] = useState<ChangeRow[] | null>(null)
  const [days, setDays] = useState('7')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setRows(null); setError(null)
    const from = new Date(Date.now() - Number(days) * 24 * 3600 * 1000).toISOString()
    fetch(`${getBackendUrl()}/api/advertising/changes?from=${encodeURIComponent(from)}&limit=500`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((j) => setRows(Array.isArray(j?.items) ? j.items : []))
      .catch((e) => { setError((e as Error).message); setRows([]) })
  }, [days])
  useEffect(() => { load() }, [load])

  const all = useMemo(() => rows ?? [], [rows])
  const failed = useMemo(() => all.filter((r) => r.delivery?.state === 'FAILED').length, [all])

  const columns: GridColumn<ChangeRow>[] = useMemo(() => [
    {
      key: 'source', label: 'Source', metric: false, sortable: true, sortValue: (r) => r.source,
      tip: 'Who caused the change — derived from the recorded actor, never guessed.',
      render: (r) => { const s = SOURCE_LABELS[r.source] ?? SOURCE_LABELS.system; return <span className={`h10-pill ${s.cls}`} title={s.tip}>{s.label}</span> },
    },
    {
      // The differentiator: not "an automation did this" but WHICH one, by name.
      key: 'origin', label: 'Origin', metric: false, sortable: true, sortValue: (r) => r.origin.name,
      tip: 'The specific schedule, plan, rule or job behind the change.',
      render: (r) => (
        <span className="h10-cl-origin" title={`${ORIGIN_LABELS[r.origin.kind] ?? r.origin.kind} · ${r.origin.name}`}>
          <span className="k">{ORIGIN_LABELS[r.origin.kind] ?? r.origin.kind}</span>
          <span className="n">{r.origin.name}</span>
        </span>
      ),
    },
    { key: 'field', label: 'What', metric: false, sortable: true, sortValue: (r) => r.field, render: (r) => <span className="h10-pill arch">{fieldLabel(r.field)}</span> },
    {
      key: 'change', label: 'Change', metric: false, sortable: false,
      render: (r) => (
        <span className="h10-cl-change">
          <b>{val(r.oldValue, r.field)}</b> → <b>{val(r.newValue, r.field)}</b>
          {r.reason && <em title={r.reason}>{r.reason}</em>}
        </span>
      ),
    },
    {
      // Kept separate from the change itself. A change we asked for is not a change Amazon took,
      // and every other tool in this space conflates the two.
      key: 'delivery', label: 'Delivery', metric: false, sortable: true, sortValue: (r) => r.delivery?.state ?? 'zz',
      tip: 'Whether the change actually reached Amazon. Blank means no delivery record exists — never assume success.',
      render: (r) => (
        r.delivery
          ? (
            <span className={`h10-pill ${DELIVERY_TONE[r.delivery.state] ?? 'arch'}`} title={r.delivery.lastError ?? `${r.delivery.attempts} attempt${r.delivery.attempts === 1 ? '' : 's'}`}>
              {r.delivery.state.toLowerCase().replace('_', ' ')}{r.delivery.attempts > 1 ? ` ×${r.delivery.attempts}` : ''}
            </span>
          )
          : <span className="h10-cl-none" title="No delivery record for this change.">no record</span>
      ),
    },
  ], [])

  const filters: GridFilter[] = useMemo(() => [
    {
      key: 'source', label: 'Change source', kind: 'select', placeholder: 'All sources',
      options: Object.entries(SOURCE_LABELS).map(([v, s]) => ({ value: v, label: s.label })),
      value: (r) => (r as ChangeRow).source,
    },
    {
      key: 'origin', label: 'Origin', kind: 'multiselect', placeholder: 'All origins',
      options: [...new Set(all.map((r) => r.origin.name))].sort().map((n) => ({ value: n, label: n })),
      value: (r) => (r as ChangeRow).origin.name,
    },
    {
      key: 'field', label: 'Change type', kind: 'multiselect', placeholder: 'All types',
      options: [...new Set(all.map((r) => r.field))].sort().map((f) => ({ value: f, label: fieldLabel(f) })),
      value: (r) => (r as ChangeRow).field,
    },
    {
      key: 'delivery', label: 'Delivery', kind: 'select', placeholder: 'Any delivery',
      options: [{ value: 'APPLIED', label: 'Applied' }, { value: 'FAILED', label: 'Failed' }, { value: 'PENDING', label: 'Queued' }, { value: 'none', label: 'No record' }],
      value: (r) => (r as ChangeRow).delivery?.state ?? 'none',
    },
  ], [all])

  return (
    <div className="h10-am h10-cl">
      <AdsPageHeader
        title="Change Log"
        subtitle="Every change Nexus made to this Amazon account — what changed, what caused it, and whether it reached Amazon."
        markets={[]} market="all" onMarketChange={() => {}}
        showLearn={false} showDataSync={false} showDateRange={false}
      />

      {error && (
        <div className="h10-am-latest" role="alert">
          <b>Load failed:</b> {error} · <button className="h10-am-link" onClick={() => load()}>Retry</button>
        </div>
      )}

      <AdsDataGrid<ChangeRow>
        rows={all}
        loading={rows == null}
        rowId={(r) => r.id}
        noun="Change"
        selectable={false}
        firstColLabel="When · Target"
        renderFirst={(r) => (
          <div className="nmw">
            <span className="t">{new Date(r.at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="mk" title={r.entity.name ?? r.entity.id}>{r.entity.name ?? `${r.entity.type.toLowerCase()} ${r.entity.id.slice(0, 8)}`}</span>
          </div>
        )}
        firstSortValue={(r) => r.at}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search changes, origins, campaigns…"
        searchValue={(r) => `${r.field} ${r.origin.name} ${r.entity.name ?? ''} ${r.reason ?? ''}`}
        defaultSort={{ key: '__first', dir: 'desc' }}
        customizable
        storageKey="h10-amazon-changelog-cols"
        // HX.10 — exports the same WINDOW the page is showing, server-side. Deliberately not a dump
        // of the rendered rows: the page fetches a capped 500 for rendering, and an export that
        // stopped at the same cap would look complete and not be. Column filters are not applied —
        // filtering a spreadsheet is easy, discovering a silently truncated export is not.
        exportable
        onExport={() => {
          const from = new Date(Date.now() - Number(days) * 24 * 3600 * 1000).toISOString()
          window.location.href = `${getBackendUrl()}/api/advertising/changes.csv?from=${encodeURIComponent(from)}`
        }}
        // The window selector rides the toolbar rather than the header's date picker, which this
        // page hides — one control, in the place the grid's other controls already live.
        toolbarRight={(
          <span className="h10-cl-win">
            {failed > 0 && <span className="h10-cl-alert" title="Filter the Delivery column to Failed to see them">{failed} failed to reach Amazon</span>}
            <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Time window" className="h10-cl-select">
              {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </span>
        )}
        reportLabel={all[0] ? `Newest change: ${new Date(all[0].at).toLocaleString('en-GB')}` : undefined}
        emptyLabel="No changes recorded in this window — bid moves, placement changes, rule applies and operator edits all land here."
      />
    </div>
  )
}
