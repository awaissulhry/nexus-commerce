/**
 * C1 — compliance resolver pure functions: payload assembly, the EU/PPE/CE rule
 * engine (deterministic via injected `now`), and the Amazon column mapper.
 */
import { describe, it, expect, vi } from 'vitest'

// The service imports prisma at module load; mock it so the pure functions
// import cleanly without a real PrismaClient.
vi.mock('../db.js', () => ({ default: {} }))

import {
  buildCompliancePayload,
  evaluateCompliance,
  buildAmazonComplianceColumns,
  buildShopifyComplianceMetafields,
  type ResponsiblePerson,
} from './compliance-resolver.service.js'

const RP: ResponsiblePerson = {
  name: 'Xavia Srl',
  addressLines: ['Via Roma 1', '20100 Milano'],
  email: 'compliance@xavia.it',
  phone: '+39 02 1234',
  taxId: 'IT12345',
}
const NOW = new Date('2026-06-15T00:00:00Z')

describe('C1 — buildCompliancePayload', () => {
  it('assembles fields + picks the CE cert + flags dangerous goods', () => {
    const p = buildCompliancePayload(
      {
        id: 'p1', sku: 'SKU1', countryOfOrigin: 'Pakistan', manufacturer: 'Xavia',
        ppeCategory: 'CAT_II', hazmatClass: '9', hazmatUnNumber: 'UN1950',
        certificates: [
          { certType: 'CE', certNumber: 'CE-1', standard: 'EN 17092', issuingBody: 'NB-123', issuedAt: null, expiresAt: new Date('2027-01-01'), fileUrl: null },
          { certType: 'REACH', certNumber: 'R-1', standard: null, issuingBody: null, issuedAt: null, expiresAt: null, fileUrl: null },
        ],
      },
      RP,
    )
    expect(p.ceCert?.certNumber).toBe('CE-1')
    expect(p.dangerousGoods).toEqual({ hazmatClass: '9', unNumber: 'UN1950' })
    expect(p.responsiblePerson?.name).toBe('Xavia Srl')
  })
  it('no hazmat → dangerousGoods null; no CE → ceCert null', () => {
    const p = buildCompliancePayload({ id: 'p2', certificates: [] }, null)
    expect(p.dangerousGoods).toBeNull()
    expect(p.ceCert).toBeNull()
    expect(p.responsiblePerson).toBeNull()
  })
  it('C4 — structured CE/PPE: garment class, notified body, DoC, protectors', () => {
    const p = buildCompliancePayload(
      {
        id: 'p3', garmentClass: 'AA', notifiedBodyNumber: '0494', notifiedBodyName: 'Ricotest',
        declarationOfConformityUrl: 'https://x/doc.pdf',
        impactProtectors: [
          { zone: 'back', standard: 'EN_1621_2', level: 2 },
          { zone: '', standard: '', level: '' }, // blank → dropped
        ],
        certificates: [],
      },
      null,
    )
    expect(p.garmentClass).toBe('AA')
    expect(p.notifiedBody).toEqual({ number: '0494', name: 'Ricotest' })
    expect(p.declarationOfConformityUrl).toBe('https://x/doc.pdf')
    expect(p.impactProtectors).toEqual([{ zone: 'back', standard: 'EN_1621_2', level: '2' }])
  })
  it('C4 — no structured data → null/empty', () => {
    const p = buildCompliancePayload({ id: 'p4', certificates: [] }, null)
    expect(p.garmentClass).toBeNull()
    expect(p.notifiedBody).toBeNull()
    expect(p.impactProtectors).toEqual([])
  })
})

