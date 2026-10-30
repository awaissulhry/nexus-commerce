import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EffectiveSettings } from '@nexus/factory-domain/receivables/ladder'
import { PAYMENT_REMINDER_TIMER, planLadder, type LadderPlan, type PlannedReminder } from '@nexus/factory-domain/receivables/reminders'
import { reminderLanguageOf, reminderText } from '@nexus/factory-domain/receivables/wording'
import { dueAtOf, parseTimerKey, timerKeyOf, timerPlan, type TimerPlan, type WantedTimer } from '@nexus/factory-domain/timers/rules'
import { callerFor, type CommandCaller, type CommandTools } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { defineHandler, type EventHandler } from '../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../platform/outbox/system'
import { applyTimerPlan, TIMER_COLUMNS, type TimerRow } from '../../platform/timers/service'
import {
  knownReminderOf,
  lockCustomer,
  openInvoices,
  receivablesClock,
  receivablesCommand,
  remindersOf,
  settingsFor,
  tenantIdOf,
  today,
  type CustomerScope,
  type OpenInvoiceRow,
  type Reader,
  type ReminderRow,
} from './store'

/**
 * THE reminder ladder (B-W2a-55; FIN-111; design finance.receivables "Reminders the ladder prepared; a person approves
 * them"; W2a plan: "a ladder that prepares reminders on the timers; a person approves each"). For one customer of one
 * company, in ONE command under the customer's advisory lock (store.ts lockCustomer), factory-domain receivables/reminders
 * `planLadder` decides and this file writes:
 *
 *   1. open reminders whose claim changed (paid or credited since) → CANCELLED by the ladder, with the reason
 *   2. only when a timer fired (prepare): one PREPARED reminder per level due, its text in the customer's language from the
 *      step's template (placeholders to confirm with the accountant); createdById null = the ladder's
 *   3. the invoices' ladder timers (platform/timers, record Invoice, key PAYMENT_REMINDER:±Nd, company + customer on the
 *      timer): the due level's (fires now) and the next step's; the rest cancelled (GONE, or RULE_OFF without a ladder)
 *
 * When it runs:
 *   - a ladder timer fired (`timer.fired`, worker handler receivables.ladderTimer): prepare = true
 *   - the customer's money changed (invoice issued, payment allocated, reversed or voided, a reminder sent, skipped or
 *     cancelled, the settings changed: worker handler receivables.ladderRecheck) and every day at 06:00 (cron
 *     receivables.ladder): prepare = false, so the due reminders are prepared by their timers
 * A pass first plans read-only and writes only when there is work (an idle pass leaves no audit row). NOTHING IS SENT
 * HERE: a reminder reaches a customer only after a person approves and sends it (./reminders.ts), and only while the
 * company's reminders are switched on (the Owner's switch; the database refuses SENT otherwise). The due-date alerts of
 * platform/alerts are not doubled: the ladder raises no alert.
 */

interface CustomerFacts {
  readonly settings: EffectiveSettings
  readonly invoices: readonly OpenInvoiceRow[]
  readonly reminders: readonly ReminderRow[]
  readonly pending: readonly TimerRow[]
  readonly fired: readonly TimerRow[]
}

const TIMER_WHERE = (scope: CustomerScope) => ({ companyId: scope.companyId, partyId: scope.partyId, ruleId: null, recordType: 'Invoice', timerKey: { startsWith: PAYMENT_REMINDER_TIMER } })

async function customerFacts(db: Reader, scope: CustomerScope, day: BusinessDate): Promise<CustomerFacts> {
  const settings = await settingsFor(db, scope.companyId)
  const invoices = await openInvoices(db, { companyId: scope.companyId, partyId: scope.partyId, asOf: day })
  const ids = invoices.map((invoice) => invoice.id)
  const reminders = await remindersOf(db, scope, ids)
  const pending = await db.dueTimer.findMany({ where: { ...TIMER_WHERE(scope), status: 'PENDING' }, select: TIMER_COLUMNS })
  const fired = ids.length === 0 ? [] : await db.dueTimer.findMany({ where: { ...TIMER_WHERE(scope), status: 'FIRED', recordId: { in: ids } }, select: TIMER_COLUMNS })
  return { settings, invoices, reminders, pending, fired }
}

