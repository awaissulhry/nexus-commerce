import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { remindersInForce, type ReminderKind, type ReminderSwitches } from '@nexus/factory-domain/sales/reminder-switches/rules'
import type { CommandTx } from '../../../core/command'

/**
 * Where the reminder switches are read (B-W2b-F38; Owner 2026-11-13, option A): the sales settings rows of the tenant (row-level
 * security keeps them to the caller's), in force per company by factory-domain sales/reminder-switches (its own row, else the
 * tenant-wide row, else off). The quote validity job (../quote-terms/validity.ts), the fitting reminder job
 * (../fittings/reminders.ts) and the reads that tell a person whether a reminder goes (the quote's terms, the appointment, the
 * Fittings tab, GET /sales/settings) use these; the switches are written by PUT /sales/settings/reminders (./settings.ts).
 */

type Reader = FactoryClient | CommandTx

export const REMINDER_SWITCH_COLUMNS = { id: true, companyId: true, quoteRemindersEnabled: true, fittingRemindersEnabled: true } as const satisfies Prisma.SalesSettingsSelect

/** The switches in force for one company (null: the tenant-wide ones). */
export async function reminderSwitchesFor(db: Reader, companyId: string | null): Promise<ReminderSwitches> {
  const rows = await db.salesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] }, select: REMINDER_SWITCH_COLUMNS })
  return remindersInForce(rows, companyId)
}

/** Whether one kind of reminder goes for a company now. */
export async function reminderOnFor(db: Reader, companyId: string, kind: ReminderKind): Promise<boolean> {
  const switches = await reminderSwitchesFor(db, companyId)
  return kind === 'QUOTE' ? switches.quoteRemindersEnabled : switches.fittingRemindersEnabled
}

/** Every company's switch of one kind, read once per job run: (companyId) → on. */
export async function reminderSwitchBook(db: Reader, kind: ReminderKind): Promise<(companyId: string) => boolean> {
  const rows = await db.salesSettings.findMany({ select: REMINDER_SWITCH_COLUMNS })
  const memo = new Map<string, boolean>()
  return (companyId) => {
    let on = memo.get(companyId)
    if (on === undefined) {
      const switches = remindersInForce(rows, companyId)
      on = kind === 'QUOTE' ? switches.quoteRemindersEnabled : switches.fittingRemindersEnabled
      memo.set(companyId, on)
    }
    return on
  }
}

/**
 * Thrown inside a reminder command when the company's switch is off at that moment (switched off after the job listed what
 * is due): the command rolls back, so neither the mail, nor the "reminded" mark, nor the Idempotency receipt is written.
 */
export class ReminderSwitchedOff extends Error {
  override name = 'ReminderSwitchedOff'
  constructor(readonly kind: ReminderKind) {
    super(`The ${kind === 'QUOTE' ? 'quote' : 'fitting'} reminder is switched off for this company.`)
  }
}
