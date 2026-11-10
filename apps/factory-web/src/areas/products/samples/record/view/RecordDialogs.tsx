'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { RoundView, WorkOrderOptions } from '../../api'
import { shipmentValueProblem, type Phrase } from '../../model'
import { NoticeLine, useWords } from '../../parts'
import type { RecordDialog, SampleRecordActions, SampleRecordModel } from '../view-model'

/** The make dialog's facts said in our words (the API's `blockers` and `warnings` are English sentences without codes). */
export function workOrderFacts(options: WorkOrderOptions, chosen: readonly string[]): { blockers: Phrase[]; warnings: Phrase[] } {
  const blockers: Phrase[] = []
  const warnings: Phrase[] = []
  if (options.lines.length === 0) blockers.push({ key: options.round.partyId ? 'wo.blocker.noLinesCustomer' : 'wo.blocker.noLines' })
  if (options.sites.length === 0) blockers.push({ key: 'wo.blocker.noSites' })
  if (options.lines.length > 0 && chosen.length === 0) blockers.push({ key: 'wo.blocker.pickLine' })
  if (options.lines.length > 0 && options.sites.length > 0 && options.blockers.length > 0 && blockers.length === 0) blockers.push({ key: 'wo.blocker.other', params: { count: options.blockers.length } })
  if (options.round.revision.status === 'DRAFT') warnings.push({ key: 'wo.warning.draft', params: { revision: options.round.revision.revision } })
  if (options.warnings.length > 0 && options.round.revision.status !== 'DRAFT') warnings.push({ key: 'wo.warning.other', params: { count: options.warnings.length } })
  return { blockers, warnings }
}

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
      const facts = workOrderFacts(dialog.options, dialog.lineIds)
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

  // Make sample work order.
  const options = dialog.options
  const facts = options ? workOrderFacts(options, dialog.lineIds) : null
  return (
    <Modal open onClose={close} title={t('wo.title')} subtitle={round.number} size="xl" footer={footer(t('wo.submit'))}>
      <div className="fw-smp-form">
        {dialog.made ? (
          <Banner tone="success" title={t('wo.made', { number: dialog.made.number })}>
            {model.can.workOrdersView ? (
              <Link className="fw-smp-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(dialog.made.id)}`}>
                {t('wo.open', { number: dialog.made.number })}
              </Link>
            ) : null}
          </Banner>
        ) : !options ? (
          dialog.problem ? (
            <Banner tone="danger" title={t('wo.failed')}>
              {t(dialog.problem)}
            </Banner>
          ) : (
            <Skeleton height={160} />
          )
        ) : (
          <>
            <p className="fw-smp-hint">{t('wo.body', { revision: options.round.revision.revision })}</p>
            {facts!.blockers.map((line) => (
              <Banner key={line.key} tone="danger" title={say(line)} />
            ))}
            {facts!.warnings.map((line) => (
              <Banner key={line.key} tone="warning" title={say(line)} />
            ))}
            {options.lines.length > 0 && (
              <SummaryTable
                label={t('wo.lines')}
                density="roomy"
                stackOnPhone
                columns={[t('wo.col.take'), t('wo.col.line'), t('wo.col.colourway'), t('wo.col.open'), t('wo.col.takes')]}
                rows={options.lines.map((line) => ({
                  id: line.id,
                  cells: [
                    <Checkbox
                      key="c"
                      aria-label={t('wo.takeLine', { order: line.orderNumber, seq: line.seq })}
                      checked={dialog.lineIds.includes(line.id)}
                      onChange={(event) => patch({ lineIds: event.target.checked ? [...dialog.lineIds, line.id] : dialog.lineIds.filter((id) => id !== line.id) })}
                    />,
                    t('wo.lineName', { order: line.orderNumber, seq: line.seq }),
                    line.colourwayCode,
                    line.open.map((size) => `${size.size}: ${size.open}`).join(' · ') || '—',
                    line.proposed.map((size) => `${size.size} × ${size.quantity}`).join(' · ') || t('wo.takesNothing'),
                  ],
                }))}
              />
            )}
            <div className="fw-smp-form-grid">
              <Field label={t('wo.site')} required>
                <Select size="sm" value={dialog.siteId} onChange={(event) => patch({ siteId: event.target.value })}>
                  <option value="">{t('wo.pickSite')}</option>
                  {options.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('wo.due')} hint={t('wo.dueHint')}>
                <DateField value={dialog.dueDate} clearable onChange={(value) => patch({ dueDate: value })} />
              </Field>
            </div>
          </>
        )}
        <NoticeLine notice={dialog.notice} />
      </div>
    </Modal>
  )
}