const asTimer = (row: TimerRow): WantedTimer => ({ recordType: row.recordType, recordId: row.recordId, timerKey: row.timerKey, dueAt: row.dueAt, fireAt: row.fireAt })

const wantedOf = (timer: LadderPlan['timers'][number]): WantedTimer => ({
  recordType: 'Invoice',
  recordId: timer.invoiceId,
  timerKey: timerKeyOf(PAYMENT_REMINDER_TIMER, { amount: timer.offsetDays, unit: 'd' }),
  dueAt: dueAtOf(timer.dueDate),
  fireAt: dueAtOf(timer.fireOn),
})
const sameTimer = (a: WantedTimer, b: WantedTimer): boolean => a.recordId === b.recordId && a.timerKey === b.timerKey && a.dueAt.getTime() === b.dueAt.getTime() && a.fireAt.getTime() === b.fireAt.getTime()

/**
 * The customer's plan. A pass without a firing still prepares at once when it cancelled a reminder whose claim changed
 * (prepared again with today's figures), or when a reminder due now already had its timer fire today (it was held then:
 * an open reminder of its level, now gone) — a timer never fires twice for the same day.
 */
function customerPlan(facts: CustomerFacts, day: BusinessDate, prepare: boolean): { readonly ladder: LadderPlan; readonly timers: TimerPlan; readonly wanted: readonly WantedTimer[]; readonly prepare: boolean } {
  const planOf = (now: boolean) =>
    planLadder({
      ladder: facts.settings.ladder,
      today: day,
      invoices: facts.invoices,
      reminders: facts.reminders.map(knownReminderOf),
      minimumAmount: facts.settings.minimumAmount,
      interest: { mode: facts.settings.lateInterestMode, agreedPct: facts.settings.lateInterestAgreedPct },
      prepare: now,
    })
  let ladder = planOf(prepare)
  if (!prepare) {
    const fired = facts.fired.map(asTimer)
    const firedToday = ladder.timers.some((timer) => timer.fireOn === day && fired.some((past) => sameTimer(past, wantedOf(timer))))
    if (ladder.cancel.length > 0 || firedToday) {
      ladder = planOf(true)
      prepare = true
    }
  }
  const wanted = ladder.timers.map(wantedOf)
  const timers = timerPlan(
    wanted,
    facts.pending.map((row) => ({ id: row.id, ...asTimer(row) })),
    facts.settings.ladder.length === 0 ? 'RULE_OFF' : 'GONE',
    facts.fired.map(asTimer),
  )
  return { ladder, timers, wanted, prepare }
}

const hasWork = (plan: ReturnType<typeof customerPlan>): boolean => plan.ladder.cancel.length > 0 || plan.ladder.prepare.length > 0 || plan.timers.set.length > 0 || plan.timers.cancel.length > 0

export interface PassOutcome {
  readonly prepared: readonly string[]
  readonly cancelled: readonly string[]
  readonly waiting: LadderPlan['waiting']
  readonly timersSet: number
  readonly timersCancelled: number
}

/** The text a reminder is prepared with (the customer's language, the step's template, the company's rules). */
export async function preparedText(db: Reader, scope: CustomerScope, planned: PlannedReminder, settings: EffectiveSettings, iban: string | null) {
  // One query at a time: a transaction client runs one statement at a time.
  const party = await db.party.findUniqueOrThrow({ where: { id: scope.partyId }, select: { legalName: true, language: true } })
  const company = await db.company.findUniqueOrThrow({ where: { id: scope.companyId }, select: { legalName: true } })
  const language = reminderLanguageOf(party.language)
  const text = reminderText(planned.template, {
    language,
    customerName: party.legalName,
    companyName: company.legalName,
    currency: planned.currency,
    action: planned.action,
    offsetDays: planned.offsetDays,
    lines: planned.lines,
    amountDue: planned.amountDue,
    interestAmount: planned.interestAmount,
    interestMode: settings.lateInterestMode,
    recoveryChargeAmount: settings.recoveryChargeAmount,
    iban,
  })
  return { language, ...text }
}

