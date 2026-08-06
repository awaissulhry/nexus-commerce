'use client'

/**
 * FX.6 — one pending approval as a decision card, built to the
 * human-in-the-loop checklist: what happens, why you're being asked,
 * the evidence chain, the expected effect (labelled an estimate),
 * reversibility, and the cost of being wrong — decidable without
 * leaving the card. Buttons name their actual effect; a reject demands
 * the one-line reason that becomes precedent.
 */

import { useState } from 'react'
import { Check, FileText, X } from 'lucide-react'
import { Term } from './glossary'
import type { PlanLabels, StoryPlan } from './PlanStory'

interface Approval {
  id: string
  toolName: string
  charterKey: string | null
  args: Record<string, unknown>
  preview: { effect?: string } | null
  requestedAt: string
}

const TOOL_CARDS: Record<
  string,
  { wants: string; approveLabel: string; reversible: string; wrongCost: string }
> = {
  'create-negative-keyword': {
    wants: 'wants to add a negative keyword',
    approveLabel: 'Add this negative keyword',
    reversible: 'Yes — a negative keyword can be removed at any time and ads resume.',
    wrongCost:
      'If this is wrong, you stop showing ads on a search that was actually converting — sales from that search stop until you remove it.',
  },
  'graduate-keyword': {
    wants: 'wants to promote a search term to its own keyword',
    approveLabel: 'Create this keyword',
    reversible: 'Yes — the new keyword can be paused or archived at any time.',
    wrongCost:
      'If this is wrong, you spend on a keyword that does not convert — bounded by its bid and visible within days.',
  },
  'set-target-bid': {
    wants: 'wants to change a bid',
    approveLabel: 'Set this bid',
    reversible: 'Yes — the previous bid is recorded and can be restored.',
    wrongCost:
      'If this is wrong, you pay more per click (or lose visibility) on one keyword until the bid is corrected.',
  },
}

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
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
  labels: PlanLabels
  busy: boolean
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onOpenPlan: (planId: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const card = TOOL_CARDS[approval.toolName] ?? {
    wants: `proposes: ${approval.toolName}`,
    approveLabel: 'Approve this action',
    reversible: 'Unknown for this action type.',
    wrongCost: 'Unknown for this action type.',
  }

  // Evidence chain: the plan that queued this approval, and its matching item.
  const plan = plans.find((p) => p.approvalIds?.includes(approval.id))
  const item = plan?.items.find(
    (i) => i.tool === approval.toolName && JSON.stringify(i.args) === JSON.stringify(approval.args),
  )

  return (
    <div className="acr-fl-dcard">
      <div className="acr-fl-dcard-head">
        <strong>{workerName}</strong> {card.wants}
        <span className="acr-fl-sub">{ago(approval.requestedAt)}</span>
      </div>

      <p className="acr-fl-dcard-what">
        {approval.preview?.effect ?? JSON.stringify(approval.args)}
      </p>

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

      {plan ? (
        <button className="acr-fl-dcard-plan" onClick={() => onOpenPlan(plan.id)}>
          <FileText size={12} /> From the plan “{plan.headline}” — see the full story and the
          critic&apos;s review
        </button>
      ) : null}

      <div className="acr-fl-apactions">
        <button
          className="acr-btn go"
          disabled={busy}
          onClick={() => onDecide(approval.id, 'approve')}
        >
          <Check size={13} /> {card.approveLabel}
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
      <p className="acr-fl-dcard-teach">
        Your decision — and especially a reject reason — becomes{' '}
        <Term k="exemplar">precedent</Term> the workers read on their next run.
      </p>
    </div>
  )
}
