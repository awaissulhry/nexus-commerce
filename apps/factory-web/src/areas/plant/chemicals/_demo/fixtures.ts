import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { Cabinet, CabinetSheet, Chemical, ChemicalRecord, Choices, CountsAnswer, LibraryAnswer, ListAnswer, Sheet } from '../api'

/**
 * Made-up data for SCR-213's design cases and its two tabs (B-W2b-143): an invented company ("Officina Demo"), two invented
 * sites, invented products and suppliers ("Colle Demo", "Vernici Esempio"), invented role sheets and PPE, made-up sheet
 * versions and a made-up one-page PDF. Nothing here is a real product, supplier or document. Design-only (only fixtures and
 * tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-03'
export const NOW = '2026-11-03T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const ORIGIN = 'https://factory.example.com'

const COMPANY = DEMO_COMPANIES[0]
const company = { code: COMPANY.code, name: COMPANY.name }
export const SITE_N = { id: uid('8101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('8101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const SITES = [SITE_N, SITE_S]
export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The roles the design reads: the safety officer keeps the register; the production manager and read-only look; sales has no safety.view. */
export const CHEMICAL_ROLES_DEMO = {
  safety: template('safety_officer'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type ChemicalRoleDemo = keyof typeof CHEMICAL_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inChemicalsShell(path: string, page: ReactNode, role: ChemicalRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...CHEMICAL_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const ROLES = [
  { id: uid('8201', 1), code: 'TAG', name: 'Tagliatore' },
  { id: uid('8201', 2), code: 'CUC', name: 'Cucitrice' },
  { id: uid('8201', 3), code: 'FIN', name: 'Addetto finissaggio' },
]
export const PPE = [
  { id: uid('8301', 1), code: 'GUA-NIT', name: 'Guanti in nitrile' },
  { id: uid('8301', 2), code: 'OCC', name: 'Occhiali di protezione' },
  { id: uid('8301', 3), code: 'MASK-A1', name: 'Semimaschera filtro A1' },
]
export const SUPPLIERS = [
  { id: uid('8401', 1), code: 'COLLE-DEMO', name: 'Colle Demo S.r.l.' },
  { id: uid('8401', 2), code: 'VERN-ES', name: 'Vernici Esempio S.p.A.' },
]

export const sheet = (n: number, over: Partial<Sheet> = {}): Sheet => ({
  id: uid('8501', n),
  versionLabel: '3.1',
  revisedOn: '2026-08-25',
  language: 'it',
  status: 'CURRENT',
  fileId: uid('8601', n),
  fileName: `SDS colla demo v3.1 ${over.language ?? 'it'}.pdf`,
  sizeBytes: 182_400,
  sha256: 'a'.repeat(64),
  supersededAt: null,
  supersededBy: null,
  addedAt: '2026-09-01T09:10:00.000Z',
  addedBy: 'Anna Esempio',
  ...over,
})

const base = (n: number, over: Partial<Chemical>): Chemical => ({
  id: uid('8001', n),
  companyId: COMPANY.id,
  company,
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  name: 'Prodotto demo',
  supplier: { partyId: null, name: null },
  use: 'GLUE',
  ghsPictograms: [],
  signalWord: null,
  hazardStatements: [],
  precautionStatements: [],
  storagePlace: 'Armadio colle, reparto taglio',
  cabinetCode: 'CAB-TAG-1',
  maxQuantity: null,
  maxQuantityUnit: null,
  roles: [],
  ppe: [],
  status: 'ACTIVE',
  note: null,
  current: [],
  superseded: 0,
  sheetState: 'MISSING',
  language: 'it',
  version: 3,
  canManage: true,
  ...over,
})

export const GLUE = base(1, {
  name: 'Colla a contatto Demo 90',
  supplier: { partyId: SUPPLIERS[0]!.id, name: SUPPLIERS[0]!.name },
  ghsPictograms: ['GHS02', 'GHS07'],
  signalWord: 'DANGER',
  hazardStatements: ['H225', 'H319', 'H336', 'EUH066'],
  precautionStatements: ['P210', 'P233', 'P305+P351+P338'],
  maxQuantity: '25',
  maxQuantityUnit: 'L',
  roles: [ROLES[0]!],
  ppe: [PPE[0]!, PPE[1]!],
  current: [sheet(1), sheet(2, { language: 'en', fileName: 'SDS colla demo v3.1 en.pdf' })],
  superseded: 1,
  sheetState: 'OK',
})
export const PAINT = base(2, {
  name: 'Tinta bordi Esempio nera',
  supplier: { partyId: null, name: 'Vernici Esempio (per nome)' },
  use: 'EDGE_PAINT',
  ghsPictograms: ['GHS07'],
  signalWord: 'WARNING',
  hazardStatements: ['H319'],
  precautionStatements: ['P280'],
  maxQuantity: '5',
  maxQuantityUnit: 'L',
  roles: [ROLES[2]!],
  current: [sheet(3, { versionLabel: '1', revisedOn: '2025-09-14', language: 'en', fileName: 'Edge paint demo SDS v1 en.pdf' })],
  sheetState: 'OTHER_LANGUAGE',
})
export const SOLVENT = base(3, {
  name: 'Diluente Demo D-12',
  supplier: { partyId: null, name: 'Solventi Demo' },
  use: 'SOLVENT',
  ghsPictograms: ['GHS02', 'GHS07', 'GHS08'],
  signalWord: 'DANGER',
  hazardStatements: ['H225', 'H304', 'H336'],
  precautionStatements: ['P210', 'P301+P310', 'P331'],
  storagePlace: 'Armadio infiammabili, finissaggio',
  cabinetCode: 'CAB-FIN-1',
  maxQuantity: '10',
  maxQuantityUnit: 'L',
  ppe: [PPE[0]!, PPE[2]!],
  sheetState: 'MISSING',
})
export const OIL = base(4, { name: 'Olio macchine Demo 22', use: 'OIL', storagePlace: 'Manutenzione, scaffale 3', cabinetCode: null, current: [sheet(4, { versionLabel: '2.0', revisedOn: '2024-03-02', fileName: 'Olio demo SDS 2.0.pdf' })], sheetState: 'OK' })
export const OLD = base(5, { name: 'Detergente Demo (vecchio)', use: 'CLEANER', status: 'ARCHIVED', storagePlace: 'Magazzino', cabinetCode: null, current: [sheet(5, { versionLabel: '1.0', revisedOn: '2022-05-10', fileName: 'Detergente demo SDS.pdf' })], sheetState: 'OK' })
export const SOUTH = base(6, { name: 'Primer Demo P4', use: 'PRIMER', siteId: SITE_S.id, site: { code: SITE_S.code, name: SITE_S.name }, ghsPictograms: ['GHS02'], hazardStatements: ['H226'], storagePlace: 'Reparto montaggio', cabinetCode: 'CAB-S-1', current: [sheet(6, { versionLabel: '4', revisedOn: '2026-02-11' })], sheetState: 'OK' })

export const CHEMICALS = [GLUE, PAINT, SOLVENT, OIL]

export const listAnswer = (over: Partial<ListAnswer> = {}): ListAnswer => ({
  chemicals: CHEMICALS,
  complete: true,
  companies: [{ id: COMPANY.id, code: COMPANY.code, name: COMPANY.name, language: 'it', sites: SITES.map((site) => ({ id: site.id, code: site.code, name: site.name })) }],
  canManage: true,
  law: { register: 'D.Lgs. 81/2008 art. 223', sds: 'REACH art. 35' },
  today: TODAY,
  ...over,
})

export const COUNTS: CountsAnswer = { active: 4, withoutSds: 1, toRequest: 1, cabinets: 2 }

export const LIBRARY: LibraryAnswer = {
  sheets: [
    { id: sheet(1).id, chemicalId: GLUE.id, chemical: GLUE.name, site: GLUE.site, siteId: GLUE.siteId, versionLabel: '3.1', revisedOn: '2026-08-25', language: 'it', fileId: sheet(1).fileId, fileName: sheet(1).fileName, addedAt: '2026-09-01T09:10:00.000Z', superseded: [{ id: uid('8501', 9), versionLabel: '3.0', revisedOn: '2024-09-01', supersededAt: '2026-09-01T09:10:00.000Z' }], canManage: true },
    { id: sheet(2).id, chemicalId: GLUE.id, chemical: GLUE.name, site: GLUE.site, siteId: GLUE.siteId, versionLabel: '3.1', revisedOn: '2026-08-25', language: 'en', fileId: sheet(2).fileId, fileName: 'SDS colla demo v3.1 en.pdf', addedAt: '2026-09-01T09:11:00.000Z', superseded: [], canManage: true },
    { id: sheet(3).id, chemicalId: PAINT.id, chemical: PAINT.name, site: PAINT.site, siteId: PAINT.siteId, versionLabel: '1', revisedOn: '2025-09-14', language: 'en', fileId: sheet(3).fileId, fileName: 'Edge paint demo SDS v1 en.pdf', addedAt: '2025-10-01T10:00:00.000Z', superseded: [], canManage: true },
    { id: sheet(4).id, chemicalId: OIL.id, chemical: OIL.name, site: OIL.site, siteId: OIL.siteId, versionLabel: '2.0', revisedOn: '2024-03-02', language: 'it', fileId: sheet(4).fileId, fileName: 'Olio demo SDS 2.0.pdf', addedAt: '2024-03-10T10:00:00.000Z', superseded: [], canManage: true },
  ],
  missing: [{ chemicalId: SOLVENT.id, chemical: SOLVENT.name, site: SOLVENT.site, canManage: true }],
}

export const CHOICES: Choices = { roles: ROLES, ppe: PPE, suppliers: SUPPLIERS, cabinets: ['CAB-FIN-1', 'CAB-TAG-1'], places: ['Armadio colle, reparto taglio', 'Armadio infiammabili, finissaggio', 'Manutenzione, scaffale 3'] }

export const glueRecord = (over: Partial<ChemicalRecord> = {}): ChemicalRecord => ({
  chemical: GLUE,
  sheets: [...GLUE.current, sheet(9, { versionLabel: '3.0', revisedOn: '2024-09-01', status: 'SUPERSEDED', supersededAt: '2026-09-01T09:10:00.000Z', supersededBy: 'Anna Esempio', fileName: 'SDS colla demo v3.0 it.pdf' })],
  today: TODAY,
  ...over,
})

export const CABINETS: Cabinet[] = [
  { siteId: SITE_N.id, site: { code: SITE_N.code, name: SITE_N.name }, code: 'CAB-FIN-1', places: ['Armadio infiammabili, finissaggio'], products: 1, withoutSheet: 1 },
  { siteId: SITE_N.id, site: { code: SITE_N.code, name: SITE_N.name }, code: 'CAB-TAG-1', places: ['Armadio colle, reparto taglio'], products: 2, withoutSheet: 0 },
]

export const CABINET_SHEET: CabinetSheet = {
  siteId: SITE_N.id,
  site: { code: SITE_N.code, name: SITE_N.name },
  company,
  code: 'CAB-TAG-1',
  places: ['Armadio colle, reparto taglio'],
  chemicals: [GLUE, PAINT].map((row) => ({ id: row.id, name: row.name, supplier: row.supplier.name, use: row.use, ghsPictograms: row.ghsPictograms, signalWord: row.signalWord, hazardStatements: row.hazardStatements, precautionStatements: row.precautionStatements, storagePlace: row.storagePlace, maxQuantity: row.maxQuantity, maxQuantityUnit: row.maxQuantityUnit, ppe: row.ppe.map((item) => item.name), current: row.current.map((entry) => ({ id: entry.id, versionLabel: entry.versionLabel, revisedOn: entry.revisedOn, language: entry.language })) })),
  law: { register: 'D.Lgs. 81/2008 art. 223', sds: 'REACH art. 35' },
  today: TODAY,
}

/** A made-up one-page sheet for the viewer (never a real supplier's document). */
export const DEMO_PDF = samplePdf(['SCHEDA DI DATI DI SICUREZZA (esempio)', 'Colla a contatto Demo 90 - versione 3.1', 'Sezione 1: identificazione (dati inventati)', 'Sezione 2: H225 H319 H336 EUH066', 'Sezione 8: guanti in nitrile, occhiali di protezione'])
