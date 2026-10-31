import { describe, expect, it } from 'vitest'
import { assertGenericPath, MODULE_OWNED_FILES, ownerOf } from './owned'

describe('record types whose files only their module writes (owned.ts)', () => {
  it('lists the compliance document, the parcel, the privacy notice and DPIA and the type-change review (every kind), the certificate, the lot and the opening-stock reports (CERTIFICATE) and the DDT (FISCAL_ARCHIVE)', () => {
    expect(Object.keys(MODULE_OWNED_FILES).sort()).toEqual(['Certificate', 'ComplianceDocument', 'Ddt', 'Lot', 'OpeningStock', 'Parcel', 'PrivacyDpia', 'PrivacyNotice', 'TypeChangeReview'])
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
    // Not an inherited property of a plain object.
    expect(ownerOf('constructor', 'DOCUMENT')).toBeNull()
  })

  it('refuses the generic path with the module\'s route, and lets the module through', () => {
    expect(() => assertGenericPath('ComplianceDocument', 'DOCUMENT', {})).toThrow(/only through its own route: POST \/product\/styles\/:styleId\/compliance\/documents/)
    expect(() => assertGenericPath('Certificate', 'CERTIFICATE', { viaModule: false })).toThrow(/POST \/compliance\/certificates\/:certificateId\/pdf/)
    expect(() => assertGenericPath('ComplianceDocument', 'DOCUMENT', { viaModule: true })).not.toThrow()
    expect(() => assertGenericPath('Certificate', 'ATTACHMENT', {})).not.toThrow()
  })
})
