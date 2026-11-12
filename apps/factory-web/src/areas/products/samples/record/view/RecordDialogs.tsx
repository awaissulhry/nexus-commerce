'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { RoundView } from '../../api'
import { shipmentValueProblem, type Phrase } from '../../model'
import { NoticeLine, useWords } from '../../parts'
import { workOrderFacts } from '../../work-order/model'
import { WorkOrderDialog } from '../../work-order/WorkOrderDialog'
import type { RecordDialog, SampleRecordActions, SampleRecordModel } from '../view-model'

/** B-W2b-284: the make dialog's facts live with the dialog (work-order/model.ts); re-exported for the area's tests. */
export { workOrderFacts }

/** Why the open dialog's primary is held (null: it may be pressed). */
export function dialogHeld(dialog: RecordDialog, offline: boolean): Phrase | null {
  if (dialog.busy) return { key: 'common.working' }
  if (offline) return { key: 'held.offline' }
  switch (dialog.kind) {
    case 'cancel':
      return dialog.reason.trim() ? null : { key: 'cancel.held' }
    case 'nextRound':
      return null
    case 'change':
      return !dialog.title.trim() ? { key: 'change.heldTitle' } : !dialog.reason.trim() ? { key: 'change.heldReason' } : null
    case 'testResult':
      return dialog.result ? null : { key: 'test.held' }
    case 'shipment':
      return shipmentValueProblem('trackingUrl', dialog.trackingUrl) ?? shipmentValueProblem('carrierName', dialog.carrierName) ?? shipmentValueProblem('trackingNumber', dialog.trackingNumber) ?? shipmentValueProblem('note', dialog.note)
    case 'workOrder': {
      if (dialog.made) return null
      if (!dialog.options) return { key: dialog.problem ?? 'common.reading' }
      const facts = workOrderFacts(dialog.options, dialog.lineIds, dialog)
      return facts.blockers[0] ?? (dialog.siteId ? null : { key: 'wo.blocker.pickSite' })
    }
  }
}

