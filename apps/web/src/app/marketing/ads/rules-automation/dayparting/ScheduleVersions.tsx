'use client'

/**
 * HX.8 — plan-edit history for a rank schedule.
 *
 * TWO DIFFERENT HISTORIES, and conflating them is the mistake this avoids:
 *   · ScheduleActivityDrawer (A4) — what the ENGINE did to Amazon: bid and placement moves, every
 *     15 minutes, thousands of rows.
 *   · this — what the OPERATOR did to the PLAN: which windows moved, when, and by whom. A handful
 *     of rows that explain why the engine's behaviour changed.
 * Merging them would bury three plan edits under a thousand automated bid changes.
 *
 * The diff ("which hours moved") is computed here rather than server-side, using the builder's own
 * `rank-grid-model` — the same pure module that paints the grid and draws the week strip. A second
 * implementation on the server would be free to drift from what the operator actually sees.
 *
 * Rendered in both places a schedule is looked at: the list's Activity drawer and the builder.
 */
import { useEffect, useMemo, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'
import { gridFromWindows, type RankWin } from '../_rank/rank-grid-model'
import { ChangeList } from './ScheduleActivity'
import { WeekShape } from './WeekShape'
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange } from '../_shared/adsBus'

interface Version {
  id: string; name: string; windows: unknown[]; defaultTargetKey: string | null
  campaignCount: number; enabled: boolean; changedBy: string | null; createdAt: string
}

export interface TargetPalette { color: (key: string) => string | null; name: (key: string) => string }

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// `changedBy` holds an actor string. A plan edit is normally a person; automation appears only if
// something machine-driven ever re-saves a group (the coverage panel's add-campaigns path does).
const actorLabel = (a: string | null) => {
  if (!a) return 'Unknown'
  if (a.startsWith('automation:')) return a.replace('automation:', '').replace(/-/g, ' ')
  return a.startsWith('user:') ? a.slice(5) : a
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * What changed between two versions, in words. Compares the compiled 7×24 grids cell by cell so a
 * window that was merely *reshaped* (18–22 → 17–23) reads as "4 hours changed" rather than as an
 * opaque "windows edited".
 */
function describeDiff(cur: Version, prev: Version | undefined, nameOf: (k: string) => string): string[] {
  const out: string[] = []
  if (!prev) return ['First saved version.']
  if (cur.name !== prev.name) out.push(`Renamed from "${prev.name}"`)
  if ((cur.defaultTargetKey ?? '') !== (prev.defaultTargetKey ?? '')) {
    out.push(`Baseline ${prev.defaultTargetKey ? nameOf(prev.defaultTargetKey) : 'none'} → ${cur.defaultTargetKey ? nameOf(cur.defaultTargetKey) : 'none'}`)
  }
  if (cur.campaignCount !== prev.campaignCount) {
    const d = cur.campaignCount - prev.campaignCount
    out.push(`${d > 0 ? `+${d}` : d} campaign${Math.abs(d) === 1 ? '' : 's'} (${prev.campaignCount} → ${cur.campaignCount})`)
  }
  if (cur.enabled !== prev.enabled) out.push(cur.enabled ? 'Armed' : 'Paused')

  const a = gridFromWindows(prev.windows as RankWin[])
  const b = gridFromWindows(cur.windows as RankWin[])
  const touchedDays = new Set<number>()
  let cells = 0
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if ((a[d]?.[h] ?? '') !== (b[d]?.[h] ?? '')) { cells++; touchedDays.add(d) }
    }
  }
  if (cells > 0) {
    const days = [...touchedDays].sort().map((d) => DOW[d]).join(', ')
    out.push(`${cells} hour${cells === 1 ? '' : 's'} changed on ${days}`)
  }
  // A save that changed nothing never creates a version (the server dedupes), so an empty diff here
  // means the change was in a field this view doesn't track — say so rather than showing a blank row.
  return out.length ? out : ['Saved with no change to windows, baseline or campaigns.']
}

