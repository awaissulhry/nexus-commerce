import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { REMINDER_HOURS_BEFORE, reminderDue, type AppointmentKind, type AppointmentStatus } from '@nexus/factory-domain/sales/fittings/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { deliverAppointmentMail, queueAppointmentMail, riderTargetOf, type MailTarget } from './mail'
import { APPOINTMENT_RECORD, APPOINTMENT_SELECT, garmentOfAppointment, garmentRefusal, type AppointmentRow } from './store'
// B-W2b-F38: the fitting reminder goes only for a company whose switch is on (off by default).
import { reminderOnFor, reminderSwitchBook, ReminderSwitchedOff } from '../quotes/reminder-switches'

/**
 * The rider's reminder of an appointment, run hourly (B-W2b-360; SAL-054 "appointments with reminders"): the scheduler's
 * clustered cron `sales.fittingReminders` (minute 23, Europe/Rome; one replica per tick). For every ACTIVE tenant, in its system
 * context: each BOOKED appointment starting within REMINDER_HOURS_BEFORE hours that has not been reminded, was booked (or last
 * invited) earlier than that (factory-domain sales/fittings reminderDue), whose garment type's made-to-measure rules are on
 * (GATE-MTM) and whose rider has an address gets ONE mail with the .ics (template fittings.reminder, from the company's system
 * identity), reminderSentAt set in the same command; appointment.mailed. Moving its time asks the reminder again
 * (appointments.ts clears reminderSentAt).
 *
 * Each appointment in its own command with a fixed Idempotency-Key (`fitting-reminder-<id>-<its start in ms>`, record
 * Appointment: its version bumps), so a race or a rerun mails once per start time; the mail goes after the commit on the tenant's
 * mail account (FAKE locally and in tests). What is not due, not started or has no address is skipped without a write; an
 * appointment or a tenant that fails is logged and the others go on.
 *
 * B-W2b-F38 (Owner 2026-11-13, option A): the reminder goes only for a company whose fitting reminder switch is on (Sales
 * settings; off by default). A company with it off is skipped before any command (`switchedOff`), and a switch turned off
 * while the run goes rolls the command back: no mail, no reminderSentAt, no receipt, so switching it on later still reminds
 * an appointment whose reminder is due then. The invite, update and cancel mails a person sends do not depend on it.
 */

export const REMIND_COMMAND = 'fittings.remind'

export interface ReminderOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  /** Default: the process's (processEmail). */
  readonly email?: () => EmailRuntime
}

export interface ReminderRun {
  readonly tenants: number
  readonly reminded: number
  readonly skipped: number
  /** B-W2b-F38: reminders due but not sent because the company's switch is off. */
  readonly switchedOff: number
  readonly failed: number
}

type Outcome = 'sent' | 'not due' | 'no identity' | 'switched off'

