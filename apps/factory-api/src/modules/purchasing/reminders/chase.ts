import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type Clock } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { REMINDERS } from '@nexus/factory-domain/purchasing/orders/delivery'
import { PURCHASING_REMINDERS_SWITCH } from '@nexus/factory-domain/purchasing/reminders/permissions'
import { switchOf } from '@nexus/factory-domain/purchasing/reminders/settings'
import { events as followupEvents } from '@nexus/factory-domain/buying-followups/events'
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { chaseFacts, chaseInCommand } from '../expediting/chase'
import { officeContextOf, readOrder, type OrderRow, type Reader } from '../store'
import { SYSTEM_SENDER } from './remind'
import { getReminderSettings } from './settings'

/**
 * Chase reminders and the reminders' timing (B-W2b-377; follow-up XF5:05; SCM-068, SCM-087; B-W2b-305's chase, B-W2b-354's
 * settings card, B-W2b-363's PurchaseReminderKind CHASE and PurchasingSettings.confirmByHours / reminderCadenceDays).
 *
 *   timing     per company: the confirm-by hours (its row, else the tenant-wide row, else W2a's default: 48 hours, longer over
 *              the supplier's closed days) are the send's default confirm-by; the cadence (its row, else the tenant's, else
 *              one day) spaces the automatic reminders — confirmation reminders and chases alike: the first when due, then one
 *              every N days, at most three per revision, one by hand counted
 *   chase row  every chase writes a PurchaseOrderReminder of kind CHASE of the order's current revision (by hand:
 *              expediting/chase.ts; by the daily run), so "Reminders sent" lists them and the count holds
 *   daily run  cron `purchasing.chaseReminders` (every day at 09:30 Rome, clustered): per tenant, the orders that wait for goods
 *              (SENT, CONFIRMED, CHANGES_PROPOSED, PARTLY_RECEIVED) with a LATE line (expected before today). Mail to a supplier
 *              leaves only for a company whose automatic reminders are ON (the Owner's switch, PurchasingSettings: OFF by
 *              default, e-mail on its FAKE provider until the go-live); while OFF the run only counts. ONE system command per
 *              order (its version compared and set; key = order + revision + count: a repeated tick sends nothing twice).
 *   routes     GET /purchasing/reminders/settings answers `timing` too (./settings.ts); PUT /purchasing/reminders/settings/timing
 *              {companyId | null, confirmByHours | null, reminderCadenceDays | null, version?} (purchasing.reminders.switch:
 *              how often real suppliers are written to is the Owner's), ONE command on the row FOR UPDATE at the version read.
 */

const [, , chaseEvent] = followupEvents
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
export const DEFAULT_CADENCE_DAYS = REMINDERS.everyHours / 24
export const CHASE_STATUSES = ['SENT', 'CONFIRMED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED'] as const
export const TIMING_LIMITS = Object.freeze({ confirmByHours: { min: 1, max: 720 }, cadenceDays: { min: 1, max: 30 } })

export interface TimingRow {
  readonly companyId: string | null
  readonly confirmByHours: number | null
  readonly reminderCadenceDays: number | null
}

export interface Timing {
  /** The send's default confirm-by in hours; null: W2a's default (48 hours over the supplier's open days). */
  readonly confirmByHours: number | null
  readonly cadenceDays: number
  readonly source: { readonly confirmByHours: 'COMPANY' | 'TENANT' | 'DEFAULT'; readonly cadenceDays: 'COMPANY' | 'TENANT' | 'DEFAULT' }
}

/** A company's timing from its own row and the tenant's (each value on its own: a row may set one and leave the other). */
export function timingFrom(company: TimingRow | null, tenant: TimingRow | null): Timing {
  const hours = company?.confirmByHours ?? tenant?.confirmByHours ?? null
  const cadence = company?.reminderCadenceDays ?? tenant?.reminderCadenceDays ?? null
  return {
    confirmByHours: hours,
    cadenceDays: cadence ?? DEFAULT_CADENCE_DAYS,
    source: {
      confirmByHours: company?.confirmByHours != null ? 'COMPANY' : tenant?.confirmByHours != null ? 'TENANT' : 'DEFAULT',
      cadenceDays: company?.reminderCadenceDays != null ? 'COMPANY' : tenant?.reminderCadenceDays != null ? 'TENANT' : 'DEFAULT',
    },
  }
}

