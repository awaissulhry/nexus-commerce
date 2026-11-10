import { describe, expect, it } from 'vitest'
import { techPackPaper } from './paper'
import { copyPartyProblem, keysOf, orderedSections, partnerForbiddenKey, sectionProblems, TECH_PACK_SECTIONS, type TechPackAudience } from './rules'
import { formatTechPackCode, readTechPackCode, scanVerdict, techPackAddress, techPackCodeHex, techPackCodeOf, type ScannedVersion, type ScanRevision } from './scan'
import { fingerprintTextOf, techPackViewOf, type BomLineFacts, type TechPackFacts } from './view'

/** A made-up revision: one leather line with a supplier, a note, an alternate and costs; a protector; a sewing step with minutes. */
const LINE: BomLineFacts = {
  id: '01900000-0000-7000-8000-000000000001',
  seq: 10,
  depth: 0,
  section: 'SHELL',
  material: { code: 'SEED-LTH-100', name: 'Cowhide 1.2 mm', kind: 'LEATHER', approval: 'APPROVED' },
  placement: 'Body',
  qty: '12.5',
  uom: 'DM2',
  wastagePct: '15',
  sizeDependent: true,
  colourDependent: false,
  bySize: [
    { size: '50', qty: '12', gross: '13.8' },
    { size: '52', qty: '12.5', gross: '14.375' },
  ],
  colour: { code: 'BLK', name: 'Black' },
  colourwayOnly: null,
  colours: [],
  option: null,
  routingStep: null,
  subAssembly: null,
  customerSupplied: false,
  customerParty: null,
  kit: true,
  properties: null,
  note: 'Cut from the back of the hide',
  supplierParty: { code: 'SEED-SUP-1', name: 'Tannery Uno Srl' },
  alternateMaterials: [{ priority: 1, material: { code: 'SEED-LTH-110', name: 'Goat 1.1 mm' }, allowedWhen: 'WITH_APPROVAL' }],
  unitCost: '0.42',
  lineCost: '6.0375',
}

const PROTECTOR: BomLineFacts = {
  ...LINE,
  id: '01900000-0000-7000-8000-000000000002',
  seq: 20,
  section: 'PROTECTION',
  material: { code: 'SEED-PRO-300', name: 'Shoulder protector', kind: 'PROTECTOR', approval: 'PENDING' },
  placement: 'Shoulder pocket',
  qty: '2',
  uom: 'PCS',
  wastagePct: '0',
  sizeDependent: false,
  bySize: [],
  colour: null,
  kit: false,
  properties: { standard: 'EN 1621-1:2012', level: '2' },
  note: null,
  supplierParty: null,
  alternateMaterials: [],
}

