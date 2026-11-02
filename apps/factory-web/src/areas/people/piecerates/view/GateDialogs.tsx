'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, StepUpModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { dayText, preconditionWords, reasonHeld, startDayFloor } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { said, usePieceWords } from './parts'

/**
 * The switch's pop-ups: Record what piece pay rests on (the CCNL, the notice, the assessment, the consultant, the scheme: what
 * the gate's rows ask for), Start piece pay (the preconditions as met, the first day, why; the API refuses in words BEFORE it
 * asks a fresh code, so the code comes last), and Stop it (an open period stays computable).
 */
export function GateDialogs({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const { dialog } = model
  const view = model.gate?.status === 'ready' ? model.gate.value : null
  const site = view?.site.name ?? ''
  return (
    <>
      {dialog?.kind === 'preconditions' && view && (
        <Modal
          open
          onClose={() => actions?.onCloseDialog()}
          title={t('pre.title', { site })}
          footer={
            <>
              <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" heldReason={dialog.busy ? t('common.working') : null} onClick={() => actions?.onPreconditionsSave()}>
                {t('pre.save')}
              </Button>
            </>
          }
        >
          <div className="fw-pr8-stack">
            {view.state === 'ON' && <Banner tone="info" title={t('pre.onlyNote')} />}
            {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
            <div className="fw-pr8-grid">
              <Field label={t('pre.ccnl')}>
                <Input value={dialog.draft.ccnlName} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ ccnlName: event.target.value })} />
              </Field>
              <Field label={t('pre.article')}>
                <Input value={dialog.draft.ccnlArticle} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ ccnlArticle: event.target.value })} />
              </Field>
              <Field label={t('pre.notice')}>
                <Select value={dialog.draft.workerNoticeId} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ workerNoticeId: event.target.value })}>
                  <option value="">{t('common.choose')}</option>
                  {view.candidates.notices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('pre.dpia')}>
                <Select value={dialog.draft.dpiaId} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ dpiaId: event.target.value })}>
                  <option value="">{t('common.choose')}</option>
                  {view.candidates.dpias.map((row) => (
                    <option key={row.id} value={row.id}>
                      {t('pre.dpiaVersion', { version: row.versionNo })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('pre.consultant')}>
                <Input value={dialog.draft.consultantName} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ consultantName: event.target.value })} />
              </Field>
              <Field label={t('pre.agreedOn')}>
                <DateField value={dialog.draft.consultantAgreedOn} disabled={view.state === 'ON'} onChange={(value) => actions?.onPreconditionsDraft({ consultantAgreedOn: value ?? '' })} />
              </Field>
              <Field label={t('pre.scheme')}>
                <Select value={dialog.draft.schemeId} disabled={view.state === 'ON'} onChange={(event) => actions?.onPreconditionsDraft({ schemeId: event.target.value })}>
                  <option value="">{t('common.choose')}</option>
                  {view.candidates.schemes.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t('pre.note')}>
              <Textarea value={dialog.draft.note} rows={2} onChange={(event) => actions?.onPreconditionsDraft({ note: event.target.value })} />
            </Field>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'start' && view && (
        <Modal
          open
          onClose={() => actions?.onCloseDialog()}
          title={t('start.title', { site })}
          footer={
            <>
              <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" heldReason={dialog.busy ? t('common.working') : !dialog.onFrom ? t('start.heldDay') : dialog.onFrom < startDayFloor(view) ? t('start.heldPast') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => actions?.onStartSave()}>
                {t('start.apply')}
              </Button>
            </>
          }
        >
          <div className="fw-pr8-stack">
            {dialog.problem && (
              <Banner tone="danger" title={said(t, dialog.problem)}>
                {dialog.missing.length > 0 && (
                  <ul className="fw-pr8-list">
                    {view.preconditions
                      .filter((item) => dialog.missing.includes(item.code))
                      .map((item) => (
                        <li key={item.code}>{said(t, preconditionWords(item, view, locale))}</li>
                      ))}
                  </ul>
                )}
              </Banner>
            )}
            <p className="fw-pr8-hint">{t('start.lead')}</p>
            <ul className="fw-pr8-list">
              {view.preconditions.map((item) => (
                <li key={item.code}>
                  <b>{t(`gate.${item.code}.label`)}</b> — {said(t, preconditionWords(item, view, locale))}
                </li>
              ))}
            </ul>
            <Field label={t('start.day')} required>
              <DateField value={dialog.onFrom} onChange={(value) => actions?.onStartDraft({ onFrom: value ?? '' })} />
            </Field>
            <Field label={t('start.reason')} required>
              <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onStartDraft({ reason: event.target.value })} />
            </Field>
            <p className="fw-pr8-hint">{t('start.code')}</p>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'stop' && view && (
        <Modal
          open
          onClose={() => actions?.onCloseDialog()}
          title={t('stop.title', { site })}
          footer={
            <>
              <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
                {t('common.cancel')}
              </Button>
              <Button variant="danger" heldReason={dialog.busy ? t('common.working') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => actions?.onStopSave()}>
                {t('stop.apply')}
              </Button>
            </>
          }
        >
          <div className="fw-pr8-stack">
            {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
            <ul className="fw-pr8-list">
              <li>{t('stop.day', { day: dayText(view.onFrom && view.onFrom > view.today ? view.onFrom : view.today, locale) ?? '' })}</li>
              <li>{t('stop.open')}</li>
              <li>{t('stop.again')}</li>
            </ul>
            <Field label={t('stop.reason')} required>
              <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onDialogReason(event.target.value)} />
            </Field>
          </div>
        </Modal>
      )}

      <StepUpModal open={model.stepUp.open} title={t('stepUp.title')} sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''} busy={model.stepUp.busy} error={model.stepUp.problem ? t(model.stepUp.problem) : null} onSubmit={(code) => actions?.onStepUpSubmit(code)} onClose={() => actions?.onStepUpCancel()} confirmLabel={t('stepUp.confirm')} />
    </>
  )
}
