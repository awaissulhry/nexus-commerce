import { describe, expect, it } from 'vitest'
import type { CertificateFacts } from '../../sales/portal-documents/conformity'
import { codeNames, formatPublicDocCode, publicDocAddress, publicDocCodeHex, publicDocCodeOf, publicDocPath, readPublicDocCode } from './code'
import { publicDocPage as pageSchema } from './contracts'
import { batchSpans, careLinesOf, currentRevisionOf, languageOrder, namesOf, pickPage, publicDocPage, servedFileIds, standingOf, type DocOnFile, type PublicDocFacts, type RevisionFacts } from './rules'

// Made-up ids, styles, makers and certificates only.
const WO = '0190f0e2-7101-7000-8000-00a1b2c3d4e5'
const SENDER = { companyId: '0190f0e2-7101-7000-8000-000000000001', name: 'Officina Demo', companyName: 'Officina Demo S.r.l.', logoPath: null, logoDarkPath: null, accentColour: null }
const CONTACT = { email: 'qualita@example.com' }

describe('the public DoC code', () => {
  it('is the last 40 bits of the id in Crockford base 32, 8 symbols', () => {
    expect(publicDocCodeOf(WO)).toBe(publicDocCodeOf(WO.toUpperCase()))
    expect(publicDocCodeOf(WO)).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    // 0x00a1b2c3d4e5 → its last 40 bits a1b2c3d4e5.
    expect(publicDocCodeHex(publicDocCodeOf(WO))).toBe('a1b2c3d4e5')
    expect(publicDocCodeOf('0190f0e2-7101-7000-8000-000000000000')).toBe('00000000')
    expect(publicDocCodeOf('0190f0e2-7101-7000-8000-00ffffffffff')).toBe('ZZZZZZZZ')
    expect(() => publicDocCodeOf('not-an-id')).toThrow(RangeError)
  })

  it('reads a typed code in any case, with a hyphen or spaces, O for 0 and I or L for 1, or a whole address', () => {
    const code = publicDocCodeOf(WO)
    const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`
    expect(readPublicDocCode(typed)).toBe(code)
    expect(readPublicDocCode('0O1I-L1AB')).toBe('00111' + '1AB')
    expect(readPublicDocCode(`https://factory.example.com/doc/${code}`)).toBe(code)
    expect(readPublicDocCode(`https://factory.example.com/doc/${code}?x=1`)).toBe(code)
    expect(readPublicDocCode('ABCDEFG')).toBeNull()
    expect(readPublicDocCode('ABCDEFGHJ')).toBeNull()
    expect(readPublicDocCode('ABCDEFGU')).toBeNull()
    expect(readPublicDocCode(42)).toBeNull()
    expect(readPublicDocCode('x'.repeat(40))).toBeNull()
  })

  it('names exactly the records whose id ends with its bits, and prints as two groups', () => {
    const code = publicDocCodeOf(WO)
    expect(codeNames(code, WO)).toBe(true)
    expect(codeNames(code, '0190f0e2-7101-7000-8000-00a1b2c3d4e6')).toBe(false)
    expect(codeNames(code, '0290f0e2-7101-7000-9999-00a1b2c3d4e5')).toBe(true)
    expect(formatPublicDocCode(code)).toBe(`${code.slice(0, 4)}-${code.slice(4)}`)
    expect(publicDocPath(formatPublicDocCode(code).toLowerCase())).toBe(`/doc/${code}`)
    expect(publicDocAddress('https://factory.example.com/', code)).toBe(`https://factory.example.com/doc/${code}`)
    expect(() => formatPublicDocCode('nope')).toThrow(RangeError)
  })
})

// ---- the page ------------------------------------------------------------------------------------------------------------

const day = (value: string) => new Date(`${value}T10:00:00.000Z`)
let ids = 0
const fid = () => `0190f0e2-7101-7000-8000-${String(++ids).padStart(12, '0')}`