const FACTS: TechPackFacts = {
  style: {
    id: '01900000-0000-7000-8000-0000000000aa',
    code: 'SEED-JKT-01',
    name: 'Touring jacket',
    shortDescription: 'A made-up touring jacket',
    longDescription: null,
    textLanguage: 'en',
    season: 'FW27',
    productType: 'JACKET',
    productTypeName: 'Seed jacket',
    brand: null,
    privateLabel: false,
    sizes: [
      { code: '50', label: '50' },
      { code: '52', label: '52' },
    ],
    baseSize: '52',
    lifecycle: 'DEVELOPMENT',
    gender: 'UNISEX',
    hsCode: '42031000',
    originCountry: 'IT',
  },
  revision: { id: '01900000-0000-7000-8000-0000000000bb', revision: 2, status: 'DRAFT', releasedAt: null, effectiveFrom: null, scope: 'every colourway and size', scopeColourways: [], scopeSizes: [], completenessPct: '70', output: '1 PCS', changeNote: 'New shoulder pocket' },
  inForce: { id: '01900000-0000-7000-8000-0000000000cc', revision: 1 },
  pictures: [
    { id: '01900000-0000-7000-8000-0000000000d1', kind: 'SKETCH', ofRevision: false, colourway: null, caption: 'Front flat', isMain: false, fileId: '01900000-0000-7000-8000-0000000000e1', callouts: [] },
    { id: '01900000-0000-7000-8000-0000000000d2', kind: 'PAGE', ofRevision: true, colourway: null, caption: 'Shoulder', isMain: false, fileId: '01900000-0000-7000-8000-0000000000e2', callouts: [{ n: 1, x: '0.4', y: '0.2', text: 'Double stitch, 4 mm' }] },
  ],
  patterns: [{ id: '01900000-0000-7000-8000-0000000000f1', kind: 'PATTERN', format: 'DXF_AAMA', sizes: [], note: null, fileId: '01900000-0000-7000-8000-0000000000f2', fileName: 'jacket.dxf' }],
  lines: [LINE, PROTECTOR],
  colourways: [{ id: '01900000-0000-7000-8000-000000000101', code: 'BLK', name: 'Black', status: 'ACTIVE', colour: { code: 'RAL9005', name: 'Jet black', system: 'RAL', reference: '9005' }, description: null, colours: [] }],
  sizeSpec: {
    status: 'APPROVED',
    approved: true,
    approvedAt: '2026-11-01T10:00:00.000Z',
    baseSize: '52',
    gradeRule: 'SEED-GR-JKT',
    sizes: ['50', '52'],
    points: [{ code: 'CHEST_W', name: 'Chest width', unit: 'CM', howTo: null, values: [{ size: '50', nominal: '56', minus: '1', plus: '1', words: '56 ± 1 cm' }, { size: '52', nominal: '58', minus: '1', plus: '1', words: '58 ± 1 cm' }] }],
    missing: 0,
    words: '1 point(s) × 2 size(s), base size 52 · nothing missing · approved',
  },
  construction: {
    steps: [
      {
        seq: 10,
        code: 'SEW',
        name: 'Sew the body',
        workCentre: 'SEWING',
        instructions: null,
        forCells: null,
        settings: [{ seq: 1, machineClass: 'Lockstitch', stitchType: '301', needle: '134 LR', thread: 'Tkt 40', stitchesPerCm: '4', tension: null, foot: null, notes: null, line: 'Lockstitch · 301 · 134 LR · Tkt 40 · 4 per cm' }],
        checkpoint: null,
        instruction: { number: 'WI-0001', version: 2, steps: [{ code: 'SEAM_ALLOWANCE', words: 'Keep a 10 mm seam allowance', safety: null, critical: true, required: false, media: 1 }] },
        subcontracted: true,
        standardMinutes: '13.75',
        workshopParty: { code: 'SC-W1', name: 'Workshop Srl' },
      },
    ],
  },
  labels: { template: null, branding: null },
  protection: {
    classification: { category: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A', words: 'Category II PPE' },
    placements: [{ seq: 1, pocket: 'SHOULDER', protector: { code: 'SEED-PRO-300', name: 'Shoulder protector' }, standard: 'EN 1621-1:2012', level: '2', sizes: [], positionNote: null }],
    coverage: { required: true, covered: 4, notCovered: 0, words: 'Covered: every colourway and size.' },
    certificates: [],
    tests: [{ test: 'SEAM_STRENGTH', name: 'Main back seam', standardClause: null, frequency: 'YEARLY', dueOn: '2027-01-15', result: 'PASS', testedOn: '2026-10-01', reportNumber: 'SEED-LAB-1', hasReport: true, resultNote: null, testedBy: 'Lab person' }],
  },
  compliance: { words: 'Category II PPE', classification: { category: 'CATEGORY_II', standard: 'EN 17092-4:2020', ppeClass: 'A' }, documentsRequired: true, documents: [], blockers: [], scope: 'every colourway and size' },
  revisions: [{ revision: 1, status: 'RELEASED', releasedAt: '2026-10-01T09:00:00.000Z', effectiveFrom: '2026-10-01', effectiveTo: null, changeNote: 'First release', releasedBy: 'Office person' }],
  versions: [{ id: '01900000-0000-7000-8000-000000000201', version: 1, audience: 'INTERNAL', language: 'it', code: '00000000G1', createdAt: '2026-11-01T10:00:00.000Z', createdBy: 'Office person' }],
}

const viewFor = (audience: TechPackAudience, notAllowed = {}) => techPackViewOf(FACTS, { audience, language: 'en', sections: [...TECH_PACK_SECTIONS], notAllowed })
const META = { version: 3, printedAt: new Date('2026-11-10T09:30:00.000Z'), timeZone: 'Europe/Rome', qr: 'https://factory.example/tech-pack/01ABCDEFGH', code: 'TP 01ABC-DEFGH', party: null }

describe('the audiences (PRD-133; Owner W2b-4: no partner sees a cost, a margin or a pay figure)', () => {
  it('gives the office everything, with the costs it read for the cost grain', () => {
    const view = viewFor('INTERNAL')
    const line = view.bom!.sections[0]!.lines[0]!
    expect(line).toMatchObject({ unitCost: '0.42', lineCost: '6.0375', note: 'Cut from the back of the hide', kit: true, supplierParty: { code: 'SEED-SUP-1' }, material: { approval: 'APPROVED' } })
    expect(line.alternateMaterials).toHaveLength(1)
    expect(view.construction!.steps[0]).toMatchObject({ standardMinutes: '13.75', workshopParty: { code: 'SC-W1' } })
    expect(view.revision.changeNote).toBe('New shoulder pocket')
    expect(view.versions).toHaveLength(1)
    expect(view.leftOut).toEqual([])
  })

  it.each(['SUBCONTRACTOR', 'BRAND'] as const)('leaves every money, minutes, supplier, alternate, approval and person key out of a %s copy', (audience) => {
    const view = viewFor(audience)
    const forbidden = [...keysOf(view)].filter(partnerForbiddenKey)
    expect(forbidden).toEqual([])
    expect(JSON.stringify(view)).not.toMatch(/Tannery Uno|Workshop Srl|Office person|Lab person|0\.42|6\.0375|13\.75/)
    expect(view.leftOut.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['MONEY', 'MINUTES', 'SUPPLIERS', 'PEOPLE']))
    // The paper of a partner copy says none of it either.
    const paper = techPackPaper(view, META)
    expect([...keysOf(paper)].filter(partnerForbiddenKey)).toEqual([])
    expect(JSON.stringify(paper)).not.toMatch(/Tannery Uno|Workshop Srl|Office person|Lab person/)
  })

  it('keeps the workshop its notes and the kit mark; the brand gets neither, and no change note', () => {
    const workshop = viewFor('SUBCONTRACTOR').bom!.sections[0]!.lines[0]!
    expect(workshop).toMatchObject({ note: 'Cut from the back of the hide', kit: true })
    const brand = viewFor('BRAND')
    expect(brand.bom!.sections[0]!.lines[0]).not.toHaveProperty('note')
    expect(brand.bom!.sections[0]!.lines[0]).not.toHaveProperty('kit')
    expect(brand.revision).not.toHaveProperty('changeNote')
    expect(brand.revisionLog![0]).not.toHaveProperty('changeNote')
    expect(brand.versions).toEqual([])
  })

  it('shows a section the caller may not see as not allowed, with why, and never its content', () => {
    const view = viewFor('INTERNAL', { CONSTRUCTION: 'The construction section needs product.routing.view.' })
    expect(view.construction).toBeNull()
    expect(view.sections.find((entry) => entry.section === 'CONSTRUCTION')).toMatchObject({ allowed: false, included: false, why: 'The construction section needs product.routing.view.' })
    const some = techPackViewOf(FACTS, { audience: 'INTERNAL', language: 'en', sections: orderedSections(['SIZE_SPEC', 'BOM']), notAllowed: {} })
    expect(some.sections.filter((entry) => entry.included).map((entry) => entry.section)).toEqual(['BOM', 'SIZE_SPEC'])
    expect([some.sketches, some.construction, some.protection]).toEqual([null, null, null])
  })

  it('fingerprints what a copy says: the same view the same text, money and stored versions left out, another audience another text', () => {
    const internal = viewFor('INTERNAL')
    expect(fingerprintTextOf(internal, null)).toBe(fingerprintTextOf(viewFor('INTERNAL'), null))
    expect(fingerprintTextOf(internal, null)).not.toMatch(/unitCost|lineCost|versions/)
    expect(fingerprintTextOf(internal, null)).not.toBe(fingerprintTextOf(viewFor('SUBCONTRACTOR'), null))
    expect(fingerprintTextOf(viewFor('SUBCONTRACTOR'), null)).not.toBe(fingerprintTextOf(viewFor('SUBCONTRACTOR'), { code: 'SC-W1', name: 'Workshop Srl' }))
  })
})

