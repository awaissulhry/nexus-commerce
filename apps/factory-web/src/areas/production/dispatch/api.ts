import { z } from 'zod'
import { QUALIFICATION_MODES, type QualificationMode } from '@nexus/factory-domain/people/skills/qualification'
import { SKILL_LEVELS, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import { DISPATCH_STATES } from '@nexus/factory-domain/planning/schedule/dispatch'
import { LOAD_SOURCES, PRESENCE_STATES, type PresenceState } from '@nexus/factory-domain/production/dispatch/load'
import { MATERIAL_STATES, type MaterialState } from '@nexus/factory-domain/production/dispatch/material'
import { ASSIGNMENT_KINDS, SEQUENCE_STATES } from '@nexus/factory-domain/production/dispatch/rules'
import { FLOOR_RULE_MODES, type FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Production › Dispatch (B-W2b-56; SCR-138): every call of the page, each answer checked by its schema (zod drops what the
 * page does not read: every `words` sentence of the API, which is English and meant for logs: the page says it again from
 * codes and figures). The shapes mirror apps/factory-api modules/production/dispatch/contract.ts (B-W2b-49): one read of the
 * board (`GET …/board`), who can take the work (`GET …/operators`), assign, reassign, remove, move, and the printed list
 * as words (`GET …/print/paper`). Load per line and station only; a name beside a station or a card, never a figure.
 */

export type { SkillLevel, PresenceState, MaterialState, QualificationMode, FloorRuleMode }

const operatorSchema = z.object({
  assignmentId: z.string(),
  version: z.number(),
  kind: z.enum(ASSIGNMENT_KINDS),
  workerId: z.string(),
  name: z.string(),
  level: z.enum(SKILL_LEVELS).nullable(),
  trainee: z.boolean(),
  overridden: z.boolean(),
  presence: z.enum(PRESENCE_STATES).nullable(),
  reassign: z.boolean(),
})
export type LaneOperator = z.infer<typeof operatorSchema>

const cardSchema = z.object({
  id: z.string(),
  key: z.string(),
  workOrder: z.object({
    id: z.string(),
    number: z.string(),
    rush: z.boolean(),
    dueDate: z.string().nullable(),
    style: z.object({ code: z.string(), name: z.string() }),
    holdReason: z.string().nullable(),
  }),
  operation: z.object({ id: z.string(), seq: z.number(), name: z.string(), workCentreId: z.string() }),
  previous: z.object({ seq: z.number(), name: z.string() }).nullable(),
  stationId: z.string().nullable(),
  lineId: z.string().nullable(),
  bundles: z.array(z.object({ id: z.string(), code: z.string(), garments: z.number() })),
  whole: z.boolean(),
  pieces: z.number(),
  standardMinutes: z.string(),
  minutes: z.string(),
  state: z.enum(DISPATCH_STATES),
  sequence: z.object({ rule: z.enum(FLOOR_RULE_MODES), state: z.enum(SEQUENCE_STATES) }),
  material: z.object({ state: z.enum(MATERIAL_STATES), date: z.string().nullable() }).nullable(),
  order: z.number().nullable(),
  counted: z.boolean(),
  movable: z.boolean(),
  operators: z.array(operatorSchema),
  reassign: z.boolean(),
})
export type DispatchCard = z.infer<typeof cardSchema>

const stationSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  lineId: z.string().nullable(),
  workCentreId: z.string(),
  operators: z.array(operatorSchema),
  queuedMinutes: z.string(),
  cards: z.array(cardSchema),
  reassign: z.boolean(),
})
export type StationLane = z.infer<typeof stationSchema>

const loadSchema = z.object({
  queuedMinutes: z.number(),
  availableMinutes: z.number(),
  overMinutes: z.number(),
  spareMinutes: z.number(),
  source: z.enum(LOAD_SOURCES),
  people: z.number().nullable(),
  efficiencyPct: z.string(),
  absent: z.number().nullable(),
})
export type LineLoadFigures = z.infer<typeof loadSchema>

const lineSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), load: loadSchema, stations: z.array(stationSchema) })
export type DispatchLine = z.infer<typeof lineSchema>

export const boardSchema = z.object({
  site: z.object({ id: z.string(), code: z.string(), name: z.string(), timeZone: z.string() }),
  day: z.string(),
  today: z.string(),
  past: z.boolean(),
  asOf: z.string(),
  version: z.object({ number: z.number() }).nullable(),
  rules: z.object({ sequence: z.enum(FLOOR_RULE_MODES), qualification: z.enum(QUALIFICATION_MODES), namesWorkers: z.boolean() }),
  attendance: z.object({ open: z.boolean() }),
  lines: z.array(lineSchema),
  otherStations: z.array(stationSchema),
  notAssigned: z.array(cardSchema),
  mayManage: z.boolean(),
})
export type DispatchBoard = z.infer<typeof boardSchema>

export const pickerSchema = z.object({
  clockedOnly: z.boolean(),
  operators: z.array(
    z.object({
      workerId: z.string(),
      name: z.string(),
      level: z.enum(SKILL_LEVELS).nullable(),
      trainee: z.boolean(),
      onBreak: z.boolean().nullable(),
      decision: z.enum(['ALLOW', 'WARN', 'HOLD']),
      overridable: z.boolean(),
    }),
  ),
  complete: z.boolean(),
})
export type OperatorPicker = z.infer<typeof pickerSchema>
export type PickedOperator = OperatorPicker['operators'][number]

