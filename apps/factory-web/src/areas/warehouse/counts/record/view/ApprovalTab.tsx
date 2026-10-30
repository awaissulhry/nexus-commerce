'use client'

import { CheckCheck, Download, ExternalLink, FileSpreadsheet, FileText, ShieldCheck, Stamp, Undo2 } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CountRecord } from '../../api'
import { approvalState, heldPhrase } from '../../model'
import { CheckList, Money, say, useWords, type CheckState } from '../../parts'
import type { CountRecordActions, CountRecordModel } from '../../view-model'

/**
 * Count › Approval (design warehouse.counts/rec:Count/approval, cn-approval "Approval and apply"): the count's steps as a
 * check list (stand-in for the design's ReadinessChecklist) — every line counted, the recounts done, every difference with
 * its reason, submitted, approved (over the limit by a person who counted none of the lines that differ: SCM-229,
 * SCM-293), applied (one COUNT move per difference), and for the year-end inventory the sign-off that freezes the valued
 * list (c.c. art. 2217) — beside the figures (lines, differences, their value and the limit: cost grain only) and the
 * decision (who approved or sent back, when, the note). The steps' buttons are here too, held with their reason. A
 * signed-off inventory shows its frozen files (stand-in for the design's IssuedDocumentCard).
 */
export function ApprovalTab({ value, model, actions }: { value: CountRecord; model: CountRecordModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const when = (at: string | null) => (at ? formatDateTime(at, place) : null)
  const by = (name: string | null, at: string | null) => (at ? t('approval.byAt', { name: name ?? t('record.someone'), time: when(at)! }) : null)
  const summary = value.summary
  const started = value.status !== 'DRAFT' && value.status !== 'CANCELLED'
  const submitted = value.submittedAt !== null
  const decision = approvalState(value)
  const yearEnd = value.kind === 'YEAR_END'
  const state = (done: boolean, open: boolean): CheckState => (done ? 'done' : open ? 'open' : 'skipped')

  const items = [
    {
      id: 'counted',
      state: state(started && summary.uncounted === 0, started),
      title: t('approval.check.counted'),
      detail: started ? t('approval.check.countedDetail', { counted: summary.counted, all: summary.lines }) : t('approval.check.notStarted'),
    },
    {
      id: 'recounts',
      state: state(started && summary.recountsDue === 0, started),
      title: t('approval.check.recounts'),
      detail: summary.recountsDue > 0 ? t('approval.check.recountsDue', { count: summary.recountsDue }) : t('approval.check.recountsNone'),
    },
    {
      id: 'reasons',
      state: state(started && summary.unreasoned === 0, started),
      title: t('approval.check.reasons'),
      detail: summary.unreasoned > 0 ? t('approval.check.unreasoned', { count: summary.unreasoned }) : t('approval.check.reasonsDone', { count: summary.differing }),
    },
    { id: 'submitted', state: state(submitted, value.status === 'COUNTING'), title: t('approval.check.submitted'), detail: by(value.people.submittedBy, value.submittedAt) ?? t('approval.check.notYet') },
    {
      id: 'approved',
      state: (value.approvedAt ? 'done' : decision === 'notNeeded' ? 'skipped' : submitted ? 'open' : 'skipped') as CheckState,
      title: t('approval.check.approved'),
      detail:
        decision === 'withApply'
          ? t('approval.withApply', { name: value.people.approvedBy ?? t('record.someone') })
          : value.approvedAt
            ? by(value.people.approvedBy, value.approvedAt)
            : decision === 'notNeeded'
              ? t('approval.notNeeded')
              : decision === 'waiting'
                ? t('approval.waiting')
                : t('approval.check.notYet'),
    },
    {
      id: 'applied',
      state: state(value.appliedAt !== null, value.status === 'APPROVED' || (value.status === 'SUBMITTED' && !value.approvalRequired)),
      title: t('approval.check.applied'),
      detail: value.appliedAt ? `${by(value.people.appliedBy, value.appliedAt)} · ${t('approval.moves', { count: summary.differing })}` : t('approval.applyWhat'),
    },
    ...(yearEnd
      ? [
          {
            id: 'signedOff',
            state: state(value.signedOffAt !== null, value.status === 'APPLIED'),
            title: t('approval.check.signedOff'),
            detail: value.signedOffAt ? by(value.people.signedOffBy, value.signedOffAt) : t('approval.signOffWhat'),
          },
        ]
      : []),
  ]
  if (value.status === 'CANCELLED') items.push({ id: 'cancelled', state: 'failed', title: t('approval.check.cancelled'), detail: value.cancelReason ?? '' })

  const approveHeld = say(t, heldPhrase(value, 'approve', model.can))
  const applyHeld = say(t, heldPhrase(value, 'apply', model.can))
  const sendBackHeld = say(t, heldPhrase(value, 'sendBack', model.can))
  const signOffHeld = say(t, heldPhrase(value, 'signOff', model.can))
  const busy = model.busy ? t('held.busy') : null

  return (
    <div className="fw-cn-split">
      <div className="fw-cn-stack">
        <Card padded>
          <div className="fw-cn-stack tight">
            <h3 className="fw-cn-h3">{t('approval.steps')}</h3>
            <CheckList items={items} />
          </div>
        </Card>

        <Card padded>
          <div className="fw-cn-stack tight">
            <h3 className="fw-cn-h3">{t('approval.decision')}</h3>
            {decision === 'waiting' && <Banner tone="warning" title={value.approval.mayApprove ? t('approval.youMay') : (say(t, heldPhrase(value, 'approve', model.can)) ?? '')} />}
            {decision === 'sentBack' && (
              <Banner tone="warning" title={t('approval.sentBack', { name: value.people.rejectedBy ?? t('record.someone'), time: when(value.rejectedAt) ?? '—' })}>
                {value.rejectReason ?? undefined}
              </Banner>
            )}
            <KeyValue
              items={[
                { label: t('approval.approver'), value: value.people.approvedBy ?? '—' },
                { label: t('approval.when'), value: when(value.approvedAt) ?? '—' },
                { label: t('approval.note'), value: value.approvalNote ?? '—' },
                { label: t('approval.required'), value: value.approval.required ? t('approval.requiredYes') : t('approval.requiredNo') },
              ]}
            />
            <span className="fw-cn-actions">
              {(value.status === 'SUBMITTED' && value.approvalRequired) || value.status === 'COUNTING' ? (
                <Button size="sm" variant="primary" heldReason={approveHeld ?? busy} onClick={() => actions?.onDialog?.({ kind: 'approve', note: '' })}>
                  <ShieldCheck size={14} aria-hidden /> {t('step.approve')}
                </Button>
              ) : null}
              {value.status === 'SUBMITTED' && (
                <Button size="sm" heldReason={sendBackHeld ?? busy} onClick={() => actions?.onDialog?.({ kind: 'sendBack', reason: '', recount: summary.recountSuggested > 0 })}>
                  <Undo2 size={14} aria-hidden /> {t('record.sendBack')}
                </Button>
              )}
              {['SUBMITTED', 'APPROVED'].includes(value.status) && (
                <Button size="sm" variant={value.status === 'APPROVED' || !value.approvalRequired ? 'primary' : 'secondary'} heldReason={applyHeld ?? busy} onClick={() => actions?.onDialog?.({ kind: 'apply' })}>
                  <CheckCheck size={14} aria-hidden /> {t('step.apply', { count: summary.differing })}
                </Button>
              )}
            </span>
            <p className="fw-cn-hint">{t('approval.reversal')}</p>
          </div>
        </Card>
      </div>

      <div className="fw-cn-stack">
        <Card padded>
          <div className="fw-cn-stack tight">
            <h3 className="fw-cn-h3">{t('approval.figures')}</h3>
            <KeyValue
              items={[
                { label: t('approval.lines'), value: t('list.lines', { counted: summary.counted, all: summary.lines }) },
                { label: t('approval.differing'), value: String(summary.differing) },
                ...(model.can.cost && summary.differenceAmount !== undefined
                  ? [
                      { label: t(submitted ? 'approval.value' : 'approval.valueNow'), value: <Money minor={summary.differenceAmount} currency={value.currency} /> },
                      ...(value.approval.limitAmount !== undefined ? [{ label: t('approval.limit'), value: <Money minor={value.approval.limitAmount} currency={value.currency} /> }] : []),
                    ]
                  : []),
                ...(summary.unvalued > 0 ? [{ label: t('approval.unvalued'), value: t('approval.unvaluedCount', { count: summary.unvalued }) }] : []),
                { label: t('approval.suggested'), value: String(summary.recountSuggested) },
                ...(summary.movedSinceSnapshot > 0 ? [{ label: t('approval.moved'), value: String(summary.movedSinceSnapshot) }] : []),
              ]}
            />
            {!model.can.cost && <p className="fw-cn-hint">{t('approval.noCost')}</p>}
            <p className="fw-cn-hint">{t('approval.rule')}</p>
          </div>
        </Card>

        {yearEnd && (
          <Card padded>
            <div className="fw-cn-stack tight">
              <h3 className="fw-cn-h3">
                {t('valued.title')} {value.inventoryDate && <Tag tone="info">{formatDate(value.inventoryDate, place)}</Tag>}
              </h3>
              {value.valuedList ? (
                <>
                  <div className="fw-cn-file">
                    <span className="fw-cn-file-text">
                      <span className="fw-cn-text">
                        <FileText size={14} aria-hidden /> {t('valued.frozenTitle', { number: value.number })}
                      </span>
                      <span className="fw-cn-hint">{by(value.people.signedOffBy, value.signedOffAt) ?? ''}</span>
                    </span>
                    <span className="fw-cn-actions">
                      <Button size="sm" heldReason={model.can.files ? null : t('held.noFiles')} onClick={() => actions?.onValuedFile?.(value.valuedList!.pdfFileId)}>
                        <ExternalLink size={13} aria-hidden /> {t('valued.pdf')}
                      </Button>
                      {value.valuedList.sheetFileId && (
                        <Button size="sm" heldReason={model.can.files ? null : t('held.noFiles')} onClick={() => actions?.onValuedFile?.(value.valuedList!.sheetFileId!)}>
                          <FileSpreadsheet size={13} aria-hidden /> {t('valued.xlsx')}
                        </Button>
                      )}
                    </span>
                  </div>
                  <p className="fw-cn-hint">{t('valued.kept')}</p>
                </>
              ) : (
                <>
                  <p className="fw-cn-hint">{t(value.status === 'APPLIED' ? 'valued.ready' : 'valued.notYet')}</p>
                  <span className="fw-cn-actions">
                    {value.status === 'APPLIED' && (
                      <Button size="sm" variant="primary" heldReason={signOffHeld ?? busy} onClick={() => actions?.onDialog?.({ kind: 'signOff', phrase: '', language: locale === 'en' ? 'en' : 'it' })}>
                        <Stamp size={14} aria-hidden /> {t('step.signOff')}
                      </Button>
                    )}
                    {['SUBMITTED', 'APPROVED', 'APPLIED'].includes(value.status) && (
                      <>
                        <Button size="sm" heldReason={model.can.cost ? null : t('held.noCostPreview')} onClick={() => actions?.onValuedPreview?.('pdf')}>
                          <ExternalLink size={13} aria-hidden /> {t('valued.previewPdf')}
                        </Button>
                        <Button size="sm" heldReason={model.can.cost ? null : t('held.noCostPreview')} onClick={() => actions?.onValuedPreview?.('xlsx')}>
                          <Download size={13} aria-hidden /> {t('valued.previewXlsx')}
                        </Button>
                      </>
                    )}
                  </span>
                </>
              )}
              <p className="fw-cn-hint">{t('valued.law')}</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