/** Writes one PREPARED reminder (the ladder's: createdById null; a person's: theirs) with its audit row and event. */
export async function insertReminder(tools: CommandTools, scope: CustomerScope, planned: PlannedReminder, settings: EffectiveSettings, iban: string | null, byId: string | null): Promise<string> {
  const { tx, now } = tools
  const id = newId()
  const text = await preparedText(tx, scope, planned, settings, iban)
  await tx.paymentReminder.create({
    data: {
      id,
      companyId: scope.companyId,
      partyId: scope.partyId,
      level: planned.level,
      action: planned.action,
      invoiceIds: [...planned.invoiceIds],
      amountDue: planned.amountDue,
      interestAmount: planned.interestAmount,
      currency: planned.currency,
      oldestDueDate: new Date(`${planned.oldestDueDate}T00:00:00.000Z`),
      language: text.language,
      subject: text.subject,
      body: text.body,
      createdAt: now,
      updatedAt: now,
      createdById: byId,
    },
    select: { id: true },
  })
  tools.audit({
    action: byId ? 'receivables.prepare' : 'receivables.ladder',
    recordType: 'PaymentReminder',
    recordId: id,
    companyId: scope.companyId,
    after: { partyId: scope.partyId, level: planned.level, action: planned.action, invoiceIds: planned.invoiceIds, oldestDueDate: planned.oldestDueDate, template: text.template, language: text.language, byHand: byId !== null },
  })
  tools.emit({ type: 'payment_reminder.prepared', subject: id, companyId: scope.companyId, payload: { reminderId: id, partyId: scope.partyId, level: planned.level, action: planned.action, invoices: planned.invoiceIds.length, byHand: byId !== null } })
  return id
}

/** Cancels an open reminder (the ladder's: what it asks changed; a person's: their reason). */
export async function cancelReminderRow(tools: CommandTools, row: Pick<ReminderRow, 'id' | 'companyId' | 'partyId' | 'level' | 'status' | 'version'>, reason: string, bySystem: boolean): Promise<boolean> {
  const { count } = await tools.tx.paymentReminder.updateMany({
    where: { id: row.id, version: row.version, status: { in: ['PREPARED', 'APPROVED'] } },
    data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, version: row.version + 1, updatedAt: tools.now },
  })
  if (count === 0) return false
  tools.audit({ action: bySystem ? 'receivables.ladderCancel' : 'receivables.cancel', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'CANCELLED' }, reason })
  tools.emit({ type: 'payment_reminder.cancelled', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level, bySystem } })
  return true
}

/** One customer's ladder pass inside a command (see the file's comment). */
export async function ladderPassInCommand(tools: CommandTools, scope: CustomerScope, options: { readonly prepare: boolean; readonly day: BusinessDate }): Promise<PassOutcome> {
  await lockCustomer(tools.tx, tenantIdOf(tools.context), scope)
  const facts = await customerFacts(tools.tx, scope, options.day)
  const plan = customerPlan(facts, options.day, options.prepare)
  const rows = new Map(facts.reminders.map((row) => [row.id, row]))
  const cancelled: string[] = []
  for (const entry of plan.ladder.cancel) {
    const row = rows.get(entry.reminderId)
    if (row && (await cancelReminderRow(tools, row, entry.reason, true))) cancelled.push(row.id)
  }
  const ibans = new Map(facts.invoices.map((invoice) => [invoice.id, invoice.iban]))
  const prepared: string[] = []
  for (const planned of plan.ladder.prepare) {
    const iban = planned.invoiceIds.map((id) => ibans.get(id) ?? null).find((value) => value !== null) ?? null
    prepared.push(await insertReminder(tools, scope, planned, facts.settings, iban, null))
  }
  const numbers = new Map(facts.invoices.map((invoice) => [invoice.id, invoice.number]))
  const levels = new Map(plan.ladder.timers.map((timer) => [`${timer.invoiceId}|${timer.offsetDays}`, timer.level]))
  const applied = await applyTimerPlan(tools, plan.timers, new Map(facts.pending.map((row) => [row.id, row])), (wanted) => {
    const offset = parseTimerKey(wanted.timerKey)?.offset?.amount ?? 0
    return {
      record: { type: 'Invoice', id: wanted.recordId },
      recordLabel: numbers.get(wanted.recordId) ?? null,
      timerKey: wanted.timerKey,
      dueAt: wanted.dueAt,
      fireAt: wanted.fireAt,
      companyId: scope.companyId,
      partyId: scope.partyId,
      payload: { level: levels.get(`${wanted.recordId}|${offset}`) ?? null, offsetDays: offset },
    }
  })
  if (cancelled.length + prepared.length + applied.set + applied.cancelled === 0) {
    tools.audit({ action: 'receivables.ladder', recordType: 'Party', recordId: scope.partyId, companyId: scope.companyId, after: { idle: true } })
  }
  return { prepared, cancelled, waiting: plan.ladder.waiting, timersSet: applied.set, timersCancelled: applied.cancelled }
}

