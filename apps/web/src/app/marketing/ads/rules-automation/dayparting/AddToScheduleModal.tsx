'use client'

/**
 * RDX/D2 — put the hours you just painted into a schedule that already exists.
 *
 * D1 gave the selection a template handoff. Applying a template REPLACES a plan wholesale
 * (`apply-template` sets `windows: tpl.windows`), which is right for "use this shape" and wrong
 * for "also push in these evening hours" — a 92-window schedule would be reduced to the three
 * hours just painted. This is the additive path, and it is deliberately a separate action rather
 * than an option on the template flow, because replace and add are not variations on one another.
 *
 * Nothing is written until the diff has been shown. The preview and the commit are the same
 * server call with `dryRun` flipped, so what is approved is exactly what lands.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { searchOptions } from '@/lib/option-search'
import type { RankWin } from './selectionToWindows'

export interface ScheduleChoice { value: string; label: string }

interface Diff {
  addedHours: number
  retargetedHours: number
  unchangedHours: number
  changed: Array<{ dow: number; hour: number; from: string | null; to: string | null }>
  byTarget: Array<{ key: string; gained: number; lost: number; net: number }>
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export function AddToScheduleModal({ schedules, windows, hours, targetName, targetsByKey, onClose, onApplied }: {
  schedules: ScheduleChoice[]
  /** the painted selection, already collapsed to minimal windows by selectionToWindows. Typed as
   *  RankWin rather than a narrower shape so there is one definition of a window on this page —
   *  the server rejects any entry without a targetKey regardless. */
  windows: RankWin[]
  hours: number
  targetName: string
  targetsByKey: Map<string, string>
  onClose: () => void
  onApplied: (scheduleName: string) => void
}) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<ScheduleChoice | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [groupEnabled, setGroupEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const esc = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }, [onClose, busy])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  // Same ranked matcher every other ads picker uses, so "gale it" finds "IT GALE JACKET" here too.
  const shown = useMemo(() => searchOptions(q, schedules, (s) => s.label).slice(0, 8), [schedules, q])

  const preview = async (choice: ScheduleChoice) => {
    setPicked(choice); setDiff(null); setErr(''); setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${choice.value}/merge-windows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windows, dryRun: true }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.diff) { setErr(j?.error ?? 'Could not preview that change.'); return }
      setDiff(j.diff as Diff)
      setGroupEnabled(!!j?.group?.enabled)
    } catch { setErr('Could not preview that change.') }
    finally { setBusy(false) }
  }

  const commit = async () => {
    if (!picked || !diff || busy) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${picked.value}/merge-windows`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windows }),
      })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.ok) { setErr(j?.error ?? 'Could not add those hours.'); return }
      onApplied(picked.label)
    } catch { setErr('Could not add those hours.') }
    finally { setBusy(false) }
  }

  const name = (k: string | null) => (k ? targetsByKey.get(k) ?? k : 'nothing')
  const nothingChanges = !!diff && diff.changed.length === 0

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      /* `md` is 560px — the width `.h10-ntm.wide` actually rendered, two declarations deep. */
      size="md"
      title={`Add ${hours} hour${hours === 1 ? '' : 's'} to a schedule`}
      subtitle={<>
        These hours will hold <b>{targetName}</b>. They are <b>added</b> to the schedule you pick —
        its existing windows are kept, and the painted hours win only where the two overlap.
      </>}
      footer={<>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        {picked && diff && !nothingChanges && (
          <Button variant="primary" size="sm" onClick={() => void commit()} disabled={busy}>
            {busy ? 'Adding…' : `Add to ${picked.label}`}
          </Button>
        )}
      </>}
    >
      {!picked ? (
        <>
          <Input
            fieldClassName="h10-ntm-field" autoFocus
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search schedules…" aria-label="Search schedules"
          />
          <div className="h10-d2-list">
            {shown.length === 0
              ? <div className="h10-d2-empty">No schedule matches “{q}”.</div>
              : shown.map((s) => (
                <Button variant="quiet" size="sm" block key={s.value} className="h10-d2-opt" onClick={() => void preview(s)}>{s.label}</Button>
              ))}
          </div>
        </>
      ) : (
        <div className="h10-d2-diff">
          <div className="pick">
            <b>{picked.label}</b>
            <Button variant="link" inline className="chg" onClick={() => { setPicked(null); setDiff(null); setErr('') }}>Change</Button>
          </div>

          {busy && !diff && <div className="h10-d2-empty">Working out what would change…</div>}

          {diff && (nothingChanges ? (
            /* Worth saying plainly rather than showing an empty diff: the schedule already
               holds this target in every painted hour, so applying would be a no-op. */
            <div className="h10-d2-none">
              <b>Nothing would change.</b> This schedule already holds {targetName} in {hours === 1 ? 'that hour' : 'all of those hours'}.
            </div>
          ) : (
            <>
              <div className="sum">
                {diff.addedHours > 0 && <span><b>{diff.addedHours}</b> hour{diff.addedHours === 1 ? '' : 's'} newly governed</span>}
                {/* Retargeting is the one that can surprise — those hours already had a plan. */}
                {diff.retargetedHours > 0 && <span className="warn"><b>{diff.retargetedHours}</b> hour{diff.retargetedHours === 1 ? '' : 's'} change target</span>}
                <span className="muted">{diff.unchangedHours} of 168 untouched</span>
              </div>

              <div className="rows">
                {diff.changed.map((c) => (
                  <div className="r" key={`${c.dow}-${c.hour}`}>
                    <span className="t">{DAYS[c.dow]} {hh(c.hour)}</span>
                    <span className="f">{name(c.from)}</span>
                    <span className="a">→</span>
                    <span className="v">{name(c.to)}</span>
                  </div>
                ))}
              </div>

              {/* A paused schedule stays paused — merging cannot arm anything. Said here so
                  nobody expects the hours to start running. */}
              {!groupEnabled && (
                <div className="h10-d2-note">
                  <AlertTriangle size={13} />
                  <span>This schedule is <b>off</b>. Adding hours does not turn it on — nothing will reach Amazon until it is armed.</span>
                </div>
              )}
            </>
          ))}
        </div>
      )}
      {err && <div className="h10-ntm-err">{err}</div>}
    </Modal>
  )
}
