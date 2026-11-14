import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { callerFor } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { COMPANY_SELECT } from '../store'
import { runCompanyChecks } from './run'

/**
 * The nightly integrity checks (B-W2b-408; FIN-157; plan §10: "run nightly and keep the results; the export reads the last
 * run"): cron `accounting.integrityNightly`, every day at 04:10 Europe/Rome (after the cost ledger's catch-up at 03:20),
 * through the clustered scheduler only (one replica runs a tick). Per active tenant, in its SYSTEM context, every active
 * company's checks run (integrity/run.ts) with the key `integrity-nightly:<tick>:<company>` (a tick run twice keeps one
 * run). A company whose run fails is logged and left for the next night; nothing is sent to anyone.
 */

export interface IntegrityJobOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

export interface NightlyRun {
  readonly tenants: number
  readonly companies: number
  readonly failing: number
  readonly flagged: number
  readonly failed: number
}

/** One pass over every active tenant's active companies (the cron's tick; tests call it directly). */
export async function runNightlyIntegrity(options: IntegrityJobOptions, tick: Date = new Date()): Promise<NightlyRun> {
  const requestId = `integrity-nightly-${newId()}`
  const totals = { companies: 0, failing: 0, flagged: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const companies = await caller.withClient((client) => (client as FactoryClient).company.findMany({ where: { status: 'ACTIVE' }, select: COMPANY_SELECT, orderBy: { code: 'asc' } }))
    for (const company of companies) {
      totals.companies += 1
      try {
        const run = await runCompanyChecks(caller, company, null, `integrity-nightly:${tick.getTime()}:${company.id}`)
        totals.failing += run.outcomes.filter((outcome) => outcome.result !== 'PASSED').length
        totals.flagged += run.flagged
      } catch (error) {
        totals.failed += 1
        options.log.error({ err: error, tenantId, companyId: company.id }, 'the integrity checks could not run for a company')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  options.log.info({ ...run }, 'integrity checks')
  return run
}

/** The scheduler's cron: every day at 04:10 (Europe/Rome). */
export function integrityNightlyCron(options: IntegrityJobOptions): CronJob {
  return defineCron({
    name: 'accounting.integrityNightly',
    schedule: '10 4 * * *',
    async run({ scheduledAt }) {
      await runNightlyIntegrity(options, scheduledAt)
    },
  })
}
