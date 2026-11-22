'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { problemKey } from '../../quality/_shared/model'
import { createReturn, listCustomers, listReturnable, listReturnReasons, previewReturn, type PartyOption } from './api'
import { BLANK_RETURN, newReturnBody, newReturnProblems, refusalOf, type NewReturnDraft } from './model'
import type { NewReturnActions, NewReturnModel } from './view-model'

/**
 * F-OS-303 (order SHIPMENTS tab; 13-backend §7 "Open a return…"; 18-lead-settles L8) — Sales › Returns' New return, extracted from
 * ReturnsPage (its state, never its look: NewReturnModal stays the one window) so the order's Shipments tab opens the SAME window in
 * place. `open()` starts it blank (Returns' own page); `open(seed)` starts it for one customer and order and, from a shipment's row,
 * offers that shipment's lines only (the returnable read's `shipmentId`, B-OS-005 — a return line names no shipment, so the return
 * itself records none). Reads the customers (parties.view; a seeded one is the only choice), the reasons, what may come back, a preview
 * while typing; ONE create with its Idempotency-Key. `onCreated` says where it went (Returns opens it; the tab reads its list again).
 */

/** What an opener knows already: the customer (fixed), its order, and the shipment whose lines it offers. */
export interface NewReturnSeed {
  readonly party: PartyOption
  readonly salesOrderId?: string
  readonly shipmentId?: string
}

/** The window's first draft: blank, or the seed's customer and order. */
export function newReturnDraftOf(seed?: NewReturnSeed): NewReturnDraft {
  return seed ? { ...BLANK_RETURN, partyId: seed.party.id, salesOrderId: seed.salesOrderId ?? '' } : BLANK_RETURN
}

/** The returnable read's query: the customer, and the seed's shipment when it came from a shipment's row (L8). */
export function returnableQueryOf(companyId: string, partyId: string, shipmentId: string | null): { companyId: string; partyId: string; shipmentId?: string } {
  return { companyId, partyId, ...(shipmentId ? { shipmentId } : {}) }
}

export function useNewReturn(input: {
  readonly api: ApiClient
  readonly companyId: string
  readonly today: string
  readonly can: { readonly partiesView: boolean; readonly price: boolean }
  readonly onCreated: (created: { readonly id: string; readonly number: string }) => void
}): { model: NewReturnModel | null; open: (seed?: NewReturnSeed) => void; actions: Required<Pick<NewReturnActions, 'onNewReturnDraft' | 'onNewReturnLine' | 'onNewReturnSubmit' | 'onNewReturnClose'>> } {
  const { api, companyId, today, can } = input
  const created = useRef(input.onCreated)
  created.current = input.onCreated
  const [newReturn, setNewReturn] = useState<NewReturnModel | null>(null)
  const [shipmentId, setShipmentId] = useState<string | null>(null)
  const returnKey = useRef<string | null>(null)

  const open = useCallback(
    (seed?: NewReturnSeed) => {
      returnKey.current = newIdempotencyKey()
      setShipmentId(seed?.shipmentId ?? null)
      // A seeded customer is the only choice (the opener's order names it); else the customers this person may read.
      const customers = seed ? { items: [seed.party], problem: null } : { items: null, problem: can.partiesView ? null : 'newReturn.customerNoRight' }
      setNewReturn({ draft: newReturnDraftOf(seed), customers, returnable: { value: null, loading: false, problem: null }, reasons: null, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today, price: can.price })
      if (!seed && can.partiesView)
        listCustomers(api)
          .then((items) => setNewReturn((current) => (current ? { ...current, customers: { items, problem: null } } : current)))
          .catch((error) => setNewReturn((current) => (current ? { ...current, customers: { items: null, problem: `quality:${problemKey(error)}` } } : current)))
      listReturnReasons(api)
        .then((reasons) => setNewReturn((current) => (current ? { ...current, reasons } : current)))
        .catch(() => setNewReturn((current) => (current ? { ...current, reasons: [] } : current)))
    },
    [api, can.partiesView, can.price, today],
  )

  const partyId = newReturn?.draft.partyId ?? ''
  useEffect(() => {
    if (!partyId || !companyId) return
    setNewReturn((current) => (current ? { ...current, returnable: { value: null, loading: true, problem: null }, preview: null } : current))
    listReturnable(api, returnableQueryOf(companyId, partyId, shipmentId))
      .then((value) => setNewReturn((current) => (current && current.draft.partyId === partyId ? { ...current, returnable: { value, loading: false, problem: null } } : current)))
      .catch((error) => setNewReturn((current) => (current ? { ...current, returnable: { value: null, loading: false, problem: `quality:${problemKey(error)}` } } : current)))
  }, [api, companyId, partyId, shipmentId])

  // The preview while typing (debounced): what the API would make, its problems by place.
  const returnDraftKey = newReturn ? JSON.stringify(newReturn.draft) : ''
  const hasReturnable = !!newReturn?.returnable.value
  useEffect(() => {
    if (!newReturn || !newReturn.returnable.value) return
    const body = newReturnBody(newReturn.draft, newReturn.returnable.value.lines, companyId)
    if (body.lines.length === 0) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setNewReturn((current) => (current ? { ...current, previewing: true } : current))
      previewReturn(api, body, controller.signal)
        .then((preview) => setNewReturn((current) => (current ? { ...current, preview, previewing: false } : current)))
        .catch(() => setNewReturn((current) => (current ? { ...current, previewing: false } : current)))
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // The draft's text is the dependency (the model object changes on every answer).
  }, [api, companyId, returnDraftKey, hasReturnable])

  const submit = useCallback(async () => {
    const current = newReturn
    if (!current || current.busy) return
    const returnable = current.returnable.value?.lines ?? null
    const problems = newReturnProblems(current.draft, returnable)
    if (problems.length > 0 || !returnable || (current.preview && !current.preview.ok)) {
      setNewReturn({ ...current, showProblems: true })
      return
    }
    setNewReturn({ ...current, busy: true, problem: null })
    try {
      const answer = await createReturn(api, newReturnBody(current.draft, returnable, companyId), returnKey.current ?? newIdempotencyKey())
      setNewReturn(null)
      created.current({ id: answer.return.id, number: answer.return.number })
    } catch (error) {
      setNewReturn((latest) => (latest ? { ...latest, busy: false, showProblems: true, problem: refusalOf(error) } : latest))
    }
  }, [api, companyId, newReturn])

  const actions = useMemo(
    () => ({
      onNewReturnDraft: (patch: Partial<NewReturnDraft>) => setNewReturn((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
      onNewReturnLine: (key: string, patch: Partial<NewReturnDraft['lines'][string]>) =>
        setNewReturn((current) => {
          if (!current) return current
          const before = current.draft.lines[key] ?? { quantity: '', reasonCode: '', note: '' }
          return { ...current, draft: { ...current.draft, lines: { ...current.draft.lines, [key]: { ...before, ...patch } } } }
        }),
      onNewReturnSubmit: () => void submit(),
      onNewReturnClose: () => setNewReturn(null),
    }),
    [submit],
  )

  return { model: newReturn, open, actions }
}
