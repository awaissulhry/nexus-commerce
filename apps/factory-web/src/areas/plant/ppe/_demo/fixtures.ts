import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { PPE_LAW, RECEIPT_STATEMENT } from '@nexus/factory-domain/safety/ppe/rules'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { CountsAnswer, GapLine, GapRow, GapsAnswer, IssueLine, IssuesAnswer, ItemRecord, ItemsAnswer, KitsAnswer, PersonCard, PpeItem, Receipt, ReceiptAnswer, Supplier } from '../api'

/**
 * Made-up data for SCR-211's design cases and its two tabs (B-W2b-147): an invented company ("Officina Demo"), two invented
 * sites, invented roles, people, PPE items and a supplier, made-up receipts and fingerprints, a made-up one-page PDF. Nothing
 * here is a real person, product, supplier or document. Design-only (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-05'
export const NOW = '2026-11-05T09:12:00.000Z'
export const PREFIX = '/w/DEMO'

const COMPANY = DEMO_COMPANIES[0]
const company = { code: COMPANY.code, name: COMPANY.name }
export const COMPANY_ID = COMPANY.id
export const SITE_N = { id: uid('9101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('9101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const SITES = [SITE_N, SITE_S]
const site = (entry: typeof SITE_N) => ({ code: entry.code, name: entry.name })
export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design reads: the safety officer keeps the catalogue and records receipts; the owner (with the cost grain,
 * a role's `money.cost` grant) sees the unit cost too;
 * the floor supervisor records receipts but uploads no file; the production manager reads; sales has no safety.view.
 */
