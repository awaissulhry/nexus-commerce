'use client'

import Link from 'next/link'
import { ClipboardList, PackageX, UserPlus } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Radio, Select, Spinner } from '@nexus/ui/primitives'
import { hideAreasOf } from '@nexus/factory-domain/inventory/unplanned/rules'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { dayAt, quantity, type Phrase } from '../../../../_shared/buying/model'
import type { Unplanned } from '../api'
import { fitsOf, NAMESPACE, namingFor, namingHeld, sendBackHeld, type NamingDraft, type NamingLine } from '../model'
import '../reception.css'

/**
 * Goods without a PO on the receipt (B-W2b-300; SCM-122 "a buyer task asks for the PO or a return; nothing is used until a PO
 * names them"), part of SCR-063's record through SCR-379's slot: while they wait, a banner says where (the holding place), since
 * when, for whom (the buyer's task) and that nothing of it is used; "Name the purchase order" (the supplier's open orders to this
 * site, a line of the order per waiting line — the one that fits is picked — a lot-tracked line's supplier lot, a leather line's
 * hide areas one by one) posts the goods into the holding place in one step; "Send back" cancels the receipt with the reason.
 * Held buttons say why; no money.
 */

export type WaitingDialog = { readonly kind: 'name'; readonly draft: NamingDraft } | { readonly kind: 'back'; readonly reason: string }

export interface WaitingModel {
  readonly unplanned: Unplanned
  readonly dialog: WaitingDialog | null
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly prefix: string
  readonly timeZone: string
}

export interface WaitingActions {
  onDialog?: (dialog: WaitingDialog | null) => void
  onName?: () => void
  onSendBack?: () => void
  onAskBuyer?: () => void
}

