'use client'

import type { ReactNode } from 'react'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'
import { CUSTOMER_MONEY_NAMESPACE } from '../../money/model'
import { useCustomerOverview, type CustomerMoneyModel } from '../../money/overview'
import type { SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'

/**
 * SCR-033 Customer record (design sales.customers "records: Customer"): Overview, Addresses & contacts, Terms & requirements,
 * Quotes & orders and Portal access of one party, seen from Sales, on RecordFrame with its thread docked (B-TH-260: Documents and
 * Activity went to the thread). The record is the shared one (areas/parties/_shared); Terms & requirements adds the customer's
 * Commercial terms card (B-W2a-49, `terms`: the container mounts it). B-W2a-81: the Overview's Overdue and Returns this year tiles
 * and the open returns and claims under Now, from `money` (what the container reads beside the party).
 */
export function CustomerRecordView({
  model,
  actions,
  thread,
  terms,
  money,
  depth,
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  /** B-TH-260: the customer's docked thread (a design case's; the page mounts OfficeRecordThread). */
  thread?: ReactNode
  terms?: ReactNode
  money?: CustomerMoneyModel
  /** B-W2b-324: the customer in depth (the shared record's `depth` slot), drawn from made-up models in the design. */
  depth?: SupplierDepth
}) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customer model={model} actions={actions} thread={thread} terms={terms} money={money} depth={depth} />
    </WithMessages>
  )
}

function Customer({
  model,
  actions,
  thread,
  terms,
  money,
  depth,
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  thread?: ReactNode
  terms?: ReactNode
  money?: CustomerMoneyModel
  depth?: SupplierDepth | undefined
}) {
  const overview = useCustomerOverview(money ?? null)
  return <PartyRecordView model={{ ...model, side: 'customers' }} actions={actions} thread={thread} terms={terms} overview={overview} depth={depth} />
}