export const PPE_ROLES_DEMO = {
  safety: template('safety_officer'),
  owner: [...(templateOf('owner')?.permissions ?? []), 'money.cost', 'home.view'],
  supervisor: template('floor_supervisor'),
  production: template('production_manager'),
  sales: template('sales'),
} as const
export type PpeRoleDemo = keyof typeof PPE_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inPpeShell(path: string, page: ReactNode, role: PpeRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PPE_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((entry) => ({ id: entry.id, name: entry.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const SUPPLIER: Supplier = { id: uid('9401', 1), code: 'DPI-ESEMPIO', name: 'DPI Esempio S.r.l.' }
export const SUPPLIERS: Supplier[] = [SUPPLIER, { id: uid('9401', 2), code: 'SICUR-DEMO', name: 'Sicurezza Demo S.p.A.' }]

const item = (n: number, over: Partial<PpeItem>): PpeItem => ({
  id: uid('9301', n),
  companyId: COMPANY.id,
  company,
  code: 'DPI',
  name: 'DPI demo',
  nameI18n: null,
  category: 'CATEGORY_II',
  standard: null,
  sizes: [],
  lifeMonths: 12,
  supplier: SUPPLIER,
  unitCost: 1200,
  status: 'ACTIVE',
  note: null,
  inKits: 0,
  issued: 0,
  version: 2,
  updatedAt: '2026-10-20T08:00:00.000Z',
  canManage: true,
  ...over,
})

export const GLOVES = item(1, { code: 'GLOVES-CUT', name: 'Guanti antitaglio', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' }, standard: 'EN 388:2016', sizes: ['7', '8', '9', '10'], lifeMonths: 6, unitCost: 850, inKits: 2, issued: 14 })
export const SHOES = item(2, { code: 'SHOES-S3', name: 'Scarpe antinfortunistiche S3', nameI18n: { it: 'Scarpe antinfortunistiche S3', en: 'Safety shoes S3' }, standard: 'EN ISO 20345:2022', sizes: ['38', '39', '40', '41', '42', '43', '44', '45'], lifeMonths: 12, unitCost: 6400, inKits: 3, issued: 9 })
export const EARS = item(3, { code: 'EAR-DEF', name: 'Cuffie antirumore', nameI18n: { it: 'Protezione dell’udito', en: 'Hearing protection' }, category: 'CATEGORY_III', standard: 'EN 352-1:2020', lifeMonths: 24, unitCost: 2150, inKits: 1, issued: 3 })
export const APRON = item(4, { code: 'APRON', name: 'Grembiule da lavoro', nameI18n: { it: 'Grembiule da lavoro', en: 'Work apron' }, category: 'CATEGORY_I', standard: 'EN ISO 13688:2013', sizes: ['S', 'M', 'L', 'XL'], unitCost: 1490, inKits: 1, issued: 5, supplier: SUPPLIERS[1]! })
export const GLASSES = item(5, { code: 'GLASSES', name: 'Occhiali di protezione', nameI18n: { it: 'Occhiali di protezione', en: 'Safety glasses' }, standard: 'EN 166:2001', unitCost: 690, issued: 2 })
export const MASK = item(6, { code: 'MASK-FFP2', name: 'Facciale filtrante FFP2', nameI18n: { it: 'Facciale filtrante FFP2', en: 'Filtering half mask FFP2' }, category: 'CATEGORY_III', standard: 'EN 149:2001+A1:2009', lifeMonths: null, unitCost: 120, status: 'ARCHIVED', supplier: null, issued: 40 })
export const ITEMS: PpeItem[] = [APRON, EARS, GLASSES, GLOVES, SHOES]
const law = { ...PPE_LAW }

export const itemsAnswer = (over: Partial<ItemsAnswer> = {}, withCost = true): ItemsAnswer => {
  const answer = { items: ITEMS, complete: true, canAdd: true, law, ...over }
  return withCost ? answer : { ...answer, items: answer.items.map(({ unitCost: _cost, ...rest }) => rest) }
}

export const itemRecord = (entry: PpeItem = GLOVES): ItemRecord => ({
  item: entry,
  kits:
    entry.id === GLOVES.id
      ? [
          { roleSheetId: uid('9201', 1), code: 'TAG', name: 'Tagliatore', site: site(SITE_N), quantity: 2, whenToWear: 'Al tavolo di taglio' },
          { roleSheetId: uid('9201', 4), code: 'TAG', name: 'Tagliatore', site: site(SITE_S), quantity: 2, whenToWear: 'Al tavolo di taglio' },
        ]
      : [],
  law,
})

// ---- roles and kits ------------------------------------------------------------------------------------------------------------

export const ROLE_CUT = { id: uid('9201', 1), code: 'TAG', name: 'Tagliatore' }
export const ROLE_SEW = { id: uid('9201', 2), code: 'CUC', name: 'Cucitrice' }
export const ROLE_PRESS = { id: uid('9201', 3), code: 'PRS', name: 'Addetto pressa' }
const ROLE_CUT_S = { id: uid('9201', 4), code: 'TAG', name: 'Tagliatore' }

export const KITS: KitsAnswer = {
  roles: [
    { ...ROLE_CUT, companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N), people: 6 },
    { ...ROLE_SEW, companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N), people: 11 },
    { ...ROLE_PRESS, companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N), people: 3 },
  ],
  items: [GLOVES, SHOES, EARS, APRON].map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, nameI18n: entry.nameI18n, category: entry.category, status: entry.status })),
  cells: [
    { roleSheetId: ROLE_CUT.id, ppeItemId: GLOVES.id, quantity: 2, whenToWear: 'Al tavolo di taglio' },
    { roleSheetId: ROLE_CUT.id, ppeItemId: SHOES.id, quantity: 1, whenToWear: '' },
    { roleSheetId: ROLE_SEW.id, ppeItemId: APRON.id, quantity: 1, whenToWear: 'Alla macchina' },
    { roleSheetId: ROLE_SEW.id, ppeItemId: SHOES.id, quantity: 1, whenToWear: '' },
    { roleSheetId: ROLE_PRESS.id, ppeItemId: EARS.id, quantity: 1, whenToWear: 'Con la pressa in moto' },
    { roleSheetId: ROLE_PRESS.id, ppeItemId: SHOES.id, quantity: 1, whenToWear: '' },
  ],
  complete: true,
}
export const KITS_ALL: KitsAnswer = {
  ...KITS,
  roles: [...KITS.roles, { ...ROLE_CUT_S, companyId: COMPANY.id, siteId: SITE_S.id, site: site(SITE_S), people: 4 }],
  cells: [...KITS.cells, { roleSheetId: ROLE_CUT_S.id, ppeItemId: GLOVES.id, quantity: 2, whenToWear: 'Al tavolo di taglio' }],
}

