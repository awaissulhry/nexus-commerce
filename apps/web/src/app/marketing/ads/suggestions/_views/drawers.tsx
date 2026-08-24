'use client'

/**
 * SGX (2026-08-24) — split out of `SuggestionsClient.tsx`, which had grown to 2,447 lines holding
 * seven tabs. Moved VERBATIM: a relocation, not a rewrite, so `git log -L` over any symbol here
 * still reaches the SG commit that reasoned about it.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, X, ExternalLink, RotateCcw, Pause } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Tag } from '@/design-system/primitives/Tag'
import { Input } from '@/design-system/primitives/Input'
import { Drawer } from '@/design-system/components/Drawer'
import { eur } from '../cells'
import { ACTION_LABEL, ACTION_TONE, ENTITY_LABEL, ENTITY_TONE, ago, srcOf, type AiDecision, type Priced, type Suggestion } from '../_shared/types'
import { AI_MODULE_EXPLAINER, aiChangeText } from '../_shared/aiText'
import { FlowNode, baseEur, isEditable, prettyTrigger, projectAfter } from '../_shared/rowCells'

/** Detail drawer — provenance flow (Signal → Rule → Action → Target), edit-before-apply, decide. */
export function SuggestionDrawer({ suggestion, priced, busy, onClose, onAct, onPauseTarget }: {
  suggestion: Suggestion
  priced?: Priced
  busy: boolean
  onClose: () => void
  onAct: (id: string, kind: 'apply' | 'dismiss' | 'restore', overrideValue?: number) => Promise<void>
  /** SG.9 — the REAL pause (a live Amazon write), moved off the grid's ⏸ column and in here */
  onPauseTarget: (id: string) => Promise<void>
}) {
  const [armPause, setArmPause] = useState(false)
  useEffect(() => {
    if (!armPause) return
    const t = setTimeout(() => setArmPause(false), 4000)
    return () => clearTimeout(t)
  }, [armPause])
  const a = suggestion.proposedAction ?? {}
  const src = srcOf(suggestion)
  const st = suggestion.status
  const editable = isEditable(suggestion)
  const [edit, setEdit] = useState<string>(editable && a.value != null ? String(a.value) : '')
  const editNum = edit.trim() === '' ? null : Number(edit)
  const overridden = editable && editNum != null && Number.isFinite(editNum) && editNum !== a.value
  const projected = overridden && editNum != null ? projectAfter(suggestion, editNum) : null
  const base = baseEur(suggestion)
  const unit = a.op === 'incPct' || a.op === 'decPct' ? '%' : a.op === 'setValue' ? '€' : ''
  const kindLabel = ACTION_LABEL[a.type ?? ''] ?? a.type ?? '—'

  const doApply = () => { void onAct(suggestion.id, 'apply', overridden && editNum != null ? editNum : undefined).then(onClose) }
  const doDismiss = () => { void onAct(suggestion.id, 'dismiss').then(onClose) }
  const doRestore = () => { void onAct(suggestion.id, 'restore').then(onClose) }

  return (
    <Drawer
      open
      onClose={onClose}
      title={<span className="h10-sug-dh"><Tag tone={ENTITY_TONE[suggestion.entityType] ?? 'neutral'}>{ENTITY_LABEL[suggestion.entityType] ?? suggestion.entityType}</Tag> {src.label}</span>}
      footer={
        <div className="h10-sug-dfoot">
          {src.href && <Link href={src.href} className="open"><ExternalLink size={14} /> Open source</Link>}
          <span className="grow" />
          {st === 'pending' && (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={doDismiss}><X size={14} /> Dismiss</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={doApply}><Check size={14} /> {overridden ? 'Approve edit' : 'Approve'}</Button>
            </>
          )}
          {(st === 'dismissed' || st === 'expired') && <Button variant="primary" size="sm" disabled={busy} onClick={doRestore}><RotateCcw size={14} /> Restore</Button>}
        </div>
      }
    >
      <div className="h10-sug-dbody">
        {/* Provenance — why it surfaced, what it changes, where it lands */}
        <div className="h10-sug-flow">
          <FlowNode eyebrow="Signal" title={prettyTrigger(suggestion.trigger)} sub={suggestion.marketplace ? `Marketplace ${suggestion.marketplace}` : undefined} />
          <FlowNode eyebrow="Rule" title={suggestion.ruleName ?? 'Manual rule'} sub="Manual control · propose-only" />
          <FlowNode eyebrow="Proposed action" title={kindLabel} sub={a.type === 'harvest_and_negate' ? `promote ${a.wouldGraduate ?? 0} · negate ${a.wouldNegate ?? 0}` : a.wouldChange} tone={ACTION_TONE[a.type ?? '']} />
          <FlowNode eyebrow="Applies to" title={src.label} sub={ENTITY_LABEL[suggestion.entityType] ?? suggestion.entityType} href={src.href} last />
        </div>

        {/* ACR.4.4 — what this decision is worth, in the service's own terms. */}
        {priced && priced.spendAtStakeCents != null && (
          <div className={`h10-sug-stakebox${priced.recoverable ? ' waste' : ''}`}>
            <h4>
              {priced.recoverable ? <><span className="dia">♦</span> Pure waste</> : priced.direction === 'increase' ? 'Additional spend' : 'Spend at stake'}
              <b>{priced.direction === 'increase' ? '+' : ''}{eur(priced.spendAtStakeCents)}</b>
            </h4>
            <p>
              {priced.recoverable
                ? <>Trailing 30-day spend on this target that produced <b>no sales at all</b>. Redirecting it costs nothing you are currently earning.</>
                : priced.direction === 'increase'
                  ? <>Trailing 30-day spend this would add to. It is an investment, not a saving — the board counts it separately for that reason.</>
                  : <>Trailing 30-day spend this would <b>redirect</b>, not save. It produced {eur(priced.salesAtStakeCents ?? 0)} of sales, so cutting it trades revenue away with the spend.</>}
            </p>
          </div>
        )}

        {/* SG.3 — an applied row states its write's FATE, not just that it was approved */}
        {st === 'applied' && (
          <div className="h10-sug-dlblock">
            <h4>
              Delivery
              <span className={`h10-sug-dl ${{ delivered: 'ok', pending: 'pd', refused: 'rf', failed: 'fl', unknown: 'uk' }[suggestion.delivery?.state ?? 'unknown']}`}>
                {{ delivered: 'Delivered', pending: 'Pending', refused: 'Refused', failed: 'Failed', unknown: '—' }[suggestion.delivery?.state ?? 'unknown']}
              </span>
            </h4>
            <p>
              {suggestion.delivery?.detail
                ?? (suggestion.delivery?.state === 'delivered' ? 'The change reached Amazon.'
                  : suggestion.delivery?.state === 'pending' ? 'Queued — the drain worker has not settled this write yet.'
                  : 'This row predates delivery tracking — its fate was not recorded.')}
              {' '}The receipt lives in the <Link className="h10-sug-lnk" href="/marketing/ads/changelog">Change Log</Link>.
            </p>
          </div>
        )}

        {/* Edit-before-apply — adjust the magnitude; the rule's own min/max still clamp on the server */}
        {st === 'pending' && editable && (
          <div className="h10-sug-edit">
            <h4>Adjust before applying</h4>
            <label className="fld">
              <span>{a.op === 'decPct' ? 'Decrease by' : a.op === 'incPct' ? 'Increase by' : 'Set to'}</span>
              <Input inputMode="decimal" value={edit} onChange={(e) => setEdit(e.target.value)} suffix={unit === '%' ? '%' : undefined} prefix={unit === '€' ? '€' : undefined} aria-label="Override value" />
            </label>
            <p className="hint">
              {projected != null
                ? <>New result: <b>€{projected.toFixed(2)}</b>{base != null ? <> (from €{base.toFixed(2)})</> : null}</>
                : <>Proposed: {a.wouldChange ?? `${a.value ?? ''}${unit}`}. Edit to override — the rule’s min/max still apply.</>}
            </p>
          </div>
        )}

        {/* SG.9 — the REAL pause. It used to be the grid's ⏸, which now means "stop suggesting"
            (H10's own meaning). A live Amazon write belongs where the row is fully described,
            not behind a 28px icon next to a mute — so it lives here, still two-step armed. */}
        {st === 'pending' && suggestion.entityType === 'AD_TARGET' && (
          <div className="h10-sug-pausebox">
            <h4>Pause this target at Amazon</h4>
            <p>
              A real change to your account: <b>{src.label}</b>{' '}stops serving until you re-enable it.
              This is not the ⏸ on the row — that one only stops us suggesting.
            </p>
            <Button
              variant="secondary" size="sm" disabled={busy}
              className={armPause ? 'h10-sug-armed' : undefined}
              onClick={() => { if (armPause) { setArmPause(false); void onPauseTarget(suggestion.id).then(onClose) } else setArmPause(true) }}
            >
              <Pause size={14} /> {armPause ? 'Click again to pause it at Amazon' : 'Pause target'}
            </Button>
          </div>
        )}

        {/* Meta */}
        <dl className="h10-sug-meta">
          <div><dt>First proposed</dt><dd>{ago(suggestion.createdAt)}</dd></div>
          {suggestion.trigger ? <div><dt>Trigger</dt><dd>{suggestion.trigger}</dd></div> : null}
          <div><dt>Status</dt><dd>{suggestion.status}{suggestion.status === 'expired' ? ' — the engine stopped proposing this; restore to keep it anyway' : ''}</dd></div>
        </dl>
      </div>
    </Drawer>
  )
}

