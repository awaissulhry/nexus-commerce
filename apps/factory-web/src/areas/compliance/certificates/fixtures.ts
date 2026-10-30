import { createElement, useEffect, useState } from 'react'
import { daysBetween } from '@nexus/factory-domain/compliance/certificates/rules'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { at, COMPANY_ID, day, inShell, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../quality/_shared/fixtures'
import { failedRead, reading, ready } from '../../quality/_shared/model'
import type { BrandOption, Certificate, CertificateDetail, Coverage, GateResult, StyleFacts, StyleOption } from './api'
import { blankCheck, blankDraft, certCan, type AddModel, type CertFilters, type CertificatesListModel, type CheckModel } from './model'
import { CertificatesListView } from './view/CertificatesListView'

/**
 * SCR-050 Certificates — made-up register only: CERT-DEMO-… numbers, a made-up notified body "Demo Test Lab" (0000) and
 * "Demo Certification Office" (9990), the DEMO companies and a made-up brand; no real body, company, person or number.
 * Each case is one state the Owner reviews: the register with its explainer, tiles and the most serious notice; each tile
 * pressed; kind and search; the role cases (Owner, product developer = production manager, quality = quality inspector,
 * sales without the permission); a selection; live updates; Add certificate (empty, filled, the five-year rule refused,
 * a duplicate refused by the API); Check a garment (covered, refused); loading, failed, empty and nothing matching.
 * The record's cases are SCR-051 (record/fixtures.ts).
 */

export const TODAY = day(29)
export const COMPANIES = DEMO_COMPANIES.map((company) => ({ id: company.id, name: company.name }))
export const BRAND: BrandOption = { id: uid('5501', 1), code: 'DEMO-BRAND', legalName: 'Marchio Demo S.r.l.', tradeName: 'Demo Moto' }
export const BRANDS: BrandOption[] = [BRAND]

const BODY = { notifiedBodyName: 'Demo Test Lab', notifiedBodyNumber: '0000' }
const OTHER_BODY = { notifiedBodyName: 'Demo Certification Office', notifiedBodyNumber: '9990' }

export function demoCertificate(n: number, number: string, standard: string, ppeClass: string | null, status: Certificate['status'], validFrom: string, validTo: string, extra: Partial<Certificate> = {}): Certificate {
  return {
    id: uid('5502', n),
    companyId: COMPANY_ID,
    holderPartyId: null,
    standard,
    ppeClass,
    number,
    ...BODY,
    modelReference: null,
    validFrom,
    validTo,
    status,
    statusReason: null,
    statusChangedAt: null,
    note: null,
    daysToExpiry: daysBetween(TODAY, validTo),
    nextStatuses: status === 'DRAFT' ? ['VALID', 'WITHDRAWN'] : status === 'VALID' ? ['SUSPENDED', 'WITHDRAWN', 'EXPIRED'] : status === 'SUSPENDED' ? ['VALID', 'WITHDRAWN', 'EXPIRED'] : [],
    coverageCount: 1,
    version: 3,
    createdAt: at(2, 9),
    updatedAt: at(20, 11),
    ...extra,
  }
}

export const CERTIFICATES: Certificate[] = [
  demoCertificate(1, 'CERT-DEMO-0001', 'EN 17092-3:2020', 'AA', 'VALID', '2024-03-12', '2029-03-11', { modelReference: 'DEMO TOURING AA', coverageCount: 3 }),
  demoCertificate(2, 'CERT-DEMO-0002', 'EN 17092-4:2020', 'A', 'VALID', '2021-11-24', '2026-11-23', { modelReference: 'DEMO URBAN A', coverageCount: 2 }),
  demoCertificate(3, 'CERT-DEMO-0003', 'EN 1621-1:2012', '2', 'VALID', '2022-02-27', '2027-02-26', { ...OTHER_BODY, modelReference: 'DEMO PROT SPALLA L2', coverageCount: 1 }),
  demoCertificate(4, 'CERT-DEMO-0004', 'EN 17092-2:2020', 'AAA', 'SUSPENDED', '2025-01-15', '2030-01-14', { modelReference: 'DEMO RACE AAA', coverageCount: 2, statusReason: 'Notified body letter DEMO-NB-2026-118: seam strength below the class on the re-test.', statusChangedAt: at(27, 14) }),
  demoCertificate(5, 'CERT-DEMO-0005', 'EN 17092-5:2020', 'B', 'DRAFT', '2026-10-20', '2031-10-19', { coverageCount: 0, version: 1 }),
  demoCertificate(6, 'CERT-DEMO-0006', 'EN 13594:2015', '1KP', 'EXPIRED', '2021-10-01', '2026-09-30', { ...OTHER_BODY, modelReference: 'DEMO GUANTO ESTIVO', statusReason: 'Past its last valid day, 2026-09-30.', statusChangedAt: at(1, 2) }),
  demoCertificate(7, 'CERT-DEMO-0007', 'EN 1621-2:2014', '1', 'WITHDRAWN', '2023-05-02', '2028-05-01', { ...OTHER_BODY, coverageCount: 0, statusReason: 'Replaced by the supplier’s new back protector certificate.', statusChangedAt: at(9, 10) }),
  demoCertificate(8, 'CERT-DEMO-0008', 'EN 17092-3:2020', 'AA', 'VALID', '2025-06-01', '2030-05-31', { companyId: null, holderPartyId: BRAND.id, modelReference: 'DEMO MOTO AIR', coverageCount: 1 }),
]

export const byNumber = (number: string): Certificate => CERTIFICATES.find((entry) => entry.number === number)!

// ---- styles the coverage and the check name -----------------------------------------------------------------------------

const colourway = (n: number, code: string, name: string, offeredSizes: string[], status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') => ({ id: uid('5503', n), code, name, status, offeredSizes })
const SIZES = ['46', '48', '50', '52', '54', '56', '58']

export const JACKET: StyleFacts = {
  id: uid('5504', 1),
  code: 'DEMO-JKT-01',
  name: 'Giacca Touring Demo',
  companyId: COMPANY_ID,
  sizes: SIZES,
  mtmAllowed: true,
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'EN 17092-3:2020',
  ppeClass: 'AA',
  colourways: [colourway(1, 'BLK', 'Nero', SIZES), colourway(2, 'GRY', 'Grigio', SIZES.slice(0, 6)), colourway(3, 'RED', 'Rosso', SIZES.slice(1, 5))],
}
export const TROUSERS: StyleFacts = {
  id: uid('5504', 2),
  code: 'DEMO-PNT-01',
  name: 'Pantalone Touring Demo',
  companyId: COMPANY_ID,
  sizes: SIZES.slice(0, 6),
  mtmAllowed: false,
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'EN 17092-3:2020',
  ppeClass: 'AA',
  colourways: [colourway(4, 'BLK', 'Nero', SIZES.slice(0, 6)), colourway(5, 'SND', 'Sabbia', SIZES.slice(0, 5)), colourway(6, 'OLV', 'Oliva', [], 'ARCHIVED')],
}
export const STYLE_FACTS: Record<string, StyleFacts> = { [JACKET.id]: JACKET, [TROUSERS.id]: TROUSERS }
export const STYLE_OPTIONS: StyleOption[] = [JACKET, TROUSERS].map((style) => ({ id: style.id, code: style.code, name: style.name, companyId: style.companyId, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass }))

export const PROTECTOR = { id: uid('5505', 1), code: 'DEMO-PROT-SPALLA', name: 'Demo shoulder protector level 2' }

export function demoCoverage(n: number, certificateId: string, extra: Partial<Coverage>): Coverage {
  return {
    id: uid('5506', n),
    certificateId,
    styleId: null,
    itemId: null,
    style: null,
    item: null,
    colourwayIds: [],
    sizes: [],
    allowsMadeToMeasure: false,
    note: null,
    status: 'ACTIVE',
    version: 1,
    createdAt: at(3, 10),
    updatedAt: at(3, 10),
    ...extra,
  }
}

const styleRef = (style: StyleFacts) => ({ id: style.id, code: style.code, name: style.name })

/** A certificate as its record reads it (its coverage, whether its PDF is on file). */
export function demoDetail(certificate: Certificate, coverage: Coverage[] = [], hasPdf = true): CertificateDetail {
  return { ...certificate, coverage, hasPdf, coverageCount: coverage.filter((entry) => entry.status === 'ACTIVE').length }
}

export const COVERAGE_0001: Coverage[] = [
  demoCoverage(1, byNumber('CERT-DEMO-0001').id, { styleId: JACKET.id, style: styleRef(JACKET), allowsMadeToMeasure: true, note: 'Type examination report DEMO-TER-0412, all colourways.' }),
  demoCoverage(2, byNumber('CERT-DEMO-0001').id, { styleId: TROUSERS.id, style: styleRef(TROUSERS), colourwayIds: [TROUSERS.colourways[0]!.id], sizes: ['46', '48', '50', '52'] }),
  demoCoverage(3, byNumber('CERT-DEMO-0001').id, { itemId: PROTECTOR.id, item: PROTECTOR, note: 'Shoulder protectors tested with the jacket.' }),
  demoCoverage(4, byNumber('CERT-DEMO-0001').id, { styleId: uid('5504', 9), style: { id: uid('5504', 9), code: 'DEMO-JKT-00', name: 'Giacca prototipo Demo' }, status: 'ARCHIVED', note: 'Prototype dropped from the range.', updatedAt: at(18, 15) }),
]

// ---- gate answers ---------------------------------------------------------------------------------------------------------

export function coveredBy(certificate: Certificate, style: StyleFacts, colourwayId: string, size: string, date = TODAY): GateResult {
  return {
    allowed: true,
    outcome: 'covered',
    route: 'SIZE',
    date,
    styleId: style.id,
    colourwayId,
    size,
    certificate: { id: certificate.id, number: certificate.number, standard: certificate.standard, ppeClass: certificate.ppeClass, notifiedBodyName: certificate.notifiedBodyName, notifiedBodyNumber: certificate.notifiedBodyNumber, validFrom: certificate.validFrom, validTo: certificate.validTo },
    coverageId: uid('5506', 1),
    message: null,
    reasons: [],
  }
}

export function refusedFor(style: StyleFacts, colourwayId: string, size: string, date: string, reasons: GateResult['reasons']): GateResult {
  return { allowed: false, outcome: 'refused', route: 'SIZE', date, styleId: style.id, colourwayId, size, certificate: null, coverageId: null, message: null, reasons }
}

// ---- the list's cases -----------------------------------------------------------------------------------------------------

interface ListCase {
  readonly model: CertificatesListModel
  readonly role: RoleCase
}

function listModel(over: Partial<CertificatesListModel> = {}, role: RoleCase = 'owner'): ListCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: certCan(ROLE_PERMISSIONS[role]),
      companies: COMPANIES,
      brands: BRANDS,
      filters: { view: 'all', kind: 'all', q: '' },
      rows: ready(CERTIFICATES),
      today: TODAY,
      asOf: NOW,
      live: 'live',
      updates: 0,
      selected: [],
      notice: null,
      dialog: null,
      add: null,
      check: null,
      explainerOpen: true,
      ...over,
    },
  }
}

