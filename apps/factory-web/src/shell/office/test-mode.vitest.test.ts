import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE } from '../../lib/i18n/messages'
import { permissionCheck } from '../../lib/session/session'
import { designScreen } from './fixtures'
import { NO_TEST_MODES, TEST_MODE_EVENTS, testModeBanner, testModeRights, type TestModeNotices } from './test-mode'

/** B-W2b-437: the shell's TEST MODE banner (made-up companies and sites). B-W2b-F49: for every office person. */
const notices: TestModeNotices = {
  carrierSites: [
    { siteId: 's1', name: 'Plant A' },
    { siteId: 's2', name: 'Plant C' },
  ],
  eInvoicingCompanies: [{ companyId: 'c1', name: 'Company One' }],
}
const rightsOf = (role: string) => testModeRights(permissionCheck(templateOf(role)!.permissions))
const all = { carrierPage: true, eInvoicingPage: true }

describe('the TEST MODE banner (shell/office/test-mode.ts)', () => {
  it('names the sites whose carrier and the companies whose e-invoicing GET /shell/notices says are in test mode', () => {
    expect(testModeBanner({ notices, rights: all })).toEqual({
      id: 'test-mode',
      kind: 'test-mode',
      carrierSites: ['Plant A', 'Plant C'],
      eInvoicingCompanies: ['Company One'],
      links: { carrier: true, eInvoicing: true },
    })
    // Only the carrier, or only e-invoicing: one line.
    expect(testModeBanner({ notices: { ...notices, eInvoicingCompanies: [] }, rights: all })).toMatchObject({ carrierSites: ['Plant A', 'Plant C'], eInvoicingCompanies: [] })
    expect(testModeBanner({ notices: { ...notices, carrierSites: [] }, rights: all })).toMatchObject({ carrierSites: [], eInvoicingCompanies: ['Company One'] })
  })

  it('no band at all while everything is live', () => {
    expect(testModeBanner({ notices: NO_TEST_MODES, rights: all })).toBeNull()
  })

  it('every office person sees the band (B-W2b-F49); a line links its page only for a person who may open it', () => {
    expect(rightsOf('owner')).toEqual(all)
    // Admin, buyer and floor supervisor read neither test mode (no shipping.view, no invoices.view) and see both lines.
    for (const role of ['admin', 'buyer', 'floor_supervisor']) {
      expect(templateOf(role)!.permissions, role).not.toContain('shipping.view')
      expect(templateOf(role)!.permissions, role).not.toContain('invoices.view')
      expect(testModeBanner({ notices, rights: rightsOf(role) }), role).toMatchObject({ carrierSites: ['Plant A', 'Plant C'], eInvoicingCompanies: ['Company One'] })
    }
    // The admin may open Carriers & shipping (shipping.settings.view: it switches the carrier), not Finance settings.
    expect(rightsOf('admin')).toEqual({ carrierPage: true, eInvoicingPage: false })
    // A buyer and a floor supervisor open neither page: both lines without links.
    for (const role of ['buyer', 'floor_supervisor']) expect(testModeBanner({ notices, rights: rightsOf(role) })?.links, role).toEqual({ carrier: false, eInvoicing: false })
    // Warehouse: Carriers & shipping only; sales and finance: Finance settings only.
    expect(rightsOf('warehouse')).toEqual({ carrierPage: true, eInvoicingPage: false })
    for (const role of ['sales', 'finance']) expect(rightsOf(role), role).toEqual({ carrierPage: false, eInvoicingPage: true })
  })

  it('SCR-003 holds the admin case: the band, with only the link the admin template opens', () => {
    const adminCase = designScreen.cases.find((entry) => entry.id === 'test-mode-admin')
    expect(adminCase?.model.banners).toEqual([{ id: 'test-mode', kind: 'test-mode', carrierSites: [expect.any(String)], eInvoicingCompanies: [expect.any(String)], links: { carrier: true, eInvoicing: false } }])
  })

  it('is read again on the two test-mode events, and says itself in both languages', () => {
    expect(TEST_MODE_EVENTS).toEqual(['shipping.test_mode_changed', 'e_invoicing.settings_changed'])
    for (const locale of LOCALES) {
      const shell = CATALOGUE[locale].shell ?? {}
      expect(Object.keys(shell).filter((key) => key.startsWith('banner.')).sort(), locale).toEqual(['banner.testMode.carrier', 'banner.testMode.eInvoicing', 'banner.testMode.title'])
      expect(shell['banner.testMode.carrier'], locale).toContain('{sites}')
      expect(shell['banner.testMode.eInvoicing'], locale).toContain('{companies}')
    }
  })
})
