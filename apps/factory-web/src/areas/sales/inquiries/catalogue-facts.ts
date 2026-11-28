'use client'

import { useEffect, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import type { Translate } from '../../../lib/i18n/messages'
import type { IncomingRow } from './api'
import { readSheet, type SheetRowRead } from '../orders/list/office-sheet/api'

/**
 * owb-of4 step 1 — Incoming's catalogue rows (the orders a customer SENT), with the facts of the office sheet's read (owb-of1 Shape,
 * `GET /sales/orders/sheet?life=incoming`; Incoming's own read names none of them): the picture (the request's, the batch read
 * already draws it), "Sent as text · product not picked" or "n details still open", the flag "Customer on hold", and ONE door
 * Confirm the order… — THE Confirm window (owb-of5 `ConfirmOrderWindow`: the promised day, the open details, A-5). Bulk Confirm walks
 * the same window one order at a time, skips text orders and the ones that hold, and says how many. Pure, apart from the read hook.
 */

export interface CatalogueFacts {
  readonly sentAsText: boolean
  readonly openDetails: number
  readonly customerOnHold: boolean
  /** The reader may confirm it (orders.manage over it: the read's own `may.confirm`). */
  readonly mayConfirm: boolean
  /** A line without a product (A-5: Confirm needs a product on every line), or the customer on hold. */
  readonly holds: boolean
}

export function catalogueFactsOf(row: Pick<SheetRowRead, 'news' | 'customerOnHold' | 'may' | 'lines'>): CatalogueFacts {
  return {
    sentAsText: row.news.sentAsText,
    openDetails: row.news.openDetails,
    customerOnHold: row.customerOnHold,
    mayConfirm: row.may.confirm,
    holds: row.customerOnHold || row.lines.some((line) => line.product === null),
  }
}

/** The facts by request id (only the Sent requests of the sheet read). */
export function factsByIdOf(rows: readonly SheetRowRead[]): ReadonlyMap<string, CatalogueFacts> {
  return new Map(rows.filter((row) => row.kind === 'REQUEST' && row.life === 'SENT').map((row) => [row.id, catalogueFactsOf(row)]))
}

/** The row's words: "Sent as text · product not picked", else "n details still open", else none (`orders-sheet` › `incoming.*`). */
export function factsWordsOf(facts: CatalogueFacts, t: Translate): string | null {
  if (facts.sentAsText) return t('incoming.sentAsText')
  if (facts.openDetails > 0) return t('incoming.openDetails', { count: facts.openDetails })
  return null
}

/** A row that offers "Confirm the order…": a SENT catalogue order the reader may confirm (a text order too: the window picks its product). */
export const offersConfirm = (row: Pick<IncomingRow, 'kind' | 'catalogueOrder'>, facts: CatalogueFacts | undefined, ordersManage: boolean): boolean =>
  ordersManage && row.kind === 'CATALOGUE_ORDER' && row.catalogueOrder?.status === 'SENT' && !!facts?.mayConfirm

/** Bulk Confirm over the ticked rows: Sent catalogue orders; text orders and the ones that hold are skipped and counted. */
export function catalogueConfirmPlan(picked: readonly IncomingRow[], facts: ReadonlyMap<string, CatalogueFacts>): { readonly go: IncomingRow[]; readonly text: number; readonly held: number; readonly other: number } {
  const go: IncomingRow[] = []
  let text = 0
  let held = 0
  let other = 0
  for (const row of picked) {
    const known = facts.get(row.id)
    if (row.kind !== 'CATALOGUE_ORDER' || row.catalogueOrder?.status !== 'SENT' || !known?.mayConfirm) other++
    else if (known.sentAsText) text++
    else if (known.holds) held++
    else go.push(row)
  }
  return { go, text, held, other }
}

/** What Confirm did, counted (the view says it in words): confirmed, skipped (text, holds, not Sent), refused, left for later. */
export interface CatalogueConfirmed {
  readonly done: number
  readonly text: number
  readonly held: number
  readonly other: number
  readonly refused: number
  /** Still in the run when the person closed the window (confirm them later). */
  readonly left: number
}

/**
 * A Confirm run through THE Confirm window: the requests still to confirm (the first one is in the window), what was confirmed and what
 * the plan skipped. One door = a run of one; bulk Confirm = a run of the plan's orders, one window after the other.
 */
export interface ConfirmRun {
  readonly queue: readonly string[]
  readonly done: number
  readonly text: number
  readonly held: number
  readonly other: number
}

export const confirmRunOne = (requestId: string): ConfirmRun => ({ queue: [requestId], done: 0, text: 0, held: 0, other: 0 })

export const confirmRunOf = (plan: { readonly go: readonly Pick<IncomingRow, 'id'>[]; readonly text: number; readonly held: number; readonly other: number }): ConfirmRun => ({ queue: plan.go.map((row) => row.id), done: 0, text: plan.text, held: plan.held, other: plan.other })

/** The window confirmed its order: the next one comes (an empty queue ends the run). */
export const afterConfirmed = (run: ConfirmRun): ConfirmRun => ({ ...run, queue: run.queue.slice(1), done: run.done + 1 })

/** The run's receipt: what was confirmed and skipped; what is still in the queue is left for later (the person closed the window). */
export const receiptOf = (run: ConfirmRun): CatalogueConfirmed => ({ done: run.done, text: run.text, held: run.held, other: run.other, refused: 0, left: run.queue.length })

/** A receipt says something only when an order was confirmed or one was skipped (a window closed at once says nothing). */
export const receiptSays = (receipt: CatalogueConfirmed): boolean => receipt.done + receipt.text + receipt.held + receipt.other + receipt.refused > 0

/** The facts of the Sent orders, read again when Incoming reads (its `tick`); none for a reader without orders.view. */
export function useCatalogueFacts(api: ApiClient, enabled: boolean, partyId: string | null, tick: string | number | null): ReadonlyMap<string, CatalogueFacts> {
  const [facts, setFacts] = useState<ReadonlyMap<string, CatalogueFacts>>(() => new Map())
  useEffect(() => {
    if (!enabled) return
    const control = new AbortController()
    readSheet(api, { life: 'incoming', q: '', partyId, cursor: null, limit: 100 }, control.signal)
      .then((answer) => !control.signal.aborted && setFacts(factsByIdOf(answer.rows)))
      .catch(() => undefined)
    return () => control.abort()
  }, [api, enabled, partyId, tick])
  return facts
}
