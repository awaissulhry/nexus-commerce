'use client'

import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Bell, Check, ExternalLink, FileUp, RotateCcw, X } from 'lucide-react'
import { Button, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { DateField, DetailModal, Textarea, Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { CheckList } from '../../../../quality/_shared/parts'
import { ValidityBar } from '../../../_shared/validity/ValidityBar'
import { DEPTH_NAMESPACE } from '../../substances/frame/parts'
import { FileChooser } from '../../view/parts'
import type { DeclarationDetail, DeclarationRequest } from '../api'
import {
  acceptHeld,
  activityOf,
  answerHeld,
  askAgainHeld,
  cancelHeld,
  decisionChecks,
  LINE_TONE,
  lineAnswerKey,
  linesHeld,
  previewHeld,
  refuseHeld,
  refuseReasonProblem,
  remindHeld,
  RECORD_TABS,
  type Held,
  type RecordTab,
} from '../model'
import type { AnswerDraft, DeclarationsViewModel, LineDraft, RecordModel, VerbDialog } from '../view-model'
import { DueWords, KindWords, ShownPill } from './parts'

export interface RecordActions {
  onOpen?: (id: string | null, tab?: RecordTab) => void
  onTab?: (tab: RecordTab) => void
  onRetryRecord?: () => void
  onRemind?: (ids: readonly string[]) => void
  onDialog?: (dialog: VerbDialog | null) => void
  onPreview?: (request: DeclarationRequest) => void
  onLinesStart?: () => void
  onLinesChange?: (lines: readonly LineDraft[]) => void
  onLinesSave?: () => void
  onLinesCancel?: () => void
  onAnswerStart?: () => void
  onAnswerFile?: (file: File) => void
  onAnswerChange?: (draft: AnswerDraft) => void
  onAnswerSave?: () => void
  onAnswerCancel?: () => void
  onTakeUpload?: () => void
  onValidTo?: (day: string) => void
  onReason?: (text: string) => void
  onAccept?: (andNext: boolean) => void
  onRefuse?: () => void
}

type Words = (key: string, params?: Record<string, string | number>) => string
const said = (t: Words, reason: Held | null): string | null => (reason ? t(reason.key, reason.params as Record<string, string | number> | undefined) : null)

/**
 * The Supplier declaration (design compliance.tests rec "Supplier declaration", opens as a DetailModal: reviewed in sequence,
 * `?view=declarations&open=<id>&tab=request|answer|decision|activity`; J / K walk the list's rows): Request — what we asked,
 * of whom, by when, the reminders; Answer — the supplier's file in the PdfViewer, the Candidate List version, the validity,
 * and the answer per material (written here while it is open); Decision — what must be true (CheckList), Accept (and next)
 * with the validity or Reject with the reason the supplier reads, the ValidityBar once accepted; Activity — the request's
 * history from its own facts (DS Timeline). Every verb held says why. Fetches nothing.
 */
export function RecordModal({ model, record, rowIds, actions }: { model: DeclarationsViewModel; record: RecordModel; rowIds: readonly string[]; actions?: RecordActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const value = record.read.value
  const detail = value?.request ?? null
  const tab = model.address.tab
  const can = { ...model.can, manage: model.can.manage && (value?.mayManage ?? true) }
  const index = rowIds.indexOf(record.id)
  const tabs = RECORD_TABS.map((id) => ({
    id,
    label: t(`record.tab.${id}`),
    count: id === 'answer' && detail && detail.status === 'ANSWERED' ? detail.lines - detail.answeredLines || null : null,
  }))
  const remind = detail ? said(t, remindHeld(detail, can, model.online)) : null
  const accept = detail ? said(t, acceptHeld(detail, can, model.online)) : null
  const primary =
    detail && (detail.status === 'SENT' || detail.status === 'OVERDUE') ? (
      <Button size="sm" variant="primary" heldReason={remind ?? (model.busy ? q('common.loading') : null)} onClick={() => actions?.onRemind?.([detail.id])}>
        <Bell size={14} aria-hidden /> {t('record.remind')}
      </Button>
    ) : detail && detail.status === 'ANSWERED' ? (
      <Button size="sm" variant="primary" heldReason={accept ?? (model.busy ? q('common.loading') : null)} onClick={() => (tab === 'decision' ? actions?.onAccept?.(true) : actions?.onTab?.('decision'))}>
        <Check size={14} aria-hidden /> {tab === 'decision' ? t('decision.acceptNext') : t('record.toDecision')}
      </Button>
    ) : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={detail ? `${detail.number} · ${detail.party.name}` : t('record.title')}
      subtitle={detail ? t('record.subtitle', { kind: t(`kind.${detail.kind}`), count: detail.materials.length }) : undefined}
      meta={detail ? <span className="fw-q-tags"><ShownPill shown={detail.shown} /><Tag tone="neutral">{t(`channel.${detail.channel}`)}</Tag></span> : undefined}
      actions={primary}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(next) => actions?.onTab?.(next as RecordTab)}
      tabsLabel={t('record.tabsLabel')}
      nav={index >= 0 ? { ids: rowIds, current: record.id, onGo: (id) => actions?.onOpen?.(id, tab), noun: t('record.noun') } : undefined}
      loading={record.read.value === null && !record.read.problem}
      error={record.read.problem ? q(record.read.problem) : undefined}
      onRetry={actions?.onRetryRecord}
    >
      {detail && (
        <div className="fw-q-stack">
          {record.problem && <Banner tone="danger" title={t(record.problem)} />}
          {tab === 'request' && <RequestTab detail={detail} model={model} actions={actions} />}
          {tab === 'answer' && <AnswerTab detail={detail} record={record} model={model} actions={actions} />}
          {tab === 'decision' && <DecisionTab detail={detail} record={record} model={model} actions={actions} />}
          {tab === 'activity' && <ActivityTab detail={detail} />}
        </div>
      )}
    </DetailModal>
  )
}

function RequestTab({ detail, model, actions }: { detail: DeclarationDetail; model: DeclarationsViewModel; actions?: RecordActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const can = model.can
  const reminders = detail.reminderEveryDays === null ? t('record.reminderNever') : t('record.reminderEvery', { count: detail.reminderEveryDays })
  return (
    <>
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('record.supplier'), value: `${detail.party.code} · ${detail.party.name}` },
          { label: t('record.kind'), value: <KindWords request={detail} />, hint: t(`kindWhat.${detail.kind}`) },
          { label: t('record.channel'), value: t(`channel.${detail.channel}`), hint: t(`channelHint.${detail.channel}`) },
          { label: t('record.sent'), value: formatDateTime(detail.sentAt, { locale }) },
          { label: t('record.due'), value: <DueWords request={detail} /> },
          { label: t('record.reminders'), value: t('record.remindersSent', { count: detail.remindersSent }), hint: `${reminders}${detail.lastRemindedAt ? ` · ${t('record.lastReminded', { at: formatDateTime(detail.lastRemindedAt, { locale }) })}` : ''}` },
          ...(detail.supersedes ? [{ label: t('record.supersedes'), value: detail.supersedes.number }] : []),
          ...(detail.supersededBy ? [{ label: t('record.supersededBy'), value: detail.supersededBy.number }] : []),
        ]}
      />
      {detail.message && (
        <div className="fw-mt-quote">
          <span className="fw-q-hint">{t('record.message')}</span>
          <p>{detail.message}</p>
        </div>
      )}
      <SummaryTable
        label={t('record.materials')}
        columns={[t('record.col.article'), t('record.col.material'), t('record.col.answer')]}
        rows={detail.lineRows.map((line) => ({
          id: line.id,
          cells: [line.articleLabel, `${line.item.code} · ${line.item.name}`, <Pill key="a" tone={LINE_TONE(line)}>{t(lineAnswerKey(line))}</Pill>],
        }))}
      />
      <div className="fw-q-actions fw-mt-verbs">
        <Button size="sm" heldReason={said(t, askAgainHeld(detail, can, model.online))} onClick={() => actions?.onDialog?.({ kind: 'askAgain', id: detail.id, dueOn: '', reminderEveryDays: detail.reminderEveryDays === null ? '' : String(detail.reminderEveryDays), message: detail.message ?? '' })}>
          <RotateCcw size={14} aria-hidden /> {t('row.askAgain')}
        </Button>
        <Button size="sm" variant="danger-outline" heldReason={said(t, cancelHeld(detail, can, model.online))} onClick={() => actions?.onDialog?.({ kind: 'cancel', id: detail.id, reason: '' })}>
          <X size={14} aria-hidden /> {t('row.cancel')}
        </Button>
        <Button size="sm" variant="quiet" heldReason={said(t, previewHeld(detail, can))} onClick={() => actions?.onPreview?.(detail)}>
          <ExternalLink size={14} aria-hidden /> {t('row.preview')}
        </Button>
      </div>
    </>
  )
}

