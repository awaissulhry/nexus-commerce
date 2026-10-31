import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { PURCHASING_REMINDERS_SWITCH } from '@nexus/factory-domain/purchasing/reminders/permissions'
import { effectiveSwitch, switchWords } from '@nexus/factory-domain/purchasing/reminders/settings'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'

/**
 * The Owner's per-company switch for automatic PO confirmation reminders (B-W2b-14; B-W2a-52's follow-up Z1:09; W2b plan
 * §3 "Owner switch": mail to real suppliers, OFF by default, turned on after GATE-GOLIVE; factory-db supply.prisma
 * PurchasingSettings, B-W2b-02: id = the company's id, or the tenant's for the tenant-wide row).
 *
 *   GET /purchasing/reminders/settings?companyId      purchasing.view: the company's row, the tenant row, which holds,
 *                                                       whether the daily run reminds its suppliers, in words
 *   PUT /purchasing/reminders/settings/switch          purchasing.reminders.switch (the owner's; switching ON also asks a
 *        {companyId | null, on, version?}               fresh step-up, OFF never): ONE command on the row FOR UPDATE at
 *                                                       the version read; a company's first change makes its own row
 * The daily run (./daily.ts) and the reminders card and due list read the same rule (factory-domain
 * purchasing/reminders/settings effectiveSwitch). `purchasing_settings.changed` tells the screens.
 */

const COLUMNS = { id: true, companyId: true, confirmationRemindersEnabled: true, version: true, updatedAt: true } as const satisfies Prisma.PurchasingSettingsSelect
type SettingsRow = Prisma.PurchasingSettingsGetPayload<{ select: typeof COLUMNS }>

const viewOf = (row: SettingsRow | null) => (row ? { id: row.id, companyId: row.companyId, confirmationRemindersEnabled: row.confirmationRemindersEnabled, version: row.version, updatedAt: toUtcIso(row.updatedAt) } : null)

const tenantOf = (context: OfficeContext): string => context.tenantId

/** A role over every company (the tenant-wide row's). */
const everyCompany = (context: OfficeContext, permission: Permission): boolean => grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')

const mayAt = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => (companyId === null ? everyCompany(context, permission) : can(actorOf(context), permission, { companyId }))

/** The company's row and the tenant's (the rows are the tenant's: row-level security by tenant). */
export async function settingsRowsOf(db: Reader, tenantId: string, companyId: string | null): Promise<{ company: SettingsRow | null; tenant: SettingsRow | null }> {
  const company = companyId === null ? null : await db.purchasingSettings.findUnique({ where: { id: companyId }, select: COLUMNS })
  const tenant = await db.purchasingSettings.findUnique({ where: { id: tenantId }, select: COLUMNS })
  return { company: company && company.companyId === companyId ? company : null, tenant: tenant && tenant.companyId === null ? tenant : null }
}

/** Is the switch on for a company (the reminders card, the due list): its row, else the tenant's, else OFF. */
export async function remindersOn(db: Reader, tenantId: string, companyId: string): Promise<boolean> {
  const rows = await settingsRowsOf(db, tenantId, companyId)
  return effectiveSwitch(rows.company, rows.tenant).on
}

/** GET /purchasing/reminders/settings (purchasing.view). */
export async function getReminderSettings(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const companyId = query.companyId ?? null
  if (companyId !== null && !can(actorOf(context), PURCHASING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    if (companyId !== null && !(await client.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const rows = await settingsRowsOf(client, tenantOf(context), companyId)
    const state = companyId === null ? effectiveSwitch(rows.tenant, null) : effectiveSwitch(rows.company, rows.tenant)
    const source = companyId === null && state.source === 'COMPANY' ? 'TENANT' : state.source
    return { companyId, source, on: state.on, words: switchWords({ on: state.on, source }), mayChange: mayAt(context, PURCHASING_REMINDERS_SWITCH, companyId), company: viewOf(rows.company), tenant: viewOf(rows.tenant) }
  })
}

/** The row a switch writes, locked: the company's own (made from the tenant's value on its first change), or the tenant's. */
async function rowToChange(tools: CommandTools, context: OfficeContext, companyId: string | null, version: number | undefined): Promise<SettingsRow> {
  const { tx, now } = tools
  const id = companyId ?? tenantOf(context)
  if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  await tx.$queryRaw`SELECT id FROM "PurchasingSettings" WHERE id = ${id}::uuid FOR UPDATE`
  const existing = await tx.purchasingSettings.findUnique({ where: { id }, select: COLUMNS })
  if (existing) {
    if (version === undefined || version !== existing.version) {
      throw new DomainError('conflict', `These settings changed since they were read; they are now at version ${existing.version}. Reload them and switch again.`, [{ path: 'body/version', message: `The current version is ${existing.version}.` }])
    }
    return existing
  }
  if (version !== undefined) throw new DomainError('conflict', 'These settings do not exist yet: send no version to make them.', [{ path: 'body/version', message: 'Leave it out for new settings.' }])
  const tenant = companyId !== null ? await tx.purchasingSettings.findUnique({ where: { id: tenantOf(context) }, select: COLUMNS }) : null
  const created = await tx.purchasingSettings.create({
    data: { id, companyId, confirmationRemindersEnabled: tenant?.confirmationRemindersEnabled ?? false, createdAt: now, updatedAt: now, createdById: context.actorId },
    select: COLUMNS,
  })
  tools.audit({ action: 'purchasing.reminderSettingsCreate', recordType: 'PurchasingSettings', recordId: id, companyId, after: { from: tenant ? 'TENANT' : 'DEFAULT', confirmationRemindersEnabled: created.confirmationRemindersEnabled } })
  return created
}

/** PUT /purchasing/reminders/settings/switch (purchasing.reminders.switch; ON also a fresh step-up). */
export async function putReminderSwitch(caller: CommandCaller, body: { readonly companyId: string | null; readonly on: boolean; readonly version?: number | undefined }, stepUp: () => void, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (!mayAt(context, PURCHASING_REMINDERS_SWITCH, body.companyId)) {
    throw new ForbiddenError(body.companyId === null ? 'The reminders of every company are switched only by a role over every company.' : 'Only the owner switches automatic reminders to suppliers on or off.')
  }
  if (body.on) stepUp()
  await command(caller, { name: 'purchasing.remindersSwitch', idempotencyKey, input: body }, async (tools) => {
    const row = await rowToChange(tools, context, body.companyId, body.version)
    if (row.confirmationRemindersEnabled === body.on) {
      tools.audit({ action: 'purchasing.remindersSwitch', recordType: 'PurchasingSettings', recordId: row.id, companyId: row.companyId, after: { confirmationRemindersEnabled: row.confirmationRemindersEnabled, unchanged: true } })
      return { id: row.id }
    }
    const after = await tools.tx.purchasingSettings.update({ where: { id: row.id }, data: { confirmationRemindersEnabled: body.on, version: row.version + 1, updatedAt: tools.now }, select: COLUMNS })
    tools.audit({ action: 'purchasing.remindersSwitch', recordType: 'PurchasingSettings', recordId: row.id, companyId: row.companyId, before: { confirmationRemindersEnabled: row.confirmationRemindersEnabled }, after: { confirmationRemindersEnabled: after.confirmationRemindersEnabled } })
    tools.emit({ type: 'purchasing_settings.changed', subject: row.id, companyId: row.companyId, payload: { settingsId: row.id, companyId: row.companyId, confirmationRemindersEnabled: after.confirmationRemindersEnabled } })
    return { id: row.id }
  })
  return getReminderSettings(caller, { companyId: body.companyId ?? undefined })
}
