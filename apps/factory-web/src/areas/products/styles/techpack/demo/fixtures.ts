import { orderedSections, type TechPackAudience, type TechPackLanguage, type TechPackSection } from '@nexus/factory-domain/product/techpack/rules'
import { techPackCodeOf } from '@nexus/factory-domain/product/techpack/scan'
import { techPackViewOf, type BomLineFacts, type TechPackFacts } from '@nexus/factory-domain/product/techpack/view'
import { BRANDS, REV, STYLE_ID, WORKSHOPS } from '../../demo/fixtures'
import type { CopyPartyRow, ScanView, TechPackVersion, TechPackView } from '../api'

/**
 * Made-up data for the tech pack's design cases (B-W2b-243; SCR-305, SCR-306): the jacket DEMO-JKT-01 of the styles demo,
 * revision 3 in draft (revision 2 released, revision 1 obsolete), its BOM, colourways, size spec, routing with settings and a
 * work instruction, labels, protectors, certificates and tests, and the PDF versions made of it. Every code, name and number
 * is invented. The audiences' copies are made by factory-domain's own `techPackViewOf`: what a partner never gets is absent
 * here exactly as the API leaves it out.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

const SIZES = ['46', '48', '50', '52', '54', '56', '58']

const line = (n: number, section: string, code: string, name: string, kind: string, extra: Partial<BomLineFacts> = {}): BomLineFacts => ({
  id: uid('7401', n),
  seq: n * 10,
  depth: 0,
  section,
  material: { code, name, kind, approval: 'APPROVED' },
  placement: null,
  qty: '1',
  uom: 'PCS',
  wastagePct: '0',
  sizeDependent: false,
  colourDependent: false,
  bySize: [],
  colour: null,
  colourwayOnly: null,
  colours: [],
  option: null,
  routingStep: null,
  subAssembly: null,
  customerSupplied: false,
  customerParty: null,
  kit: false,
  properties: null,
  note: null,
  supplierParty: null,
  alternateMaterials: [],
  unitCost: '1.20',
  lineCost: '1.20',
  ...extra,
})

const LINES: BomLineFacts[] = [
  line(1, 'SHELL', 'PEL-DEMO-12', 'Pelle bovina pieno fiore 1,2 mm', 'LEATHER', {
    placement: 'Davanti, dietro, maniche',
    qty: '1.85',
    uom: 'M2',
    wastagePct: '12',
    sizeDependent: true,
    bySize: SIZES.map((size, index) => ({ size, qty: size === '58' ? null : (1.6 + index * 0.08).toFixed(2), gross: null })),
    colourDependent: true,
    colours: [
      { colourway: 'NERO', colour: { code: 'NERO', name: 'Nero' } },
      { colourway: 'ANTR', colour: { code: 'ANTR', name: 'Antracite' } },
      { colourway: 'ROSSO', colour: { code: 'ROSSO', name: 'Rosso corsa' } },
    ],
    supplierParty: { code: 'CONC-DEMO', name: 'Conceria Esempio S.r.l.' },
    alternateMaterials: [{ priority: 1, material: { code: 'PEL-DEMO-13', name: 'Pelle bovina 1,3 mm' }, allowedWhen: 'Con approvazione del cliente' }],
    note: 'Tagliare con il fiore verso l’alto; niente difetti di classe B sul davanti.',
    unitCost: '38.50',
    lineCost: '79.77',
    kit: true,
  }),
  line(2, 'LINING', 'FOD-DEMO-03', 'Fodera in rete traspirante', 'LINING', { placement: 'Busto', qty: '1.10', uom: 'M', unitCost: '4.10', lineCost: '4.51', kit: true }),
  line(3, 'PROTECTION', 'DEMO-PRO-S2', 'Protezione spalla livello 2', 'PROTECTOR', { placement: 'Tasche spalla', qty: '2', unitCost: '6.40', lineCost: '12.80', supplierParty: { code: 'PROT-DEMO', name: 'Protezioni Demo S.p.A.' } }),
  line(4, 'PROTECTION', 'DEMO-PRO-L1', 'Protezione gomito livello 1', 'PROTECTOR', { placement: 'Tasche gomito', qty: '2', unitCost: '4.90', lineCost: '9.80', customerSupplied: true, customerParty: { code: 'BR-DEMO', name: 'Esempio Moto' }, material: { code: 'DEMO-PRO-L1', name: 'Protezione gomito livello 1', kind: 'PROTECTOR', approval: 'CONDITIONAL' } }),
  line(5, 'TRIMS', 'ZIP-DEMO-8', 'Cerniera divisibile n. 8', 'HARDWARE', { placement: 'Chiusura davanti', colour: { code: 'NERO', name: 'Nero' }, routingStep: { seq: 50, code: 'CUC-ZIP' }, unitCost: '3.20', lineCost: '3.20', option: 'Cerniera a contrasto' }),
  line(6, 'THREAD', 'FIL-DEMO-40', 'Filo poliestere 40', 'THREAD', { qty: '320', uom: 'M', unitCost: '0.004', lineCost: '1.28' }),
  line(7, 'LABELS', 'ETI-DEMO-DPI', 'Etichetta DPI cucita', 'LABEL', { placement: 'Fodera, fianco sinistro', unitCost: '0.35', lineCost: '0.35' }),
  line(8, 'PACKAGING', 'SAC-DEMO-01', 'Sacchetto con avviso di soffocamento', 'PACKAGING', { unitCost: '0.22', lineCost: '0.22' }),
]

const PICTURES: TechPackFacts['pictures'] = [
  { id: uid('7402', 1), kind: 'SKETCH', ofRevision: false, colourway: null, caption: 'Davanti e dietro', isMain: true, fileId: uid('7403', 1), callouts: [] },
  { id: uid('7402', 2), kind: 'PHOTO', ofRevision: true, colourway: { code: 'ROSSO', name: 'Rosso corsa' }, caption: 'Campione di forma, variante rossa', isMain: false, fileId: uid('7403', 2), callouts: [] },
  {
    id: uid('7402', 3),
    kind: 'PAGE',
    ofRevision: true,
    colourway: null,
    caption: 'Spalla e manica',
    isMain: false,
    fileId: uid('7403', 3),
    callouts: [
      { n: 1, x: '0.32', y: '0.18', text: 'Doppia cucitura a 6 mm, punto 301' },
      { n: 2, x: '0.55', y: '0.40', text: 'Travetta a fine tasca spalla' },
    ],
  },
]

const BASE: TechPackFacts = {
  style: {
    id: STYLE_ID,
    code: 'DEMO-JKT-01',
    name: 'Giacca Touring Demo',
    shortDescription: 'Giacca touring in pelle con protezioni spalla e gomito, membrana impermeabile.',
    longDescription: null,
    textLanguage: 'it',
    season: 'AW27',
    productType: 'JACKET',
    productTypeName: null,
    brand: null,
    privateLabel: false,
    sizes: SIZES.map((code) => ({ code, label: code })),
    baseSize: '52',
    lifecycle: 'SAMPLING',
    gender: 'UNISEX',
    hsCode: '4203 10 00',
    originCountry: 'IT',
  },
  revision: {
    id: REV.r3,
    revision: 3,
    status: 'DRAFT',
    releasedAt: null,
    effectiveFrom: null,
    scope: 'x',
    scopeColourways: [],
    scopeSizes: [],
    completenessPct: '86',
    output: '1 PCS',
    changeNote: 'Ginocchiere e gomitiere livello 2; cerniera a contrasto.',
  },
  inForce: { id: REV.r2, revision: 2 },
  pictures: PICTURES,
  patterns: [
    { id: uid('7404', 1), kind: 'PATTERN', format: 'DXF_AAMA', sizes: [], note: 'Cartamodello completo, tutte le taglie', fileId: uid('7405', 1), fileName: 'DEMO-JKT-01-r3.dxf' },
    { id: uid('7404', 2), kind: 'MARKER', format: null, sizes: ['50', '52'], note: null, fileId: uid('7405', 2), fileName: 'piazzamento-50-52.pdf' },
  ],
  lines: LINES,
  colourways: [
    { id: uid('7777', 11), code: 'NERO', name: 'Nero', status: 'ACTIVE', colour: { code: 'NERO', name: 'Nero', system: 'PANTONE', reference: '19-0303 TCX' }, description: 'Cuciture tono su tono.', colours: [{ seq: 10, material: { code: 'PEL-DEMO-12', name: 'Pelle bovina' }, colour: { code: 'NERO', name: 'Nero' }, used: true }] },
    { id: uid('7777', 12), code: 'ANTR', name: 'Antracite', status: 'ACTIVE', colour: { code: 'ANTR', name: 'Antracite', system: null, reference: null }, description: 'Pannelli spalla neri.', colours: [{ seq: 10, material: { code: 'PEL-DEMO-12', name: 'Pelle bovina' }, colour: { code: 'ANTR', name: 'Antracite' }, used: true }] },
    { id: uid('7777', 13), code: 'ROSSO', name: 'Rosso corsa', status: 'ACTIVE', colour: { code: 'ROSSO', name: 'Rosso corsa', system: null, reference: null }, description: null, colours: [{ seq: 10, material: { code: 'PEL-DEMO-12', name: 'Pelle bovina' }, colour: null, used: false }] },
  ],
  sizeSpec: {
    status: 'DRAFT',
    approved: false,
    approvedAt: null,
    baseSize: '52',
    gradeRule: 'Giacche EU +2 cm',
    sizes: SIZES,
    points: [
      { code: 'A', name: 'Petto ½', unit: 'cm', howTo: '2 cm sotto il giromanica', values: SIZES.map((size, index) => ({ size, nominal: String(52 + index * 2), minus: '1', plus: '1', words: 'x' })) },
      { code: 'B', name: 'Lunghezza dietro', unit: 'cm', howTo: null, values: SIZES.map((size, index) => (size === '58' ? null : { size, nominal: String(70 + index), minus: '0.5', plus: '1', words: 'x' })) },
    ],
    missing: 1,
    words: 'x',
  },
  construction: {
    steps: [
      { seq: 10, code: 'TAG-PEL', name: 'Taglio pelle', workCentre: 'CUTTING', instructions: null, forCells: null, settings: [], checkpoint: 'Controllo difetti sulla pelle prima del taglio', instruction: null, subcontracted: false, standardMinutes: '18.5', workshopParty: null },
      {
        seq: 30,
        code: 'CUC-SPALLA',
        name: 'Cucitura spalla',
        workCentre: 'SEWING',
        instructions: 'Allineare le tacche.',
        forCells: null,
        settings: [{ seq: 1, machineClass: 'Lineare 1 ago', stitchType: '301', needle: '110', thread: 'Poliestere 40', stitchesPerCm: '3.5', tension: null, foot: null, notes: null, line: 'Lineare 1 ago · punto 301 · ago 110 · filo poliestere 40 · 3,5 punti/cm' }],
        checkpoint: 'Controllo cucitura su ogni capo',
        instruction: {
          number: 'WI-DEMO-0007',
          version: 2,
          steps: [
            { code: 'ALIGN', words: 'Allinea davanti e dietro sulle tacche', safety: null, critical: false, required: true, media: 1 },
            { code: 'SEAM', words: 'Cuci a 10 mm dal bordo', safety: 'Mani lontane dal piedino', critical: true, required: true, media: 2 },
          ],
        },
        subcontracted: false,
        standardMinutes: '6.2',
        workshopParty: null,
      },
      { seq: 50, code: 'CUC-ZIP', name: 'Cucitura cerniera', workCentre: 'SEWING', instructions: null, forCells: 'Solo con l’opzione cerniera a contrasto', settings: [], checkpoint: null, instruction: null, subcontracted: true, standardMinutes: '4.0', workshopParty: { code: WORKSHOPS[0]!.code, name: WORKSHOPS[0]!.tradeName ?? WORKSHOPS[0]!.legalName } },
    ],
  },
  labels: {
    template: {
      code: 'ETI-DEMO-JKT',
      revision: 2,
      name: 'Etichetta giacca touring',
      status: 'ACTIVE',
      kind: 'PPE_GARMENT',
      languages: ['it', 'en', 'de'],
      maker: 'Fabbrica Esempio S.r.l., Via Esempio 1, Città Demo',
      composition: [{ part: 'Esterno', fibres: [{ fibre: 'pelle bovina', percent: '100' }] }],
      care: [{ symbol: 'NO_WASH', text: 'Non lavare' }],
      animalOriginPhrase: true,
      qrTarget: 'DoC pubblica',
      size: '40 × 80 mm',
    },
    branding: null,
  },
  protection: {
    classification: { category: 'CATEGORY_II', standard: 'EN 17092-3:2020', ppeClass: 'A', words: 'x' },
    placements: [
      { seq: 1, pocket: 'SHOULDER', protector: { code: 'DEMO-PRO-S2', name: 'Protezione spalla livello 2' }, standard: 'EN 1621-1:2012', level: '2', sizes: [], positionNote: 'Nella testa manica' },
      { seq: 2, pocket: 'ELBOW', protector: { code: 'DEMO-PRO-L1', name: 'Protezione gomito livello 1' }, standard: 'EN 1621-1:2012', level: '1', sizes: ['46', '48', '50', '52', '54'], positionNote: null },
    ],
    coverage: { required: true, covered: 18, notCovered: 2, words: 'x' },
    certificates: [
      { number: 'CE-DEMO-0042', standard: 'EN 17092-3:2020', ppeClass: 'A', notifiedBody: 'Laboratorio Prove Demo', notifiedBodyNumber: '0000', validFrom: '2025-03-01', validTo: '2030-02-28', status: 'VALID', colourways: [], sizes: SIZES.slice(0, 6), performanceLevels: { shoulder: '2', elbow: '1' } },
    ],
    tests: [
      { test: 'SEAM_STRENGTH', name: null, standardClause: 'EN 17092-1 §6.3', frequency: 'EVERY_BATCH', dueOn: '2026-11-20', result: null, testedOn: null, reportNumber: null, hasReport: false, resultNote: null, testedBy: null },
      { test: 'POCKET_RETENTION', name: null, standardClause: null, frequency: 'QUARTERLY', dueOn: '2026-10-01', result: 'PASS', testedOn: '2026-09-28', reportNumber: 'RP-DEMO-118', hasReport: true, resultNote: null, testedBy: 'Laboratorio interno' },
    ],
  },
  compliance: {
    words: 'x',
    classification: { category: 'CATEGORY_II', standard: 'EN 17092-3:2020', ppeClass: 'A' },
    documentsRequired: true,
    documents: [
      { kind: 'DECLARATION_OF_CONFORMITY', language: 'it', state: 'CURRENT', words: 'x' },
      { kind: 'USER_INFORMATION', language: 'it', state: 'OLDER_REVISION', words: 'x' },
      { kind: 'USER_INFORMATION', language: 'en', state: 'MISSING', words: 'x' },
    ],
    blockers: ['x', 'x'],
    scope: 'x',
  },
  revisions: [
    { revision: 3, status: 'DRAFT', releasedAt: null, effectiveFrom: null, effectiveTo: null, changeNote: 'Ginocchiere e gomitiere livello 2; cerniera a contrasto.', releasedBy: null },
    { revision: 2, status: 'RELEASED', releasedAt: at(12, 15), effectiveFrom: '2026-10-12', effectiveTo: null, changeNote: 'Membrana impermeabile in tutto il busto.', releasedBy: 'Utente Demo' },
    { revision: 1, status: 'OBSOLETE', releasedAt: at(5, 11), effectiveFrom: '2026-10-05', effectiveTo: '2026-10-12', changeNote: null, releasedBy: 'Utente Demo' },
  ],
  versions: [],
}

/** The PDF versions of revision 3 (newest first): a workshop copy in Italian (v3), a customer copy in English (v2), the first workshop copy (v1). */
const version = (n: number, version: number, audience: TechPackAudience | null, language: TechPackLanguage, day: number): TechPackVersion => {
  const id = uid('7406', n)
  return { id, version, audience, language, code: techPackCodeOf(id), createdAt: at(day, 9 + version), createdBy: 'Utente Demo', fileId: uid('7407', n) }
}
export const VERSIONS: TechPackVersion[] = [version(3, 3, 'SUBCONTRACTOR', 'it', 30), version(2, 2, 'BRAND', 'en', 29), version(1, 1, 'SUBCONTRACTOR', 'it', 28)]

