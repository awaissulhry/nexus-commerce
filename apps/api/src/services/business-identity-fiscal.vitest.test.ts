import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * MCP full control 07 (lead review, step 0) — the daily corrispettivi XML and the CN22/CN23 customs declaration carry
 * the business's own identity, as the buyer-facing outputs do since O3 (business-identity.service).
 *
 *   1. Xavia (the legacy business): its ONE company identity — Settings › Company first, NEXUS_ISSUER_* as the
 *      fallback (lead review, 2026-10-01) — and never a code placeholder; without what a document prints, refused.
 *      FatturaPA, which needs a structured address the settings do not hold, reads NEXUS_ISSUER_* only, and is
 *      refused when one of them is missing (it printed 'Via Esempio 1' / 'IT00000000000' before).
 *   2. A second business with its identity: its own P.IVA, codice fiscale, name and address; never Xavia's.
 *   3. A second business without one (or without a P.IVA): refused; nothing is generated as Xavia.
 *
 * The database is mocked: the test reads what would be generated.
 */
const h = vi.hoisted(() => ({
  brand: null as Record<string, unknown> | null,
  orders: [] as unknown[],
  shipment: null as Record<string, unknown> | null,
}))

vi.mock('../db.js', () => ({
  default: {
    brandSettings: { findFirst: vi.fn(async () => h.brand) },
    order: { findMany: vi.fn(async () => h.orders) },
    shipment: { findUnique: vi.fn(async () => h.shipment) },
  },
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { generateCorrispettiviDaily } from './corrispettivi.service.js'
import { customsDeclarationHtml } from './customs-declaration.service.js'
import { generateCreditNoteXml, generateFatturaPaXml } from './fattura-pa.service.js'

const SECOND = 'test_identity_fiscal_second'
const inBusiness = <T>(workspaceId: string, work: () => Promise<T>) =>
  withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const xavia = <T>(work: () => Promise<T>) => inBusiness(LEGACY_WORKSPACE_ID, work)
const second = <T>(work: () => Promise<T>) => inBusiness(SECOND, work)

const SECOND_BRAND = {
  companyName: 'Test Moto S.r.l.',
  contactEmail: 'help@testmoto.example',
  contactPhone: '+39 06 0000000',
  addressLines: ['Via Prova 2', '00100 Roma RM', 'Italia'],
  piva: 'IT12345678901',
  codiceFiscale: '12345678901',
  pecEmail: null,
  taxId: null,
}
const DAY = '2026-04-10'
const ORDERS = [
  { id: 'o1', channel: 'SHOPIFY', status: 'DELIVERED', fiscalKind: 'B2C', marketplace: 'IT', purchaseDate: new Date('2026-04-10T09:00:00Z'), createdAt: new Date('2026-04-10T09:00:00Z'), items: [{ price: '24.40', quantity: 2, itVatRatePct: null }] },
  { id: 'o2', channel: 'MANUAL', status: 'SHIPPED', fiscalKind: null, marketplace: 'IT', purchaseDate: new Date('2026-04-10T15:00:00Z'), createdAt: new Date('2026-04-10T15:00:00Z'), items: [{ price: '10.00', quantity: 1, itVatRatePct: '10' }] },
]
const SHIPMENT = {
  id: 'test-shipment-1', weightGrams: 900, trackingNumber: 'TEST-TRACK-1',
  warehouse: { code: 'TEST-WH', name: 'Test warehouse' },
  order: {
    customerName: 'John Smith', customerEmail: 'buyer@example.test', currencyCode: 'EUR',
    shippingAddress: { AddressLine1: '1 Test Street', City: 'Testtown', PostalCode: 'T1 1TT', CountryCode: 'US' },
    items: [{ sku: 'TEST-SKU-1', quantity: 1, price: '120.00', product: { sku: 'TEST-SKU-1', hsCode: '620120', countryOfOrigin: 'IT', weightValue: '0.8', weightUnit: 'kg' } }],
  },
}

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-04-11T10:00:00Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  h.brand = null
  h.orders = ORDERS
  h.shipment = SHIPMENT
})

const XAVIA_SETTINGS = {
  companyName: 'Test Xavia S.r.l.', contactEmail: 'legal@testxavia.example', contactPhone: '+39 0541 000000',
  addressLines: ['Via Prova 9', '47999 Testborgo (RN)', 'Italia'], piva: 'IT11111111111', codiceFiscale: '11111111111', pecEmail: null, taxId: null,
}
const XAVIA_ENV = {
  NEXUS_ISSUER_NAME: 'Env Xavia S.r.l.', NEXUS_ISSUER_ADDRESS: 'Via Ambiente 3', NEXUS_ISSUER_POSTAL: '47998', NEXUS_ISSUER_CITY: 'Envtown',
  NEXUS_ISSUER_COUNTRY: 'IT', NEXUS_ISSUER_PROVINCE: 'RN', NEXUS_ISSUER_VAT: 'IT22222222222', NEXUS_ISSUER_CF: '22222222222', NEXUS_RT_MATRICOLA: 'TEST-RT-1',
}
const PLACEHOLDERS = ['Via Esempio', 'IT00000000000', '00000000000', 'Milano', '20100', 'xavia.example']
const stubEnv = (values: Record<string, string>) => { for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value) }

