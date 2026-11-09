import { samplingPlan } from '@nexus/factory-domain/quality/aql/sampling'
import { at, COMPANY_ID, ME, uid } from '../../_shared/fixtures'
import type { Assignment, Checklist, CheckView, Comparison, PlanRecord, PlanRow, PlansAnswer, Profile, ProfilesAnswer, Rule, RulesAnswer, Starter, VersionRecord, VersionView } from '../api'

/**
 * Made-up data for the design cases of Inspection plans & AQL (SCR-077, SCR-077-plan, SCR-077-print): DEMO-… codes,
 * "Demo" people, example numbers. Nothing here is a real company, customer, person or result.
 */

const person = (n: number, name: string) => ({ id: uid('7701', n), name })
export const MARTA = person(1, 'Marta Demo')
export const LUCA = person(2, 'Luca Esempio')
export const YOU = { id: ME, name: 'Alex Demo' }

const usage = (records: number) => ({ final: records, incoming: 0, inProcess: 0, records })

export const PLAN_IDS = { inc: uid('7710', 1), cut: uid('7710', 2), inl: uid('7710', 3), eol: uid('7710', 4), fin: uid('7710', 5), ret: uid('7710', 6) }
const V = { inc1: uid('7711', 1), cut1: uid('7711', 2), inl1: uid('7711', 3), inl2: uid('7711', 4), eol1: uid('7711', 5), fin1: uid('7711', 6), fin2: uid('7711', 7), ret1: uid('7711', 8) }

const row = (over: Partial<PlanRow> & Pick<PlanRow, 'id' | 'code' | 'name' | 'stage'>): PlanRow => ({
  companyId: COMPANY_ID,
  appliesTo: [],
  approved: null,
  draft: null,
  status: 'APPROVED',
  latestNumber: 1,
  owner: MARTA,
  usedBy: 0,
  lastChangeAt: at(20),
  version: 3,
  ...over,
})

export const PLAN_ROWS: PlanRow[] = [
  row({ id: PLAN_IDS.inc, code: 'DEMO-INC-LEATHER', name: 'Incoming leather, hide by hide', stage: 'INCOMING', appliesTo: [{ kind: 'CATEGORY', value: 'LEATHER', label: 'Leather' }], approved: { id: V.inc1, number: 1 }, usedBy: 14, lastChangeAt: at(3) }),
  row({ id: PLAN_IDS.cut, code: 'DEMO-CUT-PANELS', name: 'Cut panels against the pattern', stage: 'CUTTING', status: 'DRAFT', draft: { id: V.cut1, number: 1, submitted: false }, owner: null, lastChangeAt: at(27) }),
  row({ id: PLAN_IDS.inl, code: 'DEMO-INL-FIRST', name: 'First piece on the line', stage: 'IN_LINE', approved: { id: V.inl2, number: 2 }, latestNumber: 2, usedBy: 41, lastChangeAt: at(12) }),
  row({ id: PLAN_IDS.eol, code: 'DEMO-EOL-GARMENT', name: 'End of line, every garment', stage: 'END_OF_LINE', approved: { id: V.eol1, number: 1 }, usedBy: 230, owner: LUCA, lastChangeAt: at(6) }),
  row({
    id: PLAN_IDS.fin,
    code: 'DEMO-FIN-JACKET',
    name: 'Final check, motorcycle jacket',
    stage: 'FINAL',
    appliesTo: [
      { kind: 'CATEGORY', value: 'JACKET', label: 'Jackets' },
      { kind: 'CUSTOMER', value: uid('7720', 1), label: 'DEMO-C01 · Demo Moto Srl' },
    ],
    approved: { id: V.fin1, number: 1 },
    draft: { id: V.fin2, number: 2, submitted: true },
    latestNumber: 2,
    usedBy: 18,
    lastChangeAt: at(28),
  }),
  row({ id: PLAN_IDS.ret, code: 'DEMO-RET-GARMENT', name: 'Returned garment', stage: 'RETURN', status: 'RETIRED', owner: null, lastChangeAt: at(2) }),
]

