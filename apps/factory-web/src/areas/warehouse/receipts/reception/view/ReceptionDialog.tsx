'use client'

import { useMemo } from 'react'
import { ClipboardCheck, Send } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { dayAt, quantity, type Phrase } from '../../../../_shared/buying/model'
import type { ReceptionReport } from '../api'
import { choiceCounts, demandLabel, NAMESPACE, reserveHeld, rowHeld, sendHeld, serveRows, type ServeRow } from '../model'
import '../reception.css'

/**
 * SCR-379 — the Reception report (B-W2b-300; design warehouse.receipts pop:rc-reception "which work orders and orders these goods
 * serve (SCM-119); allocate in one step (reservations)"; action "Reserve for 3 work orders"), opened from the receipt's ⋯. Per
 * line of a posted receipt: what came and what of it is free now (a lot in quarantine is not, until released), then on the
 * list frame every work order and order it serves — the plan's pegging first, then the open work orders that need the material —
 * with what each still needs, what of this receipt is reserved for it already, and what to reserve now. The rows with something
 * to take are chosen; a row that may not be chosen says why on its box. "Reserve for N work orders" makes the reservations in
 * one step and (with "Tell the buyer") sends the report to the purchase order's buyer as an internal note naming them; "Send to
 * the buyer" sends it alone. Held buttons say why. Quantities in the material's stock unit; no money, no customer's name.
 */

export type ReportLoad = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: ReceptionReport }

export interface ReceptionDialogModel {
  readonly report: ReportLoad
  readonly chosen: readonly string[]
  readonly tellBuyer: boolean
  readonly note: string
  readonly busy: boolean
  readonly problem: Phrase | null
  /** After a reserve or a send: what was done. */
  readonly done: { readonly reserved: number; readonly skipped: number; readonly told: boolean | null } | null
  readonly timeZone: string
}

export interface ReceptionDialogActions {
  onClose?: () => void
  onChoose?: (ids: string[]) => void
  onTellBuyer?: (on: boolean) => void
  onNote?: (text: string) => void
  onReserve?: () => void
  onSend?: () => void
  onRetry?: () => void
}