function doc(over: Partial<DocOnFile> & Pick<DocOnFile, 'kind' | 'language' | 'revision'>): DocOnFile {
  return {
    id: fid(),
    status: 'ISSUED',
    number: over.kind === 'DECLARATION_OF_CONFORMITY' ? `DOC-DEMO-${over.revision}` : null,
    issuedAt: day('2025-03-10'),
    certificateId: null,
    makerName: 'Officina Demo S.r.l.',
    makerAddress: 'Via Esempio 1, 00000 Demoville (XX), Italia',
    file: { id: fid(), name: `${over.kind}-${over.language}-${over.revision}.pdf`, sizeBytes: 48_213, sha256: 'a'.repeat(64) },
    ...over,
  }
}

const LABEL = (languages: string[]) => ({
  makerName: 'Officina Demo S.r.l.',
  makerAddress: 'Via Esempio 1, 00000 Demoville (XX), Italia',
  importerName: null,
  importerAddress: null,
  languages,
  care: [{ symbol: 'wash-not', text: { en: 'Do not wash', it: 'Non lavare' } }],
})

const REVISIONS: RevisionFacts[] = [
  { revision: 1, releasedAt: day('2024-02-01'), label: LABEL(['it', 'en']) },
  { revision: 2, releasedAt: day('2025-03-01'), label: LABEL(['it', 'en', 'de']) },
  { revision: 3, releasedAt: day('2026-09-15'), label: LABEL(['it', 'en', 'de']) },
  { revision: 4, releasedAt: null, label: null },
]

const CERT: CertificateFacts = {
  id: '0190f0e2-7101-7000-8000-0000000000c1',
  number: 'DEMO-CERT-0001',
  standard: 'EN 17092-4:2020',
  ppeClass: 'A',
  notifiedBodyName: 'Organismo Demo',
  notifiedBodyNumber: '0000',
  validFrom: '2024-01-01',
  validTo: '2028-12-31',
  status: 'VALID',
  statusChangedOn: null,
}

function facts(over: Partial<PublicDocFacts> = {}): PublicDocFacts {
  const documents: DocOnFile[] = [
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'en', revision: 1, status: 'SUPERSEDED', issuedAt: day('2024-02-05') }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'en', revision: 2, status: 'SUPERSEDED', certificateId: CERT.id }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'de', revision: 2, status: 'SUPERSEDED' }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 2, status: 'SUPERSEDED', certificateId: CERT.id }),
    doc({ kind: 'USER_INFORMATION', language: 'en', revision: 2, status: 'SUPERSEDED' }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 3, issuedAt: day('2026-09-10') }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'en', revision: 3, issuedAt: day('2026-09-10') }),
    doc({ kind: 'USER_INFORMATION', language: 'it', revision: 3 }),
    // Never shown: a withdrawn one, a draft, an issued one whose PDF is not confirmed, a newer revision not released yet.
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'fr', revision: 3, status: 'WITHDRAWN' }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'es', revision: 3, status: 'DRAFT' }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'nl', revision: 3, file: null }),
    doc({ kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 4 }),
  ]
  return {
    kind: 'BATCH',
    code: publicDocCodeOf(WO),
    style: { code: 'DEMO-JKT-01', name: 'Giacca Demo', names: { en: 'Demo Jacket' }, category: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A', privateLabel: false },
    batch: { number: 'BA-00012', revision: 2, releasedAt: day('2025-06-02'), label: LABEL(['it', 'en', 'de']) },
    revisions: REVISIONS,
    documents,
    batches: batchSpans([
      { revision: 2, releasedAt: day('2025-03-04') },
      { revision: 2, releasedAt: day('2026-08-30') },
      { revision: 2, releasedAt: day('2025-06-02') },
      { revision: 3, releasedAt: day('2026-09-20') },
      { revision: null, releasedAt: day('2026-01-01') },
    ]),
    cited: new Map([[CERT.id, CERT]]),
    covering: [CERT],
    today: '2026-11-09',
    ...over,
  }
}

