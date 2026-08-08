'use client'

/**
 * NAF.AQ.3 — the lists this page owns, so there is exactly ONE card design on
 * it.
 *
 * This replaces the shipped `<ApprovalInbox>` on `/fleet/approvals`. The
 * behaviours it carries are AP.1–AP.8's and are reproduced deliberately, not
 * reinvented: three views with counts, grouping by worker NAME, selection with
 * a server-written blast-radius sentence, reject-all-from-one-worker, the
 * parked row with its inline undo (never a toast — a toast dies on reload and
 * the row IS the undo), and the impersonal outcome words that do not credit a
 * decider the record does not have.
 *
 * The Overview still renders the original from its own directory, untouched.
 * That is the interim the locks file records; when the Overview moves, the old
 * component and its card retire together.
 */

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock, GraduationCap, Timer, Undo2, X } from 'lucide-react'
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { ApprovalCard, type CardApproval, type FleetLabels } from './ApprovalCard'

export type InboxView = 'waiting' | 'decided' | 'expired'

export interface InboxCounts {
  waiting: number
  decided: number
  expired: number
}

export interface ApprovalRow extends CardApproval {
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
  executeAfter: string | null
  isFleet: boolean
}

export interface PrecedentRow {
  charterKey: string
  label: string
  note: string | null
  toolName: string | null
  createdAt: string
}

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').trim()

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Impersonal on purpose — "You said no" on a row with no decider is a lie. */
function outcomeWords(status: string): { word: string; tone: 'ok' | 'bad' | 'neutral' } {
  if (status === 'rejected') return { word: 'Rejected', tone: 'neutral' }
  if (status === 'executed') return { word: 'Approved — and it ran', tone: 'ok' }
  if (status === 'approved') return { word: 'Approved', tone: 'ok' }
  if (status === 'executing') return { word: 'Approved, running now', tone: 'ok' }
  if (status === 'expired') return { word: 'Ran out of time', tone: 'bad' }
  // AQ.8 — an edited proposal. Named rather than left to the humanizer, which
  // rendered a bare "superseded": true, but it reads as something that happened
  // TO the operator rather than something they did. They did not say no; they
  // said not that number.
  if (status === 'superseded') return { word: 'You changed the number', tone: 'neutral' }
  return { word: humanize(status), tone: 'neutral' }
}

/* ── tabs ──────────────────────────────────────────────────────────────── */

export function ViewTabs({
  view,
  counts,
  onChange,
}: {
  view: InboxView
  counts: InboxCounts
  onChange: (v: InboxView) => void
}) {
  const tabs: Array<{ key: InboxView; label: string; n: number; hint: string }> = [
    {
      key: 'waiting',
      label: 'Waiting for you',
      n: counts.waiting,
      hint: 'Nothing here has happened yet — each one needs your yes or no.',
    },
    {
      key: 'decided',
      label: 'Decided',
      n: counts.decided,
      hint: 'Everything already answered, and the reason given.',
    },
    {
      key: 'expired',
      label: 'Expired',
      n: counts.expired,
      hint: 'Requests that ran out of time before anyone answered them.',
    },
  ]
  return (
    <div className="ap-tabs" role="tablist" aria-label="Approval views">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={view === t.key}
          className={view === t.key ? 'on' : ''}
          title={t.hint}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          <span className="ap-tabcount">{t.n}</span>
        </button>
      ))}
    </div>
  )
}

/* ── a parked approve, with its undo ───────────────────────────────────── */

export function ParkedRow({
  row,
  workerName,
  busy,
  onUndo,
  onCommit,
}: {
  row: ApprovalRow
  workerName: string
  busy: boolean
  onUndo: (id: string) => void
  onCommit: (id: string) => void
}) {
  const card = toolCardFor(row.toolName)
  const until = row.executeAfter ? new Date(row.executeAfter).getTime() : 0
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)))
  const fired = useRef(false)

  useEffect(() => {
    if (!until) return
    const t = setInterval(() => {
      const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setLeft(secs)
      if (secs === 0 && !fired.current) {
        fired.current = true
        onCommit(row.id)
      }
    }, 500)
    return () => clearInterval(t)
  }, [until, row.id, onCommit])

  return (
    <div className="ap-scheduled">
      <span className="ap-schedicon" aria-hidden>
        <Timer size={13} />
      </span>
      <span className="ap-schedbody">
        <span className="ap-schedwhat">
          Approved — {workerName} will {card.shortAsk}
        </span>
        <span className="ap-schedmeta">
          {left > 0 ? (
            <>
              Running in {left} second{left === 1 ? '' : 's'} — the{' '}
              <Term k="undo-window">undo window</Term>. Nothing has reached Amazon yet.
            </>
          ) : (
            'Running now…'
          )}
        </span>
      </span>
      {left > 0 ? (
        <button className="acr-btn" disabled={busy} onClick={() => onUndo(row.id)}>
          <Undo2 size={13} /> Undo
        </button>
      ) : null}
    </div>
  )
}

