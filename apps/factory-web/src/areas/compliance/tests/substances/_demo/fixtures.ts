import { at, COMPANY_ID, day, NOW, uid } from '../../../../quality/_shared/fixtures'
import type { AskAnswer, DeclarationCounts, DeclarationDetail, DeclarationList, DeclarationRequest } from '../../declarations/api'
import type { MaterialEvaluation, ProfileList, ProfileRecord, ProfileRow, RuleVerdict } from '../../profiles/api'
import type { CandidateListVersion, PlansAnswer, RulesAnswer, Substance, SubstanceRule, SubstancesAnswer, TestPlan, VersionsAnswer } from '../api'

/**
 * Made-up data for the design cases of B-W2b-267 (Supplier declarations, Material profiles, the Substance list, the test
 * plan rules, the material profile card): "Demo" suppliers and materials, DEMO-SD-… numbers, invented values. The substances
 * and their CAS numbers are public law (REACH Annex XVII); nothing here is a real company, person or result.
 */

export const SUP_A = { id: uid('2671', 1), code: 'DEMO-SUP-01', name: 'Demo Conceria Alfa' }
export const SUP_B = { id: uid('2671', 2), code: 'DEMO-SUP-02', name: 'Demo Tessiture Beta' }
export const SUP_C = { id: uid('2671', 3), code: 'DEMO-SUP-03', name: 'Demo Minuterie Gamma' }

export const LEATHER = { id: uid('2672', 1), code: 'DEMO-PELLE-NERA', name: 'Demo cowhide black 1.2 mm', kind: 'LEATHER' }
export const LINING = { id: uid('2672', 2), code: 'DEMO-FODERA-RETE', name: 'Demo mesh lining', kind: 'LINING' }
export const ZIP = { id: uid('2672', 3), code: 'DEMO-ZIP-METAL', name: 'Demo metal zip 8 mm', kind: 'HARDWARE' }
export const MEMBRANE = { id: uid('2672', 4), code: 'DEMO-MEMBRANA', name: 'Demo waterproof membrane', kind: 'MEMBRANE' }
export const PROTECTOR = { id: uid('2672', 5), code: 'DEMO-PROT-SPALLA', name: 'Demo shoulder protector level 2', kind: 'PROTECTOR' }

const V_JAN = { id: uid('2673', 1), publishedOn: '2026-01-15' }
const V_JUL = { id: uid('2673', 2), publishedOn: '2026-07-01' }
export const NEWEST = { ...V_JUL, entryCount: 253 }

const label = (material: { code: string; name: string }) => `${material.code} · ${material.name}`

export function demoRequest(n: number, over: Partial<DeclarationRequest> = {}): DeclarationRequest {
  return {
    id: uid('2674', n),
    number: `DEMO-SD-${String(n).padStart(4, '0')}`,
    companyId: COMPANY_ID,
    party: SUP_A,
    kind: 'REACH_SVHC',
    kindShort: 'SVHC',
    svhcListVersion: V_JUL,
    answeredListVersion: null,
    channel: 'PORTAL',
    sentAt: at(10 + n, 9, 30),
    dueOn: '2027-01-29',
    overdueDays: 0,
    reminderEveryDays: 7,
    remindersSent: 0,
    lastRemindedAt: null,
    reminderDue: false,
    status: 'SENT',
    shown: 'REQUESTED',
    answeredAt: null,
    validTo: null,
    file: null,
    materials: [{ itemId: LEATHER.id, code: LEATHER.code, name: LEATHER.name, kind: LEATHER.kind, articleLabel: label(LEATHER) }],
    lines: 1,
    answeredLines: 0,
    supersedesId: null,
    supersededBy: null,
    version: 2,
    ...over,
  }
}

const zipLine = { itemId: ZIP.id, code: ZIP.code, name: ZIP.name, kind: ZIP.kind, articleLabel: `GZ-8 · ${ZIP.name}` }
const liningLine = { itemId: LINING.id, code: LINING.code, name: LINING.name, kind: LINING.kind, articleLabel: label(LINING) }
const membraneLine = { itemId: MEMBRANE.id, code: MEMBRANE.code, name: MEMBRANE.name, kind: MEMBRANE.kind, articleLabel: label(MEMBRANE) }

