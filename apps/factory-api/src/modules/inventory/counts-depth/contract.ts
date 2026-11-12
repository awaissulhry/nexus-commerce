import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { COUNT_ITEM_KINDS, STOCK_COUNT_KINDS, STOCK_COUNT_STATUSES } from '@nexus/factory-domain/inventory/counts/rules'
import { ABC_CLASSES, SCHEDULE_LIMITS } from '@nexus/factory-domain/inventory/counts-depth/schedules'
import { SCAN_PASSES } from '@nexus/factory-domain/inventory/counts-depth/scans'
import { SEPARATION_RULES } from '@nexus/factory-domain/inventory/counts-depth/separation'

/**
 * Counts in depth (B-W2b-299; SCM-226 frozen lines, SCM-227 count schedules, SCM-228 counting by scanning every unit, SCM-229
 * recount and approval, SCM-293 separation of duties). No field carries money but the ABC share (a cost: only with the cost
 * grain); no list names a person; the floor reads no expected quantity before "Bin done" (blind count).
 */

const version = () => z.number().int().min(1)
const place = output({ id: id(), code: z.string(), name: z.string(), labelCode: z.string().nullable() })
const words = output({ en: z.string(), it: z.string() })
const scheduleParams = input({ scheduleId: id() })
const countParams = input({ countId: id() })
const binParams = input({ countId: id(), locationId: id() })
const name = z.string().trim().min(1).max(SCHEDULE_LIMITS.name)
const note = z.string().trim().max(SCHEDULE_LIMITS.note).nullable().optional()
const everyDays = z.number().int().min(SCHEDULE_LIMITS.minDays).max(SCHEDULE_LIMITS.maxDays)

// ---- count schedules (SCM-227) -------------------------------------------------------------------------------------------

export const scheduleView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  name: z.string(),
  location: output({ id: id(), code: z.string(), name: z.string(), path: z.string() }).nullable(),
  abcClass: z.enum(ABC_CLASSES).nullable(),
  itemKind: z.enum(COUNT_ITEM_KINDS).nullable(),
  /** The scope in words ("Location A1-LEA and everything inside it · Class A materials"). */
  scope: words,
  everyDays: z.number().int(),
  nextDueOn: businessDate(),
  lastCountedOn: businessDate().nullable(),
  lastCount: output({ id: id(), number: z.string() }).nullable(),
  active: z.boolean(),
  note: z.string().nullable(),
  /** Where it stands today (Europe/Rome): OVERDUE, DUE_TODAY, DUE_SOON (this week), LATER, RETIRED. */
  due: z.enum(['OVERDUE', 'DUE_TODAY', 'DUE_SOON', 'LATER', 'RETIRED']),
  overdueDays: z.number().int(),
  /** Its open COUNT task (the floor's inbox), when one waits. */
  openTaskId: id().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listSchedulesContract = defineContract({
  querystring: input({ siteId: id().optional(), active: z.enum(['true', 'false', 'all']).optional() }),
  response: { 200: output({ schedules: z.array(scheduleView) }) },
})

export const dueSchedulesContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      today: businessDate(),
      /** The tiles: overdue, due today, due this week (overdue, today and the next six days). */
      tiles: output({ overdue: z.number().int(), dueToday: z.number().int(), dueThisWeek: z.number().int() }),
      /** The Due counts section: active schedules due this week, most overdue first. */
      rows: z.array(scheduleView),
    }),
  },
})

export const createScheduleBody = input({
  siteId: id(),
  name,
  locationId: id().nullable().optional(),
  abcClass: z.enum(ABC_CLASSES).nullable().optional(),
  itemKind: z.enum(COUNT_ITEM_KINDS).nullable().optional(),
  everyDays,
  /** The first count's day; left out: today. */
  nextDueOn: businessDate().optional(),
  note,
})
export const createScheduleContract = defineContract({ body: createScheduleBody, response: { 201: output({ schedule: scheduleView }) } })

