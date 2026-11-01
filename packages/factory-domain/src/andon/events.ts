import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CALL_ACTORS, CALL_KINDS, CALL_STATUSES, CALL_STEPS, OUTCOME_TYPES } from '../production/calls/rules'

/**
 * The line's signals (B-W2b-35; andon.prisma): help calls from the stations and their types (MES-142 … MES-145, MES-147,
 * MES-137; design production.calls "Live: call raised → the queue at once", floor.help "status and sound here",
 * floor.supervisor "Calls arrive live", floor.display "calls … at once, via the live channel"). apps/factory-api's
 * modules/production/calls emits them in the commands that make the change. The module is `andon` (the schema file's
 * name), not `production`: production's events file is another step's.
 *
 *   help_call.raised       a station sent a call (one tap; a second tap of the same type answers the open call and
 *                          raises nothing): its station, line, type and what it is about
 *   help_call.answered     a step of a call: seen, on the way, solved or cancelled, by a responder or by the station
 *                          that sent it
 *   help_call.changed      a call got its details (words added at the station) or what it led to (a maintenance job…)
 *   help_call_type.changed a site's help-call type was added, changed, switched off or on again (the floor's tiles and
 *                          the office's routing read it again)
 *
 * Every one reaches the office's Help calls (production.calls.view) and the floor devices of the call's site (floor.work:
 * the station's own call, the team leader's line view, the line TV). Ids, codes and states only: never a person (the
 * caller or who answered), never a typed word, never a response time (a call's time is read from the call).
 *
 * B-W2b-50 (MES-084, MES-161; modules/production/boards) adds a line's hourly targets (LineTarget, the same schema file):
 *   line_targets.changed       the office set, changed or removed hours of a line's day
 *   line_target.reason_given   the reason for a short hour was given (the team leader on the floor, or the office)
 */

const kind = z.enum(CALL_KINDS)
const by = z.enum(['OFFICE', 'FLOOR'])
const callLive = { permission: 'production.calls.view', floor: 'floor.work' } as const
/** B-W2b-50: the boards' events reach Floor now and the team leader's line view. */
const boardsLive = { permission: 'production.boards.view', floor: 'production.boards.view' } as const

export const events = [
  defineEvent({
    type: 'help_call.raised',
    context: 'andon',
    description: 'A station sent a help call in one tap: its station, line and type (material, machine, quality, team leader, maintenance, safety …) and the work order or bundle it is about.',
    payload: z.strictObject({
      callId: z.uuid(),
      typeId: z.uuid(),
      code: z.string(),
      kind,
      stationId: z.uuid(),
      lineId: z.uuid().nullable(),
      responderTeamId: z.uuid().nullable(),
      workOrderId: z.uuid().nullable(),
      bundleId: z.uuid().nullable(),
      by,
    }),
    live: { ...callLive, fields: ['callId', 'stationId', 'lineId', 'kind', 'code'] },
  }),
  defineEvent({
    type: 'help_call.answered',
    context: 'andon',
    description: 'A help call moved: seen, someone on the way, solved or cancelled, by a responder or by the station that sent it.',
    payload: z.strictObject({
      callId: z.uuid(),
      typeId: z.uuid(),
      kind,
      stationId: z.uuid(),
      lineId: z.uuid().nullable(),
      step: z.enum(CALL_STEPS),
      status: z.enum(CALL_STATUSES),
      actor: z.enum(CALL_ACTORS),
      by,
    }),
    live: { ...callLive, fields: ['callId', 'stationId', 'lineId', 'kind', 'step', 'status'] },
  }),
  defineEvent({
    type: 'help_call.changed',
    context: 'andon',
    description: 'A help call got its details from the station, or what it led to was named (a maintenance job, a machine request, a nonconformance, a task).',
    payload: z.strictObject({
      callId: z.uuid(),
      stationId: z.uuid(),
      lineId: z.uuid().nullable(),
      change: z.enum(['DETAILS', 'OUTCOME']),
      outcomeRecordType: z.enum(OUTCOME_TYPES).nullable(),
    }),
    live: { ...callLive, fields: ['callId', 'stationId', 'lineId', 'change'] },
  }),
  defineEvent({
    type: 'help_call_type.changed',
    context: 'andon',
    description: "A site's help-call type was added, changed (its team, escalation, waiting code or order), switched off or switched on again (the names of the fields only).",
    payload: z.strictObject({
      typeId: z.uuid(),
      code: z.string(),
      kind,
      change: z.enum(['ADDED', 'CHANGED', 'SWITCHED_OFF', 'SWITCHED_ON']),
      fields: z.array(z.string()),
    }),
    live: { ...callLive, fields: ['typeId', 'code', 'change'] },
  }),
  // ---- B-W2b-50: a line's hourly targets and the reason of a short hour (LineTarget, andon.prisma) -------------------------
  // The office's Floor now (production.boards.view) and the team leader's line view (the floor shares the permission) read
  // the hour by hour again. Ids, hours and codes only: never a person, never the typed words of a reason.
  defineEvent({
    type: 'line_targets.changed',
    context: 'andon',
    description: "A line's hourly targets of a day were set, changed or removed by the office (the hours that changed).",
    payload: z.strictObject({
      lineId: z.uuid(),
      workDate: z.iso.date(),
      set: z.array(z.number().int().min(0).max(23)),
      removed: z.array(z.number().int().min(0).max(23)),
    }),
    live: { ...boardsLive, fields: ['lineId', 'workDate', 'set', 'removed'] },
  }),
  defineEvent({
    type: 'line_target.reason_given',
    context: 'andon',
    description: "The reason for a line's short hour was given (a code of the downtime reason list), by the team leader on the floor or by the office.",
    payload: z.strictObject({
      targetId: z.uuid(),
      lineId: z.uuid(),
      workDate: z.iso.date(),
      hour: z.number().int().min(0).max(23),
      reasonCode: z.string(),
      by,
    }),
    live: { ...boardsLive, fields: ['targetId', 'lineId', 'workDate', 'hour', 'reasonCode'] },
  }),
] as const
