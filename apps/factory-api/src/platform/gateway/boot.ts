import type { FactoryDatabase } from '@nexus/factory-db'
import type { FactoryEnv } from '../../env'
import { asSystem } from '../outbox/system'

/**
 * The boot rule of plan A1 §4 "Fakes in production": the API (and the worker and scheduler) refuse to start when
 * FACTORY_ENV=production and any IntegrationAccount, of any tenant, is in FAKE mode. A fake answers without reaching the
 * provider, so in production it would issue invoices that SDI never received and labels no carrier knows. The gateway
 * refuses a FAKE call in production as well (gateway.ts), so an account switched to FAKE after the boot still sends
 * nothing.
 *
 * Call it at boot, after openFactoryDatabase and before the app or the background process starts:
 *   src/index.ts       after `database = await openFactoryDatabase(…)`, inside the same try (a refusal exits 1)
 *   src/background.ts  after its openFactoryDatabase, through refuse()
 * Other environments: it reads nothing and returns at once.
 */

export class FakeAccountsInProductionError extends Error {
  override name = 'FakeAccountsInProductionError'
  constructor(readonly accounts: readonly FakeAccount[]) {
    super(
      `${accounts.length} integration account(s) are in FAKE mode with FACTORY_ENV=production ` +
        `(${accounts.map((account) => `${account.provider} ${account.code}`).join(', ')}); switch them to LIVE or SANDBOX, or disable them, before production starts.`,
    )
  }
}

export interface FakeAccount {
  readonly tenantId: string
  readonly id: string
  readonly code: string
  readonly provider: string
}

/** Every account in FAKE mode, of every tenant (each read in its tenant's system scope; RLS stays forced). */
export async function fakeAccounts(database: FactoryDatabase): Promise<FakeAccount[]> {
  const tenants = await database.withScope({ audience: 'platform' }, (client) => client.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))
  const found: FakeAccount[] = []
  for (const { id: tenantId } of tenants) {
    const rows = await asSystem(database, tenantId, 'boot.fake-accounts', (client) =>
      client.integrationAccount.findMany({ where: { mode: 'FAKE' }, select: { id: true, code: true, provider: true }, orderBy: { code: 'asc' } }),
    )
    found.push(...rows.map((row) => ({ tenantId, ...row })))
  }
  return found
}

/** Throws FakeAccountsInProductionError in production while any account is FAKE; does nothing elsewhere. */
export async function assertNoFakeAccountsInProduction(database: FactoryDatabase, environment: FactoryEnv['FACTORY_ENV']): Promise<void> {
  if (environment !== 'production') return
  const found = await fakeAccounts(database)
  if (found.length > 0) throw new FakeAccountsInProductionError(found)
}