export const REQUESTS: DeclarationRequest[] = [
  demoRequest(1),
  demoRequest(2, { party: SUP_C, kind: 'NICKEL', kindShort: 'Nickel release', svhcListVersion: null, dueOn: day(20), overdueDays: 9, status: 'OVERDUE', shown: 'OVERDUE', remindersSent: 2, lastRemindedAt: at(24, 3, 35), reminderDue: true, materials: [zipLine] }),
  demoRequest(3, { party: SUP_B, kind: 'PFAS', kindShort: 'PFAS-free', svhcListVersion: null, status: 'ANSWERED', shown: 'ANSWERED', answeredAt: at(27, 11, 5), file: { source: 'UPLOAD', uploadId: uid('2675', 3), fileId: uid('2676', 3), uploadStatus: 'WAITING' }, materials: [membraneLine, liningLine], lines: 2, answeredLines: 1 }),
  demoRequest(4, { party: SUP_B, kind: 'RSL', kindShort: 'RSL', svhcListVersion: null, channel: 'OFFICE', status: 'ANSWERED', shown: 'ANSWERED', answeredAt: at(26, 15, 40), file: { source: 'FILE', uploadId: null, fileId: uid('2676', 4), uploadStatus: null }, materials: [liningLine], lines: 1, answeredLines: 1, reminderEveryDays: null }),
  demoRequest(5, { svhcListVersion: V_JAN, answeredListVersion: V_JAN, status: 'ACCEPTED', shown: 'REREQUEST_NEEDED', answeredAt: at(3, 10, 0), validTo: '2027-01-31', file: { source: 'UPLOAD', uploadId: uid('2675', 5), fileId: uid('2676', 5), uploadStatus: 'ACCEPTED' }, answeredLines: 1 }),
  demoRequest(6, { party: SUP_C, kind: 'CR6', kindShort: 'Cr VI', svhcListVersion: null, channel: 'OFFICE', status: 'ACCEPTED', shown: 'ACCEPTED', answeredAt: at(5, 9, 20), validTo: '2027-04-30', file: { source: 'FILE', uploadId: null, fileId: uid('2676', 6), uploadStatus: null }, answeredLines: 1 }),
  demoRequest(7, { party: SUP_B, kind: 'RSL', kindShort: 'RSL', svhcListVersion: null, status: 'REFUSED', shown: 'REJECTED', answeredAt: at(8, 14, 0), file: { source: 'UPLOAD', uploadId: uid('2675', 7), fileId: uid('2676', 7), uploadStatus: 'WAITING' }, materials: [liningLine], answeredLines: 1 }),
  demoRequest(8, { party: SUP_C, kind: 'NICKEL', kindShort: 'Nickel release', svhcListVersion: null, status: 'CANCELLED', shown: 'CANCELLED', materials: [zipLine] }),
]

export const DEMO_COUNTS: DeclarationCounts = { open: 4, overdue: 1, answered: 2, rerequest: 1, expired: 0 }

export const demoList = (requests: DeclarationRequest[] = REQUESTS, counts: DeclarationCounts = DEMO_COUNTS): DeclarationList => ({ requests, more: false, counts, newestListVersion: NEWEST, mayAsk: true, asOf: NOW })

