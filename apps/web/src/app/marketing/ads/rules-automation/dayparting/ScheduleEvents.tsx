'use client'

/**
 * G3 — authoring dated event overrides: Black Friday, Prime Day, a launch week.
 *
 * HOW THE EVENT'S PLAN IS AUTHORED, and why it is not a grid.
 * The 7×24 painter lives in RankPlanBody, which is off-limits, and duplicating it here would be a
 * second implementation of the most intricate control in the product. It also would not be the
 * right answer: an event plan is almost never hand-painted. In practice it is one of two things —
 *
 *   · "hold ONE rank for the whole event"  — the common case. Black Friday is not a shape, it is
 *     a decision to push everywhere for four days.
 *   · "use a saved template"               — for anything with real structure, authored once in
 *     the builder and reused, which is what templates already exist for.
 *
 * So the plan is chosen, not drawn. Both paths reuse primitives that already exist.
 *
 * enabled defaults to OFF and the UI says why: authoring an event weeks early is normal, arming it
 * weeks early is the mistake the feature exists to prevent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Trash2, Plus } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import type { TargetPalette } from './ScheduleVersions'
import { getBackendUrl } from '@/lib/backend-url'

type Phase = 'draft' | 'upcoming' | 'live' | 'past'
interface EventRow {
  id: string; name: string; startsAt: string; endsAt: string
  windows: unknown[]; defaultTargetKey: string | null; enabled: boolean; phase: Phase
}
interface Template { id: string; name: string; windows: unknown[]; defaultTargetKey: string | null }

const PHASE_TONE: Record<Phase, string> = { draft: 'arch', upcoming: 'ok', live: 'bad', past: 'arch' }
const PHASE_LABEL: Record<Phase, string> = { draft: 'Draft', upcoming: 'Upcoming', live: 'Live now', past: 'Ended' }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
// datetime-local wants a local-clock string with no zone; toISOString would shift it by the offset.
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ScheduleEvents({ groupId, palette, targetKeys }: {
  groupId: string
  palette: TargetPalette
  /** Selectable ranks for the "hold one rank" path. */
  targetKeys: string[]
}) {
  const [items, setItems] = useState<EventRow[] | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // form
  const [name, setName] = useState('')
  const [starts, setStarts] = useState(() => { const d = new Date(); d.setHours(d.getHours() + 24, 0, 0, 0); return toLocalInput(d) })
  const [ends, setEnds] = useState(() => { const d = new Date(); d.setHours(d.getHours() + 96, 0, 0, 0); return toLocalInput(d) })
  const [mode, setMode] = useState<'rank' | 'template'>('rank')
  const [rank, setRank] = useState('')
  const [templateId, setTemplateId] = useState('')

  const load = useCallback(() => {
    setItems(null)
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/events`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => setItems(Array.isArray(j?.items) ? j.items : [])).catch(() => setItems([]))
  }, [groupId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/rank-templates`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => setTemplates(Array.isArray(j?.items) ? j.items : [])).catch(() => {})
  }, [])

  const rankOptions = useMemo(() => targetKeys.map((k) => ({ value: k, label: palette.name(k) })), [targetKeys, palette])
  const tplOptions = useMemo(() => templates.map((t) => ({ value: t.id, label: t.name })), [templates])

  const create = async () => {
    if (busy) return
    setErr('')
    if (!name.trim()) { setErr('Give the event a name.'); return }
    if (mode === 'rank' && !rank) { setErr('Choose the rank to hold.'); return }
    if (mode === 'template' && !templateId) { setErr('Choose a template.'); return }
    const tpl = templates.find((t) => t.id === templateId)
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          startsAt: new Date(starts).toISOString(),
          endsAt: new Date(ends).toISOString(),
          // "Hold one rank" is a baseline with NO windows — every hour of the event resolves to it.
          windows: mode === 'template' ? (tpl?.windows ?? []) : [],
          defaultTargetKey: mode === 'template' ? (tpl?.defaultTargetKey ?? null) : rank,
          enabled: false, // always authored disarmed; arming is a separate, deliberate click
        }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok) { setErr(j?.error ?? 'Could not create the event.'); return }
      setAdding(false); setName(''); load()
    } catch { setErr('Request failed — please retry.') }
    finally { setBusy(false) }
  }

  const setEnabled = async (e: EventRow, enabled: boolean) => {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/events/${e.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      })
      if (!r.ok) { setErr('Could not change that event.'); return }
      load()
    } finally { setBusy(false) }
  }

  const remove = async (e: EventRow) => {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${groupId}/events/${e.id}`, { method: 'DELETE' })
      if (!r.ok) { setErr('Could not delete that event.'); return }
      load()
    } finally { setBusy(false) }
  }

  const describe = (e: EventRow) => {
    const wins = Array.isArray(e.windows) ? e.windows.filter((w) => !!(w as { targetKey?: string })?.targetKey).length : 0
    if (wins > 0) return `${wins} window${wins === 1 ? '' : 's'}${e.defaultTargetKey ? ` · baseline ${palette.name(e.defaultTargetKey)}` : ''}`
    return e.defaultTargetKey ? `holds ${palette.name(e.defaultTargetKey)} throughout` : 'no plan set'
  }

  return (
    <section id="rgd-events" className="h10-rb-sec">
      <h2><CalendarClock size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />Event overrides</h2>
      <p className="h10-rb-desc">
        Dates where this schedule should do something different — Black Friday, a launch week. While an
        event is live it replaces the weekly plan entirely, then hands back on its own. Nothing to revert.
      </p>

      <div className="h10-evt">
        {items === null ? <div className="h10-hist-msg">Loading…</div>
          : items.length === 0 ? <div className="h10-evt-empty">No event overrides. The weekly plan runs every week.</div>
          : items.map((e) => (
            <div className={`h10-evt-r ${e.phase}`} key={e.id}>
              <span className={`h10-pill ${PHASE_TONE[e.phase]}`}>{PHASE_LABEL[e.phase]}</span>
              <span className="body">
                <span className="nm">{e.name}</span>
                <span className="meta">{fmt(e.startsAt)} → {fmt(e.endsAt)} · {describe(e)}</span>
              </span>
              {/* A past event is history: arming it would do nothing, so the control is not offered. */}
              {e.phase !== 'past' && (
                <button type="button" className="h10-am-btn bulk" disabled={busy} onClick={() => void setEnabled(e, !e.enabled)}>
                  {e.enabled ? 'Disarm' : 'Arm'}
                </button>
              )}
              <button type="button" className="del" aria-label={`Delete ${e.name}`} disabled={busy} onClick={() => void remove(e)}><Trash2 size={13} /></button>
            </div>
          ))}
      </div>

      {!adding ? (
        <button type="button" className="h10-rp-link" onClick={() => setAdding(true)}><Plus size={12} /> Add an event</button>
      ) : (
        <div className="h10-evt-form">
          <label>Name<input className="h10-rb-input" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Black Friday" /></label>
          <label>Starts<input className="h10-rb-input" type="datetime-local" value={starts} onChange={(ev) => setStarts(ev.target.value)} /></label>
          <label>Ends<input className="h10-rb-input" type="datetime-local" value={ends} onChange={(ev) => setEnds(ev.target.value)} /></label>
          <div className="h10-evt-mode" role="tablist" aria-label="Event plan">
            <button type="button" role="tab" aria-selected={mode === 'rank'} className={mode === 'rank' ? 'on' : ''} onClick={() => setMode('rank')}>Hold one rank</button>
            <button type="button" role="tab" aria-selected={mode === 'template'} className={mode === 'template' ? 'on' : ''} onClick={() => setMode('template')}>Use a template</button>
          </div>
          {mode === 'rank'
            ? <label>Rank to hold<H10Select width={260} options={rankOptions} value={rank} onChange={setRank} ariaLabel="Rank to hold" /></label>
            : <label>Template<H10Select width={260} options={tplOptions.length ? tplOptions : [{ value: '', label: 'No templates saved yet' }]} value={templateId} onChange={setTemplateId} ariaLabel="Template" searchable /></label>}
          <p className="h10-evt-note">
            Created disarmed. Authoring an event ahead of time is the point; arming it ahead of time is
            what you want to avoid — arm it when you are ready.
          </p>
          {err && <div className="h10-ntm-err">{err}</div>}
          <div className="h10-evt-act">
            <button type="button" className="h10-rb-btn ghost" onClick={() => { setAdding(false); setErr('') }} disabled={busy}>Cancel</button>
            <button type="button" className="h10-am-btn primary" onClick={() => void create()} disabled={busy}>{busy ? 'Saving…' : 'Add event'}</button>
          </div>
        </div>
      )}
    </section>
  )
}