/** The timing per company from every row of the tenant (the daily runs read them once per tenant). */
export function timingOf(rows: readonly TimingRow[]): (companyId: string) => Timing {
  const tenant = rows.find((row) => row.companyId === null) ?? null
  const byCompany = new Map(rows.filter((row) => row.companyId !== null).map((row) => [row.companyId!, row]))
  return (companyId) => timingFrom(byCompany.get(companyId) ?? null, tenant)
}

/** One company's timing (its row is id = the company's id; the tenant's id = the tenant's). */
export async function timingFor(db: Reader, tenantId: string, companyId: string): Promise<Timing> {
  const rows = await db.purchasingSettings.findMany({ where: { id: { in: [companyId, tenantId] } }, select: { id: true, companyId: true, confirmByHours: true, reminderCadenceDays: true } })
  return timingFrom(rows.find((row) => row.companyId === companyId) ?? null, rows.find((row) => row.companyId === null && row.id === tenantId) ?? null)
}

/** The send's default confirm-by: the company's hours after now when it sets them, else W2a's (`fallback`). */
export async function defaultConfirmByFor(db: Reader, tenantId: string, companyId: string, now: Date, fallback: Date): Promise<Date> {
  const timing = await timingFor(db, tenantId, companyId)
  return timing.confirmByHours === null ? fallback : new Date(now.getTime() + timing.confirmByHours * HOUR_MS)
}

/**
 * Where an order's automatic reminders of one kind stand with a cadence: the first once `from` has passed, then one every
 * `cadenceDays` days after the last, at most REMINDERS.most per revision (one sent by hand counts).
 */
export function cadenceState(reminders: readonly { readonly sentAt: Date }[], from: Date | null, cadenceDays: number, now: Date): { readonly due: boolean; readonly sent: number; readonly lastAt: Date | null; readonly nextAt: Date | null } {
  const sorted = [...reminders].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
  const last = sorted.at(-1)?.sentAt ?? null
  if (from === null || sorted.length >= REMINDERS.most) return { due: false, sent: sorted.length, lastAt: last, nextAt: null }
  const after = last === null ? from.getTime() : Math.max(from.getTime(), last.getTime() + cadenceDays * DAY_MS)
  return { due: after <= now.getTime(), sent: sorted.length, lastAt: last, nextAt: new Date(after) }
}

/** The CHASE reminder of the order's current revision (inside the chase's command; the database checks the order's state). */
export async function recordChase(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'partyId' | 'siteId' | 'companyId' | 'revision'>, input: { readonly sentById: string | null; readonly to: string; readonly outboundId: string; readonly note: string | null }): Promise<string> {
  const id = newId()
  await tools.tx.purchaseOrderReminder.create({
    data: { id, purchaseOrderId: order.id, partyId: order.partyId, siteId: order.siteId, revision: order.revision, kind: 'CHASE', sentAt: tools.now, sentById: input.sentById, toAddress: input.to, emailOutboundId: input.outboundId, note: input.note, createdById: input.sentById },
    select: { id: true },
  })
  tools.emit(eventFor(chaseEvent, { subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, revision: order.revision, reminderId: id, automatic: input.sentById === null } }))
  return id
}

// ---- the daily run ------------------------------------------------------------------------------------------------------

export interface ChaseRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** The switch per company (tests may force it; default: each tenant's PurchasingSettings, read once per run). */
  readonly switchOn?: (companyId: string) => boolean
}

