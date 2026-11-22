'use client'

import Link from 'next/link'
import { SummaryTable } from '@nexus/ui/components'
import { Pill, Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { money } from '../../../../quotes/model'
import type { ChainInvoice, Order } from '../../../api'
import { dayInstant, SDI_TONE, type Tone } from '../../../model'
// F-SA-266: Money's rows are discussed in office notes only (the stricter money rule: a chip here never goes into a reply)
import { DiscussDoor } from '../../view/Discuss'
import { rowAnchor } from '../../dock/discuss'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartFailed, Quiet, Section } from '../../view/production/Kit' // F-OM-101 (L6): the Production kit, in place
// ---- F-OP-118: Money = this order's share (each invoice's whole and share, the other orders it bills)
import { alsoBillsOf, freightOf } from '../../money-share'

const INVOICE_TONE: Record<string, Tone> = { DRAFT: 'neutral', ISSUED: 'info', SENT: 'info', DELIVERED: 'success', NOT_DELIVERABLE: 'warning', REJECTED: 'danger', ERROR: 'danger' }

/**
 * F-OM-101 (order MONEY tab, 10-design §6) — section 3, Invoices & credit notes (#invoices), in the kit: every bill of this order with
 * its state and, with the price grain, its whole, this order's share and what is open (F-OP-118); the customer's statement one link
 * (no figure of the customer as a whole here). Shown with invoices.view only: without it the section is not drawn and the tab's head
 * says so once. Nothing invoiced: the head's one line. (W2, F-OM-203: one State column, the Payment words, TD02 / TD04 amounts and
 * the doors into Finance.)
 */
export function InvoicesSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  if (!model.can.viewInvoices) return null
  const settlement = model.settlement?.value ?? null
  const invoiceHref = (invoice: ChainInvoice) => `${model.prefix}${recordAddress({ type: 'Invoice', id: invoice.id, label: invoice.number ?? undefined, companyId: order.companyId }, OFFICE_PAGES)}`
  const showMoney = model.can.price && !!settlement
  // F-OP-118: another order of the same customer the invoice bills (the API names only those the reader reaches).
  const orderHref = (id: string) => `${model.prefix}/sales/orders/${encodeURIComponent(id)}`
  const title = t('moneyTab.invoices.title')
  const invoices = order.chain.invoices
  const statement = order.party ? (
    <Link className="fw-pt-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}?tab=money`}>
      {t('money.statement', { customer: order.party.legalName })}
    </Link>
  ) : null
  // Nothing invoiced yet: the head's one line (a section with nothing to show is never a box).
  if (invoices.length === 0) {
    return (
      <Section id="invoices" title={title} answer={t('moneyTab.invoices.empty')} more={statement}>
        {null}
      </Section>
    )
  }
  return (
    <Section id="invoices" title={title} answer={t('moneyTab.invoices.count', { count: invoices.length })} more={statement}>
      <SummaryTable
        label={title}
        // F-OP-118: Number · Kind · Status · SDI · Invoice total (whole) · This order's share · Open (whole).
        columns={[t('money.col.number'), t('money.col.kind'), t('money.col.status'), ...(model.sdi ? [t('money.col.sdi')] : []), ...(showMoney ? [t('money.invoiceWhole'), t('money.share'), t('money.col.open')] : [])]}
        rows={invoices.map((invoice) => {
          const sdi = model.sdi?.[invoice.id]?.value ?? null
          const amounts = settlement?.invoices.find((entry) => entry.id === invoice.id)
          const also = amounts ? alsoBillsOf(amounts) : null // F-OP-118
          const freight = amounts && model.can.price ? freightOf(amounts) : null // F-OP-118
          return {
            id: invoice.id,
            cells: [
              <span key="n" className="fw-so-cell" id={rowAnchor('Invoice', invoice.id) /* F-SA-266 */} tabIndex={-1}>
                <span className="fw-so-inline">
                  <Link className="fw-so-link" href={invoiceHref(invoice)}>
                    {invoice.number ?? t('money.draft')}
                  </Link>
                  <DiscussDoor order={order} part={t('discuss.invoice', { number: invoice.number ?? t('money.draft') })} target={{ kind: 'Invoice', id: invoice.id }} officeOnly />
                </span>
                <span className="fw-so-cell-sub">{invoice.issueDate ? formatDate(dayInstant(invoice.issueDate), { locale }) : t('money.draft')}</span>
                {/* F-OP-118: a shared invoice names the other orders it bills (links; the same customer's only), counts the rest. */}
                {also && (
                  <span className="fw-so-cell-sub fw-so-inline">
                    {also.orders.length > 0 && <span>{t('money.alsoBills')}</span>}
                    {also.orders.map((other) => (
                      <Link key={other.id} className="fw-so-link" href={orderHref(other.id)}>
                        {other.number}
                      </Link>
                    ))}
                    {also.hidden > 0 && <span>{t('money.alsoBillsHidden', { count: also.hidden })}</span>}
                  </span>
                )}
                {freight !== null && <span className="fw-so-cell-sub">{t('money.freight', { amount: money(freight, order.currency, locale) })}</span>}
              </span>,
              t(`docType.${invoice.docType}`),
              <Pill key="s" tone={INVOICE_TONE[invoice.status] ?? 'neutral'}>{t(`invoiceStatus.${invoice.status}`)}</Pill>,
              ...(model.sdi ? [sdi ? <Pill key="sdi" tone={SDI_TONE[sdi.state.code]}>{t(`sdi.state.${sdi.state.code}`)}</Pill> : invoice.status === 'DRAFT' ? t('money.draft') : <Spinner key="w" size={12} />] : []),
              ...(showMoney ? [money(amounts?.grossTotal, order.currency, locale), amounts?.share === undefined ? '—' : money(amounts.share, order.currency, locale), money(amounts?.openAmount, order.currency, locale)] : []),
            ],
          }
        })}
        density="roomy"
        stackOnPhone
      />
      {model.settlement?.problem ? <PartFailed part={t('moneyTab.invoices.part')} problem={model.settlement.problem} onRetry={() => actions?.onRetryPart?.('settlement')} /> : null}
      {!model.settlement?.problem && invoices.length > 0 && !settlement && model.settlement ? <Quiet>{t('moneyTab.invoices.reading')}</Quiet> : null}
    </Section>
  )
}
