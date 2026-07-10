/**
 * UFX Phase 6 (batch 2) — GPSR, API side.
 *
 * Locks the two units:
 *   P6e  compliance auto-fill writes the REAL schema attribute names
 *        (gpsr_manufacturer_reference / dsa_responsible_party_address — the
 *        old eu_responsible_person / responsible_person_address exist in ZERO
 *        live schemas, so the applicable-columns gate pruned them from every
 *        feed) + correct feed shape for the flat single-sub-property
 *        gpsr_manufacturer_reference → gpsr_manufacturer_email_address.
 *   P6f  GPSR EU preflight warnings (warn-only): missing contacts, attestation
 *        XOR compliance media, media URL/type/language integrity.
 *
 * Attribute shapes verified against the live cached IT schemas (OUTERWEAR,
 * GLOVES + all 72 active defs), 2026-07-10:
 *   gpsr_safety_attestation        = [{value: boolean, marketplace_id}]
 *   gpsr_manufacturer_reference    = [{gpsr_manufacturer_email_address: string, marketplace_id}]
 *   dsa_responsible_party_address  = [{value: string, marketplace_id}]
 *   compliance_media               = [{content_type, content_language, source_location, marketplace_id}]
 *   safety_data_sheet_url          = [{value, language_tag, marketplace_id}]
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { AmazonFlatFileService, buildSchemaFieldHints } from './flat-file.service.js'
import {
  checkGpsrCompliance,
  preflightRow,
  type GpsrCheckContext,
} from '../listing-preflight.service.js'
import {
  buildCompliancePayload,
  buildAmazonComplianceColumns,
  type ResponsiblePerson,
} from '../compliance-resolver.service.js'

// ── Schema fixture — the REAL IT shapes (trimmed) ────────────────────────────

const gpsrSchemaProperties: Record<string, any> = {
  gpsr_safety_attestation: {
    type: 'array',
    items: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'boolean', enum: [false, true] }, marketplace_id: {} },
    },
  },
  gpsr_manufacturer_reference: {
    type: 'array',
    items: {
      type: 'object',
      required: [],
      properties: {
        marketplace_id: {},
        gpsr_manufacturer_email_address: { type: 'string', maxLength: 100 },
      },
    },
  },
  dsa_responsible_party_address: {
    type: 'array',
    items: {
      type: 'object',
      required: ['value'],
      properties: { value: { type: 'string', maxLength: 1000 }, marketplace_id: {} },
    },
  },
}

const RP: ResponsiblePerson = {
  name: 'Xavia Srl',
  addressLines: ['Via Roma 1', '20100 Milano'],
  email: 'compliance@xavia.it',
  phone: '+39 02 1234',
  taxId: 'IT12345',
}

// ── P6e — auto-fill names + feed shape ───────────────────────────────────────

describe('UFX P6e — compliance auto-fill writes real GPSR attribute names', () => {
  const payload = buildCompliancePayload(
    { id: 'p1', sku: 'SKU1', countryOfOrigin: 'Italy', manufacturer: 'Xavia', certificates: [] },
    RP,
  )

  it('emits gpsr_manufacturer_reference + dsa_responsible_party_address from the RP email', () => {
    const cols = buildAmazonComplianceColumns(payload)
    expect(cols.gpsr_manufacturer_reference).toBe('compliance@xavia.it')
    expect(cols.dsa_responsible_party_address).toBe('compliance@xavia.it')
    expect(cols.manufacturer).toBe('Xavia')
    expect(cols.country_of_origin).toBe('Italy')
  })

  it('the fill passes an applicable-columns gate built from a real schema (the old names never did)', () => {
    const applicable = new Set(Object.keys(gpsrSchemaProperties).concat(['country_of_origin', 'manufacturer']))
    const cols = buildAmazonComplianceColumns(payload)
    const landed = Object.keys(cols).filter((k) => applicable.has(k))
    expect(landed.sort()).toEqual(['country_of_origin', 'dsa_responsible_party_address', 'gpsr_manufacturer_reference', 'manufacturer'])
    // The dead legacy names are gone entirely.
    expect(Object.keys(cols)).not.toContain('eu_responsible_person')
    expect(Object.keys(cols)).not.toContain('responsible_person_address')
    expect(Object.keys(cols)).not.toContain('manufacturer_contact_information')
  })

  it('buildSchemaFieldHints marks gpsr_manufacturer_reference as a FLAT single-sub attribute', () => {
    const hints = buildSchemaFieldHints(gpsrSchemaProperties)
    expect(hints.wrappedSubPropFields.gpsr_manufacturer_reference).toEqual({
      sub: 'gpsr_manufacturer_email_address',
      localized: false,
      flat: true,
    })
    // dsa is a normal [{value,…}] attribute — no wrapped entry.
    expect(hints.wrappedSubPropFields.dsa_responsible_party_address).toBeUndefined()
    // attestation stays a boolean-typed field.
    expect(hints.booleanFields.has('gpsr_safety_attestation')).toBe(true)
  })

  it('feed body emits [{gpsr_manufacturer_email_address, marketplace_id}] — not the schema-violating [{value,…}]', () => {
    const svc = new AmazonFlatFileService({} as any, {} as any)
    const hints = buildSchemaFieldHints(gpsrSchemaProperties)
    const rows = [{
      item_sku: 'SKU1',
      product_type: 'OUTERWEAR',
      gpsr_manufacturer_reference: 'compliance@xavia.it',
      dsa_responsible_party_address: 'compliance@xavia.it',
      gpsr_safety_attestation: 'true',
    }]
    const { body } = svc.buildJsonFeedBodyWithReport(rows, 'IT', 'SELLER', {}, {
      wrappedSubPropFields: hints.wrappedSubPropFields,
      booleanFields: hints.booleanFields,
      subPropTypes: hints.subPropTypes,
      localizedFields: hints.localizedFields, // schema present → only real localized fields get a tag
    })
    const attrs = JSON.parse(body).messages[0].attributes
    expect(attrs.gpsr_manufacturer_reference).toEqual([
      { gpsr_manufacturer_email_address: 'compliance@xavia.it', marketplace_id: expect.any(String) },
    ])
    expect(attrs.gpsr_manufacturer_reference[0]).not.toHaveProperty('value')
    expect(attrs.dsa_responsible_party_address).toEqual([
      { value: 'compliance@xavia.it', marketplace_id: expect.any(String) },
    ])
    expect(attrs.gpsr_safety_attestation).toEqual([
      { value: true, marketplace_id: expect.any(String) },
    ])
  })
})

// ── P6f — GPSR EU preflight warnings ─────────────────────────────────────────

const CONTENT_TYPES = ['safety_information', 'instructions_for_use', 'user_manual', 'warranty']

const ALL_GPSR_COLS = new Set([
  'gpsr_manufacturer_reference',
  'dsa_responsible_party_address',
  'gpsr_safety_attestation',
  'safety_data_sheet_url',
  'compliance_media__content_type',
  'compliance_media__source_location',
  'compliance_media__content_language',
])

const ctx = (over: Partial<GpsrCheckContext> = {}): GpsrCheckContext => ({
  marketplace: 'IT',
  applicableColumns: ALL_GPSR_COLS,
  contentTypeValues: CONTENT_TYPES,
  ...over,
})

/** A fully compliant EU row: contact + attestation, no media. */
const validRow = () => ({
  item_sku: 'SKU1',
  gpsr_manufacturer_reference: 'compliance@xavia.it',
  dsa_responsible_party_address: 'https://xavia.it/rp',
  gpsr_safety_attestation: 'true',
})

