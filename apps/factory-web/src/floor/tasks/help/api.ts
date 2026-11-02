import { z } from 'zod'
import { CALL_KINDS, CALL_STATUSES } from '@nexus/factory-domain/production/calls/rules'
import type { ApiClient } from '../../../lib/api/client'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'

/**
 * Call for help's calls (B-W2b-70 on the API of B-W2b-35, apps/factory-api modules/production/calls; design floor.help
 * SCR-172): the tablet's station with its tiles and open calls, and the words added to an open call. Sending a call and
 * closing one go through the tablet's queue (`andon.call.send`, `andon.call.answer`: saved here first, so they work
 * offline); words on a call have no queued kind and wait for the network. Each answer is checked against the fields the
 * screen reads. No money; the caller and a floor responder by name only inside this one call; an office responder comes
 * with no name (the floor reads no user table).
 */

const words = z.record(z.string(), z.string())
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })
const typeWords = { code: z.string(), labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() }
const person = z.object({ kind: z.enum(['USER', 'WORKER']), name: z.string().nullable() })

export const CALL_PROGRESS = ['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED'] as const

export const callSchema = z.object({
  id: z.string(),
  version: z.number(),
  status: z.enum(CALL_STATUSES),
  open: z.boolean(),
  type: z.object({ id: z.string(), kind: z.enum(CALL_KINDS), ...typeWords }),
  station: place,
  line: place.nullable(),
  responderTeam: place.nullable(),
  note: z.string().nullable(),
  sentAt: z.string(),
  timeline: z.array(z.object({ step: z.enum(CALL_PROGRESS), at: z.string(), by: person.nullable() })),
  coming: z.object({ step: z.enum(['SEEN', 'ON_THE_WAY']), by: person.nullable(), team: place.nullable() }).nullable(),
})
export type HelpCall = z.infer<typeof callSchema>
export type CallType = HelpCall['type']

const stationState = z.object({
  station: z.object({ ...place.shape, line: place.nullable() }).nullable(),
  tiles: z.array(z.object({ type: z.object({ id: z.string(), kind: z.enum(CALL_KINDS), ...typeWords }), open: callSchema.nullable() })),
  open: z.array(callSchema),
})
export type HelpStation = z.infer<typeof stationState>

const callAnswer = z.object({ call: callSchema, replayed: z.boolean() })

/** The tablet's station, its tiles (the site's active call types, each with this station's open call) and its open calls. */
export const readHelpStation = (api: ApiClient): Promise<TaskOutcome<HelpStation>> => floorRead(api, '/production/calls/station', { schema: stationState })

/** Words on the open call ("call first, explain after"), from the tablet that sent it or a tablet at its station. */
export const addDetails = (api: ApiClient, call: Pick<HelpCall, 'id'>, note: string, key: string): Promise<TaskOutcome<HelpCall>> =>
  floorWrite(api, 'POST', `/production/calls/station/${seg(call.id)}/details`, { body: { note }, schema: callAnswer, idempotencyKey: key }).then((answer) => (answer.ok ? { ok: true as const, value: answer.value.call } : answer))
