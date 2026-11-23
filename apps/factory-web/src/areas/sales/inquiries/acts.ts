import { INQUIRY_LIMITS, isOpen } from '@nexus/factory-domain/sales/inquiries/rules'
import type { ApiClient } from '../../../lib/api/client'
import { fillMailEvent } from '../../_shared/document-send/template/api'
import { refusedWords, type ManyAct } from '../_shared/many-acts/model'
import { askInfo, loseInquiry } from './api'
import { bi, type IncomingRecord } from './bar'

/**
 * F-CQ-203 (customer page › Quotes & incoming, 10-design §8; settles C2, C10) — the Incoming list's loops in the ONE many-acts window:
 * Mark N lost (one note "why the customer went away" on each), Ask <customer> about N requests (one question; each request waits for
 * its customer, who reads "We need something from you" in the portal, or gets it by mail from its contact; with one request the
 * question starts from the company's own words for it, `request.need_info`). One request after the other with its own version and ONE
 * batchId (one bell per batch, S2). A portal order is never in these loops: it is answered on its own (its row's ⋯). Assign N and
 * Decline N stay the all-or-none commands (their own windows). The container builds them (they call the API).
 */
export function incomingActOf(kind: 'lost' | 'askInfo', api: ApiClient, picked: readonly IncomingRecord[]): ManyAct<IncomingRecord> {
  const requestWhy = (row: IncomingRecord) => (row.kind !== 'REQUEST' || !row.request ? bi('acts.why.portalOwn') : !isOpen(row.request.status) ? bi('acts.why.closed') : null)
  if (kind === 'lost') {
    const runs = picked.filter((row) => requestWhy(row) === null).length
    return {
      kind,
      title: bi('acts.title.markLost', { count: runs }),
      go: bi('acts.go.markLost', { count: runs }),
      body: bi('acts.body.markLost'),
      notOn: requestWhy,
      text: () => ({ label: { ns: 'sales-inquiries', key: 'lost.note' }, hint: { ns: 'sales-inquiries', key: 'lost.noteHint' }, required: true, min: 1, max: INQUIRY_LIMITS.closeNote }),
      run: async (row, input) => {
        try {
          await loseInquiry(api, row.id, { version: row.request!.version, note: input.text.trim(), batchId: input.batchId })
          return { done: true, words: bi('acts.done.lost') }
        } catch (error) {
          return { done: false, why: refusedWords(error, row.number) }
        }
      },
    }
  }
  const askWhy = (row: IncomingRecord) => {
    if (row.kind !== 'REQUEST' || !row.request) return bi('acts.why.askPortal')
    if (row.request.status === 'NEED_INFO') return bi('acts.why.askedAlready')
    if (row.request.status !== 'NEW' && row.request.status !== 'ASSIGNED') return bi('acts.why.closed')
    return null
  }
  const runs = picked.filter((row) => askWhy(row) === null)
  return {
    kind,
    title: bi('acts.title.askInfo', { count: runs.length }),
    go: bi('acts.go.askInfo', { count: runs.length }),
    body: bi('acts.body.askInfo'),
    notOn: askWhy,
    text: () => ({ label: bi('acts.field.question'), required: true, min: 3, max: INQUIRY_LIMITS.note }),
    // One request: its question starts from the company's words for it (C2: the same start words as the request's own Ask for info).
    start: (asked) => (asked.length === 1 ? fillMailEvent(api, 'request.need_info', { recordType: 'Inquiry', recordId: asked[0]!.id }).then((start) => start.body) : Promise.resolve(null)),
    run: async (row, input) => {
      try {
        await askInfo(api, row.id, row.request!.version, undefined, { body: input.text.trim() }, input.batchId)
        return { done: true, words: bi('acts.done.askedInfo') }
      } catch (error) {
        return { done: false, why: refusedWords(error, row.number) }
      }
    },
  }
}
