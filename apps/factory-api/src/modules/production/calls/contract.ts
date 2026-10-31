import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import {
  CALL_KINDS,
  CALL_LIMITS,
  CALL_STATUSES,
  CALL_STEPS,
  CALL_TILES,
  CALL_VIEWS,
  OUTCOME_TYPES,
  RESOLUTION_CODE,
  STATION_CALL_STATES,
} from '@nexus/factory-domain/production/calls/rules'

/**
 * The help calls' routes (B-W2b-35; MES-142 … MES-145, MES-147, MES-137; design floor.help SCR-172, production.calls
 * SCR-142, floor.supervisor "Calls", floor.display "Stations", production.settings "Help-call routing"). No money
 * anywhere. People: `{ kind, name }` — an office user by name in the office; a floor worker (the caller, a team leader
 * who answered) by name only inside one call; lists name nobody else. A call rule's refusal is a 409 with the issues
 * `refusal/<CODE>` (factory-domain production/calls/rules CALL_REFUSALS) and `fix`.
 */

const version = () => z.number().int().min(1)
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))
const note = (max: number) => z.string().trim().min(1).max(max)
const words = z.record(z.string(), z.string())
const place = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ kind: z.enum(['USER', 'WORKER']), name: z.string().nullable() })
const typeWords = { labelIt: z.string(), labelEn: z.string(), labelI18n: words, icon: z.string().nullable(), colour: z.string().nullable() }
const times = output({ responseSeconds: z.number().int().nullable(), onTheWaySeconds: z.number().int().nullable(), resolveSeconds: z.number().int().nullable() })

// ---- views ---------------------------------------------------------------------------------------------------------------

export const typeOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  code: z.string(),
  kind: z.enum(CALL_KINDS),
  ...typeWords,
  /** The code is an active code of the HELP_CALL reason list (else the tile shows the code itself). */
  codeListed: z.boolean(),
  responder: output({
    /** TEAM: the type's team; TEAM_LEADERS: no team named, the site's team leaders answer. */
    kind: z.enum(['TEAM', 'TEAM_LEADERS']),
    team: output({ id: id(), code: z.string(), name: z.string(), active: z.boolean() }).nullable(),
    /** How many answer now ("members count"). */
    members: z.number().int(),
  }),
  escalateAfterMinutes: z.number().int().nullable(),
  /** The off-standard code the station's waiting books to while a call is open (MES-148, B-W2b-29); null: not booked. */
  waitingCode: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() }).nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  version: z.number().int(),
  usedCount: z.number().int(),
  openCount: z.number().int(),
})

