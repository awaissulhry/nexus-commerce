import type { MinorUnits } from '../core/money'
import { Dec } from '../tax/decimal'
import type { BusinessDate } from '../core/time'
import type { LadderStep, LateInterestMode, ReminderAction } from './ladder'
import { addDays, daysBetween, firstOpenDueDate, type OpenInstalment } from './ledger'

/**
 * The reminder ladder's plan for ONE customer of one company (B-W2a-55; FIN-111; design finance.receivables "Reminders to
 * approve": "Reminders the ladder prepared; a person approves them"), pure. The API runs it inside one command under the
 * customer's advisory lock: when a timer of the ladder fires (platform/timers, kind PAYMENT_REMINDER, one per open
 * invoice), once a day, and after the customer's invoices or payments change.
 *
 * Per open invoice (a TD01 or TD24 with something open) the ladder follows the due date of its OLDEST OPEN INSTALMENT:
 *   reached    the highest step whose day (due date + offsetDays) has come
 *   covered    the highest level of a reminder that names the invoice and is not CANCELLED (PREPARED, APPROVED, SENT or
 *              SKIPPED: a person skipped that level on purpose); a cancelled reminder covers nothing
 *   due        reached above covered: the invoice goes into the customer's reminder of that level (lower levels it
 *              jumped are not sent: the latest step speaks for them)
 * One reminder per customer and level is open (PREPARED or APPROVED) at a time: an invoice that reaches a level while
 * one is open waits for it to be sent, skipped or cancelled. A group under the company's minimum amount waits too.
 * A reminder claims what is open on the instalments that reached its step (a reminder by hand: all that is open), with the
 * late-payment interest only when the rule is AGREED (STATUTORY needs the half-year rate, not recorded yet: none). An open
 * reminder whose claim changed (paid or credited since it was prepared) is CANCELLED and prepared again with today's
 * figures, so a person never approves an amount that is no longer owed.
 *
 * Timers: each open invoice keeps at most two, keyed by the step's offset (`PAYMENT_REMINDER:+7d`): the due level's when
 * it may be prepared now (fires today), and the next step to come (fires on its day).
 */

export const PAYMENT_REMINDER_TIMER = 'PAYMENT_REMINDER'

export const REMINDER_STATUSES = ['PREPARED', 'APPROVED', 'SENT', 'SKIPPED', 'CANCELLED'] as const
export type ReminderStatus = (typeof REMINDER_STATUSES)[number]
export const OPEN_REMINDER_STATUSES: readonly ReminderStatus[] = ['PREPARED', 'APPROVED']

export interface OpenInvoice {
  readonly id: string
  readonly number: string
  readonly issueDate: BusinessDate
  readonly currency: string
  readonly dueDateKnown: boolean
  readonly instalments: readonly OpenInstalment[]
}

export interface KnownReminder {
  readonly id: string
  readonly level: number
  readonly status: ReminderStatus
  readonly invoiceIds: readonly string[]
  readonly amountDue: MinorUnits
  readonly currency: string
  /** The business day it was prepared. */
  readonly preparedOn: BusinessDate
  /** Prepared by a person (claims all that was open), not by the ladder. */
  readonly byHand: boolean
}

export interface InterestRule {
  readonly mode: LateInterestMode
  readonly agreedPct: string | null
}

export interface ReminderLine {
  readonly invoiceId: string
  readonly number: string
  readonly issueDate: BusinessDate
  /** The oldest instalment it claims. */
  readonly dueDate: BusinessDate
  readonly dueDateKnown: boolean
  readonly claimed: MinorUnits
  /** Days late on `dueDate` (negative: not due yet). */
  readonly daysLate: number
  readonly interest: MinorUnits | null
}

export interface PlannedReminder {
  readonly level: number
  readonly action: ReminderAction
  readonly template: string | null
  readonly offsetDays: number | null
  readonly currency: string
  readonly invoiceIds: readonly string[]
  readonly lines: readonly ReminderLine[]
  readonly amountDue: MinorUnits
  readonly interestAmount: MinorUnits | null
  readonly oldestDueDate: BusinessDate
}

