import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { languageMatrix } from '@nexus/factory-domain/compliance/markets/rules'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Change, CrViSettings, Entry, EntryRecord, GateMatrix, GateRow, LanguagesAnswer, Market, MarketsAnswer, Operator, OperatorsAnswer, Phrase, PhraseRecord, PhrasesAnswer, Requirement, TranslationHistory } from '../api'

/**
 * Made-up data for SCR-262's design cases (B-W2b-265): an invented company ("Officina Demo"), invented styles, brands, parties,
 * people, certificates, markets and phrases. Nothing here is a real product, partner, certificate or document; the laws and
 * standards are public references. Design-only (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-10'
export const NOW = '2026-11-10T08:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0]!

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The roles the design reads: the owner changes the Cr VI rule; the quality inspector keeps rules, gates and phrases; the
 * production manager and read-only look; sales has no compliance read. */
export const RULES_ROLES_DEMO = {
  owner: template('owner'),
  quality: template('quality_inspector'),
  production: template('production_manager'),
  readOnly: template('read_only'),
  sales: template('sales'),
} as const
export type RulesRoleDemo = keyof typeof RULES_ROLES_DEMO

/** The Office shell around the page (the role's navigation, this page's place). */
export function inRulesShell(page: ReactNode, role: RulesRoleDemo): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...RULES_ROLES_DEMO[role]])),
    path: '/compliance/settings',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/compliance/settings' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const MARTA = { id: uid('9201', 1), name: 'Marta Demo' }
export const LUCA = { id: uid('9201', 2), name: 'Luca Esempio' }
/** The person looking in the design cases (the author of nothing unless a case says so). */
export const ME = DEMO_USER.id

// ---- Chromium VI -----------------------------------------------------------------------------------------------------------

export const CR6: CrViSettings = { companyId: COMPANY.id, crViEvidenceRule: 'LOT_REPORT_REQUIRED', source: 'COMPANY', default: 'SUPPLIER_REPORT_ACCEPTED', legalLimitMgKg: '3', law: 'REACH Annex XVII entry 47', version: 3, updatedAt: '2026-10-28T09:15:00.000Z' }
export const CR6_MATERIALS = {
  count: 4,
  materials: [
    { id: uid('9202', 1), code: 'PEL-DEMO-12', name: 'Pelle bovina Demo 1,2 mm', kind: 'LEATHER', requiresCrViTest: true, crViLimitMgKg: '3' },
    { id: uid('9202', 2), code: 'PEL-DEMO-14', name: 'Pelle bovina Demo 1,4 mm (marchio Esempio)', kind: 'LEATHER', requiresCrViTest: true, crViLimitMgKg: '1.5' },
    { id: uid('9202', 3), code: 'PEL-DEMO-CAP', name: 'Pelle di capra Demo guanti', kind: 'LEATHER', requiresCrViTest: true, crViLimitMgKg: '2' },
    { id: uid('9202', 4), code: 'PEL-DEMO-08', name: 'Pelle Demo 0,8 mm fodera', kind: 'LEATHER', requiresCrViTest: true, crViLimitMgKg: null },
  ],
}

// ---- requirements and gates ------------------------------------------------------------------------------------------------

const requirement = (n: number, over: Partial<Requirement>): Requirement => ({
  id: uid('9203', n),
  code: `REQ-${n}`,
  name: 'A requirement',
  nameI18n: {},
  companyId: null,
  kind: 'CERTIFICATE',
  checkKey: null,
  check: 'MANUAL',
  operatorRole: null,
  productTypes: [],
  productTypeProfileId: null,
  ppeCategories: [],
  marketCode: null,
  blocks: [],
  lockedBlocks: [],
  overrideRoleKeys: [],
  overrideMaxDays: 7,
  legalReference: 'Reg. (EU) 2016/425',
  regulation: null,
  explanationI18n: {},
  appliesFrom: null,
  appliesUntil: null,
  seq: n * 10,
  switchedOn: true,
  offReason: null,
  switchedAt: '2026-10-01T08:00:00.000Z',
  switchedBy: MARTA,
  status: 'ACTIVE',
  who: 'COMPLIANCE',
  fixPlace: 'requirements',
  version: 2,
  updatedAt: '2026-10-01T08:00:00.000Z',
  builtIn: false,
  ...over,
})

