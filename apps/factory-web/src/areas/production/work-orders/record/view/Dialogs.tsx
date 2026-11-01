'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Printer, XCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { correctHold, onlyMaterialShort, quantityText, REPRINT_REASONS, type ReprintReason } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'

const reasonLength = (text: string, min: number, max: number) => {
  const length = text.trim().length
  return length >= min && length <= max
}

/**
 * The work order studio's dialogs: Release (design wo-release-confirm; a short material only with the planner's reason),
 * Start / Complete / Close (a confirm with what it does), Cancel (a reason; what was issued or cut goes back by hand),
 * Correct a cut entry (a reason; the mirror entry; a closing cut opens its hide again) and Reprint N tickets (the reason,
 * the label printer; a new code each). Esc closes; the focus returns to the opener (DS Modal).
 */
export function RecordDialogs({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'release':
      return <ReleaseDialog workOrder={workOrder} model={model} actions={actions} />
    case 'move':
      return <MoveDialog workOrder={workOrder} move={dialog.move} model={model} actions={actions} />
    case 'cancel':
      return <CancelDialog workOrder={workOrder} model={model} actions={actions} />
    case 'correct':
      return <CorrectDialog entryId={dialog.entryId} model={model} actions={actions} />
    case 'reprint':
      return <ReprintDialog bundleIds={dialog.bundleIds} model={model} actions={actions} />
    default:
      return null
  }
}

function ReleaseDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const material = onlyMaterialShort(model.check.value)
  const [override, setOverride] = useState(model.draft?.override ?? false)
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const needsReason = material
  const reasonOk = reasonLength(reason, 3, 500)
  const held = model.busy ? t('held.busy') : needsReason && !override ? t('release.overrideNeeded') : needsReason && !reasonOk ? t('release.reasonShort') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('release.title', { number: workOrder.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onRelease?.(needsReason ? reason.trim() : null)} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('release.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onRelease?.(needsReason ? reason.trim() : null)
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            actions?.onRelease?.(needsReason ? reason.trim() : null)
          }
        }}
      >
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
        <p>{t('release.body', { revision: workOrder.revision?.revision ?? '—' })}</p>
        <ul className="fw-pr-list">
          <li>{t('release.reachCells', { count: workOrder.cells.length, pieces: workOrder.pieces })}</li>
          <li>{t('release.reachOps', { count: workOrder.spec.operations.length })}</li>
          <li>{t('release.reachMaterials', { count: workOrder.spec.materials.length })}</li>
        </ul>
        <p className="fw-pr-hint">{t('release.reversal')}</p>
        {material && (
          <>
            <Banner tone="warning" title={t('release.short')} />
            <Checkbox checked={override} onChange={(event) => setOverride(event.target.checked)} label={t('release.override')} />
            {override && (
              <Field label={t('release.reason')} hint={t('release.reasonHint')} error={reason.length > 0 && !reasonOk ? t('release.reasonShort') : undefined}>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
              </Field>
            )}
          </>
        )}
      </form>
    </Modal>
  )
}

function MoveDialog({ workOrder, move, model, actions }: { workOrder: WorkOrder; move: 'start' | 'complete' | 'close'; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`move.${move}.title`, { number: workOrder.number })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onMove?.(move)}>
            {model.busy ? <Spinner size={12} /> : null} {t(`step.${move}`)}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
        <p>{t(`move.${move}.body`)}</p>
      </div>
    </Modal>
  )
}

function CancelDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const ok = reasonLength(reason, 1, 500)
  const started = workOrder.status !== 'DRAFT'
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('cancel.title', { number: workOrder.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('cancel.keep')}
          </Button>
          <Button size="sm" variant="danger" heldReason={model.busy ? t('held.busy') : !ok ? t('cancel.reasonNeeded') : null} onClick={() => actions?.onCancel?.(reason.trim())}>
            {model.busy ? <Spinner size={12} /> : null} {t('cancel.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
        <p>{t(started ? 'cancel.bodyStarted' : 'cancel.bodyDraft')}</p>
        <Field label={t('cancel.reason')} required>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function CorrectDialog({ entryId, model, actions }: { entryId: string; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const log = model.cutLog.value
  const entry = log?.entries.find((row) => row.id === entryId) ?? null
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  if (!log || !entry) return null
  const hold = correctHold(entry, log, model.can)
  const ok = reasonLength(reason, 3, 500)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('correct.title', { hide: entry.hideCode })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={hold ? t(`cutting.hold.${hold}`) : model.busy ? t('held.busy') : !ok ? t('correct.reasonShort') : null} onClick={() => actions?.onCorrect?.(entry.id, reason.trim())}>
            {model.busy ? <Spinner size={12} /> : null} {t('correct.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
        <p>{t('correct.body', { area: quantityText(entry.baseAreaUsed, locale), pieces: entry.pieces.reduce((sum, piece) => sum + piece.pieces, 0) })}</p>
        {entry.closing && <Banner tone="info" title={t('correct.closing')} />}
        <p className="fw-pr-hint">{t('correct.bundles')}</p>
        <Field label={t('correct.reason')} hint={t('correct.reasonHint')} required error={reason.length > 0 && !ok ? t('correct.reasonShort') : undefined}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function ReprintDialog({ bundleIds, model, actions }: { bundleIds: string[]; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const bundles = (model.bundles.value?.bundles ?? []).filter((bundle) => bundleIds.includes(bundle.id))
  const printers = model.printers?.value ?? null
  const [choice, setChoice] = useState<ReprintReason>(model.draft?.reason ? 'other' : 'lost')
  const [other, setOther] = useState(model.draft?.reason ?? '')
  const [printerId, setPrinterId] = useState<string>('')
  useEffect(() => {
    if (!printerId && printers) setPrinterId(printers.defaultPrinterId ?? printers.printers[0]?.id ?? '')
  }, [printers, printerId])
  const run = model.reprint
  const reason = choice === 'other' ? other.trim() : t(`reprint.reason.${choice}`)
  const reasonOk = reasonLength(reason, 3, 200)
  const held = !model.can.printLabels
    ? t('reprint.noPrintRight')
    : model.printers === null || (!printers && !model.printers.problem)
      ? t('held.checking')
      : !printers || printers.printers.length === 0
        ? t('reprint.noPrinter')
        : !printerId
          ? t('reprint.choosePrinter')
          : !reasonOk
            ? t('reprint.reasonShort')
            : run?.running
              ? t('held.busy')
              : null
  const done = run?.done ?? false
  return (
    <Modal
      open
      onClose={() => (run?.running ? undefined : actions?.onCloseReprint?.())}
      title={t('reprint.title', { count: bundles.length })}
      size="md"
      footer={
        done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onCloseReprint?.()}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseReprint?.()} heldReason={run?.running ? t('held.busy') : null}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onReprint?.(bundles.map((bundle) => bundle.id), reason, printerId)}>
              {run?.running ? <Spinner size={12} /> : <Printer size={13} aria-hidden />} {t('reprint.go', { count: bundles.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pr-dialog">
        <p>{t('reprint.body')}</p>
        {!done && (
          <>
            <fieldset className="fw-pr-list">
              <legend className="fw-pr-h3">{t('reprint.why')}</legend>
              {[...REPRINT_REASONS, 'other' as const].map((value) => (
                <RadioCard key={value} variant="row" name="fw-pr-reprint-reason" checked={choice === value} selected={choice === value} onChange={() => setChoice(value)} title={t(`reprint.reason.${value}`)} />
              ))}
            </fieldset>
            {choice === 'other' && (
              <Field label={t('reprint.otherLabel')} error={other.length > 0 && !reasonOk ? t('reprint.reasonShort') : undefined}>
                <Textarea value={other} onChange={(event) => setOther(event.target.value)} rows={2} maxLength={200} />
              </Field>
            )}
            {model.printers?.problem && <Banner tone="danger" title={t(model.printers.problem)} />}
            {printers && printers.printers.length > 0 && (
              <Field label={t('reprint.printer')}>
                <Select value={printerId} onChange={(event) => setPrinterId(event.target.value)}>
                  {printers.printers.map((printer) => (
                    <option key={printer.id} value={printer.id}>
                      {printer.code} · {printer.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {printers && printers.printers.length === 0 && <Banner tone="warning" title={t('reprint.noPrinter')} />}
          </>
        )}
        <ul className="fw-pr-checks" aria-live="polite">
          {bundles.map((bundle) => {
            const result = run?.results[bundle.id]
            return (
              <li key={bundle.id} className="fw-pr-check">
                {result?.state === 'done' ? <CheckCircle2 size={16} className="fw-pr-ico is-ok" aria-hidden /> : result ? <XCircle size={16} className="fw-pr-ico is-blocked" aria-hidden /> : <Printer size={16} className="fw-pr-ico" aria-hidden />}
                <span className="fw-pr-check-body">
                  <span className="fw-pr-code">{bundle.code}</span>
                  {result?.state === 'done' && <span>{t('reprint.done', { code: result.code })}</span>}
                  {result?.state === 'failed' && <span>{t(result.words.key, result.words.params)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
