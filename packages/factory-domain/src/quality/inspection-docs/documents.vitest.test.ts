import { describe, expect, it } from 'vitest'
import { certificateFingerprintText, certificateProblems, conformityCertificate, fingerprintText, inspectionReport, type CertificateInput, type ReportInput } from './documents'

const company = { name: 'Example Factory S.r.l.', lines: ['Via Esempio 1, 20100 Milano MI'], legal: 'Example Factory S.r.l. · VAT IT00000000000' }

const report = (changes: Partial<ReportInput> = {}): ReportInput => ({
  language: 'en',
  date: '2026-11-03',
  company,
  inspection: { number: 'INS-A-2026-0004', status: 'PASSED', computedResult: 'PASS', overrideReason: null, decidedOn: '2026-11-02', signatureSha256: 'c'.repeat(64), note: 'Checked under daylight.', noteAmended: [1] },
  workOrder: { number: 'WO-0001', batchNumber: 'B-0001', style: { code: 'JKT-02', name: 'Touring jacket', revision: 2 } },
  sampling: { lotSize: 48, sampleSize: 8, inspectionLevel: 'II', codeLetter: 'C', aqlMajor: '2.500', aqlMinor: '4.000', acceptMajor: 0, acceptMinor: 1, plan: 'FIN-JACKET v1' },
  counts: { critical: 0, major: 0, minor: 1 },
  inspector: 'Example Inspector',
  checks: [{ code: 'CE_MARK', label: 'CE marking', checkClass: 'CRITICAL', results: [{ unit: 1, outcome: 'PASS', value: null, note: null, amended: [] }] }],
  checklist: [],
  measurements: [
    { pointCode: 'CHEST', size: '52', unit: 1, nominal: '58.000', tolerance: '1.000', measured: '58.600', uom: 'CM', pass: true, amended: [1] },
    { pointCode: 'SLEEVE', size: '52', unit: 2, nominal: '64.000', tolerance: '1.000', measured: '65.800', uom: 'CM', pass: false, amended: [] },
  ],
  identity: { mode: 'BATCH', ok: true, words: 'Batch B-0001 checked.' },
  defects: [{ defectClass: 'MINOR', code: 'STITCH-SKIP', zone: 'ELBOW_L', quantity: 1, description: null, note: 'One skipped stitch.', cause: null, amended: [], zoneAmended: [] }],
  photos: [{ fileId: 'f1', sha256: 'd'.repeat(64), caption: 'FRONT · unit 1' }],
  photosLeftOut: 1,
  releases: [{ number: 'REL-A-2026-0002', garments: 40, reversed: 2, releasedOn: '2026-11-02', by: null }],
  amendments: [{ ref: 1, field: 'Measured value', from: '58.4', to: '58.6', reason: 'Typed 58.4 for 58.6.', askedBy: 'Example Inspector', signedBy: 'Example Manager', signedOn: '2026-11-03' }],
  sample: false,
  ...changes,
})

