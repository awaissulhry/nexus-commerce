import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { TWO_FACTOR_ACTION } from '@nexus/factory-domain/ops/two-factor'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandTools, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'

/**
 * "Two-factor since" for the roles that asked before the time was kept (B-W2b-24; B-W2b-03 added Role.requireMfaSince,
 * kept by the database from then on). A role that asks with no time gives no grace to the sessions open when it was
 * switched on (sessions/grants.ts), so its time is filled ONCE (the trigger allows it while it is null) from its own
 * audit rows: the latest row that switched it on — the Security command (`security.setRoleTwoFactor`, after.requireMfa
 * true), a custom role's edit from off to on (`roles.edit`), its making with two-factor (`roles.create`) or the template
 * sync that made or raised it (`roles.syncTemplates`). A role with no such row keeps null (it asked from before the audit
 * log reaches: no grace, as before W2b). One system command per tenant, only when a role can be filled (an idle pass
 * writes nothing). Runs when the worker starts (a deploy) and daily (`roles.twoFactorSince`, 03:20 Europe/Rome).
 */

const SWITCH_ACTIONS = [TWO_FACTOR_ACTION, 'roles.edit', 'roles.create', 'roles.syncTemplates'] as const

type Reader = FactoryClient | CommandTx

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The audit row that switched a role's two-factor on, newest first: after.requireMfa true and before not true. */
export function switchedOnAt(rows: readonly { readonly at: Date; readonly action: string; readonly before: unknown; readonly after: unknown }[]): Date | null {
  let found: Date | null = null
  for (const row of rows) {
    if (!(SWITCH_ACTIONS as readonly string[]).includes(row.action)) continue
    if (objectOf(row.after).requireMfa !== true || objectOf(row.before).requireMfa === true) continue
    if (!found || row.at > found) found = row.at
  }
  return found
}

/** The roles that ask without a time and the time their audit rows give (only those an audit row answers). */
export async function sinceToFill(db: Reader): Promise<{ readonly roleId: string; readonly since: Date }[]> {
  const roles = await db.role.findMany({ where: { requireMfa: true, requireMfaSince: null }, select: { id: true }, take: 500 })
  if (roles.length === 0) return []
  const rows = await db.auditLog.findMany({
    where: { recordType: 'Role', recordId: { in: roles.map((role) => role.id) }, action: { in: [...SWITCH_ACTIONS] } },
    select: { recordId: true, at: true, action: true, before: true, after: true },
  })
  const out: { roleId: string; since: Date }[] = []
  for (const role of roles) {
    const since = switchedOnAt(rows.filter((row) => row.recordId === role.id))
    if (since) out.push({ roleId: role.id, since })
  }
  return out
}

/** The work inside the tenant's system command: fills each role read again (still asking, still without a time). */
export async function fillTwoFactorSince({ tx, audit, context }: CommandTools): Promise<number> {
  if (context.audience !== 'system') throw new Error('This catch-up runs as the system, one tenant at a time.')
  let filled = 0
  for (const { roleId, since } of await sinceToFill(tx)) {
    const { count } = await tx.role.updateMany({ where: { id: roleId, requireMfa: true, requireMfaSince: null }, data: { requireMfaSince: since } })
    if (count !== 1) continue
    filled++
    audit({ action: 'roles.twoFactorSince', recordType: 'Role', recordId: roleId, before: { requireMfaSince: null }, after: { requireMfaSince: toUtcIso(since), from: 'audit' } })
  }
  if (filled === 0) audit({ action: 'roles.twoFactorSince', recordType: 'Tenant', recordId: context.tenantId, after: { filled: 0 } })
  return filled
}

export interface CatchUpOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** Every ACTIVE tenant: a read first, a command only when a role can be filled. */
export async function fillTwoFactorSinceAll(options: CatchUpOptions): Promise<{ readonly tenants: number; readonly filled: number; readonly failed: number }> {
  const settings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `roles-two-factor-since-${newId()}`
  let filled = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) => sinceToFill(client))
      if (pending.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const { result } = await runCommand(caller, { name: 'roles.twoFactorSince', input: null }, fillTwoFactorSince, settings)
      filled += result
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "the two-factor times of a tenant's roles could not be filled")
    }
  }
  if (filled > 0 || failed > 0) options.log.info({ tenants: tenants.length, filled, failed }, 'two-factor times filled from the audit log')
  return { tenants: tenants.length, filled, failed }
}

/** The scheduler's daily cron (03:20 Europe/Rome; the worker's start does it after a deploy). */
export function twoFactorSinceCron(options: CatchUpOptions): CronJob {
  return defineCron({
    name: 'roles.twoFactorSince',
    schedule: '20 3 * * *',
    async run() {
      await fillTwoFactorSinceAll(options)
    },
  })
}
