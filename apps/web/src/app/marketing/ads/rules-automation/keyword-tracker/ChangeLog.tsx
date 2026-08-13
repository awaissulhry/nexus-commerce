'use client'

/**
 * KT.7 — the scoped change log, in the drawer beside the campaigns it explains.
 *
 * **Scoped, not a feed.** Measured: `AD_BID_UPDATE` alone is ~925 rows in 24 hours and the no-pause
 * suppress/restore cycle accounts for most of it, so an unscoped "live change log" on this page would
 * be noise nobody reads. This shows changes to the keyword targets behind THIS term only — at which
 * point it becomes valuable, because it shows the engine touching a term you are watching.
 *
 * ── Actor is first-class, and it is not decoration ────────────────────────────────────────────
 *
 * At ~414 engine bid writes a day an unattributed row is unreadable. Every row therefore says who,
 * from the server's own `parseActor` — the same function the account-wide change feed uses, so this
 * page and that one cannot disagree about whether something was automation.
 *
 * 🔴 It renders the operator's identity rather than the word "you". The page has no reliable handle on
 * the session user here, and "you" on a row somebody else wrote would be a lie of exactly the kind
 * this section keeps deleting. The identity plus an `operator` chip is strictly more informative and
 * cannot be wrong.
 *
 * ── The undo affordance ──────────────────────────────────────────────────────────────────────
 *
 * Offered at the grain the server actually reverses at, with the window named, and **absent — not
 * greyed — once it has closed**, because a disabled button invites clicking and then explains nothing.
 * A grouped row states how many rows come with it BEFORE it is pressed: one apply is one change set,
 * and unpicking a quarter of it would leave the account in a state that never existed.
 *
 * Export reuses `/advertising/changes.csv`; no second exporter is added.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bot, Check, Info, Loader2, RotateCcw, User } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface ChangeItem {
  id: string
  undoActionLogId: string | null
  at: string
  actor: string | null
  source: 'operator' | 'automation' | 'system' | 'external'
  origin: { kind: string; id: string | null; name: string }
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  undo: { eligible: boolean; reason: string | null; groupedWith: number; changeSetId: string | null } | null
}

interface ChangesResponse {
  items: ChangeItem[]
  count: number
  targetsInScope: number
  windowDays?: number
  emptyReason: 'no_targets' | 'no_changes_in_window' | null
  emptyText: string | null
  csvHref?: string
}

const eur = (v: string | null) => {
  if (v == null) return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `€${(n / 100).toFixed(2)}` : v
}
const when = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)}`
}

/** The actor, in the two shapes that exist on this account and nothing invented in between. */
function actorLabel(it: ChangeItem): { icon: 'user' | 'bot'; who: string; chip: string } {
  if (it.source === 'automation') {
    return { icon: 'bot', who: it.origin.name || it.origin.kind, chip: 'automation' }
  }
  const raw = (it.actor ?? '').replace(/^user:/, '')
  return { icon: 'user', who: raw || 'an operator', chip: 'operator' }
}

