import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Activity, Choices, Claim, ClaimRecord, ClaimUse, CountsAnswer, Evidence, ListAnswer } from '../api'

/**
 * Made-up data for SCR-215's design cases (B-W2b-264): an invented company ("Officina Demo"), invented styles, materials,
 * labels, files and people, made-up claims and their uses. Nothing here is a real product, supplier, certificate or document.
 * Design-only (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-10'
export const NOW = '2026-11-10T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0]

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The roles the design reads: the quality inspector keeps and approves claims; the production manager and read-only look; sales has no compliance read. */
export const SOURCING_ROLES_DEMO = {
  quality: template('quality_inspector'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type SourcingRoleDemo = keyof typeof SOURCING_ROLES_DEMO

/** The Office shell around the page (the role's navigation, this page's place), as the page sees it. */
export function inSourcingShell(page: ReactNode, role: SourcingRoleDemo): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...SOURCING_ROLES_DEMO[role]])),
    path: '/compliance/sourcing',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/compliance/sourcing' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const MARTA = { id: uid('9101', 1), name: 'Marta Demo' }
const LUCA = { id: uid('9101', 2), name: 'Luca Esempio' }
const STYLE_JKT = { id: uid('9102', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }
const STYLE_PNT = { id: uid('9102', 2), code: 'PNT-DEMO-02', name: 'Pantalone Demo Rider' }
const LEATHER = { id: uid('9103', 1), code: 'PEL-DEMO-12', name: 'Pelle bovina Demo 1,2 mm' }
const LINING = { id: uid('9103', 2), code: 'FOD-DEMO-03', name: 'Fodera poliestere Demo' }

const file = (n: number, name: string, over: Partial<Evidence> = {}): Evidence => ({
  id: uid('9104', n),
  name,
  kind: 'CERTIFICATE',
  category: 'TEST_REPORT',
  contentType: 'application/pdf',
  sizeBytes: 182_000 + n * 1000,
  status: 'AVAILABLE',
  expiresOn: null,
  recordType: 'SustainabilityClaim',
  recordId: uid('9105', n),
  availableAt: '2026-09-02T10:00:00.000Z',
  ...over,
})

export const FILES = {
  recycled: file(1, 'Rapporto prova riciclato Demo 2026.pdf'),
  lwg: file(2, 'Certificato LWG conceria Esempio.pdf', { category: 'SUPPLIER_CERTIFICATE', expiresOn: '2027-06-30', recordType: 'Party' }),
  pfasOld: file(3, 'Rapporto PFAS Demo 2025.pdf', { expiresOn: '2026-10-31' }),
  pfasNew: file(4, 'Rapporto PFAS Demo 2026.pdf', { expiresOn: '2027-11-30' }),
  organic: file(5, 'Dichiarazione cotone biologico Demo.pdf', { category: 'DECLARATION', expiresOn: '2027-01-20', recordType: 'Lot' }),
}

const claim = (n: number, over: Partial<Claim>): Claim => ({
  id: uid('9105', n),
  companyId: COMPANY.id,
  code: `CL-000${n}`,
  kind: 'RECYCLED_CONTENT',
  wording: { it: 'Fodera in poliestere riciclato al 50 %', en: 'Lining made with 50 % recycled polyester' },
  phraseKey: null,
  scope: 'STYLE',
  style: STYLE_JKT,
  material: null,
  scopeNote: 'Solo la fodera',
  evidence: [FILES.recycled],
  validUntil: null,
  validity: { state: 'NONE', daysLeft: null, threshold: null },
  status: 'APPROVED',
  state: 'APPROVED',
  blockReasons: [],
  approvedAt: '2026-09-04T09:12:00.000Z',
  approvedBy: LUCA,
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  supersedes: null,
  supersededBy: null,
  uses: { live: 2, ended: 1, kinds: ['STYLE', 'LABEL'] },
  note: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  createdBy: MARTA,
  version: 2,
  canManage: true,
  canApprove: true,
  ...over,
})

export const RECYCLED = claim(1, {})
export const LWG = claim(2, {
  kind: 'RESPONSIBLE_SOURCING',
  wording: { it: 'Pelle da una conceria valutata LWG', en: 'Leather from a tannery rated by LWG' },
  scope: 'MATERIAL',
  style: null,
  material: LEATHER,
  scopeNote: null,
  evidence: [FILES.lwg],
  validUntil: '2027-06-30',
  validity: { state: 'OK', daysLeft: 232, threshold: null },
  status: 'DRAFT',
  state: 'DRAFT',
  approvedAt: null,
  approvedBy: null,
  uses: { live: 0, ended: 0, kinds: [] },
  version: 1,
})
export const PFAS_BLOCKED = claim(3, {
  kind: 'SUBSTANCE_FREE',
  wording: { it: 'Realizzato senza PFAS', en: 'Made without PFAS' },
  scope: 'COMPANY',
  style: null,
  scopeNote: null,
  evidence: [FILES.pfasOld],
  validUntil: '2026-10-31',
  validity: { state: 'EXPIRED', daysLeft: -10, threshold: null },
  state: 'BLOCKED',
  blockReasons: [
    { cause: 'VALID_UNTIL', fileId: null, day: '2026-10-31' },
    { cause: 'FILE_EXPIRED', fileId: FILES.pfasOld.id, day: '2026-10-31' },
  ],
  uses: { live: 2, ended: 0, kinds: ['LABEL', 'WEB_SHOP'] },
})
export const PFAS_REPLACEMENT = claim(4, {
  kind: 'SUBSTANCE_FREE',
  wording: { it: 'Realizzato senza PFAS', en: 'Made without PFAS' },
  scope: 'COMPANY',
  style: null,
  scopeNote: null,
  evidence: [FILES.pfasNew],
  validUntil: '2027-11-30',
  validity: { state: 'OK', daysLeft: 385, threshold: null },
  status: 'DRAFT',
  state: 'DRAFT',
  approvedAt: null,
  approvedBy: null,
  supersedes: { id: PFAS_BLOCKED.id, code: 'CL-0003', status: 'APPROVED' },
  uses: { live: 0, ended: 0, kinds: [] },
  version: 1,
})
export const ORGANIC_SOON = claim(5, {
  kind: 'ORGANIC_CONTENT',
  wording: { it: 'Fodera tasche in cotone biologico al 100 %', en: 'Pocket lining made with 100 % organic cotton' },
  style: STYLE_PNT,
  scopeNote: 'Solo la fodera delle tasche',
  evidence: [FILES.organic],
  validUntil: '2027-01-20',
  validity: { state: 'SOON', daysLeft: 71, threshold: 90 },
  uses: { live: 1, ended: 0, kinds: ['CATALOGUE'] },
})
export const RETIRED = claim(6, {
  kind: 'CARBON',
  wording: { it: 'Produzione con energia rinnovabile al 60 %', en: 'Made with 60 % renewable energy' },
  scope: 'COMPANY',
  style: null,
  scopeNote: null,
  status: 'WITHDRAWN',
  state: 'RETIRED',
  withdrawnAt: '2026-10-15T14:00:00.000Z',
  withdrawnBy: MARTA,
  withdrawReason: 'Il contratto di fornitura elettrica è cambiato',
  uses: { live: 0, ended: 2, kinds: [] },
})

export const CLAIMS: Claim[] = [RECYCLED, LWG, PFAS_BLOCKED, PFAS_REPLACEMENT, ORGANIC_SOON]
export const COUNTS: CountsAnswer = { approved: 2, blocked: 1, drafts: 2, retired: 1 }
const LAW = { claims: 'Dir. (EU) 2024/825', generic: 'Dir. (EU) 2024/825, Annex I 4a', offset: 'Dir. (EU) 2024/825, Annex I 4c', label: 'Dir. (EU) 2024/825, Annex I 2a' }

export const listAnswer = (over: Partial<ListAnswer> = {}): ListAnswer => ({ claims: CLAIMS, complete: true, canManage: true, canApprove: true, today: TODAY, law: LAW, labelCheck: 'OFF', ...over })

const LABEL_ID = uid('9106', 1)
const use = (n: number, over: Partial<ClaimUse>): ClaimUse => ({
  id: uid('9107', n),
  kind: 'STYLE',
  recordType: 'Style',
  recordId: STYLE_JKT.id,
  record: { code: STYLE_JKT.code, name: STYLE_JKT.name },
  label: null,
  note: null,
  createdAt: '2026-09-05T10:00:00.000Z',
  createdBy: MARTA,
  endedAt: null,
  endedBy: null,
  version: 1,
  ...over,
})

const USES: ClaimUse[] = [
  use(1, { label: 'Testi del modello GIA-DEMO-01' }),
  use(2, { kind: 'LABEL', recordType: 'LabelTemplate', recordId: LABEL_ID, record: { code: 'ETI-DEMO-01', name: 'Etichetta cura Giacca Demo' }, label: 'Etichetta cura' }),
  use(3, { kind: 'CATALOGUE', label: 'Catalogo primavera 2026 (inventato)', endedAt: '2026-10-01T09:00:00.000Z', endedBy: LUCA, version: 2 }),
]

const activity = (n: number, action: string, at: string, by: { id: string; name: string } | null, facts: Activity['facts'] = {}, reason: string | null = null): Activity => ({ id: uid('9108', n), at, action: `compliance.claims.${action}`, by, reason, facts })

export const recordOf = (value: Claim, over: Partial<ClaimRecord> = {}): ClaimRecord => ({
  claim: value,
  uses: value.id === RECYCLED.id ? USES : value.id === PFAS_BLOCKED.id ? [use(4, { kind: 'LABEL', recordType: 'LabelTemplate', recordId: LABEL_ID, record: { code: 'ETI-DEMO-01', name: 'Etichetta cura Giacca Demo' }, label: 'Cartellino' }), use(5, { kind: 'WEB_SHOP', label: 'Pagina prodotto' })] : [],
  activity: [
    activity(4, 'endUse', '2026-10-01T09:00:00.000Z', LUCA, { kind: 'CATALOGUE', label: 'Catalogo primavera 2026 (inventato)' }),
    activity(3, 'addUse', '2026-09-05T10:00:00.000Z', MARTA, { kind: 'STYLE', label: 'Testi del modello GIA-DEMO-01' }),
    activity(2, 'approve', '2026-09-04T09:12:00.000Z', LUCA, { status: 'APPROVED' }),
    activity(1, 'draft', '2026-09-01T08:00:00.000Z', MARTA, { status: 'DRAFT', code: value.code }),
  ],
  findings: {},
  today: TODAY,
  law: LAW,
  ...over,
})

export const CHOICES: Choices = {
  files: Object.values(FILES).map((entry) => ({ id: entry.id, name: entry.name, kind: entry.kind, category: entry.category, recordType: entry.recordType ?? 'SustainabilityClaim', recordId: entry.recordId ?? uid('9105', 9), expiresOn: entry.expiresOn, availableAt: entry.availableAt })),
  styles: [STYLE_JKT, STYLE_PNT],
  materials: [LEATHER, LINING],
  labels: [{ id: LABEL_ID, code: 'ETI-DEMO-01', name: 'Etichetta cura Giacca Demo', styleId: STYLE_JKT.id }],
  phrases: [{ key: 'claim.recycled-lining', text: 'Fodera in poliestere riciclato al 50 %', language: 'it' }],
  nextCode: 'CL-0007',
}
