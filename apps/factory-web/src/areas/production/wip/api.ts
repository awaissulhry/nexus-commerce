import { z } from 'zod'
import { HEAT_LEVELS } from '@nexus/factory-domain/production/boards/heatmap'
import { HOUR_STATES, PACES } from '@nexus/factory-domain/production/boards/hourly'
import { BUNDLE_PLACES } from '@nexus/factory-domain/production/bundles/where'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { boardReasonSchema, boardSchema, type LineBoard } from '../../../lib/line-board/schema'

/**
 * Floor now's W2b calls (B-W2b-66; SCR-073, SCR-173's office preview), each answer checked by its schema. The shapes mirror
 * apps/factory-api modules/production/boards/contract.ts (B-W2b-50) and modules/production/bundles/contract.ts
 * (B-W2b-41): hour by hour, a short hour's reason, a line's targets, the heat map and a cell's bundles, the stuck bundles
 * and the tile's count, the TV's board. Line totals only: nothing by person, no money.
 */

const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const site = place.extend({ timeZone: z.string() })
const target = z.object({ id: z.string(), targetPieces: z.number(), version: z.number() })
const look = z.object({ icon: z.string(), tone: z.string() })
const shift = z.object({ label: z.string().nullable(), start: z.string(), end: z.string() }).nullable()

export const hourSchema = z.object({
  hour: z.number(),
  label: z.string(),
  start: z.string(),
  end: z.string(),
  state: z.enum(HOUR_STATES),
  workingMinutes: z.number(),
  done: z.number(),
  target: target.nullable(),
  short: z.boolean(),
  calls: z.number(),
  reason: boardReasonSchema.extend({ note: z.string().nullable(), at: z.string() }).nullable(),
})
export type Hour = z.infer<typeof hourSchema>

const lineHoursSchema = z.object({
  line: place,
  shift,
  hours: z.array(hourSchema),
  totals: z.object({ done: z.number(), target: z.number().nullable(), targetSoFar: z.number().nullable(), pace: z.enum(PACES), paceLook: look, shortHours: z.number() }),
  canGiveReason: z.boolean(),
})
export type LineHours = z.infer<typeof lineHoursSchema>

export const reasonOptionSchema = boardReasonSchema.extend({ needsDetail: z.boolean() })
export type ReasonOption = z.infer<typeof reasonOptionSchema>

export const hourlySchema = z.object({ asOf: z.string(), site, day: z.string(), today: z.string(), lines: z.array(lineHoursSchema), reasons: z.array(reasonOptionSchema) })
export type HourlyAnswer = z.infer<typeof hourlySchema>

const cellSchema = z.object({ code: z.string(), bundles: z.number(), pieces: z.number(), stuck: z.number(), level: z.enum(HEAT_LEVELS), pile: z.boolean() })
export const heatmapSchema = z.object({
  asOf: z.string(),
  site,
  columns: z.array(z.object({ code: z.string(), name: z.string() })),
  rows: z.array(z.object({ line: place.nullable(), bundles: z.number(), pieces: z.number(), stuck: z.number(), cells: z.array(cellSchema) })),
  max: z.number(),
  stuckLimitHours: z.number(),
  capped: z.boolean(),
})
export type HeatmapAnswer = z.infer<typeof heatmapSchema>

const opRef = z.object({ code: z.string(), name: z.string() })
export const trackedBundleSchema = z.object({
  id: z.string(),
  code: z.string(),
  siteId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }),
  size: z.string(),
  quantity: z.number(),
  place: z.enum(BUNDLE_PLACES),
  next: opRef.nullable(),
  operation: opRef.nullable(),
  lastScan: z.object({ at: z.string(), operation: opRef.nullable(), station: z.object({ code: z.string(), name: z.string() }).nullable() }).nullable(),
  stuck: z.object({ stuck: z.boolean(), workingHours: z.number(), limitHours: z.number() }),
})
export type TrackedBundle = z.infer<typeof trackedBundleSchema>

const bundlesAnswer = z.object({ bundles: z.array(trackedBundleSchema), capped: z.boolean(), asOf: z.string() })
export type BundlesAnswer = z.infer<typeof bundlesAnswer>

const tilesSchema = z.object({ stuck: z.number(), stuckLimitHours: z.number().nullable() })
export type BundleTiles = z.infer<typeof tilesSchema>

const targetsSchema = z.object({
  line: place,
  site,
  day: z.string(),
  today: z.string(),
  past: z.boolean(),
  hours: z.array(z.object({ hour: z.number(), label: z.string(), workingMinutes: z.number(), target: target.nullable(), reasonGiven: z.boolean() })),
  total: z.number().nullable(),
  canSet: z.boolean(),
})
export type LineTargets = z.infer<typeof targetsSchema>

export function getHourly(api: ApiClient, siteId: string): Promise<HourlyAnswer> {
  return api.get('/production/boards/hourly', { query: { siteId }, schema: hourlySchema })
}

export function giveReason(api: ApiClient, targetId: string, body: { reasonCode: string; note?: string; version: number }): Promise<unknown> {
  return api.post(`/production/boards/targets/${encodeURIComponent(targetId)}/reason`, { body, idempotencyKey: newIdempotencyKey() })
}

export function getTargets(api: ApiClient, lineId: string): Promise<LineTargets> {
  return api.get('/production/boards/targets', { query: { lineId }, schema: targetsSchema })
}

export function setTargets(api: ApiClient, body: { lineId: string; date: string; hours: readonly { hour: number; targetPieces: number | null; version?: number }[] }): Promise<unknown> {
  return api.request('PUT', '/production/boards/targets', { body, idempotencyKey: newIdempotencyKey() })
}

export function getHeatmap(api: ApiClient, siteId: string): Promise<HeatmapAnswer> {
  return api.get('/production/boards/heatmap', { query: { siteId }, schema: heatmapSchema })
}

export function getHeatCell(api: ApiClient, query: { siteId: string; lineId: string | null; code: string }): Promise<BundlesAnswer> {
  return api.get('/production/boards/heatmap/cell', { query: { siteId: query.siteId, lineId: query.lineId ?? undefined, code: query.code }, schema: bundlesAnswer })
}

export function getStuck(api: ApiClient, siteId: string | null): Promise<BundlesAnswer> {
  return api.get('/production/bundles/stuck', { query: { siteId: siteId ?? undefined }, schema: bundlesAnswer })
}

export function getBundleTiles(api: ApiClient, siteId: string | null): Promise<BundleTiles> {
  return api.get('/production/bundles/tiles', { query: { siteId: siteId ?? undefined }, schema: tilesSchema })
}

/** The Office's preview of a line's TV: the same board as the wall's (SCR-173 display.preview). */
export function getTvBoard(api: ApiClient, lineId: string): Promise<LineBoard> {
  return api.get('/production/boards/tv', { query: { lineId }, schema: boardSchema })
}
