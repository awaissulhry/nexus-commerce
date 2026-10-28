import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_NUMBER, MAX_YEAR, MIN_YEAR, NUMBER_KINDS, NUMBER_RESETS, SERIES_CODE } from '@nexus/factory-domain/numbering/kinds'
import { MAX_PATTERN_LENGTH } from '@nexus/factory-domain/numbering/format'

/**
 * The numbering routes (office, admin): the company's series with their next numbers, a new series (with the number
 * it starts at, for a paper booklet's hand-over), a new start before anything was issued, and "move past a number"
 * after a restore. Numbers themselves are issued by the documents' own commands (allocateNumber).
 */

export const SERIES_STATUSES = ['ACTIVE', 'CLOSED'] as const

export const seriesView = output({
  id: id(),
  companyId: id(),
  kind: z.enum(NUMBER_KINDS),
  code: z.string(),
  /** `2026`, or `ALL` for a series that never resets. */
  scopeKey: z.string(),
  year: z.number().int().nullable(),
  reset: z.enum(NUMBER_RESETS),
  pattern: z.string(),
  fiscal: z.boolean(),
  startValue: z.number().int(),
  nextValue: z.number().int(),
  /** The next number as it will be printed (null when the series has issued its last). */
  nextNumber: z.string().nullable(),
  lastIssuedDate: z.string().nullable(),
  status: z.enum(SERIES_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type SeriesView = z.infer<typeof seriesView>

const number = () => z.number().int().min(1).max(MAX_NUMBER)
const version = () => z.number().int().min(1)
const seriesParams = input({ seriesId: id() })
const one = { 200: output({ series: seriesView }) }

export const listSeriesContract = defineContract({
  querystring: input({ companyId: id().optional(), kind: z.enum(NUMBER_KINDS).optional() }),
  response: { 200: output({ series: z.array(seriesView) }) },
})

export const createSeriesContract = defineContract({
  body: input({
    companyId: id(),
    kind: z.enum(NUMBER_KINDS),
    /** Default `MAIN`. */
    code: z.string().regex(SERIES_CODE).optional(),
    /** Default YEARLY. */
    reset: z.enum(NUMBER_RESETS).optional(),
    /** A yearly series' first period. Default: this year (Europe/Rome). */
    year: z.number().int().min(MIN_YEAR).max(MAX_YEAR).optional(),
    /** Default: the kind's pattern (`FT-{YYYY}-{N:5}`). */
    pattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
    /** The first number (default 1): where a paper booklet or another program stopped, plus one. */
    startValue: number().optional(),
  }),
  response: { 201: output({ series: seriesView }) },
})

export const setStartContract = defineContract({
  params: seriesParams,
  body: input({ startValue: number(), version: version() }),
  response: one,
})

export const advanceContract = defineContract({
  params: seriesParams,
  body: input({
    /** The last number already used elsewhere (the SDI receipts, the DDT archive): the series continues after it. */
    pastValue: z.number().int().min(1).max(MAX_NUMBER - 1),
    /** Why (for the audit log): "restore of 2026-11-02, last SDI receipt FT-2026-00141". */
    reason: z.string().trim().min(3).max(500),
    /** That number's document date, so the date-order check keeps working. */
    lastIssuedDate: businessDate().optional(),
    version: version(),
  }),
  response: one,
})
