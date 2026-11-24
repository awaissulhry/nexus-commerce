import type { ReceivablesSettings, Reminder } from '../../../../finance/receivables/api'
import type { CustomerTrust, ReminderStop } from '../../../../finance/receivables/reminder-stops/api'
import { word, type MoneyWord } from '../../../orders/record/money/word'
import { invoiceHref } from './doors'
import { isFailed, isReading, type MoneyTabInput, type Part } from './model'

/**
 * F-CM-302 (customer page › MONEY tab, cm-w3 W3.2; 10-design §5.6; 18-lead-settles Z9) — section 6, Statement & reminders (#statement;
 * receivables.view — left out without it): this customer's reminders and the stops in force, the trusted level, reminders ON or OFF.
 *
 *   Reminders     "Level 2 · E-mail" + its state · for which invoices · prepared / sent day · why it is held (Finance's own words) or
 *                 "waits for a person" · the amount and the late interest (price grain) · ONE act: Review in Finance › — a DOOR
 *                 (`/finance/receivables?reminder=<id>`: the reminder window in place is LATER, Z9)
 *   Stops         the reason · the invoice · the note · until a day / until lifted · recorded when and by whom · ONE act: Lift… (Finance's
 *                 own stop container, in place — the invoice's stops with Lift; receivables.reminders.manage) · no "Change…" (Z9: LATER)
 *   Head          Statement… (Finance's own window, in place — only with the price grain: without it the window would draw held buttons)
 *                 · ⋯ Their figures › · Ri.Ba. › · Open in Finance › Receivables & credit ›
 */

export interface ReminderRow {
  readonly id: string
  readonly anchor: string
  readonly title: MoneyWord
  readonly state: { readonly word: MoneyWord; readonly tone: 'warning' | 'info' | 'success' | 'neutral' }
  readonly invoices: readonly string[]
  readonly when: MoneyWord
  readonly notes: readonly MoneyWord[]
  readonly amount: number | null
  readonly interest: number | null
  readonly currency: string
  readonly href: string
}

export interface StopRow {
  readonly id: string
  readonly anchor: string
  readonly reason: MoneyWord
  readonly invoice: { readonly id: string; readonly number: string | null; readonly href: string }
  readonly note: string | null
  readonly until: MoneyWord
  readonly recorded: MoneyWord
  /** Lift… in place (Finance's stop container on the invoice): its right, and the stop's own verdict. */
  readonly liftable: boolean
}

export interface ChaseModel {
  readonly reading: boolean
  readonly problem: string | null
  readonly answer: readonly MoneyWord[]
  /** "Reminders are switched off for this company" (Finance's own words), once. */
  readonly off: MoneyWord | null
  readonly reminders: readonly ReminderRow[]
  readonly stops: readonly StopRow[]
  /** Statement… in place (receivables.view + the price grain, and something to state). */
  readonly statement: boolean
}

const STATE_TONE: Readonly<Record<string, ReminderRow['state']['tone']>> = { PREPARED: 'warning', APPROVED: 'info', SENT: 'success', SKIPPED: 'neutral', CANCELLED: 'neutral' }

/** The section's model (pure). Left out (null) without receivables.view. */
export function chaseOf(input: MoneyTabInput, trust: Part<CustomerTrust> | null, settings: Part<ReceivablesSettings> | null, prefix: string, hasDocuments: boolean): ChaseModel | null {
  const can = input.can
  if (!can.receivables || !input.reminders || !input.stops) return null
  const price = can.price
  const readsIn = [input.reminders, input.stops]
  if (readsIn.some((part) => isReading(part))) return { reading: true, problem: null, answer: [word('cm.chase.reading')], off: null, reminders: [], stops: [], statement: false }
  const failed = readsIn.find((part) => isFailed(part))
  if (failed) return { reading: false, problem: failed.problem, answer: [], off: null, reminders: [], stops: [], statement: false }
  const live = (input.reminders.value ?? []).filter((reminder: Reminder) => reminder.status === 'PREPARED' || reminder.status === 'APPROVED' || reminder.status === 'SENT')
  const reminders: ReminderRow[] = live
    .sort((a, b) => b.preparedAt.localeCompare(a.preparedAt))
    .map((reminder) => ({
      id: reminder.id,
      anchor: `cm-Reminder-${reminder.id}`,
      title: word('cm.dot', { words: { first: word('finance-receivables:level.number', { params: { level: reminder.level } }), second: word(`finance-receivables:action.${reminder.action}`) } }),
      state: { word: word(`finance-receivables:status.${reminder.status}`), tone: STATE_TONE[reminder.status] ?? 'neutral' },
      invoices: reminder.invoices.map((invoice) => invoice.number ?? '—'),
      when: reminder.sentAt ? word('cm.chase.sent', { instants: { date: reminder.sentAt } }) : word('cm.chase.prepared', { instants: { date: reminder.preparedAt } }),
      notes: reminder.status === 'PREPARED' ? (reminder.held.length > 0 ? reminder.held.map((held) => word(`finance-receivables:heldReason.${held.code}`)) : [word('cm.chase.waits')]) : [],
      amount: price && typeof reminder.amountDue === 'number' ? reminder.amountDue : null,
      interest: price && typeof reminder.interestAmount === 'number' && reminder.interestAmount > 0 ? reminder.interestAmount : null,
      currency: reminder.currency,
      href: `${prefix}/finance/receivables?reminder=${encodeURIComponent(reminder.id)}`,
    }))
  const stops: StopRow[] = (input.stops.value ?? [])
    .filter((stop) => stop.state === 'holding')
    .map((stop: ReminderStop) => ({
      id: stop.id,
      anchor: `cm-Stop-${stop.id}`,
      reason: word(`finance-payments-depth:stops.reason.${stop.reason}`),
      invoice: { id: stop.invoice.id, number: stop.invoice.number, href: invoiceHref(prefix, stop.invoice, stop.company.id) },
      note: stop.note,
      until: stop.until ? word('cm.chase.until', { days: { date: stop.until } }) : word('finance-payments-depth:stops.untilLifted'),
      recorded: stop.createdBy?.name ? word('cm.chase.recordedBy', { instants: { date: stop.createdAt }, params: { name: stop.createdBy.name } }) : word('cm.chase.recorded', { instants: { date: stop.createdAt } }),
      liftable: can.remindersManage && stop.can.lift,
    }))
  const waiting = reminders.filter((row) => row.notes.length === 1 && row.notes[0]!.key === 'cm.chase.waits').length
  const sent = reminders.filter((row) => row.state.word.key.endsWith('.SENT')).length
  const answer: MoneyWord[] = []
  if (waiting > 0) answer.push(word('cm.needs.reminders', { params: { count: waiting } }))
  if (sent > 0) answer.push(word('cm.chase.sentCount', { params: { count: sent } }))
  answer.push(stops.length > 0 ? word('cm.chase.stops', { params: { count: stops.length } }) : word('cm.chase.noStop'))
  const level = trust?.value?.level ?? null
  if (trust?.value) answer.push(level !== null ? word('cm.chase.level', { params: { level } }) : word('cm.chase.noLevel'))
  const on = settings?.value?.switch.on ?? null
  return {
    reading: false,
    problem: null,
    answer,
    off: on === false ? word('finance-receivables:switch.offTitle') : null,
    reminders,
    stops,
    statement: price && hasDocuments,
  }
}
