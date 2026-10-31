import { z } from 'zod'
import { FLOOR_TONES } from '@nexus/factory-domain/auth/floor/literacy'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CONFLICT_DECISIONS, CONFLICT_KINDS } from '@nexus/factory-domain/floor-sync/conflicts/rules'

/**
 * Offline conflicts go to the lead (B-W2b-52; MES-196; design floor.supervisor "Waiting for you"). No field carries money;
 * a list names stations and tablets, never a worker; one conflict names its two reporters only where the site names
 * workers (Owner answer W1). Every choice carries its icon and tone (MES-188); the screen says the words.
 */

const look = output({ icon: z.string(), tone: z.enum(FLOOR_TONES) })
const station = output({ id: id(), code: z.string(), name: z.string() })
const counts = { good: z.number().int(), scrap: z.number().int(), rework: z.number().int() }
const person = output({ id: id(), name: z.string() })

/** One side of a conflict: the report a tablet sent that was refused, or the one recorded first. */
const refusedSide = output({ deviceId: id(), deviceName: z.string(), station: station.nullable(), deviceTime: instant().nullable(), serverTime: instant(), ...counts })
const recordedSide = output({
  scanId: id(),
  /** Null: the office's correction stands (no tablet). */
  deviceId: id().nullable(),
  deviceName: z.string().nullable(),
  station: station.nullable(),
  serverTime: instant(),
  /** The recorded report was corrected since (the correction stands). */
  corrected: z.boolean(),
  ...counts,
})

export const conflictView = output({
  /** The refused queued action (FloorRefusedAction). */
  id: id(),
  kind: z.enum(CONFLICT_KINDS),
  /** OPEN: waiting for the lead; WITH_OFFICE: the lead sent it to the office (still open there). */
  state: z.enum(['OPEN', 'WITH_OFFICE']),
  look,
  workOrder: output({ id: id(), number: z.string() }),
  bundle: output({ id: id(), code: z.string() }),
  operation: output({ id: id(), seq: z.number().int(), name: z.string() }),
  refused: refusedSide,
  recorded: recordedSide,
  sentToOfficeAt: instant().nullable(),
  version: z.number().int(),
})

const reasonTile = output({ code: z.string(), look })
/** The decisions with their reason tiles (factory-domain floor-sync/conflicts/rules). */
const decisions = z.array(output({ decision: z.enum(CONFLICT_DECISIONS), look, signs: z.boolean(), reasons: z.array(reasonTile) }))

const states = z.enum(['OPEN', 'WITH_OFFICE', 'ALL'])

export const floorConflictsContract = defineContract({
  querystring: input({
    /** Another line of the site; left out: the tablet's own line (a line tablet's, or its station's), else the whole site. */
    lineId: id().optional(),
    /** Default ALL: what waits for the lead first, then what is with the office. */
    state: states.default('ALL'),
  }),
  response: {
    200: output({
      line: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
      conflicts: z.array(conflictView),
      decisions,
    }),
  },
})

const params = input({ refusedId: id() })

export const floorConflictContract = defineContract({
  params,
  response: {
    200: output({
      conflict: conflictView.extend({
        /** Who sent the refused report and who recorded the first one, where the site names workers (inside this one record). */
        refusedBy: person.nullable(),
        recordedBy: person.nullable(),
      }),
      decisions,
    }),
  },
})

export const decideConflictContract = defineContract({
  params,
  body: input({
    decision: z.enum(CONFLICT_DECISIONS),
    /** A reason tile of the decision (never typed words). */
    reason: z.string().trim().min(1).max(40),
    version: z.number().int().min(1),
  }),
  response: {
    200: output({
      decision: z.enum(CONFLICT_DECISIONS),
      /** The refused action after the decision: DISCARDED (KEEP_RECORDED) or still OPEN with the office (SEND_TO_OFFICE). */
      status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED']),
      state: z.enum(['OPEN', 'WITH_OFFICE', 'CLOSED']),
      version: z.number().int(),
    }),
  },
})

export const officeConflictsContract = defineContract({
  querystring: input({ siteId: id().optional(), state: states.default('ALL'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ conflicts: z.array(conflictView.extend({ siteId: id() })) }) },
})
