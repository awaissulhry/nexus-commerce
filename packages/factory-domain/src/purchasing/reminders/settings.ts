import { AUTOMATIC_REMINDERS_DEFAULT } from '../orders/delivery'

/**
 * Where the Owner's switch for automatic PO confirmation reminders stands for a company (B-W2b-14; factory-db
 * supply.prisma PurchasingSettings, B-W2b-02): the company's own row wins, else the tenant-wide row (id = the tenant's,
 * companyId null), else OFF (AUTOMATIC_REMINDERS_DEFAULT). The database holds no sending rule: the daily run
 * (apps/factory-api modules/purchasing/reminders/daily.ts) reads this before it sends anything. Pure.
 */

export type SwitchSource = 'COMPANY' | 'TENANT' | 'DEFAULT'

export interface SwitchRow {
  readonly companyId: string | null
  readonly confirmationRemindersEnabled: boolean
}

export interface EffectiveSwitch {
  readonly on: boolean
  readonly source: SwitchSource
}

/** The switch of one company from its own row and the tenant's. */
export function effectiveSwitch(company: SwitchRow | null, tenant: SwitchRow | null): EffectiveSwitch {
  if (company) return { on: company.confirmationRemindersEnabled, source: 'COMPANY' }
  if (tenant) return { on: tenant.confirmationRemindersEnabled, source: 'TENANT' }
  return { on: AUTOMATIC_REMINDERS_DEFAULT, source: 'DEFAULT' }
}

/** The switch per company from every row of the tenant (the daily run reads them once per tenant). */
export function switchOf(rows: readonly SwitchRow[]): (companyId: string) => boolean {
  const tenant = rows.find((row) => row.companyId === null) ?? null
  const byCompany = new Map(rows.filter((row) => row.companyId !== null).map((row) => [row.companyId!, row]))
  return (companyId) => effectiveSwitch(byCompany.get(companyId) ?? null, tenant).on
}

/** The switch in words (English: the API's; the screens word it from `on` and `source`). */
export function switchWords(state: EffectiveSwitch): string {
  if (state.on) return state.source === 'TENANT' ? 'On for every company (the tenant-wide setting): the daily run reminds suppliers that have not confirmed.' : 'On: the daily run reminds suppliers that have not confirmed.'
  return state.source === 'DEFAULT' ? 'Off (never switched on): the daily run sends no reminder; the buyer reminds by hand.' : 'Off: the daily run sends no reminder; the buyer reminds by hand.'
}
