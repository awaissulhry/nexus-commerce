'use client'

/**
 * FX.6 — one pending approval as a decision card, built to the
 * human-in-the-loop checklist: what happens, why you're being asked,
 * the evidence chain, the expected effect (labelled an estimate),
 * reversibility, and the cost of being wrong — decidable without
 * leaving the card. Buttons name their actual effect; a reject demands
 * the one-line reason that becomes precedent.
 *
 * NAF.AP.3 rebuilds three things that were wrong:
 *
 * 1. The vocabulary was inverted. It covered the three fleet tools, which
 *    have produced ZERO approvals, and fell through to "Unknown for this
 *    action type" for the four tools behind all 18 real ones — leaving the
 *    two most decision-relevant facts blank exactly where there is history.
 * 2. Every card looked the same. Review depth now scales with consequence:
 *    a reversible bid nudge is compact, an irreversible customer message is
 *    not. An identical card for both is what trains a rubber stamp.
 * 3. The "what happens" line read `preview.effect` and fell back to
 *    `JSON.stringify(args)`. Fleet tools emit `effect`; the legacy shape is
 *    `{ note, action, changes }`, so a pre-fleet approval would have shown
 *    the operator raw JSON. It never shows raw JSON now.
 */

import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { Term } from './glossary'
import type { StoryPlan } from './PlanStory'

interface Approval {
  id: string
  toolName: string
  charterKey: string | null
  riskTier: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  /** AP.6 — why a previously-approved action came back unrun. */
  reason?: string | null
  /** AP.8 — how this worker's proposals of this kind have fared with you. */
  trackRecord?: { approved: number; rejected: number; total: number } | null
}

export interface ToolCard {
  /** Follows "wants to …" */
  wants: string
  /** Follows "asked to …" in the history list. */
  shortAsk: string
  approveLabel: string
  reversible: string
  /** Drives review depth: an irreversible action is never compact. */
  undoable: 'yes' | 'partial' | 'no' | 'unknown'
  wrongCost: string
}

export const TOOL_CARDS: Record<string, ToolCard> = {
  /* ── the fleet's own propose-tools ─────────────────────────────────── */
  'create-negative-keyword': {
    wants: 'wants to add a negative keyword',
    shortAsk: 'stop ads showing for a search term',
    approveLabel: 'Add this negative keyword',
    reversible: 'Yes — a negative keyword can be removed at any time and ads resume.',
    undoable: 'yes',
    wrongCost:
      'If this is wrong, you stop showing ads on a search that was actually converting — sales from that search stop until you remove it.',
  },
  'graduate-keyword': {
    wants: 'wants to promote a search term to its own keyword',
    shortAsk: 'promote a search term to its own keyword',
    approveLabel: 'Create this keyword',
    reversible: 'Yes — the new keyword can be paused or archived at any time.',
    undoable: 'yes',
    wrongCost:
      'If this is wrong, you spend on a keyword that does not convert — bounded by its bid and visible within days.',
  },
  'set-target-bid': {
    wants: 'wants to change a bid',
    shortAsk: "change a keyword's bid",
    approveLabel: 'Set this bid',
    reversible: 'Yes — the previous bid is recorded and can be restored.',
    undoable: 'yes',
    wrongCost:
      'If this is wrong, you pay more per click (or lose visibility) on one keyword until the bid is corrected.',
  },

  /* ── the tools that have actually produced every approval so far ───── */
  'apply-content': {
    wants: "wants to change a listing's content",
    shortAsk: 'change listing content',
    approveLabel: 'Apply this content change',
    reversible: 'Yes — the previous content is stored and can be restored.',
    undoable: 'yes',
    wrongCost:
      'If this is wrong, the listing shows incorrect copy until you revert it, and Amazon may take time to re-index the correction.',
  },
  'set-price': {
    wants: 'wants to change a price',
    shortAsk: 'change a price',
    approveLabel: 'Set this price',
    reversible: 'Yes — the previous price is recorded and can be restored.',
    undoable: 'yes',
    wrongCost:
      'If this is wrong, you sell at the wrong price until it is corrected — and any orders placed in the meantime stand at that price.',
  },
  'publish-listing': {
    wants: 'wants to publish a listing',
    shortAsk: 'publish a listing',
    approveLabel: 'Publish this listing',
    reversible:
      'Partly — the listing can be taken down, but it may already have been indexed and seen by shoppers.',
    undoable: 'partial',
    wrongCost:
      'If this is wrong, an incomplete or incorrect listing is publicly visible until you pull it.',
  },
  'send-customer-message': {
    wants: 'wants to send a message to a customer',
    shortAsk: 'send a message to a customer',
    approveLabel: 'Send this message',
    reversible: 'No — a sent message cannot be recalled.',
    undoable: 'no',
    wrongCost:
      'If this is wrong, a real customer receives incorrect or unwanted contact, which can count against your Amazon account health.',
  },
}

