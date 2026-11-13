'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateTimeField, Modal } from '../../../../../../lib/i18n/ds-parts'
import type { FieldProblems } from '../../../../../../lib/safety-reports/intake'
import { IntakeFields } from '../../../../../../lib/safety-reports/view/IntakeFields'
import { ScanSheet } from '../../../../../../lib/safety-reports/view/SafetyPhotos'
import { labelCamera } from '../../../../../../lib/safety-reports/camera'
import type { PartyOption, StyleOption } from '../../../api'
import type { NewReportDraft, SafetyCan } from '../../model'
import { useWords } from '../../parts'

/**
 * New report (B-W2b-357; GATE-PRIVACY: "the office types a report from a mail meanwhile"; SAL-414): a report from a mail, a
 * call or a visit, typed by the office — how it came (a mail: when it came), the customer and the style when known, then the
 * shared form (the garment — serial typed or read by the camera —, what happened, an accident, whether anyone was hurt: the
 * office may leave it unsaid, and the injury words only with the reporter's consent, the day and place, who reported). Create
 * opens the report; its SAFETY service case is opened in the same command. Held with why: the rights (sales.safety.manage AND
 * sales.service.manage), sending.
 */

export interface NewReportModel {
  readonly draft: NewReportDraft
  readonly problems: FieldProblems & { receivedAt?: string }
  readonly parties: readonly PartyOption[] | null | 'failed'
  readonly styles: readonly StyleOption[] | null | 'failed'
  readonly busy: boolean
  readonly refusal: string | null
  readonly scanning: boolean
  readonly today: string
  /** The camera reads the label (false in design cases). */
  readonly camera: boolean
}

export interface NewReportActions {
  onDraft?: (patch: Partial<NewReportDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
  onScan?: (open: boolean) => void
  onScanned?: (code: string) => void
}

export function newReportHeld(can: SafetyCan, model: Pick<NewReportModel, 'busy'>): string | null {
  if (!can.manage) return 'held.NO_MANAGE'
  if (!can.serviceManage) return 'held.NO_SERVICE'
  if (model.busy) return 'dialog.sending'
  return null
}

export function NewReportDialog({ model, can, actions }: { model: NewReportModel; can: SafetyCan; actions?: NewReportActions }) {
  const { t } = useWords()
  const { draft } = model
  const set = (patch: Partial<NewReportDraft>) => actions?.onDraft?.(patch)
  const held = newReportHeld(can, model)
  return (
    <Modal
      open
      size="lg"
      sheet
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      subtitle={t('new.subtitle')}
      busy={model.busy}
      closeHeld={model.busy ? t('dialog.sending') : null}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} heldReason={model.busy ? t('dialog.sending') : null}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onSubmit?.()} heldReason={held ? t(held) : null}>
            {model.busy && <Spinner size={14} />} {t('new.create')}
          </Button>
        </>
      }
    >
      <div className="fw-acc-dialog">
        {model.refusal && <Banner tone="danger" title={t(model.refusal)} />}
        <fieldset className="fw-sri-group">
          <legend className="fw-sri-legend">{t('new.how')}</legend>
          <div className="fw-sri-choices" role="radiogroup" aria-label={t('new.how')}>
            <RadioCard variant="row" name="fw-acc-source" value="MAIL" checked={draft.source === 'MAIL'} selected={draft.source === 'MAIL'} onChange={() => set({ source: 'MAIL' })} title={t('source.MAIL')} />
            <RadioCard variant="row" name="fw-acc-source" value="OFFICE" checked={draft.source === 'OFFICE'} selected={draft.source === 'OFFICE'} onChange={() => set({ source: 'OFFICE', receivedAt: '' })} title={t('source.OFFICE')} />
          </div>
          <div className="fw-acc-row">
            {draft.source === 'MAIL' && (
              <Field label={t('new.receivedAt')} hint={t('new.receivedAtHint')} error={model.problems.receivedAt ? t(model.problems.receivedAt) : undefined}>
                <DateTimeField value={draft.receivedAt} onChange={(value) => set({ receivedAt: value })} />
              </Field>
            )}
            <Field label={t('new.customer')} hint={model.parties === 'failed' ? t('new.partiesFailed') : t('new.customerHint')}>
              <Select value={draft.partyId} disabled={!Array.isArray(model.parties)} onChange={(event) => set({ partyId: event.target.value })}>
                <option value="">{t('new.noCustomer')}</option>
                {(Array.isArray(model.parties) ? model.parties : []).map((party) => (
                  <option key={party.id} value={party.id}>{`${party.code} · ${party.tradeName ?? party.legalName}`}</option>
                ))}
              </Select>
            </Field>
            <Field label={t('new.style')} hint={model.styles === 'failed' ? t('new.stylesFailed') : t('new.styleHint')}>
              <Select value={draft.styleId} disabled={!Array.isArray(model.styles)} onChange={(event) => set({ styleId: event.target.value })}>
                <option value="">{t('new.noStyle')}</option>
                {(Array.isArray(model.styles) ? model.styles : []).map((style) => (
                  <option key={style.id} value={style.id}>{`${style.code} · ${style.name}`}</option>
                ))}
              </Select>
            </Field>
          </div>
        </fieldset>
        <IntakeFields
          model={{ draft, problems: model.problems, door: 'office', fixedBatch: null, today: model.today, scan: model.camera ? { held: null } : null, keeper: null }}
          actions={{ onDraft: (patch) => set(patch), onScan: () => actions?.onScan?.(true) }}
        />
      </div>
      {model.scanning && <ScanSheet scanner={model.camera ? labelCamera : null} onScanned={(code) => actions?.onScanned?.(code)} onClose={() => actions?.onScan?.(false)} />}
    </Modal>
  )
}
