import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { BOARD_SHAPES, STATION_BOARD_STATES } from '@nexus/factory-domain/production/boards/board'
import { HEAT_LEVELS } from '@nexus/factory-domain/production/boards/heatmap'
import { HOUR_STATES, PACES } from '@nexus/factory-domain/production/boards/hourly'
import { TARGET_LIMITS } from '@nexus/factory-domain/production/boards/targets'
import { FLOOR_TONES } from '@nexus/factory-domain/auth/floor/literacy'
import { STATION_CALL_STATES } from '@nexus/factory-domain/production/calls/rules'
import { notMoney } from '@nexus/factory-domain/money/marked'

/**
 * Line targets and boards' routes (B-W2b-50; MES-084, MES-161, MES-162, MES-166, ANA-007; design production.floor "Hour by
 * hour", "WIP by operation" heat map, "Why was 10:00–11:00 short?", "Line TV board"; floor.display SCR-173). Line and team
 * totals only: no worker, no person id, no figure per person, no money anywhere (a display device has no grain at all). A
 * board rule's refusal is a 409 with the issues `refusal/<CODE>` (factory-domain production/boards/targets BOARD_REFUSALS)
 * and `fix`.
 */

const version = () => z.number().int().min(1)
const words = z.record(z.string(), z.string())
const place = output({ id: id(), code: z.string(), name: z.string() })
const look = output({ icon: z.string(), tone: z.enum(FLOOR_TONES) })
const site = output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() })
const reasonWords = output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() })
const shift = output({ label: z.string().nullable(), start: z.string(), end: z.string() }).nullable()

const target = output({ id: id(), targetPieces: z.number().int(), version: z.number().int() })

/** One hour of a line's day. */
const hourOut = output({
  hour: z.number().int(),
  /** `10:00–11:00`. */
  label: z.string(),
  start: z.string(),
  end: z.string(),
  state: z.enum(HOUR_STATES),
  /** Working minutes of the line's calendar in the hour. */
  workingMinutes: z.number().int(),
  /** Garments out of the line's last operation in the hour (the line's team, never a person). */
  done: z.number().int(),
  target: target.nullable(),
  /** Over and below its target. */
  short: z.boolean(),
  /** Help calls sent from the line's stations in the hour (a count). */
  calls: z.number().int(),
  /** The reason given for a short hour: its downtime code's words, the words typed with it, when. Never who. */
  reason: output({ ...reasonWords.shape, note: z.string().nullable(), at: z.string() }).nullable(),
})

const totals = output({
  done: z.number().int(),
  target: z.number().int().nullable(),
  targetSoFar: z.number().int().nullable(),
  pace: z.enum(PACES),
  paceLook: look,
  shortHours: z.number().int(),
})

const lineHours = output({
  line: place,
  shift,
  hours: z.array(hourOut),
  /** Pieces, never money. */
  totals: notMoney(totals),
  /** The caller may give the reason of a short hour on this line. */
  canGiveReason: z.boolean(),
})

// ---- the targets of a line's day (MES-084) -------------------------------------------------------------------------------

export const targetsContract = defineContract({
  querystring: input({ lineId: id(), date: businessDate().optional() }),
  response: {
    200: output({
      line: place,
      site,
      day: businessDate(),
      today: businessDate(),
      /** A past day's targets are history: read only. */
      past: z.boolean(),
      shift,
      /** Every hour with working time or a target, in order (the grid the office fills). */
      hours: z.array(output({ hour: z.number().int(), label: z.string(), workingMinutes: z.number().int(), target: target.nullable(), reasonGiven: z.boolean() })),
      /** The day's target pieces together, never money. */
      total: notMoney(z.number().int().nullable()),
      canSet: z.boolean(),
    }),
  },
})

