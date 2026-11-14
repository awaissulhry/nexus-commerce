'use client'

import { useState } from 'react'
import { Undo2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { COSTING_NAMESPACE, decimalText, moneyText } from '../../../../finance/costing/model'
import type { WorkOrder } from '../../../_shared/api'
import type { CloseCheck, CloseFigures, CloseReason, CloseRecord } from '../api'
import { CLOSE_NS, closedPhrase, closeHeld, FIGURES, NOTE_MAX, noteNeeded, REOPEN_MAX, reasonKey, reopenHeld, reopenOpenHeld, type Figure } from '../model'
import type { CloseActions, CloseModel } from '../use-close'

/**
 * SCR-460 — Close work order (design production.workorders pop:wo-close, "confirm", from the record's primary; MES-012,
 * MES-013) and what follows it on the record: planned against actual garments, material cost (the cost grain only),
 * standard minutes and scrap, each within or beyond the company's tolerance; a reason from the list when a figure is
 * beyond it (OTHER with words); what the close settles (the variance split and the closing entry while the company's
 * figures for the accountant are on) or "Waits for the accountant…" while they are off; Close held with its reason, never a
 * dead button. After it: Undo for a few seconds (paused while the pointer or the focus is on it), and on a closed work
 * order who closed it, why, and Reopen… with a reason. Esc closes a dialog; the focus returns to the opener (DS Modal).
 * Work order totals only: no figure about a person.
 */
export function CloseParts({ workOrder, model, actions }: { workOrder: WorkOrder; model: CloseModel; actions?: CloseActions }) {
  return (
    <WithMessages namespaces={[CLOSE_NS, COSTING_NAMESPACE]}>
      {model.dialog === 'close' && <CloseDialog workOrder={workOrder} model={model} actions={actions} />}
      {model.dialog === 'reopen' && <ReopenDialog workOrder={workOrder} model={model} actions={actions} />}
    </WithMessages>
  )
}

/** The band under the record's tabs: the Undo after a close, or a closed work order's close (who, when, why) with Reopen…. */
export function CloseBanners({ workOrder, model, actions }: { workOrder: WorkOrder; model: CloseModel; actions?: CloseActions }) {
  return (
    <WithMessages namespaces={[CLOSE_NS]}>
      {model.undo && <UndoBanner model={model} actions={actions} />}
      {workOrder.status === 'CLOSED' && !model.undo && <ClosedBanner model={model} actions={actions} />}
    </WithMessages>
  )
}

function figureCells(figure: Figure, figures: CloseFigures, t: (key: string, params?: Record<string, string | number>) => string, locale: ReturnType<typeof useLocale>): [string, string] {
  switch (figure) {
    case 'quantity':
      return [t('figure.garments', { count: figures.plannedQuantity }), t('figure.garments', { count: figures.actualQuantity })]
    case 'scrap':
      return [t('figure.garments', { count: figures.plannedScrapQuantity }), t('figure.garments', { count: figures.scrapQuantity })]
    case 'minutes':
      return [t('figure.minutes', { minutes: decimalText(figures.plannedMinutes, locale, 1) }), t('figure.minutes', { minutes: decimalText(figures.actualMinutes, locale, 1) })]
    case 'material':
      if (figures.plannedMaterialCost === undefined || figures.actualMaterialCost === undefined) return [t('figure.needsCost'), t('figure.needsCost')]
      return [moneyText(figures.plannedMaterialCost, figures.currency, locale), moneyText(figures.actualMaterialCost, figures.currency, locale)]
  }
}

/** Planned against actual, each figure within or beyond the tolerance (the dialog, and the close that stands on the Labour & cost tab). */
export function FiguresTable({ figures, beyond, tolerancePct }: Pick<CloseCheck, 'figures' | 'beyond' | 'tolerancePct'>) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  return (
    <SummaryTable
      label={t('figure.label')}
      columns={[t('figure.col.figure'), t('figure.col.planned'), t('figure.col.actual'), t('figure.col.tolerance', { tolerance: decimalText(tolerancePct, locale, 2) })]}
      align={[undefined, 'right', 'right', 'right']}
      stackOnPhone
      rows={FIGURES.map((figure) => {
        const [planned, actual] = figureCells(figure, figures, t, locale)
        return {
          id: figure,
          cells: [
            t(`figure.row.${figure}`),
            planned,
            actual,
            <Pill key="state" tone={beyond[figure] ? 'warning' : 'success'}>
              {t(beyond[figure] ? 'figure.beyond' : 'figure.within')}
            </Pill>,
          ],
        }
      })}
    />
  )
}

function CloseDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: CloseModel; actions?: CloseActions }) {
  const t = useT(CLOSE_NS)
  const tc = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  const check = model.check?.value ?? null
  const failed = model.check?.problem ?? null
  const [reason, setReason] = useState<CloseReason | null>(model.draft?.reason ?? null)
  const [note, setNote] = useState(model.draft?.note ?? '')
  const held = closeHeld(check, { reason, note }, model.busy)
  const heldWords = held ? t(held.key, held.params) : null
  const needsNote = check ? noteNeeded(check, reason) : false
  const submit = () => {
    if (!held) actions?.onClose?.({ reason, note })
  }
  const waitingCodes = check ? [...new Set(check.waiting.map((item) => item.code))] : []
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('dialog.title', { number: workOrder.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldWords} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('dialog.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        {!check && !failed && (
          <p className="fw-pr-hint" role="status">
            <Spinner size={14} /> {t('dialog.reading')}
          </p>
        )}
        {!check && failed && (
          <Banner
            tone="danger"
            title={t('dialog.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(failed)}
          </Banner>
        )}
        {check && (
          <>
            <p>{t('dialog.body')}</p>
            <FiguresTable figures={check.figures} beyond={check.beyond} tolerancePct={check.tolerancePct} />
            <p className="fw-pr-hint">{t('dialog.toleranceHint', { tolerance: decimalText(check.tolerancePct, locale, 2) })}</p>
            {check.figures.plannedMaterialCost === undefined && <p className="fw-pr-hint">{t('dialog.noCost')}</p>}
            {check.settles ? (
              <Banner tone={check.waiting.length > 0 ? 'warning' : 'info'} title={t(check.waiting.length > 0 ? 'settle.waitingTitle' : 'settle.title')}>
                {check.waiting.length > 0 ? (
                  <ul className="fw-pr-list">
                    {waitingCodes.map((code) => (
                      <li key={code}>{tc(`waiting.${code}`, { count: check.waiting.filter((item) => item.code === code).length })}</li>
                    ))}
                  </ul>
                ) : (
                  <>
                    {t('settle.body')} {check.toPost > 0 ? t('settle.toPost', { count: check.toPost }) : ''}
                  </>
                )}
              </Banner>
            ) : (
              <Banner tone="warning" title={t('waits.title')}>
                {t('waits.close')}
              </Banner>
            )}
            {check.reasonNeeded ? (
              <Field label={t('dialog.reason')} required hint={t('dialog.reasonHint')}>
                <Select size="sm" value={reason ?? ''} onChange={(event) => setReason((event.target.value || null) as CloseReason | null)}>
                  <option value="">{t('dialog.reasonPick')}</option>
                  {check.reasons.map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {t(reasonKey(entry.code))}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="fw-pr-hint">{t('dialog.noReason', { tolerance: decimalText(check.tolerancePct, locale, 2) })}</p>
            )}
            <Field label={t(needsNote ? 'dialog.noteNeeded' : 'dialog.note')} required={needsNote} hint={t('dialog.noteHint', { max: NOTE_MAX })}>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={NOTE_MAX} />
            </Field>
            <p className="fw-pr-hint">{t('dialog.undoHint')}</p>
          </>
        )}
      </form>
    </Modal>
  )
}

function ReopenDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: CloseModel; actions?: CloseActions }) {
  const t = useT(CLOSE_NS)
  const check = model.check?.value ?? null
  const [reason, setReason] = useState(model.draft?.reopenReason ?? '')
  const held = reopenHeld(check, reason, model.busy)
  const submit = () => {
    if (!held) actions?.onReopen?.(reason)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('reopen.title', { number: workOrder.number })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCancel?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('reopen.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <p>{t(check?.live?.settled ? 'reopen.bodySettled' : 'reopen.body')}</p>
        <Field label={t('reopen.reason')} required hint={t('reopen.reasonHint', { max: REOPEN_MAX })}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={REOPEN_MAX} />
        </Field>
      </form>
    </Modal>
  )
}

function UndoBanner({ model, actions }: { model: CloseModel; actions?: CloseActions }) {
  const t = useT(CLOSE_NS)
  const undo = model.undo!
  return (
    <div onMouseEnter={() => actions?.onHoldUndo?.(true)} onMouseLeave={() => actions?.onHoldUndo?.(false)} onFocus={() => actions?.onHoldUndo?.(true)} onBlur={() => actions?.onHoldUndo?.(false)}>
      <Banner
        tone="success"
        title={t(undo.settled ? 'undo.settled' : 'undo.closed', { number: undo.number })}
        action={
          <span className="fw-pr-inline">
            <Button size="sm" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onUndo?.()}>
              <Undo2 size={14} aria-hidden /> <span>{t('undo.go')}</span>
            </Button>
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissUndo?.()}>
              {t('common.dismiss')}
            </Button>
          </span>
        }
      >
        {undo.problem ? t(undo.problem.key, undo.problem.params) : t('undo.body')}
      </Banner>
    </div>
  )
}

function ClosedBanner({ model, actions }: { model: CloseModel; actions?: CloseActions }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const check = model.check?.value ?? null
  const live: CloseRecord | null = check?.live ?? null
  const reopen = reopenOpenHeld(check, model.busy)
  const action =
    model.check?.problem && !check ? (
      <Button size="sm" onClick={() => actions?.onRetry?.()}>
        {t('common.retry')}
      </Button>
    ) : (
      <Button size="sm" heldReason={reopen ? t(reopen.key, reopen.params) : null} onClick={() => actions?.onOpenReopen?.()}>
        {t('reopen.open')}
      </Button>
    )
  if (!live) {
    return (
      <Banner tone="info" title={t(check ? 'closed.noRecord' : model.check?.problem ? 'closed.failed' : 'closed.reading')} action={action}>
        {t('closed.final')}
      </Banner>
    )
  }
  const words = closedPhrase(live)
  return (
    <Banner tone="info" title={t(words.key, { date: formatDate(live.closedAt, { locale }), time: formatTime(live.closedAt, { locale }), name: live.closedBy.name })} action={action}>
      {live.reasonCode ? `${t('closed.reason', { reason: t(reasonKey(live.reasonCode)) })} ` : ''}
      {live.reasonNote ? `${t('closed.note', { note: live.reasonNote })} ` : ''}
      {t('closed.final')}
    </Banner>
  )
}
