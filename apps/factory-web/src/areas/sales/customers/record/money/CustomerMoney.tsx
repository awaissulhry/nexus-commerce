'use client'

import { useMemo } from 'react'
import { useOfficeSession } from '../../../../../lib/session/context'
import { romeToday } from '../../../../finance/costing/model'
import type { Party } from '../../../../parties/_shared/api'
import { partyName } from '../../../../parties/_shared/model'
import type { Glance } from '../../depth/api'
import type { Read } from '../../depth/model'
import type { CustomerMoneyModel } from '../../money/overview'
import { CustomerMoneyTab } from '../view/money/CustomerMoneyTab'
import type { DockPick } from '../view/WorkTab'
import { pagePartsOf } from './balance'
import { moneyTabCanOf, type MoneyRead, type MoneyTabInput } from './model'
import { useCustomerMoneyTab } from './use-customer-money-tab'

/**
 * F-CM-101 (customer page › MONEY tab, 13-backend §5.3) — the tab's container: the reader's rights, the page's money reads (the ageing
 * split by company, the open items: `money`, read on every tab), the tab's own reads (made only while the tab is shown) and the glance
 * (the depth provider's, handed by the record) become the ONE input of the pure rules; the view draws it. `CR` builds it like Work and
 * Quotes (only on `?tab=money`). Every read names THIS customer.
 */
export function CustomerMoney({ party, prefix, money, priceDiffer, glance, onPick }: { party: Party; prefix: string; money: CustomerMoneyModel | null; priceDiffer: number | null; glance: Read<Glance> | null; onPick?: (pick: DockPick) => void }) {
  const session = useOfficeSession()
  const can = useMemo(() => moneyTabCanOf(session.permissions), [session.permissions])
  const company = session.company ? { id: session.company.id, name: session.company.name } : null
  const today = useMemo(() => romeToday(), [])
  const page = useMemo(() => pagePartsOf(money), [money])
  const heldIds = useMemo(() => (page.openItems?.value?.items ?? []).map((item) => item.id), [page.openItems])
  const reads = useCustomerMoneyTab({ partyId: party.id, companyId: company?.id ?? null, currency: party.currency, can, heldIds })
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
  return <CustomerMoneyTab input={input} prefix={prefix} asOf={money?.readAt ?? null} onRetry={onRetry} onPick={onPick} />
}