describe('Xavia: its one company identity, never a placeholder', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('with its company settings: the corrispettivi and the customs declaration print them', async () => {
    h.brand = { ...XAVIA_SETTINGS }
    const day = await xavia(() => generateCorrispettiviDaily(DAY))
    expect(day.xml).toContain('<PartitaIva>11111111111</PartitaIva>')
    expect(day.xml).toContain('<CodiceFiscale>11111111111</CodiceFiscale>')
    expect(day).toMatchObject({ orderCount: 2, filename: `corrispettivi_11111111111_${DAY}.xml` })
    const { html } = await xavia(() => customsDeclarationHtml('test-shipment-1'))
    expect(html).toContain('<div class="line">Test Xavia S.r.l.</div>')
    expect(html).toContain('<div class="line">47999 Testborgo (RN)</div>')
    expect(html).toContain('Tel: +39 0541 000000')
    expect(html).toContain('VAT/IVA: IT11111111111')
    for (const placeholder of PLACEHOLDERS) {
      expect(day.xml).not.toContain(placeholder)
      expect(html).not.toContain(placeholder)
    }
  })

  it('without settings: NEXUS_ISSUER_* (and the RT matricola) is the fallback', async () => {
    stubEnv(XAVIA_ENV)
    const day = await xavia(() => generateCorrispettiviDaily(DAY))
    expect(day.xml).toContain('<PartitaIva>22222222222</PartitaIva>')
    expect(day.xml).toContain('<MatricolaRT>TEST-RT-1</MatricolaRT>')
    const { html } = await xavia(() => customsDeclarationHtml('test-shipment-1'))
    expect(html).toContain('<div class="line">Env Xavia S.r.l.</div>')
    expect(html).toContain('<div class="line">47998 Envtown</div>')
  })

  it('with neither: refused', async () => {
    await expect(xavia(() => generateCorrispettiviDaily(DAY))).rejects.toThrow(/Settings › Company/)
    await expect(xavia(() => customsDeclarationHtml('test-shipment-1'))).rejects.toThrow(/Settings › Company/)
  })

  it('FatturaPA: refused while a NEXUS_ISSUER_* value it prints is missing, before anything is read', async () => {
    h.brand = { ...XAVIA_SETTINGS }
    await expect(xavia(() => generateFatturaPaXml('test-order-1'))).rejects.toThrow(/NEXUS_ISSUER_/)
    await expect(xavia(() => generateCreditNoteXml('test-refund-1'))).rejects.toThrow(/NEXUS_ISSUER_/)
  })
})

describe('a second business with its identity: its own legal identity, never Xavia', () => {
  beforeEach(() => {
    h.brand = { ...SECOND_BRAND }
  })

  it('the corrispettivi carry its P.IVA and codice fiscale', async () => {
    const result = await second(() => generateCorrispettiviDaily(DAY))
    expect(result.xml).toContain('<PartitaIva>12345678901</PartitaIva>')
    expect(result.xml).toContain('<CodiceFiscale>12345678901</CodiceFiscale>')
    expect(result.xml).not.toContain('00000000000')
    expect(result.xml).not.toContain('MatricolaRT')
    expect(result.filename).toBe(`corrispettivi_12345678901_${DAY}.xml`)
  })

  it('the customs declaration is from the business', async () => {
    const { html } = await second(() => customsDeclarationHtml('test-shipment-1'))
    const from = html.slice(html.indexOf('From / Expéditeur'), html.indexOf('To / Destinataire'))
    expect(from).toContain('Test Moto S.r.l.')
    expect(from).toContain('Via Prova 2')
    expect(from).toContain('00100 Roma RM')
    expect(from).toContain('Tel: +39 06 0000000')
    expect(from).toContain('VAT/IVA: IT12345678901')
    expect(html).not.toMatch(/xavia|Via Esempio|IT00000000000/i)
  })
})

describe('a second business without an identity: refused', () => {
  it('no corrispettivi and no customs declaration', async () => {
    await expect(second(() => generateCorrispettiviDaily(DAY))).rejects.toThrow(/Settings › Company/)
    await expect(second(() => customsDeclarationHtml('test-shipment-1'))).rejects.toThrow(/Settings › Company/)
  })

  it('without a P.IVA: refused too', async () => {
    h.brand = { ...SECOND_BRAND, piva: null, taxId: null }
    await expect(second(() => generateCorrispettiviDaily(DAY))).rejects.toThrow(/P\.IVA/)
    await expect(second(() => customsDeclarationHtml('test-shipment-1'))).rejects.toThrow(/P\.IVA/)
  })
})