export const callOut = output({
  id: id(),
  version: z.number().int(),
  siteId: id(),
  status: z.enum(CALL_STATUSES),
  open: z.boolean(),
  type: output({ id: id(), code: z.string(), kind: z.enum(CALL_KINDS), ...typeWords }),
  station: place,
  line: place.nullable(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  bundle: output({ id: id(), code: z.string() }).nullable(),
  responderTeam: place.nullable(),
  note: z.string().nullable(),
  sentAt: z.string(),
  seenAt: z.string().nullable(),
  onTheWayAt: z.string().nullable(),
  solvedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  escalatedAt: z.string().nullable(),
  /** Whole seconds since it was sent, while open (the elapsed time). */
  openSeconds: z.number().int().nullable(),
  times,
  /** Who saw it first: an office user by name in the office; a floor worker never by name in a list. */
  seenBy: person.nullable(),
  resolutionCode: z.string().nullable(),
  outcome: output({ recordType: z.string(), recordId: id() }).nullable(),
  /** The station's waiting while it was open is booked to off-standard time (MES-148: "Waiting time not counted"). */
  waitingBooked: z.boolean(),
})

const step = z.enum(['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED', 'CANCELLED'])
export const callRecordOut = callOut.extend({
  /** The caller: only where the site's floor records name workers. */
  caller: person.nullable(),
  timeline: z.array(output({ step, at: z.string(), by: person.nullable() })),
  /** Who is coming (design floor.help "Paolo · maintenance · on the way"), while open. */
  coming: output({ step: z.enum(['SEEN', 'ON_THE_WAY']), by: person.nullable(), team: place.nullable() }).nullable(),
  resolutionNote: z.string().nullable(),
  waiting: output({ blockId: id(), code: z.string(), status: z.string(), startedAt: z.string(), endedAt: z.string().nullable() }).nullable(),
  bookWaiting: z.boolean(),
})

// ---- the station (floor.help) ----------------------------------------------------------------------------------------------

const stationOut = output({ id: id(), code: z.string(), name: z.string(), line: place.nullable() })

export const stationStateContract = defineContract({
  response: {
    200: output({
      /** Who a call names at the site: WORKER (the signed-in worker, once they acknowledged the notice) or STATION. */
      subject: z.enum(['WORKER', 'STATION']),
      station: stationOut.nullable(),
      /** The tiles: the site's active types in their order, each with this station's open call of it. */
      tiles: z.array(output({ type: typeOut.pick({ id: true, code: true, kind: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, sortOrder: true }), open: callRecordOut.nullable() })),
      /** This station's open calls (an inactive type's still open call too). */
      open: z.array(callRecordOut),
    }),
  },
})

const sendBody = input({
  typeId: id(),
  /** The tablet's own id for the call (A1 §3.8): a resent call is made once. */
  clientEventId: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/, 'A client event id is 1 to 80 letters, digits, dots, colons, underscores or hyphens.'),
  /** Another station of the site: the team leader calling for it (floor.lead). Default: the tablet's station. */
  stationId: id().optional(),
  /** What it is about: a work order (and a bundle of it). A material call names what is missing in `note` (MES-137). */
  workOrderId: id().optional(),
  bundleId: id().optional(),
  note: note(CALL_LIMITS.note).optional(),
  /** When it was tapped on the tablet (a queued call sent later); kept when believable. */
  occurredAt: instant().optional(),
})
export type SendBody = z.infer<typeof sendBody>

const sendAnswer = output({
  call: callRecordOut,
  /** true: this station's open call of the type (a second tap): nothing new was sent (MES-143). */
  existing: z.boolean(),
  replayed: z.boolean(),
})
export const sendContract = defineContract({ body: sendBody, response: { 201: sendAnswer, 200: sendAnswer } })

const callParams = input({ callId: id() })
const callAnswer = output({ call: callRecordOut, replayed: z.boolean() })

export const detailsContract = defineContract({
  params: callParams,
  body: input({ version: version().optional(), note: note(CALL_LIMITS.note) }),
  response: { 200: callAnswer },
})

const stationClose = input({ version: version().optional(), occurredAt: instant().optional() })
export const stationSolveContract = defineContract({ params: callParams, body: stationClose, response: { 200: callAnswer } })
export const stationCancelContract = defineContract({ params: callParams, body: stationClose, response: { 200: callAnswer } })

// ---- answering (the line view, the office) --------------------------------------------------------------------------------

const answerBody = { version: version().optional(), occurredAt: instant().optional() }
export const seenContract = defineContract({ params: callParams, body: input(answerBody), response: { 200: callAnswer } })
export const onTheWayContract = defineContract({ params: callParams, body: input(answerBody), response: { 200: callAnswer } })
export const solveContract = defineContract({
  params: callParams,
  body: input({
    ...answerBody,
    /** How it was solved (BROUGHT, FIXED, ADJUSTED…). */
    resolutionCode: z.string().trim().regex(RESOLUTION_CODE, 'A resolution code is 2 to 40 upper-case letters, digits and underscores, starting with a letter.').optional(),
    resolutionNote: note(CALL_LIMITS.resolutionNote).optional(),
  }),
  response: { 200: callAnswer },
})
export const cancelContract = defineContract({
  params: callParams,
  body: input({ ...answerBody, reason: note(CALL_LIMITS.reason) }),
  response: { 200: callAnswer },
})
export const outcomeContract = defineContract({
  params: callParams,
  body: input({ version: version().optional(), recordType: z.enum(OUTCOME_TYPES), recordId: id() }),
  response: { 200: callAnswer },
})

