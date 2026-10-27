/**
 * Reviews › Inbox — the grid's Server-Side Row Model datasource (the Listings page's shape, `readinessDatasource.ts`):
 * one AG block is one API page (`cacheBlockSize = pageSize`: 50 / 100 / 200) of `GET /api/reviews/inbox`, newest first
 * unless a header click (Received, Stars) asks for another order. The answer also carries what the page around the grid
 * shows — the tab counts, the status tiles, the Filters lists and the read state — so the page hears of every answer
 * (`onPage`) before AG draws its rows.
 *
 * Stateless apart from a request counter: a refresh is `api.refreshServerSide({ purge: false })` (a live update keeps
 * the ticked rows and the scroll) and AG asks again. A failed read is told to AG (its failed block) AND to the page
 * (the banner with Try again): never an empty Inbox.
 */
import type { IServerSideDatasource, IServerSideGetRowsParams } from '@/design-system/grid'
import { reviewsGet } from '../_lib/reviewsFetch'
import { inboxApiParams, sortFromGrid, type InboxQuery } from './inboxQuery'

/** One row of `GET /api/reviews/inbox` (review-inbox.service.ts `InboxRow`). */
export interface InboxRow {
  id: string
  postedAt: string
  channel: string
  market: string | null
  kind: 'product' | 'seller'
  rating: number | null
  /** The start of the text (≤ 200 characters). */
  snippet: string
  /** The start of the English text when the review is in another language and was translated. */
  english: string | null
  language: string | null
  buyer: string | null
  product: { id: string; name: string; sku: string; variant: string | null } | null
  order: { id: string; label: string } | null
  mood: string | null
  themes: string[]
  status: string
  assignee: string | null
  /** When a reply is due, while the review is open. */
  dueAt: string | null
  overdue: boolean
  imported: boolean
  responses: { sent: number; draft: number }
  /** PR G — how many photos (or videos) the buyer added. */
  photos: number
  /** PR G — eBay's AI topics (eBay feedback read by eBay's newer API); [] = read, none; null = never read. */
  aiTopics: { topic: string; label: string; sentiment: string | null }[] | null
}

/** One channel × market Nexus reads reviews from, and whether that works (review-sources.service.ts). */
export interface InboxReadState {
  channel: string
  market: string | null
  ok: boolean
  since: string | null
  reason: string | null
  reconnectHref: string | null
  /** Its reviews arrive only by file import (Amazon's product reviews, a store app not connected). */
  byFile?: boolean
  /** False when no account of the channel is connected at all (Etsy): not "behind", not read; Connect is `reconnectHref`. */
  connected?: false
}

export interface InboxStatusCounts {
  NEW: number
  IN_PROGRESS: number
  RESPONDED: number
  RESOLVED: number
  IGNORED: number
  OVERDUE: number
}

export interface InboxTabCounts {
  all: number
  product: number
  seller: number
}

export interface InboxFacets {
  owners: string[]
  themes: string[]
  families: { id: string; label: string }[]
}

/** `GET /api/reviews/inbox`. */
export interface InboxPage {
  rows: InboxRow[]
  total: number
  page: number
  pageSize: number
  tabCounts: InboxTabCounts
  statusCounts: InboxStatusCounts
  facets: InboxFacets
  readState: InboxReadState[]
  /** The reviews that need a reply, all time, every channel: the same number as the badges. */
  needsReply?: number
}

export interface InboxDatasourceOptions {
  /** Read at request time, so a filter change followed by a refresh sends the new filters. */
  getQuery: () => InboxQuery
  /** A read started (the live pill says "Updating…"). */
  onRequest?: () => void
  /** The latest answer: the header, the tabs, the tiles, the Filters lists and the banners read it. */
  onPage: (page: InboxPage) => void
  /** A read failed: the page shows it with Try again, never an empty list. */
  onError: (message: string) => void
}

/** The API page an AG block asks for. */
export function pageOfBlock(startRow: number, pageSize: number): number {
  return Math.floor(Math.max(0, startRow) / Math.max(1, pageSize)) + 1
}

export function createInboxDatasource({ getQuery, onRequest, onPage, onError }: InboxDatasourceOptions): IServerSideDatasource<InboxRow> {
  let latest = 0
  return {
    getRows: async (params: IServerSideGetRowsParams<InboxRow>) => {
      const query = getQuery()
      const sortModel = (params.request.sortModel ?? []).map((e) => ({ colId: e.colId, sort: e.sort === 'asc' ? 'asc' as const : 'desc' as const }))
      const page = pageOfBlock(params.request.startRow ?? 0, query.pageSize)
      const version = ++latest
      onRequest?.()
      const answer = await reviewsGet<InboxPage>('/reviews/inbox', inboxApiParams(query, page, sortFromGrid(sortModel, query.sort)))
      if (!answer.data) {
        if (version === latest) onError(answer.error ?? 'The Inbox could not load.')
        params.fail()
        return
      }
      // The answer lands BEFORE the rows, so the tiles and the toolbar count are current when the cells draw.
      if (version === latest) onPage(answer.data)
      params.success({ rowData: answer.data.rows, rowCount: answer.data.total })
    },
  }
}
