import { z } from 'zod'
import { CLOCK_ACTIONS, CLOCK_FLAGS, CLOCK_SOURCES, CLOCK_STATES, type ClockAction } from '@nexus/factory-domain/people/clock/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { floorRead, taskProblemOf, type TaskOutcome, type TaskProblem } from '../shared/task-api'
import type { SendKept } from './kept'
import type { ClockView, OpenWork } from './model'

/**
 * SCR-170's calls (apps/factory-api modules/people/clock, B-W2b-33; the open work of modules/production/terminal, B-W2b-40):
 * the worker's own clock, the tablet's clock (a badge, or a name and PIN, signed in or not), whether the site clocks at
 * all. While the site's ATTENDANCE gate is off every one answers 409 `gate/ATTENDANCE`: the screen stays closed and says
 * why, and offers nothing. A badge code and a PIN go only in request bodies and never into an outcome.
 */

const event = z.object({ id: z.string(), kind: z.enum(CLOCK_ACTIONS), source: z.enum(CLOCK_SOURCES), occurredAt: z.string(), flags: z.array(z.enum(CLOCK_FLAGS)), flagged: z.boolean() })

export const clockSchema = z.object({
  person: z.object({ workerId: z.string(), employeeId: z.string(), name: z.string() }),
  state: z.enum(CLOCK_STATES),
  inSince: z.string().nullable(),
  breakSince: z.string().nullable(),
  forgottenSince: z.string().nullable(),
  minutes: z.object({ worked: z.number(), present: z.number(), breaks: z.number() }),
  shift: z.object({ label: z.string().nullable(), date: z.string(), startsAt: z.string(), endsAt: z.string(), source: z.enum(['ROSTER', 'DEFAULT']) }).nullable(),
  breaks: z.object({
    mode: z.enum(['FIXED', 'CLOCKED']),
    next: z.object({ label: z.string().nullable(), startsAt: z.string(), endsAt: z.string() }).nullable(),
    due: z.string().nullable(),
  }),
  autoClockOutAt: z.string().nullable(),
  actions: z.array(z.enum(CLOCK_ACTIONS)),
  next: z.enum(CLOCK_ACTIONS),
  events: z.array(event),
  serverTime: z.string(),
}) satisfies z.ZodType<ClockView>

const recorded = z.object({ event, repeated: z.boolean(), clock: clockSchema })
export type Recorded = z.infer<typeof recorded>

/** A task problem, or the clock is closed at this site (the ATTENDANCE gate). */
export type ClockProblem = TaskProblem | { readonly kind: 'closed' }
export type ClockOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ClockProblem }

const closed = (error: unknown): boolean => isApiError(error) && error.issues.some((issue) => issuePath(issue).startsWith('gate/'))

async function attempt<T>(run: () => Promise<T>): Promise<ClockOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, problem: closed(error) ? { kind: 'closed' } : taskProblemOf(error) }
  }
}

/** "Your time today" of the person signed in. */
export function fetchClock(api: ApiClient): Promise<ClockOutcome<ClockView>> {
  return attempt(() => api.get('/people/clock/floor', { schema: z.object({ clock: clockSchema }) }).then((answer) => answer.clock))
}

/** Whether this tablet's site clocks at all (asked with nobody signed in: the device token alone). */
export function fetchTabletClock(api: ApiClient): Promise<TaskOutcome<{ open: boolean }>> {
  return floorRead(api, '/people/clock/tablet', { schema: z.object({ open: z.boolean() }) })
}

const write = <T,>(api: ApiClient, path: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<ClockOutcome<T>> =>
  attempt(async () => {
    await api.get('/auth/csrf')
    return api.post(path, { body, schema, idempotencyKey: newIdempotencyKey() })
  })

export const newClockEventId = (): string => globalThis.crypto.randomUUID()

/** The signed-in worker taps Clock in, Clock out, Break. */
export function clockTap(api: ApiClient, action: ClockAction, clientEventId: string, deviceTime: string): Promise<ClockOutcome<Recorded>> {
  return write(api, '/people/clock/floor', { clientEventId, action, deviceTime }, recorded)
}

export type ClockProof = { readonly badgeCode: string } | { readonly workerId: string; readonly pin: string }

/** A badge scanned on the clock (no action: in, out or back from the break, as the person's state says), or a name and PIN. */
export function clockProved(api: ApiClient, proof: ClockProof, clientEventId: string, deviceTime: string): Promise<ClockOutcome<Recorded>> {
  return write(api, '/people/clock/scan', { clientEventId, deviceTime, ...proof }, recorded)
}

/** A badge scanned while offline, sent now with the tablet's time and its clock at sending (a wrong clock is flagged). */
export function sendKeptBadge(api: ApiClient, kept: { readonly badgeCode: string; readonly clientEventId: string; readonly action: ClockAction; readonly occurredAt: string }, sentAt: string): Promise<ClockOutcome<Recorded>> {
  return write(api, '/people/clock/scan', { clientEventId: kept.clientEventId, badgeCode: kept.badgeCode, action: kept.action, occurredAt: kept.occurredAt, sentAt }, recorded)
}

/** The kept badges' sender: what the office's answer means for the code on the tablet (a final answer drops it). */
export const keptSender =
  (api: ApiClient): SendKept =>
  async (kept, sentAt) => {
    const answer = await sendKeptBadge(api, kept, sentAt)
    if (answer.ok) return { kind: 'done' }
    switch (answer.problem.kind) {
      case 'offline':
      case 'unavailable':
      case 'rateLimited':
        return { kind: 'later' }
      case 'refused':
        return { kind: 'refused', code: answer.problem.code }
      case 'closed':
        return { kind: 'refused', code: 'CLOSED' }
      default:
        return { kind: 'refused', code: null }
    }
  }

const openItem = z.object({
  bundleId: z.string(),
  bundleCode: z.string(),
  operation: z.object({ id: z.string(), seq: z.number(), name: z.string() }),
  state: z.string(),
  mine: z.boolean(),
  pausedAtClockOut: z.boolean(),
})
const openSchema = z.object({
  items: z.array(openItem),
  offer: z.object({ bundleId: z.string(), workOrderOperationId: z.string(), words: z.string() }).nullable(),
  clockOutWarning: z.string().nullable(),
}) satisfies z.ZodType<OpenWork>

/** The person's open work (production.scan): what a clock-out will pause, what the last one paused. */
export function fetchOpenWork(api: ApiClient): Promise<TaskOutcome<OpenWork>> {
  return floorRead(api, '/production/terminal/open', { schema: openSchema })
}