/** A step of a call queued on a tablet (floor-sync `andon.call.answer`): a responder's, or the station's own close. */
export const queuedAnswerBody = input({
  callId: id(),
  step: z.enum(CALL_STEPS),
  version: version().optional(),
  occurredAt: instant().optional(),
  resolutionCode: z.string().trim().regex(RESOLUTION_CODE).optional(),
  resolutionNote: note(CALL_LIMITS.resolutionNote).optional(),
  reason: note(CALL_LIMITS.reason).optional(),
})

// ---- the office -----------------------------------------------------------------------------------------------------------

export const listCallsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    lineId: id().optional(),
    stationId: id().optional(),
    typeId: id().optional(),
    kind: csv(CALL_KINDS).optional(),
    status: csv(CALL_STATUSES).optional(),
    /** open (default: the inbox, oldest first), closed or all (newest first). */
    view: z.enum(CALL_VIEWS).default('open'),
    tile: z.enum(CALL_TILES).optional(),
    /** Sent on or after / before these days of the site (inclusive). */
    from: businessDate().optional(),
    to: businessDate().optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ calls: z.array(callOut), nextCursor: id().nullable() }) },
})

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional() }),
  response: {
    200: output({
      tiles: output({ OPEN: z.number().int(), WAITING: z.number().int(), ANSWERED_TODAY: z.number().int() }),
      /** The median of today's calls' response times (sent → seen), per site and line: never per person. */
      medianResponseSeconds: z.number().int().nullable(),
      waitingMinutes: z.number().int(),
    }),
  },
})

export const byHourContract = defineContract({
  querystring: input({ siteId: id(), date: businessDate().optional(), lineId: id().optional() }),
  response: {
    200: output({
      date: z.string(),
      timeZone: z.string(),
      hours: z.array(output({ hour: z.number().int(), calls: z.number().int(), byKind: z.record(z.string(), z.number().int()), byLine: z.array(output({ lineId: id().nullable(), count: z.number().int() })) })),
      byKind: z.array(output({ kind: z.enum(CALL_KINDS), calls: z.number().int(), answered: z.number().int(), medianResponseSeconds: z.number().int().nullable() })),
      lines: z.array(place),
    }),
  },
})

export const callRecordContract = defineContract({
  params: callParams,
  response: { 200: output({ call: callRecordOut, canAnswer: z.boolean(), canNameOutcome: z.boolean() }) },
})

export const boardContract = defineContract({
  querystring: input({ lineId: id().optional() }),
  response: {
    200: output({
      line: place,
      asOf: z.string(),
      /** Each station of the line: its call state (no names, no output per station: Owner answer F2). */
      stations: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          state: z.enum(STATION_CALL_STATES),
          /** An open MATERIAL call: "waiting for material". */
          material: z.boolean(),
          calls: z.array(output({ id: id(), kind: z.enum(CALL_KINDS), code: z.string(), status: z.enum(CALL_STATUSES), sentAt: z.string(), openSeconds: z.number().int() })),
        }),
      ),
      /** The line's open calls, oldest first, to answer (the line view's "Calls"). */
      calls: z.array(callOut),
      canAnswer: z.boolean(),
    }),
  },
})

// ---- the types (Floor rules & codes › Help-call routing) -------------------------------------------------------------------

export const listTypesContract = defineContract({
  querystring: input({ siteId: id(), active: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: { 200: output({ site: place, types: z.array(typeOut), canManage: z.boolean() }) },
})

const routing = {
  responderTeamId: id().nullable().optional(),
  escalateAfterMinutes: z.number().int().nullable().optional(),
  offStandardCodeId: id().nullable().optional(),
  sortOrder: z.number().int().optional(),
}
export const createTypeContract = defineContract({
  body: input({ siteId: id(), code: z.string().trim().min(2).max(40), kind: z.enum(CALL_KINDS), ...routing }),
  response: { 201: output({ type: typeOut, replayed: z.boolean() }), 200: output({ type: typeOut, replayed: z.boolean() }) },
})
export const updateTypeContract = defineContract({
  params: input({ typeId: id() }),
  body: input({ version: version(), kind: z.enum(CALL_KINDS).optional(), active: z.boolean().optional(), ...routing }),
  response: { 200: output({ type: typeOut, replayed: z.boolean() }) },
})