/** A customer's pass, read-only first: a command only when there is work. */
export async function runLadderFor(caller: CommandCaller, scope: CustomerScope, options: { readonly prepare: boolean; readonly day?: BusinessDate; readonly idempotencyKey?: string }): Promise<PassOutcome | null> {
  const day = options.day ?? today()
  const facts = await caller.withClient((client) => customerFacts(client, scope, day))
  if (!hasWork(customerPlan(facts, day, options.prepare))) return null
  const { result } = await receivablesCommand(caller, { name: 'receivables.ladder', idempotencyKey: options.idempotencyKey, input: { ...scope, prepare: options.prepare, day } }, (tools) => ladderPassInCommand(tools, scope, { prepare: options.prepare, day }))
  return result
}

/** Every customer the ladder may have work for in a tenant: open invoices, open reminders, pending ladder timers. */
async function customersOf(db: Reader, companyId: string | null, day: BusinessDate): Promise<CustomerScope[]> {
  const invoices = await openInvoices(db, { companyId, asOf: day })
  const reminders = await db.paymentReminder.findMany({ where: { status: { in: ['PREPARED', 'APPROVED'] }, ...(companyId ? { companyId } : {}) }, select: { companyId: true, partyId: true }, distinct: ['companyId', 'partyId'] })
  const timers = await db.dueTimer.findMany({ where: { status: 'PENDING', ruleId: null, recordType: 'Invoice', timerKey: { startsWith: PAYMENT_REMINDER_TIMER }, ...(companyId ? { companyId } : {}) }, select: { companyId: true, partyId: true }, distinct: ['companyId', 'partyId'] })
  const seen = new Map<string, CustomerScope>()
  for (const entry of [...invoices, ...reminders, ...timers]) {
    if (!entry.companyId || !entry.partyId) continue
    seen.set(`${entry.companyId}|${entry.partyId}`, { companyId: entry.companyId, partyId: entry.partyId })
  }
  return [...seen.values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.partyId.localeCompare(b.partyId))
}

export interface LadderRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

export interface LadderRun {
  readonly tenants: number
  readonly customers: number
  readonly passes: number
  readonly prepared: number
  readonly cancelled: number
  readonly failed: number
}

/** One pass over every customer of a tenant (or one company): the daily cron and a settings change. */
export async function runLadderForTenant(caller: CommandCaller, companyId: string | null, log: Log | null, day: BusinessDate = today()): Promise<Omit<LadderRun, 'tenants'>> {
  const totals = { customers: 0, passes: 0, prepared: 0, cancelled: 0, failed: 0 }
  const customers = await caller.withClient((client) => customersOf(client, companyId, day))
  for (const scope of customers) {
    totals.customers++
    try {
      const outcome = await runLadderFor(caller, scope, { prepare: false, day })
      if (!outcome) continue
      totals.passes++
      totals.prepared += outcome.prepared.length
      totals.cancelled += outcome.cancelled.length
    } catch (error) {
      totals.failed++
      log?.error({ err: error, ...scope }, 'the reminder ladder of a customer could not run')
    }
  }
  return totals
}

/** The daily pass over every active tenant (the cron's tick; tests call it directly). */
export async function runLadder(options: LadderRunOptions): Promise<LadderRun> {
  const requestId = `receivables-ladder-${newId()}`
  const totals = { tenants: 0, customers: 0, passes: 0, prepared: 0, cancelled: 0, failed: 0 }
  const day = businessDate(receivablesClock().now())
  for (const tenantId of await activeTenants(options.database)) {
    totals.tenants++
    const outcome = await runLadderForTenant(callerFor(options.database, systemContext(tenantId, requestId)), null, options.log, day)
    totals.customers += outcome.customers
    totals.passes += outcome.passes
    totals.prepared += outcome.prepared
    totals.cancelled += outcome.cancelled
    totals.failed += outcome.failed
  }
  if (totals.passes + totals.failed > 0) options.log.info({ ...totals }, 'receivables: the reminder ladder ran')
  return totals
}

