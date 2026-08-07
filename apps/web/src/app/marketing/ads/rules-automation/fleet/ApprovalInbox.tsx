'use client'

/**
 * NAF.AP.2 + AP.3 — the approval inbox.
 *
 * AP.2: three views instead of one. The panel used to query pending only, so
 * eighteen decisions with fifteen written reasons were invisible. Waiting is
 * fleet-only (a pre-fleet approval is not something this page can act on);
 * Decided and Expired include that history, labelled, because the decision
 * timeline already shows it and two panels must not disagree about the past.
 *
 * AP.3: review depth scales with consequence. A reversible bid nudge and an
 * irreversible customer message must not look identical — an identical card
 * for both is what trains an operator to rubber-stamp. Low-risk reversible
 * actions get a compact row; high-risk or irreversible ones get the full
 * card with every fact on show.
 */

import { useState } from 'react'
import { AlertTriangle, Check, Clock, Undo2, X } from 'lucide-react'
import { DecisionCard, TOOL_CARDS, toolCardFor } from './DecisionCard'
import { Term } from './glossary'
import type { StoryPlan } from './PlanStory'

export type InboxView = 'waiting' | 'decided' | 'expired'

export interface ApprovalRow {
  id: string
  toolName: string
  charterKey: string | null
  status: string
  riskTier: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
  expiresAt: string | null
  isFleet: boolean
}