describe('C1 — evaluateCompliance', () => {
  const base = buildCompliancePayload(
    { id: 'p', sku: 'S', countryOfOrigin: 'IT', hsCode: '6506', ppeCategory: 'CAT_II', certificates: [] },
    RP,
  )
  it('PPE Cat II + EU + no CE → block', () => {
    const issues = evaluateCompliance(base, 'IT', 'AMAZON', NOW)
    expect(issues.some((i) => i.code === 'ce_cert_missing' && i.severity === 'block')).toBe(true)
  })
  it('PPE Cat II + non-EU → no CE block', () => {
    expect(evaluateCompliance(base, 'US', 'AMAZON', NOW).some((i) => i.code === 'ce_cert_missing')).toBe(false)
  })
  it('expired CE → block; expiring <90d → warn; valid → clean', () => {
    const expired = { ...base, ceCert: { certNumber: 'CE-1', expiresAt: new Date('2026-01-01') } }
    expect(evaluateCompliance(expired, 'IT', 'AMAZON', NOW).some((i) => i.code === 'ce_cert_expired' && i.severity === 'block')).toBe(true)
    const expiring = { ...base, ceCert: { certNumber: 'CE-1', expiresAt: new Date('2026-07-01') } }
    expect(evaluateCompliance(expiring, 'IT', 'AMAZON', NOW).some((i) => i.code === 'ce_cert_expiring' && i.severity === 'warn')).toBe(true)
    const valid = { ...base, ceCert: { certNumber: 'CE-1', expiresAt: new Date('2028-01-01') } }
    expect(evaluateCompliance(valid, 'IT', 'AMAZON', NOW).some((i) => i.code.startsWith('ce_cert'))).toBe(false)
  })
  it('hazmat on Amazon → warn', () => {
    const dg = { ...base, dangerousGoods: { hazmatClass: '9', unNumber: 'UN1950' } }
    expect(evaluateCompliance(dg, 'IT', 'AMAZON', NOW).some((i) => i.code === 'amazon_hazmat_declaration')).toBe(true)
  })
  it('missing country/hs on cross-border → warn', () => {
    const bare = buildCompliancePayload({ id: 'p', certificates: [] }, RP)
    const issues = evaluateCompliance(bare, 'US', 'AMAZON', NOW).map((i) => i.code)
    expect(issues).toContain('country_of_origin_missing')
    expect(issues).toContain('hs_code_missing')
  })
  it('GPSR responsible person missing on EU → warn; present → clean', () => {
    const noRp = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', hsCode: '6506', certificates: [] }, null)
    expect(evaluateCompliance(noRp, 'IT', 'AMAZON', NOW).some((i) => i.code === 'gpsr_responsible_person_missing')).toBe(true)
    const withRp = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', hsCode: '6506', certificates: [] }, RP)
    expect(evaluateCompliance(withRp, 'IT', 'AMAZON', NOW).some((i) => i.code === 'gpsr_responsible_person_missing')).toBe(false)
  })
})

describe('C1 — buildAmazonComplianceColumns', () => {
  it('maps the confirmed Amazon keys; folds RP address', () => {
    const p = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', manufacturer: 'Xavia', certificates: [] }, RP)
    const cols = buildAmazonComplianceColumns(p)
    expect(cols.country_of_origin).toBe('IT')
    expect(cols.manufacturer).toBe('Xavia')
    expect(cols.manufacturer_contact_information).toBe('Xavia')
    expect(cols.eu_responsible_person).toBe('Xavia Srl')
    expect(cols.responsible_person_address).toBe('Via Roma 1, 20100 Milano, compliance@xavia.it, +39 02 1234')
  })
  it('emits only keys with data (no RP, no manufacturer)', () => {
    const p = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', certificates: [] }, null)
    expect(Object.keys(buildAmazonComplianceColumns(p))).toEqual(['country_of_origin'])
  })
})

describe('C3 — buildShopifyComplianceMetafields', () => {
  it('maps country/manufacturer/RP into the compliance namespace', () => {
    const p = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', manufacturer: 'Xavia', certificates: [] }, RP)
    const m = buildShopifyComplianceMetafields(p)
    const byKey = Object.fromEntries(m.map((x) => [x.key, x]))
    expect(byKey.country_of_origin).toMatchObject({ namespace: 'compliance', type: 'single_line_text_field', value: 'IT' })
    expect(byKey.manufacturer.value).toBe('Xavia')
    expect(byKey.responsible_person.value).toBe('Xavia Srl')
    expect(byKey.responsible_person_address).toMatchObject({ type: 'multi_line_text_field' })
    expect(byKey.responsible_person_address.value).toContain('Via Roma 1')
  })
  it('no RP name → no responsible_person metafields', () => {
    const p = buildCompliancePayload({ id: 'p', countryOfOrigin: 'IT', certificates: [] }, null)
    expect(buildShopifyComplianceMetafields(p).map((x) => x.key)).toEqual(['country_of_origin'])
  })
  it('nothing → empty array', () => {
    expect(buildShopifyComplianceMetafields(buildCompliancePayload({ id: 'p', certificates: [] }, null))).toEqual([])
  })
})
