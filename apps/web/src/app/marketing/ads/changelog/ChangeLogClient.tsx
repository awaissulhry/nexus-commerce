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
import { RotateCcw, StickyNote } from 'lucide-react'
import { AdsPageHeader } from '../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
// One definition of "routine", shared with the chart annotations — the same split, for the same
// reason, so the two surfaces cannot disagree about what counts as noise.
import { isRoutine } from '../campaigns/ChangeAnnotations'
import { fmtChangeValue } from '../_shared/changeValue'
import { getBackendUrl } from '@/lib/backend-url'

interface Origin { kind: string; id: string | null; name: string }
interface Delivery { state: string; attempts: number; lastError: string | null }
interface UndoPreview {
  found: boolean; eligible: boolean; reason?: string
  actionType?: string; groupedWith?: number; at?: string
}
interface ChangeRow {
  id: string; at: string; actor: string | null; source: string
  origin: Origin
  entity: { type: string; id: string; name: string | null }
  field: string; oldValue: string | null; newValue: string | null; reason: string | null
  /** ADX G6 — the numbers behind the prose (AdvertisingActionLog.evidence). */
  evidence: Evidence | null
  delivery: Delivery | null; undoable: boolean
  /** ACR.4.3 — the operation-row id an undo needs. Present on field rows that could be paired
   *  with the record behind them; null when there is nothing to reverse. */
  undoActionLogId?: string | null
  undoBlockedReason?: string
}

/**
 * ADX G6 — why a change happened, not just what changed and who did it.
 * Every field optional: a write with nothing numeric to say still records a note,
 * and most writers do not emit this yet, so null is normal rather than an error.
 */
interface Evidence {
  targetKey?: string; metric?: string
  observed?: number | null; threshold?: number | null
  windowDays?: number | null; sampleSize?: number | null
  sampleUnit?: 'rows' | 'days' | 'impressions'
  note?: string
}

/**
 * Compact one-liner: "TOS IS 31 vs 45 · 3 days". Deliberately terse because it sits
 * inside a grid cell; the full object goes in the title attribute.
 */