describe('who a copy is for', () => {
  const style = { code: 'SEED-JKT-01', brandPartyId: null }
  const brand = { id: '01900000-0000-7000-8000-000000000301', code: 'SEED-C1', roles: ['CUSTOMER'], status: 'ACTIVE' }
  const workshop = { id: '01900000-0000-7000-8000-000000000302', code: 'SC-W1', roles: ['SUBCONTRACTOR'], status: 'ACTIVE' }
  it('names nobody on an internal copy, a party of the audience on a partner copy', () => {
    expect(copyPartyProblem('INTERNAL', style, null, false)).toBeNull()
    expect(copyPartyProblem('INTERNAL', style, brand, true)?.path).toBe('body/partyId')
    expect(copyPartyProblem('SUBCONTRACTOR', style, workshop, true)).toBeNull()
    expect(copyPartyProblem('SUBCONTRACTOR', style, brand, true)?.message).toMatch(/not a workshop/)
    expect(copyPartyProblem('BRAND', style, { ...brand, status: 'BLOCKED' }, true)?.message).toMatch(/blocked/)
  })
  it('gives a private-label style a brand copy only for its brand, named', () => {
    const own = { code: 'SEED-JKT-02', brandPartyId: brand.id }
    expect(copyPartyProblem('BRAND', own, null, false)?.message).toMatch(/say the brand/)
    expect(copyPartyProblem('BRAND', own, brand, true)).toBeNull()
    expect(copyPartyProblem('BRAND', own, { ...brand, id: '01900000-0000-7000-8000-000000000399', code: 'SEED-C2' }, true)?.message).toMatch(/another brand/)
  })
  it('refuses a section asked twice or not the caller’s, at its place', () => {
    expect(sectionProblems(['BOM', 'BOM', 'CONSTRUCTION'], new Set(['BOM']), { CONSTRUCTION: 'Needs the routing.' })).toEqual([
      { path: 'body/sections/1', message: 'BOM is asked twice.' },
      { path: 'body/sections/2', message: 'Needs the routing.' },
    ])
  })
})