export const CERT_COVERAGE = requirement(1, {
  code: 'CERT-COVERAGE',
  name: 'A valid certificate covers the style, colourway and size',
  nameI18n: { it: 'Un certificato valido copre modello, colore e taglia', en: 'A valid certificate covers the style, colourway and size' },
  checkKey: 'certificate.coverage',
  check: 'certificate.coverage',
  ppeCategories: ['CATEGORY_II', 'CATEGORY_III'],
  blocks: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'],
  lockedBlocks: ['LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'],
  legalReference: 'Reg. (EU) 2016/425 art. 8(2), Annex V',
  explanationI18n: { it: 'Un DPI di categoria II o III si etichetta e si immette sul mercato solo con un certificato UE del tipo valido.', en: 'A category II or III PPE is labelled and placed on the market only under a valid EU type-examination certificate.' },
  fixPlace: 'certificates',
})
export const DOC_LANGUAGE = requirement(2, {
  code: 'DOC-LANGUAGE',
  name: 'The declaration of conformity in every language the market needs',
  nameI18n: { it: 'La dichiarazione di conformità in ogni lingua del mercato', en: 'The declaration of conformity in every language the market needs' },
  kind: 'DOC_LANGUAGE',
  check: 'doc.languages',
  blocks: ['SHIPMENT'],
  overrideRoleKeys: ['owner'],
  overrideMaxDays: 3,
  legalReference: 'Reg. (EU) 2016/425 art. 15, Annex IX',
  fixPlace: 'declarations',
})
export const USER_INFO = requirement(3, {
  code: 'USER-INFO-LANGUAGE',
  name: 'The user information in the market’s languages',
  nameI18n: { it: 'Le istruzioni per l’uso nelle lingue del mercato', en: 'The user information in the market’s languages' },
  kind: 'USER_INFO_LANGUAGE',
  check: 'userInfo.languages',
  blocks: ['WORK_ORDER_RELEASE', 'SHIPMENT'],
  lockedBlocks: ['SHIPMENT'],
  overrideRoleKeys: ['owner', 'quality_inspector'],
  overrideMaxDays: 7,
  legalReference: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4',
  fixPlace: 'declarations',
})
export const LABEL_LANGUAGE = requirement(4, {
  code: 'LABEL-LANGUAGE',
  name: 'The label in the market’s languages',
  nameI18n: { it: 'L’etichetta nelle lingue del mercato', en: 'The label in the market’s languages' },
  kind: 'LABEL',
  check: 'label.languages',
  blocks: ['LABEL_PRINT'],
  overrideRoleKeys: ['quality_inspector'],
  overrideMaxDays: 3,
  legalReference: 'Reg. (EU) 2016/425 Annex II 2.12',
  fixPlace: 'labels',
})
export const EU_OPERATOR = requirement(5, {
  code: 'EU-OPERATOR',
  name: 'A manufacturer established in the EU, or one who answers for it',
  nameI18n: { it: 'Un fabbricante stabilito nell’UE, o chi ne risponde', en: 'A manufacturer established in the EU, or one who answers for it' },
  kind: 'OPERATOR_ROLE',
  check: 'operator.role',
  operatorRole: 'MANUFACTURER',
  blocks: ['SHIPMENT'],
  legalReference: 'Reg. (EU) 2019/1020 art. 4',
  fixPlace: 'operators',
})
export const CRVI = requirement(6, {
  code: 'CRVI-EVIDENCE',
  name: 'Chromium VI evidence for every leather lot',
  nameI18n: { it: 'Prove del cromo VI per ogni lotto di pelle', en: 'Chromium VI evidence for every leather lot' },
  kind: 'TEST',
  legalReference: 'REACH Annex XVII entry 47',
  who: 'QUALITY',
  fixPlace: 'tests',
})
export const TEXTILE_IT = requirement(7, {
  code: 'TEXTILE-SHARE-IT',
  name: 'Fibre composition on the label (Italy)',
  nameI18n: { it: 'Composizione fibrosa in etichetta (Italia)', en: 'Fibre composition on the label (Italy)' },
  kind: 'LABEL',
  checkKey: 'textile.textileShare',
  marketCode: 'IT',
  blocks: ['LABEL_PRINT'],
  legalReference: 'Reg. (EU) 1007/2011 art. 14',
  switchedOn: false,
  offReason: 'In attesa del titolare (domanda Q10): i nostri capi superano l’80 % di parte tessile?',
})

