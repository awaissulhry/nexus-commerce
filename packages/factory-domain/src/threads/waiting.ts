import { WORKING_DAY_MINUTES, waitingFor as requestWaitingFor, type InquiryStatus } from '../sales/inquiries/rules'

/**
 * Who a conversation waits on, and since when (B-TH-028; threads plan N1, §7.2 "one waiting rule"; design T1-F01, T1-F02, the
 * Incoming tiles), pure. ONE rule for the thread head's pill, Incoming's "Waiting on us over 1 working day" tile and Today, so
 * the three never disagree:
 *
 *   a request (Inquiry)  by its state: NEW and ASSIGNED wait on US since it came (the list's waiting time), NEED_INFO waits on
 *                        the CUSTOMER since our question (the newest message we shared, else when it came); closed: nobody.
 *                        Amber after 1 working day on us (sales/inquiries `overdue`: the same 480 minutes).
 *   any other record     by its newest SHARED message (an office note never flips it): the customer's or supplier's (INBOUND)
 *                        waits on US since it came, ours (OUTBOUND) waits on the CUSTOMER since we sent it. No party or no
 *                        shared message yet: no pill. Amber after 3 working days on us.
 *
 * Waiting on the customer is never amber (it is not ours to answer): the pill shows its time only. The working minutes come from
 * the record's company calendar (the API's); without a calendar, clock minutes (said in the pill's tooltip).
 */

export const WAITING_ONS = ['US', 'CUSTOMER'] as const
export type WaitingOn = (typeof WAITING_ONS)[number]

/** Working days on us before the pill turns amber. */
export const WAITING_THRESHOLD_DAYS = Object.freeze({ REQUEST: 1, OTHER: 3 })

export interface SharedMessage {
  readonly direction: 'INBOUND' | 'OUTBOUND'
  readonly at: Date
}

export interface WaitingFacts {
  /** The record is a request: its state and when it came. */
  readonly request?: { readonly status: InquiryStatus; readonly receivedAt: Date } | undefined
  /** The thread's newest shared message (INBOUND or OUTBOUND), null: none yet. */
  readonly lastShared: SharedMessage | null
  /** The newest message WE shared (OUTBOUND), for a request waiting on the customer. */
  readonly lastOutbound?: Date | null | undefined
  /** The record has a customer or supplier to wait on. */
  readonly hasParty: boolean
}

export interface Waiting {
  readonly on: WaitingOn
  readonly since: Date
  readonly thresholdDays: number
}

/** Who waits and since when, or null: nobody (closed, no party, no shared message). */
export function waitingOf(facts: WaitingFacts): Waiting | null {
  if (facts.request) {
    const on = requestWaitingFor(facts.request.status)
    if (on === null) return null
    const since = on === 'CUSTOMER' && facts.lastOutbound && facts.lastOutbound > facts.request.receivedAt ? facts.lastOutbound : facts.request.receivedAt
    return { on, since, thresholdDays: WAITING_THRESHOLD_DAYS.REQUEST }
  }
  if (!facts.hasParty || facts.lastShared === null) return null
  return { on: facts.lastShared.direction === 'INBOUND' ? 'US' : 'CUSTOMER', since: facts.lastShared.at, thresholdDays: WAITING_THRESHOLD_DAYS.OTHER }
}

/** Over the rule's threshold while it waits on us (one working day is WORKING_DAY_MINUTES). */
export function amberOf(waiting: Waiting, workingMinutes: number): boolean {
  return waiting.on === 'US' && workingMinutes > waiting.thresholdDays * WORKING_DAY_MINUTES
}