/** The scheduler's cron: every day at 06:00 (Europe/Rome), before the office opens. */
export function ladderCron(options: LadderRunOptions): CronJob {
  return defineCron({
    name: 'receivables.ladder',
    schedule: '0 6 * * *',
    async run() {
      await runLadder(options)
    },
  })
}

// ---- the worker's handlers ----------------------------------------------------------------------------------------------------

type Payload = Record<string, unknown>
const str = (payload: Payload, key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null)

/** A ladder timer fired: the customer's due reminders are prepared (keyed by the timer: a repeat prepares nothing twice). */
export async function onTimerFired(caller: CommandCaller, payload: Payload): Promise<PassOutcome | null> {
  const timerId = str(payload, 'timerId')
  const key = str(payload, 'timerKey')
  if (!timerId || !key || payload.ruleId !== null || parseTimerKey(key)?.kind !== PAYMENT_REMINDER_TIMER) return null
  const timer = await caller.withClient((client) => client.dueTimer.findUnique({ where: { id: timerId }, select: { companyId: true, partyId: true, status: true } }))
  if (!timer?.companyId || !timer.partyId || timer.status !== 'FIRED') return null
  return runLadderFor(caller, { companyId: timer.companyId, partyId: timer.partyId }, { prepare: true, idempotencyKey: `ladder-timer:${timerId}` })
}

/** The customers an event touches (an invoice, a payment, a reminder of theirs), or a company whose settings changed. */
async function scopesOf(db: Reader, type: string, payload: Payload): Promise<{ readonly customers: CustomerScope[]; readonly company?: string | null }> {
  if (type === 'invoice.issued') {
    const id = str(payload, 'invoiceId')
    const invoice = id ? await db.invoice.findUnique({ where: { id }, select: { companyId: true, buyerPartyId: true, docType: true } }) : null
    return { customers: invoice && invoice.docType !== 'TD02' ? [{ companyId: invoice.companyId, partyId: invoice.buyerPartyId }] : [] }
  }
  if (type.startsWith('payment.')) {
    const id = str(payload, 'paymentId')
    const payment = id ? await db.payment.findUnique({ where: { id }, select: { companyId: true, partyId: true } }) : null
    return { customers: payment ? [payment] : [] }
  }
  if (type.startsWith('payment_reminder.')) {
    const id = str(payload, 'reminderId')
    const reminder = id ? await db.paymentReminder.findUnique({ where: { id }, select: { companyId: true, partyId: true } }) : null
    return { customers: reminder ? [reminder] : [] }
  }
  if (type === 'receivables_settings.changed') return { customers: [], company: str(payload, 'companyId') }
  return { customers: [] }
}

export const RECHECK_EVENTS = [
  'invoice.issued',
  'payment.allocated',
  'payment.allocation_reversed',
  'payment.voided',
  'payment_reminder.sent',
  'payment_reminder.skipped',
  'payment_reminder.cancelled',
  'receivables_settings.changed',
] as const

/** After a customer's money or reminders changed: its pass (prepare false), at once rather than tomorrow morning. */
export async function onRecheck(caller: CommandCaller, type: string, payload: Payload): Promise<void> {
  const scopes = await caller.withClient((client) => scopesOf(client, type, payload))
  if (type === 'receivables_settings.changed') {
    await runLadderForTenant(caller, scopes.company ?? null, null)
    return
  }
  for (const scope of scopes.customers) await runLadderFor(caller, scope, { prepare: false })
}

export function ladderHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'receivables.ladderTimer',
      events: ['timer.fired'],
      async handle(event, tools) {
        await onTimerFired(tools.caller, event.payload as Payload)
      },
    }),
    defineHandler({
      name: 'receivables.ladderRecheck',
      events: [...RECHECK_EVENTS],
      async handle(event, tools) {
        await onRecheck(tools.caller, event.type, event.payload as Payload)
      },
    }),
  ]
}
