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
 */

const kind = z.enum(CALL_KINDS)
const by = z.enum(['OFFICE', 'FLOOR'])
const callLive = { permission: 'production.calls.view', floor: 'floor.work' } as const

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
] as const