// ---- people and their gaps -------------------------------------------------------------------------------------------------------

const ref = (entry: PpeItem) => ({ code: entry.code, name: entry.name, nameI18n: entry.nameI18n, category: entry.category, sizes: entry.sizes, status: entry.status })
const line = (entry: PpeItem, quantity: number, held: number, replace = 0, whenToWear = ''): GapLine => ({ ppeItemId: entry.id, item: ref(entry), quantity, held, missing: Math.max(0, quantity - held), replace, whenToWear })

export const MARIO = { id: uid('9501', 1), name: 'Mario Esempio', employeeCode: 'D-0012' }
export const LUCIA = { id: uid('9501', 2), name: 'Lucia Prova', employeeCode: 'D-0027' }
export const GIORGIO = { id: uid('9501', 3), name: 'Giorgio Demo', employeeCode: 'D-0031' }
export const SARA = { id: uid('9501', 4), name: 'Sara Campione', employeeCode: 'D-0040' }
export const PAOLO = { id: uid('9501', 5), name: 'Paolo Fittizio', employeeCode: null }
const ANNA_S = { id: uid('9501', 6), name: 'Anna Modello', employeeCode: 'S-0003' }

const gap = (employee: { id: string; name: string; employeeCode: string | null }, role: typeof ROLE_CUT | null, lines: GapLine[], lastIssueAt: string | null, at = SITE_N): GapRow => ({
  employee,
  companyId: COMPANY.id,
  siteId: at.id,
  site: site(at),
  role,
  lines,
  missing: lines.reduce((sum, entry) => sum + entry.missing, 0),
  replace: lines.reduce((sum, entry) => sum + entry.replace, 0),
  lastIssueAt,
  canIssue: true,
})

export const GAP_MARIO = gap(MARIO, ROLE_CUT, [line(GLOVES, 2, 0, 0, 'Al tavolo di taglio'), line(SHOES, 1, 0)], null)
export const GAP_LUCIA = gap(LUCIA, ROLE_SEW, [line(APRON, 1, 0, 0, 'Alla macchina'), line(SHOES, 1, 1)], '2026-03-12T10:00:00.000Z')
export const GAP_GIORGIO = gap(GIORGIO, ROLE_PRESS, [line(EARS, 1, 0, 0, 'Con la pressa in moto'), line(SHOES, 1, 1)], '2026-09-02T07:40:00.000Z')
export const GAP_SARA = gap(SARA, ROLE_CUT, [line(GLOVES, 2, 2, 2, 'Al tavolo di taglio'), line(SHOES, 1, 1)], '2026-04-15T08:00:00.000Z')
export const GAP_PAOLO = gap(PAOLO, null, [], null)
const GAP_ANNA = gap(ANNA_S, ROLE_CUT_S, [line(GLOVES, 2, 1, 0, 'Al tavolo di taglio')], '2026-10-01T09:00:00.000Z', SITE_S)

/** The `missing` answer: only the lines missed. */
const missingOnly = (row: GapRow): GapRow => ({ ...row, lines: row.lines.filter((entry) => entry.missing > 0) })
export const gapsAnswer = (over: Partial<GapsAnswer> = {}): GapsAnswer => ({ people: [GAP_MARIO, GAP_LUCIA, GAP_GIORGIO].map(missingOnly), complete: true, withoutRole: 1, today: TODAY, law, ...over })
export const GAPS_EVERYONE: GapRow[] = [GAP_MARIO, GAP_LUCIA, GAP_GIORGIO, GAP_SARA, GAP_PAOLO]
export const GAPS_ALL_SITES: GapRow[] = [...[GAP_MARIO, GAP_LUCIA, GAP_GIORGIO].map(missingOnly), missingOnly(GAP_ANNA)]

