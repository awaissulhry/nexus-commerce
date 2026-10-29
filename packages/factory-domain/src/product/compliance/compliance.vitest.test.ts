import { describe, expect, it } from 'vitest'
import type { GateCover, SizeGateRequest } from '../../compliance/cert-gate/gate'
import type { CertificateStatus } from '../../compliance/certificates/rules'
import {
  addressText,
  blockersOf,
  checkedCells,
  classificationOf,
  complianceChecks,
  coverageCell,
  coverageCounts,
  currentDocument,
  documentLanguages,
  documentStatus,
  documentUploadProblems,
  issuePlan,
  makerOf,
  standardParts,
  type CoverageCell,
  type DocumentFacts,
  type GridCell,
  type StyleFacts,
} from './rules'

// Every style, certificate and notified body here is made up (notified body "0000" does not exist).
const JACKET: StyleFacts = { id: 'style-1', code: 'TEST-JKT', productType: 'JACKET', ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-4:2020', ppeClass: 'A', brandPartyId: null }
const BLK = 'colourway-blk'
const RED = 'colourway-red'

const certificate = (id: string, overrides: Partial<GateCover['certificate']> = {}): GateCover['certificate'] => ({
  id,
  number: `TEST-${id}`,
  standard: 'EN 17092-4:2020',
  ppeClass: 'A',
  notifiedBodyName: 'Test Notified Body',
  notifiedBodyNumber: '0000',
  validFrom: '2025-01-01',
  validTo: '2029-12-31',
  status: 'VALID' as CertificateStatus,
  ...overrides,
})
const cover = (id: string, sizes: string[], overrides: Partial<GateCover['certificate']> = {}, colourwayIds: string[] = []): GateCover => ({
  coverageId: `coverage-${id}`,
  colourwayIds,
  sizes,
  allowsMadeToMeasure: false,
  certificate: certificate(id, overrides),
})
const base = (covers: GateCover[], style: StyleFacts = JACKET, date = '2026-10-29'): SizeGateRequest => ({
  style: { id: style.id, code: style.code, ppeCategory: style.ppeCategory, sizes: ['48', '50', '52'], mtmAllowed: false },
  colourwayId: BLK,
  size: '48',
  date,
  covers,
})
const cell = (size: string, colourwayId = BLK, offered = true): GridCell => ({ colourwayId, colourwayCode: colourwayId === BLK ? 'BLK' : 'RED', size, offered })
const grid = (request: SizeGateRequest): CoverageCell[] => ['48', '50', '52'].map((size) => coverageCell(request, cell(size)))

const file = { id: 'file-1', originalName: 'doc.pdf', sizeBytes: 10, sha256: 'a'.repeat(64), availableAt: '2026-10-01T09:00:00.000Z' }
const doc = (overrides: Partial<DocumentFacts>): DocumentFacts => ({
  id: 'doc',
  kind: 'DECLARATION_OF_CONFORMITY',
  language: 'it',
  revision: 1,
  status: 'ISSUED',
  number: null,
  issuedAt: '2026-10-01T09:00:00.000Z',
  currentFile: file,
  versions: 1,
  pendingUpload: false,
  ...overrides,
})

describe('the PPE classification (PRD-270; Reg. (EU) 2016/425 art. 18, Annex I)', () => {
  it('reads the standard, its EN 17092 part and edition, the class, and what a category II garment needs', () => {
    expect(standardParts('EN 17092-4:2020')).toEqual({ code: 'EN 17092', part: '4', edition: '2020' })
    expect(standardParts('EN 13594:2015')).toEqual({ code: 'EN 13594', part: null, edition: '2015' })
    expect(standardParts('EN 1621-1:2012')).toEqual({ code: 'EN 1621', part: '1', edition: '2012' })
    expect(standardParts(null)).toBeNull()
    expect(classificationOf(JACKET)).toMatchObject({
      isPpe: true,
      category: 'CATEGORY_II',
      standardCode: 'EN 17092',
      part: '4',
      edition: '2020',
      ppeClass: 'A',
      partClass: 'A',
      certificateRequired: true,
      documentsRequired: true,
      legalMaker: 'COMPANY',
    })
    expect(classificationOf({ ...JACKET, brandPartyId: 'brand-1' }).legalMaker).toBe('BRAND')
  })

  it('asks nothing of a garment that is not PPE, and no certificate (but the DoC and leaflet) of category I', () => {
    const plain = classificationOf({ ...JACKET, ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null })
    expect(plain).toMatchObject({ isPpe: false, certificateRequired: false, documentsRequired: false, standardCode: null, part: null })
    expect(plain.message).toMatch(/not PPE: no certificate, Declaration of Conformity or user information leaflet is needed/)
    const self = classificationOf({ ...JACKET, ppeCategory: 'CATEGORY_I', ppeStandard: null, ppeClass: null })
    expect(self).toMatchObject({ isPpe: true, certificateRequired: false, documentsRequired: true })
  })
})

describe('coverage per colourway × size (the certificate gate, QHS-051)', () => {
  it('covers two of three sizes and names the gap with the gate\'s reason', () => {
    const cells = grid(base([cover('A', ['48', '50'])]))
    expect(cells.map((entry) => entry.status)).toEqual(['COVERED', 'COVERED', 'NOT_COVERED'])
    expect(cells[0]).toMatchObject({ label: 'BLK 48', certificate: { number: 'TEST-A', validTo: '2029-12-31' }, coverageId: 'coverage-A', expiringSoon: false })
    expect(cells[2]).toMatchObject({ certificate: null, reasons: [{ code: 'size_not_covered', certificateId: 'A' }] })
    expect(cells[2]!.message).toMatch(/does not cover size 52 of style TEST-JKT \(it covers 48, 50\)/)
    expect(coverageCounts(cells)).toEqual({ cells: 3, offered: 3, covered: 2, expiringSoon: 0, notCovered: 1, expired: 0, suspended: 0 })
  })

  it('says EXPIRED or SUSPENDED when a certificate would cover the cell but for its status; an expired one never counts as covered', () => {
    const expired = coverageCell(base([cover('OLD', [], { validFrom: '2021-01-01', validTo: '2025-12-31' })]), cell('50'))
    expect(expired).toMatchObject({ status: 'EXPIRED', certificate: { number: 'TEST-OLD', validTo: '2025-12-31' }, coverageId: null, expiringSoon: false })
    expect(expired.message).toMatch(/expired: its last valid day was 2025-12-31/)
    // Marked EXPIRED by the scheduler, too.
    expect(coverageCell(base([cover('GONE', [], { status: 'EXPIRED', validTo: '2025-12-31' })]), cell('50')).status).toBe('EXPIRED')
    // An expired one that covers the size beats a valid one that does not cover it: the reason is the expiry.
    expect(coverageCell(base([cover('OLD', [], { validTo: '2025-12-31' }), cover('NEW', ['48'])]), cell('50')).status).toBe('EXPIRED')
    const suspended = coverageCell(base([cover('S', [], { status: 'SUSPENDED' })]), cell('48'))
    expect(suspended).toMatchObject({ status: 'SUSPENDED', certificate: { number: 'TEST-S', status: 'SUSPENDED' } })
    expect(suspended.message).toMatch(/suspended by the notified body/)
    // A withdrawn certificate, or one for another colourway, covers nothing.
    expect(coverageCell(base([cover('W', [], { status: 'WITHDRAWN' })]), cell('48')).status).toBe('NOT_COVERED')
    expect(coverageCell(base([cover('C', [], {}, [RED])]), cell('48')).status).toBe('NOT_COVERED')
    expect(coverageCell(base([]), cell('48'))).toMatchObject({ status: 'NOT_COVERED', reasons: [{ code: 'no_certificate' }] })
  })

  it('marks a covered cell whose certificate ends within 60 days', () => {
    const soon = coverageCell(base([cover('A', [], { validTo: '2026-12-15' })]), cell('48'))
    expect(soon).toMatchObject({ status: 'COVERED', daysToExpiry: 47, expiringSoon: true })
  })

  it('needs no certificate for a style that is not PPE', () => {
    const plain = { ...JACKET, ppeCategory: 'NOT_PPE' as const, ppeStandard: null, ppeClass: null }
    expect(coverageCell(base([], plain), cell('48'))).toMatchObject({ status: 'NOT_REQUIRED', certificate: null })
  })

  it('checks the offered cells, or every cell while no SKU is on', () => {
    const request = base([cover('A', ['48'])])
    const cells = [coverageCell(request, cell('48')), coverageCell(request, cell('50', BLK, false))]
    expect(checkedCells(cells).map((entry) => entry.size)).toEqual(['48'])
    const none = cells.map((entry) => ({ ...entry, offered: false }))
    expect(checkedCells(none)).toHaveLength(2)
  })
})

describe('the DoC and the leaflet per language and revision (Reg. (EU) 2016/425 art. 8(7)(8), art. 15)', () => {
  it('counts only the document issued for exactly this revision, with a confirmed file', () => {
    const one = doc({ id: 'r1', revision: 1 })
    expect(currentDocument([one], 1, 'DECLARATION_OF_CONFORMITY', 'it')).toBe(one)
    // Revision 2 released: the revision 1 DoC is not the current one.
    expect(currentDocument([one], 2, 'DECLARATION_OF_CONFORMITY', 'it')).toBeNull()
    expect(currentDocument([one], 1, 'USER_INFORMATION', 'it')).toBeNull()
    expect(currentDocument([one], 1, 'DECLARATION_OF_CONFORMITY', 'de')).toBeNull()
    expect(currentDocument([doc({ status: 'DRAFT', currentFile: null, issuedAt: null })], 1, 'DECLARATION_OF_CONFORMITY', 'it')).toBeNull()
    expect(currentDocument([doc({ status: 'WITHDRAWN' })], 1, 'DECLARATION_OF_CONFORMITY', 'it')).toBeNull()
    // A superseded one still goes with the garments of its own revision.
    expect(currentDocument([doc({ status: 'SUPERSEDED' })], 1, 'DECLARATION_OF_CONFORMITY', 'it')).not.toBeNull()
  })

  it('says CURRENT, OLDER_REVISION or MISSING, with an upload that waits', () => {
    const one = doc({ id: 'r1', revision: 1, number: 'DOC-TEST-1' })
    expect(documentStatus('DECLARATION_OF_CONFORMITY', 'it', 1, [one])).toMatchObject({ state: 'CURRENT', document: { id: 'r1' }, message: 'The EU Declaration of Conformity in it for revision 1 is on file (DOC-TEST-1).' })
    const older = documentStatus('DECLARATION_OF_CONFORMITY', 'it', 2, [one])
    expect(older).toMatchObject({ state: 'OLDER_REVISION', document: { id: 'r1', revision: 1 }, pendingUpload: false })
    expect(older.message).toBe('The EU Declaration of Conformity in it is for revision 1, an older revision: upload the signed one for revision 2.')
    const waiting = documentStatus('DECLARATION_OF_CONFORMITY', 'it', 2, [one, doc({ id: 'r2', revision: 2, status: 'DRAFT', currentFile: null, issuedAt: null, versions: 0 })])
    expect(waiting).toMatchObject({ state: 'OLDER_REVISION', pendingUpload: true })
    expect(documentStatus('USER_INFORMATION', 'en', 1, [one])).toMatchObject({ state: 'MISSING', document: null, message: 'No signed user information leaflet in en is on file for revision 1.' })
    expect(documentStatus('USER_INFORMATION', 'en', null, [])).toMatchObject({ state: 'MISSING', revision: null })
  })

  it('lists the label\'s languages first, then any other language on file', () => {
    const documents = [doc({ language: 'fr' }), doc({ language: 'it' }), doc({ language: 'es', status: 'WITHDRAWN' }), doc({ language: 'de', kind: 'USER_INFORMATION' })]
    expect(documentLanguages('DECLARATION_OF_CONFORMITY', documents, ['it', 'en'])).toEqual(['it', 'en', 'fr'])
    expect(documentLanguages('USER_INFORMATION', documents, [])).toEqual(['de'])
  })

  it('supersedes the older revisions\' issued documents of the same kind and language', () => {
    const documents = [doc({ id: 'r1', revision: 1 }), doc({ id: 'r1-en', revision: 1, language: 'en' }), doc({ id: 'r1-ui', revision: 1, kind: 'USER_INFORMATION' }), doc({ id: 'r2', revision: 2, status: 'DRAFT' })]
    expect(issuePlan(documents, { id: 'r2', kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 2 })).toEqual({ supersede: ['r1'], supersededAtOnce: false })
    // A late upload for revision 1 after revision 2's is issued is superseded at once.
    expect(issuePlan([doc({ id: 'r2', revision: 2 })], { id: 'r1', kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1 })).toEqual({ supersede: [], supersededAtOnce: true })
  })

  it('takes a PDF in an ISO 639-1 language only', () => {
    expect(documentUploadProblems({ language: 'it', contentType: 'application/pdf' })).toEqual([])
    expect(documentUploadProblems({ language: 'xx', contentType: 'image/png' }).map((problem) => problem.path)).toEqual(['language', 'contentType'])
  })

  it('names the maker of the garment label, else the brand, else the company (Annex IX 2)', () => {
    const address = { line1: 'Via Inventata 1', postalCode: '00000', city: 'Testville', province: 'TT', country: 'IT' }
    expect(addressText(address)).toBe('Via Inventata 1, 00000 Testville (TT), IT')
    const label = { makerPartyId: null, makerName: 'Label Maker S.r.l.', makerAddress: 'As printed' }
    expect(makerOf({ label, brand: null, company: { legalName: 'X', address } })).toBe(label)
    expect(makerOf({ label: null, brand: { id: 'b', legalName: 'Brand S.r.l.', address }, company: { legalName: 'X', address } })).toEqual({ makerPartyId: 'b', makerName: 'Brand S.r.l.', makerAddress: 'Via Inventata 1, 00000 Testville (TT), IT' })
    expect(makerOf({ label: null, brand: { id: 'b', legalName: 'Brand S.r.l.', address: null }, company: { legalName: 'X', address } })).toBeNull()
    expect(makerOf({ label: null, brand: null, company: { legalName: 'Company S.r.l.', address } })).toMatchObject({ makerPartyId: null, makerName: 'Company S.r.l.' })
    expect(makerOf({ label: null, brand: null, company: { legalName: 'Company S.r.l.', address: null } })).toBeNull()
  })
})

describe('what blocks production, labels and shipping', () => {
  const revision = { id: 'rev-2', revision: 2, status: 'RELEASED', styleId: JACKET.id }
  const label = { id: 'label-1', code: 'LBL-TEST', revision: 1, status: 'ACTIVE' }
  const current = (kind: DocumentFacts['kind'], language: string) => documentStatus(kind, language, 2, [doc({ kind, language, revision: 2 })])

  it('uses the work-order release\'s words for the revision, the label and the certificate, and paths per cell', () => {
    const cells = grid(base([cover('A', ['48', '50'])]))
    const checks = complianceChecks({
      styleId: JACKET.id,
      classification: classificationOf(JACKET),
      revision,
      released: revision,
      label,
      cells,
      documents: { DECLARATION_OF_CONFORMITY: [current('DECLARATION_OF_CONFORMITY', 'it')], USER_INFORMATION: [current('USER_INFORMATION', 'it')] },
    })
    expect(checks.map((check) => [check.code, check.state])).toEqual([
      ['REVISION', 'OK'],
      ['LABEL_TEMPLATE', 'OK'],
      ['CERTIFICATE', 'BLOCKED'],
      ['DECLARATION_OF_CONFORMITY', 'OK'],
      ['USER_INFORMATION', 'OK'],
    ])
    const [blocker] = blockersOf(checks)
    expect(blocker).toMatchObject({
      code: 'CERTIFICATE',
      blocks: ['PRODUCTION', 'LABELS', 'SHIPPING'],
      message: 'No valid certificate covers BLK 52 today (Reg. (EU) 2016/425): 1 of 3 cell(s).',
      problems: [{ path: `cells/${BLK}/52/certificate` }],
    })
  })

  it('blocks shipping while the DoC is for an older revision, or a language is missing', () => {
    const cells = grid(base([cover('A', [])]))
    const checks = complianceChecks({
      styleId: JACKET.id,
      classification: classificationOf(JACKET),
      revision,
      released: revision,
      label: null,
      cells,
      documents: {
        DECLARATION_OF_CONFORMITY: [documentStatus('DECLARATION_OF_CONFORMITY', 'it', 2, [doc({ revision: 1 })]), current('DECLARATION_OF_CONFORMITY', 'en')],
        USER_INFORMATION: [],
      },
    })
    const blockers = blockersOf(checks)
    expect(blockers.map((check) => check.code)).toEqual(['LABEL_TEMPLATE', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'])
    expect(blockers[0]!.message).toBe('Revision 2 names no garment label template: set one on the revision before it is released (Product › Labels).')
    expect(blockers[1]).toMatchObject({
      blocks: ['SHIPPING'],
      message: 'The EU Declaration of Conformity for revision 2 is not on file in it (Reg. (EU) 2016/425 art. 8(8), art. 15): 1 of 2 language(s).',
      problems: [{ path: 'documents/DECLARATION_OF_CONFORMITY/it', message: expect.stringMatching(/for revision 1, an older revision/) }],
    })
    expect(blockers[2]!.message).toBe('No signed user information leaflet is on file for revision 2: PPE is shipped only with it (Reg. (EU) 2016/425 art. 8(7), Annex II 1.4).')
  })

  it('asks a style that is not PPE for no certificate and no documents', () => {
    const plain = { ...JACKET, ppeCategory: 'NOT_PPE' as const, ppeStandard: null, ppeClass: null }
    const checks = complianceChecks({
      styleId: plain.id,
      classification: classificationOf(plain),
      revision,
      released: revision,
      label,
      cells: grid(base([], plain)),
      documents: { DECLARATION_OF_CONFORMITY: [], USER_INFORMATION: [] },
    })
    expect(checks.map((check) => check.state)).toEqual(['OK', 'OK', 'NOT_REQUIRED', 'NOT_REQUIRED', 'NOT_REQUIRED'])
    expect(blockersOf(checks)).toEqual([])
  })

  it('says the style has no released revision in the work order\'s words', () => {
    const checks = complianceChecks({
      styleId: JACKET.id,
      classification: classificationOf({ ...JACKET, ppeCategory: 'CATEGORY_I', ppeStandard: null, ppeClass: null }),
      revision: null,
      released: null,
      label: null,
      cells: [],
      documents: { DECLARATION_OF_CONFORMITY: [], USER_INFORMATION: [] },
    })
    expect(checks[0]).toMatchObject({ code: 'REVISION', state: 'BLOCKED', message: 'No released revision of the style is chosen. The style has no released revision: release one in Product › Styles first.' })
    expect(checks[2]).toMatchObject({ code: 'CERTIFICATE', state: 'NOT_REQUIRED' })
    expect(checks[3]).toMatchObject({ state: 'BLOCKED', message: expect.stringMatching(/no revision yet/) })
  })
})