export function demoDetail(request: DeclarationRequest, over: Partial<DeclarationDetail> = {}): DeclarationDetail {
  return {
    ...request,
    message: 'Please declare the substances of the attached list for the materials below. Thank you.',
    internalNote: null,
    lineRows: request.materials.map((material, index) => ({
      id: uid('2677', request.version * 10 + index + Number(request.number.slice(-2))),
      seq: index + 1,
      item: { id: material.itemId, code: material.code, name: material.name, kind: material.kind },
      articleLabel: material.articleLabel,
      contains: index < request.answeredLines ? false : null,
      aboveThreshold: index < request.answeredLines ? false : null,
      substance: null,
      substanceName: null,
      concentration: null,
      concentrationUnit: null,
      note: null,
      version: 1,
    })),
    upload:
      request.file?.source === 'UPLOAD'
        ? { id: request.file.uploadId!, fileId: request.file.fileId!, status: request.file.uploadStatus ?? 'WAITING', category: 'DECLARATION', issuer: request.party.name, documentNumber: 'DEMO-DEC-112', issuedOn: day(20), expiresOn: '2027-10-31', receivedAt: request.answeredAt, uploadedByName: 'Demo Supplier Contact', documentFileId: null }
        : null,
    partnerTask: request.channel === 'PORTAL' ? { id: uid('2678', 1), status: request.status === 'SENT' || request.status === 'OVERDUE' ? 'OPEN' : 'DONE', dueAt: `${request.dueOn}T22:59:59Z`, remindedAt: request.lastRemindedAt, closedAt: request.answeredAt } : null,
    decidedAt: request.status === 'ACCEPTED' || request.status === 'REFUSED' ? at(28, 10, 15) : null,
    decidedBy: request.status === 'ACCEPTED' || request.status === 'REFUSED' ? { id: uid('3333', 1), name: 'Demo Quality Lead' } : null,
    refuseReason: request.status === 'REFUSED' ? 'The declaration names an older list: please send the current one.' : null,
    cancelledAt: request.status === 'CANCELLED' ? at(15, 9, 0) : null,
    cancelReason: request.status === 'CANCELLED' ? 'Supplier changed: asked of the new one.' : null,
    supersedes: null,
    newestListVersion: NEWEST,
    ...over,
  }
}

export const demoAskReview = (sent = false): AskAnswer => ({
  sent,
  companyId: COMPANY_ID,
  svhcListVersion: NEWEST,
  counts: { send: 2, add: 1, skip: 1 },
  groups: [
    { party: { ...SUP_A, portalOn: true }, kind: 'REACH_SVHC', kindShort: 'SVHC', channel: null, outcome: 'ADD', why: null, materials: [{ itemId: LEATHER.id, code: LEATHER.code, name: LEATHER.name, articleLabel: label(LEATHER) }], request: { requestId: uid('2674', 1), number: 'DEMO-SD-0001' } },
    { party: { ...SUP_A, portalOn: true }, kind: 'PFAS', kindShort: 'PFAS-free', channel: 'PORTAL', outcome: 'SEND', why: null, materials: [{ itemId: LEATHER.id, code: LEATHER.code, name: LEATHER.name, articleLabel: label(LEATHER) }], request: sent ? { requestId: uid('2674', 9), number: 'DEMO-SD-0009' } : null },
    { party: { ...SUP_B, portalOn: false }, kind: 'PFAS', kindShort: 'PFAS-free', channel: 'OFFICE', outcome: 'SEND', why: null, materials: [{ itemId: MEMBRANE.id, code: MEMBRANE.code, name: MEMBRANE.name, articleLabel: label(MEMBRANE) }], request: sent ? { requestId: uid('2674', 10), number: 'DEMO-SD-0010' } : null },
    { party: { ...SUP_B, portalOn: false }, kind: 'REACH_SVHC', kindShort: 'SVHC', channel: null, outcome: 'SKIP', why: 'answered already', materials: [{ itemId: MEMBRANE.id, code: MEMBRANE.code, name: MEMBRANE.name, articleLabel: label(MEMBRANE) }], request: { requestId: uid('2674', 3), number: 'DEMO-SD-0003' } },
  ],
})

// ---- material profiles --------------------------------------------------------------------------------------------------

