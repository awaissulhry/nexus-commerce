/**
 * Reviews › Requests › Queue — what the page reads, and the shapes the API answers with (`GET /api/review-queue`,
 * `/review-queue/sending`, `/review-queue/:id`; services/reviews/review-queue.service.ts). One grid page is one API page:
 * the server filters, sorts and pages; the grid shows the page it got. Every status, reason and held reason arrives
 * in words — the page never turns a provider code into words itself.
 */
import { reviewsGet, type ReviewsResult } from '../../_lib/reviewsFetch'
import type { LinkParams } from '../../_lib/reviewsLinks'

export type QueueStatus = 'SCHEDULED' | 'DUE' | 'RETRYING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'SUPPRESSED'

export interface QueueRow {
  id: string
  orderId: string
  orderLabel: string
  /** First name + initial. Never the e-mail. */
  buyer: string
  channel: string
  market: string | null
  product: string | null
  productType: string | null
  deliveredAt: string | null
  /** The delivery date is Nexus's estimate (shipped + 3 working days), not a scan. */
  deliveredEstimate: boolean
  dayWords: string
  nextTryAt: string | null
  sentAt: string | null
  status: QueueStatus
  tries: number
  reasonKey: string
  reasonWords: string
  ruleId: string | null
  ruleName: string | null
  /** Why "Send now" is held for this row, or null. */
  sendNowHeld: string | null
}

export interface QueueTiles {
  scheduled: number
  dueNow: number
  retrying: number
  sent: number
  /** Failed for good (no try left). */
  failed: number
  /** Skipped and blocked (not asked). */
  skipped: number
  /** Review rate of the last 30 days (0..1), an estimate; null before any request was sent. */
  reviewRate: number | null
  /** Change against the 30 days before, as a fraction (0.006 = +0.6 points). */
  rateDelta: number | null
}

export interface QueueFailures {
  count: number
  bounced: number
  noAnswer: number
  words: string
}

export interface QueueFacets {
  rules: { id: string; name: string; isActive: boolean }[]
  productTypes: string[]
  reasons: { key: string; words: string }[]
}

export interface QueueAnswer {
  rows: QueueRow[]
  total: number
  page: number
  pageSize: number
  tiles: QueueTiles
  failures7d: QueueFailures
  facets: QueueFacets
}

export interface SendingState {
  paused: { by: string; at: string | null; reason: string | null } | null
  /** Next hourly run; null when the hourly sender is not known to run. */
  nextRunAt: string | null
  /** "Runs every hour", or why that is not known. */
  hourly: string
  lastRun: {
    at: string | null
    by: string
    ok: boolean
    sent: number | null
    failed: number | null
    skipped: number | null
    tooEarly: number | null
    words: string
  } | null
  due: {
    amazon: { total: number; byMarket: Record<string, number> }
    email: { total: number; byChannel: Record<string, number> }
  }
  /** Why "Run now" is held (paused, a run going on), or null. */
  runHeld: string | null
}

export type TimelineKind = 'added' | 'check' | 'return' | 'refund' | 'try' | 'sent' | 'failed' | 'not_asked' | 'next' | 'note'

export interface RequestDetail {
  request: QueueRow & {
    createdAt: string | null
    scheduledFor: string | null
    lastAttemptAt: string | null
    nextRetryAt: string | null
    /** The raw code, for the info tip only. */
    reasonCode: string | null
    rule: {
      id: string
      name: string
      scope: string
      marketplace: string | null
      firstTryDay: number | null
      skips: string[]
      howWasIt: boolean
    } | null
  }
  order: {
    id: string
    label: string
    status: string | null
    fulfilment: string | null
    total: number | null
    currency: string | null
    lines: { sku: string; name: string | null; productType: string | null; quantity: number; price: number }[]
    dates: { ordered: string | null; shipped: string | null; delivered: string | null; cancelled: string | null }
    refund: { at: string | null; amount: number; currency: string | null } | null
    return: { id: string; rma: string | null; status: string; open: boolean; openedAt: string | null } | null
  }
  window: { deliveredAt: string | null; estimate: boolean; firstDay: string | null; lastDay: string | null }
  amazonAnswer: { words: string; code: string; at: string | null } | null
  timeline: { at: string | null; words: string; kind: TimelineKind }[]
  held: { snooze: string | null; sendNow: string | null; skip: string | null; allowAgain: string | null }
  snoozeOptions: { days: number; to: string | null; held: string | null }[]
}

/** One page of the queue, with the tiles, the failures of 7 days and the filter options. */
export function readQueuePage(params: LinkParams, signal?: AbortSignal): Promise<ReviewsResult<QueueAnswer>> {
  return reviewsGet<QueueAnswer>('/review-queue', params, { signal })
}

/** Sending on or paused, the next and the last run, what is due now. */
export function readSending(signal?: AbortSignal): Promise<ReviewsResult<SendingState>> {
  return reviewsGet<SendingState>('/review-queue/sending', undefined, { signal })
}

/** One request for the pop-up. */
export function readRequestDetail(id: string, signal?: AbortSignal): Promise<ReviewsResult<RequestDetail>> {
  return reviewsGet<RequestDetail>(`/review-queue/${encodeURIComponent(id)}`, undefined, { signal })
}
