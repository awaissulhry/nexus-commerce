'use client'

import { useCallback, useMemo } from 'react'
import { useOfficeSession } from '../../../../../lib/session/context'
import { WithMessages } from '../../../../../record-panels/i18n' // F-CM-201: the windows' toasts and titles say loaded words
import { romeToday } from '../../../../finance/costing/model'
import type { Party } from '../../../../parties/_shared/api'
import { partyName } from '../../../../parties/_shared/model'
import type { Glance } from '../../depth/api'
import type { Read } from '../../depth/model'
import type { CustomerMoneyModel } from '../../money/overview'
import { OrderMoneyWindow } from '../../../orders/record/money/door/OrderMoneyWindow' // F-CM-201: the order's own windows, in place
import { CustomerMoneyTab } from '../view/money/CustomerMoneyTab'
import type { DockPick } from '../view/WorkTab'
import { pagePartsOf } from './balance'
import { MONEY_TAB_NAMESPACES, moneyTabCanOf, type MoneyRead, type MoneyTabInput } from './model'
import { StopWindow } from './StopWindow' // F-CM-201: Finance's own stop container, in one centred window
import { RefundWindowsView } from './RefundWindowsView' // F-CM-203: Finance's own refund windows, in place
import { targetOfNote, type RefundTarget } from '../../../../finance/payments/refunds/model' // F-CM-203
import { useCustomerMoneyTab } from './use-customer-money-tab'
import { useMoneyWindows } from './use-money-windows' // F-CM-201

/**
 * F-CM-101 (customer page › MONEY tab, 13-backend §5.3) — the tab's container: the reader's rights, the page's money reads (the ageing
 * split by company, the open items: `money`, read on every tab), the tab's own reads (made only while the tab is shown) and the glance
 * (the depth provider's, handed by the record) become the ONE input of the pure rules; the view draws it. `CR` builds it like Work and
 * Quotes (only on `?tab=money`). Every read names THIS customer.
 */
export interface CustomerMoneyProps {
  readonly party: Party
  readonly prefix: string
  readonly money: CustomerMoneyModel | null
  readonly priceDiffer: number | null
  readonly glance: Read<Glance> | null
  readonly onPick?: (pick: DockPick) => void
}

export function CustomerMoney(props: CustomerMoneyProps) {
  // F-CM-201: every catalogue the tab and its windows say words from is loaded above them (Z29).
  return (
    <WithMessages namespaces={MONEY_TAB_NAMESPACES}>
      <CustomerMoneyReads {...props} />
    </WithMessages>
  )
}

function CustomerMoneyReads({ party, prefix, money, priceDiffer, glance, onPick }: CustomerMoneyProps) {
  const session = useOfficeSession()
  const can = useMemo(() => moneyTabCanOf(session.permissions), [session.permissions])
  const company = session.company ? { id: session.company.id, name: session.company.name } : null
  const today = useMemo(() => romeToday(), [])
  const page = useMemo(() => pagePartsOf(money), [money])
  const heldIds = useMemo(() => (page.openItems?.value?.items ?? []).map((item) => item.id), [page.openItems])
  const onAccount = (page.openItems?.value?.creditBalance ?? []).some((entry) => entry.amount === undefined || entry.amount > 0) // F-CM-203
  const reads = useCustomerMoneyTab({ partyId: party.id, companyId: company?.id ?? null, currency: party.currency, can, heldIds, onAccount })
  const input: MoneyTabInput = {
    party: { id: party.id, name: partyName(party), currency: party.currency, paymentTerms: party.paymentTerms },
    company,
    companies: session.companies.length,
    can,
    today,
    ...page,
    refunds: reads.refunds,
    stops: reads.stops,
    reminders: reads.reminders,
    summary: reads.summary,
    shipped: reads.shipped,
    glance,
    openOrders: money?.orders?.items ?? null,
    priceDiffer,
  }
  const onRetry = (read: MoneyRead) => (read === 'page' ? money?.reload?.() : reads.retry(read))
  // F-CM-201: a write in place (the order's window, Finance's) → every money read of the page and the tab again (the burst).
  const reloadPage = money?.reload
  const reloadTab = reads.reload
  const onBurst = useCallback(() => {
    reloadPage?.()
    reloadTab()
  }, [reloadPage, reloadTab])
  const windows = useMoneyWindows({ prefix, onBurst })
  // F-CM-203: what Refund… may settle for THIS customer — its credit notes with money left (the refunds read) and its payments' money
  // on account (the credit-balance read); null while they are read (Finance's window says it is reading).
  const name = partyName(party)
  const notes = reads.refunds?.value?.creditNotesToRefund ?? null
  const holders = reads.credit?.value?.payments ?? null
  const targets: RefundTarget[] | null =
    notes === null
      ? null
      : [
          ...notes.map(targetOfNote),
          ...(holders ?? []).filter((payment) => payment.unplacedAmount === undefined || payment.unplacedAmount > 0).map((payment): RefundTarget => ({ kind: 'payment', paymentId: payment.id, label: payment.externalRef, partyName: name, currency: payment.currency, cap: payment.unplacedAmount ?? null })),
        ]
  return (
    <>
      <CustomerMoneyTab
        input={input}
        prefix={prefix}
        asOf={money?.readAt ?? null}
        onRetry={onRetry}
        onPick={onPick}
        onAct={windows.onAct}
        lazy={{
          want: reads.want,
          documents: reads.documents,
          chip: reads.chip,
          onChip: reads.onChip,
          onMoreDocuments: reads.moreDocuments /* F-CM-202 */,
          payments: reads.payments,
          credit: reads.credit,
          refundsMade: reads.refundsMade,
          onMorePayments: reads.morePayments,
          onRefund: (start) => {
            reads.want('received') // its money on account's payments are the window's targets
            windows.refunds.onOpen(start)
          },
          onMoveRefund: windows.refunds.onMove /* F-CM-203 */,
        }}
      />
      {windows.door.model ? <OrderMoneyWindow model={windows.door.model} actions={windows.door.actions} /> : null}
      {windows.stop ? <StopWindow partyId={party.id} ask={windows.stop} onClose={windows.closeStop} onChanged={onBurst} /> : null}
      <RefundWindowsView windows={windows.refunds} targets={targets} today={today} />
    </>
  )
}
