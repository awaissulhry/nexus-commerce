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
  /** NAF.AQ — resolved through AgentRun so `?assignment=` can filter. */
  assignmentId?: string | null
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
                {/* S10.2 — text, not a badge.
                    This was a 10px dashed chip reading "pre-fleet", measured at
                    3.77:1 — the subtle marker the seed-data research warns
                    against, carrying the most important fact on the row. It is
                    now words at the same size as the rest of the line, and it
                    says what it means rather than abbreviating it. */}
                {!row.isFleet ? (
                  <>
                    <span className="dt-sep">·</span>
                    <span className="aq-prefleet">from before the fleet</span>
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
  onSnooze,
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
  onBulkPreview: (
    ids: string[],
    decision: 'approve' | 'reject',
  ) => Promise<{ sentence: string; count: number; blocked: boolean }>
  onBulkDecide: (ids: string[], decision: 'approve' | 'reject', reason?: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  onSnooze: (id: string, until: Date | null) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingBulk, setPendingBulk] = useState<{
    decision: 'approve' | 'reject'
    sentence: string
    /** The server's count of what is actually decidable, not `selected.size`. */
    count: number
    /** The server refused this batch; there is nothing to confirm. */
    blocked: boolean
  } | null>(null)
  const [typed, setTyped] = useState('')
  const [bulkReason, setBulkReason] = useState('')
  const [rejectAllFor, setRejectAllFor] = useState<string | null>(null)
  const [rejectAllReason, setRejectAllReason] = useState('')

  const clearSelection = () => {
    setSelected(new Set())
    setPendingBulk(null)
    setBulkReason('')
    /* S8.3 — a typed confirmation left in the box would carry over to the next
       batch, where it names the wrong count and would silently satisfy the
       gate. It has to die with the selection that justified it. */
    setTyped('')
  }

  const grouped = new Map<string, ApprovalRow[]>()
  for (const a of rows) {
    const k = a.charterKey ?? ''
    grouped.set(k, [...(grouped.get(k) ?? []), a])
  }

  /* Ashby's threshold: a plain acknowledgement up to two dozen, a typed one
     above it. 24 is their line and there is no better-evidenced number. */
  const BULK_TYPE_THRESHOLD = 24
  const needsTyping = !!pendingBulk && !pendingBulk.blocked && pendingBulk.count > BULK_TYPE_THRESHOLD
  const confirmPhrase = pendingBulk ? `${pendingBulk.decision} ${pendingBulk.count}` : ''

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
              {/* AQ.6 — when the server refuses a batch, the sentence IS the
                  refusal, so there is nothing to confirm. Showing a live
                  "Yes, do it" over an explanation of why it cannot happen is
                  how an operator learns to distrust the confirmation.

                  S8.3 — this tested `/Approve one kind at a time/` against the
                  server's prose. S8.1 added a SECOND refusal (two workers, one
                  kind) which that regex does not match, so the guard silently
                  stopped covering the case it was written for. It reads the
                  server's `blockedReason` flag now: a client that re-derives a
                  server decision by matching its wording is one copy edit away
                  from offering a button that cannot work. */}
              {!pendingBulk.blocked ? (
                <>
                  {/*
                   * S8.3 — friction that scales with N.
                   *
                   * The same verb is a light action on two rows and a heavy one
                   * on forty; until now both confirmed identically with one
                   * click. Ashby's pattern is the reference: a plain
                   * acknowledgement up to a couple of dozen records, and above
                   * that the operator types the action out. It defends against
                   * the specific failure this section owns — a hand already
                   * moving to "Yes, do it" because the last six batches were
                   * fine.
                   *
                   * The phrase names the SERVER's decidable count, not
                   * `selected.size`, so the operator cannot type one number
                   * while agreeing to another.
                   */}
                  {needsTyping ? (
                    <label className="aq-bulktype">
                      Type <code>{confirmPhrase}</code> to confirm:
                      <input
                        autoFocus
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        aria-label={`Type ${confirmPhrase} to confirm`}
                      />
                    </label>
                  ) : null}
                  <button
                    className="acr-btn go"
                    disabled={
                      busy ||
                      (pendingBulk.decision === 'reject' && !bulkReason.trim()) ||
                      (needsTyping && typed.trim().toLowerCase() !== confirmPhrase)
                    }
                    onClick={() => {
                      onBulkDecide([...selected], pendingBulk.decision, bulkReason.trim() || undefined)
                      clearSelection()
                    }}
                  >
                    {needsTyping
                      ? `Yes, ${pendingBulk.decision} ${pendingBulk.count}`
                      : 'Yes, do it'}
                  </button>
                </>
              ) : null}
              <button
                className="acr-btn"
                disabled={busy}
                onClick={() => {
                  setPendingBulk(null)
                  setTyped('')
                }}
              >
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
                  setPendingBulk({
                    decision: 'approve',
                    ...(await onBulkPreview([...selected], 'approve')),
                  })
                }
              >
                <Check size={13} /> Approve selected
              </button>
              <button
                className="acr-btn"
                disabled={busy}
                onClick={async () =>
                  setPendingBulk({
                    decision: 'reject',
                    ...(await onBulkPreview([...selected], 'reject')),
                  })
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
            {/*
             * S8.2 — select-all, scoped to THIS GROUP and saying its own number.
             *
             * Without it the section could not do the job it exists for:
             * clearing forty near-identical proposals meant forty clicks. With
             * it, the only honest scope is the group the operator can see —
             * there is deliberately no cross-group select-all and no second
             * step to extend one. A control that silently means "all 340
             * matching a filter you are not looking at" is the most dangerous
             * thing this page could ship, and the count is in the label so the
             * number is agreed before the click, not after.
             *
             * Parked rows are excluded because they cannot be decided — the
             * same rule `previewBulk` applies server-side, so select-all can
             * never produce the "3 others are not affected" clause by itself.
             */}
            {(() => {
              const selectable = group.filter((r) => r.status !== 'scheduled')
              if (selectable.length < 2) return null
              const allSelected = selectable.every((r) => selected.has(r.id))
              return (
                <button
                  type="button"
                  className="aq-selectall"
                  disabled={busy}
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      for (const r of selectable) {
                        if (allSelected) next.delete(r.id)
                        else next.add(r.id)
                      }
                      return next
                    })
                  }
                >
                  {allSelected
                    ? `Clear the ${selectable.length} selected here`
                    : `Select all ${selectable.length} in this group`}
                </button>
              )
            })()}
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
                  onSnooze={onSnooze}
                />
              </div>
            ),
          )}
        </div>
      ))}
    </>
  )
}