export interface DemoOptions {
  audience?: TechPackAudience
  language?: TechPackLanguage
  /** The cost grain: an internal preview's line costs. */
  cost?: boolean
  /** Sections the reader may not see (their permission), with why. */
  notAllowed?: Partial<Record<TechPackSection, string>>
  revision?: 'draft' | 'released' | 'obsolete'
  privateLabel?: boolean
}

/** The live tech pack of DEMO-JKT-01 for an audience, as the API answers it (factory-domain's own rule leaves out the rest). */
export function demoTechPack(options: DemoOptions = {}): TechPackView {
  const revision =
    options.revision === 'released'
      ? { ...BASE.revision, id: REV.r2, revision: 2, status: 'RELEASED', releasedAt: at(12, 15), effectiveFrom: '2026-10-12', scopeColourways: ['NERO', 'ANTR'], scopeSizes: [], completenessPct: '100', changeNote: 'Membrana impermeabile in tutto il busto.' }
      : options.revision === 'obsolete'
        ? { ...BASE.revision, id: REV.r1, revision: 1, status: 'OBSOLETE', releasedAt: at(5, 11), effectiveFrom: '2026-10-05', scopeColourways: [], scopeSizes: ['46', '48', '50', '52', '54'], completenessPct: '100', changeNote: null }
        : BASE.revision
  const brand = options.privateLabel ? { code: BRANDS[0]!.code, name: BRANDS[0]!.tradeName ?? BRANDS[0]!.legalName } : null
  const facts: TechPackFacts = {
    ...BASE,
    style: { ...BASE.style, brand, privateLabel: !!options.privateLabel },
    revision,
    inForce: options.revision === 'released' ? null : BASE.inForce,
    lines: options.cost === false ? LINES.map(({ unitCost: _unit, lineCost: _line, ...rest }) => rest) : LINES,
    versions: VERSIONS.map(({ fileId: _file, createdBy, ...entry }) => ({ ...entry, createdBy: createdBy ?? null })),
  }
  const notAllowed = options.notAllowed ?? {}
  return techPackViewOf(facts, { audience: options.audience ?? 'INTERNAL', language: options.language ?? 'it', sections: orderedSections(undefined), notAllowed })
}