/** The design case keeps its own selection, so ticks, the header box, shift-click and x work in the review. */
function CertificatesDesign({ model }: { model: ListCase }) {
  const [selected, setSelected] = useState<readonly string[]>(model.model.selected)
  const [filters, setFilters] = useState<CertFilters>(model.model.filters)
  useEffect(() => setSelected(model.model.selected), [model.model.selected])
  useEffect(() => setFilters(model.model.filters), [model.model.filters])
  return inShell('/compliance/certificates', createElement(CertificatesListView, { model: { ...model.model, selected, filters }, actions: { onSelect: (ids) => setSelected([...ids]), onFilters: setFilters } }), model.role)
}

const addModel = (over: Partial<AddModel> = {}): AddModel => ({ draft: blankDraft(COMPANY_ID), touched: [], fileName: null, busy: false, problem: null, lines: [], refused: [], ...over })
const filledDraft = { ...blankDraft(COMPANY_ID), standard: 'EN 17092-3:2020', number: 'CERT-DEMO-0009', notifiedBodyName: 'Demo Test Lab', notifiedBodyNumber: '0000', modelReference: 'DEMO TOURING 2', validFrom: '2026-10-15', validTo: '2031-10-14' }
const checkModel = (over: Partial<CheckModel> = {}): CheckModel => ({ ...blankCheck(TODAY), ...over })
const blackJacket = JACKET.colourways[0]!.id

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-050',
  title: 'Certificates (register, coverage, gate)',
  view: CertificatesDesign,
  cases: [
    { id: 'owner', label: 'Owner: the gate explained, the tiles, the notice and the register', model: listModel(), note: 'A tile is a saved view: its number is that view’s count. The suspended certificate is the most serious notice.' },
    { id: 'explainer-closed', label: 'The explainer folded (remembered on this device)', model: listModel({ explainerOpen: false }) },
    { id: 'notices-open', label: 'The other notices opened', model: listModel({ noticesOpen: true }) },
    { id: 'tile-valid', label: 'Tile pressed: valid', model: listModel({ filters: { view: 'valid', kind: 'all', q: '' } }) },
    { id: 'tile-expiring', label: 'Tile pressed: expiring in 180 days', model: listModel({ filters: { view: 'expiring', kind: 'all', q: '' } }), note: 'The hint counts 90 and 30 days.' },
    { id: 'tile-suspended', label: 'Tile pressed: suspended or withdrawn', model: listModel({ filters: { view: 'suspended', kind: 'all', q: '' } }) },
    { id: 'tile-drafts', label: 'Tile pressed: drafts not registered', model: listModel({ filters: { view: 'drafts', kind: 'all', q: '' } }) },
    { id: 'expired', label: 'Rows ▾ Expired: the glove certificate past its last day', model: listModel({ filters: { view: 'expired', kind: 'all', q: '' } }) },
    { id: 'filtered', label: 'Kind protectors, searched for the body 9990', model: listModel({ filters: { view: 'all', kind: 'PROTECTOR', q: '9990' } }) },
    { id: 'selected', label: 'Two rows selected', model: listModel({ selected: [byNumber('CERT-DEMO-0001').id, byNumber('CERT-DEMO-0003').id] }), note: 'The toolbar swaps to Export 2 (CSV); no bulk edit of legal fields.' },
    { id: 'updates', label: 'Live changes waiting', model: listModel({ updates: 2 }), note: 'Rows never move under the cursor: "2 updates · Show".' },
    { id: 'product', label: 'Product developer (production manager): reads, every write held', model: listModel({}, 'production') },
    { id: 'quality', label: 'Quality (inspector): adds and checks', model: listModel({}, 'inspector') },
    { id: 'no-permission', label: 'Sales: not for this role', model: listModel({}, 'sales') },
    { id: 'add', label: 'Add certificate: empty', model: listModel({ dialog: { kind: 'add' }, add: addModel() }), note: 'Create is held with the first open field; ⌘↵ creates.' },
    { id: 'add-filled', label: 'Add certificate: filled, with its PDF', model: listModel({ dialog: { kind: 'add' }, add: addModel({ draft: filledDraft, fileName: 'demo-certificate-0009.pdf', touched: ['number', 'validFrom', 'validTo'] }) }), note: 'EN 17092-3 grants class AA by itself; the span is said in years.' },
    { id: 'add-five-years', label: 'Add certificate: the five-year rule refused as you leave the field', model: listModel({ dialog: { kind: 'add' }, add: addModel({ draft: { ...filledDraft, validTo: '2031-12-14' }, touched: ['validTo', 'validFrom'] }) }) },
    { id: 'add-protector', label: 'Add certificate: a protector asks its level', model: listModel({ dialog: { kind: 'add' }, add: addModel({ draft: { ...filledDraft, standard: 'EN 1621-1:2012', number: 'CERT-DEMO-0010' }, touched: ['ppeClass'] }) }) },
    { id: 'add-refused', label: 'Add certificate: the body already has that number', model: listModel({ dialog: { kind: 'add' }, add: addModel({ draft: { ...filledDraft, number: 'CERT-DEMO-0001' }, problem: 'add.problem.duplicate', lines: ['Notified body 0000 already has a certificate CERT-DEMO-0001 in the register.'], refused: ['number'] }) }) },
    { id: 'check', label: 'Check a garment: pick a style', model: listModel({ dialog: { kind: 'check' }, check: checkModel({ query: 'touring', styles: ready(STYLE_OPTIONS) }) }) },
    { id: 'check-covered', label: 'Check a garment: covered', model: listModel({ dialog: { kind: 'check' }, check: checkModel({ style: ready(JACKET), colourwayId: blackJacket, size: '52', result: coveredBy(byNumber('CERT-DEMO-0001'), JACKET, blackJacket, '52') }) }) },
    {
      id: 'check-refused',
      label: 'Check a garment: size 58 outside the covered range',
      model: listModel({
        dialog: { kind: 'check' },
        check: checkModel({ style: ready(TROUSERS), colourwayId: TROUSERS.colourways[0]!.id, size: '56', date: '2027-03-01', result: refusedFor(TROUSERS, TROUSERS.colourways[0]!.id, '56', '2027-03-01', [{ code: 'size_not_covered', message: 'Certificate CERT-DEMO-0001 covers sizes 46, 48, 50, 52 of DEMO-PNT-01, not 56.', certificateId: byNumber('CERT-DEMO-0001').id }]) }),
      }),
      note: 'Each reason in our words, who fixes it and how; the API’s sentence kept under it as data.',
    },
    { id: 'shortcuts', label: 'The keys (?)', model: listModel({ dialog: { kind: 'shortcuts' } }) },
    { id: 'empty', label: 'No certificates yet', model: listModel({ rows: ready([]) }) },
    { id: 'empty-view', label: 'No certificates yet (product developer)', model: listModel({ rows: ready([]) }, 'production') },
    { id: 'no-match', label: 'Nothing matches', model: listModel({ filters: { view: 'all', kind: 'all', q: 'zzz' } }) },
    { id: 'loading', label: 'Loading', model: listModel({ rows: reading(), asOf: null, live: 'connecting', today: null }) },
    { id: 'error', label: "The API didn't answer", model: listModel({ rows: failedRead('problem.unavailable') }), note: 'Never drawn as an empty register; the tiles say "—", not 0.' },
  ],
})
