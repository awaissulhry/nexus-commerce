'use client'

import { ACCIDENT_OUTCOMES, type AccidentOutcome } from '@nexus/factory-domain/sales/safety-reports/rules'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Checkbox, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import type { Report } from '../../api'
import type { ReviseField } from '../../model'
import { useWords } from '../../parts'
import { dialogHeld, reviseFieldProblems } from '../dialogs'
import type { DialogState, RecordDialog, ReportRecordActions, ReportRecordModel } from '../view-model'

/**
 * The report's dialogs (B-W2b-357): Close (what quality found and did), Record in the accident log / a revision / the authority
 * was told (GPSR art. 20: the day, the place, what came of it — coarsely, never the injury —, why a revision corrects the log,
 * the day the authority was told and its reference), Erase the reporter's data and Erase the injury words (GDPR art. 17: whose
 * request and when), Record whether someone was hurt (the words only with the reporter's consent, GDPR art. 9), Correct the
 * facts (the garment, the day, worn as intended) and File in the PPE register (a new COMPLAINT entry for the report's style).
 * One write each, with the version read; the button held with why; a refusal in our words.
 */
export function RecordDialogs({ model, report, state, actions }: { model: ReportRecordModel; report: Report; state: DialogState; actions?: ReportRecordActions }) {
  const { t } = useWords()
  const dialog = state.dialog
  const held = dialogHeld(dialog, report, model.today)
  const change = (next: RecordDialog) => actions?.onDialogChange?.(next)
  const close = () => actions?.onDialog?.(null)
  const titleKey = dialog.kind === 'revise' ? (dialog.told ? 'record.told' : dialog.first ? 'record.logFirst' : 'record.revise') : `dialog.${dialog.kind}.title`
  const confirmKey = dialog.kind === 'revise' ? (dialog.told ? 'dialog.revise.saveTold' : 'dialog.revise.save') : `dialog.${dialog.kind}.confirm`
  const busyHeld = state.busy ? t('dialog.saving') : null
  return (
    <Modal
      open
      size={dialog.kind === 'revise' || dialog.kind === 'recordInjury' ? 'lg' : 'md'}
      onClose={close}
      title={t(titleKey)}
      busy={state.busy}
      closeHeld={busyHeld}
      footer={
        <>
          <Button variant="secondary" onClick={close} heldReason={busyHeld}>
            {t('common.cancel')}
          </Button>
          <Button variant={dialog.kind === 'eraseReporter' || dialog.kind === 'eraseInjury' ? 'danger' : 'primary'} onClick={() => actions?.onDialogSubmit?.()} heldReason={busyHeld ?? (held && state.tried ? t(held) : null)}>
            {state.busy && <Spinner size={14} />} {t(confirmKey)}
          </Button>
        </>
      }
    >
      <div className="fw-acc-dialog">
        {state.problem && <Banner tone="danger" title={t(state.problem)} />}
        <DialogBody dialog={dialog} report={report} model={model} tried={state.tried} change={change} />
      </div>
    </Modal>
  )
}

