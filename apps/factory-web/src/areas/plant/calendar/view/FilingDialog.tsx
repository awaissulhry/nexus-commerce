'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { ACCEPT } from '../api'
import { atField, filingHeld, noticeToConfirm } from '../model'
import type { CalendarPageActions, CalendarPageModel, FilingState } from '../view-model'
import { problemText, useDay, useWords } from './parts'

/**
 * Record RLS notice (design pop:rls-filing; from the RLS panel): the day it was filed on the INAIL portal (today or
 * before; never before the RLS was elected or designated), INAIL's reference, the receipt (generic files, record type
 * RlsNotice). Also "Set the due day you confirmed" and Cancel notice with the reason. The send itself is manual on the
 * INAIL portal: the page records it. Esc closes and the focus goes back to the opener (the DS Modal).
 */
export function FilingDialog({ model, state, actions }: { model: CalendarPageModel; state: FilingState; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const listed = model.notices.status === 'ready' ? (model.notices.value.notices.find((entry) => entry.id === state.id) ?? null) : null
  const notice = state.latest ?? listed
  const canManage = !!notice && notice.canManage && model.can.manageOrganisation
  const canUpload = canManage && model.can.upload
  const closeIt = () => actions?.onAddress?.({ filing: null })
  const error = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  const held = notice ? filingHeld(state.draft, { ...notice, canManage }, model.today, state.busy) : 'held.reading'
  const pending = notice?.status === 'PENDING'

  const footer = !notice ? (
    <Button onClick={closeIt}>{t('common.close')}</Button>
  ) : state.step === 'due' ? (
    <>
      <Button onClick={() => actions?.onFilingStep?.('file')}>{t('common.back')}</Button>
      <Button variant="primary" heldReason={!canManage ? t('held.organisation') : state.busy ? t('held.saving') : !state.draft.dueOn ? t('held.noticeDue') : state.draft.dueOn === notice.dueOn ? t('held.nothingChanged') : null} onClick={() => actions?.onSetDue?.()}>
        {t('filing.saveDue')}
      </Button>
    </>
  ) : state.step === 'cancel' ? (
    <>
      <Button onClick={() => actions?.onFilingStep?.('file')}>{t('common.back')}</Button>
      <Button variant="danger" heldReason={!canManage ? t('held.organisation') : state.busy ? t('held.saving') : state.draft.cancelReason.trim() ? null : t('held.reason')} onClick={() => actions?.onCancelNotice?.()}>
        {t('filing.cancelConfirm')}
      </Button>
    </>
  ) : pending ? (
    <>
      <Button size="sm" variant="quiet" heldReason={canManage ? null : t('held.organisation')} onClick={() => actions?.onFilingStep?.('due')}>
        {t('filing.setDue')}
      </Button>
      <Button size="sm" variant="quiet" heldReason={canManage ? null : t('held.organisation')} onClick={() => actions?.onFilingStep?.('cancel')}>
        {t('filing.cancel')}
      </Button>
      <span className="grow" />
      <Button onClick={closeIt}>{t('common.cancel')}</Button>
      <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRecordFiling?.()}>
        {state.busy ? <Spinner size={14} /> : null} {t('filing.record')}
      </Button>
    </>
  ) : (
    <Button variant="primary" onClick={closeIt}>
      {t('common.close')}
    </Button>
  )

  return (
    <Modal open onClose={closeIt} title={t('filing.title')} subtitle={notice ? t('rls.who', { role: t(`role.${notice.role}`), person: notice.appointee }) : undefined} size="md" footer={footer}>
      {!notice ? (
        model.notices.status === 'loading' ? (
          <p className="fw-hs-muted" role="status">
            <Spinner size={14} /> {t('common.reading')}
          </p>
        ) : (
          <p>{t(model.notices.status === 'error' ? model.notices.problem : 'filing.notFound')}</p>
        )
      ) : (
        <div className="fw-hs-stack">
          {state.saved && <Banner tone="success" title={t(state.saved)} />}
          {state.problem && !state.problem.field && <Banner tone="danger" title={problemText(t, state.problem)} />}
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('rls.col.site'), value: notice.site?.name ?? t('site.whole') },
              { label: t('filing.appointed'), value: day(notice.appointedFrom) },
              { label: t('rls.col.due'), value: noticeToConfirm(notice) ? t('rls.dueToConfirm', { date: day(notice.dueOn) }) : t('rls.dueOn', { date: day(notice.dueOn) }) },
              { label: t('filing.status'), value: <Pill tone={notice.status === 'FILED' ? 'success' : notice.status === 'PENDING' ? 'info' : 'neutral'}>{t(`noticeStatus.${notice.status}`)}</Pill> },
              ...(notice.status === 'FILED' ? [{ label: t('filing.filedOn'), value: day(notice.filedOn), hint: notice.filedBy ? t('filing.filedBy', { person: notice.filedBy }) : undefined }, { label: t('filing.reference'), value: notice.reference ?? '—' }] : []),
              ...(notice.status === 'CANCELLED' ? [{ label: t('filing.cancelled'), value: day(notice.cancelledAt), hint: notice.cancelReason ?? undefined }] : []),
            ]}
          />
          <p className="fw-hs-muted">{t('rls.manual')}</p>
          {state.step === 'due' ? (
            <Field label={t('filing.dueOn')} hint={t('filing.dueHint')} error={error('dueOn')}>
              <DateField value={state.draft.dueOn} onChange={(dueOn) => actions?.onFilingDraft?.({ ...state.draft, dueOn })} ariaLabel={t('filing.dueOn')} />
            </Field>
          ) : state.step === 'cancel' ? (
            <Field label={t('filing.cancelReason')} required error={error('reason')}>
              <Textarea value={state.draft.cancelReason} rows={3} onChange={(event) => actions?.onFilingDraft?.({ ...state.draft, cancelReason: event.target.value })} />
            </Field>
          ) : (
            <>
              {pending && (
                <div className="fw-hs-form-row">
                  <Field label={t('filing.filedOn')} required hint={t('filing.filedHint')} error={error('filedOn')}>
                    <DateField value={state.draft.filedOn} onChange={(filedOn) => actions?.onFilingDraft?.({ ...state.draft, filedOn })} max={model.today} ariaLabel={t('filing.filedOn')} />
                  </Field>
                  <Field label={t('filing.reference')} required hint={t('filing.referenceHint')} error={error('reference')}>
                    <Input value={state.draft.reference} maxLength={100} onChange={(event) => actions?.onFilingDraft?.({ ...state.draft, reference: event.target.value })} />
                  </Field>
                </div>
              )}
              {notice.status !== 'CANCELLED' && (
                <section className="fw-hs-stack" aria-labelledby="fw-hs-receipt">
                  <h3 id="fw-hs-receipt" className="fw-hs-h3">
                    {t('filing.receipt')}
                  </h3>
                  {notice.receipt ? (
                    <FileRow
                      name={notice.receipt.name}
                      status={t('filing.receiptOnFile')}
                      actions={
                        <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(notice.receipt!.fileId)}>
                          {t('common.open')}
                        </Button>
                      }
                    />
                  ) : (
                    <p className="fw-hs-muted">{t('filing.noReceipt')}</p>
                  )}
                  {canUpload ? (
                    <>
                      <FileDropzone onFiles={(files) => actions?.onReceipt?.(files)} accept={ACCEPT.RlsNotice} maxBytes={25 * 1024 * 1024} disabled={state.uploading} hint={t('filing.receiptHint')} />
                      {state.uploading && (
                        <p className="fw-hs-muted" role="status">
                          <Spinner size={14} /> {t('common.uploading')}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="fw-hs-muted">{t(canManage ? 'held.upload' : 'held.organisation')}</p>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