export const COUNTS: CountsAnswer = { peopleMissingKit: 3, receiptsNotSigned: 1, replacementsDue: 1, itemsBelowMinimum: null, complete: true, today: TODAY }

// ---- issues and receipts ----------------------------------------------------------------------------------------------------------

const SAFETY_USER = 'Elena Sicuri'
const issue = (n: number, over: Partial<IssueLine> & { employee: IssueLine['employee']; item: PpeItem }): IssueLine => {
  const { item: entry, ...rest } = over
  return {
    id: uid('9601', n),
    receiptId: uid('9601', n),
    issuedAt: '2026-10-28T08:30:00.000Z',
    companyId: COMPANY.id,
    siteId: SITE_N.id,
    site: site(SITE_N),
    size: null,
    quantity: 1,
    reason: 'NEW',
    method: 'FLOOR_PIN',
    issuedBy: { kind: 'WORKER', name: null, hidden: true },
    receipt: { id: uid('9601', n), state: 'SIGNED_PIN', scanFileId: null, documentFileId: null },
    device: { id: uid('9701', 1), name: 'Tablet taglio A1' },
    voided: null,
    canVoid: true,
    ...rest,
    item: { id: entry.id, code: entry.code, name: entry.name, nameI18n: entry.nameI18n, category: entry.category },
  }
}

const PIN_RECEIPT = uid('9601', 1)
const PAPER_SIGNED = uid('9601', 3)
const PAPER_OPEN = uid('9601', 5)
export const ISSUES: IssueLine[] = [
  issue(5, { employee: GIORGIO, item: SHOES, size: '43', method: 'PAPER', issuedAt: '2026-11-04T14:05:00.000Z', issuedBy: { kind: 'USER', name: SAFETY_USER, hidden: false }, device: null, receipt: { id: PAPER_OPEN, state: 'NOT_SIGNED', scanFileId: null, documentFileId: null } }),
  issue(3, { employee: LUCIA, item: SHOES, size: '38', method: 'PAPER', receiptId: PAPER_SIGNED, issuedAt: '2026-11-02T09:00:00.000Z', issuedBy: { kind: 'USER', name: SAFETY_USER, hidden: false }, device: null, receipt: { id: PAPER_SIGNED, state: 'SIGNED_PAPER', scanFileId: uid('9801', 1), documentFileId: null } }),
  issue(4, { employee: LUCIA, item: GLASSES, method: 'PAPER', receiptId: PAPER_SIGNED, issuedAt: '2026-11-02T09:00:00.000Z', issuedBy: { kind: 'USER', name: SAFETY_USER, hidden: false }, device: null, receipt: { id: PAPER_SIGNED, state: 'SIGNED_PAPER', scanFileId: uid('9801', 1), documentFileId: null }, voided: { voidId: uid('9601', 9), at: '2026-11-02T11:20:00.000Z', reason: 'Consegnati per errore: non previsti per il ruolo', by: SAFETY_USER }, canVoid: false }),
  issue(1, { employee: SARA, item: GLOVES, size: '8', quantity: 2, reason: 'REPLACEMENT', receipt: { id: PIN_RECEIPT, state: 'SIGNED_PIN', scanFileId: null, documentFileId: uid('9801', 2) } }),
  issue(2, { employee: SARA, item: SHOES, size: '39', receiptId: PIN_RECEIPT, receipt: { id: PIN_RECEIPT, state: 'SIGNED_PIN', scanFileId: null, documentFileId: uid('9801', 2) } }),
]
export const ISSUE_ALL_SITES: IssueLine = issue(6, { employee: ANNA_S, item: GLOVES, size: '7', siteId: SITE_S.id, site: site(SITE_S), issuedAt: '2026-10-01T09:00:00.000Z', device: { id: uid('9701', 2), name: 'Tablet sud' } })
export const issuesAnswer = (over: Partial<IssuesAnswer> = {}): IssuesAnswer => ({ issues: ISSUES, complete: true, law, ...over })