export function demoProfile(material: { id: string; code: string; name: string; kind: string }, over: Partial<ProfileRow> = {}): ProfileRow {
  return {
    material: { ...material, companyId: COMPANY_ID, status: 'ACTIVE' },
    composition: null,
    tannage: null,
    animalSpecies: null,
    originCountry: null,
    supplier: SUP_A,
    state: 'INCOMPLETE',
    stateReason: 'Made-up evaluator words (never shown).',
    evaluatedAt: at(28, 3, 50),
    testsNeeded: [],
    declarations: { needed: ['REACH_SVHC', 'RSL'], present: [], missing: ['REACH_SVHC', 'RSL'], asked: [] },
    compositionConfirmed: false,
    tannageConfirmed: null,
    innocuousness: { required: false, complete: true, parameters: [] },
    svhcAboveThreshold: null,
    version: 3,
    ...over,
  }
}

export const PROFILES: ProfileRow[] = [
  demoProfile(LEATHER, {
    composition: '100 % cowhide',
    tannage: 'CHROME',
    animalSpecies: 'Bovine',
    originCountry: 'IT',
    compositionConfirmed: true,
    tannageConfirmed: false,
    testsNeeded: ['CR_VI', 'AZO'],
    declarations: { needed: ['REACH_SVHC', 'RSL', 'CR6'], present: ['CR6'], missing: ['REACH_SVHC', 'RSL'], asked: ['REACH_SVHC'] },
    innocuousness: { required: true, complete: false, parameters: [{ parameter: 'PH', status: 'FILE' }, { parameter: 'CR_VI', status: 'MET' }, { parameter: 'AZO', status: 'MISSING' }] },
  }),
  demoProfile(LINING, { supplier: SUP_B, composition: '100 % polyester', compositionConfirmed: true, originCountry: 'PK', declarations: { needed: ['REACH_SVHC', 'RSL'], present: ['REACH_SVHC', 'RSL'], missing: [], asked: [] }, state: 'COMPLETE' }),
  demoProfile(ZIP, { supplier: SUP_C, testsNeeded: ['NICKEL'], declarations: { needed: ['REACH_SVHC', 'NICKEL'], present: [], missing: ['REACH_SVHC', 'NICKEL'], asked: ['NICKEL'] }, state: 'BLOCKED', innocuousness: { required: true, complete: false, parameters: [{ parameter: 'NICKEL', status: 'FAILED' }] } }),
  demoProfile(MEMBRANE, { supplier: SUP_B, composition: '100 % polyurethane', declarations: { needed: ['REACH_SVHC', 'RSL', 'PFAS'], present: ['REACH_SVHC'], missing: ['RSL', 'PFAS'], asked: ['PFAS'] } }),
  demoProfile(PROTECTOR, { supplier: null, state: null, evaluatedAt: null, version: null, declarations: { needed: [], present: [], missing: [], asked: [] } }),
]

export const demoProfiles = (profiles: ProfileRow[] = PROFILES): ProfileList => ({ profiles, more: false, counts: { materials: 5, none: 1, incomplete: 2, complete: 1, blocked: 1 }, mayEdit: true, asOf: NOW })