export interface ChaseRun {
  readonly tenants: number
  readonly due: number
  readonly sent: number
  /** Due, but the company's automatic reminders are off: nothing went to the supplier. */
  readonly switchedOff: number
  readonly failed: number
}

const RUN_LIMIT = 500

/** The orders that wait for goods with a line late today, and where their chases stand (the system's scope). */
async function lateOrders(client: Prisma.TransactionClient, now: Date, timing: (companyId: string) => Timing) {
  const today = businessDate(now)
  const before = new Date(`${today}T00:00:00.000Z`)
  // Only orders with a day already passed (a line's, or one of its deliveries'): the worklist then says which lines are LATE.
  const passed = { OR: [{ needDate: { lt: before } }, { confirmedDate: { lt: before } }] }
  const orders = await client.purchaseOrder.findMany({
    where: { status: { in: [...CHASE_STATUSES] }, lines: { some: { OR: [passed, { deliveries: { some: passed } }] } } },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: RUN_LIMIT,
    select: { id: true },
  })
  const out: { order: OrderRow; lateLineIds: string[]; state: ReturnType<typeof cadenceState> }[] = []
  for (const { id } of orders) {
    const order = await readOrder(client, id)
    if (!order) continue
    const facts = await chaseFacts(client, order, today, now)
    const late = facts.chased.filter((line) => line.reasons.includes('LATE'))
    if (late.length === 0) continue
    const chases = await client.purchaseOrderReminder.findMany({ where: { purchaseOrderId: order.id, revision: order.revision, kind: 'CHASE' }, select: { sentAt: true } })
    // Late since the day after its expected day (the earliest of the late lines).
    const since = late.map((line) => line.expectedDate).filter((day): day is string => typeof day === 'string').sort()[0]
    const from = since ? new Date(`${since}T00:00:00.000Z`) : now
    out.push({ order, lateLineIds: late.map((line) => line.lineId), state: cadenceState(chases, new Date(from.getTime() + DAY_MS), timing(order.companyId).cadenceDays, now) })
  }
  return out
}

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runChaseReminders(options: ChaseRunOptions): Promise<ChaseRun> {
  const clock = options.clock ?? serverClock
  const settings = { ...COMMAND_SETTINGS, clock }
  const requestId = `po-chases-${newId()}`
  const totals = { due: 0, sent: 0, switchedOff: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const rows = await caller.withClient((client) => client.purchasingSettings.findMany({ select: { companyId: true, confirmationRemindersEnabled: true, confirmByHours: true, reminderCadenceDays: true } }))
    const switchOn = options.switchOn ?? switchOf(rows)
    const now = clock.now()
    const due = (await caller.withClient((client) => lateOrders(client as unknown as Prisma.TransactionClient, now, timingOf(rows)))).filter((row) => row.state.due)
    for (const { order, lateLineIds, state } of due) {
      totals.due++
      if (!switchOn(order.companyId)) {
        totals.switchedOff++
        continue
      }
      try {
        await runCommand(
          caller,
          { name: 'purchasing.chaseAutomatic', idempotencyKey: `po-chase-${order.id}-${order.revision}-${state.sent + 1}`, input: { purchaseOrderId: order.id, revision: order.revision, count: state.sent + 1 }, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: order.version } },
          async (tools) => chaseInCommand(tools, (await readOrder(tools.tx, order.id))!, { sender: SYSTEM_SENDER, sentById: null, lineIds: lateLineIds, message: null }),
          settings,
        )
        totals.sent++
      } catch (error) {
        totals.failed++
        options.log.error({ err: error, tenantId, purchaseOrderId: order.id }, 'a chase reminder could not be sent')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.due > 0) options.log.info({ ...run }, 'purchase order chase reminders')
  return run
}

/** The scheduler's cron: every day at 09:30 (Europe/Rome), after the confirmation reminders. */
export function chaseRemindersCron(options: ChaseRunOptions): CronJob {
  return defineCron({
    name: 'purchasing.chaseReminders',
    schedule: '30 9 * * *',
    async run() {
      await runChaseReminders(options)
    },
  })
}

// ---- the timing's route --------------------------------------------------------------------------------------------------

export interface TimingBody {
  readonly companyId: string | null
  readonly confirmByHours: number | null
  readonly reminderCadenceDays: number | null
  readonly version?: number | undefined
}

/** As the switch (./settings.ts): over the company, or a role over every company for the tenant-wide row. */
const mayAt = (context: OfficeContext, companyId: string | null): boolean =>
  companyId === null ? grantsFor(actorOf(context), PURCHASING_REMINDERS_SWITCH).some((grant) => grant.companies === 'all') : can(actorOf(context), PURCHASING_REMINDERS_SWITCH, { companyId })

/** PUT /purchasing/reminders/settings/timing (purchasing.reminders.switch over the company; every company for the tenant row). */
export async function putReminderTiming(caller: CommandCaller, body: TimingBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!mayAt(context, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'The reminders of every company are timed only by a role over every company.' : 'Only the owner sets how often suppliers are reminded.')
  const problems = [
    ...(body.confirmByHours !== null && (body.confirmByHours < TIMING_LIMITS.confirmByHours.min || body.confirmByHours > TIMING_LIMITS.confirmByHours.max) ? [{ path: 'body/confirmByHours', message: 'Between 1 and 720 hours.' }] : []),
    ...(body.reminderCadenceDays !== null && (body.reminderCadenceDays < TIMING_LIMITS.cadenceDays.min || body.reminderCadenceDays > TIMING_LIMITS.cadenceDays.max) ? [{ path: 'body/reminderCadenceDays', message: 'Between 1 and 30 days.' }] : []),
  ]
  if (problems.length > 0) throw new ValidationError('Ask for an answer within 1 to 720 hours and remind every 1 to 30 days.', problems)
  await command(caller, { name: 'purchasing.reminderTiming', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const id = body.companyId ?? context.tenantId
    if (body.companyId !== null && !(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    await tx.$queryRaw`SELECT id FROM "PurchasingSettings" WHERE id = ${id}::uuid FOR UPDATE`
    const existing = await tx.purchasingSettings.findUnique({ where: { id }, select: { id: true, companyId: true, version: true, confirmByHours: true, reminderCadenceDays: true, confirmationRemindersEnabled: true } })
    if (existing && (body.version === undefined || body.version !== existing.version)) throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and save again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    if (!existing && body.version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
    const before = existing ? { confirmByHours: existing.confirmByHours, reminderCadenceDays: existing.reminderCadenceDays } : null
    const after = { confirmByHours: body.confirmByHours, reminderCadenceDays: body.reminderCadenceDays }
    if (existing && before!.confirmByHours === after.confirmByHours && before!.reminderCadenceDays === after.reminderCadenceDays) return { id }
    let enabled = existing?.confirmationRemindersEnabled ?? false
    if (existing) await tx.purchasingSettings.update({ where: { id }, data: { ...after, version: existing.version + 1, updatedAt: now }, select: { id: true } })
    else {
      // A company's first change makes its own row, keeping the switch it followed (the tenant's, else OFF).
      const tenant = body.companyId !== null ? await tx.purchasingSettings.findUnique({ where: { id: context.tenantId }, select: { confirmationRemindersEnabled: true } }) : null
      enabled = tenant?.confirmationRemindersEnabled ?? false
      await tx.purchasingSettings.create({ data: { id, companyId: body.companyId, confirmationRemindersEnabled: enabled, ...after, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    }
    tools.audit({ action: 'purchasing.reminderTiming', recordType: 'PurchasingSettings', recordId: id, companyId: body.companyId, ...(before ? { before } : {}), after })
    tools.emit({ type: 'purchasing_settings.changed', subject: id, companyId: body.companyId, payload: { settingsId: id, companyId: body.companyId, confirmationRemindersEnabled: enabled } })
    return { id }
  })
  return getReminderSettings(caller, { companyId: body.companyId ?? undefined })
}