describe('the public DoC page', () => {
  it('a batch made to revision 2: its own declaration in the label languages, for batches before revision 3 took over', () => {
    const page = pageSchema.parse(publicDocPage(facts(), SENDER, CONTACT))
    expect(page.kind).toBe('BATCH')
    expect(page.product.batch).toEqual({ number: 'BA-00012', releasedOn: '2025-06-02' })
    expect(page.declaration).toMatchObject({ revision: 2, standing: 'EARLIER', before: '2026-09-15', batches: { first: '2025-03-04', last: '2026-08-30' } })
    expect(page.declaration!.files.map((file) => file.language)).toEqual(['it', 'en', 'de'])
    expect(page.declaration!.files[0]).toMatchObject({ number: 'DOC-DEMO-2', issuedOn: '2025-03-10', sizeBytes: 48_213 })
    expect(page.missing).toBeNull()
    // The leaflet of the SAME revision (only English for revision 2), and the label's care line.
    expect(page.instructions.files.map((file) => [file.language, file.name])).toEqual([['en', 'USER_INFORMATION-en-2.pdf']])
    expect(page.instructions.care).toEqual([{ symbol: 'wash-not', text: { en: 'Do not wash', it: 'Non lavare' } }])
    // The certificate the declaration cites, valid on the batch's release day.
    expect(page.certificate).toMatchObject({ number: 'DEMO-CERT-0001', notifiedBody: { name: 'Organismo Demo', number: '0000' }, day: '2025-06-02', validOnDay: true })
    // Earlier versions: revision 1 only (older than the batch's), with no batch on record.
    expect(page.versions.map((version) => [version.revision, version.issuedOn, version.batches])).toEqual([[1, '2024-02-05', null]])
    expect(page.product.maker).toEqual({ name: 'Officina Demo S.r.l.', address: 'Via Esempio 1, 00000 Demoville (XX), Italia', role: 'COMPANY' })
    expect(page.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(page.path).toBe(publicDocCodeOf(WO))
  })

  it('a style code: the newest RELEASED revision with a declaration is current (a declaration for an unreleased revision waits)', () => {
    const page = publicDocPage(facts({ kind: 'BATCH', batch: null }), SENDER, CONTACT)
    expect(page.declaration).toBeNull()
    const style = publicDocPage(facts({ kind: 'STYLE', batch: null }), SENDER, CONTACT)
    expect(style.declaration).toMatchObject({ revision: 3, standing: 'CURRENT', before: null, batches: { first: '2026-09-20', last: '2026-09-20' } })
    // Withdrawn, draft and unconfirmed files never show.
    expect(style.declaration!.files.map((file) => file.language)).toEqual(['it', 'en'])
    expect(style.versions.map((version) => version.revision)).toEqual([2, 1])
    expect(style.versions[0]!.declarations.map((file) => file.language)).toEqual(['it', 'en', 'de'])
    expect(style.versions[0]!.instructions.map((file) => file.language)).toEqual(['en'])
    expect(style.certificate).toMatchObject({ day: '2026-11-09', validOnDay: true })
    expect(style.product.batch).toBeNull()
    // Every file the page serves, and nothing else (the file route answers only these).
    const served = servedFileIds(style)
    expect(served.size).toBe(2 + 1 + 3 + 1 + 1)
    expect([...served].every((value) => style.declaration!.files.some((file) => file.fileId === value) || style.instructions.files.some((file) => file.fileId === value) || style.versions.some((version) => [...version.declarations, ...version.instructions].some((file) => file.fileId === value)))).toBe(true)
  })

  it('the current revision falls back to the newest published one when none is released; none published → null', () => {
    const unreleased = REVISIONS.map((revision) => ({ ...revision, releasedAt: null }))
    expect(currentRevisionOf(unreleased, facts().documents)).toBe(4)
    expect(currentRevisionOf(REVISIONS, [])).toBeNull()
    expect(standingOf(3, REVISIONS, facts().documents)).toEqual({ standing: 'CURRENT', before: null })
  })

  it('a batch whose revision has no declaration yet says NOT_PUBLISHED; not PPE says NOT_PPE and names no certificate', () => {
    const missing = publicDocPage(facts({ batch: { number: 'BA-00013', revision: 4, releasedAt: day('2026-11-02'), label: null } }), SENDER, CONTACT)
    // Revision 4's Italian declaration is issued: a batch made to it shows it, CURRENT (no later released revision).
    expect(missing.declaration).toMatchObject({ revision: 4, standing: 'CURRENT' })
    const none = publicDocPage(facts({ batch: { number: 'BA-00014', revision: 5, releasedAt: day('2026-11-02'), label: null } }), SENDER, CONTACT)
    expect(none.declaration).toBeNull()
    expect(none.missing).toBe('NOT_PUBLISHED')
    expect(none.versions.map((version) => version.revision)).toEqual([4, 3, 2, 1])
    const notPpe = publicDocPage(facts({ style: { ...facts().style, category: 'NOT_PPE', standard: null, ppeClass: null } }), SENDER, CONTACT)
    expect(notPpe).toMatchObject({ declaration: null, missing: 'NOT_PPE', certificate: null, versions: [] })
    expect(notPpe.ppe.certificateRequired).toBe(false)
  })

  it('category I names no notified body; a private label names the brand as the legal maker', () => {
    const categoryOne = publicDocPage(facts({ style: { ...facts().style, category: 'CATEGORY_I' } }), SENDER, CONTACT)
    expect(categoryOne.certificate).toBeNull()
    expect(categoryOne.ppe.certificateRequired).toBe(false)
    expect(categoryOne.declaration).not.toBeNull()
    const brand = publicDocPage(facts({ style: { ...facts().style, privateLabel: true } }), SENDER, CONTACT)
    expect(brand.product.maker?.role).toBe('BRAND')
  })

  it('a certificate not valid on the day: a covering one valid then wins, else the cited one shown as not valid', () => {
    const lapsed: CertificateFacts = { ...CERT, validTo: '2025-01-31', status: 'EXPIRED' }
    const renewed: CertificateFacts = { ...CERT, id: '0190f0e2-7101-7000-8000-0000000000c2', number: 'DEMO-CERT-0002', validFrom: '2025-02-01' }
    const both = publicDocPage(facts({ cited: new Map([[CERT.id, lapsed]]), covering: [lapsed, renewed] }), SENDER, CONTACT)
    expect(both.certificate).toMatchObject({ number: 'DEMO-CERT-0002', validOnDay: true })
    const alone = publicDocPage(facts({ cited: new Map([[CERT.id, lapsed]]), covering: [] }), SENDER, CONTACT)
    expect(alone.certificate).toMatchObject({ number: 'DEMO-CERT-0001', validOnDay: false, validTo: '2025-01-31' })
    const none = publicDocPage(facts({ cited: new Map(), covering: [] }), SENDER, CONTACT)
    expect(none.certificate).toBeNull()
  })

  it('the helpers: language order, care lines and names as stored', () => {
    expect(languageOrder(['fr', 'de', 'it', 'en'], ['IT', 'en'])).toEqual(['it', 'en', 'de', 'fr'])
    expect(careLinesOf([{ symbol: 'wash-30', text: { en: 'Wash at 30', it: '', de: 3 } }, { symbol: '' }, 'x', null])).toEqual([{ symbol: 'wash-30', text: { en: 'Wash at 30' } }])
    expect(careLinesOf({})).toEqual([])
    expect(namesOf({ it: 'Giacca', en: 7, de: ' ' })).toEqual({ it: 'Giacca' })
    expect(namesOf(['x'])).toEqual({})
  })

  it('two records under one code (rare): the page asked for, naming the other so the reader picks the one on the label', () => {
    const batch = publicDocPage(facts(), SENDER, CONTACT)
    const style = publicDocPage(facts({ kind: 'STYLE', batch: null, style: { ...facts().style, code: 'DEMO-JKT-09', name: 'Altra Giacca' } }), SENDER, CONTACT)
    expect(pickPage([batch], 0)).toMatchObject({ n: 0, others: [] })
    expect(pickPage([batch, style], 0)).toMatchObject({ n: 0, product: { batch: { number: 'BA-00012' } }, others: [{ n: 1, style: { code: 'DEMO-JKT-09', name: 'Altra Giacca' }, batch: null }] })
    expect(pickPage([batch, style], 1)).toMatchObject({ n: 1, kind: 'STYLE', others: [{ n: 0, style: { code: 'DEMO-JKT-01' }, batch: 'BA-00012' }] })
    expect(pickPage([batch], 1)).toBeNull()
    expect(pickPage([], 0)).toBeNull()
  })
})