export const setTargetsContract = defineContract({
  body: input({
    lineId: id(),
    date: businessDate(),
    hours: z
      .array(
        input({
          hour: z.number().int().min(0).max(23),
          /** null removes the hour's target. */
          targetPieces: z.number().int().min(0).max(TARGET_LIMITS.maxPieces).nullable(),
          /** The version read (a stale one is a 409). */
          version: version().optional(),
        }),
      )
      .min(1)
      .max(24),
  }),
  response: {
    200: output({ line: place, day: businessDate(), set: z.array(z.number().int()), removed: z.array(z.number().int()), unchanged: z.array(z.number().int()), total: notMoney(z.number().int().nullable()) }),
  },
})

export const reasonContract = defineContract({
  params: input({ targetId: id() }),
  body: input({
    reasonCode: z.string().trim().min(1).max(60),
    note: z.string().trim().max(TARGET_LIMITS.note).optional(),
    version: version(),
  }),
  response: { 200: output({ targetId: id(), version: z.number().int(), hour: hourOut }) },
})

// ---- hour by hour (MES-161) ------------------------------------------------------------------------------------------------

export const hourlyContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional(), date: businessDate().optional() }),
  response: {
    200: output({
      asOf: z.string(),
      site,
      day: businessDate(),
      today: businessDate(),
      lines: z.array(lineHours),
      /** The downtime reasons a short hour can be given with (active, in their order). */
      reasons: z.array(output({ ...reasonWords.shape, needsDetail: z.boolean() })),
    }),
  },
})

// ---- the WIP heat map (MES-162) --------------------------------------------------------------------------------------------

export const heatmapContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      asOf: z.string(),
      site,
      columns: z.array(output({ code: z.string(), name: z.string() })),
      rows: z.array(
        output({
          /** null: bundles on no line yet. */
          line: place.nullable(),
          bundles: z.number().int(),
          pieces: z.number().int(),
          stuck: z.number().int(),
          cells: z.array(output({ code: z.string(), bundles: z.number().int(), pieces: z.number().int(), stuck: z.number().int(), level: z.enum(HEAT_LEVELS), pile: z.boolean() })),
        }),
      ),
      max: z.number().int(),
      stuckLimitHours: z.number().int(),
      /** More open bundles than one read follows. */
      capped: z.boolean(),
    }),
  },
})

// ---- the line TV board (ANA-007, MES-166) ----------------------------------------------------------------------------------

const boardOut = output({
  asOf: z.string(),
  line: place,
  site,
  day: businessDate(),
  shift,
  output: output({
    ...totals.shape,
    hours: z.array(output({ hour: z.number().int(), label: z.string(), state: z.enum(HOUR_STATES), done: z.number().int(), targetPieces: z.number().int().nullable(), short: z.boolean(), reason: reasonWords.nullable() })),
  }),
  /** Each station by colour, shape and word: no names, no output per station (Owner answer F2). */
  stations: z.array(
    output({
      ...place.shape,
      call: z.enum(STATION_CALL_STATES),
      material: z.boolean(),
      machineDown: z.boolean(),
      state: z.enum(STATION_BOARD_STATES),
      look: output({ ...look.shape, shape: z.enum(BOARD_SHAPES) }),
    }),
  ),
  wip: output({
    bundles: z.number().int(),
    pieces: z.number().int(),
    stuck: z.number().int(),
    operations: z.array(output({ code: z.string(), name: z.string(), bundles: z.number().int(), pieces: z.number().int(), stuck: z.number().int(), level: z.enum(HEAT_LEVELS), pile: z.boolean() })),
    capped: z.boolean(),
  }),
  quality: output({ dhu: z.string().nullable(), defects: z.number().int(), units: z.number().int() }),
  /** The team leader's note: the line's latest handover note of the day; null hides the panel. */
  note: output({ shiftLabel: z.string(), topics: z.array(z.string()), text: z.string().nullable(), at: z.string() }).nullable(),
})

export const tvContract = defineContract({
  querystring: input({ lineId: id().optional() }),
  response: { 200: boardOut },
})

export const displayContract = defineContract({
  response: { 200: output({ ...boardOut.shape, device: output({ id: id(), name: z.string(), mode: z.literal('DISPLAY') }) }) },
})