/** The record's dialogs: Cancel round, Make the next round, Raise a change, CE result, Add shipment, Make sample work order. */
export function RecordDialogs({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say } = useWords()
  const dialog = model.dialog
  if (!dialog) return null
  const offline = model.live === 'offline'
  const held = say(dialogHeld(dialog, offline))
  const close = () => actions?.onDialog?.(null)
  const patch = (value: Partial<RecordDialog>) => actions?.onDialogPatch?.(value)
  const footer = (label: string, tone: 'primary' | 'danger' = 'primary') => (
    <>
      <Button size="sm" variant="secondary" onClick={close}>
        {dialog.kind === 'workOrder' && dialog.made ? t('common.close') : t('common.cancel')}
      </Button>
      {!(dialog.kind === 'workOrder' && dialog.made) && (
        <Button size="sm" variant={tone} heldReason={held} onClick={() => actions?.onDialogSubmit?.()}>
          {label}
        </Button>
      )}
    </>
  )

  if (dialog.kind === 'cancel')
    return (
      <Modal open onClose={close} title={t('cancel.title', { number: round.number })} size="sm" footer={footer(t('cancel.submit'), 'danger')}>
        <div className="fw-smp-form">
          <p className="fw-smp-hint">{t('cancel.body')}</p>
          <Field label={t('cancel.reason')} required>
            <Textarea value={dialog.reason} rows={3} honourRows maxLength={1000} onChange={(event) => patch({ reason: event.target.value })} />
          </Field>
          <NoticeLine notice={dialog.notice} />
        </div>
      </Modal>
    )

  if (dialog.kind === 'nextRound')
    return (
      <Modal open onClose={close} title={t('next.title')} size="md" footer={footer(t('next.submit'))}>
        <div className="fw-smp-form">
          <p className="fw-smp-hint">{t('next.body', { number: round.number })}</p>
          <Field label={t('new.due')}>
            <DateField value={dialog.dueDate} clearable onChange={(value) => patch({ dueDate: value })} />
          </Field>
          <Field label={t('new.instructions')} hint={t('next.instructionsHint')}>
            <Textarea value={dialog.instructions} rows={3} honourRows maxLength={4000} onChange={(event) => patch({ instructions: event.target.value })} />
          </Field>
          <NoticeLine notice={dialog.notice} />
        </div>
      </Modal>
    )

  if (dialog.kind === 'change')
    return (
      <Modal open onClose={close} title={t('change.title')} size="md" footer={footer(t('change.submit'))}>
        <div className="fw-smp-form">
          <p className="fw-smp-hint">{t('change.body', { style: round.style.code, revision: round.revision.revision })}</p>
          <Field label={t('change.what')} required>
            <Input size="sm" value={dialog.title} maxLength={200} onChange={(event) => patch({ title: event.target.value })} />
          </Field>
          <Field label={t('change.why')} required>
            <Textarea value={dialog.reason} rows={3} honourRows maxLength={4000} onChange={(event) => patch({ reason: event.target.value })} />
          </Field>
          <NoticeLine notice={dialog.notice} />
        </div>
      </Modal>
    )

  if (dialog.kind === 'testResult')
    return (
      <Modal open onClose={close} title={t('test.title')} size="sm" footer={footer(t('test.submit'))}>
        <div className="fw-smp-form">
          <p className="fw-smp-hint">{t('test.body')}</p>
          <fieldset className="fw-smp-radios">
            <legend className="fw-smp-legend">{t('approval.result')}</legend>
            {(['PASSED', 'FAILED'] as const).map((result) => (
              <RadioCard key={result} name="test-result" value={result} title={t(`test.${result}`)} checked={dialog.result === result} selected={dialog.result === result} onChange={() => patch({ result })} />
            ))}
          </fieldset>
          <p className="fw-smp-hint">{t('test.certificateLater')}</p>
          <NoticeLine notice={dialog.notice} />
        </div>
      </Modal>
    )

  if (dialog.kind === 'shipment')
    return (
      <Modal open onClose={close} title={t('ship.addTitle')} size="md" footer={footer(t('ship.addSubmit'))}>
        <div className="fw-smp-form">
          <Field label={t('ship.direction')}>
            <Select size="sm" value={dialog.direction} onChange={(event) => patch({ direction: event.target.value as 'OUTBOUND' | 'RETURN' })}>
              <option value="OUTBOUND">{round.party ? t('ship.outboundTo', { name: round.party.name }) : t('ship.outbound')}</option>
              <option value="RETURN">{t('ship.return')}</option>
            </Select>
          </Field>
          {!round.party && <Banner tone="info" title={t('ship.internalParty')} />}
          <div className="fw-smp-form-grid">
            <Field label={t('ship.col.carrier')}>
              <Input size="sm" value={dialog.carrierName} maxLength={100} onChange={(event) => patch({ carrierName: event.target.value })} />
            </Field>
            <Field label={t('ship.col.tracking')}>
              <Input size="sm" value={dialog.trackingNumber} maxLength={100} onChange={(event) => patch({ trackingNumber: event.target.value })} />
            </Field>
          </div>
          <Field label={t('ship.col.page')} hint={t('ship.pageHint')} error={say(shipmentValueProblem('trackingUrl', dialog.trackingUrl))}>
            <Input size="sm" type="url" value={dialog.trackingUrl} maxLength={2000} placeholder="https://" onChange={(event) => patch({ trackingUrl: event.target.value })} />
          </Field>
          <Field label={t('ship.col.note')}>
            <Textarea value={dialog.note} rows={2} honourRows maxLength={1000} onChange={(event) => patch({ note: event.target.value })} />
          </Field>
          <NoticeLine notice={dialog.notice} lines={dialog.lines} />
        </div>
      </Modal>
    )

  // Make sample work order (B-W2b-284: on an order line, or without one; work-order/WorkOrderDialog.tsx).
  return <WorkOrderDialog model={model} round={round} dialog={dialog} footer={footer(t('wo.submit'))} onClose={close} onPatch={(value) => patch(value)} />
}
