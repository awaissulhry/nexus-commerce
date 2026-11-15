import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX } from '../../shared/fixtures'
import type { ErrorDetail, ErrorItem } from './api'
import { ErrorQueueBand, ErrorQueueSection, type ErrorQueueModel } from './view/ErrorQueueSection'

/**
 * Made-up failed messages for the design review (B-W2b-415, SCR-600): invented invoices, services and times. Nothing here is a
 * real company, person, message or number. Design-only.
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const id = (n: number) => `0190f0e2-e7e7-7000-8000-${String(n).padStart(12, '0')}`

const item = (n: number, over: Partial<ErrorItem>): ErrorItem => ({
  id: id(n),
  companyId: '0190f0e2-5c00-7000-8000-000000000001',
  source: 'CALL',
  provider: 'SDI',
  operation: 'sdi.send_invoice',
  record: null,
  reasonCode: 'provider_error',
  reasonText: null,
  tries: 1,
  firstFailedAt: at(14, 9, 10 - n),
  lastFailedAt: at(14, 9, 40 - n),
  state: 'OPEN',
  retriedAt: null,
  retriedBySystem: null,
  dismissedAt: null,
  dismissReason: null,
  fixPlace: null,
  retry: { held: null },
  dismiss: { held: null },
  version: 1,
  ...over,
})

export const DEMO_ITEMS: readonly ErrorItem[] = [
  item(1, { reasonCode: '00404', reasonText: 'Fattura FT-2026-0041 rifiutata: codice destinatario non valido (esempio).', tries: 2, fixPlace: 'invoices', retry: { held: 'FROM_RECORD' } }),
  item(2, { source: 'OUTBOX', provider: null, operation: 'email.send', reasonCode: 'job_failed', reasonText: 'ProviderError: the mailbox did not answer (example).', companyId: null }),
  item(3, { source: 'WEBHOOK', provider: 'SENDCLOUD', operation: 'webhook.process', reasonCode: 'signature_mismatch', reasonText: 'The signature header does not match the body (example).', retry: { held: 'SIGNATURE' } }),
  item(4, { source: 'OUTBOX', provider: null, operation: 'quote.sent', reasonCode: 'publish_failed', reasonText: 'Redis did not answer within 2000 ms (example).', companyId: null }),
  item(5, { provider: 'SES', operation: 'mail.send', reasonCode: 'timeout', reasonText: 'no answer within 10000 ms', fixPlace: 'mail', retry: { held: 'FROM_RECORD' }, companyId: null }),
  item(6, { provider: 'VIES', operation: 'vat.check', reasonCode: 'account_paused', fixPlace: 'customers', retry: { held: 'FROM_RECORD' }, companyId: null }),
  item(7, { source: 'WEBHOOK', provider: 'SDI', operation: 'webhook.process', reasonCode: 'processing_failed', reasonText: 'No processor for this notification yet (example).' }),
]

const RETRIED: readonly ErrorItem[] = [
  item(11, { source: 'OUTBOX', provider: null, operation: 'shipment.status_changed', reasonCode: 'publish_failed', state: 'RETRIED', retriedAt: at(14, 10, 2), retriedBySystem: false, retry: { held: 'WAITING' } }),
  item(12, { provider: 'SES', operation: 'mail.send', reasonCode: 'timeout', state: 'RETRIED', retriedAt: at(14, 10, 5), retriedBySystem: true, fixPlace: 'mail', retry: { held: 'WAITING' }, companyId: null }),
]

const DISMISSED_ITEM = item(21, { source: 'WEBHOOK', provider: 'SDI', operation: 'webhook.process', reasonCode: 'signature_mismatch', state: 'DISMISSED', dismissedAt: at(14, 11, 0), dismissReason: 'A test delivery from the provider (example).', retry: { held: 'DISMISSED' }, dismiss: { held: 'DISMISSED' } })

const CALL_DETAIL: ErrorDetail = {
  source: {
    kind: 'call',
    startedAt: at(14, 9, 39),
    durationMs: 812,
    attempts: 1,
    httpStatus: 422,
    status: 'FAILED',
    reason: 'provider_error',
    mode: 'FAKE',
    accountId: '0190f0e2-acc0-7000-8000-000000000001',
    accountLabel: 'SDI intermediario (demo)',
    request: [
      { key: 'sendId', value: '0190f0e2-5e1d-7000-8000-000000000041' },
      { key: 'bytes', value: '18422' },
    ],
    response: [{ key: 'code', value: '00404' }],
  },
  retriedBy: null,
  dismissedBy: null,
}

const counts = { open: DEMO_ITEMS.length, retried: RETRIED.length, dismissed: 1 }

function model(over: Partial<ErrorQueueModel> = {}): ErrorQueueModel {
  return {
    prefix: PREFIX,
    view: 'open',
    list: { items: DEMO_ITEMS, counts, problem: null, nextBefore: null, loadingMore: false },
    canManage: true,
    selected: [],
    open: null,
    dismiss: null,
    retryMany: null,
    busyId: null,
    notice: null,
    updates: 0,
    ...over,
  }
}

interface Case {
  /** Null: the person does not hold integrations.view (the section and the band are absent). */
  section: ErrorQueueModel | null
}

function ErrorQueueDesign({ model: c }: { model: Case }) {
  const page = createElement(
    'div',
    { className: 'fw-adm' },
    c.section ? createElement('div', { className: 'fw-adm-head' }, createElement('div', { className: 'fw-adm-actions' }, createElement(ErrorQueueBand, { open: c.section.list.counts?.open ?? null }))) : null,
    c.section ? createElement(ErrorQueueSection, { model: c.section }) : null,
  )
  return inShell('/admin/connections', page)
}

