'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { LabelDetail, LabelIssue } from '../../api'
import { jobSettled, newestRevision, printStateOf, sheetSize, testPrintHeld } from '../../model'
import { LabelSheet } from '../../view/parts'
import type { LabelRecordActions, LabelRecordModel, RecordDialog } from '../../view-model'
import { ChecksList } from './PreviewPanel'

/**
 * The label record's dialogs: Activate (design lb-activate: the approval — every rule check passes, then the frozen-from-
 * now words), Retire (the reach: style revisions naming it can no longer release a work order; released ones keep it),
 * New revision (a copy, revision N+1, a draft), Print test label (lb-test: the printer, the copies, the sample garment,
 * the label marked TEST with the job's state and Retry), and Discard (the unsaved changes go). Nothing here fetches.
 */
export function RecordDialogs({ detail, model, actions, activation }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; activation: readonly LabelIssue[] }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  if (dialog.kind === 'activate') return <ActivateDialog detail={detail} model={model} actions={actions} activation={activation} onClose={close} />
  if (dialog.kind === 'retire') return <RetireDialog detail={detail} model={model} actions={actions} dialog={dialog} onClose={close} />
  if (dialog.kind === 'revise') return <ReviseDialog detail={detail} model={model} actions={actions} onClose={close} />
  if (dialog.kind === 'test') return <TestDialog detail={detail} model={model} actions={actions} dialog={dialog} onClose={close} />
  if (dialog.kind === 'discard') return <DiscardDialog actions={actions} onClose={close} />
  return null
}