describe('UFX P6f — checkGpsrCompliance', () => {
  it('valid row (contact + attestation) → no issues', () => {
    expect(checkGpsrCompliance(validRow(), ctx())).toEqual([])
  })

  it('valid row (contact + compliance media instead of attestation) → no issues', () => {
    const row = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'it_IT',
    }
    expect(checkGpsrCompliance(row, ctx())).toEqual([])
  })

  it('(a) both contacts blank → single missing-contact warning', () => {
    const issues = checkGpsrCompliance({ item_sku: 'S', gpsr_safety_attestation: 'true' }, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].message).toContain('GPSR: registered manufacturer/Responsible Person email missing')
  })

  it('(a) contactAutoFill suppresses the missing-contact warning (C1 fill covers it at submit)', () => {
    const issues = checkGpsrCompliance({ item_sku: 'S', gpsr_safety_attestation: 'true' }, ctx({ contactAutoFill: true }))
    expect(issues).toEqual([])
  })

  it('(a) contact that is neither email nor URL → format warning', () => {
    const row = { ...validRow(), gpsr_manufacturer_reference: 'Via Roma 1, Milano' }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('gpsr_manufacturer_reference')
    expect(issues[0].message).toContain("doesn't look like an email address or URL")
  })

  it('(b) attestation true AND compliance media present → inconsistency warning', () => {
    const row = {
      ...validRow(),
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'it_IT',
    }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('gpsr_safety_attestation')
    expect(issues[0].message).toContain('mutually inconsistent')
  })

  it('(b) no attestation, no media, no SDS → either-attest-or-attach warning', () => {
    const row = { ...validRow(), gpsr_safety_attestation: '' }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('gpsr_safety_attestation')
    expect(issues[0].message).toContain('either set the safety attestation')
  })

  it('(b) no attestation but SDS url present → no warning', () => {
    const row = { ...validRow(), gpsr_safety_attestation: '', safety_data_sheet_url: 'https://xavia.it/sds.pdf' }
    expect(checkGpsrCompliance(row, ctx())).toEqual([])
  })

  it('(b) localized truthy attestation ("Sì") is recognized', () => {
    const row = { ...validRow(), gpsr_safety_attestation: 'Sì' }
    expect(checkGpsrCompliance(row, ctx())).toEqual([])
  })

  it('(c) non-https media URL → warning', () => {
    const row = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'http://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'it_IT',
    }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('compliance_media__source_location')
    expect(issues[0].message).toContain('https://')
  })

  it('(c) wrong media extension → warning; query string on a good extension is fine', () => {
    const bad = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'https://xavia.it/docs/safety.docx',
      compliance_media__content_language: 'it_IT',
    }
    const issues = checkGpsrCompliance(bad, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('.pdf, .jpg, .jpeg or .png')

    const good = { ...bad, compliance_media__source_location: 'https://xavia.it/docs/safety.pdf?v=2' }
    expect(checkGpsrCompliance(good, ctx())).toEqual([])
  })

  it('(c) content_type outside the schema enum → warning', () => {
    const row = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'random_document',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'it_IT',
    }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('compliance_media__content_type')
  })

  it('(c) content_language mismatching the marketplace → warning (IT expects it_IT)', () => {
    const row = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'en_GB',
    }
    const issues = checkGpsrCompliance(row, ctx())
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('compliance_media__content_language')
    expect(issues[0].message).toContain('it_IT')
  })

  it('(c) BE accepts both official languages (fr_BE / nl_BE)', () => {
    const row = {
      ...validRow(),
      gpsr_safety_attestation: '',
      compliance_media__content_type: 'safety_information',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'nl_BE',
    }
    expect(checkGpsrCompliance(row, ctx({ marketplace: 'BE' }))).toEqual([])
  })

  it('non-EU marketplace → all checks skipped', () => {
    expect(checkGpsrCompliance({ item_sku: 'S' }, ctx({ marketplace: 'US' }))).toEqual([])
    expect(checkGpsrCompliance({ item_sku: 'S' }, ctx({ marketplace: 'UK' }))).toEqual([])
  })

  it('product type without GPSR fields → all checks skipped', () => {
    const issues = checkGpsrCompliance({ item_sku: 'S' }, ctx({ applicableColumns: new Set(['item_name', 'brand']) }))
    expect(issues).toEqual([])
  })

  it('DELETE rows are skipped (nothing to validate on a delete message)', () => {
    expect(checkGpsrCompliance({ item_sku: 'S', record_action: 'Delete' }, ctx())).toEqual([])
  })
})

