'use client'

/**
 * NAF.AQ.3 — the decision card, rebuilt in this directory.
 *
 * The shipped `DecisionCard` (AP.3/AP.6/AP.8) got the hard parts right and is
 * the ancestor of this: risk-shaped depth, an honest fallback, the track
 * record, the read-and-understood gate. What it could not do, because a panel
 * had no room for it, is say **what the action touches and what it changes**.
 *
 * Four things are new here, each from the study's S6:
 *
 * 1. **Names, not ids.** `/agent/fleet/approvals` has always returned a
 *    `labels` map resolving campaign and target ids to names — and every
 *    client destructured it away, so no card has ever said WHICH campaign.
 * 2. **Before → after.** "bid €0.84" is unjudgeable; "€0.31 → €0.84 (+171%)"
 *    is. Every tool's preview already carries the starting value; nothing
 *    rendered it.
 * 3. **Reversibility as one class, stated once.** It used to be asserted in
 *    two places that could drift — a chip and a sentence. One source now.
 * 4. **The expiry clock**, which is stored on every row and was rendered
 *    nowhere, and an on-demand "is this still true?" that runs the same
 *    re-check the commit path runs.
 *
 * The tool VOCABULARY is still imported from the old card rather than copied.
 * Copying it would create two dictionaries that drift, which is the defect
 * AP.3 was written to fix. It moves here when the Overview stops rendering
 * the old card, and not before.
 */

import { useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  History,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

export interface FleetLabels {
  campaigns: Record<string, { name: string; marketplace: string | null }>
  targets: Record<
    string,
    { text: string; matchType: string; campaignName: string; marketplace: string | null }
  >
}

export interface CardApproval {
  id: string
  toolName: string
  charterKey: string | null
  riskTier: string
  status: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  reason?: string | null
  trackRecord?: { approved: number; rejected: number; total: number } | null
}

/* ── reversibility, as ONE class ───────────────────────────────────────── */

/**
 * Three classes, and the wording is deliberate. "Reversible" on its own is
 * how an operator ends up believing a spend can be un-spent.
 */
type Reversibility = 'restore' | 'compensate' | 'never'

const REVERSIBILITY: Record<Reversibility, { chip: string; sentence: string }> = {
  restore: {
    chip: 'can be put back',
    sentence: 'We can put this back the way it was — the previous value is recorded.',
  },
  compensate: {
    chip: 'only compensated for',
    sentence:
      'This cannot be undone, only compensated for. The change can be reversed going forward, but whatever it already did — money spent, a listing seen — has happened.',
  },
  never: {
    chip: 'cannot be undone',
    sentence: 'This cannot be taken back once it runs, by any means.',
  },
}

/** Derived from the one vocabulary, so a chip and a sentence cannot disagree. */
function reversibilityOf(toolName: string): Reversibility {
  const undoable = toolCardFor(toolName).undoable
  if (undoable === 'yes') return 'restore'
  if (undoable === 'partial') return 'compensate'
  // `no` and `unknown` both land here: an unrecorded consequence is treated
  // as irreversible, which is the safe direction to be wrong in.
  return 'never'
}

/* ── what it touches, and what it changes ──────────────────────────────── */

interface Delta {
  field: string
  from: string | null
  to: string
}

interface Described {
  /** The thing being acted on, named. Null when we genuinely cannot say. */
  entity: string | null
  marketplace: string | null
  deltas: Delta[]
  /** Named, decision-relevant signals — never a bare confidence score. */
  evidence: Array<{ label: string; value: string }>
}

const euro = (cents: unknown) =>
  typeof cents === 'number' ? `€${(cents / 100).toFixed(2)}` : null

const plain = (v: unknown): string => {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) return v.length === 0 ? '—' : `${v.length} items`
  return JSON.stringify(v)
}

/**
 * Pull the human facts out of a preview. Per-tool because the previews are
 * per-tool — a generic renderer here would produce exactly the JSON dump the
 * card exists to avoid.
 */
