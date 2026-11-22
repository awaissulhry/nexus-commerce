'use client'

import Link from 'next/link'
import { FileText } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { money } from '../../../../quotes/model'
import type { ChainInvoice, Order } from '../../../api'
import { dayInstant } from '../../../model'
import { discussAboutOf } from '../../dock/discuss'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
import { invoicesOf, type InvoiceRow } from '../invoices'
import { useSay, type Say } from './say'

/**
 * F-OM-203 (order MONEY tab, 10-design §6) — section 3, Invoices & credit notes (#invoices), in the kit: every bill of this order —
 * goods invoices, deposit invoices (TD02), credit notes (TD04) — with ONE State column, its Payment in words (for every reader, the
 * settlement's word-code, B-OM-023) and, with the price grain, Total · This order · Open (money/invoices.ts). Each row's ⋯ opens FINANCE's own place (one path); its Discuss is an office note
 * (threads.post). The head: "Invoice shipped goods…" while shipped goods wait (Finance's From-DDTs window, this order's DDTs chosen).
 * Shown with invoices.view only (the tab's head says so once otherwise). Nothing invoiced: the head's one line.
 */
export function InvoicesSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const say = useSay(order.currency)
  if (!model.can.viewInvoices) return null
  const settlement = model.settlement?.value ?? null
  const invoiceHref = (invoice: ChainInvoice) => `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const view = invoicesOf({ order, settlement, sdi: model.sdi, can: model.can, invoiceHref, prefix: model.prefix })
  const title = t('moneyTab.invoices.title')
  const price = model.can.price
  // F-OM-203 (B-OM-023): a reader without the price grain reads the Payment words once any row carries them.
  const words = !price && view.rows.some((row) => row.payment !== null)
  const info = (
    <>
      <p>{t('moneyTab.invoices.info')}</p>
      <p>{t('moneyTab.invoices.keys')}</p>
    </>
  )
  // "Invoice shipped goods…": only while shipped goods wait for their invoice (the container found this order's DDTs).
  const shipped = model.moneyPlan?.invoiceShipped ?? null
  const buttons = shipped
    ? [
        <Button key="shipped" size="sm" asChild>
          <Link href={shipped.href}>{t('moneyTab.invoices.shipped')}</Link>
        </Button>,
      ]
    : []
  const statement = order.party ? (
    <Link className="fw-pt-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}?tab=money`}>
      {t('money.statement', { customer: order.party.legalName })}
    </Link>
  ) : null
  return (
    <Section id="invoices" title={title} answer={say(view.answer)} buttons={buttons} info={info}>
      {view.rows.length > 0 ? (
        // F-OM-203 (B-OM-023): without the price grain the Payment column still shows, in words, once the settlement names them.
        <div className={`fw-om-il${price ? '' : ` is-np${words ? ' has-pay' : ''}`}`}>
          <div className="fw-om-ir is-hd" aria-hidden>
            <div>{t('money.col.number')}</div>
            <div className="fw-om-ir-kd">{t('money.col.kind')}</div>
            <div>{t('money.col.status')}</div>
            {price ? (
              <>
                <div>{t('moneyTab.invoices.col.payment')}</div>
                <div className="fw-om-ir-am">{t('money.col.gross')}</div>
                <div className="fw-om-ir-am fw-om-ir-share">{t('money.share')}</div>
                <div className="fw-om-ir-am">{t('money.col.open')}</div>
              </>
            ) : words ? (
              <div>{t('moneyTab.invoices.col.payment')}</div>
            ) : null}
            <div />
          </div>
          {view.rows.map((row) => (
            <InvoiceRowView key={row.id} row={row} order={order} model={model} actions={actions} say={say} words={words} />
          ))}
        </div>
      ) : null}
      {model.settlement?.problem ? <PartFailed part={t('moneyTab.invoices.part')} problem={model.settlement.problem} onRetry={() => actions?.onRetryPart?.('settlement')} /> : null}
      {statement ? <p className="fw-om-il-foot">{statement}</p> : null}
    </Section>
  )
}