const unitOf = (t: Translate, uom: string) => {
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

export function ReceptionDialog({ model, actions, number }: { model: ReceptionDialogModel; actions?: ReceptionDialogActions; number: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const report = model.report.status === 'ready' ? model.report.value : null
  const rows = useMemo(() => serveRows(report), [report])
  const counts = choiceCounts(rows, model.chosen)
  const reserveWhy = reserveHeld(report, rows, model.chosen, model.busy)
  const sendWhy = sendHeld(report, model.busy)
  const amount = (value: string, uom: string) => `${quantity(value, locale)} ${unitOf(t, uom)}`

  const columns = useMemo<ColDef<ServeRow>[]>(() => {
    const Line = ({ data }: ICellRendererParams<ServeRow>) => (data ? <span className="fw-rc-cell">{`${data.line.seq} · ${data.line.item.code}${data.line.colour ? ` ${data.line.colour.code}` : ''}`}</span> : null)
    // What it is and why it is listed (the plan pegged it, or it needs the material), in one cell: the dialog's width.
    const For = ({ data }: ICellRendererParams<ServeRow>) =>
      data ? (
        <span className="fw-rc-cell">
          <strong>{demandLabel(data.serve)}</strong>
          <span className="fw-rc-sub">
            {t(`reception.kind.${data.serve.kind}`)} · <Tag tone={data.serve.why === 'PEGGED' ? 'info' : 'neutral'}>{t(`reception.why.${data.serve.why}`)}</Tag>
          </span>
        </span>
      ) : null
    const Need = ({ data }: ICellRendererParams<ServeRow>) => (data ? <span>{data.serve.needDate ? formatDate(dayAt(data.serve.needDate), place) : '—'}</span> : null)
    const Qty = (field: 'open' | 'reservedHere' | 'proposed') =>
      function QuantityCell({ data }: ICellRendererParams<ServeRow>) {
        return data ? <span className={field === 'proposed' && Number(data.serve.proposed) > 0 ? 'fw-rc-strong' : undefined}>{amount(data.serve[field], data.line.item.baseUom)}</span> : null
      }
    const Held = ({ data }: ICellRendererParams<ServeRow>) => {
      if (!data) return null
      const why = rowHeld(data)
      return why ? <span className="fw-rc-sub">{t(why)}</span> : <Pill tone="success">{t('reception.col.ready')}</Pill>
    }
    return [
      { colId: 'line', headerName: t('reception.col.line'), minWidth: 140, flex: 1, cellRenderer: Line },
      { colId: 'for', headerName: t('reception.col.for'), minWidth: 190, flex: 1.3, cellRenderer: For },
      { colId: 'need', headerName: t('reception.col.need'), minWidth: 105, flex: 0.6, cellRenderer: Need },
      { colId: 'open', headerName: t('reception.col.open'), minWidth: 105, flex: 0.6, type: 'rightAligned', cellRenderer: Qty('open') },
      { colId: 'here', headerName: t('reception.col.here'), minWidth: 110, flex: 0.6, type: 'rightAligned', cellRenderer: Qty('reservedHere') },
      { colId: 'proposed', headerName: t('reception.col.proposed'), minWidth: 105, flex: 0.6, type: 'rightAligned', cellRenderer: Qty('proposed') },
      { colId: 'state', headerName: t('reception.col.state'), minWidth: 150, flex: 1, cellRenderer: Held },
    ]
    // The cells read the words and the locale; rows change with the report.
  }, [t, locale, model.timeZone])

  const reserveLabel = counts.workOrders > 0 && counts.orders === 0 ? t('reception.reserve.workOrders', { count: counts.workOrders }) : counts.orders > 0 && counts.workOrders === 0 ? t('reception.reserve.orders', { count: counts.orders }) : t('reception.reserve.demands', { count: counts.workOrders + counts.orders })

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('reception.title', { number })}
      subtitle={t('reception.subtitle')}
      size="xxl"
      footer={
        <>
          {report?.buyer ? <Checkbox checked={model.tellBuyer} onChange={(event) => actions?.onTellBuyer?.(event.target.checked)} label={t('reception.tellBuyer', { name: report.buyer.name })} disabled={model.busy || !report.can.send} /> : <span className="fw-rc-sub">{t('reception.noBuyer')}</span>}
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('reception.close')}
          </Button>
          <Button size="sm" heldReason={sendWhy ? t(sendWhy) : null} onClick={() => actions?.onSend?.()}>
            <Send size={13} aria-hidden /> {t('reception.send')}
          </Button>
          <Button size="sm" variant="primary" heldReason={reserveWhy ? t(reserveWhy) : null} onClick={() => actions?.onReserve?.()}>
            {model.busy ? <Spinner size={12} /> : <ClipboardCheck size={13} aria-hidden />} {reserveLabel}
          </Button>
        </>
      }
    >
      <div className="fw-rc">
        {model.report.status === 'loading' ? (
          <p className="fw-rc-sub" role="status">
            <Spinner size={14} /> {t('reception.loading')}
          </p>
        ) : model.report.status === 'error' ? (
          <EmptyState title={t('reception.failed')} description={t(model.report.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('reception.retry')}</Button>} />
        ) : report!.held ? (
          <Banner tone="info" title={t(`reception.report.${report!.held}`)} />
        ) : (
          <>
            {model.problem ? <Banner tone="danger" title={t(model.problem.key, model.problem.params)} /> : null}
            {model.done ? <Banner tone="success" title={t('reception.done', { count: model.done.reserved })}>{[model.done.skipped > 0 ? t('reception.doneSkipped', { count: model.done.skipped }) : null, model.done.told === true ? t('reception.doneTold') : model.done.told === false ? t('reception.doneNotTold') : null].filter(Boolean).join(' ')}</Banner> : null}
            <KeyValue
              items={[
                { label: t('reception.fact.order'), value: report!.receipt.purchaseOrder?.number ?? '—' },
                { label: t('reception.fact.buyer'), value: report!.buyer?.name ?? t('reception.noBuyerShort') },
                { label: t('reception.fact.plan'), value: report!.run?.finishedAt ? t('reception.fact.planAt', { time: formatDateTime(report!.run.finishedAt, place) }) : t('reception.fact.noPlan') },
              ]}
            />
            <ul className="fw-rc-lines" aria-label={t('reception.linesLabel')}>
              {report!.lines.map((line) => (
                <li key={line.receiptLineId} className="fw-rc-line">
                  <strong>{`${line.seq} · ${line.item.code}${line.colour ? ` ${line.colour.code}` : ''}`}</strong>
                  <span>{t('reception.line.received', { amount: amount(line.received, line.item.baseUom) })}</span>
                  {line.lots.map((lot, index) => (
                    <Tag key={lot.id ?? `free-${index}`} tone={lot.held ? 'warning' : 'neutral'}>
                      {lot.held ? t('reception.line.lotHeld', { lot: lot.code ?? '—' }) : lot.code ? t('reception.line.lotFree', { lot: lot.code, amount: amount(lot.free, line.item.baseUom) }) : t('reception.line.free', { amount: amount(lot.free, line.item.baseUom) })}
                    </Tag>
                  ))}
                  <span className="fw-rc-sub">{t('reception.line.left', { amount: amount(line.left, line.item.baseUom) })}</span>
                </li>
              ))}
            </ul>
            <ListFrame<ServeRow>
              label={t('reception.tableLabel')}
              listKey={null}
              rows={rows}
              rowId={(row) => row.id}
              columns={columns}
              count={t('reception.count', { count: rows.length })}
              isRowSelectable={(row) => {
                const why = rowHeld(row)
                return why ? t(why) : null
              }}
              selection={{
                selected: model.chosen,
                onChange: (ids) => actions?.onChoose?.(ids),
                actions: (
                  <Button size="sm" variant="primary" heldReason={reserveWhy ? t(reserveWhy) : null} aria-label={reserveLabel} onClick={() => actions?.onReserve?.()}>
                    <ClipboardCheck size={13} aria-hidden /> <SelectionLabel>{reserveLabel}</SelectionLabel>
                  </Button>
                ),
              }}
              state={rows.length === 0 ? <EmptyState title={t('reception.empty.title')} description={t('reception.empty.body')} /> : undefined}
            />
            <Field label={t('reception.note')} hint={t('reception.noteHint')}>
              <Textarea rows={2} honourRows maxLength={500} value={model.note} onChange={(event) => actions?.onNote?.(event.target.value)} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
