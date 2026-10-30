import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { REASON_LISTS, type ReasonList } from '@nexus/factory-domain/reasons/lists'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { activeTenants, asSystem, systemContext } from '../outbox/system'
import { addStandardInCommand } from './reasons'
import { storeOf } from './sources'

/**
 * A new tenant's reason lists (B-W2a-18; the W1 leftover "reasons for new tenants are not seeded"): every ACTIVE tenant
 * whose list has NO reason at all gets that list's standard reasons (factory-domain reasons/standard), in its system
 * context, as one command per tenant (an audit row per reason added, one `reason.changed` per list). A list with any
 * reason — even all set inactive — is the tenant's own and is never touched; a person adds the missing standard codes
 * from the editor ("Add the standard reasons"). Runs when the worker starts and daily (the scheduler's clustered cron
 * `reasons.standardForNewTenants`); a tenant that fails is logged and the others go on.
 */

export interface StandardForTenantsResult {
  readonly tenants: number
  /** Tenants that had an empty list. */
  readonly seeded: number
  /** Reasons added over all tenants. */
  readonly added: number
  readonly failed: number
}

async function emptyLists(client: Prisma.TransactionClient): Promise<ReasonList[]> {
  const empty: ReasonList[] = []
  for (const list of REASON_LISTS) if ((await storeOf(list).rows(client, [list])).length === 0) empty.push(list)
  return empty
}

export async function standardReasonsForNewTenants(options: { readonly database: FactoryDatabase; readonly log: Log; readonly clock?: Clock }): Promise<StandardForTenantsResult> {
  const settings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `reasons-standard-${newId()}`
  let seeded = 0
  let added = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) => emptyLists(client))
      if (pending.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const { result } = await runCommand(
        caller,
        { name: 'reasons.addStandard', input: { lists: pending } },
        async (tools) => {
          let count = 0
          // Inside the transaction again: only a list still empty gets the standard reasons.
          for (const list of await emptyLists(tools.tx)) count += (await addStandardInCommand(tools, list)).length
          if (count === 0) tools.audit({ recordType: 'Tenant', recordId: tenantId, companyId: null, after: { added: 0 } })
          return count
        },
        settings,
      )
      added += result
      seeded++
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "a tenant's empty reason lists could not be given their standard reasons")
    }
  }
  const result = { tenants: tenants.length, seeded, added, failed }
  options.log.info({ ...result }, 'standard reasons given to empty reason lists')
  return result
}

/** The scheduler's daily cron (03:25 Europe/Rome, after the roles sync). */
export function standardReasonsCron(options: { readonly database: FactoryDatabase; readonly log: Log; readonly clock?: Clock }): CronJob {
  return defineCron({
    name: 'reasons.standardForNewTenants',
    schedule: '25 3 * * *',
    async run() {
      await standardReasonsForNewTenants(options)
    },
  })
}