export function demoProfileRecord(row: ProfileRow = PROFILES[0]!, over: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    ...row,
    compositionList: row.composition ? [{ fibre: 'cowhide', percent: '100' }] : [],
    isPpeComponent: false,
    requiresCrViTest: row.material.kind === 'LEATHER',
    compositionConfirmedAt: row.compositionConfirmed ? at(12, 10, 0) : null,
    compositionConfirmedBy: row.compositionConfirmed ? { id: uid('3333', 1), name: 'Demo Quality Lead' } : null,
    tannageConfirmedAt: null,
    tannageConfirmedBy: null,
    note: null,
    innocuousnessDetail: {
      required: row.innocuousness.required,
      ppeStyles: row.innocuousness.required ? ['DEMO-JKT-01', 'DEMO-JKT-02'] : [],
      complete: row.innocuousness.complete,
      parameters: row.innocuousness.parameters.map((entry) => ({
        parameter: entry.parameter,
        status: entry.status,
        result: entry.status === 'MET' || entry.status === 'FAILED' ? { resultId: uid('2679', 1), lotId: uid('5402', 1), test: entry.parameter, verdict: entry.status === 'MET' ? 'PASS' : 'FAIL', testedOn: day(14) } : null,
        files: entry.status === 'FILE' ? [uid('2676', 20)] : [],
      })),
    },
    evidenceFiles: [],
    declarationRequests: [
      { requestId: uid('2674', 1), number: 'DEMO-SD-0001', kind: 'REACH_SVHC', status: 'SENT', party: { id: SUP_A.id, code: SUP_A.code }, dueOn: day(30), validTo: null },
      { requestId: uid('2674', 6), number: 'DEMO-SD-0006', kind: 'CR6', status: 'ACCEPTED', party: { id: SUP_C.id, code: SUP_C.code }, dueOn: day(15), validTo: '2027-04-30' },
    ],
    labResults: [
      { resultId: uid('2679', 1), lot: { id: uid('5402', 1), code: 'DEMO-L-0231' }, test: 'CR_VI', verdict: 'PASS', testedOn: day(14), value: '1.200', belowDetectionLimit: false, unit: 'mg/kg', limit: '3.000', method: 'EN ISO 17075-1', lab: 'Demo Lab', current: true },
      { resultId: uid('2679', 2), lot: { id: uid('5402', 2), code: 'DEMO-L-0232' }, test: 'AZO', verdict: 'PASS', testedOn: day(16), value: null, belowDetectionLimit: true, unit: 'mg/kg', limit: '30.000', method: 'EN ISO 17234-1', lab: 'Demo Lab', current: true },
    ],
    mayEdit: true,
    ...over,
  }
}

const verdict = (n: number, key: string, code: string, status: RuleVerdict['status'], over: Partial<RuleVerdict> = {}): RuleVerdict => ({
  ruleId: uid('2680', n),
  key,
  code,
  name: key,
  legalReference: `REACH Annex XVII entry ${key.split('-').pop()}`,
  limit: 'made-up words (never shown)',
  status,
  why: null,
  evidence: 'EITHER',
  needs: { test: null, declaration: null },
  metBy: null,
  asked: null,
  ...over,
})

export const demoEvaluation = (state: MaterialEvaluation['state'] = 'INCOMPLETE'): MaterialEvaluation => ({
  rules: [
    verdict(1, 'REACH-XVII-47', 'CR6', 'MET', { metBy: 'TEST', evidence: 'TEST', needs: { test: 'CR_VI', declaration: 'CR6' } }),
    verdict(2, 'REACH-XVII-43', 'AZO', 'MISSING', { needs: { test: 'AZO', declaration: 'RSL' } }),
    verdict(3, 'REACH-XVII-61', 'DMFU', 'MISSING', { evidence: 'DECLARATION', needs: { test: null, declaration: 'RSL' }, asked: { requestId: uid('2674', 4), number: 'DEMO-SD-0004', dueOn: day(30), status: 'ANSWERED' } }),
    verdict(4, 'REACH-XVII-27', 'NICKEL', 'NOT_APPLICABLE', { why: 'MATERIAL_KIND' }),
    verdict(5, 'REACH-XVII-72', 'CMR', 'NOT_APPLICABLE', { why: 'SWITCHED_OFF' }),
    verdict(6, 'REACH-XVII-79', 'PFAS', 'NOT_APPLICABLE', { why: 'SWITCHED_OFF' }),
  ],
  svhc: { aboveThreshold: false, substances: [], listVersion: { ...V_JAN, entryCount: 250 }, newestVersion: NEWEST, current: false, grewBy: 3, source: 'DECLARATION' },
  state,
  mayEvaluate: true,
})

// ---- the substance list ---------------------------------------------------------------------------------------------------

const ruleRef = (n: number, key: string, code: SubstanceRule['code'], limitValue: string | null, unit: SubstanceRule['limitUnit'], kinds: string[], method: string | null, switchedOn = true) => ({
  id: uid('2681', n),
  key,
  code,
  name: key,
  limitValue,
  limitUnit: unit,
  limitBound: limitValue ? ('AT_MOST' as const) : null,
  materialKinds: kinds,
  testMethod: method,
  source: 'LAW' as const,
  switchedOn,
  status: 'ACTIVE' as const,
})