const open = (row: ErrorItem, detail: ErrorDetail | null = null) => ({ id: row.id, item: row, detail, problem: null })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-600',
  title: 'Connections › Error queue',
  view: ErrorQueueDesign,
  cases: [
    { id: 'normal', label: 'Seven failed messages waiting', model: { section: model() }, note: 'Calls, a dead event, a background job out of tries, a rejected and a failed webhook. The band says "Error queue (7)".' },
    { id: 'selected', label: 'Three ticked: Retry 2 · Dismiss 3', model: { section: model({ selected: [DEMO_ITEMS[1]!.id, DEMO_ITEMS[3]!.id, DEMO_ITEMS[0]!.id] }) }, note: 'The SDI call is left out of Retry: a failed call is sent again from where it started.' },
    { id: 'item-sdi', label: 'pop:error-item — SDI refused FT-2026-0041', model: { section: model({ open: open(DEMO_ITEMS[0]!, CALL_DETAIL) }) }, note: 'Retry held with why; Edit and retry opens Invoices; the summaries the gateway kept, never a secret.' },
    { id: 'item-job', label: 'A background job out of tries', model: { section: model({ open: open(DEMO_ITEMS[1]!, { source: { kind: 'event', type: 'email.queued', occurredAt: at(14, 9, 30), status: 'PUBLISHED', attempts: 1 }, retriedBy: null, dismissedBy: null }) }) } },
    {
      id: 'item-webhook',
      label: 'A webhook whose signature failed',
      model: { section: model({ open: open(DEMO_ITEMS[2]!, { source: { kind: 'webhook', eventType: 'parcel_status_changed', receivedAt: at(14, 9, 37), status: 'REJECTED', attempts: 0, bodyBytes: 1840, verified: false, accountId: id(90), accountLabel: 'Sendcloud (demo)' }, retriedBy: null, dismissedBy: null }) }) },
      note: 'Never processed: Retry held; the body is never shown.',
    },
    { id: 'item-dismissed', label: 'A dismissed message (who and why)', model: { section: model({ view: 'dismissed', list: { items: [DISMISSED_ITEM], counts, problem: null, nextBefore: null, loadingMore: false }, open: open(DISMISSED_ITEM, { source: { kind: 'gone' }, retriedBy: null, dismissedBy: { system: false, name: 'Anna Esempio' } }) }) } },
    { id: 'item-loading', label: 'An item loading', model: { section: model({ open: { id: DEMO_ITEMS[3]!.id, item: DEMO_ITEMS[3]!, detail: null, problem: null } }) } },
    { id: 'dismiss', label: 'Dismiss 3 with one reason', model: { section: model({ selected: [DEMO_ITEMS[2]!.id, DEMO_ITEMS[4]!.id, DEMO_ITEMS[5]!.id], dismiss: { ids: [DEMO_ITEMS[2]!.id, DEMO_ITEMS[4]!.id, DEMO_ITEMS[5]!.id], reason: '', busy: false, problem: null, tried: false } }) } },
    { id: 'dismiss-refused', label: 'Dismiss: the reason is missing', model: { section: model({ dismiss: { ids: [DEMO_ITEMS[2]!.id], reason: 'x', busy: false, problem: null, tried: true } }) } },
    { id: 'retry-many', label: 'Retry 2: the confirm', model: { section: model({ selected: [DEMO_ITEMS[1]!.id, DEMO_ITEMS[3]!.id, DEMO_ITEMS[0]!.id], retryMany: { ids: [DEMO_ITEMS[1]!.id, DEMO_ITEMS[3]!.id, DEMO_ITEMS[0]!.id], busy: false } }) }, note: 'What is sent again; the call left out with why.' },
    { id: 'retried', label: 'Sent again (waiting for the result)', model: { section: model({ view: 'retried', list: { items: RETRIED, counts, problem: null, nextBefore: null, loadingMore: false } }) }, note: 'One sent again by a person, one that went through on its own.' },
    { id: 'notice', label: 'After Retry: 1 sent again', model: { section: model({ notice: { key: 'aih.done.retried', tone: 'success', params: { count: 1 } }, updates: 2 }) }, note: 'Two live changes wait behind "2 updates · Show".' },
    { id: 'read-only', label: 'Read only: no right to retry or dismiss', model: { section: model({ canManage: false, list: { items: DEMO_ITEMS.map((row) => ({ ...row, retry: { held: 'NO_RIGHT' as const }, dismiss: { held: 'NO_RIGHT' as const } })), counts, problem: null, nextBefore: null, loadingMore: false } }) }, note: 'Every box held with its reason; the bulk buttons say why.' },
    { id: 'empty', label: 'Nothing waiting', model: { section: model({ list: { items: [], counts: { open: 0, retried: 0, dismissed: 0 }, problem: null, nextBefore: null, loadingMore: false } }) } },
    { id: 'loading', label: 'Loading', model: { section: model({ list: { items: null, counts: null, problem: null, nextBefore: null, loadingMore: false } }) } },
    { id: 'error', label: 'Not available', model: { section: model({ list: { items: null, counts: null, problem: 'problem.unavailable', nextBefore: null, loadingMore: false } }) }, note: 'The other sections keep working.' },
    { id: 'no-permission', label: 'No right to see it (absent)', model: { section: null }, note: 'Without integrations.view the section and the band are absent (never a locked box).' },
  ],
})