function describe(a: CardApproval, labels: FleetLabels): Described {
  const p = (a.preview ?? {}) as Record<string, any>
  const out: Described = { entity: null, marketplace: null, deltas: [], evidence: [] }

  // A `{field: {from, to}}` map — set-price and apply-content both use it.
  const changes = p.changes as Record<string, { from: unknown; to: unknown }> | undefined
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [field, ch] of Object.entries(changes)) {
      if (ch && typeof ch === 'object' && ('from' in ch || 'to' in ch)) {
        out.deltas.push({ field, from: plain(ch.from), to: plain(ch.to) })
      }
    }
  }

  switch (a.toolName) {
    case 'set-target-bid': {
      const t = p.target ?? {}
      const resolved = typeof a.args.targetId === 'string' ? labels.targets[a.args.targetId] : null
      out.entity = resolved
        ? `“${resolved.text}” (${resolved.matchType}) in ${resolved.campaignName}`
        : t.expression
          ? `“${t.expression}” (${t.matchType ?? '—'}) in ${p.campaign?.name ?? 'an unnamed campaign'}`
          : null
      out.marketplace = resolved?.marketplace ?? null
      if (typeof p.currentBidCents === 'number' && typeof p.proposedBidCents === 'number') {
        out.deltas.push({
          field: 'bid',
          from: euro(p.currentBidCents),
          to: euro(p.proposedBidCents) ?? '—',
        })
      }
      break
    }
    case 'create-negative-keyword': {
      const camp =
        (typeof a.args.externalCampaignId === 'string'
          ? labels.campaigns[a.args.externalCampaignId]
          : null) ?? null
      out.entity = `${camp?.name ?? p.campaign?.name ?? 'an unnamed campaign'}`
      out.marketplace = camp?.marketplace ?? p.campaign?.marketplace ?? null
      out.deltas.push({
        field: `negative keyword (${plain(p.matchType)}, ${plain(p.scope)})`,
        from: null,
        to: `“${plain(p.term)}”`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `spend on this term, last ${plain(p.metrics.windowDays)} days`,
          value: `${euro(p.metrics.costCents) ?? '—'} for ${plain(p.metrics.orders)} orders`,
        })
      }
      break
    }
    case 'graduate-keyword': {
      out.entity = plain(p.destination?.name) || null
      out.deltas.push({
        field: 'new exact keyword',
        from: null,
        to: `“${plain(p.query)}” at ${euro(p.suggestedBidCents) ?? '—'}`,
      })
      if (p.metrics) {
        out.evidence.push({
          label: `the term's own record, last ${plain(p.metrics.windowDays)} days`,
          value: `${plain(p.metrics.clicks)} clicks, ${plain(p.metrics.orders)} orders, ${euro(p.metrics.costCents) ?? '—'} spent`,
        })
      }
      break
    }
    case 'set-price': {
      out.entity = p.sku ? `SKU ${p.sku}` : null
      if (typeof p.deltaPct === 'number') {
        out.evidence.push({ label: 'change', value: `${p.deltaPct > 0 ? '+' : ''}${p.deltaPct}%` })
      }
      break
    }
    case 'publish-listing': {
      out.entity = p.title ? `${p.title} (${plain(p.channel)})` : plain(p.channel)
      out.deltas.push({
        field: 'published',
        from: p.currentlyPublished ? 'yes' : 'no',
        to: 'yes',
      })
      out.evidence.push({ label: 'publish mode for this channel', value: plain(p.publishMode) })
      break
    }
    case 'send-customer-message': {
      out.entity = p.to ? `${p.to} (${plain(p.marketplace)})` : null
      out.deltas.push({ field: 'message', from: null, to: plain(p.message) })
      out.evidence.push({
        label: 'has opted out of contact',
        value: p.suppressed ? 'YES — this will not be sent' : 'no',
      })
      break
    }
    default:
      break
  }
  return out
}