const ANSWERS = ['', 'none', 'below', 'above'] as const

function AnswerTab({ detail, record, model, actions }: { detail: DeclarationDetail; record: RecordModel; model: DeclarationsViewModel; actions?: RecordActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const locale = useLocale()
  const shell = useT('shell')
  const can = model.can
  const answerReason = said(t, answerHeld(detail, can, model.online))
  const linesReason = said(t, linesHeld(detail, can, model.online))
  const waiting = detail.status === 'SENT' || detail.status === 'OVERDUE'
  return (
    <>
      {!detail.file && (
        <Banner tone={waiting ? 'info' : 'warning'} title={t(waiting ? (detail.channel === 'PORTAL' ? 'answer.waitPortal' : 'answer.waitOffice') : 'answer.none')}>
          {waiting && detail.channel === 'PORTAL' && <span>{t('answer.waitPortalHint')}</span>}
        </Banner>
      )}
      {waiting && record.answer === null && (
        <div className="fw-q-actions fw-mt-verbs">
          {detail.channel === 'OFFICE' ? (
            <Button size="sm" variant="primary" heldReason={answerReason} onClick={() => actions?.onAnswerStart?.()}>
              <FileUp size={14} aria-hidden /> {t('answer.record')}
            </Button>
          ) : (
            <Button size="sm" heldReason={answerReason} onClick={() => actions?.onTakeUpload?.()}>
              <FileUp size={14} aria-hidden /> {t('answer.takeUpload')}
            </Button>
          )}
        </div>
      )}
      {record.answer && (
        <div className="fw-mt-panel">
          <FileChooser name={record.answer.fileName} onFile={(file) => actions?.onAnswerFile?.(file)} accept=".pdf" label={t('answer.file')} hint={t('answer.fileHint')} />
          <Field label={t('answer.validTo')} hint={t('answer.validToHint')}>
            <DateField value={record.answer.validTo} onChange={(value) => actions?.onAnswerChange?.({ ...record.answer!, validTo: value })} clearable ariaLabel={t('answer.validTo')} />
          </Field>
          <div className="fw-q-actions">
            <Button size="sm" onClick={() => actions?.onAnswerCancel?.()}>{q('common.close')}</Button>
            <Button size="sm" variant="primary" heldReason={record.answer.fileName ? (model.busy ? q('common.loading') : null) : t('answer.fileNeeded')} onClick={() => actions?.onAnswerSave?.()}>
              {t('answer.save')}
            </Button>
          </div>
        </div>
      )}
      {detail.file && (
        <KeyValue
          columns={3}
          labelCase="sentence"
          items={[
            { label: t('answer.answeredAt'), value: detail.answeredAt ? formatDateTime(detail.answeredAt, { locale }) : '—' },
            { label: t('answer.from'), value: detail.upload ? t('answer.fromUpload', { name: detail.upload.uploadedByName }) : t('answer.fromOffice') },
            { label: t('answer.validTo'), value: detail.validTo ? formatDate(detail.validTo, { locale }) : t('answer.noEnd') },
            ...(detail.kind === 'REACH_SVHC' ? [{ label: t('answer.listVersion'), value: (detail.answeredListVersion ?? detail.svhcListVersion) ? formatDate((detail.answeredListVersion ?? detail.svhcListVersion)!.publishedOn, { locale }) : '—', hint: detail.newestListVersion ? t('answer.newestList', { day: formatDate(detail.newestListVersion.publishedOn, { locale }) }) : undefined }] : []),
            ...(detail.upload ? [{ label: t('answer.document'), value: t(`upload.${detail.upload.status === 'ACCEPTED' || detail.upload.status === 'REFUSED' || detail.upload.status === 'WAITING' ? detail.upload.status : 'OTHER'}`), hint: [detail.upload.issuer, detail.upload.documentNumber].filter(Boolean).join(' · ') || undefined }] : []),
          ]}
        />
      )}
      <div className="fw-mt-section-head">
        <h3>{t('answer.lines')}</h3>
        {record.lines === null && (
          <Button size="sm" heldReason={linesReason} onClick={() => actions?.onLinesStart?.()}>
            {t('answer.linesEdit')}
          </Button>
        )}
      </div>
      {record.lines === null ? (
        <SummaryTable
          label={t('answer.lines')}
          columns={[t('record.col.article'), t('record.col.answer'), t('answer.col.substance'), t('answer.col.concentration')]}
          rows={detail.lineRows.map((line) => ({
            id: line.id,
            cells: [
              line.articleLabel,
              <Pill key="a" tone={LINE_TONE(line)}>{t(lineAnswerKey(line))}</Pill>,
              line.substance ? `${line.substance.name}${line.substance.casNumber ? ` (${line.substance.casNumber})` : ''}` : (line.substanceName ?? '—'),
              line.concentration ? `${line.concentration}${line.concentrationUnit ? ` ${t(`unit.${line.concentrationUnit}`)}` : ''}` : '—',
            ],
          }))}
        />
      ) : (
        <LinesEditor detail={detail} lines={record.lines} busy={model.busy} actions={actions} />
      )}
      {record.pdf && (record.pdf.value ? (
        <PdfViewer src={record.pdf.value} title={t('answer.pdfTitle', { number: detail.number })} fileName={`${detail.number}.pdf`} labels={pdfViewerLabels(shell)} height="min(55vh, 620px)" />
      ) : record.pdf.problem ? (
        <Banner tone="warning" title={t('answer.pdfFailed')} />
      ) : (
        <p className="fw-q-hint" role="status">{q('common.loading')}</p>
      ))}
    </>
  )
}

function LinesEditor({ detail, lines, busy, actions }: { detail: DeclarationDetail; lines: readonly LineDraft[]; busy: boolean; actions?: RecordActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const change = (lineId: string, patch: Partial<LineDraft>) => actions?.onLinesChange?.(lines.map((line) => (line.lineId === lineId ? { ...line, ...patch } : line)))
  const unchanged = lines.every((draft) => {
    const line = detail.lineRows.find((row) => row.id === draft.lineId)
    return line && draft.answer === (line.contains === null ? '' : !line.contains ? 'none' : line.aboveThreshold ? 'above' : 'below') && draft.substanceName === (line.substanceName ?? line.substance?.name ?? '') && draft.concentration === (line.concentration ?? '')
  })
  return (
    <div className="fw-mt-panel">
      {lines.map((draft) => {
        const line = detail.lineRows.find((row) => row.id === draft.lineId)
        if (!line) return null
        return (
          <div key={draft.lineId} className="fw-mt-line">
            <span className="fw-q-cell">
              <span className="fw-q-code">{line.articleLabel}</span>
              <span className="fw-q-hint">{t(`kind.${detail.kind}`)}</span>
            </span>
            <Field label={t('record.col.answer')}>
              <Select value={draft.answer} onChange={(event) => change(draft.lineId, { answer: event.target.value as LineDraft['answer'] })} aria-label={t('answer.lineFor', { article: line.articleLabel })}>
                {ANSWERS.map((answer) => (
                  <option key={answer} value={answer}>
                    {t(answer === '' ? 'line.open' : `line.${answer}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {(draft.answer === 'below' || draft.answer === 'above') && (
              <>
                <Field label={t('answer.col.substance')}>
                  <Input size="sm" value={draft.substanceName} maxLength={300} onChange={(event) => change(draft.lineId, { substanceName: event.target.value })} />
                </Field>
                <Field label={t('answer.col.concentration')} hint={detail.kind === 'REACH_SVHC' ? t('answer.concentrationSvhc') : undefined}>
                  <Input size="sm" inputMode="decimal" value={draft.concentration} maxLength={24} onChange={(event) => change(draft.lineId, { concentration: event.target.value })} />
                </Field>
              </>
            )}
          </div>
        )
      })}
      <div className="fw-q-actions">
        <Button size="sm" onClick={() => actions?.onLinesCancel?.()}>{q('common.close')}</Button>
        <Button size="sm" variant="primary" heldReason={unchanged ? t('answer.linesSame') : busy ? q('common.loading') : null} onClick={() => actions?.onLinesSave?.()}>
          {t('answer.linesSave')}
        </Button>
      </div>
    </div>
  )
}

function DecisionTab({ detail, record, model, actions }: { detail: DeclarationDetail; record: RecordModel; model: DeclarationsViewModel; actions?: RecordActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const locale = useLocale()
  const can = model.can
  const checks = decisionChecks(detail)
  const accept = said(t, acceptHeld(detail, can, model.online))
  const refuse = said(t, refuseHeld(detail, can, model.online))
  const reasonProblem = refuseReasonProblem(record.reason)
  const decided = detail.status === 'ACCEPTED' || detail.status === 'REFUSED'
  return (
    <>
      <CheckList
        label={t('decision.checks')}
        checks={checks.map((check) => ({ id: check.id, state: check.state === 'OK' ? 'OK' : 'OPEN', name: t(`decision.name.${check.id}`), text: t(check.key, check.params as Record<string, string | number> | undefined), fix: null }))}
      />
      {decided && (
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('decision.decided'), value: t(detail.status === 'ACCEPTED' ? 'decision.acceptedBy' : 'decision.refusedBy', { name: detail.decidedBy?.name ?? '—' }), hint: detail.decidedAt ? formatDateTime(detail.decidedAt, { locale }) : undefined },
            ...(detail.status === 'REFUSED' ? [{ label: t('decision.reason'), value: detail.refuseReason ?? '—' }] : []),
          ]}
        />
      )}
      {detail.status === 'ACCEPTED' && (detail.validTo ? <ValidityBar from={(detail.decidedAt ?? detail.answeredAt ?? detail.sentAt).slice(0, 10)} to={detail.validTo} today={model.today} label={t('decision.validity')} /> : <p className="fw-q-hint">{t('decision.noEnd')}</p>)}
      {detail.status === 'ANSWERED' && (
        <div className="fw-mt-decide">
          <div className="fw-mt-panel">
            <h3>{t('decision.acceptTitle')}</h3>
            <Field label={t('answer.validTo')} hint={detail.upload?.expiresOn ? t('decision.validToUpload', { day: formatDate(detail.upload.expiresOn, { locale }) }) : t('decision.validToHint')}>
              <DateField value={record.validTo} onChange={(value) => actions?.onValidTo?.(value)} clearable ariaLabel={t('answer.validTo')} />
            </Field>
            {detail.channel === 'PORTAL' && detail.upload?.status === 'WAITING' && <p className="fw-q-hint">{t('decision.uploadFirst')}</p>}
            <div className="fw-q-actions">
              <Button size="sm" heldReason={accept ?? (model.busy ? q('common.loading') : null)} onClick={() => actions?.onAccept?.(false)}>
                {t('decision.accept')}
              </Button>
              <Button size="sm" variant="primary" heldReason={accept ?? (model.busy ? q('common.loading') : null)} onClick={() => actions?.onAccept?.(true)}>
                <Check size={14} aria-hidden /> {t('decision.acceptNext')}
              </Button>
            </div>
          </div>
          <div className="fw-mt-panel">
            <h3>{t('decision.refuseTitle')}</h3>
            <Field label={t('decision.reason')} hint={t('decision.reasonHint')}>
              <Textarea rows={3} value={record.reason} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
            </Field>
            <div className="fw-q-actions">
              <Button size="sm" variant="danger" heldReason={refuse ?? (reasonProblem ? t(reasonProblem) : model.busy ? q('common.loading') : null)} onClick={() => actions?.onRefuse?.()}>
                {t('decision.refuse')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {(detail.status === 'SENT' || detail.status === 'OVERDUE') && <p className="fw-q-hint">{t('decision.notYet')}</p>}
      {detail.status === 'CANCELLED' && <p className="fw-q-hint">{t('decision.cancelled', { reason: detail.cancelReason ?? '—' })}</p>}
    </>
  )
}

function ActivityTab({ detail }: { detail: DeclarationDetail }) {
  const t = useT(DEPTH_NAMESPACE)
  const steps = activityOf(detail)
  return (
    <>
      <Timeline
        label={t('activity.label')}
        steps={steps.map((step) => ({ key: step.id, label: t(step.key, step.params as Record<string, string | number> | undefined), at: step.pending ? null : (step.at ?? undefined), tone: step.tone }))}
      />
      <p className="fw-q-hint">{t('activity.fromFacts')}</p>
    </>
  )
}
