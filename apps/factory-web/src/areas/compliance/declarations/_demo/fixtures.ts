import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Coverage, DeclarationDetail, DeclarationRow, LeafletDetail, ListAnswer, PackView, PointView, Unrecorded } from '../api'
import { recordOfDeclaration, recordOfLeaflet } from '../model'

/**
 * Made-up data of Declarations & instructions (B-W2b-268): an invented company, styles, certificates, notified body, people,
 * shipments and batches; the words of the points are invented sample sentences, never a real declaration. Design-only (only
 * fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const NOW = '2026-11-10T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0]!

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The roles the design reads: the quality inspector makes and checks drafts; the warehouse builds packs; read-only looks; sales sees nothing. */
export const ROLES_DEMO = {
  quality: template('quality_inspector'),
  warehouse: template('warehouse'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type RoleDemo = keyof typeof ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inShell(page: ReactNode, role: RoleDemo, path = '/compliance/declarations'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLES_DEMO[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const MARTA = { id: uid('9201', 1), name: 'Marta Demo' }
export const LUCA = { id: uid('9201', 2), name: 'Luca Esempio' }
export const JKT = { id: uid('9202', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }
export const PNT = { id: uid('9202', 2), code: 'PNT-DEMO-02', name: 'Pantalone Demo Rider' }
export const GLV = { id: uid('9202', 3), code: 'GUA-DEMO-03', name: 'Guanto Demo Estate' }
const CERT = { id: uid('9203', 1), number: 'CERT-DEMO-0042' }
const SHIP = { id: uid('9204', 1), number: 'DDT-DEMO-0007' }

const row = (n: number, over: Partial<DeclarationRow>): DeclarationRow => ({
  id: uid('9205', n),
  styleId: JKT.id,
  style: { code: JKT.code, name: JKT.name },
  companyId: COMPANY.id,
  kind: 'DECLARATION_OF_CONFORMITY',
  language: 'it',
  revision: 2,
  number: `DoC-${JKT.code}-IT-r2`,
  status: 'DRAFT',
  origin: 'GENERATED',
  translationOfId: null,
  translationStatus: null,
  translationCheckedAt: null,
  translationCheckedBy: null,
  marketCode: null,
  certificate: CERT,
  maker: { name: 'Demo Pelletteria S.r.l.', address: 'Via Esempio 1, 00000 Demoville (XX), Italia', partyId: null, role: 'COMPANY' },
  standards: ['EN 17092-3:2020'],
  signedByName: null,
  signedByFunction: null,
  signedPlace: null,
  signedOn: null,
  issuedAt: null,
  batches: 0,
  shipments: 0,
  marketsNeeding: ['IT'],
  draftUntilChecked: true,
  pointsToType: [],
  version: 3,
  createdAt: '2026-11-03T09:00:00.000Z',
  updatedAt: '2026-11-09T15:10:00.000Z',
  ...over,
})

export const SIGNED_IT = row(1, { revision: 1, number: `DoC-${JKT.code}-IT-r1`, status: 'ISSUED', origin: 'SIGNED', draftUntilChecked: false, signedByName: 'Marta Demo', signedByFunction: 'Amministratrice', signedPlace: 'Demoville', signedOn: '2026-05-04', issuedAt: '2026-05-04T10:00:00.000Z', batches: 3, shipments: 2, version: 1 })
export const DRAFT_IT = row(2, { signedByName: 'Marta Demo', signedByFunction: 'Amministratrice', signedPlace: 'Demoville', signedOn: '2026-11-10' })
export const DRAFT_EN = row(3, { language: 'en', number: `DoC-${JKT.code}-EN-r2`, translationOfId: DRAFT_IT.id, translationStatus: 'CHECKED', translationCheckedAt: '2026-11-09T16:00:00.000Z', translationCheckedBy: LUCA, marketsNeeding: ['UK'] })
export const DRAFT_DE = row(4, { language: 'de', number: `DoC-${JKT.code}-DE-r2`, translationOfId: DRAFT_IT.id, translationStatus: 'IN_TRANSLATION', pointsToType: ['3', '9'], marketsNeeding: ['DE', 'CH'] })
export const LEAFLET_IT = row(5, { kind: 'USER_INFORMATION', number: `UI-${JKT.code}-IT-r2`, version: 2 })
export const SIGNED_PNT = row(6, { styleId: PNT.id, style: { code: PNT.code, name: PNT.name }, revision: 1, number: `DoC-${PNT.code}-IT-r1`, status: 'ISSUED', origin: 'SIGNED', draftUntilChecked: false, signedByName: 'Marta Demo', signedPlace: 'Demoville', signedOn: '2026-03-02', issuedAt: '2026-03-02T09:00:00.000Z', batches: 1, shipments: 1, version: 1 })
export const SUPERSEDED_PNT = row(7, { styleId: PNT.id, style: { code: PNT.code, name: PNT.name }, revision: 0, number: `DoC-${PNT.code}-IT-r0`, status: 'SUPERSEDED', origin: 'SIGNED', draftUntilChecked: false, issuedAt: '2025-09-01T09:00:00.000Z', batches: 4, shipments: 3, version: 2 })
export const ROWS: DeclarationRow[] = [SIGNED_IT, DRAFT_IT, DRAFT_EN, DRAFT_DE, LEAFLET_IT, SIGNED_PNT, SUPERSEDED_PNT]

export const listAnswer = (declarations: DeclarationRow[] = ROWS): ListAnswer => ({ declarations, more: false, asOf: NOW })

const cell = (language: string, state: Coverage['rows'][number]['cells'][number]['state'], documentId: string | null, revision: number | null, markets: string[]) => ({ language, state, documentId, revision, markets })

export const COVERAGE: Coverage = {
  languages: ['de', 'en', 'fr', 'it'],
  rows: [
    { style: { ...JKT, revision: 2 }, kind: 'DECLARATION_OF_CONFORMITY', cells: [cell('de', 'IN_TRANSLATION', DRAFT_DE.id, 2, ['DE', 'CH']), cell('en', 'CHECKED', DRAFT_EN.id, 2, ['UK']), cell('fr', 'MISSING', null, null, ['FR', 'CH']), cell('it', 'DRAFT', DRAFT_IT.id, 2, ['IT'])] },
    { style: { ...JKT, revision: 2 }, kind: 'USER_INFORMATION', cells: [cell('de', 'MISSING', null, null, ['DE']), cell('en', 'MISSING', null, null, ['UK']), cell('fr', 'MISSING', null, null, ['FR']), cell('it', 'DRAFT', LEAFLET_IT.id, 2, ['IT'])] },
    { style: { ...PNT, revision: 1 }, kind: 'DECLARATION_OF_CONFORMITY', cells: [cell('de', 'NOT_NEEDED', null, null, []), cell('en', 'NOT_NEEDED', null, null, []), cell('fr', 'NOT_NEEDED', null, null, []), cell('it', 'ISSUED', SIGNED_PNT.id, 1, ['IT'])] },
    { style: { ...PNT, revision: 1 }, kind: 'USER_INFORMATION', cells: [cell('de', 'NOT_NEEDED', null, null, []), cell('en', 'NOT_NEEDED', null, null, []), cell('fr', 'NOT_NEEDED', null, null, []), cell('it', 'MISSING', null, null, ['IT'])] },
    { style: { ...GLV, revision: 1 }, kind: 'DECLARATION_OF_CONFORMITY', cells: [cell('de', 'NOT_NEEDED', null, null, []), cell('en', 'MISSING', null, null, ['UK']), cell('fr', 'NOT_NEEDED', null, null, []), cell('it', 'MISSING', null, null, ['IT'])] },
  ],
  tiles: { issued: 1, drafts: 5, languagesMissing: 7, supersededIn30Days: 1, batchesShippedWithoutVersion: 2 },
  asOf: NOW,
}

export const UNRECORDED: Unrecorded[] = [
  { shipmentId: uid('9204', 2), shipmentNumber: 'DDT-DEMO-0009', shippedAt: '2026-11-07T14:00:00.000Z', workOrderId: uid('9206', 1), workOrderNumber: 'WO-DEMO-0031', batchNumber: 'LOT-DEMO-31', styleId: JKT.id, styleCode: JKT.code },
  { shipmentId: uid('9204', 3), shipmentNumber: 'DDT-DEMO-0010', shippedAt: '2026-11-08T09:30:00.000Z', workOrderId: uid('9206', 2), workOrderNumber: 'WO-DEMO-0032', batchNumber: 'LOT-DEMO-32', styleId: PNT.id, styleCode: PNT.code },
]

const src = (kind: string, recordType?: string, recordId?: string) => ({ kind, ...(recordType ? { recordType } : {}), ...(recordId ? { recordId } : {}) })
const val = (field: string, value: string, kind: string, recordType?: string, recordId?: string) => ({ field, value, source: src(kind, recordType, recordId) })

/** Sample words of the nine points (invented sentences in the shape of Annex IX, Italian). */
export const POINTS_IT: PointView[] = [
  { point: '1', text: `DPI: ${JKT.name}, modello ${JKT.code}, lotto o numero di serie indicato sull'etichetta.`, source: src('STYLE', 'Style', JKT.id), wording: { key: 'doc.point1', kind: 'TEMPLATE' }, values: [val('model', JKT.code, 'STYLE', 'Style', JKT.id)] },
  { point: '2', text: 'Fabbricante: Demo Pelletteria S.r.l., Via Esempio 1, 00000 Demoville (XX), Italia.', source: src('OPERATOR'), wording: { key: 'doc.point2', kind: 'TEMPLATE' }, values: [val('maker', 'Demo Pelletteria S.r.l.', 'OPERATOR')] },
  { point: '3', text: 'La presente dichiarazione di conformità è rilasciata sotto la responsabilità esclusiva del fabbricante.', source: src('PHRASE', 'Phrase', uid('9207', 1)), wording: { key: 'doc.sole-responsibility', kind: 'PHRASE' }, values: [] },
  { point: '4', text: 'Oggetto della dichiarazione: revisione 2, colori nero e grigio, taglie 46–58.', source: src('STYLE_REVISION'), wording: { key: 'doc.point4', kind: 'TEMPLATE' }, values: [val('revision', '2', 'STYLE_REVISION'), val('sizes', '46–58', 'STYLE_REVISION')] },
  { point: '5', text: "L'oggetto della dichiarazione è conforme alla pertinente normativa di armonizzazione dell'Unione: Regolamento (UE) 2016/425.", source: src('REGISTER'), wording: { key: 'doc.point5', kind: 'TEMPLATE' }, values: [val('legislation', 'Reg. (UE) 2016/425', 'REGISTER')] },
  { point: '6', text: 'Norma armonizzata: EN 17092-3:2020 (GU L 77 del 5.3.2021), classe A.', source: src('REGISTER'), wording: { key: 'doc.point6', kind: 'TEMPLATE' }, values: [val('standard', 'EN 17092-3:2020', 'REGISTER')] },
  { point: '7', text: `L'organismo notificato Organismo Demo (0000) ha effettuato l'esame UE del tipo e rilasciato il certificato ${CERT.number}.`, source: src('CERTIFICATE', 'Certificate', CERT.id), wording: { key: 'doc.point7', kind: 'TEMPLATE' }, values: [val('certificate', CERT.number, 'CERTIFICATE', 'Certificate', CERT.id), val('body', 'Organismo Demo (0000)', 'NOTIFIED_BODY')] },
  { point: '8', text: 'Non applicabile: DPI di categoria II.', source: src('TEMPLATE'), wording: { key: 'doc.point8-not-applicable', kind: 'TEMPLATE' }, values: [] },
  { point: '9', text: 'Firmato a nome e per conto di Demo Pelletteria S.r.l. — Demoville, 10/11/2026. Marta Demo, Amministratrice.', source: src('TYPED', 'User', MARTA.id), wording: null, values: [val('signatory', 'Marta Demo', 'TYPED', 'User', MARTA.id)] },
]

const may = { edit: true, refresh: true, translate: true, check: false, withdraw: true }
const family = (rows: DeclarationRow[]) =>
  rows.map((entry) => ({ id: entry.id, language: entry.language, status: entry.status, origin: entry.origin, translationStatus: entry.translationStatus, translationCheckedBy: entry.translationCheckedBy, marketCode: entry.marketCode, original: entry.translationOfId === null, pointsToType: entry.pointsToType }))

export const TIMELINE = [
  { revision: 1, documents: [{ id: SIGNED_IT.id, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1, number: SIGNED_IT.number, status: 'ISSUED' }], batches: [{ batchNumber: 'LOT-DEMO-21', workOrderId: uid('9206', 3), shipmentIds: [SHIP.id], documentIds: [SIGNED_IT.id], firstRecordedAt: '2026-06-12T08:00:00.000Z', shipments: [SHIP] }, { batchNumber: 'LOT-DEMO-24', workOrderId: uid('9206', 4), shipmentIds: [], documentIds: [SIGNED_IT.id], firstRecordedAt: '2026-07-02T08:00:00.000Z', shipments: [] }] },
]

export function docDetail(base: DeclarationRow, over: Partial<DeclarationDetail> = {}): DeclarationDetail {
  const familyRows = base.id === SIGNED_IT.id ? [SIGNED_IT] : [DRAFT_IT, DRAFT_EN, DRAFT_DE]
  const { batches: _count, ...rest } = base
  return {
    ...rest,
    points: base.id === DRAFT_DE.id ? POINTS_IT.map((point) => (base.pointsToType.includes(point.point) ? { ...point, source: src('UNTRANSLATED') } : { ...point, text: `[de] ${point.text}`, source: point.source })) : base.origin === 'SIGNED' ? [] : POINTS_IT,
    template: base.origin === 'GENERATED' ? 'annex-ix.1' : null,
    gate: base.origin === 'GENERATED' ? { name: 'GATE-PPE-TEXTS' } : null,
    createdBy: MARTA,
    original: base.translationOfId ? { id: DRAFT_IT.id, language: 'it', status: 'DRAFT' } : null,
    languages: family(familyRows),
    stale: null,
    problems: [{ code: 'PHRASE_BUILT_IN', point: '4', message: '' }],
    batches: base.id === SIGNED_IT.id ? TIMELINE : [],
    publication: { styleCode: 'WVGDAEHC', address: 'https://factory.example.com/doc/WVGDAEHC', live: true },
    may: base.origin === 'SIGNED' ? { edit: false, refresh: false, translate: false, check: false, withdraw: false } : base.translationOfId ? { ...may, translate: false, check: true } : may,
    ...over,
  }
}

export function leafletDetail(over: Partial<LeafletDetail> = {}): LeafletDetail {
  const { batches: _count, ...rest } = LEAFLET_IT
  const section = (key: string, law: string, text: string, kind: string) => ({ key, law, text, source: src(kind), wording: { key: `userinfo.${key}`, kind: 'TEMPLATE' as const }, values: [] })
  return {
    ...rest,
    sections: [
      section('product', 'art. 8(7)', `Prodotto: ${JKT.name}, modello ${JKT.code}, revisione 2, categoria II, taglie 46–58.`, 'STYLE'),
      section('maker', '1.4', 'Fabbricante: Demo Pelletteria S.r.l., Via Esempio 1, 00000 Demoville (XX), Italia.', 'OPERATOR'),
      section('storage', '1.4(a)', 'Conservazione: in un luogo asciutto, lontano dalla luce del sole.', 'PHRASE'),
      section('cleaning', '1.4(a)', 'Pulizia: con un panno umido; non lavare in lavatrice.', 'TYPED'),
      section('performance', '1.4(b)', 'Prestazioni: EN 17092-3:2020, classe A.', 'REGISTER'),
      section('protectors', '1.3.1, 1.4(b)', 'Protezioni: spalle livello 2, gomiti livello 1, schiena livello 1.', 'PROTECTOR_PLACEMENT'),
      section('docAddress', '1.4(l)', 'La dichiarazione di conformità si legge su https://factory.example.com/doc/WVGDAEHC.', 'PUBLIC_DOC'),
    ],
    protectorPositions: [
      { zone: 'Spalla', pocket: 'SHOULDER', placementId: uid('9208', 1), seq: 1, protector: { id: uid('9209', 1), code: 'PRO-DEMO-300', name: 'Protezione spalla Demo' }, standard: 'EN 1621-1', level: '2', sizes: [], note: 'Regolare con il velcro interno.' },
      { zone: 'Gomito', pocket: 'ELBOW', placementId: uid('9208', 2), seq: 2, protector: { id: uid('9209', 2), code: 'PRO-DEMO-210', name: 'Protezione gomito Demo' }, standard: 'EN 1621-1', level: '1', sizes: ['46', '48', '50'], note: null },
    ],
    spareProtectors: [{ name: 'Protezione spalla Demo', code: 'PRO-DEMO-300', itemId: uid('9209', 1), zones: ['shoulder'], standard: 'EN 1621-1', level: '2', certificate: { id: uid('9203', 2), number: 'CERT-DEMO-0050', validTo: '2028-02-28' }, placed: true }],
    sectionsToType: [],
    template: 'annex-ii-1.4.1',
    gate: { name: 'GATE-PPE-TEXTS' },
    createdBy: MARTA,
    original: null,
    languages: [{ id: LEAFLET_IT.id, language: 'it', status: 'DRAFT', origin: 'GENERATED', translationStatus: null, translationCheckedBy: null, marketCode: null, original: true, sectionsToType: [] }],
    stale: { differences: [], lists: { positions: false, spares: true }, problems: [] },
    problems: [{ code: 'NO_BODY_ADDRESS', point: 'notifiedBody', message: '' }],
    packs: [
      { market: { code: 'IT', name: 'Italia', switchedOn: true }, languages: [{ language: 'it', state: 'DRAFT', signed: null, generated: null }], live: false, missing: [] },
      { market: { code: 'DE', name: 'Germania', switchedOn: true }, languages: [{ language: 'de', state: 'MISSING', signed: null, generated: null }], live: false, missing: ['de'] },
    ],
    batches: [],
    publication: { docAddress: 'https://factory.example.com/doc/WVGDAEHC' },
    may,
    ...over,
  }
}

export const RECORD_DRAFT = recordOfDeclaration(docDetail(DRAFT_IT))
export const RECORD_DE = recordOfDeclaration(docDetail(DRAFT_DE))
export const RECORD_EN = recordOfDeclaration(docDetail(DRAFT_EN))
export const RECORD_SIGNED = recordOfDeclaration(docDetail(SIGNED_IT))
export const RECORD_LEAFLET = recordOfLeaflet(leafletDetail())

export const PACK: PackView = {
  shipment: { id: SHIP.id, number: SHIP.number, status: 'SHIPPED', shippedOn: '2026-11-06' },
  customer: { name: 'Cliente Demo GmbH' },
  order: { number: 'SO-DEMO-0102', customerRef: 'PO-4410' },
  wantedLanguage: 'de',
  day: '2026-11-06',
  locale: 'en',
  styles: [
    {
      styleId: JKT.id,
      code: JKT.code,
      name: JKT.name,
      revision: 1,
      category: 'CATEGORY_II',
      garments: 24,
      documents: [
        { documentId: SIGNED_IT.id, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1, number: SIGNED_IT.number, issuedAt: SIGNED_IT.issuedAt, fallback: true, file: { id: uid('9210', 1), originalName: 'DoC GIA-DEMO-01 r1 IT.pdf', sha256: 'a3f1c2d4e5b6978877665544332211aabbccddeeff00112233445566778899aa', sizeBytes: 182000 } },
        { documentId: uid('9205', 9), kind: 'USER_INFORMATION', language: 'it', revision: 1, number: `UI-${JKT.code}-IT-r1`, issuedAt: '2026-05-04T10:00:00.000Z', fallback: true, file: { id: uid('9210', 2), originalName: 'Istruzioni GIA-DEMO-01 r1 IT.pdf', sha256: 'b4e2d3c5f6a7988877665544332211aabbccddeeff00112233445566778899bb', sizeBytes: 240000 } },
      ],
      certificate: { id: CERT.id, number: CERT.number, standard: 'EN 17092-3:2020', ppeClass: 'A', bodyName: 'Organismo Demo', bodyNumber: '0000', validFrom: '2025-01-10', validTo: '2030-01-09', validOnDay: true },
      batches: [{ workOrderId: uid('9206', 3), batchNumber: 'LOT-DEMO-21', garments: 24, publicDocAddress: 'https://factory.example.com/doc/0F711ES7', publicDocCode: '0F71-1ES7' }],
    },
  ],
  contents: [
    { title: 'Summary', sha256: 'c5f3e4d6a7b8099877665544332211aabbccddeeff00112233445566778899cc', recordType: 'Shipment', recordId: SHIP.id, fileId: uid('9210', 3), path: 'DDT-DEMO-0007-compliance-pack-v1.pdf' },
    { title: 'DoC', sha256: 'a3f1c2d4e5b6978877665544332211aabbccddeeff00112233445566778899aa', recordType: 'ComplianceDocument', recordId: SIGNED_IT.id, fileId: uid('9210', 1), path: 'documents/GIA-DEMO-01-r1-DoC-it.pdf' },
    { title: 'User information', sha256: 'b4e2d3c5f6a7988877665544332211aabbccddeeff00112233445566778899bb', recordType: 'ComplianceDocument', recordId: uid('9205', 9), fileId: uid('9210', 2), path: 'documents/GIA-DEMO-01-r1-user-information-it.pdf' },
  ],
  refusals: [],
  warnings: [{ code: 'FALLBACK_LANGUAGE' }],
  versions: [
    { id: uid('9211', 1), version: 1, language: 'en', number: 'CP-DEMO-0001', fingerprint: 'f1', file: { id: uid('9210', 3), originalName: 'DDT-DEMO-0007 compliance pack v1.pdf', sha256: 'c5f3', sizeBytes: 96000 }, shared: false, documents: 2, createdAt: '2026-11-06T15:00:00.000Z', createdBy: MARTA },
    { id: uid('9211', 2), version: 2, language: 'en', number: 'CP-DEMO-0002', fingerprint: 'f2', file: { id: uid('9210', 4), originalName: 'DDT-DEMO-0007 compliance pack v2.pdf', sha256: 'd6a4', sizeBytes: 97000 }, shared: true, documents: 2, createdAt: '2026-11-07T08:30:00.000Z', createdBy: LUCA },
  ],
}

/**
 * A small one-page PDF with the given lines (Helvetica, WinAnsi), made here so the design's PdfViewer has a document to draw
 * without any file: the structure and its cross-reference offsets are computed.
 */
export function demoPdf(lines: readonly string[]): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (char) => `\\${char}`).replace(/[^\x20-\x7e]/g, '?')
  const content = ['BT', '/F1 12 Tf', '56 780 Td', '16 TL', ...lines.map((line) => `(${escape(line)}) Tj T*`), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

export const DRAFT_PDF = demoPdf(['DRAFT - generated from the records, not the declaration in force', '', 'EU declaration of conformity', `No. ${DRAFT_IT.number}`, '', ...POINTS_IT.map((point) => `${point.point}. ${point.text.slice(0, 80)}`)])
export const PACK_PDF = demoPdf(['Compliance pack - DDT-DEMO-0007', 'Customer: Cliente Demo GmbH', '', `${JKT.code} revision 1 - 24 garments`, `Certificate ${CERT.number} valid to 09/01/2030`, 'Batch LOT-DEMO-21 - public DoC page 0F71-1ES7'])