const rowOf = (req: Requirement, mayLoosen = true): GateRow => ({
  requirement: req,
  cells: (['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'] as const).map((gate) => ({ gate, blocks: req.blocks.includes(gate), locked: req.lockedBlocks.includes(gate) })),
  overrideRoleKeys: [...req.overrideRoleKeys],
  overrideMaxDays: req.overrideMaxDays,
  mayLoosen: mayLoosen && !req.builtIn,
})

export const REQUIREMENTS = [CERT_COVERAGE, DOC_LANGUAGE, USER_INFO, LABEL_LANGUAGE, EU_OPERATOR, CRVI, TEXTILE_IT]
export const gateMatrix = (mayManage = true, rows: readonly Requirement[] = REQUIREMENTS): GateMatrix => ({
  gates: ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT'],
  rows: rows.map((req) => rowOf(req, mayManage)),
  asOf: NOW,
  mayManage,
})
/** A tenant whose W1 certificate rule is still built in (no row yet). */
export const BUILT_IN = { ...CERT_COVERAGE, id: null, builtIn: true, version: 0, switchedBy: null }

// ---- the register and the watch ----------------------------------------------------------------------------------------------

const entry = (n: number, over: Partial<Entry>): Entry => ({
  id: uid('9204', n),
  code: 'EN',
  edition: null,
  label: 'EN',
  title: 'A standard',
  titleI18n: {},
  kind: 'HARMONISED_STANDARD',
  status: 'IN_FORCE',
  ojReference: null,
  ojDate: null,
  supersededBy: null,
  link: null,
  note: null,
  usedBy: 0,
  openChanges: 0,
  version: 1,
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...over,
})

export const PPE_REG = entry(1, { code: 'Reg. (EU) 2016/425', label: 'Reg. (EU) 2016/425', title: 'Regulation on personal protective equipment', titleI18n: { it: 'Regolamento sui dispositivi di protezione individuale' }, kind: 'REGULATION', ojReference: 'OJ L 81, 31.3.2016', ojDate: '2016-03-31', link: 'https://eur-lex.europa.eu/eli/reg/2016/425/oj' })
export const EN_4 = entry(2, { code: 'EN 17092-4', edition: '2020', label: 'EN 17092-4:2020', title: 'Protective garments for motorcycle riders — Class A garments', ojReference: 'OJ L 77, 5.3.2021', ojDate: '2021-03-05', usedBy: 3 })
export const EN_3_NEW = entry(3, { code: 'EN 17092-3', edition: '2026', label: 'EN 17092-3:2026', title: 'Protective garments for motorcycle riders — Class AA garments (revised)', usedBy: 0 })
export const EN_3 = entry(4, { code: 'EN 17092-3', edition: '2020', label: 'EN 17092-3:2020', title: 'Protective garments for motorcycle riders — Class AA garments', status: 'SUPERSEDED', supersededBy: { id: EN_3_NEW.id, label: EN_3_NEW.label }, ojReference: 'OJ L 77, 5.3.2021', ojDate: '2021-03-05', usedBy: 2, openChanges: 1 })
export const EN_1621 = entry(5, { code: 'EN 1621-1', edition: '2012', label: 'EN 1621-1:2012', title: 'Motorcyclists’ limb impact protectors', kind: 'STANDARD', usedBy: 1 })
export const EN_13595 = entry(6, { code: 'EN 13595-1', edition: '2002', label: 'EN 13595-1:2002', title: 'Protective clothing for professional motorcycle riders — General requirements', status: 'WITHDRAWN' })
export const ENTRIES = [PPE_REG, EN_4, EN_3, EN_3_NEW, EN_1621, EN_13595]