describe('UFX P6f — preflightRow wiring', () => {
  it('extras.gpsr adds the warnings to the standard preflight output', () => {
    const row = { item_sku: 'S', main_product_image_locator: 'https://x/img.jpg' }
    const issues = preflightRow(row, [], [], { gpsr: ctx() })
    const gpsrIssues = issues.filter((i) => i.message.startsWith('GPSR:'))
    expect(gpsrIssues.length).toBeGreaterThan(0)
    expect(gpsrIssues.every((i) => i.severity === 'warning')).toBe(true)
  })

  it('no extras.gpsr → callers unchanged (no GPSR issues)', () => {
    const row = { item_sku: 'S', main_product_image_locator: 'https://x/img.jpg' }
    expect(preflightRow(row, [], []).filter((i) => i.message.startsWith('GPSR:'))).toEqual([])
  })

  it('dedupes per field with checkEnumValues (one bad content_type cell → one issue)', () => {
    const row = {
      item_sku: 'S',
      main_product_image_locator: 'https://x/img.jpg',
      gpsr_manufacturer_reference: 'compliance@xavia.it',
      compliance_media__content_type: 'nonsense',
      compliance_media__source_location: 'https://xavia.it/docs/safety.pdf',
      compliance_media__content_language: 'it_IT',
    }
    const issues = preflightRow(row, [], [], {
      enumColumns: [{ id: 'compliance_media__content_type', label: 'Content Type', values: CONTENT_TYPES }],
      gpsr: ctx(),
    })
    expect(issues.filter((i) => i.field === 'compliance_media__content_type')).toHaveLength(1)
  })

  it('GPSR warnings never escalate to errors (nothing may block a submit)', () => {
    const row = {
      item_sku: 'S',
      main_product_image_locator: 'https://x/img.jpg',
      gpsr_safety_attestation: 'true',
      compliance_media__content_type: 'bogus',
      compliance_media__source_location: 'http://bad.example/file.docx',
      compliance_media__content_language: 'en_GB',
    }
    const issues = preflightRow(row, [], [], { gpsr: ctx() }).filter((i) => i.message.startsWith('GPSR:'))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
  })
})
