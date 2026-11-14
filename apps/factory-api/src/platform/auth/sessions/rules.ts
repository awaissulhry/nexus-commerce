import type { FactoryClient } from '@nexus/factory-db'
import { securityRulesOf, type SecurityRules } from '@nexus/factory-domain/auth/sessions/lengths'
import type { CommandTx } from '../../../core/command'

/**
 * The tenant's security rules (B-W2b-404; PLT-068, PLT-063): its SecuritySettings row (id = the tenant's id), or the defaults
 * of factory-domain auth/sessions/lengths without one, and the row's version (0: no row yet). Read on every office and
 * portal request (one primary-key read) by the authenticators, so a shorter session or a switched step-up applies at the
 * next request.
 */

const SETTINGS_SELECT = {
  officeIdleMinutes: true,
  officeLongestHours: true,
  portalIdleMinutes: true,
  portalLongestHours: true,
  stepUpOff: true,
  stepUpMaxFailures: true,
  stepUpLockMinutes: true,
  version: true,
} as const

export async function securityRulesIn(
  client: Pick<FactoryClient, 'securitySettings'> | Pick<CommandTx, 'securitySettings'>,
  tenantId: string,
): Promise<{ readonly rules: SecurityRules; readonly version: number }> {
  const row = await (client as Pick<FactoryClient, 'securitySettings'>).securitySettings.findUnique({ where: { id: tenantId }, select: SETTINGS_SELECT })
  return { rules: securityRulesOf(row), version: row?.version ?? 0 }
}
