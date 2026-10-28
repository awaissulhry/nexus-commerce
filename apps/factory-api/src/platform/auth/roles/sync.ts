import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandTools } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { applySystemRoleChanges, systemRoleChanges } from './system-roles'

/**
 * The system roles follow their templates without a person (feature PLT-030): every ACTIVE tenant is synced once when
 * the worker starts (a deploy that changed a template brings a new worker) and daily by the scheduler's clustered cron
 * `roles.syncTemplates` (one replica per tick). Each tenant is one command in its system context: one audit row per
 * changed role, as when an administrator syncs (`POST /auth/roles/sync-templates`). A tenant with nothing to change
 * writes nothing; a tenant that fails is logged and the others go on.
 */

export interface SyncCounts {
  readonly created: number
  readonly updated: number
}

/** The work of one sync inside an office or system command: the changes, written and audited. */
export async function syncRolesInCommand({ tx, now, audit, context }: CommandTools): Promise<SyncCounts> {
  if (context.audience !== 'office' && context.audience !== 'system') throw new Error('The system roles are synced by an administrator or the system.')
  const changes = await systemRoleChanges(tx)
  await applySystemRoleChanges(tx, changes, { now, actorId: context.actorId })
  for (const change of changes) audit({ recordType: 'Role', recordId: change.roleId, before: change.before, after: { key: change.key, change: change.kind, ...change.after } })
  // A sync that raced another one and found nothing left still records that it ran (every command is audited).
  if (changes.length === 0) audit({ recordType: 'Tenant', recordId: context.tenantId, after: { created: 0, updated: 0 } })
  return { created: changes.filter((change) => change.kind === 'created').length, updated: changes.filter((change) => change.kind !== 'created').length }
}

export interface SyncAllResult extends SyncCounts {
  /** Active tenants looked at. */
  readonly tenants: number
  /** Tenants whose roles changed. */
  readonly changed: number
  readonly failed: number
}

/** Syncs the system roles of every ACTIVE tenant. */
export async function syncAllTenants(options: { readonly database: FactoryDatabase; readonly log: Log; readonly clock?: Clock }): Promise<SyncAllResult> {
  const settings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `roles-sync-${newId()}`
  let created = 0
  let updated = 0
  let changed = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) => systemRoleChanges(client))
      if (pending.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const { result } = await runCommand(caller, { name: 'roles.syncTemplates', input: null }, syncRolesInCommand, settings)
      created += result.created
      updated += result.updated
      changed++
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, 'the system roles of a tenant could not be synced with their templates')
    }
  }
  const result = { tenants: tenants.length, changed, created, updated, failed }
  options.log.info({ ...result }, 'system roles synced with their templates')
  return result
}

/** The scheduler's daily cron (03:15 Europe/Rome). */
export function rolesSyncCron(options: { readonly database: FactoryDatabase; readonly log: Log; readonly clock?: Clock }): CronJob {
  return defineCron({
    name: 'roles.syncTemplates',
    schedule: '15 3 * * *',
    async run() {
      await syncAllTenants(options)
    },
  })
}