function fmtEvidence(e: Evidence): string {
  const bits: string[] = []
  if (e.metric) bits.push(e.metric.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
  if (e.observed != null && e.threshold != null) bits.push(`${e.observed} vs ${e.threshold}`)
  else if (e.observed != null) bits.push(String(e.observed))
  if (e.sampleSize != null) bits.push(`${e.sampleSize} ${e.sampleUnit ?? 'rows'}`)
  else if (e.windowDays != null) bits.push(`${e.windowDays}d`)
  return bits.join(' · ')
}

/** Thin data should be visible on its face — some schedules hold 1-5 days where the account has 56. */
function isThin(e: Evidence): boolean {
  if (e.sampleUnit === 'days' && typeof e.sampleSize === 'number') return e.sampleSize < 7
  return e.sampleUnit === 'rows' && e.sampleSize === 0
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
const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f.replace(/_/g, ' ')
/**
 * FB.3e (2026-08-21) — the value formatter is the SHARED, field-aware one. The local copy printed
 * the raw stored string for every non-placement field, and bids are stored in CENTS — this page
 * showed the operator "35 → 2" for a €0.35 → €0.02 change, identically to the schedule drawer it
 * was copied from. One map now serves both: `_shared/changeValue.ts`.
 */
const val = fmtChangeValue

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

  /**
   * HX.11 — rollup by origin, above the flat feed.
   *
   * Google's change history offers "by user" and "by campaign" overviews rather than only a
   * chronological list, and the reason is that a flat feed answers "what happened" but never
   * "which of my automations is misbehaving". Sorted by FAILURES first, then volume: a schedule
   * with 14 failed writes matters more than one with 400 clean ones, and sorting by count alone
   * would bury it.
   */
  const [originFilter, setOriginFilter] = useState<string | null>(null)
  /**
   * Routine bid movement is hidden by DEFAULT.
   *
   * Measured over a week: 6,095 of 6,133 field changes were rank-schedule bid and placement moves,
   * against ~1,942 creates, negatives and operator actions in the same period. Unfiltered, the log
   * reads as a rank-schedule log and everything else is buried 3:1 — which is exactly what it
   * looked like in use.
   *
   * The continuous half is one click away, because "what did our bidding do this week" is a real
   * question; it is just not the one you open a change log to ask.
   */
  const [showRoutine, setShowRoutine] = useState(false)
  // HX.7 — undo. Confirmed rather than immediate, and previewed before the confirm, because the
  // answer is frequently "no, and here is why".
  const [undoing, setUndoing] = useState<{ row: ChangeRow; preview: UndoPreview | null } | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoMsg, setUndoMsg] = useState('')

  /**
   * ACR.6 (R6) — writing an operator note.
   *
   * `ChangeAnnotations.tsx` already PLOTS operator notes on the campaign performance chart, and
   * this log already renders them in the feed. Neither could create one: the only writer of
   * `POST /advertising/events/custom` was the legacy `/marketing/advertising/events` page that
   * Stage 6 retires, so the console read a kind of row it could not produce.
   *
   * It belongs here rather than on the chart because a note is a change-log entry — "we changed the
   * hero image", "supplier raised the price" — that explains a movement the machine did not cause.
   * That is the one class of event nothing else in this system can record.
   */
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [noteMsg, setNoteMsg] = useState('')

  const saveNote = useCallback(async () => {
    const note = noteText.trim()
    if (!note) return
    setNoteBusy(true); setNoteMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/events/custom`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setNoteMsg(j?.error ?? 'Could not save the note.'); return }
      setNoteOpen(false); setNoteText('')
      setNoteMsg('Note added to the log.')
      load()
    } catch (e) { setNoteMsg((e as Error).message || 'Could not save the note.') } finally { setNoteBusy(false) }
  }, [noteText, load])

  const openUndo = useCallback(async (r: ChangeRow) => {
    setUndoing({ row: r, preview: null }); setUndoMsg('')
    /**
     * ACR.4.3 — prefer the resolved handle over the id prefix.
     *
     * This used to read `r.id.startsWith('a:')` and refuse every field row with "there is no
     * snapshot to restore from". That was true of the ROW and false of the change: the feed
     * carried 80 bid rows marked undoable that all refused on click, because the snapshot lives
     * on the operation row the field row was never joined to. It is joined now.
     */
    const id = r.undoActionLogId ?? (r.id.startsWith('a:') ? r.id.slice(2) : null)
    if (!id) {
      setUndoing({ row: r, preview: { found: false, eligible: false, reason: r.undoBlockedReason ?? 'This change could not be matched to a reversible record, so there is no snapshot to restore from.' } })
      return
    }
    try {
      const j = await fetch(`${getBackendUrl()}/api/advertising/changes/${id}/undo-preview`, { cache: 'no-store' }).then((x) => x.json())
      setUndoing({ row: r, preview: j })
    } catch { setUndoing({ row: r, preview: { found: false, eligible: false, reason: 'Could not check whether this can be undone.' } }) }
  }, [])

  const doUndo = useCallback(async () => {
    if (!undoing || undoBusy) return
    const id = undoing.row.undoActionLogId ?? (undoing.row.id.startsWith('a:') ? undoing.row.id.slice(2) : null)
    if (!id) return
    setUndoBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${id}/undo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      const j = await r.json().catch(() => null)
      setUndoMsg(r.ok && j?.reversed
        ? `Undone — ${j.reversed} change${j.reversed === 1 ? '' : 's'} reversed. The reversal is queued through the normal write path and appears in this log as its own entry.`
        : (j?.reason ?? 'Could not undo that change.'))
      if (r.ok && j?.reversed) { setUndoing(null); load() }
    } catch { setUndoMsg('Request failed — please retry.') }
    finally { setUndoBusy(false) }
  }, [undoing, undoBusy, load])
  const fetched = useMemo(() => rows ?? [], [rows])
  const routineCount = useMemo(() => fetched.filter((r) => isRoutine(r.field)).length, [fetched])
  const allRows = useMemo(
    () => (showRoutine ? fetched : fetched.filter((r) => !isRoutine(r.field))),
    [fetched, showRoutine],
  )
  const summary = useMemo(() => {
    const m = new Map<string, { name: string; kind: string; count: number; failed: number }>()
    for (const r of allRows) {
      const e = m.get(r.origin.name) ?? { name: r.origin.name, kind: r.origin.kind, count: 0, failed: 0 }
      e.count++
      if (r.delivery?.state === 'FAILED') e.failed++
      m.set(r.origin.name, e)
    }
    return [...m.values()].sort((a, b) => b.failed - a.failed || b.count - a.count)
  }, [allRows])

  // Applied before the grid, so the grid's own column filters compose on top rather than fight it.
  const all = useMemo(
    () => (originFilter ? allRows.filter((r) => r.origin.name === originFilter) : allRows),
    [allRows, originFilter],
  )
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
          {/* ADX G6 — the evidence behind the change. `reason` is prose an engine wrote
              for a human; this is the numbers it wrote it from. */}
          {r.evidence && fmtEvidence(r.evidence) && (
            <em
              className={`h10-cl-ev${isThin(r.evidence) ? ' thin' : ''}`}
              title={isThin(r.evidence)
                ? `Thin data — this decision rests on very little.\n${JSON.stringify(r.evidence, null, 1)}`
                : JSON.stringify(r.evidence, null, 1)}
            >
              {fmtEvidence(r.evidence)}
            </em>
          )}
        </span>
      ),
    },
    {
      // Only operation rows carry a before/after snapshot, so only they can be reversed. Offering
      // the control on a value row that cannot use it would be a promise the page cannot keep.
      key: 'undo', label: '', metric: false, sortable: false,
      render: (r) => (
        r.id.startsWith('a:')
          ? <button type="button" className="h10-cl-undo" title="Undo this change" onClick={(e) => { e.stopPropagation(); void openUndo(r) }}><RotateCcw size={12} /></button>
          : null
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
        primaryAction={{ label: 'Add note', icon: <StickyNote size={15} />, onClick: () => { setNoteOpen(true); setNoteMsg('') } }}
      />

      {error && (
        <div className="h10-am-latest" role="alert">
          <b>Load failed:</b> {error} · <button className="h10-am-link" onClick={() => load()}>Retry</button>
        </div>
      )}

      {summary.length > 1 && (
        <div className="h10-cl-sum">
          <span className="lbl">By origin</span>
          {summary.slice(0, 10).map((o) => (
            <button
              type="button"
              key={o.name}
              className={`chip ${originFilter === o.name ? 'on' : ''} ${o.failed > 0 ? 'bad' : ''}`}
              onClick={() => setOriginFilter(originFilter === o.name ? null : o.name)}
              title={`${o.kind} · ${o.count} change${o.count === 1 ? '' : 's'}${o.failed > 0 ? `, ${o.failed} failed to reach Amazon` : ''}`}
            >
              <span className="n">{o.name}</span>
              <span className="c">{o.count}</span>
              {o.failed > 0 && <span className="f">{o.failed} failed</span>}
            </button>
          ))}
          {originFilter && <button type="button" className="clr" onClick={() => setOriginFilter(null)}>Clear</button>}
        </div>
      )}

      {noteMsg && !noteOpen && <div className="h10-am-latest">{noteMsg}</div>}
      {noteOpen && (
        <div className="h10-ntm-back" onClick={() => { if (!noteBusy) setNoteOpen(false) }}>
          <div className="h10-ntm" role="dialog" aria-modal="true" aria-label="Add a note" onClick={(e) => e.stopPropagation()}>
            <div className="h10-ntm-h"><b>Add a note to the log</b></div>
            <div className="h10-ntm-b">
              <p className="h10-cl-noteh">
                For the changes this system did not make — a price move, a new hero image, a stock-out, a
                competitor launch. Notes appear in this feed and as markers on the campaign performance
                chart, so a later &ldquo;why did that week look like that&rdquo; has an answer.
              </p>
              <textarea
                className="h10-cl-notei"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="e.g. Raised the IT price by €4 across the GALE family"
                aria-label="Note"
                rows={3}
                autoFocus
              />
              {noteMsg && <div className="h10-cl-notee">{noteMsg}</div>}
            </div>
            <div className="h10-ntm-f">
              <button type="button" className="cancel" disabled={noteBusy} onClick={() => setNoteOpen(false)}>Cancel</button>
              <span className="grow" />
              <button type="button" className="apply" disabled={noteBusy || !noteText.trim()} onClick={() => void saveNote()}>
                {noteBusy ? 'Saving…' : 'Add note'}
              </button>
            </div>
          </div>
        </div>
      )}

      {undoMsg && !undoing && <div className="h10-am-latest">{undoMsg}</div>}
      {undoing && (
        <div className="h10-ntm-back" onClick={() => { if (!undoBusy) { setUndoing(null); setUndoMsg('') } }}>
          <div className="h10-ntm" role="dialog" aria-modal="true" aria-label="Undo change" onClick={(e) => e.stopPropagation()}>
            <div className="h10-ntm-h"><b>Undo this change</b></div>
            <div className="h10-ntm-sub">
              {!undoing.preview ? 'Checking…'
                : !undoing.preview.eligible ? undoing.preview.reason
                : (
                  <>
                    Restores what <b>{fieldLabel(undoing.row.field)}</b> was before this change, on{' '}
                    <b>{undoing.row.entity.name ?? undoing.row.entity.type.toLowerCase()}</b>.
                    {undoing.preview.groupedWith && undoing.preview.groupedWith > 1 && (
                      <> This was one of <b>{undoing.preview.groupedWith}</b> changes made by a single
                      operation, and all of them reverse together — undoing part of it would leave the
                      entity in a state that never existed.</>
                    )}
                    {' '}The reversal is pushed to Amazon through the normal write path, so it honours the
                    campaign&rsquo;s write-gate and is itself recorded here.
                  </>
                )}
            </div>
            {undoMsg && <div className="h10-ntm-b"><div className="h10-ntm-err">{undoMsg}</div></div>}
            <div className="h10-ntm-f">
              <button type="button" className="cancel" onClick={() => { setUndoing(null); setUndoMsg('') }} disabled={undoBusy}>Close</button>
              <span className="grow" />
              {undoing.preview?.eligible && (
                <button type="button" className="apply danger" onClick={() => void doUndo()} disabled={undoBusy}>{undoBusy ? 'Undoing…' : 'Undo'}</button>
              )}
            </div>
          </div>
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
            <label className="h10-cl-routine" title="Bids and placement percentages move every 15 minutes. Hidden by default so creates, negatives and operator edits are not buried under them.">
              <input type="checkbox" checked={showRoutine} onChange={(e) => setShowRoutine(e.target.checked)} />
              bid moves{routineCount > 0 ? ` (${routineCount})` : ''}
            </label>
            <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Time window" className="h10-cl-select">
              {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </span>
        )}
        reportLabel={all[0] ? `Newest change: ${new Date(all[0].at).toLocaleString('en-GB')}` : undefined}
        emptyLabel={showRoutine
          ? 'No changes recorded in this window.'
          : 'No changes in this window other than routine bid movement — tick "bid moves" to include it.'}
      />
    </div>
  )
}