const humanize = (s: string) => s.replace(/[_-]+/g, ' ').trim()

/**
 * The honest fallback. "Unknown for this action type" told the operator
 * nothing and read as reassurance; an unrecorded consequence is treated as
 * an irreversible one, which is the safe direction to be wrong in.
 */
export function toolCardFor(toolName: string): ToolCard {
  return (
    TOOL_CARDS[toolName] ?? {
      wants: `proposes to run ${humanize(toolName)}`,
      shortAsk: humanize(toolName),
      approveLabel: `Run ${humanize(toolName)}`,
      reversible:
        'Not recorded for this action — treat it as something that cannot be undone until someone confirms otherwise.',
      undoable: 'unknown',
      wrongCost:
        'Not recorded for this action. Because the consequence is unknown, read the details below before approving.',
    }
  )
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const UNDO_WORD: Record<ToolCard['undoable'], string> = {
  yes: 'can be undone',
  partial: 'only partly undoable',
  no: 'cannot be undone',
  unknown: 'undo unknown',
}

/**
 * What this action will do, in a sentence. Fleet tools give us `effect`;
 * the legacy shape gives `note` plus a `changes` map. Raw JSON is never a
 * headline — if we have nothing readable we say so and let the disclosure
 * carry the detail.
 */
function whatHappens(preview: Record<string, unknown> | null): string | null {
  if (!preview) return null
  const effect = preview.effect
  if (typeof effect === 'string' && effect.trim()) return effect
  const note = preview.note
  if (typeof note === 'string' && note.trim()) return note
  const changes = preview.changes
  if (changes && typeof changes === 'object') {
    const fields = Object.keys(changes as Record<string, unknown>)
    if (fields.length > 0) {
      return `Changes ${fields.length === 1 ? 'one field' : `${fields.length} fields`}: ${fields.join(', ')}.`
    }
  }
  return null
}

export function DecisionCard({
  approval,
  workerName,
  plans,
  busy,
  onDecide,
  onOpenPlan,
}: {
  approval: Approval
  workerName: string
  plans: StoryPlan[]
  busy: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const card = toolCardFor(approval.toolName)

  // AP.3 — review depth scales with consequence. High risk, or anything we
  // cannot promise is undoable, gets the full card open from the start.
  const heavy =
    approval.riskTier === 'high' || card.undoable === 'no' || card.undoable === 'unknown'
  const [showDetail, setShowDetail] = useState(heavy)

  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  // AP.8 — the Article 14 gate. For a high-risk or irreversible action,
  // approving takes a deliberate act, not a reflex. Everything is still
  // SHOWN (AP.3's promise); what changes is that the button waits for a
  // person to say they have read it. Applied here only — blanket friction
  // is what trains the click-through it exists to prevent.
  // The gate applies exactly where the card is already heavy. An
  // unrecorded consequence is described to the operator as "treat it as
  // something that cannot be undone" — gating it too is the only way the
  // words and the behaviour agree. In practice this is high risk and
  // irreversible actions only; every fleet tool is mapped, so it does not
  // become the blanket friction that breeds click-through.
  const needsAck = heavy
  const [acknowledged, setAcknowledged] = useState(false)
  const approveBlocked = needsAck && !acknowledged

  // Evidence chain: the plan that queued this approval, and its matching item.
  const plan = plans.find((p) => p.approvalIds?.includes(approval.id))
  const item = plan?.items.find(
    (i) => i.tool === approval.toolName && JSON.stringify(i.args) === JSON.stringify(approval.args),
  )
  const summary = whatHappens(approval.preview)

  return (
    <div className={`acr-fl-dcard ap-card r-${approval.riskTier}${heavy ? ' heavy' : ''}`}>
      <div className="acr-fl-dcard-head">
        <strong>{workerName}</strong> {card.wants}
        <span className="ap-chips">
          <Term k="risk-tier">
            <span className={`dt-risk r-${approval.riskTier}`}>{approval.riskTier} risk</span>
          </Term>
          <span className={`ap-undo u-${card.undoable}`}>{UNDO_WORD[card.undoable]}</span>
        </span>
        <span className="acr-fl-sub">{ago(approval.requestedAt)}</span>
      </div>

      <p className="acr-fl-dcard-what">
        {summary ?? 'This action did not describe itself — read the details below before deciding.'}
      </p>

      {/* AP.8 — automation bias is the named failure mode. A worker whose
          last suggestions of this exact kind you rejected deserves a slower
          read, so its record sits next to the ask rather than buried. */}
      {approval.trackRecord && approval.trackRecord.total > 0 ? (
        <p
          className={`ap-record${
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

      {/* AP.6 — this was approved once and refused at run time because the
          facts had moved. Handing it back silently would be the worst of
          both worlds, so the card says what happened. */}
      {approval.reason?.startsWith('not run —') ? (
        <p className="ap-cameback">
          <RotateCcw size={12} aria-hidden />
          <span>
            <strong>You approved this before, and it did not run.</strong>{' '}
            {approval.reason.replace(/^not run — /, '')} — it is back here so you can decide
            again with the facts as they are now.
          </span>
        </p>
      ) : null}

      {heavy ? (
        <p className="ap-heavy-note">
          <ShieldAlert size={12} aria-hidden />
          {card.undoable === 'no'
            ? 'This one cannot be taken back once it runs. Everything is shown in full below.'
            : approval.riskTier === 'high'
              ? 'High risk, so nothing is hidden — every fact is shown below.'
              : 'This action has no recorded consequence, so it is shown in full.'}
        </p>
      ) : null}

      {/* Low-risk reversible actions keep the facts one click away; heavy
          ones never hide them. */}
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
        <dl className="acr-fl-dcard-facts">
          <div>
            <dt>Why you&apos;re being asked</dt>
            <dd>
              This worker is at <Term k="propose">PROPOSE</Term> — nothing it suggests happens
              without your yes, and this card is the only gate left before Amazon.
            </dd>
          </div>
          {item?.expectedEffect ? (
            <div>
              <dt>Expected effect (the worker&apos;s estimate)</dt>
              <dd>
                {item.expectedEffect.metric} {item.expectedEffect.direction} ~
                {item.expectedEffect.magnitudePct}% over {item.expectedEffect.horizonDays} days
                {item.expectedEffect.basis ? ` — based on: ${item.expectedEffect.basis}` : ''}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Can it be undone?</dt>
            <dd>{card.reversible}</dd>
          </div>
          <div>
            <dt>If it turns out wrong</dt>
            <dd>{card.wrongCost}</dd>
          </div>
        </dl>
      ) : null}

      {plan ? (
        <button className="acr-fl-dcard-plan" onClick={() => onOpenPlan(plan.id)}>
          <FileText size={12} /> From the plan “{plan.headline}” — see the full story and the
          critic&apos;s review
        </button>
      ) : null}

      {needsAck ? (
        <label className="ap-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I have read what this does
            {card.undoable === 'no' ? ' — and that it cannot be undone' : ''}.
          </span>
        </label>
      ) : null}

      <div className="acr-fl-apactions">
        <button
          className="acr-btn go"
          disabled={busy || approveBlocked}
          title={
            approveBlocked
              ? 'Tick the box above first — this one is high risk or cannot be undone.'
              : undefined
          }
          onClick={() => onDecide(approval.id, 'approve')}
        >
          <Check size={13} /> {card.approveLabel}
        </button>
        {rejecting ? (
          <span className="acr-fl-rejectrow">
            <Input
              autoFocus
              fieldClassName="acr-fl-reasonfield"
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
      <p className="acr-fl-dcard-teach">
        Your decision — and especially a reject reason — becomes{' '}
        <Term k="exemplar">precedent</Term> the workers read on their next run. It is recorded
        against your name, and approving gives you an{' '}
        <Term k="undo-window">undo window</Term> before anything happens.
      </p>
    </div>
  )
}
