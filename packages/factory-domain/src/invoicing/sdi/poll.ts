import { failureOf, type SdiSendStatus } from './states'

/**
 * The status poll's rule (FIN-086; plan A1 §4 "a status poll catches lost webhooks"): which sends the scheduler asks the
 * SDI intermediary about at a tick, pure. A send is asked about once it waited POLL_AFTER_MS without an outcome:
 *
 *   SENT       SDI has not answered by webhook (it answers within minutes, at most five days): asked every tick for two
 *              hours, then every 30 minutes for two days, then every 3 hours until SDI answers
 *   SENDING    the sending process stopped between writing the send and recording the provider's answer: asked once;
 *              the provider says whether it has the file (SENT) or not (FAILED, nothing sent)
 *   FAILED     only when the provider did not answer (NO_ANSWER: the file may have reached SDI), for seven days, on the
 *              SENT cadence; a refused or unsent file is not asked about
 * The cadence counts 5-minute steps of the tick's time, so every replica and every tenant agree.
 */

export const POLL_AFTER_MS = 15 * 60_000
export const POLL_UNCERTAIN_FOR_MS = 7 * 24 * 60 * 60_000
/** The scheduler's cron runs every five minutes. */
export const POLL_STEP_MS = 5 * 60_000

export interface PollFacts {
  readonly status: SdiSendStatus
  readonly failureReason: string | null
  /** Since when it waits: SENT its send time, SENDING its creation, FAILED its last change. */
  readonly since: Date
}

function onCadence(ageMs: number, tick: Date): boolean {
  const step = Math.floor(tick.getTime() / POLL_STEP_MS)
  if (ageMs < 2 * 60 * 60_000) return true
  if (ageMs < 2 * 24 * 60 * 60_000) return step % 6 === 0
  return step % 36 === 0
}

/** Whether the poll asks about this send at this tick. */
export function pollDue(send: PollFacts, tick: Date): boolean {
  const age = tick.getTime() - send.since.getTime()
  if (age < POLL_AFTER_MS) return false
  switch (send.status) {
    case 'SENDING':
      return true
    case 'SENT':
      return onCadence(age, tick)
    case 'FAILED':
      return (failureOf(send.failureReason)?.uncertain ?? false) && age <= POLL_UNCERTAIN_FOR_MS && onCadence(age, tick)
    default:
      return false
  }
}