/** What a role without the routing and the certificates sees (the API's words: the screen says its own). */
export const NOT_ALLOWED_VIEWER: Partial<Record<TechPackSection, string>> = { CONSTRUCTION: 'x', PROTECTION: 'x', COMPLIANCE: 'x' }

export const PARTIES: { SUBCONTRACTOR: CopyPartyRow[]; BRAND: CopyPartyRow[] } = {
  SUBCONTRACTOR: WORKSHOPS.slice(0, 2).map(({ companyId: _company, ...row }) => row),
  BRAND: [...BRANDS, { id: uid('6668', 1), code: 'CLI-DEMO-07', legalName: 'Moto Abbigliamento Demo S.r.l.', tradeName: null }],
}

/** A scanned page: version `printed` of revision 3, with what the API says of it. */
export function demoScan(state: ScanView['state']): ScanView {
  const printed = { styleId: STYLE_ID, styleCode: 'DEMO-JKT-01', revisionId: REV.r3, revision: 3, revisionStatus: 'DRAFT', version: 1, audience: 'SUBCONTRACTOR' as const, language: 'it', createdAt: at(28, 10) }
  const code = techPackCodeOf(VERSIONS[2]!.id)
  switch (state) {
    case 'NEWER_VERSION':
      return { code: `TP ${code.slice(0, 5)}-${code.slice(5)}`, state, words: 'x', printed, newer: { revisionId: REV.r3, revision: 3, version: 3, createdAt: VERSIONS[0]!.createdAt } }
    case 'NEWER_REVISION':
      return { code: `TP ${code.slice(0, 5)}-${code.slice(5)}`, state, words: 'x', printed: { ...printed, revisionId: REV.r1, revision: 1, revisionStatus: 'OBSOLETE' }, newer: { revisionId: REV.r3, revision: 3, version: 3, createdAt: VERSIONS[0]!.createdAt } }
    case 'OBSOLETE':
      return { code: `TP ${code.slice(0, 5)}-${code.slice(5)}`, state, words: 'x', printed: { ...printed, revisionId: REV.r1, revision: 1, revisionStatus: 'OBSOLETE' }, newer: null }
    case 'CURRENT':
      return { code: `TP ${code.slice(0, 5)}-${code.slice(5)}`, state, words: 'x', printed: { ...printed, version: 3, revisionStatus: 'RELEASED' }, newer: null }
    default:
      return { code: `TP ${code.slice(0, 5)}-${code.slice(5)}`, state, words: 'x', printed: { ...printed, version: 3 }, newer: null }
  }
}
