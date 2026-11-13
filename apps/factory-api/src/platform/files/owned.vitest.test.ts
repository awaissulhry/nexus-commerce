import { describe, expect, it } from 'vitest'
import { assertGenericPath, MODULE_OWNED_FILES, MODULE_READ_FILES, ownerOf, readsThroughModule } from './owned'

describe('record types whose files only their module writes (owned.ts)', () => {
  it('lists the compliance document, the parcel, the privacy notice and DPIA and the type-change review (every kind), the certificate, the lot and the opening-stock reports (CERTIFICATE) and the DDT (FISCAL_ARCHIVE)', () => {
    expect(Object.keys(MODULE_OWNED_FILES).sort()).toEqual(['AttendanceMonthClose', 'Certificate', /* B-W2b-161 */ 'CompanyBranding', 'ComplianceDocument', 'Ddt', /* B-W2b-278 */ 'EvidencePack', /* B-W2b-135 */ 'FitnessJudgement', /* B-W2b-135 */ 'HealthVisit', /* B-W2b-125 */ 'InailFiling', 'Incident', 'Lot', /* B-W2b-171 */ 'MeasurementProfile', 'OpeningStock', 'Parcel', 'PayrollExport', /* B-W2b-224 */ 'PointOfMeasure', /* B-W2b-288 */ 'PpeTextApproval', 'PrivacyDpia', 'PrivacyNotice', /* B-W2b-351 */ 'ProductSafetyReport', /* B-W2b-278 */ 'ProductionControlTest', /* B-W2b-165 */ 'QuoteVersion', 'SupplierClaim', 'TypeChangeReview', 'WorkerStatement'])
    expect(ownerOf('OpeningStock', 'CERTIFICATE')).not.toBeNull()
    expect(ownerOf('OpeningStock', 'ATTACHMENT')).toBeNull()
    expect(ownerOf('PrivacyNotice', 'DOCUMENT')).not.toBeNull()
    expect(ownerOf('PrivacyDpia', 'ATTACHMENT')).not.toBeNull()
    expect(ownerOf('Lot', 'CERTIFICATE')).not.toBeNull()
    expect(ownerOf('Lot', 'PHOTO')).toBeNull()
    expect(ownerOf('Parcel', 'PHOTO')).not.toBeNull()
    expect(ownerOf('Ddt', 'FISCAL_ARCHIVE')).not.toBeNull()
    expect(ownerOf('Ddt', 'PHOTO')).toBeNull()
    expect(ownerOf('ComplianceDocument', 'DOCUMENT')).not.toBeNull()
    expect(ownerOf('ComplianceDocument', 'ATTACHMENT')).not.toBeNull()
    expect(ownerOf('Certificate', 'CERTIFICATE')).not.toBeNull()
    expect(ownerOf('Certificate', 'ATTACHMENT')).toBeNull()
    expect(ownerOf('TypeChangeReview', 'DOCUMENT')).not.toBeNull()
    expect(ownerOf('Quote', 'DOCUMENT')).toBeNull()
    expect(ownerOf('QuoteVersion', 'PHOTO')).not.toBeNull()
    // B-W2b-278 (FU4:02): an evidence pack's files and a production-control test's lab report, every kind.
    for (const kind of ['DOCUMENT', 'ATTACHMENT', 'CERTIFICATE', 'PHOTO'] as const) {
      expect(ownerOf('EvidencePack', kind), `EvidencePack ${kind}`).not.toBeNull()
      expect(ownerOf('ProductionControlTest', kind), `ProductionControlTest ${kind}`).not.toBeNull()
    }
    // B-W2b-288 (FU2:01): the PPE consultant's file of an approval, every kind.
    expect(ownerOf('PpeTextApproval', 'DOCUMENT')).not.toBeNull()
    expect(ownerOf('TechnicalFile', 'ATTACHMENT')).toBeNull()
    // Not an inherited property of a plain object.
    expect(ownerOf('constructor', 'DOCUMENT')).toBeNull()
  })

  it('refuses the generic path with the module\'s route, and lets the module through', () => {
    expect(() => assertGenericPath('ComplianceDocument', 'DOCUMENT', {})).toThrow(/only through its own route: POST \/product\/styles\/:styleId\/compliance\/documents/)
    expect(() => assertGenericPath('Certificate', 'CERTIFICATE', { viaModule: false })).toThrow(/POST \/compliance\/certificates\/:certificateId\/pdf/)
    expect(() => assertGenericPath('ComplianceDocument', 'DOCUMENT', { viaModule: true })).not.toThrow()
    expect(() => assertGenericPath('Certificate', 'ATTACHMENT', {})).not.toThrow()
    expect(() => assertGenericPath('EvidencePack', 'DOCUMENT', {})).toThrow(/POST \/compliance\/techfiles\/:fileId\/packs/)
    expect(() => assertGenericPath('ProductionControlTest', 'CERTIFICATE', {})).toThrow(/POST \/compliance\/production-tests\/:testId\/report/)
  })

  it('reads a closed month\'s LUL calendar (B-W2b-48), a payroll file (B-W2b-54) and a worker statement (B-W2b-62, B-W2b-68) only through their modules, no other record type', () => {
    expect(Object.keys(MODULE_READ_FILES)).toEqual(['AttendanceMonthClose', 'PayrollExport', 'WorkerStatement', /* B-W2b-125 */ 'Incident', 'InailFiling', /* B-W2b-135 */ 'FitnessJudgement', 'HealthVisit', /* B-W2b-171 */ 'MeasurementProfile', /* B-W2b-351 */ 'ProductSafetyReport'])
    expect(readsThroughModule('AttendanceMonthClose')).toBe(true)
    expect(readsThroughModule('PayrollExport')).toBe(true)
    // B-W2b-68: one person's pay.
    expect(readsThroughModule('WorkerStatement')).toBe(true)
    // B-W2b-125: an incident's photos and INAIL's receipt (protected: office only, each receipt opening recorded).
    expect(readsThroughModule('Incident')).toBe(true)
    expect(readsThroughModule('InailFiling')).toBe(true)
    expect(ownerOf('Incident', 'PHOTO')).not.toBeNull()
    // B-W2b-135: a judgement's copy (protected, each opening recorded); a visit keeps no file.
    expect(readsThroughModule('FitnessJudgement')).toBe(true)
    expect(ownerOf('HealthVisit', 'ATTACHMENT')).not.toBeNull()
    expect(readsThroughModule('Quote')).toBe(false)
    expect(readsThroughModule('constructor')).toBe(false)
  })
})
