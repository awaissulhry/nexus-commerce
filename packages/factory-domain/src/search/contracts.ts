import { z } from 'zod'
import { id, input, instant, output } from '../core/contracts'
import { notMoney } from '../money/marked'
import { SEARCH_LIMITS } from './text'

/**
 * The search route's contract (apps/factory-api platform/search `GET /search`; B-W2a-32; PLT-153): shared by the API
 * (its route schema) and the web (the palette's Records group and the All results page check every answer with it).
 *
 * A result is a record its reader may open (the entry's view permission and its company, site and party, filtered by the
 * reader's grants as the record's own list is) and holds no money: number, name, one line under it, status, area,
 * company and site, how it matched, and when its entry was written.
 */

/** A record type as the API names it (its model: `SalesOrder`, `Party`). */
export const RECORD_TYPE = /^[A-Z][A-Za-z0-9]*$/

/** How a result matched: its number whole, every word inside its text, or a word alike (a typo forgiven). */
export const SEARCH_MATCHES = ['number', 'words', 'similar'] as const
export type SearchMatch = (typeof SEARCH_MATCHES)[number]

export const searchQuery = input({
  q: z.string().max(200),
  /** One record type only (the results page's chip); absent: every type. */
  type: z.string().regex(RECORD_TYPE).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMITS.maxPage).default(SEARCH_LIMITS.page),
  /** Results to skip (the results page's next page); at most 1000. */
  offset: z.coerce.number().int().min(0).max(1000).default(0),
})
export type SearchQueryInput = z.input<typeof searchQuery>

export const searchResult = output({
  recordType: z.string(),
  recordId: id(),
  number: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  /** The record's status code at the last index (a factory-domain code), or null. */
  status: z.string().nullable(),
  /** The area it opens in (`sales`, `warehouse`). */
  area: z.string(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  match: z.enum(SEARCH_MATCHES),
  indexedAt: instant(),
})
export type SearchResult = z.infer<typeof searchResult>

export const searchAnswer = output({
  /** The query as searched (folded) and its words: the web marks them in the rows. */
  query: z.string(),
  words: z.array(z.string()),
  /** Too short to search: nothing was looked up. */
  tooShort: z.boolean(),
  results: z.array(searchResult),
  /** Every record type that matched, with how many (the type filter aside), most first. */
  counts: z.array(output({ recordType: z.string(), count: z.number().int().min(0) })),
  /** How many results the type asked (or every type) has: a count, not money. */
  total: notMoney(z.number().int().min(0)),
  /** The offset of the next page, or null when this is the last. */
  nextOffset: z.number().int().nullable(),
  /** When the index last wrote an entry of this tenant (null: it is empty). */
  asOf: instant().nullable(),
})
export type SearchAnswer = z.infer<typeof searchAnswer>

export const rebuildBody = input({
  /** Only these record types; absent: every type with an indexer. */
  recordTypes: z.array(z.string().regex(RECORD_TYPE).max(60)).min(1).max(100).optional(),
})

export const rebuildAnswer = output({
  requested: z.literal(true),
  recordTypes: z.array(z.string()).nullable(),
})