describe('the QR to the current version (PRD-138)', () => {
  const id = '019a1b2c-3d4e-7f00-8a00-0123456789ab'
  it('codes the last 48 bits of the version id, read back however it is typed or scanned', () => {
    const code = techPackCodeOf(id)
    expect(code).toHaveLength(10)
    expect(techPackCodeHex(code)).toBe('0123456789ab')
    expect(readTechPackCode(formatTechPackCode(code))).toBe(code)
    expect(readTechPackCode(code.toLowerCase().replace(/0/g, 'o'))).toBe(code)
    const address = techPackAddress('https://factory.example/', code)
    expect(address).toBe(`https://factory.example/tech-pack/${code}`)
    expect(readTechPackCode(address)).toBe(code)
    expect([readTechPackCode('nonsense'), readTechPackCode('ZZZZZZZZZZ'), readTechPackCode('8000000000'), readTechPackCode(42)]).toEqual([null, null, null, null])
    // The largest 48 bits read back too (the first symbol goes up to 7).
    const top = techPackCodeOf('019a1b2c-3d4e-7f00-8a00-ffffffffffff')
    expect(top).toBe('7ZZZZZZZZZ')
    expect(techPackCodeHex(top)).toBe('ffffffffffff')
    expect(readTechPackCode(formatTechPackCode(top))).toBe(top)
  })

  const rev = (id: string, revision: number, status: ScanRevision['status']): ScanRevision => ({ id, revision, status })
  const version = (over: Partial<ScannedVersion>): ScannedVersion => ({ id: 'v', revisionId: 'r2', version: 1, audience: 'SUBCONTRACTOR', language: 'it', fingerprint: 'a', createdAt: '2026-11-10T09:00:00.000Z', ...over })
  it('says when a newer revision is in force, a newer version of the same audience says something else, or the page is current', () => {
    const page = version({ version: 2 })
    const r2 = rev('r2', 2, 'RELEASED')
    expect(scanVerdict(page, r2, [page], [rev('r1', 1, 'OBSOLETE'), r2]).state).toBe('CURRENT')
    // Another audience or the same contents again are not newer.
    expect(scanVerdict(page, r2, [page, version({ version: 3, audience: 'INTERNAL', fingerprint: 'b' }), version({ version: 4, fingerprint: 'a' })], [r2]).state).toBe('CURRENT')
    const newer = scanVerdict(page, r2, [page, version({ version: 5, fingerprint: 'c' })], [r2])
    expect(newer).toMatchObject({ state: 'NEWER_VERSION', newer: { version: 5 } })
    const r3 = rev('r3', 3, 'RELEASED')
    expect(scanVerdict(page, rev('r2', 2, 'OBSOLETE'), [page, version({ revisionId: 'r3', version: 6 })], [rev('r2', 2, 'OBSOLETE'), r3])).toMatchObject({ state: 'NEWER_REVISION', newer: { revision: 3, version: 6 } })
    expect(scanVerdict(page, rev('r2', 2, 'DRAFT'), [page], [rev('r1', 1, 'RELEASED'), rev('r2', 2, 'DRAFT')]).state).toBe('DRAFT')
    expect(scanVerdict(page, rev('r2', 2, 'OBSOLETE'), [page], [rev('r2', 2, 'OBSOLETE')]).state).toBe('OBSOLETE')
  })
})

describe('the paper', () => {
  it('prints the header words, the QR and every section asked, in its language, with no money', () => {
    const paper = techPackPaper(techPackViewOf(FACTS, { audience: 'INTERNAL', language: 'it', sections: [...TECH_PACK_SECTIONS], notAllowed: {} }), META)
    expect(paper).toMatchObject({ title: 'Scheda tecnica', styleLine: 'SEED-JKT-01 · Touring jacket', versionLine: 'Revisione 2 · bozza · versione 3', audienceLine: 'Copia interna', qr: META.qr, code: META.code })
    expect(paper.sections.map((section) => section.section)).toEqual([...TECH_PACK_SECTIONS])
    expect(paper.banner).toBe('La revisione 2 è una bozza: può cambiare prima del rilascio.')
    expect(JSON.stringify(paper)).not.toMatch(/0\.42|6\.0375/)
    // The office copy prints minutes and the workshop's name.
    expect(JSON.stringify(paper)).toMatch(/13\.75/)
    expect(JSON.stringify(paper)).toMatch(/Workshop Srl/)
  })
})
