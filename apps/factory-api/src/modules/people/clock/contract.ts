import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_EVENT_ID } from '@nexus/factory-domain/floor-sync/rules'
import { CLOCK_ACTIONS, CLOCK_FLAGS, CLOCK_SOURCES, CLOCK_STATES } from '@nexus/factory-domain/people/clock/rules'

/**
 * Clock in and out (B-W2b-33; MES-223, MES-224, MES-227, MES-239, MES-199; design floor.clock SCR-170). Floor only: the
 * signed-in worker's own clock (`/people/clock/floor`) and the tablet's clock for anyone who shows a badge, or their name
 * and PIN when they forgot it (`/people/clock/scan`). Every write takes the tablet's event id once per tablet (the
 * Idempotency-Key is `<device>.<client event id>`). No money anywhere; no other person's time: one person's own clock
 * at a time, through the site's ATTENDANCE legal gate.
 */

const clientEventId = z.string().regex(CLIENT_EVENT_ID, 'A tablet event id: 8 to 64 letters, digits, dots, colons, hyphens or underscores.')

const eventView = output({
  id: id(),
  kind: z.enum(CLOCK_ACTIONS),
  source: z.enum(CLOCK_SOURCES),
  occurredAt: instant(),
  flags: z.array(z.enum(CLOCK_FLAGS)),
  /** Something for the team leader to check (a name and PIN, a wrong tablet clock). */
  flagged: z.boolean(),
})

const breakView = output({ label: z.string().nullable(), startsAt: instant(), endsAt: instant(), words: z.string() })

/** "Your time today" (design floor.clock "state", "breaks"): the person's own clock, nobody else's. */
export const clockView = output({
  person: output({ workerId: id(), employeeId: id(), name: z.string() }),
  state: z.enum(CLOCK_STATES),
  inSince: instant().nullable(),
  breakSince: instant().nullable(),
  /** A clock-in never closed (older than 13 hours): the team leader corrects that day. */
  forgottenSince: instant().nullable(),
  /** "In since 07:58 · 4 h 12 min today". */
  words: z.string(),
  /** Raw minutes so far today (no rounding, no grace: the attendance day's). */
  minutes: output({ worked: z.number().int().min(0), present: z.number().int().min(0), breaks: z.number().int().min(0) }),
  shift: output({ label: z.string().nullable(), date: businessDate(), startsAt: instant(), endsAt: instant(), source: z.enum(['ROSTER', 'DEFAULT']) }).nullable(),
  breaks: output({
    mode: z.enum(['FIXED', 'CLOCKED']),
    /** FIXED: the next break of the shift ("Deducted automatically 12:00–12:30"). */
    next: breakView.nullable(),
    /** CLOCKED: the reminder once a stretch passes the rule (D.Lgs. 66/2003 art. 8), else null. */
    due: z.string().nullable(),
  }),
  /** When the automatic clock-out closes the open stretch if nobody clocks out (null: the company has none, or no shift fits). */
  autoClockOutAt: instant().nullable(),
  /** The buttons, the main one first; `next` is what a badge scanned on the clock does. */
  actions: z.array(z.enum(CLOCK_ACTIONS)),
  next: z.enum(CLOCK_ACTIONS),
  /** Today's counted events, oldest first. */
  events: z.array(eventView),
  serverTime: instant(),
})

const recorded = output({
  event: eventView,
  /** The scan repeated one recorded less than a minute before: nothing new was recorded (`event` is that one). */
  repeated: z.boolean(),
  /** "Clocked in at 07:58." / "Saved on this tablet at 07:58 (tablet time)." */
  words: z.string(),
  clock: clockView,
})

export const floorStateContract = defineContract({ response: { 200: output({ clock: clockView }) } })

export const floorClockContract = defineContract({
  body: input({
    clientEventId,
    /** Left out: what a badge scan does (in, out, back from the break). */
    action: z.enum(CLOCK_ACTIONS).optional(),
    /** The tablet's clock when tapped (kept beside the server's time, which counts). */
    deviceTime: instant().optional(),
  }),
  response: { 200: recorded, 201: recorded },
})

/**
 * The tablet's clock (a kiosk, signed in or not): a badge, or a worker picked by name and the PIN. `occurredAt` (the
 * tablet's time) when a badge was scanned while offline and is sent now; `sentAt` the tablet's clock at sending (a wrong
 * clock is flagged). A name and PIN are never kept offline: the PIN never stays on the tablet.
 */
export const scanClockContract = defineContract({
  body: input({
    clientEventId,
    badgeCode: z.string().max(64).optional(),
    workerId: id().optional(),
    pin: z.string().max(12).optional(),
    action: z.enum(CLOCK_ACTIONS).optional(),
    deviceTime: instant().optional(),
    occurredAt: instant().optional(),
    sentAt: instant().optional(),
  }),
  response: { 200: recorded, 201: recorded },
})

/** The queued event's payload (floor-sync kind `people.clock.record`): the action; the envelope has the tablet's time. */
export const queuedClockBody = input({ clientEventId, action: z.enum(CLOCK_ACTIONS), occurredAt: instant() })
export type QueuedClockBody = z.infer<typeof queuedClockBody>
export type FloorClockBody = z.infer<typeof floorClockContract.body>
export type ScanClockBody = z.infer<typeof scanClockContract.body>
