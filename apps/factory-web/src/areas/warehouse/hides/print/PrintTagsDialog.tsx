'use client'

import { FileDown, Printer, RotateCcw } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { Button, NumberStepper, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import type { HideRow } from '../../../_shared/stock/api'
import { useWords } from '../../lots/shared/parts'
import { hideLabel, jobMoving, printHeldKey, printStateOf, tagLayout, type PrintActions, type PrintDialog } from '../model'

const JOB_TONE = { QUEUED: 'neutral', SENT: 'info', PRINTED: 'success', FAILED: 'danger' } as const

/**
 * Print hide tags (design hd-tags): the HIDE label as it prints (DS LabelPreview: the tag as Code 128, the article,
 * colour, grade, area, thickness and lot), the site's label printer and the copies, or — when the site has no label
 * printer — the tags as a PDF in the browser; then each tag's print job with its state (queued, sent, printed, failed +
 * Retry). A part of the Hides list and the hide record (it fetches nothing: the page owns the dialog's state).
 */
export function PrintTagsDialog({ dialog, hides, actions }: { dialog: PrintDialog; hides: readonly HideRow[]; actions?: PrintActions }) {
  const t = useWords()
  const locale = useLocale()
  const unit = (uom: HideRow['areaUom']) => t(`stock:uom.${uom}`)
  const first = hides[0] ?? null
  const layout = first ? tagLayout(hideLabel(first, locale, unit), t('hd.print.labelName', { code: first.code })) : null
  const held = printHeldKey(dialog)
  const printers = dialog.printers.value
  const noPrinter = printers !== null && printers.length === 0
  const sent = dialog.prints !== null
  const moving = dialog.prints?.some((print) => jobMoving(print.job)) ?? false
  const firstJob = dialog.prints?.[0]?.job ?? null

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('hd.print.title', { count: hides.length })}
      size="md"
      footer={
        <>
          {!sent && printers !== null && printers.length > 0 && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onPdf?.()} heldReason={dialog.busy ? t('hd.print.busy') : null}>
              <FileDown size={14} aria-hidden /> {t('hd.print.pdf')}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {sent ? t('rec.close') : t('stock:common.cancel')}
          </Button>
          {!sent &&
            (noPrinter || dialog.printers.problem ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onPdf?.()} heldReason={dialog.busy ? t('hd.print.busy') : null}>
                {dialog.busy && <Spinner size={12} />} <FileDown size={14} aria-hidden /> {t('hd.print.pdfCount', { count: hides.length })}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => actions?.onPrint?.()} heldReason={held ? t(held) : null}>
                {dialog.busy && <Spinner size={12} />} <Printer size={14} aria-hidden /> {t('hd.print.confirm', { count: hides.length })}
              </Button>
            ))}
        </>
      }
    >
      <div className="fw-wl-stack">
        {layout ? (
          <LabelPreview layout={layout} scale={3} print={printStateOf(firstJob, (status) => t(`hd.print.status.${status}`))} codeLabel={(value) => t('hd.print.codeLabel', { code: value })} invalidCodeLabel={(value) => t('hd.print.invalidCode', { code: value })} />
        ) : (
          first && <Banner tone="warning" title={t('hd.print.notPrintable', { code: first.code })} />
        )}
        {hides.length > 1 && <p className="fw-wl-hint">{t('hd.print.andMore', { count: hides.length - 1 })}</p>}

        {!sent && (
          <>
            {printers === null && !dialog.printers.problem && (
              <p className="fw-wl-hint" role="status">
                <Spinner size={14} /> {t('hd.print.loadingPrinters')}
              </p>
            )}
            {dialog.printers.problem && <Banner tone="warning" title={t('hd.print.printersFailed')}>{t(`stock:${dialog.printers.problem}`)}</Banner>}
            {noPrinter && <Banner tone="info" title={t('hd.print.noPrinter')}>{t('hd.print.noPrinterBody')}</Banner>}
            {printers !== null && printers.length > 0 && (
              <div className="fw-wl-fields">
                <Field label={t('hd.print.printer')}>
                  <Select size="sm" value={dialog.printerId ?? ''} onChange={(event) => actions?.onPrinter?.(event.target.value || null)}>
                    <option value="">{t('hd.print.choose')}</option>
                    {printers.map((printer) => (
                      <option key={printer.id} value={printer.id}>
                        {`${printer.code} · ${printer.name}`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('hd.print.copies')} hint={t('hd.print.copiesHint')}>
                  <NumberStepper size="sm" value={dialog.copies} min={1} max={5} onChange={(next) => actions?.onCopies?.(next)} decrementLabel={t('hd.print.less')} incrementLabel={t('hd.print.more')} />
                </Field>
              </div>
            )}
          </>
        )}

        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.startsWith('hd.') ? dialog.problem : `stock:${dialog.problem}`)} />}

        {dialog.prints && (
          <div className="fw-wl-stack tight">
            <p className="fw-wl-text">{moving ? t('hd.print.sending') : t('hd.print.done')}</p>
            <ul className="fw-wl-print-jobs" aria-label={t('hd.print.jobsLabel')}>
              {dialog.prints.map((print) => (
                <li key={print.hideId} className="fw-wl-print-job">
                  <span className="fw-wl-code">{print.code}</span>
                  <span className="fw-st-inline">
                    {print.job ? <Pill tone={JOB_TONE[print.job.status]}>{t(`hd.print.status.${print.job.status}`)}</Pill> : <Pill tone="danger">{t('hd.print.status.REFUSED')}</Pill>}
                    {print.problem && <span className="fw-st-sub">{t(print.problem.startsWith('hd.') ? print.problem : `stock:${print.problem}`)}</span>}
                    {print.job?.status === 'FAILED' && (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.(print.job!.id)}>
                        <RotateCcw size={13} aria-hidden /> {t('hd.print.retry')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
