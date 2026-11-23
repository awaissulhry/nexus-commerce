import type { ApiClient } from '../../../../lib/api/client'
import { askApproval, cancelQuote, makeOrderFromQuote, sendNewLink } from '../api'
import { refusedWords, type ManyAct } from '../../_shared/many-acts/model'
import { bo, CANCELLABLE_QUOTES, orderMakeable, type QuoteActKind, type QuoteRecord } from './bar'

/**
 * F-CQ-202 (customer page › Quotes & incoming, 10-design §8; settles C12, C36) — the Quotes list's loops in the ONE many-acts window,
 * on both hosts: Cancel N quotes (a sent one's reason; a firm offer named), Ask for approval on N drafts, Make the orders for N
 * accepted quotes whose order waits (the PO number typed where the terms need one), Send a new link to N sent quotes — one quote after
 * the other with its own version and one batchId. The container builds them (they call the API); the bar is bar.ts.
 */

/** The loops of the window (F-CQ-202), built over the ticked quotes. `day` says a date in the reader's words. */
export function quoteActOf(kind: Exclude<QuoteActKind, 'addTask'>, api: ApiClient, picked: readonly QuoteRecord[], day: (date: string) => string): ManyAct<QuoteRecord> {
  if (kind === 'cancel') {
    const sent = picked.filter((row) => row.status === 'SENT').length
    return {
      kind,
      danger: true,
      title: { ns: 'sales', key: 'list.bulk.cancelTitle', params: { count: picked.filter((row) => CANCELLABLE_QUOTES.includes(row.status)).length } },
      go: { ns: 'sales', key: 'list.bulk.cancel', params: { count: picked.filter((row) => CANCELLABLE_QUOTES.includes(row.status)).length } },
      body: sent > 0 ? { ns: 'sales', key: 'list.bulk.cancelBodySent', params: { count: sent } } : { ns: 'sales', key: 'list.bulk.cancelBody' },
      notOn: (row) => (CANCELLABLE_QUOTES.includes(row.status) ? null : bo('acts.why.quoteClosed')),
      text: (runs) => ({ label: { ns: 'sales', key: 'dialog.reason' }, required: runs.some((row) => row.status === 'SENT'), min: 3, max: 500 }),
      run: async (row, input) => {
        try {
          await cancelQuote(api, row, input.text, input.batchId)
          return { done: true, words: bo('acts.done.cancelled') }
        } catch (error) {
          // A sent quote refused by its state is a firm offer (c.c. art. 1329): it stands until its last day (Q4-B3).
          return { done: false, why: refusedWords(error, row.number, row.status === 'SENT' && row.validUntil ? bo('acts.why.firmOffer', { date: day(row.validUntil) }) : null) }
        }
      },
    }
  }
  if (kind === 'askApproval')
    return {
      kind,
      title: bo('acts.title.askApproval', { count: picked.filter((row) => row.status === 'DRAFT').length }),
      go: bo('acts.go.askApproval', { count: picked.filter((row) => row.status === 'DRAFT').length }),
      body: bo('acts.body.askApproval'),
      notOn: (row) => (row.status === 'DRAFT' ? null : row.status === 'PENDING_APPROVAL' ? bo('acts.why.waitingAlready') : row.status === 'APPROVED' ? bo('acts.why.approvedAlready') : bo('acts.why.notDraft')),
      text: () => ({ label: { ns: 'sales', key: 'dialog.ask.note' }, hint: { ns: 'sales', key: 'dialog.ask.noteHint' }, required: false, min: 0, max: 500 }),
      run: async (row, input) => {
        try {
          await askApproval(api, row, input.text)
          return { done: true, words: bo('acts.done.asked') }
        } catch (error) {
          return { done: false, why: refusedWords(error, row.number, bo('acts.why.approvalRefused')) }
        }
      },
    }
  if (kind === 'makeOrders')
    return {
      kind,
      title: bo('acts.title.makeOrders', { count: picked.filter(orderMakeable).length }),
      go: bo('acts.go.makeOrders', { count: picked.filter(orderMakeable).length }),
      body: bo('acts.body.makeOrders'),
      notOn: (row) => {
        if (row.status !== 'ACCEPTED') return bo('acts.why.notAccepted')
        if (row.order?.state !== 'WAITS') return bo('acts.why.hasOrder')
        if (row.order.reason === 'ACCOUNT_ON_HOLD' || row.order.reason === 'NO_SALES_ORDER_SERIES') return { ns: 'sales', key: `list.where.orderWaits.${row.order.reason}` }
        if (!row.versionId) return bo('acts.why.readAgain')
        return null
      },
      // C36: POST /sales/orders takes the customer's PO number (`customerRef`): a quote whose terms need one gets its field here.
      field: (row) => (row.order?.reason === 'PO_NUMBER_REQUIRED' ? { label: bo('acts.field.po'), required: true, max: 100 } : null),
      run: async (row, input) => {
        try {
          const made = await makeOrderFromQuote(api, row.versionId!, input.field.trim() || null)
          return { done: true, words: bo('acts.done.orderMade', { number: made.order.number }) }
        } catch (error) {
          return { done: false, why: refusedWords(error, row.number) }
        }
      },
    }
  return {
    kind,
    title: bo('acts.title.newLink', { count: picked.filter((row) => row.status === 'SENT').length }),
    go: bo('acts.go.newLink', { count: picked.filter((row) => row.status === 'SENT').length }),
    body: bo('acts.body.newLink'),
    notOn: (row) => (row.status === 'SENT' ? null : bo('acts.why.notSent')),
    run: async (row) => {
      try {
        const answer = await sendNewLink(api, row)
        return answer.delivery === 'failed' ? { done: false, why: bo('acts.why.mailFailed') } : { done: true, words: bo('acts.done.linkSent') }
      } catch (error) {
        return { done: false, why: refusedWords(error, row.number) }
      }
    },
  }
}