function DialogBody({ dialog, report, model, tried, change }: { dialog: RecordDialog; report: Report; model: ReportRecordModel; tried: boolean; change: (next: RecordDialog) => void }) {
  const { t } = useWords()
  const ds = useDsWords()
  const held = dialogHeld(dialog, report, model.today)
  const shown = tried && held ? t(held) : undefined
  switch (dialog.kind) {
    case 'close':
      return (
        <>
          <p className="fw-acc-hint">{t('dialog.close.intro')}</p>
          <Field label={t('dialog.close.note')} error={shown} required>
            <Textarea value={dialog.note} onChange={(event) => change({ ...dialog, note: event.target.value })} rows={5} maxLength={2000} />
          </Field>
        </>
      )
    case 'file':
      return (
        <>
          <p className="fw-acc-hint">{report.style ? t('dialog.file.intro', { style: `${report.style.code} · ${report.style.name}` }) : t('held.NO_STYLE')}</p>
          <p className="fw-acc-hint">{t('dialog.file.words')}</p>
          {!model.can.registerManage && <Banner tone="warning" title={t('dialog.file.noRight')} />}
        </>
      )
    case 'eraseReporter':
    case 'eraseInjury':
      return (
        <>
          <p className="fw-acc-hint">{t(`dialog.${dialog.kind}.intro`)}</p>
          <p className="fw-acc-hint">
            <LawRef law="GDPR art. 17" plain={t('dialog.eraseLaw')} labels={ds.lawRef} />
          </p>
          <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')} error={shown} required>
            <Textarea value={dialog.reason} onChange={(event) => change({ ...dialog, reason: event.target.value })} rows={3} maxLength={500} />
          </Field>
        </>
      )
    case 'recordInjury':
      return (
        <>
          <p className="fw-acc-hint">{t('dialog.recordInjury.intro')}</p>
          <div className="fw-sri-choices" role="radiogroup" aria-label={t('intake.injured')}>
            <RadioCard variant="row" name="fw-acc-hurt" value="yes" checked={dialog.draft.injured === true} selected={dialog.draft.injured === true} onChange={() => change({ ...dialog, draft: { ...dialog.draft, injured: true } })} title={t('intake.injuredYes')} />
            <RadioCard variant="row" name="fw-acc-hurt" value="no" checked={dialog.draft.injured === false} selected={dialog.draft.injured === false} onChange={() => change({ ...dialog, draft: { injured: false, consent: false, words: '' } })} title={t('intake.injuredNo')} />
          </div>
          {dialog.draft.injured === true && (
            <div className="fw-sri-consent">
              <Checkbox checked={dialog.draft.consent} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, consent: event.target.checked } })} label={t('intake.consentOffice', { keeper: t('intake.theMaker') })} />
              {dialog.draft.consent && (
                <Field label={t('intake.injuryWords')} hint={t('intake.injuryWordsHint')}>
                  <Textarea value={dialog.draft.words} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, words: event.target.value } })} rows={3} maxLength={2000} />
                </Field>
              )}
            </div>
          )}
          {shown && <p className="fw-sri-error">{shown}</p>}
        </>
      )
    case 'facts':
      return (
        <>
          <p className="fw-acc-hint">{t('dialog.facts.intro')}</p>
          <div className="fw-acc-row">
            <Field label={t('intake.serial')}>
              <Input value={dialog.draft.serial} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, serial: event.target.value } })} maxLength={100} className="fw-acc-mono" />
            </Field>
            <Field label={t('intake.batch')}>
              <Input value={dialog.draft.batchNumber} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, batchNumber: event.target.value } })} maxLength={100} className="fw-acc-mono" />
            </Field>
            <Field label={t('intake.size')}>
              <Input value={dialog.draft.size} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, size: event.target.value } })} maxLength={20} />
            </Field>
            <Field label={t('intake.occurredOn')}>
              <DateField value={dialog.draft.occurredOn} onChange={(value) => change({ ...dialog, draft: { ...dialog.draft, occurredOn: value } })} max={model.today} clearable />
            </Field>
            <Field label={t('intake.worn')}>
              <Select value={dialog.draft.worn} onChange={(event) => change({ ...dialog, draft: { ...dialog.draft, worn: event.target.value as 'yes' | 'no' | 'unsure' } })}>
                {(['yes', 'no', 'unsure'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`intake.wornValue.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {shown && <p className="fw-sri-error">{shown}</p>}
        </>
      )
    case 'revise': {
      const problems: Partial<Record<ReviseField, string>> = tried ? reviseFieldProblems(dialog, report, model.today) : {}
      const problem = (field: ReviseField) => (problems[field] ? t(problems[field]!) : undefined)
      const set = (patch: Partial<typeof dialog.draft>) => change({ ...dialog, draft: { ...dialog.draft, ...patch } })
      return (
        <>
          <p className="fw-acc-hint">{dialog.told ? t('dialog.revise.introTold') : dialog.first ? t('dialog.revise.introFirst') : t('dialog.revise.intro')}</p>
          <div className="fw-acc-row">
            <Field label={t('log.col.day')} error={problem('occurredOn')} required>
              <DateField value={dialog.draft.occurredOn} onChange={(value) => set({ occurredOn: value })} max={model.today} />
            </Field>
            <Field label={t('log.col.place')} error={problem('place')} required>
              <Input value={dialog.draft.place} onChange={(event) => set({ place: event.target.value })} maxLength={300} />
            </Field>
            <Field label={t('log.col.outcome')} hint={t('dialog.revise.outcomeHint')} error={problem('outcome')} required>
              <Select value={dialog.draft.outcome} onChange={(event) => set({ outcome: event.target.value as AccidentOutcome | '' })}>
                <option value="">{t('dialog.revise.pickOutcome')}</option>
                {ACCIDENT_OUTCOMES.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {t(`outcome.${outcome}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <fieldset className="fw-sri-group">
            <legend className="fw-sri-legend">{t('dialog.revise.authority')}</legend>
            <p className="fw-acc-hint">{t('dialog.revise.authorityHint')}</p>
            <div className="fw-acc-row">
              <Field label={t('dialog.revise.toldOn')} error={problem('toldOn')} required={dialog.told}>
                <DateField value={dialog.draft.toldOn} onChange={(value) => set({ toldOn: value })} max={model.today} clearable={!dialog.told} />
              </Field>
              <Field label={t('dialog.revise.reference')} hint={t('dialog.revise.referenceHint')} error={problem('reference')}>
                <Input value={dialog.draft.reference} onChange={(event) => set({ reference: event.target.value })} maxLength={200} className="fw-acc-mono" />
              </Field>
            </div>
          </fieldset>
          <Field label={t('dialog.revise.note')} hint={dialog.first ? t('dialog.revise.noteFirstHint') : t('dialog.revise.noteHint')} error={problem('note')} required={!dialog.first}>
            <Textarea value={dialog.draft.note} onChange={(event) => set({ note: event.target.value })} rows={3} maxLength={2000} />
          </Field>
        </>
      )
    }
  }
}
