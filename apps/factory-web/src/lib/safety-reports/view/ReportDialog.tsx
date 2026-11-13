'use client'

import { Banner, Stepper } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../i18n/ds-parts'
import { useT } from '../../i18n/provider'
import { labelCamera } from '../camera'
import { REPORT_STEPS, sendHeld, shownProblems, type ReportDialogActions, type ReportDialogModel } from '../dialog'
import { NS, type Door } from '../intake'
import { IntakeFields, IntakeReview } from './IntakeFields'
import { SafetyPhotos, ScanSheet } from './SafetyPhotos'

/**
 * The report dialog from outside (B-W2b-357; design portal.customer.returns pop:safety-report "Modal (full screen on a phone)",
 * links.doc sec:report → the claim form's safety path): two steps — tell us (the shared form) and check and send —, then the
 * end (DS EndState: the number to quote, "our quality team reads it today") with the photos when the door takes them. Esc
 * closes and returns the focus to the opener (the DS Modal); typed work asks Discard / Stay first; Send is held with why
 * (sending, the device check, a wait, no connection). Words of the `safety-reports` catalogue (the host loads it).
 */

export interface ReportDialogViewModel {
  readonly dialog: ReportDialogModel
  readonly door: Exclude<Door, 'office'>
  readonly fixedBatch: string | null
  readonly today: string
  readonly keeper: string | null
  /** The camera reads the label (false in design cases: no camera there). */
  readonly camera: boolean
  /** Whom to write to when the door is closed (the public page's address). */
  readonly contact: string | null
  readonly offline?: boolean
}

export function ReportDialog({ model, actions }: { model: ReportDialogViewModel; actions?: ReportDialogActions }) {
  const t = useT(NS)
  const ds = useDsWords()
  const { dialog, door } = model
  const close = () => actions?.onClose?.()
  const title = door === 'portal' ? t('dialog.titlePortal') : t('dialog.title')

  if (dialog.sent) {
    return (
      <Modal open sheet size="lg" onClose={close} title={title}>
        <div className="fw-sri">
          <EndState
            tone="success"
            title={t('dialog.sentTitle', { number: dialog.sent.number })}
            body={t('dialog.sentBody')}
            next={[door === 'portal' ? t('dialog.sentNextPortal') : t('dialog.sentNext'), t('dialog.sentKeep')]}
            reference={{ value: dialog.sent.number, label: t('dialog.reference') }}
            actions={[{ label: t('common.close'), onClick: close }]}
            labels={ds.endState}
          />
          {dialog.photos && <SafetyPhotos model={dialog.photos} actions={actions?.photos} />}
        </div>
      </Modal>
    )
  }

  const held = sendHeld(dialog, model.offline)
  const wait = dialog.refusal?.wait ?? null
  const waitKey = (prefix: 'held' | 'refused') => (wait?.unit === 'seconds' ? `${prefix}.waitSeconds` : `${prefix}.waitMinutes`)
  const heldText = held === 'held.wait' && wait ? t(waitKey('held'), { count: wait.count }) : held ? t(held) : null
  const refusalText = dialog.refusal ? (wait ? t(waitKey('refused'), { count: wait.count }) : t(dialog.refusal.key)) : null
  const closedRefusal = dialog.refusal?.key === 'refused.off' || dialog.refusal?.key === 'refused.offPortal'
  const at = REPORT_STEPS.indexOf(dialog.step)
  const busyHeld = dialog.busy ? t('dialog.sending') : null
  const footer = dialog.discard ? (
    <>
      <Button variant="secondary" data-autofocus onClick={() => actions?.onStay?.()}>
        {t('common.stay')}
      </Button>
      <Button variant="danger" onClick={() => actions?.onDiscard?.()}>
        {t('common.discard')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" onClick={close} heldReason={busyHeld}>
        {t('common.cancel')}
      </Button>
      {dialog.step === 'review' && (
        <Button variant="secondary" onClick={() => actions?.onBack?.()} heldReason={busyHeld}>
          {t('common.back')}
        </Button>
      )}
      {dialog.step === 'review' ? (
        <Button variant="primary" onClick={() => actions?.onSend?.()} heldReason={heldText}>
          {dialog.busy && <Spinner size={14} />} {dialog.busy ? t('dialog.sending') : t('dialog.send')}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => actions?.onNext?.()}>
          {t('common.next')}
        </Button>
      )}
    </>
  )
  return (
    <Modal open sheet size="lg" onClose={close} title={title} subtitle={t('common.stepOf', { n: at + 1, of: REPORT_STEPS.length, name: t(`dialog.step.${dialog.step}`) })} footer={footer} busy={dialog.busy} closeHeld={busyHeld}>
      <div className="fw-sri">
        <Stepper steps={REPORT_STEPS.map((step) => ({ key: step, label: t(`dialog.step.${step}`) }))} current={at} />
        {dialog.discard && (
          <Banner tone="warning" title={t('common.discardTitle')}>
            {t('common.discardBody')}
          </Banner>
        )}
        {refusalText && (
          <Banner tone={closedRefusal ? 'info' : 'danger'} title={refusalText}>
            {closedRefusal && model.contact ? t('public.closedWrite', { email: model.contact }) : null}
          </Banner>
        )}
        {dialog.checking && (
          <p className="fw-sri-hint" role="status">
            <Spinner size={14} /> {t('dialog.checking')}
          </p>
        )}
        {dialog.step === 'form' ? (
          <>
            <p className="fw-sri-hint">{door === 'portal' ? t('dialog.formIntroPortal') : t('dialog.formIntro')}</p>
            <IntakeFields
              model={{ draft: dialog.draft, problems: shownProblems(dialog, door, model.today, model.fixedBatch), door, fixedBatch: model.fixedBatch, today: model.today, scan: model.camera ? { held: null } : null, keeper: model.keeper }}
              actions={{ onDraft: actions?.onDraft, onScan: () => actions?.onScan?.(true) }}
            />
            <p className="fw-sri-hint">{door === 'portal' ? t('dialog.privacyPortal') : t('dialog.privacy')}</p>
          </>
        ) : (
          <>
            <p className="fw-sri-hint">{t('dialog.reviewIntro')}</p>
            <IntakeReview draft={dialog.draft} door={door} fixedBatch={model.fixedBatch} />
            <p className="fw-sri-hint">{t('dialog.photosLater')}</p>
          </>
        )}
      </div>
      {dialog.scanning && <ScanSheet scanner={model.camera ? labelCamera : null} onScanned={(code) => actions?.onScanned?.(code)} onClose={() => actions?.onScan?.(false)} />}
    </Modal>
  )
}