describe('inspectionReport', () => {
  it('prints the result, the AQL table, checks, measurements, defects with photos, signatures and the corrections', () => {
    const document = inspectionReport(report())
    expect(document.title).toBe('Final inspection report')
    expect(document.facts).toEqual(expect.arrayContaining([{ label: 'Result', value: 'PASSED' }, { label: 'Inspection plan', value: 'FIN-JACKET v1' }]))
    const headings = document.sections.map((section) => section.heading)
    expect(headings).toEqual(['Sampling (ISO 2859-1, single sampling)', 'Checks', 'Measurements', 'Serial and batch check', 'Defects found', 'Photos', 'Note', 'Signatures', 'Corrections after signing'])
    const aql = document.sections[0]!.table!
    expect(aql.rows.map((row) => row[0])).toEqual(['Critical', 'Major', 'Minor'])
    expect(aql.rows[2]).toEqual(['Minor', '4', '1', '2', '1', 'accept'])
    const measures = document.sections[2]!.table!.rows
    expect(measures[0]![4]).toBe('58.6 [A1]')
    expect(measures[1]![5]).toBe('Fail: over by 0.8 cm')
    expect(document.sections[3]!.lines[0]).toBe('Batch: passed · Batch B-0001 checked.')
    expect(document.sections[4]!.table!.rows[0]![2]).toBe('Left elbow')
    expect(document.sections[5]!.photos).toHaveLength(1)
    expect(document.sections[5]!.lines[0]).toMatch(/1 photo is not printed/)
    expect(document.sections[6]!.lines).toEqual(['Checked under daylight. [A1]'])
    expect(document.sections[7]!.lines[0]).toMatch(/^Result signed by Example Inspector on .* · e-signature cccccccccccccccc…$/)
    // A floor releaser is the bench, never a name.
    expect(document.sections[7]!.lines[1]).toBe('REL-A-2026-0002: 40 garments released on 2 Nov 2026 at the bench (PIN) · 2 taken back')
    expect(document.sections[8]!.lines).toEqual(['A1 · Measured value: from 58.4 to 58.6', 'Reason: Typed 58.4 for 58.6. · asked by Example Inspector, countersigned by Example Manager on 3 Nov 2026'])
    expect(document.fileName).toBe('Inspection-report-INS-A-2026-0004-en.pdf')
  })

  it('a bench inspector is never named; an override says it was the inspector\'s decision; Italian words', () => {
    const document = inspectionReport(report({ language: 'it', inspector: null, inspection: { ...report().inspection, computedResult: 'FAIL', overrideReason: 'Minors within the customer\'s limit.' } }))
    expect(document.facts.find((fact) => fact.label === 'Esito')!.value).toBe("CONFORME (decisione dell'ispettore sul risultato calcolato (NON CONFORME))")
    expect(document.sections.find((section) => section.heading === 'Firme')!.lines[0]).toMatch(/^Esito firmato dall'ispettore al banco \(PIN\)/)
    expect(document.sections[0]!.lines).toContain("Minors within the customer's limit.")
    expect(document.sections.find((section) => section.heading === 'Misure')!.table!.rows[1]![5]).toBe('Non conforme: oltre di 0.8 cm')
  })

  it('the fingerprint leaves out the date and the banner, not the contents', () => {
    const kept = inspectionReport(report())
    expect(fingerprintText(inspectionReport(report({ date: '2026-12-01', sample: true })))).toBe(fingerprintText(kept))
    expect(fingerprintText(inspectionReport(report({ counts: { critical: 0, major: 1, minor: 1 } })))).not.toBe(fingerprintText(kept))
  })

  it('carries no money, wages or cost key anywhere', () => {
    expect(JSON.stringify(inspectionReport(report()))).not.toMatch(/cost|price|margin|wage|amount/i)
  })
})

const certificate = (changes: Partial<CertificateInput> = {}): CertificateInput => ({
  language: 'en',
  date: '2026-11-03',
  company,
  shipment: { number: 'SH-0001', shippedOn: '2026-11-03' },
  customer: { name: 'Example Moto S.p.A.', vatNumber: null },
  order: { number: 'SO-0002', customerRef: 'PO-77' },
  ddt: { number: '144/2026', date: '2026-10-30' },
  lines: [{ style: { code: 'JKT-02', name: 'Touring jacket', revision: 2 }, colourway: 'BLK Black', size: '50', garments: 1, workOrder: 'WO-0001', batchNumber: 'B-0001', inspections: ['INS-1'], releases: ['REL-1'] }],
  declarations: [{ style: 'JKT-02 rev. 2', number: 'DOC-JKT-02-2', language: 'en' }],
  issuer: 'Example Inspector',
  sample: false,
  ...changes,
})

describe('conformityCertificate', () => {
  it('states the goods with their inspections and releases, the PPE declarations and who issued it', () => {
    const document = conformityCertificate(certificate())
    expect(document.title).toBe('Certificate of conformity')
    expect(document.sections[0]!.lines[0]).toMatch(/^Example Factory S\.r\.l\. declares that the 1 garments of this shipment/)
    expect(document.sections[1]!.table!.rows[0]).toEqual(['JKT-02 Touring jacket · revision 2', 'BLK Black 50', '1', 'WO-0001 · B-0001', 'INS-1', 'REL-1'])
    expect(document.sections[2]!.lines).toEqual(['JKT-02 rev. 2: DOC-JKT-02-2 (en)'])
    expect(conformityCertificate(certificate({ declarations: [{ style: 'JKT-02 rev. 2', number: null, language: '-' }] })).sections[2]!.lines).toEqual(['JKT-02 rev. 2: EU declaration of conformity not on file'])
    expect(document.sections[3]!.lines[0]).toBe('Example Inspector, quality · 3 Nov 2026')
    expect(JSON.stringify(document)).not.toMatch(/cost|price|margin|wage|amount/i)
  })

  it('the same goods give the same fingerprint whoever issues it', () => {
    expect(certificateFingerprintText(conformityCertificate(certificate({ issuer: 'Someone Else', date: '2026-11-09' })))).toBe(certificateFingerprintText(conformityCertificate(certificate())))
  })

  it('is issued of packed or gone goods that stand released, never of a draft or reversed goods', () => {
    expect(certificateProblems({ status: 'SHIPPED', lines: 1, cells: [{ label: 'JKT-02 BLK 50', onShipment: 1, onShipments: 1, released: 1 }] })).toEqual([])
    expect(certificateProblems({ status: 'DRAFT', lines: 1, cells: [] })[0]).toMatch(/draft/)
    expect(certificateProblems({ status: 'RETURNED', lines: 1, cells: [] })[0]).toMatch(/returned/)
    expect(certificateProblems({ status: 'PACKED', lines: 0, cells: [] })).toEqual(['The shipment has no garments.'])
    expect(certificateProblems({ status: 'PACKED', lines: 1, cells: [{ label: 'JKT-02 BLK 52', onShipment: 2, onShipments: 2, released: 1 }] })[0]).toMatch(/2 garments on shipments, 1 released now/)
  })
})