/**
 * SG.9 — the A.I. decision drawer. The tab had none, so its hover card had nowhere to send you.
 * Read-first: the provenance, the change in operator units, the plan's own reason, and — for a
 * decided row — what the write gate actually did with it. The verbs act immediately here (the
 * grid is where staging happens), which is the family drawer's convention.
 */
export function AiDecisionDrawer({ decision, busy, onClose, onAct }: {
  decision: AiDecision
  busy: boolean
  onClose: () => void
  onAct: (id: string, kind: 'approve' | 'dismiss' | 'mute' | 'restore') => Promise<void>
}) {
  const applyable = ['bid', 'budget', 'placement'].includes(decision.module)
  const proposed = decision.status === 'PROPOSED'
  return (
    <Drawer
      open
      onClose={onClose}
      title={<span className="h10-sug-dh"><Tag tone="info">{decision.module}</Tag> {decision.campaignName ?? decision.planName ?? 'account-wide'}</span>}
      footer={
        <div className="h10-sug-dfoot">
          <Link href="/marketing/ads/ai-advertising" className="open"><ExternalLink size={14} /> Open the plan</Link>
          <span className="grow" />
          {proposed && (
            <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onAct(decision.id, 'mute').then(onClose)}><Pause size={14} /> Stop suggesting</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onAct(decision.id, 'dismiss').then(onClose)}><X size={14} /> Remove</Button>
              <Button variant="primary" size="sm" disabled={busy || !applyable} onClick={() => void onAct(decision.id, 'approve').then(onClose)}
                title={applyable ? undefined : `The ${decision.module} module has no live apply path yet`}
                aria-disabled={!applyable}>
                <Check size={14} /> Approve
              </Button>
            </>
          )}
          {decision.status === 'DISMISSED' && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void onAct(decision.id, 'restore').then(onClose)}><RotateCcw size={14} /> Restore</Button>
          )}
        </div>
      }
    >
      <div className="h10-sug-dbody">
        <div className="h10-sug-flow">
          <FlowNode eyebrow="Plan" title={decision.planName ?? 'A.I. plan'} sub={decision.planEnabled ? 'Enabled · proposing' : 'Disabled — its proposals are stale'} />
          <FlowNode eyebrow="Module" title={decision.module} sub={`${decision.cycle} cycle`} />
          <FlowNode eyebrow="Proposed change" title={aiChangeText(decision.module, decision.before, decision.after)} sub={decision.reason} tone="info" />
          <FlowNode eyebrow="Applies to" title={decision.campaignName ?? 'account-wide'} sub="Campaign" href={decision.campaignId ? `/marketing/ads/campaigns/${decision.campaignId}` : null} last />
        </div>

        {proposed && (
          <div className="h10-sug-edit">
            <h4>What approving does</h4>
            <p className="hint">
              <span>
                {applyable
                  ? (AI_MODULE_EXPLAINER[decision.module] ?? 'It executes through the write gate.')
                  : `The ${decision.module} module has no live apply path yet, so this row can only be removed or muted.`}
                {' '}It runs through the same engine an AUTO plan uses, so approval and autonomy cannot drift apart.
              </span>
            </p>
          </div>
        )}

        {decision.status !== 'PROPOSED' && (
          <div className="h10-sug-dlblock">
            <h4>
              Delivery
              <span className={`h10-sug-dl ${{ delivered: 'ok', pending: 'pd', refused: 'rf', failed: 'fl', unknown: 'uk' }[decision.delivery?.state ?? 'unknown']}`}>
                {decision.status === 'DENIED' ? 'Refused' : decision.status === 'SKIPPED' ? 'Skipped'
                  : { delivered: 'Delivered', pending: 'Pending', refused: 'Refused', failed: 'Failed', unknown: '—' }[decision.delivery?.state ?? 'unknown']}
              </span>
            </h4>
            <p>
              {decision.delivery?.detail ?? decision.reason}
              {' '}The receipt lives in the <Link className="h10-sug-lnk" href="/marketing/ads/changelog">Change Log</Link>.
            </p>
          </div>
        )}
      </div>
    </Drawer>
  )
}
