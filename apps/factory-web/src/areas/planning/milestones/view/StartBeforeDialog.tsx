'use client'

import { FastForward } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { GATE_LIMITS } from '@nexus/factory-domain/planning/milestones/rules'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../model'

export interface StartBeforeGate {
  readonly id: string
  /** The gate's name in words. */
  readonly name: string
  readonly order: string
  /** The target date, written ("25/11/2026"), or '—'. */
  readonly target: string
  readonly owner: string | null
  /** Why this gate cannot be started before by this person (null: it can). */
  readonly held: string | null
}

/**
 * "Start before the gate?" (design planning.milestones pop:gate-override; opened from a milestone's dialog or a planning board
 * drop the board held): which gate, why it matters (the order's work waits on it: the board holds it), the reason required
 * (3 to 1000 characters, said before the click), who may do it (someone who is neither the gate's planner nor the person who
 * added it). "Start before with this reason" is held with the reason in words; Esc closes and returns the focus to the opener.
 * A view: it fetches nothing.
 */
export function StartBeforeDialog({
  gates,
  reason,
  busy,
  problem,
  held,
  onReason,
  onConfirm,
  onCancel,
  t,
}: {
  gates: readonly StartBeforeGate[]
  reason: string
  busy: boolean
  /** A refused write, as our words. */
  problem: string | null
  /** Why the confirm waits (no permission, a reason too short, every gate held), or null. */
  held: string | null
  onReason: (reason: string) => void
  onConfirm: () => void
  onCancel: () => void
  t: Translate
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('start.title', { count: gates.length })}
      subtitle={gates[0] ? t('start.subtitle', { order: gates[0].order }) : undefined}
      size="md"
      footer={
        <span className="fw-tna-footer">
          <span />
          <span className="fw-tna-inline">
            <Button size="sm" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={busy ? t('held.busy') : held} onClick={onConfirm}>
              {busy ? <Spinner size={12} /> : <FastForward size={13} aria-hidden />} {t('start.confirm')}
            </Button>
          </span>
        </span>
      }
    >
      <div className="fw-tna-dialog">
        <ul className="fw-tna-gate-list">
          {gates.map((gate) => (
            <li key={gate.id} className="fw-tna-cell">
              <span className="fw-tna-strong">{t('start.gate', { name: gate.name, target: gate.target })}</span>
              <span className="fw-tna-sub">{gate.owner ? t('start.owner', { name: gate.owner }) : t('start.noOwner')}</span>
              {gate.held && <span className="fw-tna-sub fw-tna-danger">{gate.held}</span>}
            </li>
          ))}
        </ul>
        <p className="fw-tna-hint">{t('start.why')}</p>
        <Field label={t('start.reason')} required hint={t('start.reasonHint', { min: GATE_LIMITS.reasonMin, max: GATE_LIMITS.reason })}>
          <Textarea rows={3} maxLength={GATE_LIMITS.reason} value={reason} onChange={(event) => onReason(event.target.value)} />
        </Field>
        <p className="fw-tna-hint">{t('start.audit')}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}
