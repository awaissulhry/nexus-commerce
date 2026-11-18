'use client'

import { useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { listAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { romeToday } from '../../../finance/costing/model'
import { readProblem } from '../../../finance/receivables/model'
import type { AgeingRow } from '../../../finance/receivables/api'
import { failed, loaded, loading, type Loaded } from '../../../parties/_shared/model'
import { getCustomerAgeing, getOverdueCustomers, listCustomerComplaints, listCustomerReturns, type CustomerComplaint, type CustomerReturn } from './api'
import { listOpenOrderMoney, type OpenOrderMoney } from './api' // F-SA-273
import type { OverdueListModel } from './columns'
import { customerMoneyCanOf, overdueByParty } from './model'
import type { CustomerMoneyModel } from './overview'

const BUILT = new Set(OFFICE_PAGES)

/** The list's Overdue column: one read of every customer with money late in the company (only with receivables.view and the price grain). */
export function useOverdueList(): OverdueListModel {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => customerMoneyCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [state, setState] = useState<{ byParty: OverdueListModel['byParty']; problem: string | null }>({ byParty: null, problem: null })
  useEffect(() => {
    if (!can.receivables || !can.price) return
    const abort = new AbortController()
    getOverdueCustomers(api, companyId, abort.signal)
      .then((ageing) => setState({ byParty: overdueByParty(ageing.customers), problem: null }))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setState({ byParty: null, problem: readProblem(error) })
      })
    return () => abort.abort()
  }, [api, can.receivables, can.price, companyId])
  return useMemo(() => ({ can, ...state }), [can, state])
}

/** The record's Overdue, Returns this year and open returns and claims: three reads beside the party, each with its permission. */
export function useCustomerMoney(partyId: string, prefix: string): CustomerMoneyModel {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => customerMoneyCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [ageing, setAgeing] = useState<Loaded<AgeingRow>>(loading())
  const [returns, setReturns] = useState<Loaded<CustomerReturn>>(loading())
  const [complaints, setComplaints] = useState<Loaded<CustomerComplaint>>(loading())
  const [orders, setOrders] = useState<Loaded<OpenOrderMoney>>(loading()) // F-SA-273: the Money tab's deposits and balances
  useEffect(() => {
    const abort = new AbortController()
    const live = () => !abort.signal.aborted
    if (can.receivables)
      getCustomerAgeing(api, partyId, companyId, abort.signal)
        .then((value) => live() && setAgeing(loaded(value.customers)))
        .catch((error: unknown) => live() && setAgeing(failed(readProblem(error))))
    if (can.returns)
      listCustomerReturns(api, partyId, abort.signal)
        .then((value) => live() && setReturns(loaded(value.returns, value.truncated)))
        .catch((error: unknown) => live() && setReturns(failed(readProblem(error))))
    if (can.complaints)
      listCustomerComplaints(api, partyId, abort.signal)
        .then((value) => live() && setComplaints(loaded(value)))
        .catch((error: unknown) => live() && setComplaints(failed(readProblem(error))))
    // F-SA-273: the open orders' deposits and balances (orders.view; amounts with the price grain).
    if (can.orders)
      listOpenOrderMoney(api, partyId, abort.signal)
        .then((value) => live() && setOrders(loaded(value.orders, value.more)))
        .catch((error: unknown) => live() && setOrders(failed(readProblem(error))))
    return () => abort.abort()
  }, [api, partyId, companyId, can.receivables, can.returns, can.complaints, can.orders])
  const returnsList = listAddress('/sales/returns', { partyId }, BUILT)
  return useMemo(
    () => ({ can, prefix, partyId, year: romeToday().slice(0, 4), ageing, returns, complaints, orders /* F-SA-273 */, returnsHref: returnsList ? `${prefix}${returnsList}` : null }),
    [can, prefix, partyId, ageing, returns, complaints, orders, returnsList],
  )
}