async function remindOne(caller: CommandCaller, settings: CommandSettings, email: () => EmailRuntime, row: AppointmentRow, garmentType: string, target: MailTarget): Promise<{ outcome: Outcome; delivery: string | null }> {
  // B-W2b-F38: a switch turned off after the listing rolls the command back (ReminderSwitchedOff): nothing written.
  const remind = () => runCommand(
    caller,
    { name: REMIND_COMMAND, idempotencyKey: `fitting-reminder-${row.id}-${row.startsAt.getTime()}`, input: { appointmentId: row.id }, record: { type: 'Appointment', id: row.id } },
    async (tools) => {
      const fresh = (await tools.tx.appointment.findUnique({ where: { id: row.id }, select: APPOINTMENT_SELECT }))!
      if (!reminderDue({ ...fresh, status: fresh.status as AppointmentStatus }, tools.now)) {
        tools.audit({ action: 'fittings.remindSkipped', recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, after: { why: 'not due', status: fresh.status, reminderSentAt: fresh.reminderSentAt ? toUtcIso(fresh.reminderSentAt) : null } })
        return { outcome: 'not due' as Outcome, queued: null }
      }
      // B-W2b-F38: the company's switch, read again in the command (the job listed it a moment before).
      if (!(await reminderOnFor(tools.tx, fresh.companyId, 'FITTING'))) throw new ReminderSwitchedOff('FITTING')
      const queued = await queueAppointmentMail(tools, { mail: 'REMINDER', companyId: fresh.companyId, appointment: { ...fresh, kind: fresh.kind as AppointmentKind }, sequence: tools.record!.version, garmentType, to: target, language: target.language, sender: null })
      if (!queued) {
        tools.audit({ action: 'fittings.remindSkipped', recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, after: { why: 'no mail identity' } })
        return { outcome: 'no identity' as Outcome, queued: null }
      }
      await tools.tx.appointment.update({ where: { id: row.id }, data: { reminderSentAt: tools.now, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: APPOINTMENT_RECORD, recordId: row.id, companyId: row.companyId, after: { reminderSentAt: toUtcIso(tools.now), outboundId: queued.outboundId, startsAt: toUtcIso(fresh.startsAt) } })
      tools.emit({ type: 'appointment.mailed', subject: row.id, companyId: row.companyId, payload: { appointmentId: row.id, partyId: row.partyId, mail: 'REMINDER', outboundId: queued.outboundId } })
      return { outcome: 'sent' as Outcome, queued }
    },
    settings,
  )
  let outcome: Awaited<ReturnType<typeof remind>>
  try {
    outcome = await remind()
  } catch (error) {
    if (error instanceof ReminderSwitchedOff) return { outcome: 'switched off', delivery: null }
    throw error
  }
  const { result, replayed } = outcome
  if (replayed || !result.queued) return { outcome: result.outcome, delivery: null }
  return { outcome: result.outcome, delivery: await deliverAppointmentMail(email(), caller, result.queued, settings.clock) }
}

/** One run over every active tenant (the cron's tick; tests call it directly). */
export async function runFittingReminders(options: ReminderOptions): Promise<ReminderRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const email = options.email ?? processEmail
  const now = clock.now()
  const requestId = `fitting-reminders-${newId()}`
  let reminded = 0
  let skipped = 0
  let switchedOff = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await asSystem(options.database, tenantId, requestId, async (client) => {
        const rows = await client.appointment.findMany({
          where: { status: 'BOOKED', reminderSentAt: null, startsAt: { gt: now, lte: new Date(now.getTime() + REMINDER_HOURS_BEFORE * 3_600_000) } },
          select: APPOINTMENT_SELECT,
          orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        })
        const out: { row: AppointmentRow; garmentType: string; target: MailTarget }[] = []
        // B-W2b-F38: every company's fitting reminder switch, read once for the tenant.
        const fittingReminderOn = rows.length === 0 ? () => false : await reminderSwitchBook(client, 'FITTING')
        for (const row of rows) {
          if (!reminderDue({ ...row, status: row.status as AppointmentStatus }, now)) continue
          // B-W2b-F38: switched off for its company: no command, nothing written.
          if (!fittingReminderOn(row.companyId)) {
            switchedOff++
            continue
          }
          const garmentType = await garmentOfAppointment(client, row)
          const target = garmentType && (await garmentRefusal(client, garmentType)) === null ? await riderTargetOf(client, row) : null
          if (!garmentType || !target) {
            skipped++
            continue
          }
          out.push({ row, garmentType, target })
        }
        return out
      })
      for (const entry of due) {
        try {
          const { outcome } = await remindOne(caller, settings, email, entry.row, entry.garmentType, entry.target)
          if (outcome === 'sent') reminded++
          else if (outcome === 'switched off') switchedOff++
          else skipped++
        } catch (error) {
          failed++
          options.log.error({ err: error, tenantId, appointmentId: entry.row.id }, 'the reminder of an appointment could not be sent')
        }
      }
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the appointments of a tenant could not be checked for their reminder')
    }
  }
  const result = { tenants: tenants.length, reminded, skipped, switchedOff, failed }
  options.log.info({ ...result }, 'appointment reminders checked')
  return result
}

/** The scheduler's hourly cron (minute 23, Europe/Rome). */
export function fittingRemindersCron(options: ReminderOptions): CronJob {
  return defineCron({
    name: 'sales.fittingReminders',
    schedule: '23 * * * *',
    async run() {
      await runFittingReminders(options)
    },
  })
}