export function ChangeLog({
  term, market, refreshKey = 0, onUndo,
}: {
  term: string
  market: string
  /**
   * 🔴 The refresh has to run BOTH ways. The undo button lives here and the blast-radius preview lives
   * in the sibling control, so after a successful undo that preview still said "1 target already bids
   * €0.55" while the bid was back at €0.50. Observed on production immediately after the first UI undo.
   */
  onUndo?: () => void
  /**
   * 🔴 Bumped by the drawer when a write lands. This component is a SIBLING of the control that
   * causes the changes, so it cannot observe an apply — found by clicking: the write succeeded, its
   * confirmation appeared, and the log directly beneath it still showed the previous two rows. "Cause
   * and effect are adjacent" is worth nothing if the effect needs a page reload.
   */
  refreshKey?: number
}) {
  const [data, setData] = useState<ChangesResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const q = new URLSearchParams({ market, term, days: '14' })
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-actions/changes?${q}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load the change log (${r.status})`)
      setData(await r.json())
    } catch (e) { setErr((e as Error).message) }
  }, [term, market])

  useEffect(() => { void load() }, [load, refreshKey])

  const undo = useCallback(async (it: ChangeItem) => {
    if (!it.undoActionLogId) return
    setBusy(it.id); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/keyword-actions/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionLogId: it.undoActionLogId }),
      })
      const b = await r.json().catch(() => ({}))
      if (r.ok) {
        setNote({ ok: true, text: `Reversed ${b.reversed} change${b.reversed === 1 ? '' : 's'}. The previous bid${b.reversed === 1 ? '' : 's'} ${b.reversed === 1 ? 'has' : 'have'} been pushed back to Amazon.` })
        onUndo?.()
      } else {
        setNote({ ok: false, text: String(b.error ?? `Could not undo (${r.status})`) })
      }
      void load()
    } catch (e) { setNote({ ok: false, text: (e as Error).message }) } finally { setBusy(null) }
  }, [load, onUndo])

  if (err) {
    return (
      <section className="h10-kt-drsec">
        <h3>What changed</h3>
        <p className="h10-kt6-blind"><AlertTriangle size={13} /><span>{err}</span></p>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="h10-kt-drsec">
        <h3>What changed</h3>
        <p className="h10-kt7-load"><Loader2 size={13} /> Loading…</p>
      </section>
    )
  }

  return (
    <section className="h10-kt-drsec">
      <h3>What changed</h3>

      {note && (
        <p className={note.ok ? 'h10-kt6-ok' : 'h10-kt6-blind'}>
          {note.ok ? <Check size={13} /> : <AlertTriangle size={13} />}<span>{note.text}</span>
        </p>
      )}

      {/* 🔴 "nothing has changed" and "there is nothing a log could be about" are different facts and
          the server distinguishes them, so this renders whichever sentence it sent. */}
      {data.items.length === 0 ? (
        <p className="h10-kt7-none">
          <Info size={13} />
          <span>{data.emptyText ?? 'No changes.'}</span>
        </p>
      ) : (
        <>
          <p className="h10-kt7-lead">
            {data.items.length} change{data.items.length === 1 ? '' : 's'} to the{' '}
            {data.targetsInScope === 1 ? 'one keyword target' : `${data.targetsInScope} keyword targets`} behind this
            term in the last {data.windowDays ?? 14} days, whoever made {data.items.length === 1 ? 'it' : 'them'}.
          </p>
          <ul className="h10-kt7-list">
            {data.items.map((it) => {
              const a = actorLabel(it)
              return (
                <li key={it.id}>
                  <span className="w">{when(it.at)}</span>
                  <span className={`who ${a.chip}`} title={it.actor ?? ''}>
                    {a.icon === 'bot' ? <Bot size={11} /> : <User size={11} />}
                    <b>{a.who}</b>
                    <i>{a.chip}</i>
                  </span>
                  <span className="f">{it.field}</span>
                  <span className="v">
                    {eur(it.oldValue)} <span className="ar">→</span> <b>{eur(it.newValue)}</b>
                  </span>
                  <span className="c" title={it.campaign?.name ?? it.entity.id}>{it.campaign?.name ?? ''}</span>
                  {/* absent, not greyed, once the window has closed — a disabled button invites a
                      click and then explains nothing */}
                  {it.undo?.eligible && it.undoActionLogId ? (
                    <button type="button" className="u" disabled={busy === it.id} onClick={() => void undo(it)}>
                      {busy === it.id ? <Loader2 size={11} /> : <RotateCcw size={11} />}
                      {it.undo.groupedWith > 1 ? `Undo all ${it.undo.groupedWith}` : 'Undo'}
                    </button>
                  ) : (
                    <span className="ux" title={it.undo?.reason ?? undefined}>{it.undo?.reason ? shortWhy(it.undo.reason) : '—'}</span>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="h10-kt7-foot">
            An undo reverses the whole change set it belongs to, for 24 hours after the change — one
            apply is one thing you did, so unpicking part of it would leave the account in a state that
            never existed.{' '}
            {data.csvHref && (
              <a href={`${getBackendUrl()}${data.csvHref}`} target="_blank" rel="noreferrer">Export the account-wide feed</a>
            )}
          </p>
        </>
      )}
    </section>
  )
}

/** The reason, shortened for a table cell; the full text stays in the title attribute. */
function shortWhy(reason: string): string {
  if (/already undone/i.test(reason)) return 'undone'
  if (/window/i.test(reason)) return 'window closed'
  if (/never landed/i.test(reason)) return 'never landed'
  if (/no undo is offered/i.test(reason)) return 'not here'
  return 'no undo'
}