/* ── the record ────────────────────────────────────────────────────────── */

export function RecordList({ rows, nameOf }: { rows: ApprovalRow[]; nameOf: (k: string | null) => string }) {
  return (
    <ul className="ap-decidedlist">
      {rows.map((row) => {
        const card = toolCardFor(row.toolName)
        const out = outcomeWords(row.status)
        const when = row.decidedAt ?? row.requestedAt
        return (
          <li className="ap-decided" key={row.id}>
            <span className={`ap-outcome o-${out.tone}`}>
              {out.tone === 'ok' ? <Check size={11} /> : out.tone === 'bad' ? <Clock size={11} /> : <X size={11} />}
              {out.word}
            </span>
            <span className="ap-decidedbody">
              <span className="ap-decidedwhat">
                {nameOf(row.charterKey)} asked to {card.shortAsk}
              </span>
              <span className="ap-decidedmeta">
                {row.decidedBy ? (
                  <>by {row.decidedBy}</>
                ) : (
                  <span title="No decider was recorded. Decisions taken from now on carry a name.">
                    nobody recorded
                  </span>
                )}
                <span className="dt-sep">·</span>
                {ago(when)}
                <span className="dt-sep">·</span>
                <Term k="risk-tier">
                  <span className={`dt-risk r-${row.riskTier}`}>{row.riskTier} risk</span>
                </Term>
                {!row.isFleet ? (
                  <>
                    <span className="dt-sep">·</span>
                    <span
                      className="ap-prefleet"
                      title="From the earlier agent system, before the fleet existed."
                    >
                      pre-fleet
                    </span>
                  </>
                ) : null}
              </span>
              {row.reason ? <span className="ap-reason">“{row.reason}”</span> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/* ── precedent ─────────────────────────────────────────────────────────── */

export function PrecedentPanel({
  precedents,
  nameOf,
}: {
  precedents: PrecedentRow[]
  nameOf: (k: string | null) => string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ap-precedents">
      <button className="acr-fl-checkstoggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <GraduationCap size={13} aria-hidden />
        {precedents.length === 0
          ? 'Your decisions have not taught the fleet anything yet'
          : `What your decisions have taught the fleet (${precedents.length})`}
      </button>
      {open ? (
        precedents.length === 0 ? (
          <p className="acr-fl-empty">
            No <Term k="exemplar">precedent</Term> exists yet, because no fleet approval has been
            decided. The first yes or no you give here becomes the first one.
          </p>
        ) : (
          <ul className="ap-precedentlist">
            {precedents.map((p, i) => (
              <li key={i}>
                <span className={`ap-plabel l-${p.label}`}>{p.label}</span>
                <span className="ap-ptext">
                  <strong>{nameOf(p.charterKey)}</strong>
                  {p.toolName ? ` · ${humanize(p.toolName)}` : ''}
                  {p.note ? <span className="ap-reason">“{p.note}”</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}

/* ── the waiting queue ─────────────────────────────────────────────────── */

export function WaitingList({
  rows,
  labels,
  nameOf,
  busy,
  canExecute,
  onDecide,
  onRejectAll,
  onUndo,
  onCommit,
  onBulkPreview,
  onBulkDecide,
  onRecheck,
  onAmend,
}: {
  rows: ApprovalRow[]
  labels: FleetLabels
  nameOf: (k: string | null) => string
  busy: boolean
  canExecute: (toolName: string) => boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onRejectAll: (charterKey: string, reason: string) => void
  onUndo: (id: string) => void
  onCommit: (id: string) => void
  onBulkPreview: (ids: string[], decision: 'approve' | 'reject') => Promise<string>
  onBulkDecide: (ids: string[], decision: 'approve' | 'reject', reason?: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingBulk, setPendingBulk] = useState<{ decision: 'approve' | 'reject'; sentence: string } | null>(null)
  const [bulkReason, setBulkReason] = useState('')
  const [rejectAllFor, setRejectAllFor] = useState<string | null>(null)
  const [rejectAllReason, setRejectAllReason] = useState('')

  const clearSelection = () => {
    setSelected(new Set())
    setPendingBulk(null)
    setBulkReason('')
  }

  const grouped = new Map<string, ApprovalRow[]>()
  for (const a of rows) {
    const k = a.charterKey ?? ''
    grouped.set(k, [...(grouped.get(k) ?? []), a])
  }

  return (
    <>
      {selected.size > 0 ? (
        <div className="ap-bulkbar" role="region" aria-label="Bulk actions">
          {pendingBulk ? (
            <>
              <span className="ap-bulksentence">
                <AlertTriangle size={13} aria-hidden /> {pendingBulk.sentence}
              </span>
              {pendingBulk.decision === 'reject' ? (
                <input
                  autoFocus
                  placeholder="one-line reason (required)"
                  value={bulkReason}
                  onChange={(e) => setBulkReason(e.target.value)}
                />
              ) : null}
              {/* AQ.6 — when the server refuses a mixed batch, the sentence
                  IS the refusal, so there is nothing to confirm. Showing a
                  live "Yes, do it" over an explanation of why it cannot happen
                  is how an operator learns to distrust the confirmation. */}
              {!/Approve one kind at a time/.test(pendingBulk.sentence) ? (
                <button
                  className="acr-btn go"
                  disabled={busy || (pendingBulk.decision === 'reject' && !bulkReason.trim())}
                  onClick={() => {
                    onBulkDecide([...selected], pendingBulk.decision, bulkReason.trim() || undefined)
                    clearSelection()
                  }}
                >
                  Yes, do it
                </button>
              ) : null}
              <button className="acr-btn" disabled={busy} onClick={() => setPendingBulk(null)}>
                Back
              </button>
            </>
          ) : (
            <>
              <span className="ap-bulkcount">{selected.size} selected</span>
              <button
                className="acr-btn go"
                disabled={busy}
                onClick={async () =>
                  setPendingBulk({ decision: 'approve', sentence: await onBulkPreview([...selected], 'approve') })
                }
              >
                <Check size={13} /> Approve selected
              </button>
              <button
                className="acr-btn"
                disabled={busy}
                onClick={async () =>
                  setPendingBulk({ decision: 'reject', sentence: await onBulkPreview([...selected], 'reject') })
                }
              >
                <X size={13} /> Reject selected
              </button>
              <button className="acr-btn" onClick={clearSelection}>
                Clear
              </button>
            </>
          )}
        </div>
      ) : null}

      {[...grouped.entries()].map(([charterKey, group]) => (
        <div key={charterKey} className="acr-fl-inboxgroup">
          <div className="acr-fl-inboxhead">
            <strong>{nameOf(charterKey || null)}</strong>
            <span className="acr-fl-sub">
              {group.filter((r) => r.status === 'pending').length} waiting
              {group.some((r) => r.status === 'scheduled') ? ' · some already approved' : ''}
              {group.some((r) => r.riskTier === 'high') ? ' · includes high risk' : ''}
            </span>
            {rejectAllFor === charterKey ? (
              <span className="acr-fl-rejectrow">
                <input
                  autoFocus
                  placeholder="one-line reason (required)"
                  value={rejectAllReason}
                  onChange={(e) => setRejectAllReason(e.target.value)}
                />
                <button
                  className="acr-btn"
                  disabled={busy || !rejectAllReason.trim()}
                  onClick={() => {
                    onRejectAll(charterKey, rejectAllReason.trim())
                    setRejectAllFor(null)
                    setRejectAllReason('')
                  }}
                >
                  Confirm — reject all {group.filter((r) => r.status === 'pending').length}
                </button>
                <button className="acr-btn" disabled={busy} onClick={() => setRejectAllFor(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="acr-btn"
                disabled={busy}
                onClick={() => {
                  setRejectAllFor(charterKey)
                  setRejectAllReason('')
                }}
              >
                {/* Counts only what the server will actually touch — the shipped
                    button could promise "reject all 5" and reject 3. */}
                Reject all ({group.filter((r) => r.status === 'pending').length})
              </button>
            )}
          </div>

          {group.map((a) =>
            a.status === 'scheduled' ? (
              <ParkedRow
                key={a.id}
                row={a}
                workerName={nameOf(a.charterKey)}
                busy={busy}
                onUndo={onUndo}
                onCommit={onCommit}
              />
            ) : (
              <div key={a.id} className="ap-selectrow">
                <label className="ap-checkbox">
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(a.id)) next.delete(a.id)
                        else next.add(a.id)
                        return next
                      })
                    }
                    aria-label={`Select this request from ${nameOf(a.charterKey)}`}
                  />
                </label>
                <ApprovalCard
                  approval={a}
                  labels={labels}
                  workerName={nameOf(a.charterKey)}
                  busy={busy}
                  canExecute={canExecute(a.toolName)}
                  onDecide={onDecide}
                  onRecheck={onRecheck}
                  onAmend={onAmend}
                />
              </div>
            ),
          )}
        </div>
      ))}
    </>
  )
}