function Problem({ model }: { model: LabelRecordModel }) {
  const t = useT('labels')
  if (!model.problem) return null
  return (
    <Banner tone="danger" title={t(model.problem.key)}>
      {model.problem.lines && model.problem.lines.length > 0 && (
        <ul className="fw-q-lines" lang="en">
          {model.problem.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

function ActivateDialog({ detail, model, actions, activation, onClose }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; activation: readonly LabelIssue[]; onClose: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  const held = !model.can.manage ? t('held.noManage') : activation.length > 0 ? t('held.problems', { count: activation.length }) : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('activate.title', { code: detail.code, revision: detail.revision })}
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onActivate?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('activate.confirm', { revision: detail.revision })}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <p>{t('activate.intro')}</p>
        <ChecksList problems={activation} warnings={detail.warnings} />
        <Banner tone="info" title={t('activate.frozen', { next: detail.revision + 1 })}>
          {t('activate.workOrders')}
        </Banner>
        {detail.revisions.some((entry) => entry.status === 'ACTIVE' && entry.id !== detail.id) && <p className="fw-q-hint">{t('activate.olderActive')}</p>}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RetireDialog({ detail, model, actions, dialog, onClose }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; dialog: Extract<RecordDialog, { kind: 'retire' }>; onClose: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  const released = detail.usage.styleRevisions.filter((entry) => entry.status === 'RELEASED')
  const held = !model.can.manage ? t('held.noManage') : dialog.reason.trim().length > 500 ? t('held.long') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('retire.title', { code: detail.code, revision: detail.revision })}
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => actions?.onRetire?.(dialog.reason)}>
            {model.busy ? <Spinner size={12} /> : null} {t('retire.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <ul className="fw-q-lines">
          <li>{t('retire.reach')}</li>
          <li>{released.length > 0 ? t('retire.released', { count: released.length, styles: released.map((entry) => `${entry.styleCode} r${entry.revision}`).join(', ') }) : t('retire.noReleased')}</li>
          <li>{t('retire.kept')}</li>
          <li>{t('retire.back')}</li>
        </ul>
        <Field label={t('retire.reason')} hint={t('retire.reasonHint')}>
          <Textarea rows={2} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'retire', reason: event.target.value })} />
        </Field>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function ReviseDialog({ detail, model, actions, onClose }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; onClose: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  const next = newestRevision(detail) + 1
  const held = !model.can.manage ? t('held.noManage') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('revise.title', { code: detail.code, revision: next })}
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onRevise?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('revise.confirm', { revision: next })}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <p>{t('revise.intro', { revision: detail.revision, next })}</p>
        <p className="fw-q-hint">{t('revise.keeps')}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function DiscardDialog({ actions, onClose }: { actions?: LabelRecordActions; onClose: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('discard.title')}
      footer={
        <>
          <Button onClick={onClose}>{q('common.cancel')}</Button>
          <Button variant="danger" onClick={() => actions?.onDiscard?.()}>
            {t('discard.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('discard.intro')}</p>
    </Modal>
  )
}

function TestDialog({ detail, model, actions, dialog, onClose }: { detail: LabelDetail; model: LabelRecordModel; actions?: LabelRecordActions; dialog: Extract<RecordDialog, { kind: 'test' }>; onClose: () => void }) {
  const t = useT('labels')
  const q = useT('quality')
  const locale = useLocale()
  const printers = (model.printers.value ?? []).filter((printer) => printer.kind === 'LABEL_ZPL' && printer.status !== 'ARCHIVED')
  const printer = printers.find((entry) => entry.id === dialog.printerId) ?? null
  const base = testPrintHeld(model.can, model.printers.value === null ? null : printers)
  const sending = model.busy || (model.test.job !== null && !jobSettled(model.test.job))
  const held = base ? t(base.key, base.params) : !printer ? t('held.pickPrinter') : printer.status === 'PAUSED' ? t('held.printerPaused') : sending ? t('held.printing') : null
  const job = model.test.job
  const label = model.test.label ?? model.preview.value?.label ?? null
  const detailWords = job ? (job.status === 'FAILED' ? (job.lastError ?? t('test.failedDetail')) : t('test.detail', { printer: model.test.printer?.name ?? printer?.name ?? '—', time: formatTime(job.printedAt ?? job.sentAt ?? job.createdAt, { locale }) })) : undefined
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('test.title', { code: detail.code, revision: detail.revision })}
      footer={
        <>
          <Button onClick={onClose}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => printer && actions?.onTestPrint?.(printer.id, dialog.copies)}>
            {sending ? <Spinner size={12} /> : null} {job ? t('test.again') : t('test.print')}
          </Button>
        </>
      }
    >
      <div className="fw-lb-test">
        <div className="fw-q-form">
          <p className="fw-q-hint">{t('test.intro')}</p>
          {model.printers.problem ? (
            <Banner tone="warning" title={t('test.printersFailed')}>
              {q(model.printers.problem)}
            </Banner>
          ) : model.printers.value === null ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={12} /> {q('common.loading')}
            </p>
          ) : printers.length === 0 ? (
            <Banner tone="info" title={t('test.noPrinter')}>
              {t('test.noPrinterBody')}
            </Banner>
          ) : (
            <Field label={t('test.printer')} hint={printer ? t('test.printerHint', { dpi: printer.dpi ?? '—', width: printer.labelWidthMm ?? '—', height: printer.labelHeightMm ?? '—' }) : undefined}>
              <Select value={dialog.printerId ?? ''} onChange={(event) => actions?.onDialog?.({ ...dialog, printerId: event.target.value || null })}>
                <option value="">{t('test.pickPrinter')}</option>
                {printers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.code}
                    {entry.status === 'PAUSED' ? ` · ${t('test.paused')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('test.copies')} hint={t('test.copiesHint')}>
            <Input
              inputMode="numeric"
              value={String(dialog.copies)}
              onChange={(event) => {
                const copies = Math.min(10, Math.max(1, Number.parseInt(event.target.value.replace(/\D/g, '') || '1', 10)))
                actions?.onDialog?.({ ...dialog, copies })
              }}
            />
          </Field>
          <p className="fw-q-hint">{model.preview.value ? t('test.cell', { style: model.preview.value.cell.styleCode, colourway: model.preview.value.values.colourway?.code ?? '—', size: model.preview.value.cell.size ?? '—' }) : t('preview.cellDefault')}</p>
          <Problem model={model} />
        </div>
        {label ? (
          <LabelSheet
            label={label}
            widthMm={sheetSize(detail.widthMm, 50)}
            heightMm={sheetSize(detail.heightMm, 80)}
            test
            print={job ? printStateOf(job, (status) => t(`print.${status}`), detailWords) : undefined}
            onRetry={job?.status === 'FAILED' ? () => actions?.onRetryJob?.(job.id) : undefined}
            retryHeld={model.busy ? t('held.busy') : null}
            scale={3}
          />
        ) : (
          <p className="fw-q-hint">{t('preview.loading')}</p>
        )}
      </div>
    </Modal>
  )
}
