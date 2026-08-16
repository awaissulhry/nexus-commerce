'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the grid's selection actions (the three bid verbs) and their preview/refuse copy.
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Analytics or Bulk Operations — a bulk write surface.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S4 — editing: the selection bar's three verbs, and the guardrails they keep.
 *
 * This is the page's first write section, so `NO_WRITE_ACTIONS` is replaced here (the slot
 * contract's rule: an explicit object goes, it is not quietly dropped). Three verbs on the
 * TARGETS selection:
 *
 *   · Set bid — one absolute value for every writable selected row;
 *   · Boost % — relative, computed from each row's CURRENT bid (±);
 *   · Bid to win — N% of each row's own going CPC; a row with no CPC in the window is excluded
 *     and counted, because 82% of rows are unmeasured and a bid computed from nothing is not a
 *     bid (S0 §2.1 — unmeasured is normal, not an error).
 *
 * Guardrails, all decided BEFORE the request and all shown in the confirm step:
 *   · Floor-state rows (suppressed · at-floor · in the min-bid window) are ALWAYS excluded —
 *     `suppressedFromBidCents` is a state machine and a bulk write over it hands the no-pause
 *     engine an instruction; those rows are counted apart, never silently dropped.
 *   · Everything goes through `POST /advertising/ad-targets/bulk-bid` — the audited path: the
 *     write gate (bounds, ceilings, caps) decides per row, the CPC ceiling clamps, and every
 *     accepted write sits in the 5-minute grace hold the staged tray below can still discard.
 *   · The result is reported in the gate's words: staged / skipped / refused / clamped.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Pencil } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { hasBidState } from './bidState'
import { BID_STAGED_EVENT } from './BidStagedTray'
import type { BidTargetRow } from './types'
import { emitAdsChange } from '../_shared/adsBus'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

type Mode = 'set' | 'boost' | 'win'
const MODE_LABEL: Record<Mode, string> = { set: 'Set bid', boost: 'Boost %', win: 'Bid to win' }

/** The three floor states S4 refuses to write over. One predicate, used by plan AND copy. */
const isFloorState = (r: BidTargetRow) =>
  hasBidState(r, 'suppressed') || hasBidState(r, 'at-floor') || hasBidState(r, 'min-bid-window')

interface Plan {
  entries: Array<{ adTargetId: string; bidCents: number; label: string; fromCents: number }>
  floored: BidTargetRow[]
  noCpc: BidTargetRow[]
  unchanged: number
}

function buildPlan(rows: BidTargetRow[], mode: Mode, value: number): Plan {
  const entries: Plan['entries'] = []
  const floored: BidTargetRow[] = []
  const noCpc: BidTargetRow[] = []
  let unchanged = 0
  for (const r of rows) {
    if (isFloorState(r)) { floored.push(r); continue }
    let next: number
    if (mode === 'set') next = Math.round(value * 100)
    else if (mode === 'boost') next = Math.round(r.bidCents * (1 + value / 100))
    else {
      if (r.cpcCents == null) { noCpc.push(r); continue }
      next = Math.round(r.cpcCents * (value / 100))
    }
    next = Math.max(2, next)
    if (next === r.bidCents) { unchanged += 1; continue }
    entries.push({ adTargetId: r.id, bidCents: next, label: r.label, fromCents: r.bidCents })
  }
  return { entries, floored, noCpc, unchanged }
}

export function BidSelectionActions({ ids, clear, rows, reload }: {
  ids: string[]
  clear: () => void
  rows: BidTargetRow[]
  reload: () => void
}) {
  const [mode, setMode] = useState<Mode | null>(null)
  const selected = useMemo(() => {
    const want = new Set(ids)
    return rows.filter((r) => want.has(r.id))
  }, [ids, rows])

  return (
    <>
      <span className="h10-bd4-bar">
        {(['set', 'boost', 'win'] as Mode[]).map((m) => (
          <button key={m} type="button" className="h10-bd4-verb" onClick={() => setMode(m)}>
            <Pencil size={12} aria-hidden /> {MODE_LABEL[m]}
          </button>
        ))}
      </span>
      {mode != null && (
        <BidEditDialog
          mode={mode}
          rows={selected}
          onClose={() => setMode(null)}
          onDone={() => { setMode(null); clear(); reload() }}
        />
      )}
    </>
  )
}

