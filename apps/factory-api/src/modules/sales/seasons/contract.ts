import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SEASON_LIMITS, SEASON_STATES, SEASON_STATUSES } from '@nexus/factory-domain/sales/seasons/rules'

/** The seasons' routes (B-W2b-303; SAL-277; modules/sales/seasons). No money anywhere. */

const words = output({ en: z.string(), it: z.string() })
const season = output({
  id: id(),
  companyId: id(),
  company: output({ id: id(), code: z.string() }),
  code: z.string(),
  name: z.string(),
  startsOn: businessDate(),
  endsOn: businessDate(),
  orderBookClosesOn: businessDate().nullable(),
  status: z.enum(SEASON_STATUSES),
  state: z.enum(SEASON_STATES),
  stateWords: words,
  notice: words.nullable(),
  closedAt: instant().nullable(),
  closedBy: z.string().nullable(),
  note: z.string().nullable(),
  /** How many styles carry its code as their season (W1's text). */
  styles: z.number().int(),
  quoteVersions: z.number().int(),
  orders: z.number().int(),
  version: z.number().int(),
})
const one = output({ season: season.extend({ mayManage: z.boolean() }) })
const version = z.number().int().min(1)
const seasonParams = input({ seasonId: id() })

export const listSeasonsContract = defineContract({
  querystring: input({ companyId: id().optional(), status: z.enum([...SEASON_STATUSES, 'ALL']).optional(), q: z.string().trim().max(50).optional() }),
  response: { 200: output({ seasons: z.array(season), mayManage: z.boolean() }) },
})
export const getSeasonContract = defineContract({ params: seasonParams, response: { 200: one } })
export const createSeasonContract = defineContract({
  body: input({
    companyId: id(),
    code: z.string().max(SEASON_LIMITS.code + 10),
    name: z.string().max(SEASON_LIMITS.name + 10),
    startsOn: businessDate(),
    endsOn: businessDate(),
    orderBookClosesOn: businessDate().nullable().optional(),
    note: z.string().max(SEASON_LIMITS.note).nullable().optional(),
  }),
  response: { 201: one },
})
export const updateSeasonContract = defineContract({
  params: seasonParams,
  body: input({ version, name: z.string().max(SEASON_LIMITS.name + 10).optional(), startsOn: businessDate().optional(), endsOn: businessDate().optional(), orderBookClosesOn: businessDate().nullable().optional(), note: z.string().max(SEASON_LIMITS.note).nullable().optional() }),
  response: { 200: one },
})
export const moveSeasonContract = defineContract({ params: seasonParams, body: input({ version }), response: { 200: one } })

const named = output({ seasonId: id().nullable(), code: z.string().nullable() })
export const setQuoteSeasonContract = defineContract({
  params: input({ quoteId: id() }),
  body: input({ version, seasonId: id().nullable() }),
  response: { 200: output({ season: named.extend({ quoteId: id(), versionId: id() }) }) },
})
export const setOrderSeasonContract = defineContract({
  params: input({ orderId: id() }),
  body: input({ version, seasonId: id().nullable() }),
  response: { 200: output({ season: named.extend({ orderId: id(), version: z.number().int() }) }) },
})
