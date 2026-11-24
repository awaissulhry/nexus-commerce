'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOfficeApi } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { openRefunds, type OpenRefunds } from '../../../../finance/payments/refunds/api'
import { listReminders, type Reminder } from '../../../../finance/receivables/api'
import { listInvoices } from '../../../../finance/_shared/api' // F-CM-202
import { listStops, type ReminderStop } from '../../../../finance/receivables/reminder-stops/api'
import { getOrderSummary, type OrderSummary } from '../../../orders/api'
import { readProblem } from '../../../orders/model'
import { shippedOfCustomer } from './api'
import { documentQueryOf, DOCUMENTS_READ, type DocumentChip, type DocumentsRead } from './documents' // F-CM-202
import { LIVE_COALESCE_MS, moneyChangeIsOurs, partReady, READING, TAB_READS, type LazyRead, type MoneyTabCan, type Part, type ShippedNotInvoiced, type TabRead } from './model'

/**
 * F-CM-103 (customer page › MONEY tab, cm-w1 W1.2; 13-backend §1.4, §5.2) — the tab's OWN reads, made only while the tab is shown, each
 * with its right (a read the reader may not make is `null`: its part is left out), its own state (reading · ready · failed with an
 * `orders` problem key) and its own Try again. First paint makes the five that make "What needs you · N" whole at once: refunds to make,
 * stops in force, reminders, the open orders' figures, shipped not invoiced (the page already reads the ageing, the open items, the
 * glance and the price counts). Every call names THIS customer (`partyId`) and the company the page works in; nothing is filtered by
 * customer here. Live: a money event of this customer (the rule in model.ts) → ONE coalesced re-read of these reads, keeping what they
 * show while they read; a reconnect → the same.
 */

export interface CustomerMoneyTabReads {
  readonly refunds: Part<OpenRefunds> | null
  readonly stops: Part<readonly ReminderStop[]> | null
  readonly reminders: Part<readonly Reminder[]> | null
  readonly summary: Part<OrderSummary> | null
  readonly shipped: Part<ShippedNotInvoiced | null> | null
  /** A section's Try again: that read again. */
  readonly retry: (read: TabRead | LazyRead) => void
  /** F-CM-201: after a write in place, every read of the tab again (keeping what it shows while it reads). */
  readonly reload: () => void
  // ── F-CM-202: the reads made when their section nears the room ──
  /** A section came near: make its read (once; later bursts read it again). */
  readonly want: (read: LazyRead) => void
  /** Every document of the customer under the chip (invoices.view; null without it), the pages read so far. */
  readonly documents: Part<DocumentsRead> | null
  readonly chip: DocumentChip
  readonly onChip: (chip: DocumentChip) => void
  /** The documents' next page (the read's cursor). */
  readonly moreDocuments: () => void
}

/** At most this many reminders of the customer (the read's own page cap). */
const REMINDERS_READ = 200

