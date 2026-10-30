import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type Clock } from '@nexus/factory-domain/core/time'
import { AUTOMATIC_REMINDERS_DEFAULT, reminderState } from '@nexus/factory-domain/purchasing/orders/delivery'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock } from '../../../core/time'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { officeContextOf, readOrder } from '../store'
import { remindInCommand, SYSTEM_SENDER } from './remind'

/**
 * The daily confirmation reminders (B-W2a-52; SCM-087 "Confirmation reminders are daily running"; W2a plan §2 "Owner
 * switch": PO confirmation reminders reach real suppliers only after the Owner turns them on per company, after
 * GATE-GOLIVE; off by default).
 *
 *   due list   GET /purchasing/reminders/due (purchasing.view): the orders the caller reaches that still wait for their
 *              supplier's answer after their confirm-by time, with the reminders sent for the current revision and when
 *              the daily run would send the next; the buyer sends one by hand from the record (./remind.ts).
 *   the run    cron `purchasing.confirmationReminders` (every day at 09:00 Rome, clustered): per tenant, the SENT orders
 *              past their deadline (factory-domain reminderState: the first after the deadline, then one a day, at most
 *              three per revision, a reminder by hand counted); for a company whose automatic reminders are ON, ONE
 *              system command per order (its version compared and set; key = order + revision + count, so a repeated tick
 *              sends nothing twice) writing the reminder as the buyer would. While the switch is OFF (always, until a
 *              setting holds it: no column in schema wave 3 — a schema need) the run sends nothing and only counts.
 */

/** The Owner's switch for one company: OFF until a per-company setting exists (factory-domain AUTOMATIC_REMINDERS_DEFAULT). */
export function automaticRemindersOn(_companyId: string): boolean {
  return AUTOMATIC_REMINDERS_DEFAULT
}

/** The SENT orders past their confirm-by time that this reader reaches (at most `take`, the oldest deadline first). */
async function overdueOrders(client: Prisma.TransactionClient, where: Prisma.PurchaseOrderWhereInput, now: Date, take: number) {
  const orders = await client.purchaseOrder.findMany({
    where: { AND: [where, { status: 'SENT', confirmBy: { lte: now } }] },
    orderBy: [{ confirmBy: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, revision: true, confirmBy: true, sentAt: true, sentById: true, version: true },
  })
  const reminders = orders.length === 0 ? [] : await client.purchaseOrderReminder.findMany({ where: { purchaseOrderId: { in: orders.map((order) => order.id) } }, select: { purchaseOrderId: true, revision: true, sentAt: true } })
  return orders.map((order) => ({ order, state: reminderState({ status: order.status, revision: order.revision, confirmBy: order.confirmBy, reminders: reminders.filter((row) => row.purchaseOrderId === order.id && row.revision === order.revision) }, now) }))
}

/** GET /purchasing/reminders/due (purchasing.view). */
export async function dueReminders(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined; readonly partyId?: string | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
  const where: Prisma.PurchaseOrderWhereInput = { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { siteId: query.siteId } : {}, query.partyId ? { partyId: query.partyId } : {}] }
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const rows = await overdueOrders(client as unknown as Prisma.TransactionClient, where, now, query.limit + 1)
    const page = rows.slice(0, query.limit)
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set(page.map((row) => row.order.partyId))] } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]))
    return {
      orders: page.map(({ order, state }) => ({
        id: order.id,
        number: order.number,
        companyId: order.companyId,
        siteId: order.siteId,
        partyId: order.partyId,
        supplierName: parties.get(order.partyId) ?? '',
        revision: order.revision,
        sentAt: order.sentAt ? toUtcIso(order.sentAt) : null,
        confirmBy: toUtcIso(order.confirmBy!),
        remindersSent: state.sent,
        lastReminderAt: state.lastAt ? toUtcIso(state.lastAt) : null,
        nextAutomaticAt: state.nextAt ? toUtcIso(state.nextAt) : null,
        automatic: automaticRemindersOn(order.companyId),
        version: order.version,
      })),
      more: rows.length > query.limit,
    }
  })
}

export interface ReminderRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** The switch per company (tests turn it on; the scheduler uses `automaticRemindersOn`). */
  readonly switchOn?: (companyId: string) => boolean
}

export interface ReminderRun {
  readonly tenants: number
  readonly due: number
  readonly sent: number
  /** Due, but the company's automatic reminders are off: nothing went to the supplier. */
  readonly switchedOff: number
  readonly failed: number
}

/** At most this many orders per tenant per run. */
const RUN_LIMIT = 500

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runConfirmationReminders(options: ReminderRunOptions): Promise<ReminderRun> {
  const clock = options.clock ?? serverClock
  const switchOn = options.switchOn ?? automaticRemindersOn
  const settings = { ...COMMAND_SETTINGS, clock }
  const requestId = `po-reminders-${newId()}`
  const totals = { due: 0, sent: 0, switchedOff: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const now = clock.now()
    const due = (await caller.withClient((client) => overdueOrders(client as unknown as Prisma.TransactionClient, {}, now, RUN_LIMIT))).filter((row) => row.state.due)
    for (const { order, state } of due) {
      totals.due++
      if (!switchOn(order.companyId)) {
        totals.switchedOff++
        continue
      }
      try {
        await runCommand(
          caller,
          { name: 'purchasing.remindAutomatic', idempotencyKey: `po-reminder-${order.id}-${order.revision}-${state.sent + 1}`, input: { purchaseOrderId: order.id, revision: order.revision, count: state.sent + 1 }, record: { type: 'PurchaseOrder', id: order.id, expectedVersion: order.version } },
          async (tools) => remindInCommand(tools, (await readOrder(tools.tx, order.id))!, { sender: SYSTEM_SENDER, sentById: null, message: null }),
          settings,
        )
        totals.sent++
      } catch (error) {
        totals.failed++
        options.log.error({ err: error, tenantId, purchaseOrderId: order.id }, 'a confirmation reminder could not be sent')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.due > 0) options.log.info({ ...run }, 'purchase order confirmation reminders')
  return run
}

/** The scheduler's cron: every day at 09:00 (Europe/Rome). */
export function confirmationRemindersCron(options: ReminderRunOptions): CronJob {
  return defineCron({
    name: 'purchasing.confirmationReminders',
    schedule: '0 9 * * *',
    async run() {
      await runConfirmationReminders(options)
    },
  })
}
