'use client'

import Link from 'next/link'
import { CheckCircle2, FileSpreadsheet, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'
import { hideListLineWords, NAMESPACE } from '../../daily-model'
import type { HideListActions, HideListModel } from '../../daily-state'
import '../../receipts-daily.css'

/**
 * The tannery's hide list (B-W2a-63 on B-W2a-31; design rc-hides "W2a: Import the tannery's hide list (ImportFlow,
 * totals compared with PO and invoice, SCM-248)"): the band's Import hide list opens the ONE import wizard of Admin ›
 * Import & export on importer `inventory.hideList` (upload → the dry run, nothing written → apply what was seen → the
 * result; one list = one order = ONE receipt). After the wizard, the list's totals per order line against what the line
 * expects with its tolerance, and the receipt the apply made. A list is an import of a delivery (W1 receipts are posted in
 * one go: there is no open receipt to add hides to), so it lives on the list, beside Receive goods. Views only.
 */
export function HideListImport({ model, actions }: { model: HideListModel; actions?: HideListActions }) {
  const t = useT(NAMESPACE)
  return (
    <>
      <Button size="sm" heldReason={model.held ? t(model.held.key, model.held.params as Record<string, string | number> | undefined) : null} onClick={() => actions?.onOpen?.()}>
        <FileSpreadsheet size={14} aria-hidden /> {t('hideList.action')}
      </Button>
      {model.sheet && <SheetImportDialog model={model.sheet} actions={actions?.wizard} inline={model.inline} />}
    </>
  )
}

export function HideListTotals({ model, actions, prefix }: { model: HideListModel; actions?: HideListActions; prefix: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const summary = model.summary
  if (!summary) return null
  const value = summary.part.value
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h2 className="fw-by-h3">{t('hideList.title')}</h2>
          <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.()}>
            {t('common.dismiss')}
          </Button>
        </div>
        {!value ? (
          summary.part.problem ? (
            <EmptyState title={t('hideList.failed')} description={t(summary.part.problem)} action={<Button size="sm" onClick={() => actions?.onRetrySummary?.()}>{t('common.retry')}</Button>} />
          ) : (
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('hideList.loading')}
            </p>
          )
        ) : (
          <>
            <p className="fw-by-text">
              {t(`hideList.status.${value.status}`)}{' '}
              {value.order && (
                <>
                  {t('hideList.forOrder')}{' '}
                  <Link className="fw-by-link" href={`${prefix}/purchasing/orders/${value.order.id}`}>
                    {value.order.number}
                  </Link>
                </>
              )}
            </p>
            <p className="fw-by-hint">{t('hideList.counts', { rows: value.counts.rows, toReceive: value.counts.toReceive, before: value.counts.receivedBefore, errors: value.counts.errors })}</p>
            {value.receipt ? (
              <Banner
                tone="success"
                title={t('hideList.received', { number: value.receipt.number })}
                action={
                  <Button size="sm" asChild>
                    <Link href={`${prefix}/warehouse/receipts/${value.receipt.id}?tab=lots`}>{t('hideList.openReceipt', { number: value.receipt.number })}</Link>
                  </Button>
                }
              />
            ) : value.status === 'PLANNED' ? (
              <Banner tone="info" title={t('hideList.notYet')} />
            ) : null}
            {value.lines.length > 0 && (
              <ul className="fw-rcd-totals" aria-label={t('hideList.linesLabel')}>
                {value.lines.map((line) => {
                  const said = hideListLineWords(line)
                  const unit = t(`uom.${line.baseUom}`)
                  const fine = !line.needsReason
                  return (
                    <li key={line.purchaseOrderLineId} className="fw-rcd-total">
                      <span className="fw-by-card-head">
                        <b>{t('hideList.line', { seq: line.seq, code: line.itemCode })}</b>
                        <Pill tone={line.kind === 'OVER' ? (line.needsReason ? 'danger' : 'warning') : line.kind === 'SHORT' ? 'warning' : 'success'}>{t(`hideList.kind.${line.kind}`)}</Pill>
                      </span>
                      <span className="fw-by-text">{t('hideList.brings', { hides: line.hides, lots: line.lots, area: quantity(line.baseArea, locale), unit })}</span>
                      <span className="fw-by-cell-sub">{t('hideList.against', { before: quantity(line.receivedBefore, locale), after: quantity(line.after, locale), expected: quantity(line.expected, locale), upTo: quantity(line.upTo, locale), pct: line.tolerancePct, unit })}</span>
                      <span className="fw-by-inline">
                        {fine ? <CheckCircle2 size={14} className="fw-by-ico is-ok" aria-hidden /> : <XCircle size={14} className="fw-by-ico is-blocked" aria-hidden />}
                        <span className="fw-by-hint">{t(said.key, said.params as Record<string, string | number> | undefined)}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="fw-by-hint">{t('hideList.invoiceNote')}</p>
          </>
        )}
      </div>
    </Card>
  )
}
