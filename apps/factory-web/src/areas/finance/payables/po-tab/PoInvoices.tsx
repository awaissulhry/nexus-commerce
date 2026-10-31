'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { listInvoices, type InvoiceRow } from '../api'
import { payablesCanOf, readProblem } from '../model'
import { PoInvoicesView } from './view/PoInvoicesView'

/**
 * The PO studio's Invoices tab (purchasing/orders/record mounts it, `?tab=invoices`): reads the supplier invoices with a
 * line on this order (`GET /payables/invoices?purchaseOrderId=`, the newest 50). Without payables.view it asks nothing.
 */
export function PoInvoices({ orderId, prefix }: { orderId: string; prefix: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => payablesCanOf(session.permissions), [session.permissions])
  const [rows, setRows] = useState<InvoiceRow[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  const load = useCallback(async () => {
    if (!can.view) return
    setProblem(null)
    try {
      const page = await listInvoices(api, { purchaseOrderId: orderId, limit: 50 })
      setRows(page.items)
      setMore(page.nextCursor !== null)
    } catch (error) {
      setRows(null)
      setProblem(readProblem(error))
    }
  }, [api, orderId, can.view])

  useEffect(() => {
    void load()
  }, [load])

  return <PoInvoicesView model={{ prefix, view: can.view, cost: can.cost, rows, problem, more }} onRetry={() => void load()} />
}
