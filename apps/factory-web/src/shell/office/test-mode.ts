import type { SystemBanner } from './view/OfficeShellView'

/**
 * B-W2b-437 (design shell.frame sec:system-banners "TEST MODE: 'SDI and the carrier are in test mode. Nothing reaches a real
 * customer.'"; LOG-035 "the shell shows TEST MODE while it is on"; Owner rule W2b-6 "a test mode shows a banner on every page
 * while it is on"): the shell's TEST MODE banner from the two test modes W2b-6 ships — the carrier's per site (B-W2b-390) and
 * e-invoicing's per company (B-W2b-401). Pure, so the tests hold it.
 * B-W2b-F49: for EVERY office person (not only who may read shipping or invoices: an admin, a buyer, a floor supervisor too),
 * from ONE read every signed-in office person may call, `GET /shell/notices?companyId` (apps/factory-api platform/shell: the
 * sites and companies the person works in, narrowed to this company, names only). Only the links stay held by rights.
 */

/** The live events after which the banner is read again (a person who may not read a test mode gets neither: page load and reconnect). */
export const TEST_MODE_EVENTS: readonly string[] = ['shipping.test_mode_changed', 'e_invoicing.settings_changed']

/** Which page where a test mode is switched the person may open. */
export interface TestModeRights {
  carrierPage: boolean
  eInvoicingPage: boolean
}

export const testModeRights = (has: (permission: string) => boolean): TestModeRights => ({
  // Warehouse › Carriers & shipping (its row asks shipping.settings.view); Finance › Finance settings (invoices.view).
  carrierPage: has('shipping.settings.view'),
  eInvoicingPage: has('invoices.view'),
})

/** B-W2b-F49: what `GET /shell/notices` says is in test mode (a site or company is listed while its test mode is on). */
export interface TestModeNotices {
  carrierSites: readonly { siteId: string; name: string }[]
  eInvoicingCompanies: readonly { companyId: string; name: string }[]
  /**
   * B-W2b-F58: the Owner's local test server hides the top bar (FACTORY_HIDE_TEST_MODE_BANNER, local only; the Owner's answer
   * A of 11-15). The test modes stay on and every other TEST word stays; absent or false everywhere else.
   */
  bannerHidden?: boolean
}

export const NO_TEST_MODES: TestModeNotices = Object.freeze({ carrierSites: [], eInvoicingCompanies: [], bannerHidden: false })

/** The banner (null: nothing in test mode where the person works, or the local test server hides it — no band at all). */
export function testModeBanner(input: { notices: TestModeNotices; rights: TestModeRights }): SystemBanner | null {
  if (input.notices.bannerHidden) return null
  const carrierSites = input.notices.carrierSites.map((site) => site.name)
  const eInvoicingCompanies = input.notices.eInvoicingCompanies.map((company) => company.name)
  if (carrierSites.length === 0 && eInvoicingCompanies.length === 0) return null
  return { id: 'test-mode', kind: 'test-mode', carrierSites, eInvoicingCompanies, links: { carrier: input.rights.carrierPage, eInvoicing: input.rights.eInvoicingPage } }
}
