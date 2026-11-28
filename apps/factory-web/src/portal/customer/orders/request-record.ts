import type { LifeNote, OrderLife } from '@nexus/factory-domain/sales/order-life'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { lifeOfStatus } from '../../../lib/order-cells/model'
import { lineCountOf } from '../../../lib/order-draft/model'
import { recordSchema, type DraftRecord } from '../../../lib/order-draft/schema'

/**
 * owb-po5.2 (lead settle 2: ONE order page for both records) — a Draft or Sent request (`PortalOrderRequest`) drawn in the order's frame:
 * the same band and tabs as an order (Overview · Lines · Money · Shipments · Files; Money only with the price grain). Pure, but for the
 * two calls at the end. The record is the draft record (`GET /portal/order-requests/:id`, the ONE schema of lib/order-draft: picture,
 * own columns, removed lines and `may.takeBack` sit inside `request`). Never the office's series: the request's number is not the order's
 * (settle 3) — the band says "Your order · <subject>" until the factory confirms.
 */

export const REQUEST_TABS = ['overview', 'lines', 'money', 'shipments', 'files'] as const
export type RequestTab = (typeof REQUEST_TABS)[number]

/** What the frame draws of a request. */
export interface RequestFrame {
  readonly id: string
  readonly version: number
  /** "Your order · <subject>" (no number before Confirm). */
  readonly title: string
  readonly subject: string | null
  readonly customerRef: string | null
  readonly life: OrderLife
  readonly note: LifeNote | null
  readonly status: DraftRecord['request']['status']
  /** The order it became (the page sends the person there): an accepted request. */
  readonly orderId: string | null
  readonly lines: number
  readonly pieces: number
  readonly wanted: string | null
  readonly sentAt: string | null
  readonly seesPrices: boolean
  /** The ONE primary of the band (settle 2): Draft "Review and send…" · Sent "Take it back" · otherwise none. */
  readonly primary: 'send' | 'takeBack' | null
  /** What the reader may do (the record's `may`; an older answer: as before — send for who may order, never take back). */
  readonly may: { readonly send: boolean; readonly takeBack: boolean; readonly picture: boolean }
  readonly picture: { readonly fileId: string | null } | null
}

/** The frame of a request in the reader's words (`orderName`: "Your order"). */
export function requestFrameOf(record: DraftRecord, words: { orderName: string }, rights: { mayOrder: boolean; mayDraft: boolean; preview: boolean }): RequestFrame {
  const request = record.request
  const life = lifeOfStatus(request.status)
  const subject = request.subject?.trim() ? request.subject.trim() : null
  const may = {
    send: !rights.preview && request.status === 'DRAFT' && (request.may?.send ?? rights.mayOrder),
    takeBack: !rights.preview && request.status === 'SENT' && (request.may?.takeBack ?? false),
    // One right for every portal picture route (portal.orderDrafts.edit), before and after Send; never once decided.
    picture: !rights.preview && rights.mayDraft && (request.status === 'DRAFT' || request.status === 'SENT'),
  }
  return {
    id: request.id,
    version: request.version,
    title: subject ? `${words.orderName} · ${subject}` : words.orderName,
    subject,
    customerRef: request.customerRef,
    life: life.life,
    note: life.note,
    status: request.status,
    orderId: request.status === 'ACCEPTED' ? (request.salesOrder?.id ?? null) : null,
    lines: lineCountOf(request),
    pieces: request.summary.pieces,
    wanted: request.requestedDate,
    sentAt: request.sentAt,
    seesPrices: record.seesPrices,
    primary: request.status === 'DRAFT' ? 'send' : request.status === 'SENT' ? 'takeBack' : null,
    may,
    picture: request.picture ? { fileId: request.picture.fileId } : null,
  }
}

/** The tab a person lands on (Money only with the price grain; old `status` / `documents` land on Overview / Files). */
export function requestTabOf(value: string | null | undefined, seesPrices: boolean): RequestTab {
  const asked = value === 'status' ? 'overview' : value === 'documents' ? 'files' : value
  const tab = (REQUEST_TABS as readonly string[]).includes(asked ?? '') ? (asked as RequestTab) : 'overview'
  return tab === 'money' && !seesPrices ? 'overview' : tab
}

/** Before Confirm, Money and Shipments say one quiet line (settle 2); the key of that line, or null for a tab with its own body. */
export function quietLineOf(tab: RequestTab): 'quiet.money' | 'quiet.shipments' | null {
  return tab === 'money' ? 'quiet.money' : tab === 'shipments' ? 'quiet.shipments' : null
}

/** The request's files by kind (a mockup, a size file, another file): names only, the draft's own and its lines'. */
export function requestFilesOf(record: DraftRecord): readonly { readonly kind: 'mockups' | 'sizes' | 'other'; readonly files: readonly { readonly id: string; readonly name: string | null }[] }[] {
  const files = record.request.files
  if (!files) return []
  const row = (file: { id: string; originalName: string | null }) => ({ id: file.id, name: file.originalName })
  return [
    { kind: 'mockups' as const, files: files.logos.map(row) },
    { kind: 'sizes' as const, files: files.sheets.map(row) },
    { kind: 'other' as const, files: files.references.map(row) },
  ].filter((group) => group.files.length > 0)
}

/**
 * Why Take it back was refused, as a key of our own words (the app never shows the API's text): the factory already started work on it
 * (owb-po1.2: work begun), already answered it (accepted or refused), the page was stale, or another failure.
 */
export function takeBackRefusal(error: unknown): 'takeBack.started' | 'takeBack.answered' | 'takeBack.stale' | 'takeBack.failed' {
  if (!isApiError(error)) return 'takeBack.failed'
  if (error.kind === 'conflict' && /started/i.test(error.message)) return 'takeBack.started'
  if (error.kind === 'conflict' && /answered/i.test(error.message)) return 'takeBack.answered'
  if (error.status === 409) return 'takeBack.stale'
  return 'takeBack.failed'
}

// ── the two calls (the page's own API client) ────────────────────────────────────────────────────────────────────────────────
const path = (id: string) => `/portal/order-requests/${encodeURIComponent(id)}`

/** The draft record; a 404 (not a request of this customer, or an e-mail request's id) answers null: the route shows the e-mail page. */
export async function fetchRequestRecord(api: ApiClient, id: string, signal?: AbortSignal): Promise<DraftRecord | null> {
  try {
    return await api.get(path(id), { schema: recordSchema, signal })
  } catch (error) {
    if (isApiError(error) && error.kind === 'not_found') return null
    throw error
  }
}

/** Take it back (owb-po1.2): SENT → DRAFT, the number kept; answers the draft record. 409 in words (decided, work started). */
export const takeBackRequest = (api: ApiClient, id: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<DraftRecord> =>
  api.post(`${path(id)}/take-back`, { body: { version }, schema: recordSchema, idempotencyKey })