/* ── the clock ─────────────────────────────────────────────────────────── */

function timeLeft(iso: string | null): { text: string; urgent: boolean } | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { text: 'out of time', urgent: true }
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return { text: `${mins} min left`, urgent: true }
  const hrs = Math.round(mins / 60)
  return { text: `${hrs}h left`, urgent: hrs <= 2 }
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/* ── the card ──────────────────────────────────────────────────────────── */

export function ApprovalCard({
  approval,
  labels,
  workerName,
  busy,
  canExecute,
  onDecide,
  onRecheck,
}: {
  approval: CardApproval
  labels: FleetLabels
  workerName: string
  busy: boolean
  /** False for the fleet's preview-only tools — a yes changes nothing. */
  canExecute: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
}) {
  const vocab = toolCardFor(approval.toolName)
  const rev = reversibilityOf(approval.toolName)
  const d = describe(approval, labels)
  const left = timeLeft(approval.expiresAt)

  // Depth scales with CONSEQUENCE, not with riskTier alone. Every fleet tool
  // is riskTier 'high', so a tier-only rule made 100% of cards heavy and the
  // ack gate blanket friction — precisely what AP.8 said it was avoiding.
  const heavy = rev !== 'restore' || approval.riskTier === 'high'
  const [showDetail, setShowDetail] = useState(heavy)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [acked, setAcked] = useState(false)
  const [recheck, setRecheck] = useState<{ stale: boolean; why: string | null } | null>(null)
  const [rechecking, setRechecking] = useState(false)

  const needsAck = heavy && canExecute
  const approveBlocked = needsAck && !acked

  return (
    <div className={`aq-card r-${approval.riskTier}${heavy ? ' heavy' : ''}`}>
      <div className="aq-cardhead">
        <strong>{workerName}</strong> {vocab.wants}
        <span className="aq-chips">
          <Term k="risk-tier">
            <span className={`aq-risk r-${approval.riskTier}`}>{approval.riskTier} risk</span>
          </Term>
          <span className={`aq-rev v-${rev}`}>{REVERSIBILITY[rev].chip}</span>
          {left ? (
            <span className={`aq-clock${left.urgent ? ' urgent' : ''}`}>
              <Clock size={11} aria-hidden /> {left.text}
            </span>
          ) : null}
        </span>
        <span className="aq-age">{ago(approval.requestedAt)}</span>
      </div>

      {/* 1 — what it touches, by NAME */}
      {d.entity ? (
        <p className="aq-entity">
          On <strong>{d.entity}</strong>
          {d.marketplace ? ` · ${d.marketplace}` : ''}
        </p>
      ) : null}

      {/* 2 — before → after */}
      {d.deltas.length > 0 ? (
        <ul className="aq-deltas">
          {d.deltas.map((x, i) => (
            <li key={i}>
              <span className="aq-dfield">{x.field}</span>
              {x.from != null ? (
                <>
                  <span className="aq-dfrom">{x.from}</span>
                  <ArrowRight size={12} aria-hidden />
                </>
              ) : (
                <span className="aq-dnew">new</span>
              )}
              <span className="aq-dto">{x.to}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* the worker's own sentence, kept — it reads better than any template */}
      {typeof approval.preview?.effect === 'string' ? (
        <p className="aq-effect">{approval.preview.effect as string}</p>
      ) : d.deltas.length === 0 ? (
        <p className="aq-effect">
          This action did not describe itself — read the details below before deciding.
        </p>
      ) : null}

      {/* the honest ceiling: a yes here changes nothing on Amazon today */}
      {!canExecute ? (
        <p className="aq-noexec">
          <ShieldAlert size={12} aria-hidden />
          <span>
            Approving this records your decision and teaches the fleet, but{' '}
            <strong>changes nothing on Amazon</strong> — this action has no way to run yet.
          </span>
        </p>
      ) : null}

      {/* AP.8 — the automation-bias countermeasure, kept verbatim in spirit */}
      {approval.trackRecord && approval.trackRecord.total > 0 ? (
        <p
          className={`aq-record${
            approval.trackRecord.rejected > approval.trackRecord.approved ? ' doubted' : ''
          }`}
        >
          <History size={12} aria-hidden />
          You have answered {approval.trackRecord.total} of these from this worker before —{' '}
          {approval.trackRecord.approved} approved, {approval.trackRecord.rejected} rejected.
          {approval.trackRecord.rejected > approval.trackRecord.approved
            ? ' You have said no more often than yes.'
            : ''}
        </p>
      ) : null}

      {/* AP.6 — it was approved once and handed back */}
      {approval.reason?.startsWith('not run —') ? (
        <p className="aq-cameback">
          <RotateCcw size={12} aria-hidden />
          <span>
            <strong>You approved this before, and it did not run.</strong>{' '}
            {approval.reason.replace(/^not run — /, '')} — it is back here so you can decide again
            with the facts as they are now.
          </span>
        </p>
      ) : null}

      {!heavy ? (
        <button
          className="acr-fl-checkstoggle"
          aria-expanded={showDetail}
          onClick={() => setShowDetail(!showDetail)}
        >
          {showDetail ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showDetail ? 'Hide the details' : 'Show what this means, and what it costs to be wrong'}
        </button>
      ) : null}

      {showDetail ? (
        <dl className="aq-facts">
          {d.evidence.length > 0 ? (
            <div>
              <dt>What it is going on</dt>
              <dd>
                <ul className="aq-evidence">
                  {d.evidence.map((e, i) => (
                    <li key={i}>
                      <span>{e.label}</span>
                      <strong>{e.value}</strong>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Can it be undone?</dt>
            <dd>{REVERSIBILITY[rev].sentence}</dd>
          </div>
          <div>
            <dt>If it turns out wrong</dt>
            <dd>{vocab.wrongCost}</dd>
          </div>
          {approval.expiresAt ? (
            <div>
              <dt>If you do nothing</dt>
              <dd>
                It expires {new Date(approval.expiresAt).toLocaleString()} and is recorded as
                refused. Expiry never means approved.
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/* AQ.3 — ask, on demand, whether the facts still hold */}
      <div className="aq-recheck">
        <button
          className="acr-btn"
          disabled={busy || rechecking}
          onClick={async () => {
            setRechecking(true)
            try {
              setRecheck(await onRecheck(approval.id))
            } finally {
              setRechecking(false)
            }
          }}
        >
          <FileText size={12} /> {rechecking ? 'Checking…' : 'Check this is still true'}
        </button>
        {recheck ? (
          <span className={recheck.stale ? 'aq-rc-stale' : 'aq-rc-ok'}>
            {recheck.stale
              ? `The facts have moved — ${recheck.why ?? 'this no longer applies'}`
              : 'Still true as of just now.'}
          </span>
        ) : null}
      </div>

      {needsAck ? (
        <label className="aq-ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>
            I have read what this does
            {rev === 'never' ? ' — and that it cannot be undone' : ''}.
          </span>
        </label>
      ) : null}

      <div className="aq-actions">
        <button
          className="acr-btn go"
          disabled={busy || approveBlocked}
          title={approveBlocked ? 'Tick the box above first.' : undefined}
          onClick={() => onDecide(approval.id, 'approve')}
        >
          <Check size={13} /> {vocab.approveLabel}
        </button>
        {rejecting ? (
          <span className="acr-fl-rejectrow">
            <input
              autoFocus
              placeholder="one-line reason — this teaches the fleet"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              className="acr-btn"
              disabled={busy || !reason.trim()}
              onClick={() => onDecide(approval.id, 'reject', reason.trim())}
            >
              Confirm rejection
            </button>
            <button className="acr-btn" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="acr-btn" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> Reject, with a reason
          </button>
        )}
      </div>
    </div>
  )
}
