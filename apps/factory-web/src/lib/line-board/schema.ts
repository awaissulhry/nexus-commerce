import { z } from 'zod'
import { FLOOR_TONES } from '@nexus/factory-domain/auth/floor/literacy'
import { BOARD_SHAPES, STATION_BOARD_STATES } from '@nexus/factory-domain/production/boards/board'
import { HEAT_LEVELS } from '@nexus/factory-domain/production/boards/heatmap'
import { HOUR_STATES, PACES } from '@nexus/factory-domain/production/boards/hourly'
import { STATION_CALL_STATES } from '@nexus/factory-domain/production/calls/rules'

/**
 * The line TV board's answer (B-W2b-50, GET /production/boards/display on a DISPLAY device, GET /production/boards/tv in
 * the Office's preview: the same JSON), checked by its schema. Line and team totals only: nobody's name, no output per
 * station, no money. The shapes mirror apps/factory-api modules/production/boards/contract.ts.
 */

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const look = z.object({ icon: z.string(), tone: z.enum(FLOOR_TONES) })

/** The words of a reason code: its code's words only on a board, never the words typed with it. */
export const boardReasonSchema = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() })
export type BoardReason = z.infer<typeof boardReasonSchema>

export const boardHourSchema = z.object({ hour: z.number(), label: z.string(), state: z.enum(HOUR_STATES), done: z.number(), targetPieces: z.number().nullable(), short: z.boolean(), reason: boardReasonSchema.nullable() })
export type BoardHour = z.infer<typeof boardHourSchema>

export const boardStationSchema = z.object({
  ...place.shape,
  call: z.enum(STATION_CALL_STATES),
  material: z.boolean(),
  machineDown: z.boolean(),
  state: z.enum(STATION_BOARD_STATES),
  look: look.extend({ shape: z.enum(BOARD_SHAPES) }),
})
export type BoardStation = z.infer<typeof boardStationSchema>

export const boardOperationSchema = z.object({ code: z.string(), name: z.string(), bundles: z.number(), pieces: z.number(), stuck: z.number(), level: z.enum(HEAT_LEVELS), pile: z.boolean() })
export type BoardOperation = z.infer<typeof boardOperationSchema>

export const boardSchema = z.object({
  asOf: z.string(),
  line: place,
  site: place.extend({ timeZone: z.string() }),
  day: z.string(),
  shift: z.object({ label: z.string().nullable(), start: z.string(), end: z.string() }).nullable(),
  output: z.object({ done: z.number(), target: z.number().nullable(), targetSoFar: z.number().nullable(), pace: z.enum(PACES), paceLook: look, shortHours: z.number(), hours: z.array(boardHourSchema) }),
  stations: z.array(boardStationSchema),
  wip: z.object({ bundles: z.number(), pieces: z.number(), stuck: z.number(), operations: z.array(boardOperationSchema), capped: z.boolean() }),
  quality: z.object({ dhu: z.string().nullable(), defects: z.number(), units: z.number() }),
  note: z.object({ shiftLabel: z.string(), topics: z.array(z.string()), text: z.string().nullable(), at: z.string() }).nullable(),
})
export type LineBoard = z.infer<typeof boardSchema>