export const changeScheduleContract = defineContract({
  params: scheduleParams,
  body: input({
    version: version(),
    name: name.optional(),
    locationId: id().nullable().optional(),
    abcClass: z.enum(ABC_CLASSES).nullable().optional(),
    itemKind: z.enum(COUNT_ITEM_KINDS).nullable().optional(),
    everyDays: everyDays.optional(),
    nextDueOn: businessDate().optional(),
    note,
    /** false: retired (makes no more counts); true: active again. */
    active: z.boolean().optional(),
  }),
  response: { 200: output({ schedule: scheduleView }) },
})

export const startScheduleContract = defineContract({
  params: scheduleParams,
  body: input({
    /** Freeze the counted lines' moves until each is counted (SCM-226); default true for a schedule's count. */
    freeze: z.boolean().optional(),
    countTeam: z.string().trim().max(120).nullable().optional(),
  }),
  response: { 201: output({ countId: id(), number: z.string(), lines: z.number().int() }) },
})

export const abcContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      siteId: id(),
      days: z.number().int(),
      rules: output({ aPercent: z.number(), bPercent: z.number() }),
      materials: z.array(
        output({
          item: output({ id: id(), code: z.string(), name: z.string(), kind: z.string() }),
          abcClass: z.enum(ABC_CLASSES),
          rank: z.number().int(),
          /** Its share of the value used (percent): a cost figure, only with the cost grain. */
          sharePercent: z.string().nullable().optional(),
        }),
      ),
      counts: output({ A: z.number().int(), B: z.number().int(), C: z.number().int() }),
    }),
  },
})

// ---- frozen lines (SCM-226) ----------------------------------------------------------------------------------------------

export const frozenContract = defineContract({
  querystring: input({ siteId: id().optional(), locationId: id().optional(), itemId: id().optional() }),
  response: {
    200: output({
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          count: output({ id: id(), number: z.string() }),
          location: place,
          item: output({ id: id(), code: z.string(), name: z.string() }),
          lot: output({ id: id(), code: z.string() }).nullable(),
          hide: output({ id: id(), code: z.string() }).nullable(),
          frozenAt: instant(),
          /** What it waits for: its count, or its asked recount. */
          waitsFor: z.enum(['COUNT', 'RECOUNT']),
        }),
      ),
      /** The words a move of these meets. */
      words: words,
    }),
  },
})

// ---- counting by scan (SCM-228) ------------------------------------------------------------------------------------------

const binLineView = output({
  lineId: id(),
  seq: z.number().int(),
  origin: z.enum(['SNAPSHOT', 'ADDED']),
  item: output({ id: id(), code: z.string(), name: z.string(), uom: z.string(), tracking: z.string() }),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  /** The pass it is scanned in now; null: counted (finished). */
  pass: z.enum(SCAN_PASSES).nullable(),
  /** Units scanned in that pass, and what they hold (the big numeral). */
  scans: z.number().int(),
  scanned: quantity(),
  /** Blind: the expected quantity only once the bin is done. */
  expected: quantity().optional(),
})

const countRef = output({ id: id(), number: z.string(), kind: z.enum(STOCK_COUNT_KINDS), status: z.enum(STOCK_COUNT_STATUSES), freezeMoves: z.boolean() })

export const toCountContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      asOf: instant(),
      /** Bins of the site's running counts with lines to count or to recount (rows: bin, kind, since); empty: "No count planned. Scan a bin to count it." */
      bins: z.array(
        output({
          count: countRef,
          location: place,
          kind: z.enum(SCAN_PASSES),
          lines: z.number().int(),
          since: instant(),
          /** A recount the caller may not do (they counted it): shown, not offered. */
          yours: z.boolean(),
        }),
      ),
    }),
  },
})