function BidEditDialog({ mode, rows, onClose, onDone }: {
  mode: Mode
  rows: BidTargetRow[]
  onClose: () => void
  onDone: () => void
}) {
  const [value, setValue] = useState<string>(mode === 'set' ? '' : mode === 'boost' ? '10' : '110')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ applied: number; skipped: number; failed: number; clamps: number } | null>(null)

  const num = Number(value)
  const valid = Number.isFinite(num) && (mode === 'set' ? num >= 0.02 && num <= 20 : mode === 'boost' ? num >= -90 && num <= 400 : num >= 10 && num <= 300)
  const plan = useMemo(() => (valid ? buildPlan(rows, mode, num) : null), [rows, mode, num, valid])

  const submit = async () => {
    if (!plan || plan.entries.length === 0 || busy) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: plan.entries.map((e) => ({ adTargetId: e.adTargetId, bidCents: e.bidCents })),
          reason: note.trim() ? `BID.S4 ${MODE_LABEL[mode]} — ${note.trim()}` : `BID.S4 ${MODE_LABEL[mode]} from the Bid page`,
        }),
      })
      const j = await r.json()
      if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `(${r.status})`)
      setResult({ applied: j.applied ?? 0, skipped: j.skipped ?? 0, failed: j.failed ?? 0, clamps: Array.isArray(j.cpcClamps) ? j.cpcClamps.length : 0 })
      window.dispatchEvent(new Event(BID_STAGED_EVENT))
      // RT.1 — staged bid writes: the tray is same-tab, this reaches every other tab.
      emitAdsChange('ads.bid.changed')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h10-bd4-back" role="dialog" aria-modal="true" aria-label={MODE_LABEL[mode]} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="h10-bd4-card">
        <h3>{MODE_LABEL[mode]} — {rows.length.toLocaleString('en-IE')} selected target{rows.length === 1 ? '' : 's'}</h3>

        {result != null ? (
          <>
            <p className="h10-bd4-ok" role="status">
              <Check size={13} aria-hidden /> {result.applied.toLocaleString('en-IE')} write{result.applied === 1 ? '' : 's'} staged — each sits in a 5-minute hold and can be discarded in the tray below.
              {result.skipped > 0 && <> {result.skipped} skipped (no change or refused by the gate).</>}
              {result.failed > 0 && <> <b>{result.failed} failed.</b></>}
              {result.clamps > 0 && <> {result.clamps} clamped to the CPC ceiling before staging.</>}
            </p>
            <div className="h10-bd4-row"><button type="button" className="h10-bd4-primary" onClick={onDone}>Done</button></div>
          </>
        ) : (
          <>
            <label className="h10-bd4-field">
              {mode === 'set' ? 'New bid (€)' : mode === 'boost' ? 'Change (%, negative lowers)' : '% of each row’s going CPC'}
              <input type="number" value={value} step={mode === 'set' ? '0.01' : '1'} onChange={(e) => setValue(e.target.value)} autoFocus />
            </label>
            {mode === 'win' && <p className="h10-bd4-sub">110% bids just above what a click has been costing on that keyword — its own trailing CPC, not an account average.</p>}
            <label className="h10-bd4-field">
              Note for the change log (optional)
              <input type="text" value={note} maxLength={140} placeholder="why this move" onChange={(e) => setNote(e.target.value)} />
            </label>

            {plan != null && (
              <p className="h10-bd4-plan">
                <b>{plan.entries.length.toLocaleString('en-IE')}</b> will be written
                {plan.floored.length > 0 && <> · <b>{plan.floored.length}</b> excluded — suppressed or floored by policy, and a bulk write over a suppression hands the engine an instruction</>}
                {plan.noCpc.length > 0 && <> · <b>{plan.noCpc.length}</b> excluded — no click in the window, so there is no going CPC to bid against</>}
                {plan.unchanged > 0 && <> · {plan.unchanged} already at that value</>}.
              </p>
            )}
            {plan != null && plan.entries.length > 0 && (
              <ul className="h10-bd4-sample">
                {plan.entries.slice(0, 4).map((e) => (
                  <li key={e.adTargetId}><span className="t">{e.label}</span> {eur(e.fromCents)} → <b>{eur(e.bidCents)}</b></li>
                ))}
                {plan.entries.length > 4 && <li className="more">…and {plan.entries.length - 4} more</li>}
              </ul>
            )}
            {err != null && <p className="h10-bd4-err" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}

            <div className="h10-bd4-row">
              <button type="button" className="h10-bd4-cancel" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="button" className="h10-bd4-primary" disabled={busy || !valid || !plan || plan.entries.length === 0} onClick={() => void submit()}>
                {busy ? 'Staging…' : `Stage ${plan?.entries.length ?? 0} write${(plan?.entries.length ?? 0) === 1 ? '' : 's'}`}
              </button>
            </div>
            <p className="h10-bd4-foot">Every write goes through the gate (bounds · ceilings · caps decide per row) and then a 5-minute cancellable hold. Nothing reaches Amazon from this dialog directly.</p>
          </>
        )}
      </div>
    </div>
  )
}
