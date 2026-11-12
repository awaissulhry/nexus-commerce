import { Dec, type Decimal } from '../../tax/decimal'
import type { BusinessDate } from '../../core/time'

/**
 * What each source of warehouse tasks makes, pure (B-W2b-292; SCM-274; apps/factory-api modules/inventory/tasks/sources). Every
 * source reconciles: it reads its record as it is now and says which task should be open for it, so a repeated or late event
 * changes nothing twice.
 *
 *   receipt     goods received onto a dock (a RECEIVING place) wait for a put-away: one PUT_AWAY per lot lying there.
 *   released    a lot released while it lies in a quarantine place, or the stock of a hold released there, goes back to a
 *               bin: one PUT_AWAY per lot lying in the quarantine place.
 *   hold        a stock hold that asks the quarantine move has one QUARANTINE task to its asked place; asked elsewhere, the
 *               task follows; released, closed or no longer asked, the task is cancelled.
 *   pick list   a pick list made for a work order has one PICK task while some of it is still to pick.
 *   count       an active count schedule due today or earlier has one COUNT task; no longer due, it is cancelled.
 */

/** A put-away is asked only for goods on a dock (received) or in a quarantine place (released). */
export const PUT_AWAY_FROM_KINDS = ['RECEIVING', 'QUARANTINE'] as const

export interface OpenTaskOf {
  readonly id: string
  readonly toLocationId: string | null
}

export type QuarantinePlan =
  | { readonly action: 'NONE' }
  | { readonly action: 'CREATE'; readonly toLocationId: string }
  | { readonly action: 'FOLLOW'; readonly taskId: string; readonly toLocationId: string }
  | { readonly action: 'CANCEL'; readonly taskIds: readonly string[]; readonly reason: string }

/** The QUARANTINE task a hold needs now (its status and quarantine as stored; `open`: its open QUARANTINE tasks). */
export function quarantinePlan(
  hold: { readonly status: string; readonly quarantine: string; readonly quarantineLocationId: string | null; readonly stock: boolean },
  open: readonly OpenTaskOf[],
): QuarantinePlan {
  const asked = hold.status === 'ACTIVE' && hold.stock && hold.quarantine === 'ASKED' && hold.quarantineLocationId !== null
  if (!asked) {
    if (open.length === 0) return { action: 'NONE' }
    const reason =
      hold.status !== 'ACTIVE'
        ? `The hold was ${hold.status === 'RELEASED' ? 'released' : 'closed'}: nothing moves to quarantine.`
        : hold.quarantine === 'MOVED'
          ? 'The move to quarantine was confirmed.'
          : 'The move to quarantine is no longer asked.'
    return { action: 'CANCEL', taskIds: open.map((task) => task.id), reason }
  }
  const [first, ...more] = open
  if (!first) return { action: 'CREATE', toLocationId: hold.quarantineLocationId! }
  if (more.length > 0) return { action: 'CANCEL', taskIds: more.map((task) => task.id), reason: 'One move to quarantine per hold: this one was a second.' }
  if (first.toLocationId !== hold.quarantineLocationId) return { action: 'FOLLOW', taskId: first.id, toLocationId: hold.quarantineLocationId! }
  return { action: 'NONE' }
}

/** Whether a count schedule is due on `today` (Europe/Rome). */
export function scheduleDue(schedule: { readonly active: boolean; readonly nextDueOn: BusinessDate }, today: BusinessDate): boolean {
  return schedule.active && schedule.nextDueOn <= today
}

/** A lot's stock lying at a place (its base unit), above 0: what a put-away task carries. */
export function lyingTotal(balances: readonly { readonly onHand: Decimal | string }[]): Decimal {
  return balances.reduce<Decimal>((sum, balance) => sum.plus(new Dec(balance.onHand)), new Dec(0))
}
