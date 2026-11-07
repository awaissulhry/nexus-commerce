import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import type { PartnerKind } from '../../auth/partners/kinds'
import { PARTNER_MATCHES } from './match'

/**
 * Portal search's contract (apps/factory-api `GET /portal/search`; B-W2b-168; SAL-084; design portal.frame › top-bar
 * "Search results grouped: Orders, Documents, Returns, Jobs; Enter opens" and portal.customer.home › search-hero "Enter
 * opens the single match directly; several matches → grouped results"). Shared by the API (its route schema) and the
 * portal's web (B-W2b-173).
 *
 * A result is one of the partner's own records the person may open, with the references the partner sees — theirs first,
 * ours second (RefPair) — its status code and its date. Never money, never anything only the office sees.
 */

/** The groups results come in (plan: orders, documents, returns, jobs, POs). */
export const PARTNER_SEARCH_GROUPS = ['orders', 'documents', 'returns', 'jobs', 'pos'] as const
export type PartnerSearchGroup = (typeof PARTNER_SEARCH_GROUPS)[number]

/** The groups of each partner kind's portal, in the order its rail shows them (an empty group is left out). */
export const GROUPS_OF_KIND: Readonly<Record<PartnerKind, readonly PartnerSearchGroup[]>> = Object.freeze({
  CUSTOMER: ['orders', 'documents', 'returns'],
  SUPPLIER: ['pos', 'documents', 'returns'],
  SUBCONTRACTOR: ['jobs', 'documents'],
  GUEST: ['documents'],
})

export const PARTNER_SEARCH_LIMITS = Object.freeze({
  /** Results per group by default (the top bar's grouped list). */
  perGroup: 5,
  /** The most one group may ask (its "see all"). */
  maxPerGroup: 50,
  /** The most index entries read per query before the wall: a longer list says `capped` (type more of the reference). */
  candidates: 200,
  /** The most records one reference lookup reads per record type. */
  lookup: 20,
})

export const partnerSearchQuery = input({
  q: z.string().max(200),
  /** One group only (its "see all"); absent: every group of the person's portal. */
  group: z.enum(PARTNER_SEARCH_GROUPS).optional(),
  /** Results per group. */
  limit: z.coerce.number().int().min(1).max(PARTNER_SEARCH_LIMITS.maxPerGroup).default(PARTNER_SEARCH_LIMITS.perGroup),
})
export type PartnerSearchQueryInput = z.input<typeof partnerSearchQuery>

export const partnerSearchResult = output({
  /** The record's type as the API names it (`SalesOrder`, `PurchaseOrder`): the portal page it opens. */
  recordType: z.string(),
  recordId: id(),
  group: z.enum(PARTNER_SEARCH_GROUPS),
  /** Their own reference (their PO number), shown first; null when they gave none. */
  theirRef: z.string().nullable(),
  /** Our number, shown second. */
  ourRef: z.string().nullable(),
  /** One line under it: the order a document belongs to, the order a delivery ships. */
  subtitle: z.string().nullable(),
  /** The record's status code (the portal says it in the partner's words). */
  status: z.string().nullable(),
  /** The record's own date (ordered, issued, shipped). */
  date: instant().nullable(),
  /** How it matched: their reference typed whole, our number typed whole, every word, or a word alike. */
  match: z.enum(PARTNER_MATCHES),
})
export type PartnerSearchResult = z.infer<typeof partnerSearchResult>

export const partnerSearchAnswer = output({
  /** The query as searched (folded) and its words: the web marks them. */
  query: z.string(),
  words: z.array(z.string()),
  /** Too short to search: nothing was looked up. */
  tooShort: z.boolean(),
  /** The groups with at least one result, in the portal's order, each with how many matched and the first results. */
  groups: z.array(output({ group: z.enum(PARTNER_SEARCH_GROUPS), count: z.number().int().min(0), results: z.array(partnerSearchResult) })),
  /** How many records matched in every group. */
  found: z.number().int().min(0),
  /** The one record Enter opens directly: the only result, or the only one whose reference was typed whole; else null. */
  single: partnerSearchResult.nullable(),
  /** More index entries matched than one search reads: the counts may be short (type more of the reference). */
  capped: z.boolean(),
})
export type PartnerSearchAnswer = z.infer<typeof partnerSearchAnswer>
