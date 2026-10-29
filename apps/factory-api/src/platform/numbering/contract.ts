import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_BLOCK_SIZE } from '@nexus/factory-domain/numbering/blocks'
import { DOCUMENT_KINDS, MAX_NUMBER, MAX_YEAR, MIN_YEAR, NUMBER_RESETS, SCAN_ID_KINDS, SERIES_CODE } from '@nexus/factory-domain/numbering/kinds'
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
  kind: z.enum(DOCUMENT_KINDS),
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
  querystring: input({ companyId: id().optional(), kind: z.enum(DOCUMENT_KINDS).optional() }),
  response: { 200: output({ series: z.array(seriesView) }) },
})

export const createSeriesContract = defineContract({
  body: input({
    companyId: id(),
    /** A document kind: the scan-id kinds (BUNDLE, HIDE, GARMENT_SERIAL) have no series, only the tenant's blocks. */
    kind: z.enum(DOCUMENT_KINDS),
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

/**
 * `GET /numbering/series/:seriesId/allocations` (B-W0-28, design 02 admin.documents "Fiscal check" and the
 * "allocations" pop-up; PLT-123, DPR 633/72 art. 21): the numbers this series issued, newest first (at most `limit`),
 * and the proof over ALL of them: how many, the first and the last, and every range between the first and the last that
 * Nexus did not issue (a series moved past numbers used elsewhere, or a gap). Who issued each: the person's name, or
 * null for the system and the floor (worker names never appear in office lists: Owner answer W1).
 */
export const allocationView = output({
  value: z.number().int(),
  formatted: z.string(),
  documentDate: z.string(),
  recordType: z.string(),
  recordId: id(),
  allocatedAt: instant(),
  allocatedByName: z.string().nullable(),
})
export type AllocationView = z.infer<typeof allocationView>

export const allocationSummary = output({
  count: z.number().int(),
  first: z.number().int().nullable(),
  last: z.number().int().nullable(),
  firstFormatted: z.string().nullable(),
  lastFormatted: z.string().nullable(),
  lastDocumentDate: z.string().nullable(),
  /** Ranges between the first and the last number this series did not issue (at most 20, lowest first). */
  skipped: z.array(output({ from: z.number().int(), to: z.number().int() })),
  /** More than 20 ranges were found (only the first 20 are listed). */
  moreSkipped: z.boolean(),
})
export type AllocationSummary = z.infer<typeof allocationSummary>

export const allocationsContract = defineContract({
  params: seriesParams,
  querystring: input({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ series: seriesView, summary: allocationSummary, allocations: z.array(allocationView) }) },
})

/** `POST /numbering/series/:seriesId/close`: the series issues no more numbers; what it issued stays. */
export const closeSeriesContract = defineContract({
  params: seriesParams,
  body: input({ version: version(), reason: z.string().trim().min(3).max(500).optional() }),
  response: one,
})

// ---- scan-id blocks (scan-ids.ts) -------------------------------------------------------------------------------------------

export const BLOCK_STATUSES = ['ACTIVE', 'CLOSED'] as const

export const blockView = output({
  id: id(),
  kind: z.enum(SCAN_ID_KINDS),
  deviceId: id(),
  fromRef: z.number().int(),
  toRef: z.number().int(),
  size: z.number().int(),
  /** Numbers of it the server saw used. */
  used: z.number().int(),
  /** The highest number used (null: none): a tablet that lost its data goes on after it. */
  highestUsedRef: z.number().int().nullable(),
  remaining: z.number().int(),
  firstCode: z.string(),
  lastCode: z.string(),
  status: z.enum(BLOCK_STATUSES),
  closedReason: z.string().nullable(),
  closedAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

export const listBlocksContract = defineContract({
  querystring: input({ deviceId: id().optional(), kind: z.enum(SCAN_ID_KINDS).optional(), status: z.enum(BLOCK_STATUSES).optional() }),
  response: { 200: output({ blocks: z.array(blockView) }) },
})

export const reserveBlockContract = defineContract({
  body: input({
    deviceId: id(),
    kind: z.enum(SCAN_ID_KINDS),
    /** Default: the kind's tablet size (200 bundle tickets or hide tags, 500 garment serials). */
    size: z.number().int().min(1).max(MAX_BLOCK_SIZE).optional(),
  }),
  response: { 201: output({ block: blockView }) },
})

export const closeBlockContract = defineContract({
  params: input({ blockId: id() }),
  body: input({
    /** Why (for the audit log): "tablet lost on 29 Oct", "tablet retired". */
    reason: z.string().trim().min(3).max(500),
    version: version(),
  }),
  response: { 200: output({ block: blockView }) },
})

/** The tablet's open blocks, and the tenant tag it prints its scan ids with. */
export const myBlocksContract = defineContract({
  response: { 200: output({ scanTag: z.string(), blocks: z.array(blockView) }) },
})

export const topUpContract = defineContract({
  body: input({
    /** Default: every scan-id kind. */
    kinds: z
      .array(
        input({
          kind: z.enum(SCAN_ID_KINDS),
          /** The tablet's own count of numbers left (labels printed and not yet sent count as used). */
          remaining: z.number().int().min(0).max(MAX_NUMBER).optional(),
        }),
      )
      .max(SCAN_ID_KINDS.length)
      .optional(),
  }),
  response: { 200: output({ scanTag: z.string(), blocks: z.array(blockView), reserved: z.array(blockView) }) },
})