export const PLANS: PlansAnswer = {
  plans: PLAN_ROWS,
  truncated: false,
  counts: { byStage: { INCOMING: 1, CUTTING: 1, IN_LINE: 1, END_OF_LINE: 1, FINAL: 1, RETURN: 1 }, waitingApproval: 1 },
  canManage: true,
  canApprove: true,
}

export const PLANS_EMPTY: PlansAnswer = { ...PLANS, plans: [], counts: { byStage: {}, waitingApproval: 0 } }

export const STARTER: Starter[] = [
  { code: 'INC-LEATHER', stage: 'INCOMING', name: { it: 'Pelle in arrivo, pelle per pelle', en: 'Incoming leather, hide by hide' }, checks: 6, missing: true },
  { code: 'CUT-PANELS', stage: 'CUTTING', name: { it: 'Pezzi tagliati sul modello', en: 'Cut panels against the pattern' }, checks: 5, missing: true },
  { code: 'INL-FIRST', stage: 'IN_LINE', name: { it: 'Primo capo in linea', en: 'First piece on the line' }, checks: 7, missing: true },
  { code: 'EOL-GARMENT', stage: 'END_OF_LINE', name: { it: 'Fine linea, ogni capo', en: 'End of line, every garment' }, checks: 6, missing: true },
  { code: 'FIN-JACKET', stage: 'FINAL', name: { it: 'Controllo finale giacca', en: 'Final check, jacket' }, checks: 11, missing: true },
  { code: 'RET-GARMENT', stage: 'RETURN', name: { it: 'Capo reso', en: 'Returned garment' }, checks: 5, missing: true },
]

// ---- the plan record: DEMO-FIN-JACKET, v1 in force, v2 submitted ----

const check = (n: number, over: Partial<CheckView> & Pick<CheckView, 'code' | 'labelIt' | 'labelEn' | 'type'>): CheckView => ({
  id: uid('7730', n),
  sortOrder: n * 10,
  labelI18n: {},
  checkClass: 'MAJOR',
  mandatory: true,
  photoRequired: false,
  nominal: null,
  tolerance: null,
  uom: null,
  choices: [],
  ...over,
})

