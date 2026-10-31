'use client'

import type { ReactNode } from 'react'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import { PartyRecordView, type PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'
import { CUSTOMER_MONEY_NAMESPACE } from '../../money/model'
import { useCustomerOverview, type CustomerMoneyModel } from '../../money/overview'

/**
 * SCR-033 Customer record (design sales.customers "records: Customer"): Overview, Addresses & contacts, Tax & terms,
 * Quotes & orders, Documents and Activity of one party, seen from Sales. Requirements and Portal access (W2b) are not
 * drawn. The record is the shared one (areas/parties/_shared); Tax & terms adds the customer's Commercial terms card
 * (B-W2a-49, `terms`: the container mounts it). B-W2a-81: the Overview's Overdue and Returns this year tiles and the
 * open returns and claims under Now, from `money` (what the container reads beside the party).
 */
export function CustomerRecordView({
  model,
  actions,
  panels,
  documents,
  terms,
  money,
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  panels?: ReactNode
  documents?: ReactNode
  terms?: ReactNode
  money?: CustomerMoneyModel
}) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customer model={model} actions={actions} panels={panels} documents={documents} terms={terms} money={money} />
    </WithMessages>
  )
}

function Customer({
  model,
  actions,
  panels,
  documents,
  terms,
  money,
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  panels?: ReactNode
  documents?: ReactNode
  terms?: ReactNode
  money?: CustomerMoneyModel
}) {
  const overview = useCustomerOverview(money ?? null)
  return <PartyRecordView model={{ ...model, side: 'customers' }} actions={actions} panels={panels} documents={documents} terms={terms} overview={overview} />
}
