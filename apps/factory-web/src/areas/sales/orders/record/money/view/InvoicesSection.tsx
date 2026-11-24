'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation' // F-OM-fx5w (N5): Copy link to this row keeps the page's address terms
import type { MenuItemDef } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../../_shared/record-frame/address' // F-OM-fx5w (N5)
import { money } from '../../../../quotes/model'
import type { ChainInvoice, Order } from '../../../api'
import { discussAboutOf } from '../../dock/discuss'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton } from '../../view/LineMenu'
import { PartFailed, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
import { invoicesOf, type InvoiceRow } from '../invoices'
import { InvoiceList, type InvoiceListRow } from './parts' // F-CM-k1: the shared list (its head and rows); this file builds each row's ⋯
import { useSay } from './say'

/**
 * F-OM-203 (order MONEY tab, 10-design §6) — section 3, Invoices & credit notes (#invoices), in the kit: every bill of this order —
 * goods invoices, deposit invoices (TD02), credit notes (TD04) — with ONE State column, its Payment in words (for every reader, the
 * settlement's word-code, B-OM-023) and, with the price grain, Total · This order · Open (money/invoices.ts). Each row's ⋯ opens FINANCE's own place (one path); its Discuss is an office note
 * (threads.post). The head: "Invoice shipped goods…" while shipped goods wait (Finance's From-DDTs window, this order's DDTs chosen).
 * Shown with invoices.view only (the tab's head says so once otherwise). Nothing invoiced: the head's one line.
 * F-CM-k1: the rows are the shared InvoiceList (view/parts.tsx, the customer's Money tab draws it too); this section keeps its head,
 * its foot, the sixth column (this order's share) and builds each row's ⋯ (its doors into Finance, Discuss, copy number, copy link).
 */
export function InvoicesSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const f = useT('record-frame') // F-CM-k1: the row's ⋯ is built here now (it was in the row view)
  const locale = useLocale()
  const frame = useRecordFrame()
  const search = useSearchParams()?.toString() ?? ''
  const say = useSay(order.currency)
  if (!model.can.viewInvoices) return null
  const settlement = model.settlement?.value ?? null
  const invoiceHref = (invoice: ChainInvoice) => `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const view = invoicesOf({ order, settlement, sdi: model.sdi, can: model.can, invoiceHref, prefix: model.prefix })
  const title = t('moneyTab.invoices.title')
  const price = model.can.price
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
  const statementHref = `${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}?tab=money`
  const statement = order.party ? (
    <Link className="fw-pt-link" href={statementHref}>
      {t('money.statement', { customer: order.party.legalName })}
    </Link>
  ) : null
  // F-OM-fx3 (W-07, W-08): nothing invoiced is the head's one line, never a box — the statement then lives in the head's ⋯, beside
  // Open in Finance › Invoices › (Finance's own list; it has no order filter yet).
  const empty = view.rows.length === 0 && !model.settlement?.problem
  const more: MenuItemDef[] = [
    { id: 'finance', label: t('moneyTab.invoices.finance'), href: `${model.prefix}/finance/invoices` },
    ...(empty && order.party ? [{ id: 'statement', label: t('money.statement', { customer: order.party.legalName }), href: statementHref }] : []),
  ]
  // F-CM-k1: each row's ⋯ — this page's own lines; the shared list draws the button.
  const itemsOf = (row: InvoiceRow): MenuItemDef[] => {
    const invoice = row.invoice
    const number = invoice.number ?? t('money.draft')
    const items: MenuItemDef[] = row.doors.map((door) => (door.href ? { id: door.id, label: say(door.label), href: door.href } : { id: door.id, label: say(door.label), disabled: true, description: door.held ? say(door.held) : undefined }))
    if (model.can.threadsPost && frame?.discuss) {
      // F-SA-266: an invoice is discussed in an office note only (the stricter money rule).
      const part = t('discuss.invoice', { number })
      const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')
      const about = discussAboutOf(order, { yourOrder, firstLine: (words) => t('discuss.firstLine', { thing: words }) }, { part, target: { kind: 'Invoice', id: invoice.id }, officeOnly: true })
      items.push({ id: 'discuss', label: f('discuss.of', { thing: part }), onSelect: () => frame.discuss?.({ record: { type: 'SalesOrder', id: order.id }, about }) })
    }
    if (invoice.number) items.push({ id: 'copy', label: t('moneyTab.invoices.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(invoice.number ?? '') })
    // F-OM-fx5w (N5): every row's ⋯ copies a link to it (the plan's rows do too) — a draft's row ends with its ⋯ like every other.
    items.push({
      id: 'link',
      label: t('moneyTab.menu.copyLinkRow'),
      onSelect: () => void navigator.clipboard?.writeText(new URL(`${tabHref(`${model.prefix}/sales/orders/${order.id}`, 'money', search)}#${row.anchor}`, window.location.href).toString()),
    })
    return items
  }
  const orderHref = (id: string) => `${model.prefix}/sales/orders/${encodeURIComponent(id)}`
  // F-CM-k1: the rows in the shared list's plain shape; the sixth column's cell = this order's share of the invoice (price grain).
  const rows: InvoiceListRow[] = view.rows.map((row) => ({
    id: row.id,
    anchor: row.anchor,
    number: row.number,
    issueDate: row.issueDate,
    currency: row.currency,
    href: row.href,
    kind: row.kind,
    state: row.state,
    sdi: row.sdi,
    payment: row.payment,
    total: row.total,
    open: row.open,
    subs: row.subs,
    also: row.also ? { orders: row.also.orders.map((other) => ({ id: other.id, number: other.number, href: orderHref(other.id) })), hidden: row.also.hidden } : null,
    extra: row.share === null ? null : money(row.share, order.currency, locale),
  }))
  const menuOf = (listRow: InvoiceListRow): MenuItemDef[] => {
    const row = view.rows.find((entry) => entry.id === listRow.id)
    return row ? itemsOf(row) : []
  }
  return (
    <Section id="invoices" title={title} answer={say(view.answer)} buttons={buttons} more={<LineMenuButton label={t('moneyTab.invoices.headMore')} items={more} />} info={info}>
      {view.rows.length > 0 ? <InvoiceList rows={rows} price={price} extraHead={t('money.share')} menuOf={menuOf} onRetrySdi={() => actions?.onRetryPart?.('sdi')} /> : null}
      {model.settlement?.problem ? <PartFailed part={t('moneyTab.invoices.part')} problem={model.settlement.problem} onRetry={() => actions?.onRetryPart?.('settlement')} /> : null}
      {statement && !empty ? <p className="fw-om-il-foot">{statement}</p> : null}
    </Section>
  )
}
