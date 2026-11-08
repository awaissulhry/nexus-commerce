'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, RadioCard, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { Machine } from '../../../_shared/api'
import { MachinePill } from '../../../_shared/parts'
import type { Words } from '../../../_shared/model'
import { SETTABLE, type Settable } from '../api'
import { releases, statusHeld, type StatusDraft } from '../model'
import { useDepthWords, useSay } from '../parts'

export interface StatusDialogState {
  draft: StatusDraft
  busy: boolean
  problem: Words | null
}

/**
 * Change status (design plant.machines pop:status, from the record's ⋯): the status — running, down, under maintenance or
 * do-not-use — and the reason, always (the history copies it). Do-not-use set here also needs a reason, and only a
 * technician releases it, with a fresh code (the same signing act as a sign-safe). A machine locked as unsafe is not changed
 * here: its request's sign-safe frees it (Owner answer H1). Held buttons say why.
 */
export function StatusDialog({
  machine,
  state,
  can,
  onDraft,
  onClose,
  onSubmit,
}: {
  machine: Pick<Machine, 'assetNumber' | 'status' | 'locked' | 'statusReason'>
  state: StatusDialogState
  can: { manage: boolean; signSafe: boolean }
  onDraft?: (patch: Partial<StatusDraft>) => void
  onClose?: () => void
  onSubmit?: () => void
}) {
  const t = useDepthWords()
  const say = useSay()
  const held = statusHeld(machine, state.draft, can, state.busy)
  const release = releases(machine.status, state.draft.to)
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('status.title', { machine: machine.assetNumber })}
      size="md"
      footer={
        <>
          <Button onClick={() => onClose?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => onSubmit?.()}>
            {state.busy ? <Spinner size={12} /> : null} {t('status.submit')}
          </Button>
        </>
      }
    >
      <form
        className="fw-md-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) onSubmit?.()
        }}
      >
        <p className="fw-md-row">
          <span className="fw-md-muted">{t('status.now')}</span> <MachinePill status={machine.status} locked={machine.locked} />
          {machine.statusReason ? <span className="fw-md-muted">{machine.statusReason}</span> : null}
        </p>
        {machine.locked && (
          <Banner tone="danger" title={t('status.lockedTitle')}>
            {t('status.lockedBody')}
          </Banner>
        )}
        {state.problem && <Banner tone="danger" title={say(state.problem) ?? ''} />}
        <fieldset className="fw-md-fieldset" disabled={machine.locked || !can.manage}>
          <legend>{t('status.to')}</legend>
          <div className="fw-md-radios">
            {SETTABLE.map((choice: Settable) => (
              <RadioCard
                key={choice}
                name="fw-md-status"
                value={choice}
                checked={state.draft.to === choice}
                selected={state.draft.to === choice}
                disabled={choice === machine.status}
                onChange={() => onDraft?.({ to: choice })}
                title={t(`status.choice.${choice}`)}
                description={choice === machine.status ? t('status.current') : t(`status.choiceHint.${choice}`)}
              />
            ))}
          </div>
        </fieldset>
        {state.draft.to === 'DO_NOT_USE' && <Banner tone="warning" title={t('status.doNotUseTitle')}>{t('status.doNotUseBody')}</Banner>}
        {release && <Banner tone={can.signSafe ? 'info' : 'warning'} title={t(can.signSafe ? 'status.releaseTitle' : 'status.releaseHeldTitle')}>{t(can.signSafe ? 'status.releaseBody' : 'status.releaseHeldBody')}</Banner>}
        <Field label={t('status.reason')} required hint={t('status.reasonHint')}>
          <Textarea rows={3} maxLength={500} value={state.draft.reason} onChange={(event) => onDraft?.({ reason: event.target.value })} />
        </Field>
      </form>
    </Modal>
  )
}