export const CHECKS_V2: CheckView[] = [
  check(1, { code: 'CE_MARK', labelIt: 'Marcatura CE leggibile', labelEn: 'CE mark readable', type: 'PASS_FAIL', checkClass: 'CRITICAL', labelI18n: { ro: 'Marcaj CE lizibil' } }),
  check(2, { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Half chest', type: 'MEASUREMENT', nominal: '58.000', tolerance: '1.500', uom: 'CM' }),
  check(3, { code: 'ZIP_RUN', labelIt: 'La cerniera scorre fino in fondo', labelEn: 'Zip runs to the end', type: 'PASS_FAIL', photoRequired: true }),
  check(4, { code: 'STITCH', labelIt: 'Cuciture del collo', labelEn: 'Collar stitching', type: 'CHOICE', checkClass: 'MINOR', choices: ['Clean', 'Uneven', 'Skipped'] }),
  check(5, { code: 'PROTECTORS', labelIt: 'Protezioni nelle tasche', labelEn: 'Protectors in their pockets', type: 'COUNT' }),
  check(6, { code: 'READ', labelIt: 'Leggere la scheda del modello prima di iniziare', labelEn: 'Read the style sheet before starting', type: 'INSTRUCTION', checkClass: null, mandatory: false }),
]

const CHECKS_V1: CheckView[] = [
  check(11, { code: 'CE_MARK', labelIt: 'Marcatura CE leggibile', labelEn: 'CE mark readable', type: 'PASS_FAIL', checkClass: 'CRITICAL' }),
  check(12, { code: 'READ', labelIt: 'Leggere la scheda del modello prima di iniziare', labelEn: 'Read the style sheet before starting', type: 'INSTRUCTION', checkClass: null, mandatory: false }),
  check(13, { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Half chest', type: 'MEASUREMENT', nominal: '58.000', tolerance: '1.000', uom: 'CM' }),
  check(14, { code: 'PROTECTORS', labelIt: 'Protezioni nelle tasche', labelEn: 'Protectors in their pockets', type: 'COUNT' }),
]

const sampling = (over: Partial<VersionView['sampling']> = {}): VersionView['sampling'] => ({
  samplingMethod: 'AQL_PROFILE',
  aqlProfileId: null,
  profile: null,
  fixedSampleSize: null,
  frequency: null,
  frequencyValue: null,
  stopAtReject: null,
  ...over,
})

export const VERSION_V2: VersionView = {
  id: V.fin2,
  planId: PLAN_IDS.fin,
  number: 2,
  status: 'DRAFT',
  changeNote: 'Zip and collar checks added after the October complaints; chest tolerance to 1.5 cm as the size chart.',
  author: MARTA,
  approvedBy: null,
  approvedAt: null,
  approvalSha256: null,
  retiredBy: null,
  retiredAt: null,
  sampling: sampling({ stopAtReject: true }),
  checks: CHECKS_V2,
  usedBy: usage(0),
  submitted: { by: MARTA, at: at(28, 16, 5), note: null },
  problems: [],
  version: 7,
  createdAt: at(24),
  updatedAt: at(28, 16, 4),
}

export const VERSION_V1: VersionView = {
  ...VERSION_V2,
  id: V.fin1,
  number: 1,
  status: 'APPROVED',
  changeNote: null,
  author: LUCA,
  approvedBy: MARTA,
  approvedAt: at(2, 11, 20),
  approvalSha256: '9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6',
  sampling: sampling(),
  checks: CHECKS_V1,
  usedBy: usage(18),
  submitted: null,
  problems: null,
  version: 4,
  createdAt: at(1),
  updatedAt: at(2, 11, 20),
}

export const COMPARISON: Comparison = {
  fromNumber: 1,
  toNumber: 2,
  added: [
    { code: 'ZIP_RUN', labelIt: 'La cerniera scorre fino in fondo', labelEn: 'Zip runs to the end' },
    { code: 'STITCH', labelIt: 'Cuciture del collo', labelEn: 'Collar stitching' },
  ],
  removed: [],
  changed: [
    { code: 'CHEST', changes: [{ field: 'tolerance', before: '1.000', after: '1.500' }] },
    { code: 'CE_MARK', changes: [{ field: 'labelI18n', before: {}, after: { ro: 'Marcaj CE lizibil' } }] },
  ],
  moved: ['READ'],
  sampling: [{ field: 'stopAtReject', before: null, after: true }],
  same: false,
}

export const RECORD: PlanRecord = {
  plan: PLAN_ROWS[4]!,
  versions: [
    { id: V.fin2, number: 2, status: 'DRAFT', changeNote: VERSION_V2.changeNote, author: MARTA, approvedBy: null, approvedAt: null, retiredAt: null, checks: 6, usedBy: usage(0), createdAt: at(24) },
    { id: V.fin1, number: 1, status: 'APPROVED', changeNote: null, author: LUCA, approvedBy: MARTA, approvedAt: at(2, 11, 20), retiredAt: null, checks: 4, usedBy: usage(18), createdAt: at(1) },
  ],
  current: VERSION_V2,
  comparison: COMPARISON,
  preview: { subject: 'styles', count: 4, outOf: 11 },
  rules: 0,
  may: { manage: true, approve: true, approveHeld: null },
}

/** The same plan, with no draft: v1 in force and frozen. */
export const RECORD_APPROVED: PlanRecord = {
  ...RECORD,
  plan: { ...RECORD.plan, draft: null, latestNumber: 1 },
  versions: [RECORD.versions[1]!],
  current: VERSION_V1,
  comparison: { fromNumber: 1, toNumber: 1, added: [], removed: [], changed: [], moved: [], sampling: [], same: true },
  may: { manage: true, approve: false, approveHeld: 'There is no draft to approve.' },
}

export const VERSION_RECORD: VersionRecord = {
  version: VERSION_V1,
  comparison: { fromNumber: null, toNumber: 1, added: CHECKS_V1.map(({ code, labelIt, labelEn }) => ({ code, labelIt, labelEn })), removed: [], changed: [], moved: [], sampling: [], same: false },
  records: [
    { kind: 'FINAL', id: uid('7740', 1), number: 'DEMO-INS-0018', status: 'PASSED', siteId: uid('7741', 1), at: at(27, 15) },
    { kind: 'FINAL', id: uid('7740', 2), number: 'DEMO-INS-0017', status: 'FAILED', siteId: uid('7741', 1), at: at(26, 10) },
    { kind: 'FINAL', id: uid('7740', 3), number: 'DEMO-INS-0016', status: 'OPEN', siteId: uid('7741', 1), at: at(25, 9) },
  ],
  may: { manage: true, approve: false, approveHeld: null },
}

export const VERSION_RECORD_V2: VersionRecord = { version: VERSION_V2, comparison: COMPARISON, records: [], may: { manage: true, approve: true, approveHeld: null } }

// ---- AQL profiles ----

const profile = (n: number, over: Partial<Profile> & Pick<Profile, 'code' | 'name'>): Profile => ({
  id: uid('7750', n),
  companyId: COMPANY_ID,
  inspectionLevel: 'II',
  aqlCritical: '0.000',
  aqlMajor: '2.500',
  aqlMinor: '4.000',
  isDefault: false,
  active: true,
  note: null,
  usedBy: { customers: 0, styles: 0, pairs: 0 },
  inspections: 0,
  version: 2,
  updatedAt: at(10),
  ...over,
})

export const PROFILE_ROWS: Profile[] = [
  profile(1, { code: 'AQL-STD', name: 'Standard', isDefault: true, inspections: 31 }),
  profile(2, { code: 'AQL-EXM', name: 'Export customers', aqlMajor: '1.500', aqlMinor: '2.500', usedBy: { customers: 1, styles: 0, pairs: 0 }, inspections: 6 }),
  profile(3, { code: 'AQL-TIGHT', name: 'Tight, one style of one customer', aqlMajor: '1.000', aqlMinor: '1.500', usedBy: { customers: 0, styles: 0, pairs: 1 } }),
  profile(4, { code: 'AQL-S3', name: 'Small lots, special S-3', inspectionLevel: 'S3', aqlMajor: '4.000', aqlMinor: '6.500', active: false }),
]

export const PROFILES: ProfilesAnswer = {
  profiles: PROFILE_ROWS,
  aqlValues: ['0', '0.010', '0.015', '0.025', '0.040', '0.065', '0.10', '0.15', '0.25', '0.40', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10'],
  criticalLock: { aql: '0', accept: 0, reject: 1, law: 'Regulation (EU) 2016/425 (PPE), art. 8 and Annex II' },
  manageCompanyIds: [COMPANY_ID],
}

export const ASSIGNMENTS: Assignment[] = [{ id: uid('7751', 1), profileId: PROFILE_ROWS[1]!.id, profileCode: 'AQL-EXM', customer: { id: uid('7720', 1), name: 'Demo Moto Srl' }, style: null, active: true, version: 1 }]

// ---- rules ----

const rule = (n: number, over: Partial<Rule> & Pick<Rule, 'event' | 'plan' | 'frequency'>): Rule => ({
  id: uid('7760', n),
  companyId: COMPANY_ID,
  position: n,
  sortOrder: n * 10,
  appliesTo: [],
  frequencyValue: null,
  recordKind: null,
  dueHours: null,
  active: true,
  opened: { last30Days: 0, lastAt: null },
  skipped: { last30Days: 0, lastAt: null, lastWords: null },
  version: 1,
  ...over,
})

const planRef = (index: number) => {
  const plan = PLAN_ROWS[index]!
  return { id: plan.id, code: plan.code, name: plan.name, stage: plan.stage, approved: plan.approved, appliesTo: plan.appliesTo }
}

export const RULES: Rule[] = [
  rule(1, { event: 'GOODS_RECEIPT', plan: planRef(0), frequency: 'EVERY_LOT', recordKind: 'INCOMING', appliesTo: [{ kind: 'CATEGORY', value: 'LEATHER', label: 'Leather' }], opened: { last30Days: 12, lastAt: at(28, 8) } }),
  rule(2, { event: 'BUNDLE_SCAN', plan: planRef(2), frequency: 'FIRST_PIECE', recordKind: 'FIRST_PIECE', opened: { last30Days: 9, lastAt: at(28, 7) }, skipped: { last30Days: 3, lastAt: at(27), lastWords: { it: 'DEMO-WO-0042: un primo capo è già aperto a questa operazione.', en: 'DEMO-WO-0042: a first piece is open at this operation already.' } } }),
  rule(3, { event: 'OPERATION_FINISHED', plan: planRef(3), frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 10, recordKind: 'END_OF_LINE', active: false }),
  // B-W2b-213: a packing rule whose final inspections are due 8 hours after they open.
  rule(4, { event: 'PACKING', plan: planRef(4), frequency: 'EVERY_LOT', recordKind: 'FINAL', dueHours: 8, opened: { last30Days: 4, lastAt: at(28, 9) } }),
]

const inProcess = { stages: ['CUTTING', 'IN_LINE', 'END_OF_LINE'] as RulesAnswer['events'][number]['stages'], frequencies: [{ frequency: 'EVERY_LOT' as const, takesValue: false }, { frequency: 'PERCENT_OF_OPERATIONS' as const, takesValue: true }, { frequency: 'FIRST_PIECE' as const, takesValue: false }, { frequency: 'EVERY_NTH_BUNDLE' as const, takesValue: true }], chipKinds: ['STYLE', 'CATEGORY', 'OPERATION', 'CUSTOMER'] as RulesAnswer['events'][number]['chipKinds'] }

export const RULES_ANSWER: RulesAnswer = {
  rules: RULES,
  events: [
    { event: 'GOODS_RECEIPT', available: true, held: null, stages: ['INCOMING'], frequencies: [{ frequency: 'EVERY_LOT', takesValue: false }], chipKinds: ['STYLE', 'CATEGORY', 'MATERIAL', 'SUPPLIER', 'OPERATION', 'CUSTOMER'] },
    { event: 'OPERATION_FINISHED', available: true, held: null, ...inProcess },
    { event: 'BUNDLE_SCAN', available: true, held: null, ...inProcess },
    // B-W2b-213: packing opens a final inspection (no inspector yet; the first who records it takes it).
    { event: 'PACKING', available: true, held: null, stages: ['FINAL'], frequencies: [{ frequency: 'EVERY_LOT', takesValue: false }, { frequency: 'PERCENT_OF_OPERATIONS', takesValue: true }, { frequency: 'EVERY_NTH_BUNDLE', takesValue: true }], chipKinds: ['STYLE', 'CATEGORY', 'OPERATION', 'CUSTOMER'] },
    { event: 'RETURN_RECEIVED', available: false, held: { it: "Non ancora: un reso non ha un record d'ispezione.", en: 'Not yet: a return has no inspection record.' }, stages: [], frequencies: [], chipKinds: [] },
  ],
  canManage: true,
}

export const PREVIEW_WORDS = {
  considered: 120,
  fits: 40,
  earlier: 6,
  opened: 14,
  from: '2026-09-29',
  to: '2026-10-29',
  truncated: false,
  words: {
    it: 'Questa regola avrebbe creato 14 ispezioni nell’ultimo mese (2026-09-29 – 2026-10-29): 40 di 120 lotti ricevuti corrispondono; 6 sono andati a una regola precedente.',
    en: 'This rule would have created 14 inspections in the last month (2026-09-29 – 2026-10-29): 40 of 120 lots received fit it; 6 went to an earlier rule.',
  },
}

// ---- the calculator ----

export const calcPlan = (lotSize: number, level: Profile['inspectionLevel'], aqlMajor: string, aqlMinor: string) => {
  const plan = samplingPlan({ lotSize, level, aqlMajor, aqlMinor })
  return { lotSize: plan.lotSize, level: plan.level, codeLetter: plan.codeLetter, sampleSize: plan.sampleSize, hundredPercent: plan.hundredPercent, samplesDiffer: plan.samplesDiffer, classes: plan.classes.map((entry) => ({ ...entry })) }
}

// ---- the printable checklist ----

export const CHECKLIST_IT: Checklist = {
  language: 'it',
  title: 'DEMO-FIN-JACKET · Final check, motorcycle jacket',
  subtitle: 'Lista di controllo, versione 1',
  notInForce: null,
  lines: [
    { label: 'Fase', value: 'Finale' },
    { label: 'Versione', value: 'v1 · Approvata' },
    { label: 'Approvata da', value: 'Marta Demo · 2026-10-02' },
    { label: 'Campione', value: 'Profilo AQL che si applica (modello, cliente, predefinito)' },
    { label: 'Al numero di rifiuto', value: 'Come dicono le regole qualità' },
    { label: 'Lotto / ordine', value: '________________' },
    { label: 'Quantità del lotto · campione', value: '________ · ________' },
  ],
  rows: [
    { n: 1, code: 'CE_MARK', label: 'Marcatura CE leggibile', missing: false, type: 'Conforme / non conforme', takesResult: true, klass: 'Critico', critical: true, mandatory: true, photoRequired: false, spec: null, answer: '☐ Conforme   ☐ Non conforme   ☐ Non applicabile', choices: [] },
    { n: 2, code: 'READ', label: 'Leggere la scheda del modello prima di iniziare', missing: false, type: 'Solo istruzione', takesResult: false, klass: null, critical: false, mandatory: false, photoRequired: false, spec: null, answer: 'Da leggere', choices: [] },
    { n: 3, code: 'CHEST', label: 'Mezzo torace', missing: false, type: 'Misura', takesResult: true, klass: 'Maggiore', critical: false, mandatory: true, photoRequired: false, spec: '58 ± 1 cm', answer: 'Misurato: ________', choices: [] },
    { n: 4, code: 'PROTECTORS', label: 'Protezioni nelle tasche', missing: false, type: 'Conteggio', takesResult: true, klass: 'Maggiore', critical: false, mandatory: true, photoRequired: false, spec: null, answer: 'Contati: ________', choices: [] },
  ],
  sampleColumns: 0,
  signatures: ['Ispettore ________________', 'Data e ora ________________', 'Esito: ☐ Accettato   ☐ Respinto'],
  legend: 'Obbligatorio: senza risposta il controllo non è firmato come superato. Critico: se non è conforme, il controllo non passa.',
  languages: ['it', 'en', 'ro'],
}

export const CHECKLIST_DRAFT_EN: Checklist = {
  ...CHECKLIST_IT,
  language: 'en',
  subtitle: 'Checklist, version 2',
  notInForce: 'Draft version: not the one in force. Do not use it for an inspection.',
  lines: [
    { label: 'Stage', value: 'Final' },
    { label: 'Version', value: 'v2 · Draft' },
    { label: 'Sample', value: 'Fixed sample of 5 units' },
    { label: 'At the reject number', value: 'Stop' },
    { label: 'Lot / order', value: '________________' },
    { label: 'Lot size · sample', value: '________ · ________' },
  ],
  rows: [
    { n: 1, code: 'CE_MARK', label: 'CE mark readable', missing: false, type: 'Pass / fail', takesResult: true, klass: 'Critical', critical: true, mandatory: true, photoRequired: false, spec: null, answer: '☐ Pass   ☐ Fail   ☐ Not applicable', choices: [] },
    { n: 2, code: 'ZIP_RUN', label: 'Zip runs to the end', missing: false, type: 'Pass / fail', takesResult: true, klass: 'Major', critical: false, mandatory: true, photoRequired: true, spec: null, answer: '☐ Pass   ☐ Fail   ☐ Not applicable', choices: [] },
    { n: 3, code: 'STITCH', label: 'Collar stitching', missing: false, type: 'Choice', takesResult: true, klass: 'Minor', critical: false, mandatory: true, photoRequired: false, spec: null, answer: 'Tick one answer', choices: ['☐ Clean', '☐ Uneven', '☐ Skipped'] },
  ],
  sampleColumns: 5,
  signatures: ['Inspector ________________', 'Date and time ________________', 'Result: ☐ Accepted   ☐ Rejected'],
  legend: 'Mandatory: without an answer the inspection is not signed as passed. Critical: a fail fails the inspection.',
}

export const NOW_ISO = at(29, 9, 42)
export { YOU as ME_PERSON }
