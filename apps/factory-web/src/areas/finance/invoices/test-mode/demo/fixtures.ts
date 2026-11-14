import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import { ROLES, type Role } from '../../../_demo/fixtures'
import { abilitiesOf, type FinanceAbilities } from '../../../_shared/model'
import type { CompanyEInvoicing } from '../api'

/**
 * Made-up data shared by B-W2b-417's design cases (SCR-440 … SCR-449): the permissions each role holds with this step's
 * rights (the tax set-up, the accountant's switches, test mode, the deposit rules, shipping holds, payables), and the
 * e-invoicing settings of the two invented companies ("Officina Demo S.r.l." in test mode on the FAKE intermediary,
 * "Pelletteria Esempio S.p.A." in test mode on a sandbox connection, answers simulated). Nothing here is a real company,
 * connection or number. Design-only (only fixtures import it); it exports no `designScreen`.
 */

const DEPTH_RIGHTS: Record<Role, readonly string[]> = {
  owner: ['invoices.tax.manage', 'invoices.tax.switch', 'invoices.testMode.manage', 'invoices.depositRules.manage', 'shipping.view', 'shipping.holds.manage', 'shipping.holds.release', 'payables.view', 'payables.manage'],
  finance: ['invoices.tax.manage', 'invoices.tax.switch', 'invoices.testMode.manage', 'invoices.depositRules.manage', 'shipping.view', 'shipping.holds.manage', 'shipping.holds.release', 'payables.view', 'payables.manage'],
  sales: ['shipping.view'],
}

/** A role's permissions with this step's rights. */
export const permissionsOf = (role: Role): string[] => [...ROLES[role], ...DEPTH_RIGHTS[role]]
export const financeCanOf = (role: Role): FinanceAbilities => abilitiesOf(permissionsOf(role))

export const [DEMO, ESEMPIO] = DEMO_COMPANIES
export const NOW_DAY = '2026-11-14'

const account = (n: number, mode: string) => ({ id: `0190f0e2-9191-7000-8000-${String(n).padStart(12, '0')}`, label: mode === 'FAKE' ? 'SDI (FAKE)' : 'SDI sandbox', mode, status: 'ACTIVE' })

export const TESTING_FAKE: CompanyEInvoicing = {
  companyId: DEMO.id,
  code: DEMO.code,
  legalName: DEMO.name,
  version: 3,
  testMode: true,
  liveSince: null,
  simulateOutcome: 'DELIVERED',
  state: { code: 'TEST', banner: 'E-invoice test mode — nothing goes to SDI', simulated: false },
  connection: { state: 'ACTIVE', accounts: [account(1, 'FAKE')] },
  goLive: { allowed: true, problems: [] },
  testSent: 4,
  simulateOptions: [{ outcome: 'DELIVERED' }, { outcome: 'REJECTED' }, { outcome: 'NOT_DELIVERABLE' }],
  rules: { selfInvoicesOn: false },
  can: { manage: true, switchRules: true },
}

export const TESTING_SIMULATED: CompanyEInvoicing = {
  ...TESTING_FAKE,
  companyId: ESEMPIO.id,
  code: ESEMPIO.code,
  legalName: ESEMPIO.name,
  simulateOutcome: 'REJECTED',
  state: { code: 'TEST', banner: 'E-invoice test mode — nothing goes to SDI', simulated: true },
  connection: { state: 'ACTIVE', accounts: [account(2, 'SANDBOX')] },
  goLive: { allowed: false, problems: [{ code: 'PROVIDER_NOT_CHOSEN' }] },
  testSent: 1,
}

export const LIVE: CompanyEInvoicing = { ...TESTING_FAKE, testMode: false, liveSince: '2026-11-09T08:00:00.000Z', state: { code: 'LIVE', banner: null, simulated: false }, goLive: { allowed: false, problems: [{ code: 'ALREADY_LIVE' }] }, testSent: 0 }