export const WAIT_REASONS = {
  OPEN_REMINDER: "A reminder of this level is already waiting for the customer: it goes out (or is skipped) first.",
  UNDER_MINIMUM: "What is due is below the company's minimum amount for a reminder.",
} as const
export type WaitReason = keyof typeof WAIT_REASONS

export interface WantedReminderTimer {
  readonly invoiceId: string
  readonly level: number
  readonly offsetDays: number
  /** The due date the ladder follows (the timer's date). */
  readonly dueDate: BusinessDate
  /** The day it fires (its start, Europe/Rome). */
  readonly fireOn: BusinessDate
}

export interface LadderPlan {
  /** Open reminders whose claim changed: cancelled, then prepared again with today's figures. */
  readonly cancel: readonly { readonly reminderId: string; readonly reason: string }[]
  /** The reminders to prepare now (only when asked: a timer fired). */
  readonly prepare: readonly PlannedReminder[]
  /** Invoices due at a level that wait, and why. */
  readonly waiting: readonly { readonly invoiceId: string; readonly level: number; readonly reason: WaitReason }[]
  /** The timers each open invoice should have. */
  readonly timers: readonly WantedReminderTimer[]
}

export const STALE_REASON = 'Paid or credited since it was prepared: what it asks is no longer what is due. The ladder prepares it again with the open amounts.'
export const SETTLED_REASON = 'Paid or credited since it was prepared: nothing it names is open any more.'

/** The highest step whose day has come for a due date (null: none yet). */
export function reachedStep(ladder: readonly LadderStep[], dueDate: BusinessDate, today: BusinessDate): LadderStep | null {
  let reached: LadderStep | null = null
  for (const step of ladder) if (addDays(dueDate, step.offsetDays) <= today) reached = step
  return reached
}

/** The highest level of a reminder (not CANCELLED) that names the invoice; 0: none. */
export function coveredLevel(invoiceId: string, reminders: readonly KnownReminder[]): number {
  let level = 0
  for (const reminder of reminders) if (reminder.status !== 'CANCELLED' && reminder.invoiceIds.includes(invoiceId) && reminder.level > level) level = reminder.level
  return level
}

/** Late-payment interest at an agreed yearly rate on an amount late `days` days: amount × rate / 100 × days / 365, half up. */
export function agreedInterest(open: MinorUnits, agreedPct: string, days: number): MinorUnits {
  if (days <= 0 || open <= 0) return 0
  return Number.parseInt(new Dec(open).times(new Dec(agreedPct)).times(days).dividedBy(36_500).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
}

/** What a reminder claims on one invoice: the open instalments that reached the step (`offsetDays` null: all of them). */
export function claimLine(invoice: OpenInvoice, offsetDays: number | null, today: BusinessDate, interest: InterestRule): ReminderLine | null {
  const claimed = invoice.instalments.filter((instalment) => instalment.open > 0 && (offsetDays === null || addDays(instalment.dueDate, offsetDays) <= today))
  if (claimed.length === 0) return null
  const dueDate = claimed[0]!.dueDate
  const interestOf = (instalment: OpenInstalment) => agreedInterest(instalment.open, interest.agreedPct!, daysBetween(instalment.dueDate, today))
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    issueDate: invoice.issueDate,
    dueDate,
    dueDateKnown: invoice.dueDateKnown,
    claimed: claimed.reduce((sum, instalment) => sum + instalment.open, 0),
    daysLate: daysBetween(dueDate, today),
    interest: interest.mode === 'AGREED' && interest.agreedPct ? claimed.reduce((sum, instalment) => sum + interestOf(instalment), 0) : null,
  }
}

function reminderOf(step: Pick<LadderStep, 'level' | 'action' | 'template'> & { readonly offsetDays: number | null }, lines: readonly ReminderLine[], currency: string): PlannedReminder {
  const interest = lines.some((line) => line.interest !== null) ? lines.reduce((sum, line) => sum + (line.interest ?? 0), 0) : null
  return {
    level: step.level,
    action: step.action,
    template: step.template,
    offsetDays: step.offsetDays,
    currency,
    invoiceIds: lines.map((line) => line.invoiceId),
    lines,
    amountDue: lines.reduce((sum, line) => sum + line.claimed, 0),
    interestAmount: interest === 0 ? null : interest,
    oldestDueDate: lines.map((line) => line.dueDate).sort()[0]!,
  }
}

