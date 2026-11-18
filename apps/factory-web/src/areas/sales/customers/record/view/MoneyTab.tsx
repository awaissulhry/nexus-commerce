'use client'

import Link from 'next/link'
import { Card, KeyValue, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { moneyText } from '../../../../finance/costing/model'
import { AGEING_BUCKETS } from '../../../../finance/receivables/api'
import type { Party } from '../../../../parties/_shared/api'
import { keyNumbers, money, sideHref, SIDES, type PartyRecordModel } from '../../../../parties/_shared/model'
import type { OverviewSlot, SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'
import { ReadState } from '../../../../parties/_shared/view/parts'
import { CUSTOMER_MONEY_NAMESPACE, depositsAndBalances, openToPayOf, receivablesOfCustomer, statementOf } from '../../money/model'
import type { CustomerMoneyModel } from '../../money/overview'

/**
 * F-SA-273 (sales page plan N5, pick P10; 11-customer-page §5): the customer's Money tab — each card its own right, amounts only
 * with the price grain (the API leaves them out), the customer's own ledger only:
 *
 *   Key numbers   open to pay (receivables.view) · overdue · free credit (sales.credit.view) · deposits waiting (orders.view) ·
 *                 ordered in <year> · returns in <year> (sales.returns.view): at most six, each a door where one exists
 *   Credit        the limit, used and free (the glance) · Change limit… → Finance › Receivables & credit (the one editor;
 *                 sales.credit.limits, held with why)
 *   Open invoices one row per currency: open, overdue, the ageing (current · 1–30 · 31–60 · 61–90 · 90+), invoices, oldest days late ·
 *                 Open statement (Finance's statement of the customer, company and currency)
 *   Deposits and balances of open orders   the first 10 by balance (a link each) · See all → Work (All orders)
 *   Payment terms read only (the party's) · Edit in Terms & requirements
 */
export function MoneyTab({ model, party, money: moneyModel, overview, depth }: { model: PartyRecordModel; party: Party; money: CustomerMoneyModel | null; overview?: OverviewSlot | undefined; depth?: SupplierDepth | undefined }) {
  const t = useT(CUSTOMER_MONEY_NAMESPACE)
  const tp = useT('parties')
  const locale = useLocale()
  const can = model.can
  const mcan = moneyModel?.can
  const year = String(new Date().getUTCFullYear())
  const recordPath = sideHref(model.prefix, SIDES.customers, `/${encodeURIComponent(party.id)}`)
  const price = can.price
  const amount = (value: number | undefined | null, currency: string) => (price && value !== undefined && value !== null ? moneyText(value, currency, locale) : null)
  const ageing = moneyModel?.ageing ?? null
  const owed = ageing?.items ? openToPayOf(ageing.items, party.id) : null
  const orders = moneyModel?.orders ?? null
  const deposits = orders?.items ? depositsAndBalances(orders.items) : null
  const numbers = keyNumbers(model.quotes, model.orders, year)
  // The credit tile of Sales' depth slot (customers/depth/CustomerDepth.tsx customerDepthSlot: the first of its numbers).
  const credit = mcan?.credit ? depth?.numbers?.[0] : undefined
  const metrics: Metric[] = [
    ...(mcan?.receivables
      ? [
          {
            label: t('tab.openToPay'),
            value: !owed ? '—' : owed.length === 0 ? (price ? '0' : t('tab.nothingOpen')) : price ? owed.map((row) => moneyText(row.open, row.currency, locale)).join(' · ') : t('cell.invoices', { count: owed.reduce((sum, row) => sum + row.invoices, 0) }),
            hint: ageing?.problem ? t('money.unknown') : !owed ? t('money.reading') : t('tab.openToPayHint'),
          },
        ]
      : []),
    ...(overview?.overdue ? [overview.overdue] : []),
    ...(credit ? [credit] : []),
    ...(mcan?.orders ? [{ label: t('tab.depositsWaiting'), value: deposits ? String(deposits.depositsWaiting) : '—', hint: orders?.problem ? t('money.unknown') : !deposits ? t('money.reading') : t('tab.depositsWaitingHint') }] : []),
    ...(can.orders
      ? [
          {
            label: tp('numbers.thisYear', { year }),
            value: numbers.orderedThisYear ? String(numbers.orderedThisYear.count) : '—',
            hint: numbers.orderedThisYear
              ? ((price && numbers.orderedThisYear.currency && numbers.orderedThisYear.amount !== null ? money(numbers.orderedThisYear.amount, numbers.orderedThisYear.currency, locale) : null) ?? tp('numbers.ordersHint'))
              : tp('numbers.reading'),
          },
        ]
      : []),
    ...(overview?.returns ? [overview.returns] : []),
  ].slice(0, 6)

  return (
    <div className="fw-pty-stack">
      {metrics.length > 0 && <MetricStrip metrics={metrics} />}
      <div className="fw-pty-two-wide">
        {mcan?.credit && (
          <Card padded>
            <div className="fw-pty-card-body">
              <h2 className="fw-pty-card-title">{t('tab.credit')}</h2>
              {credit ? <MetricStrip metrics={[credit]} /> : <p className="fw-pty-hint">{t('tab.noLimit')}</p>}
              {mcan.creditLimits ? (
                <Button size="sm" asChild>
                  <Link href={receivablesOfCustomer(model.prefix, party.id)}>{t('tab.changeLimit')}</Link>
                </Button>
              ) : (
                <Button size="sm" heldReason={t('tab.changeLimitHeld')}>
                  {t('tab.changeLimit')}
                </Button>
              )}
            </div>
          </Card>
        )}
        <Card padded>
          <div className="fw-pty-card-body">
            <h2 className="fw-pty-card-title">{t('tab.paymentTerms')}</h2>
            <KeyValue labelCase="sentence" items={[{ label: tp('field.paymentTerms'), value: party.paymentTerms ?? '—' }]} />
            <Link className="fw-pty-link" href={`${recordPath}?tab=terms`}>
              {t('tab.editTerms')}
            </Link>
          </div>
        </Card>
      </div>
      {mcan?.receivables && (
        <Card padded>
          <div className="fw-pty-card-body">
            <h2 className="fw-pty-card-title">{t('tab.openInvoices')}</h2>
            {ageing?.problem ? (
              <ReadState problem={ageing.problem} loading={false} />
            ) : !owed ? (
              <ReadState loading rows={2} />
            ) : owed.length === 0 ? (
              <p className="fw-pty-hint">{t('tab.noOpenInvoice')}</p>
            ) : (
              <ul className="fw-pty-list">
                {owed.map((row) => (
                  <li key={row.currency}>
                    <span className="fw-pty-cell">
                      <span className="fw-pty-name">
                        {row.currency} · {amount(row.open, row.currency) ?? t('cell.invoices', { count: row.invoices })}
                        {row.daysLate !== null && row.daysLate > 0 && <Tag tone="danger">{t('cell.daysLate', { count: row.daysLate })}</Tag>}
                      </span>
                      {price && (
                        <span className="fw-pty-hint">
                          {AGEING_BUCKETS.map((bucket) => `${t(`tab.bucket.${bucket}`)} ${moneyText(row.buckets[bucket] ?? 0, row.currency, locale)}`).join(' · ')}
                        </span>
                      )}
                    </span>
                    <Link className="fw-pty-link" href={statementOf(model.prefix, party.id, row.companyId, row.currency)}>
                      {t('tab.openStatement')}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}
      {mcan?.orders && (
        <Card padded>
          <div className="fw-pty-card-body">
            <h2 className="fw-pty-card-title">{t('tab.deposits')}</h2>
            {orders?.problem ? (
              <ReadState problem={orders.problem} loading={false} />
            ) : !deposits ? (
              <ReadState loading rows={3} />
            ) : deposits.rows.length === 0 ? (
              <p className="fw-pty-hint">{t('tab.noOrderOwes')}</p>
            ) : (
              <ul className="fw-pty-list">
                {deposits.rows.map((order) => (
                  <li key={order.id}>
                    <Link className="fw-pty-code" href={`${model.prefix}/sales/orders/${encodeURIComponent(order.id)}`}>
                      {order.number}
                    </Link>
                    <span className="fw-pty-hint">
                      {[t(`tab.deposit.${order.deposit.state}`), order.deposit.dueDate ? t('tab.depositDue', { date: formatDate(order.deposit.dueDate, { locale }) }) : null, amount(order.paid, order.currency) ? t('tab.paid', { amount: amount(order.paid, order.currency)! }) : null, amount(order.balance, order.currency) ? t('tab.balance', { amount: amount(order.balance, order.currency)! }) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {deposits && (deposits.owing > deposits.rows.length || orders?.more) && (
              <Link className="fw-pty-link" href={`${recordPath}?tab=work&rows=all`}>
                {t('tab.seeAll')}
              </Link>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