const unitOf = (t: Translate, uom: string) => {
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** The banner of goods that wait (or what became of them), with its buttons. */
export function WaitingBanner({ model, actions }: { model: WaitingModel; actions?: WaitingActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { receipt, buyerTask, can } = model.unplanned
  if (receipt.state === 'SENT_BACK') return <Banner tone="neutral" icon={<PackageX size={16} aria-hidden />} title={t('waiting.sentBack')}>{receipt.note}</Banner>
  if (receipt.state === 'ORDER_NAMED') return <Banner tone="success" title={t('waiting.named', { order: receipt.purchaseOrder?.number ?? '—', place: receipt.holding?.code ?? '—' })} />
  const nameHeld = namingHeld(model.unplanned, { orderId: model.unplanned.orders[0]?.id ?? null, lines: {} }, model.busy)
  const noOrder = model.unplanned.orders.length === 0
  return (
    <Banner
      tone="warning"
      icon={<ClipboardList size={16} aria-hidden />}
      title={t('waiting.title', { place: receipt.holding?.code ?? '—', since: formatDateTime(receipt.receivedAt, place) })}
      action={
        <span className="fw-rc-actions">
          {can.askBuyer ? (
            <Button size="sm" onClick={() => actions?.onAskBuyer?.()} heldReason={model.busy ? t('waiting.held.busy') : null}>
              <UserPlus size={13} aria-hidden /> {t('waiting.askBuyer')}
            </Button>
          ) : null}
          <Button size="sm" heldReason={can.decide ? null : t('waiting.held.noDecide')} onClick={() => actions?.onDialog?.({ kind: 'back', reason: '' })}>
            <PackageX size={13} aria-hidden /> {t('waiting.sendBack')}
          </Button>
          <Button size="sm" variant="primary" heldReason={noOrder || !can.decide ? (nameHeld ? t(nameHeld.key, nameHeld.params) : null) : null} onClick={() => actions?.onDialog?.({ kind: 'name', draft: { orderId: null, lines: {} } })}>
            {t('waiting.name')}
          </Button>
        </span>
      }
    >
      <span className="fw-rc-banner-body">
        {t('waiting.body')}{' '}
        {buyerTask
          ? buyerTask.assignee
            ? t('waiting.buyer', { name: buyerTask.assignee.name, due: buyerTask.dueDate ? formatDate(dayAt(buyerTask.dueDate), place) : '—' })
            : t('waiting.buyerNobody')
          : t('waiting.noTask')}{' '}
        {noOrder ? (
          <>
            {t('waiting.noOrderYet', { supplier: receipt.supplier.name })} <Link href={`${model.prefix}/purchasing/orders`}>{t('waiting.toOrders')}</Link>
          </>
        ) : null}
      </span>
    </Banner>
  )
}

/** The two dialogs: name the purchase order, send the goods back. */
export function WaitingDialogs({ model, actions }: { model: WaitingModel; actions?: WaitingActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const dialog = model.dialog
  if (!dialog) return null
  const { receipt, lines, orders } = model.unplanned
  if (dialog.kind === 'back') {
    const held = sendBackHeld(model.unplanned, dialog.reason, model.busy)
    return (
      <Modal
        open
        onClose={() => actions?.onDialog?.(null)}
        title={t('waiting.back.title', { number: receipt.number })}
        size="md"
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
              {t('reception.close')}
            </Button>
            <Button size="sm" variant="primary" tone="danger" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onSendBack?.()}>
              {model.busy ? <Spinner size={12} /> : null} {t('waiting.back.confirm')}
            </Button>
          </>
        }
      >
        <div className="fw-rc">
          {model.problem ? <Banner tone="danger" title={t(model.problem.key, model.problem.params)} /> : null}
          <ul className="fw-rc-list">
            <li>{t('waiting.back.what', { supplier: receipt.supplier.name, count: lines.length })}</li>
            <li>{t('waiting.back.task')}</li>
            <li>{t('waiting.back.kept')}</li>
          </ul>
          <Field label={t('waiting.back.reason')} required hint={t('waiting.back.reasonHint')}>
            <Textarea rows={3} honourRows maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'back', reason: event.target.value })} autoFocus />
          </Field>
        </div>
      </Modal>
    )
  }
  const draft = dialog.draft
  const order = orders.find((entry) => entry.id === draft.orderId)
  const held = namingHeld(model.unplanned, draft, model.busy)
  const set = (lineId: string, change: Partial<NamingLine>) => actions?.onDialog?.({ kind: 'name', draft: { ...draft, lines: { ...draft.lines, [lineId]: { ...(draft.lines[lineId] ?? { purchaseOrderLineId: '', supplierLotRef: '', hideAreas: '' }), ...change } } } })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('waiting.nameDialog.title', { number: receipt.number })}
      subtitle={t('waiting.nameDialog.subtitle', { place: receipt.holding?.code ?? '—' })}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('reception.close')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onName?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('waiting.nameDialog.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-rc">
        {model.problem ? <Banner tone="danger" title={t(model.problem.key, model.problem.params)} /> : null}
        <fieldset className="fw-rc-orders">
          <legend className="fw-rc-legend">{t('waiting.nameDialog.order')}</legend>
          {orders.length === 0 ? <p className="fw-rc-sub">{t('waiting.noOrderYet', { supplier: receipt.supplier.name })}</p> : null}
          {orders.map((entry) => {
            const takes = lines.every((line) => fitsOf(entry, line.id).length > 0)
            return (
              <Radio
                key={entry.id}
                name="fw-rc-order"
                checked={draft.orderId === entry.id}
                onChange={() => actions?.onDialog?.({ kind: 'name', draft: namingFor(model.unplanned, entry.id) })}
                label={`${entry.number} · ${t(`waiting.orderStatus.${entry.status}`)}${takes ? '' : ` · ${t('waiting.nameDialog.notAll')}`}`}
              />
            )
          })}
        </fieldset>
        {order ? (
          <ul className="fw-rc-naming" aria-label={t('waiting.nameDialog.lines')}>
            {lines.map((line) => {
              const named = draft.lines[line.id]
              const fits = fitsOf(order, line.id)
              const areas = line.item.tracking === 'HIDE' ? hideAreasOf(named?.hideAreas ?? '') : null
              return (
                <li key={line.id} className="fw-rc-naming-line">
                  <KeyValue
                    items={[
                      { label: t('waiting.nameDialog.came'), value: `${line.seq} · ${line.item.code}${line.colour ? ` ${line.colour.code}` : ''} · ${quantity(line.quantity, locale)} ${unitOf(t, line.uom)}${line.hideCount ? ` · ${t('waiting.nameDialog.hides', { count: line.hideCount })}` : ''}` },
                    ]}
                  />
                  <Field label={t('waiting.nameDialog.orderLine')} required>
                    <Select size="sm" value={named?.purchaseOrderLineId ?? ''} onChange={(event) => set(line.id, { purchaseOrderLineId: event.target.value })}>
                      <option value="">{fits.length === 0 ? t('waiting.nameDialog.noFit') : t('waiting.nameDialog.pick')}</option>
                      {order.lines
                        .filter((entry) => fits.includes(entry.id))
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {t('waiting.nameDialog.lineOption', { seq: entry.seq, code: entry.item.code, open: `${quantity(entry.openBase, locale)} ${unitOf(t, entry.item.baseUom)}` })}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  {line.item.tracking !== 'NONE' ? (
                    <Field label={t('waiting.nameDialog.supplierLot')} hint={t('waiting.nameDialog.supplierLotHint')}>
                      <Input size="sm" maxLength={60} value={named?.supplierLotRef ?? ''} onChange={(event) => set(line.id, { supplierLotRef: event.target.value })} />
                    </Field>
                  ) : null}
                  {areas ? (
                    <Field label={t('waiting.nameDialog.hideAreas', { unit: unitOf(t, line.uom) })} required hint={areas.problem === null ? t('waiting.nameDialog.hideTotal', { count: areas.areas.length, total: quantity(areas.areas.reduce((sum, area) => sum + Number(area), 0), locale) }) : t('waiting.nameDialog.hideAreasHint')}>
                      <Textarea rows={3} honourRows value={named?.hideAreas ?? ''} onChange={(event) => set(line.id, { hideAreas: event.target.value })} />
                    </Field>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
        <p className="fw-rc-sub">{t('waiting.nameDialog.reach', { place: receipt.holding?.code ?? '—' })}</p>
      </div>
    </Modal>
  )
}