const receiptOf = (lines: IssueLine[], over: Partial<Receipt> = {}): Receipt => {
  const head = lines[0]!
  return {
    id: head.receiptId,
    companyId: head.companyId,
    siteId: head.siteId,
    site: head.site,
    employee: head.employee,
    issuedAt: head.issuedAt,
    method: head.method,
    state: head.receipt.state,
    issuedBy: head.issuedBy,
    signature: head.method === 'FLOOR_PIN' ? { workerId: uid('9901', 1), worker: head.employee.name, device: head.device, sha256: '3f6a'.repeat(16) } : null,
    scan: head.receipt.scanFileId ? { fileId: head.receipt.scanFileId, name: 'ricevuta-dpi-firmata.pdf' } : null,
    document: head.receipt.documentFileId ? { id: uid('9802', 1), version: 1, language: 'it', fileId: head.receipt.documentFileId, createdAt: '2026-10-28T09:00:00.000Z' } : null,
    lines,
    units: lines.filter((entry) => !entry.voided).reduce((sum, entry) => sum + entry.quantity, 0),
    canIssue: true,
    ...over,
  }
}

export const RECEIPT_PIN = receiptOf(ISSUES.filter((entry) => entry.receiptId === PIN_RECEIPT))
export const RECEIPT_PAPER = receiptOf(ISSUES.filter((entry) => entry.receiptId === PAPER_SIGNED))
export const RECEIPT_OPEN = receiptOf(ISSUES.filter((entry) => entry.receiptId === PAPER_OPEN))
export const RECEIPT_VOIDED = receiptOf([{ ...ISSUES[4]!, voided: { voidId: uid('9601', 8), at: '2026-10-29T08:00:00.000Z', reason: 'Taglia sbagliata', by: SAFETY_USER }, canVoid: false }], { state: 'VOIDED', document: null, units: 0 })
export const receiptAnswer = (receipt: Receipt, verified = true): ReceiptAnswer => ({ receipt, statement: receipt.method === 'FLOOR_PIN' ? RECEIPT_STATEMENT.it : null, verified: receipt.method === 'FLOOR_PIN' ? verified : false, law })
export const RECEIPT_IDS = [PIN_RECEIPT, PAPER_SIGNED, PAPER_OPEN]

export const DEMO_PDF: Uint8Array = samplePdf(['RICEVUTA DI CONSEGNA DPI (esempio)', 'Sara Campione - D-0040 - Stabilimento Demo Nord', 'Guanti antitaglio, taglia 8, 2 pezzi (sostituzione)', 'Scarpe antinfortunistiche S3, taglia 39, 1 pezzo', 'Firmata con badge e PIN sul tablet (dati inventati)'])

export const CARD_SARA: PersonCard = {
  employee: { id: SARA.id, name: SARA.name, employeeCode: SARA.employeeCode, status: 'ACTIVE', companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N) },
  role: ROLE_CUT,
  kit: GAP_SARA.lines,
  receipts: [RECEIPT_PIN],
  returned: null,
  canIssue: true,
  today: TODAY,
  law,
}
export const CARD_LUCIA: PersonCard = {
  employee: { id: LUCIA.id, name: LUCIA.name, employeeCode: LUCIA.employeeCode, status: 'ACTIVE', companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N) },
  role: ROLE_SEW,
  kit: GAP_LUCIA.lines,
  receipts: [RECEIPT_PAPER],
  returned: null,
  canIssue: true,
  today: TODAY,
  law,
}
export const CARD_LEAVER: PersonCard = {
  employee: { id: GIORGIO.id, name: GIORGIO.name, employeeCode: GIORGIO.employeeCode, status: 'ACTIVE', companyId: COMPANY.id, siteId: SITE_N.id, site: site(SITE_N) },
  role: ROLE_PRESS,
  kit: GAP_GIORGIO.lines,
  receipts: [RECEIPT_OPEN],
  returned: { caseId: uid('9902', 1), status: 'OPEN', doneAt: null, issueId: null },
  canIssue: true,
  today: TODAY,
  law,
}
