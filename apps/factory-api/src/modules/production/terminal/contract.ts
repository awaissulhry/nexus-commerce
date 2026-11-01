import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { OVERRIDE_REASON_CODES } from '@nexus/factory-domain/production/guards/rules'
import { REASON_CODE } from '@nexus/factory-domain/production/scans/reasons'
import { TERMINAL_LIMITS, TIMING_CLIENT_ID, TIMING_KINDS, TIMING_STATES } from '@nexus/factory-domain/production/terminal/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Operation timing on the tablet (B-W2b-40; MES-087 … MES-094, MES-117). No field carries money; no floor answer names a
 * worker (another person's open work is "another person"); the office's minutes per operation name nobody. A refusal by
 * a timing rule is a 409 whose issues are `refusal/<CODE>` (factory-domain production/terminal/rules TIMING_REFUSALS, or
 * the scans' SCAN_REFUSALS for the operation a START means, a voided ticket, a hold …) with its words and `fix`.
 */

const clientScanId = () => z.string().regex(TIMING_CLIENT_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.')
const operationRef = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })

/** The bundle and, optionally, the operation (absent: START the station's next one; the others the subject's open work). */
const bundleRef = {
  /** The scanned ticket (a bundle's, current or replaced, or a coupon's). */
  code: z.string().trim().min(1).max(64).optional(),
  bundleId: id().optional(),
  workOrderOperationId: id().optional(),
}
const envelope = {
  /** The tablet's id for the action (A1 §3.8): one action, once, also from the offline queue. */
  clientScanId: clientScanId(),
  /** The tablet's clock when it happened (offline). */
  occurredAt: instant().optional(),
}
const members = () => z.array(id()).max(TERMINAL_LIMITS.maxMembers).optional()

export const startBody = input({
  ...bundleRef,
  ...envelope,
  /** Why a station starts an operation of another kind of work (covering for another line …). */
  kindReason: z.string().trim().min(3).max(200).optional(),
  /** A team operation (MES-094): people of this tablet's crew (the one signed in is added). */
  memberIds: members(),
})
export const pauseBody = input({
  ...bundleRef,
  ...envelope,
  /** A code of the PAUSE reason list (GET /reasons?list=PAUSE). */
  reasonCode: z.string().regex(REASON_CODE),
  /** A few words; required when the code asks them (an "Other"). */
  note: z.string().trim().min(1).max(TERMINAL_LIMITS.noteMax).optional(),
})
export const resumeBody = input({ ...bundleRef, ...envelope, memberIds: members() })
export const handBackBody = input({ ...bundleRef, ...envelope })
export const partialBody = input({
  ...bundleRef,
  ...envelope,
  /** The pieces done so far: from 1, together with earlier ones fewer than the bundle's garments. */
  pieces: z.number().int().min(1).max(100_000),
  memberIds: members(),
})

const timingScan = output({
  id: id(),
  kind: z.enum(TIMING_KINDS),
  workOrderId: id(),
  bundleId: id(),
  bundleCode: z.string(),
  operation: operationRef,
  pauseReasonCode: z.string().nullable(),
  pieces: z.number().int(),
  /** A team's members on it (0: one person, or a station). */
  team: z.number().int(),
  stationId: id().nullable(),
  deviceId: id().nullable(),
  clientScanId: z.string(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
})

/** A bundle at an operation as the operation screen shows it: the work in hand's own clock, never a pace or a target. */
const timing = output({
  state: z.enum(TIMING_STATES),
  /** The open work is the viewer's (their own; the station's where the site records stations). */
  mine: z.boolean(),
  startedAt: instant().nullable(),
  /** The running part began (the screen's clock: secondsBefore + now − runningSince). */
  runningSince: instant().nullable(),
  secondsBefore: z.number().int(),
  pausedAt: instant().nullable(),
  pauseReasonCode: z.string().nullable(),
  /** Paused by the system at clock-out: the next sign-in offers to continue. */
  pausedAtClockOut: z.boolean(),
  piecesSoFar: z.number().int(),
  /** The people the running part counts for (1; a team 2–4). */
  people: z.number().int(),
  /** What the viewer may do now; Finish (the REPORT) is always the scans' one tap. */
  actions: z.array(z.enum(TIMING_KINDS)),
})

const answer = output({
  scan: timingScan,
  timing,
  /** The receipt in words ("B-000123 at Op 30 paused."). */
  words: z.string(),
  /** START: the qualification check's warning (the site's rule only warns), or null. */
  qualification: output({ mode: z.literal('WARN'), message: z.string(), fix: z.string() }).nullable(),
  /** START: the team leader's override that lifted a qualification hold, or null. */
  override: output({ reasonCode: z.string() }).nullable(),
})

const write = <Body extends z.ZodType>(body: Body) => defineContract({ body, response: { 201: answer, 200: answer } })

export const startContract = write(startBody)
export const pauseContract = write(pauseBody)
export const resumeContract = write(resumeBody)
export const handBackContract = write(handBackBody)
export const partialContract = write(partialBody)

export const startOverrideContract = defineContract({
  body: input({
    /** The held START, as the tablet sent it (the same clientScanId). */
    start: startBody,
    /** The team leader: their badge, scanned, or their worker id, picked by name; and their 6-digit PIN (never stored, never logged). */
    lead: input({ badgeCode: z.string().trim().min(1).max(64).optional(), workerId: id().optional(), pin: z.string().regex(/^\d{6}$/, 'Expected 6 digits.') }),
    reasonCode: z.enum(OVERRIDE_REASON_CODES),
    /** A few words; required with OTHER. */
    note: z.string().trim().min(3).max(200).optional(),
  }),
  response: { 201: answer, 200: answer },
})

const openItem = timing.extend({
  bundleId: id(),
  bundleCode: z.string(),
  workOrderId: id(),
  number: z.string(),
  operation: operationRef,
  /** PAUSED: "B-000123 at Op 30 paused." */
  words: z.string().nullable(),
  /** PAUSED: "Continue bundle B-000123 at Op 30?" */
  continueWords: z.string().nullable(),
})

export const openContract = defineContract({
  response: {
    200: output({
      items: z.array(openItem),
      /** After a clock-out paused work: the sign-in's card "Continue bundle B-000123 at Op 30?" (its action: the RESUME). */
      offer: output({ bundleId: id(), workOrderOperationId: id(), words: z.string() }).nullable(),
      /** The clock page's "Clock out?": "Your open bundle B-000123 will be paused." (null: nothing runs). */
      clockOutWarning: z.string().nullable(),
      serverTime: instant(),
    }),
  },
})

export const stateContract = defineContract({
  querystring: input({ ...bundleRef }),
  response: {
    200: output({
      bundle: output({ id: id(), code: z.string(), quantity: z.number().int(), status: z.string() }),
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      operation: operationRef,
      timing,
      serverTime: instant(),
    }),
  },
})

const minutes = () => z.string().regex(/^\d+\.\d{2}$/)

export const workOrderTimingContract = defineContract({
  params: input({ workOrderId: id() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES) }),
      operations: z.array(
        output({
          operation: operationRef,
          /** Minutes worked in closed stretches (pauses left out). */
          timedMinutes: minutes(),
          /** The same, a team counted once per member. */
          personMinutes: minutes(),
          /** The running parts of open stretches so far. */
          openMinutes: minutes(),
          stretches: z.number().int(),
          running: z.number().int(),
          paused: z.number().int(),
          handedBack: z.number().int(),
          partials: z.number().int(),
          piecesSoFar: z.number().int(),
          /** Pauses per reason code (count and minutes). */
          pauses: z.array(output({ code: z.string(), count: z.number().int(), minutes: minutes() })),
        }),
      ),
      serverTime: instant(),
    }),
  },
})