export const CHANGE_OPEN: Change = {
  id: uid('9205', 1),
  standard: { id: EN_3.id, label: EN_3.label, status: 'SUPERSEDED' },
  newStandard: { id: EN_3_NEW.id, label: EN_3_NEW.label },
  kind: 'REVISION',
  whatChanged: 'Revisione di esempio: la prova di abrasione dei capi di classe AA ora si fa a velocità più alta.',
  sourceReference: 'Avviso di esempio in Gazzetta ufficiale',
  noticedAt: '2026-11-02T10:00:00.000Z',
  noticedBy: MARTA,
  transitionEndsOn: '2026-11-30',
  transition: 'ENDS_SOON',
  status: 'OPEN',
  impact: null,
  assessment: null,
  assessedAt: null,
  assessedBy: null,
  closedAt: null,
  closedBy: null,
  certificates: [
    { id: uid('9206', 1), number: 'CERT-DEMO-0001', status: 'VALID', validTo: '2029-04-30' },
    { id: uid('9206', 2), number: 'CERT-DEMO-0002', status: 'VALID', validTo: '2028-09-15' },
  ],
  styles: [
    { id: uid('9207', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring', certificateIds: [uid('9206', 1)] },
    { id: uid('9207', 2), code: 'PNT-DEMO-02', name: 'Pantalone Demo Rider', certificateIds: [uid('9206', 2)] },
  ],
  reviews: [],
  task: null,
  version: 1,
  createdAt: '2026-11-02T10:00:00.000Z',
}
export const CHANGE_ASSESSED: Change = {
  ...CHANGE_OPEN,
  id: uid('9205', 2),
  status: 'ASSESSED',
  impact: 'RETEST',
  assessment: 'Valutazione di esempio: l’organismo notificato chiede una nuova prova di abrasione per la giacca touring.',
  assessedAt: '2026-11-05T09:00:00.000Z',
  assessedBy: LUCA,
  reviews: [{ id: uid('9208', 1), status: 'OPEN', certificateId: uid('9206', 1), styleId: uid('9207', 1), styleCode: 'GIA-DEMO-01', revision: 3 }],
  task: { id: uid('9209', 1), title: 'Impatto di EN 17092-3:2026', status: 'OPEN' },
  version: 3,
}
export const CHANGE_CLOSED: Change = {
  ...CHANGE_OPEN,
  id: uid('9205', 3),
  standard: { id: EN_13595.id, label: EN_13595.label, status: 'WITHDRAWN' },
  newStandard: { id: EN_3.id, label: EN_3.label },
  kind: 'WITHDRAWAL',
  whatChanged: 'Ritirata: sostituita dalla serie EN 17092.',
  transitionEndsOn: null,
  transition: 'NONE',
  status: 'CLOSED',
  impact: 'NONE',
  assessment: 'Nessun certificato la cita più.',
  assessedAt: '2025-06-01T09:00:00.000Z',
  assessedBy: MARTA,
  closedAt: '2025-06-02T09:00:00.000Z',
  closedBy: MARTA,
  certificates: [],
  styles: [],
  version: 4,
}
export const CHANGES = [CHANGE_OPEN, CHANGE_ASSESSED]
export const entryRecord = (row: Entry = EN_3): EntryRecord => ({
  entry: row,
  certificates: row.usedBy > 0 ? [{ id: uid('9206', 1), number: 'CERT-DEMO-0001', standard: row.label, status: 'VALID', validTo: '2029-04-30', styles: 2 }, { id: uid('9206', 2), number: 'CERT-DEMO-0002', standard: row.label, status: 'VALID', validTo: '2028-09-15', styles: 1 }] : [],
  supersedes: [],
  changes: row.openChanges > 0 ? [CHANGE_OPEN] : [],
  asOf: NOW,
})

// ---- markets -----------------------------------------------------------------------------------------------------------------

const market = (n: number, over: Partial<Market>): Market => ({
  id: uid('9210', n),
  code: 'XX',
  name: 'Market',
  nameI18n: {},
  companyId: null,
  labelLanguages: [],
  docLanguages: [],
  userInfoLanguages: [],
  markings: ['CE'],
  nationalRules: [],
  importerNeeded: false,
  gpsrContactNeeded: false,
  seq: n * 10,
  switchedOn: true,
  offReason: null,
  switchedAt: '2026-09-01T08:00:00.000Z',
  switchedBy: MARTA,
  note: null,
  status: 'ACTIVE',
  version: 1,
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...over,
})

export const MARKETS: Market[] = [
  market(1, { code: 'IT', name: 'Italy', nameI18n: { it: 'Italia', en: 'Italy' }, labelLanguages: ['it'], docLanguages: ['it'], userInfoLanguages: ['it'] }),
  market(2, { code: 'DE', name: 'Germany', nameI18n: { it: 'Germania', en: 'Germany' }, labelLanguages: ['de'], docLanguages: ['de'], userInfoLanguages: ['de'] }),
  market(3, {
    code: 'FR',
    name: 'France',
    nameI18n: { it: 'Francia', en: 'France' },
    labelLanguages: ['fr'],
    docLanguages: ['fr'],
    userInfoLanguages: ['fr'],
    nationalRules: [{ key: 'fr-demo-pfas', words: { it: 'Regola nazionale di esempio sui PFAS nei capi', en: 'A made-up national rule on PFAS in garments' }, law: 'Legge nazionale di esempio', href: null }],
  }),
  market(4, { code: 'ES', name: 'Spain', nameI18n: { it: 'Spagna', en: 'Spain' }, labelLanguages: ['es'], docLanguages: ['es'], userInfoLanguages: ['es'] }),
  market(5, { code: 'UK', name: 'United Kingdom', nameI18n: { it: 'Regno Unito', en: 'United Kingdom' }, labelLanguages: ['en'], docLanguages: ['en'], userInfoLanguages: ['en'], markings: ['UKCA'], importerNeeded: true, switchedOn: false, offReason: 'In attesa del titolare (domanda Q23): vendiamo nel Regno Unito?' }),
  market(6, { code: 'CH', name: 'Switzerland', nameI18n: { it: 'Svizzera', en: 'Switzerland' }, labelLanguages: ['de', 'fr', 'it'], docLanguages: ['de', 'fr', 'it'], userInfoLanguages: ['de', 'fr', 'it'], switchedOn: false, offReason: 'In attesa del titolare (domanda Q23).' }),
]
export const marketsAnswer = (mayManage = true, rows: readonly Market[] = MARKETS): MarketsAnswer => ({ markets: [...rows], matrix: languageMatrix(rows), asOf: NOW, mayManage })
export const LANGUAGES: LanguagesAnswer = {
  matrix: languageMatrix(MARKETS),
  phrases: [
    { language: 'it', inLibrary: 6, ready: 6, proposed: 0, stale: 0, missing: 0 },
    { language: 'de', inLibrary: 6, ready: 4, proposed: 1, stale: 0, missing: 1 },
    { language: 'fr', inLibrary: 6, ready: 5, proposed: 1, stale: 0, missing: 0 },
    { language: 'es', inLibrary: 6, ready: 3, proposed: 0, stale: 1, missing: 2 },
  ],
  asOf: NOW,
}

// ---- phrases -----------------------------------------------------------------------------------------------------------------

const approved = (n: number, text: string, sourceRevision = 1) => ({ id: uid('9211', n), text, revision: 1, sourceRevision, approvedAt: '2026-10-10T09:00:00.000Z', approvedBy: LUCA })
const draft = (n: number, text: string, by: { id: string; name: string } = MARTA) => ({ id: uid('9212', n), text, revision: 2, sourceRevision: 1, proposedBy: by, version: 1 })

const phrase = (n: number, over: Partial<Phrase>): Phrase => ({
  id: uid('9213', n),
  key: 'phrase',
  kind: 'WARNING',
  companyId: null,
  sourceLanguage: 'it',
  sourceText: 'Testo',
  revision: 1,
  note: null,
  status: 'ACTIVE',
  version: 1,
  updatedAt: '2026-10-01T08:00:00.000Z',
  cells: [],
  ...over,
})

export const PHRASE_LANGUAGES = ['it', 'de', 'fr', 'es']
export const WARNING_A = phrase(1, {
  key: 'warning.class-a',
  sourceText: 'Capo di classe A: protegge da abrasione e urti in misura ridotta rispetto alla classe AA.',
  cells: [
    { language: 'it', state: 'SOURCE', approved: null, draft: null },
    { language: 'de', state: 'PROPOSED', approved: null, draft: draft(1, 'Bekleidung der Klasse A: schützt in geringerem Maß als Klasse AA.') },
    { language: 'fr', state: 'APPROVED', approved: approved(1, 'Vêtement de classe A : protège moins que la classe AA.'), draft: null },
    { language: 'es', state: 'MISSING', approved: null, draft: null },
  ],
})
export const CARE = phrase(2, {
  key: 'care.wash-not',
  kind: 'CARE',
  sourceText: 'Non lavare in lavatrice: pulire con un panno umido.',
  revision: 2,
  cells: [
    { language: 'it', state: 'SOURCE', approved: null, draft: null },
    { language: 'de', state: 'APPROVED', approved: approved(2, 'Nicht in der Maschine waschen: mit einem feuchten Tuch reinigen.', 2), draft: null },
    { language: 'fr', state: 'APPROVED', approved: approved(3, 'Ne pas laver en machine : nettoyer avec un chiffon humide.', 2), draft: null },
    { language: 'es', state: 'STALE', approved: approved(4, 'No lavar a máquina.', 1), draft: null },
  ],
})
export const ANIMAL = phrase(3, {
  key: 'marking.animal-origin',
  kind: 'MARKING',
  sourceText: 'Contiene parti non tessili di origine animale.',
  cells: [
    { language: 'it', state: 'SOURCE', approved: null, draft: null },
    { language: 'de', state: 'APPROVED', approved: approved(5, 'Enthält nichttextile Teile tierischen Ursprungs.'), draft: null },
    { language: 'fr', state: 'APPROVED', approved: approved(6, "Contient des parties non textiles d'origine animale."), draft: null },
    { language: 'es', state: 'PROPOSED', approved: null, draft: draft(7, 'Contiene partes no textiles de origen animal.', { id: ME, name: 'Alex Demo' }) },
  ],
})
export const PHRASES = [WARNING_A, CARE, ANIMAL]
export const phrasesAnswer = (mayManage = true, mayApprove = true, rows: readonly Phrase[] = PHRASES): PhrasesAnswer => ({ phrases: [...rows], languages: PHRASE_LANGUAGES, asOf: NOW, mayManage, mayApprove })
export const phraseRecord = (row: Phrase = WARNING_A): PhraseRecord => ({
  phrase: row,
  history: row.cells.flatMap((cell): TranslationHistory[] =>
    cell.approved ? [{ id: cell.approved.id, language: cell.language, revision: cell.approved.revision, text: cell.approved.text, status: 'APPROVED' as const, sourceRevision: cell.approved.sourceRevision, proposedBy: MARTA, proposedAt: '2026-10-09T09:00:00.000Z', approvedBy: LUCA, approvedAt: cell.approved.approvedAt }] : cell.draft ? [{ id: cell.draft.id, language: cell.language, revision: cell.draft.revision, text: cell.draft.text, status: 'DRAFT' as const, sourceRevision: cell.draft.sourceRevision, proposedBy: cell.draft.proposedBy, proposedAt: '2026-11-08T09:00:00.000Z', approvedBy: null, approvedAt: null }] : [],
  ),
})

// ---- operators ---------------------------------------------------------------------------------------------------------------

const operator = (n: number, over: Partial<Operator>): Operator => ({
  id: uid('9214', n),
  role: 'MANUFACTURER',
  level: 'COMPANY',
  companyId: COMPANY.id,
  style: null,
  brand: null,
  marketCode: null,
  party: null,
  printedName: COMPANY.name,
  printedAddress: 'Via dell’Esempio 1\n00000 Città Demo (XX), Italia',
  contact: 'conformita@example.com',
  validFrom: '2026-01-01',
  validTo: null,
  validOnDay: true,
  note: null,
  version: 1,
  updatedAt: '2026-09-01T08:00:00.000Z',
  ...over,
})
const BRAND = { id: uid('9215', 1), code: 'BRAND-DEMO', name: 'Marchio Esempio S.r.l.' }
export const OPERATORS: Operator[] = [
  operator(1, {}),
  operator(2, { level: 'BRAND', brand: BRAND, party: BRAND, printedName: 'Marchio Esempio S.r.l.', printedAddress: 'Viale Demo 22\n00000 Città Esempio (YY), Italia', contact: 'info@example.com' }),
  operator(3, { role: 'DISTRIBUTOR', level: 'STYLE', style: { id: uid('9207', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }, marketCode: 'CH', party: { id: uid('9215', 2), code: 'DIST-DEMO', name: 'Distribuzione Demo SA' }, printedName: 'Distribuzione Demo SA', printedAddress: 'Strada Demo 5\n0000 Città Demo, Svizzera', contact: null }),
  operator(4, { role: 'IMPORTER', level: 'TENANT', companyId: null, marketCode: 'UK', party: { id: uid('9215', 3), code: 'IMP-DEMO', name: 'Demo Imports Ltd' }, printedName: 'Demo Imports Ltd', printedAddress: '1 Demo Street\nDemotown DE1 0MO, United Kingdom', contact: 'imports@example.com', validFrom: '2026-12-01', validOnDay: false }),
]
export const operatorsAnswer = (mayManage = true, rows: readonly Operator[] = OPERATORS): OperatorsAnswer => ({ operators: [...rows], day: TODAY, asOf: NOW, mayManage })
export const PARTIES = [
  { id: uid('9215', 2), code: 'DIST-DEMO', legalName: 'Distribuzione Demo SA', tradeName: null, roles: ['CUSTOMER'] },
  { id: uid('9215', 3), code: 'IMP-DEMO', legalName: 'Demo Imports Ltd', tradeName: null, roles: ['CUSTOMER'] },
]
export const BRANDS = [{ id: BRAND.id, code: BRAND.code, legalName: BRAND.name, tradeName: 'Esempio', roles: ['BRAND'] }]
export const STYLES = [
  { id: uid('9207', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring', companyId: COMPANY.id },
  { id: uid('9207', 2), code: 'PNT-DEMO-02', name: 'Pantalone Demo Rider', companyId: COMPANY.id },
]