const R47 = ruleRef(1, 'REACH-XVII-47', 'CR6', '3', 'MG_KG', ['LEATHER'], 'EN ISO 17075-1')
const R43 = ruleRef(2, 'REACH-XVII-43', 'AZO', '30', 'MG_KG', ['LEATHER', 'TEXTILE', 'LINING'], 'EN ISO 17234-1')
const R27 = ruleRef(3, 'REACH-XVII-27', 'NICKEL', '0.5', 'UG_CM2_WEEK', ['HARDWARE', 'TRIM'], 'EN 1811')
const R61 = ruleRef(4, 'REACH-XVII-61', 'DMFU', '0.1', 'MG_KG', [], 'ISO 16186')
const R72 = ruleRef(5, 'REACH-XVII-72', 'CMR', null, null, ['TEXTILE', 'LEATHER'], null, false)
const R79 = ruleRef(6, 'REACH-XVII-79', 'PFAS', '25', 'UG_KG', ['MEMBRANE', 'TEXTILE'], 'CEN/TS 15968', false)

const substance = (n: number, name: string, cas: string | null, rules: Substance['rules'], over: Partial<Substance> = {}): Substance => ({
  id: uid('2682', n),
  companyId: null,
  casNumber: cas,
  ecNumber: null,
  name,
  nameI18n: {},
  groupCode: null,
  lists: ['REACH_ANNEX_XVII'],
  annexXviiEntries: [rules[0]?.key.split('-').pop() ?? ''],
  svhcListVersion: null,
  note: null,
  status: 'ACTIVE',
  rules,
  version: 1,
  ...over,
})

export const SUBSTANCES: Substance[] = [
  substance(1, 'Chromium VI compounds', '18540-29-9', [R47], { ecNumber: '242-410-1', nameI18n: { it: 'Composti del cromo VI' } }),
  substance(2, 'Benzidine', '92-87-5', [R43], { groupCode: 'AZO_AMINES', nameI18n: { it: 'Benzidina' } }),
  substance(3, 'Nickel', '7440-02-0', [R27], { ecNumber: '231-111-4', nameI18n: { it: 'Nichel' } }),
  substance(4, 'Dimethyl fumarate', '624-49-7', [R61], { nameI18n: { it: 'Dimetilfumarato' } }),
  substance(5, 'Bis(2-ethylhexyl) phthalate (DEHP)', '117-81-7', [R72], { lists: ['REACH_ANNEX_XVII', 'SVHC'], annexXviiEntries: ['72'], svhcListVersion: V_JAN }),
  substance(6, 'PFHxA, its salts and related substances', null, [R79], { groupCode: 'PFHXA', annexXviiEntries: ['79'] }),
]

export const demoSubstances = (rows: Substance[] = SUBSTANCES): SubstancesAnswer => ({ substances: rows, more: false, asOf: NOW, mayManage: true })

const fullRule = (ref: ReturnType<typeof ruleRef>, over: Partial<SubstanceRule> = {}): SubstanceRule => ({
  ...ref,
  companyId: null,
  substance: null,
  substanceGroup: null,
  members: 0,
  productTypes: [],
  marketCodes: [],
  evidence: 'EITHER',
  exemptPpe: false,
  exemptNaturalLeather: false,
  customer: null,
  legalReference: `REACH Annex XVII entry ${ref.key.split('-').pop()}`,
  legalUrl: 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj',
  offReason: ref.switchedOn ? null : 'Off until a style or a market needs it (Owner, Q5 A): the limits per substance group are to be verified first.',
  switchedAt: ref.switchedOn ? null : at(9, 7, 0),
  switchedBy: ref.switchedOn ? null : { id: uid('3333', 2), name: 'Demo Owner' },
  test: ref.code === 'CMR' ? null : ref.code === 'CR6' ? 'CR_VI' : (ref.code as SubstanceRule['test']),
  declaration: ref.code === 'NICKEL' || ref.code === 'CR6' || ref.code === 'PFAS' ? ref.code : 'RSL',
  version: 2,
  ...over,
})

