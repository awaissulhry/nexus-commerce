'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useLiveBus } from '../../../../shell/live/use-live' // F-CM-103: the page's money reads read again by themselves
import { openItemsFor } from '../../../finance/payments/refunds/api' // F-CM-103: the open items and the money on account
import { readProblem as readOrderProblem } from '../../orders/model' // F-CM-103: a new read's problem as an `orders` key
import { LIVE_COALESCE_MS, moneyChangeIsOurs, type OpenItemsRead } from '../record/money/model' // F-CM-103
import { customerMoneyCanOf, overdueByParty } from './model'
import type { CustomerMoneyModel } from './overview'

const BUILT = new Set(OFFICE_PAGES)

/** The list's Overdue column: one read of every customer with money late in the company (only with receivables.view and the price grain). */
export function useOverdueList(): OverdueListModel {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => customerMoneyCanOf(session.permissions), [session.permissions])
  const [state, setState] = useState<{ byParty: OverdueListModel['byParty']; problem: string | null; complete?: boolean }>({ byParty: null, problem: null })
  useEffect(() => {
    if (!can.receivables || !can.price) return
    const abort = new AbortController()
    // F-CL-202 (C1-B1): every company the reader reaches and every page (≤ 5 × 500) — never "none" for a customer late elsewhere.
    getOverdueCustomers(api, abort.signal)
      .then((ageing) => setState({ byParty: overdueByParty(ageing.customers), problem: null, complete: ageing.complete }))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setState({ byParty: null, problem: readProblem(error) })
      })
    return () => abort.abort()
  }, [api, can.receivables, can.price])
  return useMemo(() => ({ can, ...state }), [can, state])
}

/**
 * The record's Overdue, Returns this year and open returns and claims: three reads beside the party, each with its permission.
 * F-CM-103 (customer MONEY tab, cm-w1 W1.2; 13-backend §1.3, §5.2): the ageing is asked WITHOUT the company term (every company the
 * reader reaches: one customer's own rows) and split by company — `ageing` keeps its shape (this company's rows), `ageingElsewhere`
 * holds the others ("Also owes Seed Company B ›", 0 new requests); the open items become a page read (payments.view: the tab's count,
 * To collect, the money on account); the money reads (ageing, open items, the open orders' money) read again by themselves when this
 * customer's money moves (ONE coalesced re-read; on a reconnect too), keeping what they show while they read. Every read names THIS
 * customer (`partyId`); nothing is filtered by customer here.
 */
export function useCustomerMoney(partyId: string, prefix: string): CustomerMoneyModel {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => customerMoneyCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const [ageing, setAgeing] = useState<Loaded<AgeingRow>>(loading())
  const [ageingElsewhere, setAgeingElsewhere] = useState<Loaded<AgeingRow>>(loading()) // F-CM-103
  const [readAt, setReadAt] = useState<string | null>(null) // F-CM-103
  const [openItems, setOpenItems] = useState<{ readonly value: OpenItemsRead | null; readonly problem: string | null }>({ value: null, problem: null }) // F-CM-103
  const [returns, setReturns] = useState<Loaded<CustomerReturn>>(loading())
  const [complaints, setComplaints] = useState<Loaded<CustomerComplaint>>(loading())
  const [orders, setOrders] = useState<Loaded<OpenOrderMoney>>(loading()) // F-SA-273: the Money tab's deposits and balances
  const [round, setRound] = useState(0) // F-CM-103: a live burst or a Try again reads the money again
  useEffect(() => {
    const abort = new AbortController()
    const live = () => !abort.signal.aborted
    if (can.returns)
      listCustomerReturns(api, partyId, abort.signal)
        .then((value) => live() && setReturns(loaded(value.returns, value.truncated)))
        .catch((error: unknown) => live() && setReturns(failed(readProblem(error))))
    if (can.complaints)
      listCustomerComplaints(api, partyId, abort.signal)
        .then((value) => live() && setComplaints(loaded(value)))
        .catch((error: unknown) => live() && setComplaints(failed(readProblem(error))))
    return () => abort.abort()
  }, [api, partyId, can.returns, can.complaints])
  useEffect(() => {
    const abort = new AbortController()
    const live = () => !abort.signal.aborted
    if (can.receivables)
      // F-CM-103: every company the reader reaches, then split: this company's rows keep the field's name and shape.
      getCustomerAgeing(api, partyId, null, abort.signal)
        .then((value) => {
          if (!live()) return
          const here = companyId ? value.customers.filter((row) => row.company.id === companyId) : value.customers
          setAgeing(loaded(here))
          setAgeingElsewhere(loaded(companyId ? value.customers.filter((row) => row.company.id !== companyId) : []))
          setReadAt(value.readAt)
        })
        .catch((error: unknown) => {
          if (!live()) return
          setAgeing(failed(readProblem(error)))
          setAgeingElsewhere(failed(readProblem(error)))
        })
    // F-CM-103: the open items and the money on account of this customer in this company (payments.view).
    if (can.payments && companyId)
      openItemsFor(api, { companyId, partyId }, abort.signal)
        .then((value) => live() && setOpenItems({ value: { items: value.items, creditBalance: value.creditBalance }, problem: null }))
        .catch((error: unknown) => live() && setOpenItems({ value: null, problem: readOrderProblem(error) }))
    // F-SA-273: the open orders' deposits and balances (orders.view; amounts with the price grain).
    if (can.orders)
      listOpenOrderMoney(api, partyId, abort.signal)
        .then((value) => live() && setOrders(loaded(value.orders, value.more)))
        .catch((error: unknown) => live() && setOrders(failed(readProblem(error))))
    return () => abort.abort()
  }, [api, partyId, companyId, can.receivables, can.payments, can.orders, round])
  // F-CM-103: this customer's money moved (the live rule, model.ts) → ONE re-read of the money reads; a reconnect → the same.
  const held = useRef<ReadonlySet<string>>(new Set())
  held.current = new Set((openItems.value?.items ?? []).map((item) => item.id))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setRound((now) => now + 1)
  }, [])
  const burst = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(reload, LIVE_COALESCE_MS)
  }, [reload])
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])
  useLiveBus({ onChange: (change) => (moneyChangeIsOurs(change, partyId, held.current) ? burst() : undefined), onReconnect: burst }, can.receivables || !!can.payments || !!can.orders)
  const returnsList = listAddress('/sales/returns', { partyId }, BUILT)
  return useMemo(
    () => ({
      can,
      prefix,
      partyId,
      year: romeToday().slice(0, 4),
      ageing,
      returns,
      complaints,
      orders /* F-SA-273 */,
      returnsHref: returnsList ? `${prefix}${returnsList}` : null,
      // F-CM-103: the other companies' rows, the open items (null without payments.view or a company), the read's time, Try again.
      ageingElsewhere,
      openItems: can.payments && companyId ? openItems : null,
      readAt,
      reload,
    }),
    [can, prefix, partyId, ageing, returns, complaints, orders, returnsList, ageingElsewhere, openItems, companyId, readAt, reload],
  )
}
