import type { SystemBanner } from './view/OfficeShellView'

/**
 * B-W2b-437 (design shell.frame sec:system-banners "TEST MODE: 'SDI and the carrier are in test mode. Nothing reaches a real
 * customer.'"; LOG-035 "the shell shows TEST MODE while it is on"; Owner rule W2b-6 "a test mode shows a banner on every page
 * while it is on"): the shell's TEST MODE banner from the two test modes W2b-6 ships — the carrier's per site (B-W2b-390,
 * `GET /shipping/test-mode`, shipping.view) and e-invoicing's per company (B-W2b-401, `GET /invoicing/e-invoicing/settings`,
 * invoices.view). Each part only for a person who may read it; both narrowed to the company the person works in. Pure, so the
 * tests hold it.
 */

/** The live events after which the banner is read again. */
export const TEST_MODE_EVENTS: readonly string[] = ['shipping.test_mode_changed', 'e_invoicing.settings_changed']

/** What the shell may read and open: each test mode's read right, and the page where it is switched. */
export interface TestModeRights {
  carrier: boolean
  eInvoicing: boolean
  carrierPage: boolean
  eInvoicingPage: boolean
}

export const testModeRights = (has: (permission: string) => boolean): TestModeRights => ({
  carrier: has('shipping.view'),
  eInvoicing: has('invoices.view'),
  // Warehouse › Carriers & shipping (its row asks shipping.settings.view); Finance › Finance settings (invoices.view).
  carrierPage: has('shipping.settings.view'),
  eInvoicingPage: has('invoices.view'),
})

export interface CarrierSiteMode {
  companyId: string
  name: string
  testMode: boolean
}

export interface CompanyEInvoicingMode {
  companyId: string
  legalName: string
  state: { code: 'TEST' | 'LIVE' }
}

/** The banner (null: nothing in test mode, or nothing the person may read — no band at all). */
export function testModeBanner(input: { carrier: readonly CarrierSiteMode[]; eInvoicing: readonly CompanyEInvoicingMode[]; companyId: string | null; rights: TestModeRights }): SystemBanner | null {
  const mine = <T extends { companyId: string }>(rows: readonly T[]) => (input.companyId ? rows.filter((row) => row.companyId === input.companyId) : rows)
  const carrierSites = input.rights.carrier ? mine(input.carrier).filter((site) => site.testMode).map((site) => site.name) : []
  const eInvoicingCompanies = input.rights.eInvoicing ? mine(input.eInvoicing).filter((company) => company.state.code === 'TEST').map((company) => company.legalName) : []
  if (carrierSites.length === 0 && eInvoicingCompanies.length === 0) return null
  return { id: 'test-mode', kind: 'test-mode', carrierSites, eInvoicingCompanies, links: { carrier: input.rights.carrierPage, eInvoicing: input.rights.eInvoicingPage } }
}