export function ScheduleVersions({ groupId, palette, compact = false }: {
  groupId: string
  palette: TargetPalette
  /** compact = inside the builder, where vertical space is shared with the plan editor. */
  compact?: boolean
}) {
  const [items, setItems] = useState<Version[]>([])
  const [loading, setLoading] = useState(true)
  // HX.8b — restore. Confirmed rather than immediate: on an armed schedule the rank loop acts on
  // the restored plan within 15 minutes.
  const [confirming, setConfirming] = useState<Version | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/versions?limit=30`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setItems(Array.isArray(j?.items) ? j.items : []) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [groupId, reload])

  const restore = async (v: Version) => {
    if (busy) return
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/restore-version`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: v.id }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) { setMsg(j?.error ?? 'Restore failed — please retry.'); return }
      setMsg(j?.armed
        ? 'Restored. This schedule is armed, so the rank loop will act on the restored plan within 15 minutes.'
        : 'Restored. This schedule is paused, so nothing runs until you arm it.')
      setConfirming(null)
      setReload((n) => n + 1)
      // RT.1 — restoring a version rewrites the plan every campaign in it resolves against.
      emitAdsChange('ads.schedule.changed')
    } catch { setMsg('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  const rows = useMemo(
    () => items.map((v, i) => ({ v, diff: describeDiff(v, items[i + 1], palette.name) })),
    [items, palette],
  )

  if (loading) return <div className="h10-hist-msg">Loading history…</div>
  if (!items.length) {
    return (
      <div className="h10-hist-msg">
        No edits recorded yet. A version is saved each time this schedule&rsquo;s windows, baseline,
        name or campaigns change — history starts from the next save.
      </div>
    )
  }

  return (
    <div className={`h10-ver ${compact ? 'compact' : ''}`}>
      {msg && <div className="h10-ver-msg">{msg}</div>}
      {confirming && (
        <div className="h10-ntm-back" onClick={() => { if (!busy) setConfirming(null) }}>
          <div className="h10-ntm" role="dialog" aria-modal="true" aria-label="Restore plan" onClick={(e) => e.stopPropagation()}>
            <div className="h10-ntm-h"><b>Restore this plan</b></div>
            <div className="h10-ntm-sub">
              Replaces the current windows and baseline with the version saved{' '}
              <b>{new Date(confirming.createdAt).toLocaleString()}</b>. Campaigns, portfolio scope and
              armed/paused state are untouched, and the restore is itself recorded — so you can undo it.
              {' '}Bids already sent to Amazon are <b>not</b> reverted.
            </div>
            <div className="h10-ntm-f">
              <button type="button" className="cancel" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
              <span className="grow" />
              <button type="button" className="apply" onClick={() => void restore(confirming)} disabled={busy}>
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
      {rows.map(({ v, diff }, i) => (
        <div className={`h10-ver-r ${i === 0 ? 'current' : ''}`} key={v.id}>
          <div className="mark" aria-hidden="true"><span className="dot" />{i < rows.length - 1 && <span className="line" />}</div>
          <div className="body">
            <div className="hd">
              <b>{i === 0 ? 'Current' : ago(v.createdAt)}</b>
              <span className="by">{actorLabel(v.changedBy)}</span>
              <span className="at" title={new Date(v.createdAt).toLocaleString()}>{new Date(v.createdAt).toLocaleString()}</span>
            </div>
            <ul className="diff">{diff.map((d, k) => <li key={k}>{d}</li>)}</ul>
            {/* The current plan is already in effect, so only earlier versions can be restored. */}
            {i > 0 && (
              <button type="button" className="h10-ver-restore" onClick={() => setConfirming(v)} disabled={busy}>
                <RotateCcw size={12} /> Restore this plan
              </button>
            )}
            {/* The shape at that point in time — the fastest way to see an evening block move. */}
            <WeekShape
              windows={v.windows}
              baselineKey={v.defaultTargetKey ?? ''}
              colorOf={palette.color}
              nameOf={palette.name}
              baselineName={v.defaultTargetKey ? palette.name(v.defaultTargetKey) : 'Baseline'}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Section wrapper for the builder, where history sits alongside the plan rather than in a drawer.
 *
 * TWO TABS, and "Amazon changes" leads. When you are editing a schedule the question you actually
 * have is "what has this been doing on Amazon" — the bid and placement-percentage moves the engine
 * made — not "when did I last edit it". Plan edits are the supporting answer to that, so they sit
 * second. Same two components the list's drawer renders, so the surfaces cannot disagree.
 */
export function ScheduleVersionsSection({ groupId, palette }: { groupId: string; palette: TargetPalette }) {
  const [tab, setTab] = useState<'amazon' | 'plan'>('amazon')
  return (
    <section id="rgd-history" className="h10-rb-sec">
      <h2><History size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />History</h2>
      <p className="h10-rb-desc">What this schedule changed on Amazon, and how the plan itself has been edited.</p>
      <div className="h10-act-tabs inset" role="tablist" aria-label="History type">
        <button type="button" role="tab" aria-selected={tab === 'amazon'} className={tab === 'amazon' ? 'on' : ''} onClick={() => setTab('amazon')}>Amazon changes</button>
        <button type="button" role="tab" aria-selected={tab === 'plan'} className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>Plan edits</button>
      </div>
      <div className="h10-rb-hist">
        {tab === 'amazon'
          ? <ChangeList groupId={groupId} />
          : <ScheduleVersions groupId={groupId} palette={palette} compact />}
      </div>
    </section>
  )
}
