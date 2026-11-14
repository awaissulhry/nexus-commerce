import { scoped, type Phrase } from '../../payments/riba/depth'
import { MAX_STOP_TEXT, type CustomerTrust, type ReminderStop, type StopReason } from './api'

/**
 * Reminder stops and trusted levels without a screen (B-W2b-425): who may record or lift a stop, why a stop as typed waits
 * (a promise to pay names its day; the last day is today or later), who may set a trusted level and what it lets go by
 * itself. Every phrase is a key of this step's catalogue for a `finance`-scoped translator. Pure: the tests hold it.
 */

export interface StopsCan {
  view: boolean
  manage: boolean
  trust: boolean
}

export const stopsCanOf = (permissions: readonly string[]): StopsCan => ({ view: permissions.includes('receivables.view'), manage: permissions.includes('receivables.reminders.manage'), trust: permissions.includes('receivables.reminders.trust') })

export interface StopDraft {
  invoiceId: string
  reason: StopReason
  until: string
  note: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Why the stop as typed waits (null: it may be recorded): an invoice, a promise's day, a day today or later, a note that fits. */
export function stopDraftHeld(draft: StopDraft, today: string, can: StopsCan, busy: boolean): Phrase | null {
  if (!can.manage) return { key: scoped('stops.held.right') }
  if (!draft.invoiceId) return { key: scoped('stops.held.invoice') }
  if (draft.reason === 'PROMISE_TO_PAY' && !DAY.test(draft.until)) return { key: scoped('stops.held.promiseDay') }
  if (draft.until !== '' && (!DAY.test(draft.until) || draft.until < today)) return { key: scoped('stops.held.dayPast') }
  if (draft.note.length > MAX_STOP_TEXT.note) return { key: scoped('stops.held.noteLong'), params: { max: MAX_STOP_TEXT.note } }
  if (busy) return { key: 'common.working' }
  return null
}

/** Why a stop may not be lifted or changed by this person now (null: it may). */
export function stopMoveHeld(stop: ReminderStop, move: 'lift' | 'change', can: StopsCan, busy: boolean): Phrase | null {
  if (!can.manage) return { key: scoped('stops.held.right') }
  if (stop.state === 'lifted') return { key: scoped('refusal.stop.LIFTED') }
  if (stop.state === 'over') return { key: scoped('refusal.stop.OVER') }
  if (move === 'lift' ? !stop.can.lift : !stop.can.change) return { key: scoped('stops.held.right') }
  if (busy) return { key: 'common.working' }
  return null
}

/** The tone of a stop's state (Pill). */
export const STOP_TONE: Record<ReminderStop['state'], 'warning' | 'neutral' | 'info'> = { holding: 'warning', lifted: 'neutral', over: 'info' }

/** Why a trusted level may not be set by this person now (null: they may: the Owner, with a fresh code). */
export function trustHeld(trust: CustomerTrust | null, can: StopsCan, busy: boolean): Phrase | null {
  if (!can.trust || (trust && !trust.mayChange)) return { key: scoped('trust.held.right') }
  if (!trust) return { key: scoped('trust.held.reading') }
  if (busy) return { key: 'common.working' }
  return null
}

/** The e-mail steps a level lets go by themselves in a company (a letter or a call always waits for a person). */
export function trustedSteps(trust: CustomerTrust, level: number | null): Array<{ companyCode: string; on: boolean; steps: number[] }> {
  if (level === null) return []
  return trust.companies.map((company) => ({ companyCode: company.code, on: company.remindersEnabled, steps: company.steps.filter((step) => step.action === 'EMAIL' && step.level <= level).map((step) => step.level) }))
}

/** A live event that changes the stops or a trusted level. */
export const stopsTouched = (change: { type: string }): boolean => change.type === 'reminder_stop.changed' || change.type === 'reminder_trust.changed' || change.type.startsWith('payment_reminder.')