export interface InboxCounts {
  waiting: number
  decided: number
  expired: number
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').trim()

/**
 * What was decided, said plainly — and impersonally. It used to read "You
 * said no" on rows whose decider is null, which claims a person the record
 * does not have. Who decided is the meta line's job, where it can say
 * "nobody recorded" honestly.
 */
function outcomeWords(status: string): { word: string; tone: 'ok' | 'bad' | 'neutral' } {
  if (status === 'rejected') return { word: 'Rejected', tone: 'neutral' }
  if (status === 'executed') return { word: 'Approved — and it ran', tone: 'ok' }
  if (status === 'approved') return { word: 'Approved', tone: 'ok' }
  if (status === 'executing') return { word: 'Approved, running now', tone: 'ok' }
  if (status === 'expired') return { word: 'Ran out of time', tone: 'bad' }
  return { word: humanize(status), tone: 'neutral' }
}

/* ── the tabs ──────────────────────────────────────────────────────────── */

function ViewTabs({
  view,
  counts,
  onChange,
}: {
  view: InboxView
  counts: InboxCounts
  onChange: (v: InboxView) => void
}) {
  const tabs: Array<{ key: InboxView; label: string; n: number; hint: string }> = [
    { key: 'waiting', label: 'Waiting for you', n: counts.waiting, hint: 'Nothing here has happened yet — each one needs your yes or no.' },
    { key: 'decided', label: 'Decided', n: counts.decided, hint: 'Everything you have already answered, and the reason you gave.' },
    { key: 'expired', label: 'Expired', n: counts.expired, hint: 'Requests that ran out of time before anyone answered them.' },
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

/* ── one already-decided row ───────────────────────────────────────────── */

function DecidedRow({ row, workerName }: { row: ApprovalRow; workerName: string }) {
  const card = toolCardFor(row.toolName)
  const out = outcomeWords(row.status)
  const when = row.decidedAt ?? row.requestedAt
  return (
    <li className="ap-decided">
      <span className={`ap-outcome o-${out.tone}`}>
        {out.tone === 'ok' ? <Check size={11} /> : out.tone === 'bad' ? <Clock size={11} /> : <X size={11} />}
        {out.word}
      </span>
      <span className="ap-decidedbody">
        <span className="ap-decidedwhat">
          {workerName} asked to {card.shortAsk}
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
          <span className={`dt-risk r-${row.riskTier}`}>{row.riskTier} risk</span>
          {!row.isFleet ? (
            <>
              <span className="dt-sep">·</span>
              <span className="ap-prefleet" title="From the earlier agent system, before the fleet existed. Kept so this panel and the decision timeline agree about the same history.">
                pre-fleet
              </span>
            </>
          ) : null}
        </span>
        {row.reason ? <span className="ap-reason">“{row.reason}”</span> : null}
      </span>
    </li>
  )
}

/* ── the panel ─────────────────────────────────────────────────────────── */

export function ApprovalInbox({
  view,
  counts,
  approvals,
  plans,
  nameByKey,
  busy,
  loading,
  onViewChange,
  onDecide,
  onRejectAll,
  onOpenPlan,
}: {
  view: InboxView
  counts: InboxCounts
  approvals: ApprovalRow[]
  plans: StoryPlan[]
  nameByKey: Map<string, string>
  busy: boolean
  loading: boolean
  onViewChange: (v: InboxView) => void
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onRejectAll: (charterKey: string, reason: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const [rejectAllFor, setRejectAllFor] = useState<string | null>(null)
  const [rejectAllReason, setRejectAllReason] = useState('')

  // Names, not keys — the group header used to print the raw charter key,
  // and literally the word "unknown" when a run could not be resolved.
  const nameOf = (key: string | null) =>
    key ? (nameByKey.get(key) ?? humanize(key)) : 'An agent we cannot identify'

  const grouped = new Map<string, ApprovalRow[]>()
  for (const a of approvals) {
    const k = a.charterKey ?? ''
    grouped.set(k, [...(grouped.get(k) ?? []), a])
  }

  return (
    <>
      <ViewTabs view={view} counts={counts} onChange={onViewChange} />

      {loading ? (
        <div aria-busy="true" aria-label="Loading approvals">
          {[70, 70].map((h, i) => (
            <div key={i} className="dt-skeleton" style={{ height: h, marginBottom: 6 }} />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <p className="acr-fl-empty">
          {view === 'waiting' ? (
            <>
              Nothing is waiting for you. <Term k="approval">Approvals</Term> appear here when a
              plan passes the <Term k="critic">critic</Term> — and every yes or no you give
              becomes <Term k="exemplar">precedent</Term> the workers read on their next run.
            </>
          ) : view === 'decided' ? (
            <>No decision has been taken yet.</>
          ) : (
            <>Nothing has expired. A request that goes unanswered too long ends up here.</>
          )}
        </p>
      ) : view === 'waiting' ? (
        [...grouped.entries()].map(([charterKey, rows]) => (
          <div key={charterKey} className="acr-fl-inboxgroup">
            <div className="acr-fl-inboxhead">
              <strong>{nameOf(charterKey || null)}</strong>
              <span className="acr-fl-sub">
                {rows.length} waiting
                {rows.some((r) => r.riskTier === 'high') ? ' · includes high risk' : ''}
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
                    Confirm — reject all {rows.length}
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
                  Reject all ({rows.length})
                </button>
              )}
            </div>
            {rows.map((a) => (
              <DecisionCard
                key={a.id}
                approval={a}
                workerName={nameOf(a.charterKey)}
                plans={plans}
                busy={busy}
                onDecide={onDecide}
                onOpenPlan={onOpenPlan}
              />
            ))}
          </div>
        ))
      ) : (
        <ul className="ap-decidedlist">
          {approvals.map((a) => (
            <DecidedRow key={a.id} row={a} workerName={nameOf(a.charterKey)} />
          ))}
        </ul>
      )}

      {view === 'decided' && counts.decided > 0 ? (
        <p className="acr-fl-sub ap-foot">
          <Undo2 size={11} aria-hidden /> A decision cannot be taken back once it has run — but
          every one is recorded here with its reason, and rows marked{' '}
          <span className="ap-prefleet">pre-fleet</span> came from the earlier agent system, before
          this fleet existed.
        </p>
      ) : null}
      {view === 'waiting' && approvals.some((a) => a.riskTier === 'high') ? (
        <p className="acr-fl-sub ap-foot">
          <AlertTriangle size={11} aria-hidden /> High-risk actions are shown in full, with their
          evidence, because they are the ones worth slowing down for.
        </p>
      ) : null}
    </>
  )
}

export { TOOL_CARDS }