/** What an open reminder would claim now if it were prepared again on its own day; equal to its amount: not stale. */
export function claimNow(reminder: KnownReminder, invoices: ReadonlyMap<string, OpenInvoice>, ladder: readonly LadderStep[]): MinorUnits {
  const offset = reminder.byHand ? null : (ladder.find((step) => step.level === reminder.level)?.offsetDays ?? null)
  let claimed = 0
  for (const id of reminder.invoiceIds) {
    const invoice = invoices.get(id)
    if (!invoice) continue
    claimed += claimLine(invoice, offset, reminder.preparedOn, { mode: 'NONE', agreedPct: null })?.claimed ?? 0
  }
  return claimed
}

export interface LadderPlanInput {
  readonly ladder: readonly LadderStep[]
  readonly today: BusinessDate
  /** The customer's open TD01/TD24 invoices in the company. */
  readonly invoices: readonly OpenInvoice[]
  /** The customer's reminders in the company (every status). */
  readonly reminders: readonly KnownReminder[]
  readonly minimumAmount: MinorUnits | null
  readonly interest: InterestRule
  /** Prepare the due reminders (a timer fired); false: only cancel stale ones and plan the timers. */
  readonly prepare: boolean
}

/** THE ladder's plan for one customer (see the file's comment). */
export function planLadder(input: LadderPlanInput): LadderPlan {
  const byId = new Map(input.invoices.map((invoice) => [invoice.id, invoice]))
  const cancel: { reminderId: string; reason: string }[] = []
  const live: KnownReminder[] = []
  for (const reminder of input.reminders) {
    if (OPEN_REMINDER_STATUSES.includes(reminder.status)) {
      const now = claimNow(reminder, byId, input.ladder)
      if (now !== reminder.amountDue) {
        cancel.push({ reminderId: reminder.id, reason: now === 0 ? SETTLED_REASON : STALE_REASON })
        continue
      }
    }
    live.push(reminder)
  }
  const openLevels = new Set(live.filter((reminder) => OPEN_REMINDER_STATUSES.includes(reminder.status)).map((reminder) => `${reminder.currency}|${reminder.level}`))

  // The invoices due at a level now, grouped by currency and level.
  const due = new Map<string, { step: LadderStep; currency: string; invoices: OpenInvoice[] }>()
  const covered = new Map<string, number>()
  for (const invoice of input.invoices) {
    const level = coveredLevel(invoice.id, live)
    covered.set(invoice.id, level)
    const dueDate = firstOpenDueDate(invoice.instalments)
    if (!dueDate) continue
    const step = reachedStep(input.ladder, dueDate, input.today)
    if (!step || step.level <= level) continue
    const key = `${invoice.currency}|${step.level}`
    const group = due.get(key) ?? { step, currency: invoice.currency, invoices: [] }
    group.invoices.push(invoice)
    due.set(key, group)
  }

  const prepare: PlannedReminder[] = []
  const waiting: { invoiceId: string; level: number; reason: WaitReason }[] = []
  const ready = new Set<string>()
  for (const [key, group] of [...due.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (openLevels.has(key)) {
      for (const invoice of group.invoices) waiting.push({ invoiceId: invoice.id, level: group.step.level, reason: 'OPEN_REMINDER' })
      continue
    }
    const lines = group.invoices.map((invoice) => claimLine(invoice, group.step.offsetDays, input.today, input.interest)).filter((line): line is ReminderLine => line !== null)
    const planned = reminderOf(group.step, lines, group.currency)
    if (input.minimumAmount !== null && planned.amountDue < input.minimumAmount) {
      for (const invoice of group.invoices) waiting.push({ invoiceId: invoice.id, level: group.step.level, reason: 'UNDER_MINIMUM' })
      continue
    }
    for (const invoice of group.invoices) ready.add(invoice.id)
    if (input.prepare) {
      prepare.push(planned)
      for (const invoice of group.invoices) covered.set(invoice.id, group.step.level)
    }
  }

  const timers: WantedReminderTimer[] = []
  for (const invoice of input.invoices) {
    const dueDate = firstOpenDueDate(invoice.instalments)
    if (!dueDate) continue
    const level = covered.get(invoice.id) ?? 0
    const reached = reachedStep(input.ladder, dueDate, input.today)
    // Due now and nothing holds it: a timer that fires today (when preparing, the reminder was just planned instead).
    if (!input.prepare && reached && reached.level > level && ready.has(invoice.id)) timers.push({ invoiceId: invoice.id, level: reached.level, offsetDays: reached.offsetDays, dueDate, fireOn: input.today })
    const next = input.ladder.find((step) => step.level > Math.max(level, reached?.level ?? 0) && addDays(dueDate, step.offsetDays) > input.today)
    if (next) timers.push({ invoiceId: invoice.id, level: next.level, offsetDays: next.offsetDays, dueDate, fireOn: addDays(dueDate, next.offsetDays) })
  }
  return { cancel, prepare, waiting, timers }
}

/** A reminder a person asks for by hand (the ageing row, the order's schedule): the next level of the chosen invoices, all that is open on them. */
export function reminderByHand(ladder: readonly LadderStep[], invoices: readonly OpenInvoice[], reminders: readonly KnownReminder[], today: BusinessDate, interest: InterestRule): PlannedReminder | null {
  if (ladder.length === 0 || invoices.length === 0) return null
  const live = reminders.filter((reminder) => reminder.status !== 'CANCELLED')
  const covered = Math.max(0, ...invoices.map((invoice) => coveredLevel(invoice.id, live)))
  const step = ladder.find((entry) => entry.level === Math.min(covered + 1, ladder.length)) ?? ladder.at(-1)!
  const lines = invoices.map((invoice) => claimLine(invoice, null, today, interest)).filter((line): line is ReminderLine => line !== null)
  if (lines.length === 0) return null
  return reminderOf({ level: step.level, action: step.action, template: step.template, offsetDays: null }, lines, invoices[0]!.currency)
}

// ---- what holds a reminder back, and the refusals -----------------------------------------------------------------------------

/** Shown on a reminder to approve (design "Held (W2b stop rules)"): what W2a can tell; the other stop rules are W2b. */
export const HELD_REASONS = {
  UNPLACED_PAYMENT: 'The customer has money on account that is not allocated to an invoice yet (a payment being processed?): allocate it first, it may pay these invoices.',
  CREDIT_NOTE_DRAFT: 'A credit note is being prepared for one of its invoices.',
  CHANGED: 'Paid or credited since it was prepared: cancel it, the ladder prepares it again.',
  NO_CONTACT: 'No active contact of the customer receives invoices with an e-mail address.',
  SWITCHED_OFF: "Reminders are switched off for the company (the Owner's switch): it can be approved, not sent.",
} as const
export type HeldReason = keyof typeof HELD_REASONS

export const REMINDER_REFUSALS = {
  NOT_PREPARED: 'Only a reminder that waits for approval can be changed, approved or skipped.',
  NOT_APPROVED: 'A person approves a reminder before it is sent.',
  FINAL: 'This reminder is sent, skipped or cancelled: it never changes.',
  SWITCHED_OFF:
    "Reminders are switched off for this company: nothing is sent to a customer until the Owner switches them on (after the go-live, once the accountant decided the late-payment rule). The reminder can be approved and waits.",
  NO_CONTACT: 'Add an active contact of the customer who receives invoices (role Invoices) with an e-mail address: the reminder goes to them.',
  CHANGED: 'Something was paid or credited since this reminder was prepared: what it asks is no longer what is due. Cancel it; the ladder prepares it again.',
  NO_TEXT: 'An e-mail or a letter is approved with its subject and text.',
  CALL_NOTE: 'Say what was agreed on the call.',
  OPEN_AT_LEVEL: 'A reminder of this level is already waiting for this customer: approve, skip or cancel it first.',
  NOTHING_OPEN: 'Nothing is open on these invoices.',
  NO_LADDER: "The company has no reminder ladder: set its steps in the receivables settings first.",
  NOT_A_CALL: 'Only a call is recorded with what was said.',
} as const
export type ReminderRefusal = keyof typeof REMINDER_REFUSALS

/** At most this many reminders in one bulk approval. */
export const MAX_BULK_REMINDERS = 50
export const MAX_REMINDER_TEXT = { subject: 200, body: 8000, reason: 1000, callNote: 2000 } as const
