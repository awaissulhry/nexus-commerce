'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { listContacts, listCustomers, listOrders, listReturns, listShipments, listStyles, logComplaint, previewComplaint, uploadPhoto, type PartyOption } from './api'
import { blankLogDraft, logBody, logProblems, refusalKey, withPreview, type ComplaintsCan, type LogDraft } from './model'
import type { LogActions, LogModel } from './view-model'

/**
 * F-OS-303 (order SHIPMENTS tab; 13-backend §7 "Log a complaint…") — Quality › Complaints' Log complaint, extracted from ComplaintsPage
 * (its state, never its look: LogComplaintModal stays the one window) so the order's Shipments tab opens the SAME window in place.
 * `open()` starts it blank (the Complaints page's `?new=1`); `open(seed)` starts it for one customer, its order and, from a shipment's
 * row, that shipment (the create takes `shipmentId`). Reads the customers (parties.view; a seeded one is the only choice), the styles,
 * then the customer's contacts, orders, shipments and returns (each with its own right); a look-up of what a serial or the customer
 * finds; ONE create with its Idempotency-Key, then the customer's photos. `onLogged` says where it went (the page opens it; the tab reads
 * its list again).
 */

/** What an opener knows already: the customer (fixed), its order, and the shipment it is about. */
export interface LogComplaintSeed {
  readonly party: PartyOption
  readonly salesOrderId?: string
  readonly shipmentId?: string
}

/** The window's first draft: blank, or the seed's customer, order and shipment. */
export function logDraftOf(today: string, seed?: LogComplaintSeed): LogDraft {
  const blank = blankLogDraft(today)
  return seed ? { ...blank, partyId: seed.party.id, salesOrderId: seed.salesOrderId ?? '', shipmentId: seed.shipmentId ?? '' } : blank
}

export function useLogComplaint(input: {
  readonly api: ApiClient
  readonly companyId: string
  readonly today: string
  readonly can: Pick<ComplaintsCan, 'partiesView' | 'stylesView' | 'ordersView' | 'shippingView' | 'returnsView' | 'filesUpload'>
  readonly onLogged: (complaint: { readonly id: string; readonly number: string }, failedPhotos: number) => void
}): { model: LogModel | null; open: (seed?: LogComplaintSeed) => void; close: () => void; actions: Required<Pick<LogActions, 'onLogDraft' | 'onLogLookUp' | 'onLogSubmit'>> } {
  const { api, companyId, today, can } = input
  const logged = useRef(input.onLogged)
  logged.current = input.onLogged
  const [log, setLog] = useState<LogModel | null>(null)
  const logKey = useRef<string | null>(null)
  const previewRead = useRef(0)

  const open = useCallback(
    (seed?: LogComplaintSeed) => {
      logKey.current = null
      setLog({
        draft: logDraftOf(today, seed),
        // A seeded customer is the only choice (the opener's order names it); else the customers this person may read.
        customers: seed ? { items: [seed.party], problem: null } : { items: null, problem: can.partiesView ? null : 'log.customerNoRight' },
        contacts: null,
        orders: null,
        shipments: null,
        returns: null,
        styles: null,
        preview: null,
        previewing: false,
        showProblems: false,
        busy: false,
        problem: null,
        today,
        canPhotos: can.filesUpload,
      })
      if (!seed && can.partiesView) {
        listCustomers(api)
          .then((items) => setLog((current) => (current ? { ...current, customers: { items, problem: null } } : current)))
          .catch((error) => setLog((current) => (current ? { ...current, customers: { items: null, problem: refusalKey(error) } } : current)))
      }
      if (can.stylesView) {
        listStyles(api)
          .then((items) => setLog((current) => (current ? { ...current, styles: items } : current)))
          .catch(() => undefined)
      }
    },
    [api, can.partiesView, can.stylesView, can.filesUpload, today],
  )
  const close = useCallback(() => setLog(null), [])

  // The customer's contacts, orders, shipments and returns when the customer changes (each with its own right).
  const logParty = log?.draft.partyId ?? ''
  useEffect(() => {
    if (!logParty) {
      setLog((current) => (current ? { ...current, contacts: null, orders: null, shipments: null, returns: null } : current))
      return
    }
    const controller = new AbortController()
    const fill = <K extends 'contacts' | 'orders' | 'shipments' | 'returns'>(key: K, allowed: boolean, read: () => Promise<NonNullable<LogModel[K]>>) => {
      if (!allowed) return
      read()
        .then((items) => setLog((current) => (current && current.draft.partyId === logParty ? { ...current, [key]: items } : current)))
        .catch(() => setLog((current) => (current && current.draft.partyId === logParty ? { ...current, [key]: null } : current)))
    }
    fill('contacts', can.partiesView, () => listContacts(api, logParty, controller.signal))
    fill('orders', can.ordersView, () => listOrders(api, logParty, controller.signal))
    fill('shipments', can.shippingView, () => listShipments(api, logParty, controller.signal))
    fill('returns', can.returnsView, () => listReturns(api, logParty, controller.signal))
    return () => controller.abort()
  }, [api, logParty, can.partiesView, can.ordersView, can.shippingView, can.returnsView])

  const lookUp = useCallback(async () => {
    if (!log) return
    const read = ++previewRead.current
    setLog({ ...log, previewing: true })
    try {
      const body = logBody({ ...log.draft, description: log.draft.description || ' ' }, companyId, today)
      const preview = await previewComplaint(api, {
        companyId,
        ...(body.partyId ? { partyId: body.partyId } : {}),
        ...(body.serial ? { serial: body.serial } : {}),
        ...(body.salesOrderId ? { salesOrderId: body.salesOrderId } : {}),
        ...(body.shipmentId ? { shipmentId: body.shipmentId } : {}),
        ...(body.styleId ? { styleId: body.styleId } : {}),
        ...(body.batchNumber ? { batchNumber: body.batchNumber } : {}),
      })
      if (read !== previewRead.current) return
      setLog((current) => (current ? { ...current, preview, previewing: false, draft: withPreview(current.draft, preview) } : current))
    } catch (error) {
      if (read !== previewRead.current) return
      setLog((current) => (current ? { ...current, previewing: false, problem: refusalKey(error) } : current))
    }
  }, [api, companyId, log, today])

  const submit = useCallback(async () => {
    if (!log || log.busy) return
    if (logProblems(log.draft, today).length > 0) {
      setLog({ ...log, showProblems: true })
      return
    }
    setLog({ ...log, busy: true, problem: null })
    logKey.current ??= newIdempotencyKey()
    try {
      const answer = await logComplaint(api, logBody(log.draft, companyId, today), logKey.current)
      const complaint = answer.complaint
      let failed = 0
      for (const photo of log.draft.photos) {
        try {
          await uploadPhoto(api, complaint, photo)
        } catch {
          failed += 1
        }
      }
      logKey.current = null
      setLog(null)
      logged.current(complaint, failed)
    } catch (error) {
      logKey.current = null
      setLog((current) => (current ? { ...current, busy: false, problem: refusalKey(error) } : current))
    }
  }, [api, companyId, log, today])

  const actions = useMemo(
    () => ({
      onLogDraft: (patch: Partial<LogDraft>) => {
        logKey.current = null
        setLog((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, ...(patch.serial !== undefined || patch.partyId !== undefined ? { preview: patch.partyId !== undefined ? null : current.preview } : {}) } : current))
      },
      onLogLookUp: () => void lookUp(),
      onLogSubmit: () => void submit(),
    }),
    [lookUp, submit],
  )

  return { model: log, open, close, actions }
}
