'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { StatusReach, SupplierProfile, SupplierStatus } from '../api'
import { NEEDS_REASON, reasonProblem, STOPS_NEW_ORDERS, statusMoves, type Read } from '../model'
import { useSay } from './parts'

export interface StatusDialogModel {
  readonly profile: SupplierProfile
  readonly to: SupplierStatus | null
  readonly reason: string
  /** What the move reaches (drafts held, sent orders unchanged), read when a status is picked. */
  readonly reach: Read<StatusReach> | null
  readonly busy: boolean
  readonly failed: string | null
  readonly tried: boolean
}

export interface StatusDialogActions {
  onPick?: (status: SupplierStatus | null) => void
  onReason?: (reason: string) => void
  onConfirm?: () => void
  onClose?: () => void
}

/**
 * Change status (SCM-008): only the moves the rules allow from where the supplier stands, a reason for Conditional, On
 * hold and Blocked, and what the move reaches said before the click (drafts held at their send, sent orders unchanged).
 */
export function StatusDialog({ model, actions }: { model: StatusDialogModel | null; actions?: StatusDialogActions }) {
  const { t, say } = useSay()
  if (!model) return null
  const moves = statusMoves(model.profile)
  const problem = reasonProblem(model.to, model.reason)
  const reach = model.reach
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('status.dialog.title', { name: model.profile.name })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={model.busy ? t('dialog.saving') : model.tried && problem ? say(problem) : null}>
            {model.to ? t('status.dialog.confirm', { status: t(`status.${model.to}`) }) : t('status.change')}
          </Button>
        </>
      }
    >
      <div className="fw-spd-stack">
        <p className="fw-spd-hint">{t('status.dialog.now', { status: t(`status.${model.profile.standing.status}`) })}</p>
        <Field label={t('status.dialog.to')} error={model.tried && model.to === null ? say(problem) : undefined}>
          <Select value={model.to ?? ''} onChange={(event) => actions?.onPick?.(event.target.value === '' ? null : (event.target.value as SupplierStatus))}>
            <option value="">{t('status.dialog.pick')}</option>
            {moves.map((status) => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('status.dialog.reason')} required={model.to !== null && NEEDS_REASON.has(model.to)} hint={t('status.dialog.reasonHint')} error={model.tried && model.to !== null && problem ? say(problem) : undefined}>
          <Textarea rows={2} value={model.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
        {model.to && STOPS_NEW_ORDERS.has(model.to) ? <Banner tone="warning" title={t('status.dialog.stops')} /> : null}
        {model.to === 'PROSPECT' ? <Banner tone="info" title={t('status.dialog.prospect')} /> : null}
        {reach === null ? null : reach.status === 'loading' ? (
          <p className="fw-spd-hint" role="status">
            <Spinner size={14} /> {t('status.dialog.reaching')}
          </p>
        ) : reach.status === 'error' ? (
          <p className="fw-spd-hint">{t('status.dialog.reachFailed')}</p>
        ) : (
          <p className="fw-spd-reach">{STOPS_NEW_ORDERS.has(reach.value.status) ? t('status.dialog.reachStops', { drafts: reach.value.draftsHeld, open: reach.value.openUnchanged }) : t('status.dialog.reachGoes', { drafts: reach.value.draftsHeld, open: reach.value.openUnchanged })}</p>
        )}
        {model.failed ? <Banner tone="danger" title={t(model.failed)} /> : null}
      </div>
    </Modal>
  )
}
