import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { LOCALES } from '../../lib/i18n/locales'
import { CATALOGUE } from '../../lib/i18n/messages'
import { permissionCheck } from '../../lib/session/session'
import { TEST_MODE_EVENTS, testModeBanner, testModeRights, type CarrierSiteMode, type CompanyEInvoicingMode } from './test-mode'

/** B-W2b-437: the shell's TEST MODE banner (made-up companies and sites). */
const C1 = 'c1'
const C2 = 'c2'
const sites: CarrierSiteMode[] = [
  { companyId: C1, name: 'Plant A', testMode: true },
  { companyId: C1, name: 'Plant B', testMode: false },
  { companyId: C2, name: 'Plant C', testMode: true },
]
const companies: CompanyEInvoicingMode[] = [
  { companyId: C1, legalName: 'Company One', state: { code: 'TEST' } },
  { companyId: C2, legalName: 'Company Two', state: { code: 'LIVE' } },
]
const rightsOf = (role: string) => testModeRights(permissionCheck(templateOf(role)!.permissions))
const all = { carrier: true, eInvoicing: true, carrierPage: true, eInvoicingPage: true }

describe('the TEST MODE banner (shell/office/test-mode.ts)', () => {
  it('names the sites of this company whose carrier is in test mode and its e-invoicing in test mode', () => {
    expect(testModeBanner({ carrier: sites, eInvoicing: companies, companyId: C1, rights: all })).toEqual({
      id: 'test-mode',
      kind: 'test-mode',
      carrierSites: ['Plant A'],
      eInvoicingCompanies: ['Company One'],
      links: { carrier: true, eInvoicing: true },
    })
    // Another company: its own site only; its e-invoicing is live.
    expect(testModeBanner({ carrier: sites, eInvoicing: companies, companyId: C2, rights: all })).toMatchObject({ carrierSites: ['Plant C'], eInvoicingCompanies: [] })
    // No company chosen yet (a tenant of several companies): every company the person sees.
    expect(testModeBanner({ carrier: sites, eInvoicing: companies, companyId: null, rights: all })).toMatchObject({ carrierSites: ['Plant A', 'Plant C'], eInvoicingCompanies: ['Company One'] })
  })

  it('no band at all while everything is live', () => {
    const live = { carrier: sites.map((site) => ({ ...site, testMode: false })), eInvoicing: companies.map((company) => ({ ...company, state: { code: 'LIVE' as const } })) }
    expect(testModeBanner({ ...live, companyId: C1, rights: all })).toBeNull()
  })

  it('each part only for a person who may read it; a line links its page only for a person who may open it', () => {
    expect(rightsOf('owner')).toEqual(all)
    // Warehouse: the carrier with Carriers & shipping, no e-invoicing (no invoices.view).
    expect(rightsOf('warehouse')).toEqual({ carrier: true, eInvoicing: false, carrierPage: true, eInvoicingPage: false })
    expect(testModeBanner({ carrier: sites, eInvoicing: companies, companyId: C1, rights: rightsOf('warehouse') })).toMatchObject({ carrierSites: ['Plant A'], eInvoicingCompanies: [] })
    // Sales and finance read both, but may not open Carriers & shipping (shipping.settings.view).
    for (const role of ['sales', 'finance']) expect(rightsOf(role), role).toEqual({ carrier: true, eInvoicing: true, carrierPage: false, eInvoicingPage: true })
    // A buyer reads neither: no banner.
    expect(testModeBanner({ carrier: sites, eInvoicing: companies, companyId: C1, rights: rightsOf('buyer') })).toBeNull()
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