export const RULES: SubstanceRule[] = [
  fullRule(R47, { substance: { id: uid('2682', 1), casNumber: '18540-29-9', name: 'Chromium VI compounds', status: 'ACTIVE' }, evidence: 'TEST' }),
  fullRule(R43, { substanceGroup: 'AZO_AMINES', members: 22 }),
  fullRule(R27, { substance: { id: uid('2682', 3), casNumber: '7440-02-0', name: 'Nickel', status: 'ACTIVE' } }),
  fullRule(R61, { substance: { id: uid('2682', 4), casNumber: '624-49-7', name: 'Dimethyl fumarate', status: 'ACTIVE' }, evidence: 'DECLARATION' }),
  fullRule(R72, { substanceGroup: 'CMR_APP12', members: 1, evidence: 'DECLARATION' }),
  fullRule(R79, { substanceGroup: 'PFHXA', members: 1, marketCodes: ['FR'] }),
]

export const demoRules = (rows: SubstanceRule[] = RULES): RulesAnswer => ({ rules: rows, asOf: NOW, mayManage: true })

export const VERSIONS: CandidateListVersion[] = [
  { id: V_JUL.id, publishedOn: V_JUL.publishedOn, entryCount: 253, source: 'ECHA Candidate List', sourceUrl: 'https://echa.europa.eu/candidate-list-table', note: null, substancesAdded: 3, grewBy: 3, newest: true, version: 1 },
  { id: V_JAN.id, publishedOn: V_JAN.publishedOn, entryCount: 250, source: 'ECHA Candidate List', sourceUrl: null, note: null, substancesAdded: 1, grewBy: null, newest: false, version: 1 },
]

export const demoVersions = (rows: CandidateListVersion[] = VERSIONS): VersionsAnswer => ({ versions: rows, asOf: NOW, mayManage: true })

const plan = (n: number, test: TestPlan['test'], frequency: TestPlan['frequency'], over: Partial<TestPlan> = {}): TestPlan => ({
  id: uid('2683', n),
  companyId: null,
  itemKind: 'LEATHER',
  item: null,
  test,
  frequency,
  marketCode: null,
  substanceRule: null,
  method: null,
  switchedOn: true,
  offReason: null,
  switchedAt: null,
  switchedBy: null,
  note: null,
  status: 'ACTIVE',
  version: 1,
  ...over,
})

export const PLANS: TestPlan[] = [
  plan(1, 'CR_VI', 'EVERY_LOT', { method: 'EN ISO 17075-1', substanceRule: { id: R47.id, key: R47.key, code: 'CR6', name: R47.key, limit: 'made-up', switchedOn: true, status: 'ACTIVE' } }),
  plan(2, 'AZO', 'ON_CHANGE', { method: 'EN ISO 17234-1' }),
  plan(3, 'NICKEL', 'FIRST_LOT', { itemKind: null, item: { id: ZIP.id, code: ZIP.code, name: ZIP.name, kind: ZIP.kind }, method: 'EN 1811' }),
  plan(4, 'PAH', 'YEARLY', { itemKind: 'PROTECTOR' }),
  plan(5, 'PFAS', 'YEARLY', { itemKind: 'MEMBRANE', marketCode: 'FR', switchedOn: false, offReason: 'Waits for the PFAS rule (entry 79) to be switched on.' }),
]

export const demoPlans = (rows: TestPlan[] = PLANS): PlansAnswer => ({ plans: rows, mayManage: true, asOf: NOW })

/** A small made-up one-page PDF (Helvetica), so the viewer has something to draw in the design cases. */
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

export const DECLARATION_PDF = demoPdf(['Demo Tessiture Beta - supplier declaration (made up)', '', 'Restricted substances: none above the limits of the list.', 'Articles: DEMO-MEMBRANA, DEMO-FODERA-RETE', 'Valid to 31/10/2027'])