export const binContract = defineContract({
  querystring: input({ placeCode: z.string().trim().min(1).max(80), countId: id().optional() }),
  response: {
    200: output({
      location: place,
      /** The running counts that count this bin (more than one: name `countId`). */
      counts: z.array(countRef),
      count: countRef.nullable(),
      lines: z.array(binLineView),
    }),
  },
})

export const scanBody = input({
  /** The bin's label (or its code). */
  placeCode: z.string().trim().min(1).max(80),
  /** What was scanned: a hide's tag, a roll's tag, a lot's label; left out: typed on the number pad for `lineId`. */
  code: z.string().trim().min(1).max(120).regex(/^\S+$/, { message: 'A scanned code has no spaces.' }).optional(),
  /** The line counted when nothing was scanned (an item without a label). */
  lineId: id().optional(),
  /** In the item's base unit: what the unit holds (required on the number pad or for a lot's label; a hide's area and a roll's length are known). */
  quantity: quantity().optional(),
  /** When it was scanned, by the tablet's clock (a queued scan). */
  scannedAt: instant().optional(),
})
export const scanContract = defineContract({
  params: countParams,
  body: scanBody,
  response: {
    201: output({
      scanId: id(),
      count: countRef,
      line: binLineView,
      /** The unit was not expected in this bin: its line was added (ADDED). */
      added: z.boolean(),
      quantity: quantity(),
    }),
  },
})

const differenceView = output({
  lineId: id(),
  seq: z.number().int(),
  item: output({ id: id(), code: z.string(), name: z.string(), uom: z.string() }),
  lot: output({ id: id(), code: z.string() }).nullable(),
  hide: output({ id: id(), code: z.string() }).nullable(),
  pass: z.enum(SCAN_PASSES),
  expected: quantity(),
  scanned: quantity(),
  scans: z.number().int(),
  difference: z.string(),
  kind: z.enum(['MATCH', 'MISSING', 'EXTRA', 'SHORT', 'OVER']),
})

export const binDoneContract = defineContract({
  params: binParams,
  response: {
    200: output({
      count: countRef,
      location: place,
      differences: z.array(differenceView),
      /** "No difference." */
      none: z.boolean(),
      /** Moves into or out of the bin since the count started (a note on the differences step), with the words. */
      movedSinceStart: z.number().int(),
      note: words.nullable(),
    }),
  },
})

export const finishBody = input({ occurredAt: instant().optional() })
export const finishContract = defineContract({
  params: binParams,
  body: finishBody,
  response: {
    200: output({
      count: countRef,
      location: place,
      differences: z.array(differenceView),
      /** The lines whose recount the rule asked now (another person recounts them). */
      recountsAsked: z.array(output({ lineId: id(), seq: z.number().int() })),
      lines: z.number().int(),
      counted: z.number().int(),
    }),
  },
})

// ---- separation of duties (SCM-293) --------------------------------------------------------------------------------------

const switchView = output({
  rule: z.enum(SEPARATION_RULES),
  /** The scope's own value; null: as every company (a company) or the default, on (every company). */
  own: z.boolean().nullable(),
  inForce: output({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']) }),
  words,
})

export const separationView = output({
  companyId: id().nullable(),
  version: z.number().int(),
  updatedAt: instant().nullable(),
  changedBy: output({ id: id(), name: z.string() }).nullable(),
  mayChange: z.boolean(),
  switches: z.array(switchView),
  /** Why a rule of this scope is off (asked when it was switched off). */
  offReason: z.string().nullable(),
})

export const separationContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: separationView },
})

export const saveSeparationContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    version: z.number().int().min(0),
    /** null: as every company (a company), or the default, on (every company). Left out: unchanged. */
    counterNotApprover: z.boolean().nullable().optional(),
    receiverNotMatcher: z.boolean().nullable().optional(),
    /** Switching a rule off asks why (1 to 500 characters), and a fresh code. */
    reason: z.string().max(1000).nullable().optional(),
  }),
  response: { 200: output({ rules: separationView, loosened: z.array(z.enum(SEPARATION_RULES)) }) },
})