const moveTarget = z.object({
  stationId: z.string().nullable().optional(),
  lineId: z.string().nullable().optional(),
  workerId: z.string().nullable().optional(),
  unplaced: z.boolean().optional(),
  clearWorker: z.boolean().optional(),
})

/** The body of a move; the API's `undo` has this shape too ("every move has Undo": it is posted back as it came). */
export const moveBodySchema = z.object({
  date: z.string().optional(),
  workOrderOperationId: z.string(),
  from: z.string(),
  bundleIds: z.array(z.string()).optional(),
  to: moveTarget,
  position: z.number().optional(),
})
export type MoveBody = z.infer<typeof moveBodySchema> & { readonly overrideReason?: string }

const moveAnswer = z.object({
  moved: z.object({ key: z.string(), bundleIds: z.array(z.string()), whole: z.boolean(), stationId: z.string().nullable(), lineId: z.string().nullable() }),
  warnings: z.array(z.string()),
  undo: moveBodySchema,
})
export type MoveAnswer = z.infer<typeof moveAnswer>

const assignedAnswer = z.object({ assignment: z.object({ id: z.string() }), overridden: z.boolean() })

export const paperSchema = z.object({
  language: z.enum(['it', 'en']),
  title: z.string(),
  heading: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
  columns: z.array(z.string()),
  sections: z.array(z.object({ title: z.string(), operators: z.string().nullable(), rows: z.array(z.object({ rush: z.boolean(), cells: z.array(z.string()) })), footer: z.string() })),
  empty: z.string().nullable(),
  foot: z.string(),
})
export type DispatchPaper = z.infer<typeof paperSchema>

const seg = (value: string) => encodeURIComponent(value)

/** The board of a site's day: the load of each line, the lanes, what has no station yet (production.dispatch.view). */
export const getBoard = (api: ApiClient, ask: { readonly siteId: string; readonly date: string | null }, signal?: AbortSignal) =>
  api.get('/production/dispatch/board', { query: { siteId: ask.siteId, date: ask.date ?? undefined }, schema: boardSchema, signal })

export interface PickerAsk {
  readonly siteId: string
  readonly date: string
  readonly stationId?: string | null
  readonly workOrderOperationId?: string | null
  readonly assignmentId?: string | null
}

/** Who can take this work: the people clocked in (gate open, today), else everybody active, each with the check's answer. */
export const getOperators = (api: ApiClient, ask: PickerAsk, signal?: AbortSignal) =>
  api.get('/production/dispatch/operators', {
    query: { siteId: ask.siteId, date: ask.date, stationId: ask.stationId ?? undefined, workOrderOperationId: ask.workOrderOperationId ?? undefined, assignmentId: ask.assignmentId ?? undefined },
    schema: pickerSchema,
    signal,
  })

export interface AssignBody {
  readonly date: string
  readonly workerId: string
  readonly stationId?: string
  readonly workOrderOperationId?: string
  readonly overrideReason?: string
}

/** production.dispatch.manage: an operator at a station, or on an operation (at a station or not). */
export const assignOperator = (api: ApiClient, body: AssignBody, key = newIdempotencyKey()) => api.post('/production/dispatch/assignments', { body, schema: assignedAnswer, idempotencyKey: key })

/** production.dispatch.manage: someone else takes this work (the check runs again). */
export const reassignOperator = (api: ApiClient, assignment: { readonly id: string; readonly version: number }, body: { readonly workerId: string; readonly overrideReason?: string }, key = newIdempotencyKey()) =>
  api.post(`/production/dispatch/assignments/${seg(assignment.id)}/reassign`, { body: { version: assignment.version, ...body }, schema: assignedAnswer, idempotencyKey: key })

/** production.dispatch.manage (office): nobody at this place any more. */
export const removeOperator = (api: ApiClient, assignment: { readonly id: string; readonly version: number }, key = newIdempotencyKey()) =>
  api.post(`/production/dispatch/assignments/${seg(assignment.id)}/remove`, { body: { version: assignment.version }, schema: z.object({ removed: z.string() }), idempotencyKey: key })

/** production.dispatch.manage (office only): a card or some of its bundles, to a station, a line or back to Not assigned. */
export const moveWork = (api: ApiClient, body: MoveBody, key = newIdempotencyKey()) => api.post('/production/dispatch/moves', { body, schema: moveAnswer, idempotencyKey: key })

export interface PaperAsk {
  readonly lineId: string | null
  readonly stationId: string | null
  readonly date: string | null
  readonly language: 'it' | 'en'
}

/** What the printed list says (the print window), in the page's language. */
export const getPaper = (api: ApiClient, ask: PaperAsk, signal?: AbortSignal) =>
  api.get('/production/dispatch/print/paper', { query: { lineId: ask.lineId ?? undefined, stationId: ask.stationId ?? undefined, date: ask.date ?? undefined, language: ask.language }, schema: paperSchema, signal })
