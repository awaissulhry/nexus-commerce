'use client'

import { useMemo } from 'react'
import type { Metric } from '@nexus/ui/components'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { moneyText } from '../../../finance/costing/model'
import type { AgeingRow } from '../../../finance/receivables/api'
import type { Loaded } from '../../../parties/_shared/model'
import type { OverviewSlot } from '../../../parties/_shared/view/PartyRecordView'
import type { CustomerComplaint, CustomerReturn, OpenOrderMoney } from './api'
import { CUSTOMER_MONEY_NAMESPACE, openAfterSales, overdueOf, receivablesOfCustomer, returnsThisYear, type CustomerMoneyCan } from './model'
import { OpenAfterSalesCard } from './view/OpenAfterSalesCard'

/** What the customer record reads beside the party for its Overview (B-W2a-81). */
export interface CustomerMoneyModel {
  readonly can: CustomerMoneyCan
  readonly prefix: string
  readonly partyId: string
  /** The Europe/Rome year "this year" means. */
  readonly year: string
  readonly ageing: Loaded<AgeingRow>
  readonly returns: Loaded<CustomerReturn>
  readonly complaints: Loaded<CustomerComplaint>
  /** F-SA-273: the open orders' deposits and balances (orders.view; absent in a design case that draws none). */
  readonly orders?: Loaded<OpenOrderMoney>
  /** The returns list with this customer, once Sales › Returns is built (else the tile is not a link). */
  readonly returnsHref: string | null
}

/**
 * The customer's Overview part of B-W2a-81 (design sales.customers customer.ov.numbers "Overdue (W2a)", "Returns this
 * year (W2a)"; customer.ov.now "Open returns and claims (W2a)"; page.conn "Finance › Receivables (W2a)"): two key-number
 * tiles after the record's own three — each opens its filtered list — and the open returns and claims under Now, with
 * the link to what the customer owes. Each part only with its permission; amounts only with the price grain.
 */
export function useCustomerOverview(model: CustomerMoneyModel | null): OverviewSlot | undefined {
  const t = useT(CUSTOMER_MONEY_NAMESPACE)
  const locale = useLocale()
  return useMemo(() => {
    if (!model) return undefined
    const { can } = model
    const numbers: Metric[] = []
    let overdueTile: Metric | undefined // F-SA-272: the Overview's door to Money
    let returnsTile: Metric | undefined // F-SA-273: Money's Returns in <year>
    if (can.receivables) {
      const overdue = model.ageing.items ? overdueOf(model.ageing.items, model.partyId) : null
      const value = !model.ageing.items
        ? '—'
        : !overdue
          ? can.price
            ? '0'
            : t('money.nothingLate')
          : can.price
            ? overdue.amounts.map((amount) => moneyText(amount.amount, amount.currency, locale)).join(' · ')
            : t('money.lateInvoices', { count: overdue.invoices })
      const hint = model.ageing.problem
        ? t('money.unknown')
        : !model.ageing.items
          ? t('money.reading')
          : overdue?.daysLate
            ? t('money.oldestLate', { count: overdue.daysLate })
            : t('money.nothingLateHint')
      overdueTile = { label: t('money.overdue'), value, hint, href: receivablesOfCustomer(model.prefix, model.partyId) }
      numbers.push(overdueTile)
    }
    if (can.returns) {
      const year = model.returns.items ? returnsThisYear(model.returns.items, model.year) : null
      const value = year ? String(year.count) : '—'
      const hint = model.returns.problem ? t('money.unknown') : !year ? t('money.reading') : t('money.returnsHint', { units: year.units, open: year.open })
      returnsTile = model.returnsHref ? { label: t('money.returns', { year: model.year }), value, hint, href: model.returnsHref } : { label: t('money.returns', { year: model.year }), value, hint }
      numbers.push(returnsTile)
    }
    const open = openAfterSales(model.returns.items ?? [], model.complaints.items ?? [])
    const now =
      can.returns || can.complaints || can.receivables ? (
        <OpenAfterSalesCard
          model={{
            prefix: model.prefix,
            can,
            returns: can.returns ? { items: model.returns.items ? open.returns : null, problem: model.returns.problem ?? null } : null,
            complaints: can.complaints ? { items: model.complaints.items ? open.complaints : null, problem: model.complaints.problem ?? null } : null,
            receivablesHref: can.receivables ? receivablesOfCustomer(model.prefix, model.partyId) : null,
          }}
        />
      ) : null
    return { numbers, now, ...(overdueTile ? { overdue: overdueTile } : {}), ...(returnsTile ? { returns: returnsTile } : {}) }
  }, [model, t, locale])
}
