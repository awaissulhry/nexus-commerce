import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { EXCEPTION_KINDS } from '@nexus/factory-domain/planning/exceptions/detect'
import { EXCEPTION_RESOLUTIONS, EXCEPTION_STATUSES, MAX_EXCEPTIONS_PER_ACTION, RESOLVE_NOTE } from '@nexus/factory-domain/planning/exceptions/lifecycle'

/**
 * The exception list of a site's planning runs (B-W2a-22; PLN-193; design planning.exceptions, SCR-125): what the runs
 * could not solve, as a queue to clear. Facts are decimal strings, ISO dates and words; never money, never a figure
 * per person (an exception's owner is the office person it is for, named in the record).
 */

const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const person = output({ id: id(), name: z.string() })

export const exceptionView = output({
  id: id(),
  siteId: id(),
  kind: z.enum(EXCEPTION_KINDS),
  /** The kind in English (the screens say it from `kind`). */
  label: z.string(),
  occurrence: z.number().int(),
  status: z.enum(EXCEPTION_STATUSES),
  /** What it is about, in one sentence (from the facts, as the run said it). */
  sentence: z.string(),
  item: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The record it is about (an order line, a work order, a purchase order, a line or work centre). */
  record: output({ type: z.string(), id: id(), label: z.string().nullable() }).nullable(),
  /** The latest run's line it comes from. */
  requirementId: id().nullable(),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  ordersAffected: z.number().int(),
  daysLate: z.number().int().nullable(),
  firstRunId: id(),
  lastRunId: id(),
  firstSeenAt: instant(),
  lastSeenAt: instant(),
  /** Whole days since it was first found. */
  ageDays: z.number().int(),
  /** B-W2b-20: the age in the site's working days (the days after the first sighting up to today that the site works). */
  ageWorkingDays: z.number().int(),
  owner: person.nullable(),
  mine: z.boolean(),
  acknowledgedAt: instant().nullable(),
  acknowledgedBy: person.nullable(),
  /** Snoozed now (until a later moment, or until the next run). */
  snoozed: z.boolean(),
  snoozedAt: instant().nullable(),
  /** null while snoozed: until the next run. */
  snoozedUntil: instant().nullable(),
  resolvedAt: instant().nullable(),
  resolution: z.enum(EXCEPTION_RESOLUTIONS).nullable(),
  resolvedBy: person.nullable(),
  resolveNote: z.string().nullable(),
  version: z.number().int(),
})

export const listExceptionsContract = defineContract({
  querystring: input({
    siteId: id(),
    /** Comma-separated statuses; default NEW,ACKNOWLEDGED (the open queue). */
    status: z.string().max(40).optional(),
    kind: z.enum(EXCEPTION_KINDS).optional(),
    mine: flag().optional(),
    /** true: only snoozed now; false: only not snoozed now. */
    snoozed: flag().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      /** The tiles, over the open queue (never the filtered page): NEW, mine, snoozed until today (ends today). */
      tiles: output({ open: z.number().int(), new: z.number().int(), mine: z.number().int(), snoozedUntilToday: z.number().int() }),
      latestRun: output({ id: id(), finishedAt: instant().nullable() }).nullable(),
      exceptions: z.array(exceptionView),
      nextCursor: id().nullable(),
    }),
  },
})

export const getExceptionContract = defineContract({
  params: input({ exceptionId: id() }),
  response: { 200: output({ exception: exceptionView }) },
})

const ref = input({ id: id(), version: z.number().int().min(1) })

export const acknowledgeExceptionsContract = defineContract({
  body: input({ exceptions: z.array(ref).min(1).max(MAX_EXCEPTIONS_PER_ACTION) }),
  response: { 200: output({ exceptions: z.array(exceptionView), replayed: z.boolean() }) },
})

export const snoozeExceptionContract = defineContract({
  params: input({ exceptionId: id() }),
  body: input({ version: z.number().int().min(1), until: instant().nullable() }),
  response: { 200: output({ exception: exceptionView, replayed: z.boolean() }) },
})

export const resolveExceptionContract = defineContract({
  params: input({ exceptionId: id() }),
  body: input({ version: z.number().int().min(1), note: z.string().max(RESOLVE_NOTE.max + 100) }),
  response: { 200: output({ exception: exceptionView, replayed: z.boolean() }) },
})