export function useCustomerMoneyTab(input: { readonly partyId: string; readonly companyId: string | null; readonly currency: string | null; readonly can: MoneyTabCan; readonly heldIds: readonly string[] }): CustomerMoneyTabReads {
  const api = useOfficeApi()
  const { partyId, companyId, currency, can } = input
  const allowed: Record<TabRead, boolean> = useMemo(
    () => ({ refunds: can.payments, stops: can.receivables, reminders: can.receivables, summary: can.orders, shipped: can.invoices }),
    [can.payments, can.receivables, can.orders, can.invoices],
  )
  const [refunds, setRefunds] = useState<Part<OpenRefunds>>(READING)
  const [stops, setStops] = useState<Part<readonly ReminderStop[]>>(READING)
  const [reminders, setReminders] = useState<Part<readonly Reminder[]>>(READING)
  const [summary, setSummary] = useState<Part<OrderSummary>>(READING)
  const [shipped, setShipped] = useState<Part<ShippedNotInvoiced | null>>(READING)
  const aborts = useRef(new Map<TabRead, AbortController>())

  const load = useCallback(
    (read: TabRead, again: boolean) => {
      if (!allowed[read]) return
      aborts.current.get(read)?.abort()
      const abort = new AbortController()
      aborts.current.set(read, abort)
      const live = () => !abort.signal.aborted
      const fail = (set: (part: Part<never>) => void) => (error: unknown) => live() && set({ value: null, problem: readProblem(error) })
      // A Try again shows the part reading; a live re-read keeps what it shows until the answer arrives.
      if (read === 'refunds') {
        if (!again) setRefunds(READING)
        openRefunds(api, abort.signal, { companyId, partyId })
          .then((value) => live() && setRefunds(partReady(value)))
          .catch(fail(setRefunds))
      } else if (read === 'stops') {
        if (!again) setStops(READING)
        listStops(api, { ...(companyId ? { companyId } : {}), partyId, state: 'holding' }, abort.signal)
          .then((value) => live() && setStops(partReady(value)))
          .catch(fail(setStops))
      } else if (read === 'reminders') {
        if (!again) setReminders(READING)
        listReminders(api, { companyId, partyId, view: 'all', limit: REMINDERS_READ }, abort.signal)
          .then((value) => live() && setReminders(partReady(value.reminders)))
          .catch(fail(setReminders))
      } else if (read === 'summary') {
        if (!again) setSummary(READING)
        getOrderSummary(api, { partyId, companyId, open: true }, null, abort.signal)
          .then((value) => live() && setSummary(partReady(value)))
          .catch(fail(setSummary))
      } else {
        if (!again) setShipped(READING)
        shippedOfCustomer(api, { companyId, partyId, currency }, abort.signal)
          .then((value) => live() && setShipped(partReady(value)))
          .catch(fail(setShipped))
      }
    },
    [allowed, api, companyId, currency, partyId],
  )

  useEffect(() => {
    const running = aborts.current
    for (const read of TAB_READS) load(read, false)
    return () => {
      for (const abort of running.values()) abort.abort()
      running.clear()
    }
  }, [load])

  // ── F-CM-202: the lazy reads — made once their section nears the room, read again by a burst once made ──
  const [wanted, setWanted] = useState<ReadonlySet<LazyRead>>(() => new Set())
  const want = useCallback((read: LazyRead) => setWanted((now) => (now.has(read) ? now : new Set([...now, read]))), [])
  const [chip, setChip] = useState<DocumentChip>('all')
  const [documents, setDocuments] = useState<Part<DocumentsRead>>(READING)
  const documentsAbort = useRef<AbortController | null>(null)
  const loadDocuments = useCallback(
    (mode: 'first' | 'again' | 'next', cursor: string | null) => {
      if (!can.invoices) return
      documentsAbort.current?.abort()
      const abort = new AbortController()
      documentsAbort.current = abort
      if (mode === 'first') setDocuments(READING)
      const terms = documentQueryOf(chip)
      listInvoices(api, { partyId, companyId, docType: terms.docType, status: terms.status, limit: DOCUMENTS_READ, cursor }, abort.signal)
        .then((page) => !abort.signal.aborted && setDocuments((was) => partReady({ rows: mode === 'next' ? [...(was.value?.rows ?? []), ...page.invoices] : page.invoices, next: page.nextCursor })))
        .catch((error: unknown) => !abort.signal.aborted && setDocuments({ value: null, problem: readProblem(error) }))
    },
    [api, can.invoices, chip, companyId, partyId],
  )
  const wantsDocuments = wanted.has('documents')
  useEffect(() => {
    if (wantsDocuments) loadDocuments('first', null)
  }, [wantsDocuments, loadDocuments])
  useEffect(() => () => documentsAbort.current?.abort(), [])
  const lazyNow = useRef({ wanted, loadDocuments })
  lazyNow.current = { wanted, loadDocuments }
  const againLazy = useCallback(() => {
    if (lazyNow.current.wanted.has('documents')) lazyNow.current.loadDocuments('again', null)
  }, [])
  const moreDocuments = useCallback(() => {
    const next = documents.value?.next ?? null
    if (next) loadDocuments('next', next)
  }, [documents.value?.next, loadDocuments])
  // ── end F-CM-202 ──

  // Live: this customer's money moved → ONE re-read of the tab's reads (coalesced).
  const held = useRef<ReadonlySet<string>>(new Set())
  held.current = new Set([...input.heldIds, ...(refunds.value?.refundsDue ?? []).map((refund) => refund.id), ...(refunds.value?.creditNotesToRefund ?? []).map((note) => note.creditNoteId)])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const burst = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      for (const read of TAB_READS) load(read, true)
      againLazy() // F-CM-202
    }, LIVE_COALESCE_MS)
  }, [load, againLazy])
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])
  useLiveBus({ onChange: (change) => (moneyChangeIsOurs(change, partyId, held.current) ? burst() : undefined), onReconnect: burst })

  const retry = useCallback((read: TabRead | LazyRead) => (read === 'documents' ? loadDocuments('first', null) : load(read, false)), [load, loadDocuments])
  const reload = useCallback(() => {
    for (const read of TAB_READS) load(read, true)
    againLazy() // F-CM-202
  }, [load, againLazy])
  return useMemo(
    () => ({
      refunds: allowed.refunds ? refunds : null,
      stops: allowed.stops ? stops : null,
      reminders: allowed.reminders ? reminders : null,
      summary: allowed.summary ? summary : null,
      shipped: allowed.shipped ? shipped : null,
      retry,
      reload,
      want,
      documents: can.invoices ? documents : null,
      chip,
      onChip: setChip,
      moreDocuments,
    }),
    [allowed, refunds, stops, reminders, summary, shipped, retry, reload, want, can.invoices, documents, chip, moreDocuments],
  )
}