function InvoiceRowView({ row, order, model, actions, say, words }: { row: InvoiceRow; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; say: Say; words: boolean }) {
  const t = useT('orders')
  const f = useT('record-frame')
  const locale = useLocale()
  const frame = useRecordFrame()
  const price = model.can.price
  const invoice = row.invoice
  const number = invoice.number ?? t('money.draft')
  const href = `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const items: MenuItemDef[] = row.doors.map((door) => (door.href ? { id: door.id, label: say(door.label), href: door.href } : { id: door.id, label: say(door.label), disabled: true, description: door.held ? say(door.held) : undefined }))
  if (model.can.threadsPost && frame?.discuss) {
    // F-SA-266: an invoice is discussed in an office note only (the stricter money rule).
    const part = t('discuss.invoice', { number })
    const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
    const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part, target: { kind: 'Invoice', id: invoice.id }, officeOnly: true })
    items.push({ id: 'discuss', label: f('discuss.of', { thing: part }), onSelect: () => frame.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about }) })
  }
  if (invoice.number) items.push({ id: 'copy', label: t('moneyTab.invoices.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(invoice.number ?? '') })
  const orderHref = (id: string) => `${model.prefix}/sales/orders/${encodeURIComponent(id)}`
  const amount = (value: number | null) => (value === null ? null : money(value, order.currency, locale))
  return (
    <div className="fw-om-ir" id={row.anchor} tabIndex={-1}>
      <div className="fw-om-ir-n">
        <span className="fw-om-ir-nb">
          <FileText size={13} aria-hidden />
          <Link className="fw-pt-link" href={href}>
            {number}
          </Link>
        </span>
        <span className="fw-pt-sub">
          {[invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : t('money.draft'), ...row.subs.map(say)].join(' · ')}
        </span>
        {/* F-OP-118: a shared invoice names the other orders it bills (links; the same customer's only), counts the rest. */}
        {row.also ? (
          <span className="fw-pt-sub fw-pt-inline">
            {row.also.orders.length > 0 ? <span>{t('money.alsoBills')}</span> : null}
            {row.also.orders.map((other) => (
              <Link key={other.id} className="fw-pt-link" href={orderHref(other.id)}>
                {other.number}
              </Link>
            ))}
            {row.also.hidden > 0 ? <span>{t('money.alsoBillsHidden', { count: row.also.hidden })}</span> : null}
          </span>
        ) : null}
        <span className="fw-om-ir-kn">{say(row.kind)}</span>
      </div>
      <div className="fw-om-ir-kd">{say(row.kind)}</div>
      <div className="fw-om-ir-s">
        {row.sdi === 'reading' ? (
          <span className="fw-pt-inline">
            <Spinner size={12} /> {t('deposit.step.sdiReading')}
          </span>
        ) : row.sdi === 'failed' ? (
          <span className="fw-pt-inline">
            {t('moneyTab.invoices.sdiFailed')}
            <Button size="sm" variant="link" onClick={() => actions?.onRetryPart?.('sdi')}>
              {t('common.retry')}
            </Button>
          </span>
        ) : (
          <Pill tone={row.state.tone}>{say(row.state.word)}</Pill>
        )}
      </div>
      {price ? (
        <>
          <div className="fw-om-ir-p">{row.payment ? <Tag tone={row.payment.tone}>{say(row.payment.word)}</Tag> : null}</div>
          <div className="fw-om-ir-t">
            {row.total !== null ? <span data-l={t('money.col.gross')}>{amount(row.total)}</span> : null}
            {row.open !== null ? <span data-l={t('money.col.open')}>{amount(row.open)}</span> : null}
          </div>
          <div className="fw-om-ir-am">{amount(row.total)}</div>
          <div className="fw-om-ir-am fw-om-ir-share">{amount(row.share)}</div>
          <div className="fw-om-ir-am">{row.open !== null ? <b>{amount(row.open)}</b> : null}</div>
        </>
      ) : words ? (
        <div className="fw-om-ir-p">{row.payment ? <Tag tone={row.payment.tone}>{say(row.payment.word)}</Tag> : null}</div>
      ) : null}
      <div className="fw-om-ir-o">{items.length > 0 ? <LineMenuButton label={t('moneyTab.invoices.more', { number })} items={items} /> : null}</div>
    </div>
  )
}
