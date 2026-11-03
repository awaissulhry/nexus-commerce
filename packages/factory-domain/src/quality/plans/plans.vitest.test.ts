import { describe, expect, it } from 'vitest'
import { CHECKLIST_ITEMS } from '../final/rules'
import { printableChecklist } from './checklist'
import {
  approvalSha256,
  approvalText,
  approverRefusal,
  checkContentOf,
  checksProblems,
  chipsMatch,
  chipsProblems,
  compareVersions,
  contentProblems,
  PLAN_STAGES,
  planDraftProblems,
  samplingProblems,
  samplingWords,
  specWords,
  STAGE_RECORDS,
  type CheckDraft,
} from './rules'
import { missingStarterPlans, STARTER_PLANS } from './starter'

/** B-W2b-92: inspection plans, by hand (QHS-008 templates, QHS-009 check types, QHS-016 versions approved by a second person). */

const paths = (problems: readonly { path: string }[]) => problems.map((problem) => problem.path)
const UUID = '0190f1e2-3a4b-7c5d-8e9f-0a1b2c3d4e5f'
const ce: CheckDraft = { code: 'CE_MARK', labelIt: 'Marcatura CE', labelEn: 'CE marking', type: 'PASS_FAIL', checkClass: 'CRITICAL' }
const chest: CheckDraft = { code: 'CHEST', labelIt: 'Mezzo torace', labelEn: 'Chest half', type: 'MEASUREMENT', checkClass: 'MAJOR', nominal: '58.000', tolerance: '1.000', uom: 'CM' }
const read: CheckDraft = { code: 'READ', labelIt: 'Leggere', labelEn: 'Read', type: 'INSTRUCTION' }

describe('a plan (QHS-008)', () => {
  it('a code of capitals, digits, - and _; a name; chips of known kinds, each once', () => {
    expect(planDraftProblems({ code: 'FIN-JACKET', name: 'Final, jackets', appliesTo: [{ kind: 'CATEGORY', value: 'JACKET' }] }, true)).toEqual([])
    expect(paths(planDraftProblems({ code: 'fin jacket', name: ' ' }, true))).toEqual(['code', 'name'])
    expect(paths(planDraftProblems({ code: 'F', name: 'x'.repeat(121) }, true))).toEqual(['code', 'name'])
    // A change names only what it changes.
    expect(planDraftProblems({ name: 'New name' }, false)).toEqual([])
    expect(paths(chipsProblems([{ kind: 'CATEGORY', value: 'HELMET' }, { kind: 'STYLE', value: 'JKT-01' }, { kind: 'STYLE', value: UUID }, { kind: 'STYLE', value: UUID }]))).toEqual(['appliesTo/0/value', 'appliesTo/1/value', 'appliesTo/3/value'])
    // A category is a kind of garment or a kind of material.
    expect(chipsProblems([{ kind: 'CATEGORY', value: 'LEATHER' }, { kind: 'CATEGORY', value: 'GLOVES' }])).toEqual([])
  })

  it('every stage has words and the record its inspections are (a return has none yet)', () => {
    expect(PLAN_STAGES.map((stage) => STAGE_RECORDS[stage])).toEqual(['IncomingInspection', 'InProcessCheck', 'InProcessCheck', 'InProcessCheck', 'Inspection', null])
  })
})

describe('check types (QHS-009)', () => {
  it('fills the defaults: mandatory unless an instruction, no photo, words trimmed, languages sorted', () => {
    expect(checkContentOf({ ...read, labelIt: ' Leggere ' })).toMatchObject({ labelIt: 'Leggere', mandatory: false, checkClass: null, photoRequired: false, choices: [] })
    expect(checkContentOf({ ...ce, labelI18n: { ur: 'x', ro: 'Marcaj CE' } })).toMatchObject({ mandatory: true, labelI18n: { ro: 'Marcaj CE', ur: 'x' } })
    expect(Object.keys(checkContentOf({ ...ce, labelI18n: { ur: 'x', ro: 'y' } }).labelI18n)).toEqual(['ro', 'ur'])
  })

  it('each type its own shape, every problem at once', () => {
    expect(checksProblems([ce, chest, read])).toEqual([])
    // A measurement against the size chart names none of nominal, tolerance and unit.
    expect(checksProblems([{ ...chest, nominal: null, tolerance: null, uom: null }])).toEqual([])
    expect(paths(checksProblems([{ ...chest, tolerance: null }]))).toEqual(['checks/0/nominal'])
    expect(paths(checksProblems([{ ...chest, nominal: '-1', tolerance: '0.1234' }]))).toEqual(['checks/0/nominal', 'checks/0/tolerance'])
    expect(paths(checksProblems([{ ...ce, nominal: '1', tolerance: '1', uom: 'CM' }]))).toEqual(['checks/0/nominal'])
    expect(paths(checksProblems([{ code: 'SHADE', labelIt: 'Tono', labelEn: 'Shade', type: 'CHOICE', choices: ['A'] }]))).toEqual(['checks/0/choices'])
    expect(paths(checksProblems([{ code: 'SHADE', labelIt: 'Tono', labelEn: 'Shade', type: 'CHOICE', choices: ['A', 'a'] }]))).toEqual(['checks/0/choices'])
    expect(paths(checksProblems([{ ...ce, choices: ['A', 'B'] }]))).toEqual(['checks/0/choices'])
    // An instruction is only read.
    expect(paths(checksProblems([{ ...read, mandatory: true }]))).toEqual(['checks/0/type'])
    expect(paths(checksProblems([{ ...read, checkClass: 'MINOR' }]))).toEqual(['checks/0/type'])
    // Codes once each, words in both languages, other languages by their ISO code.
    expect(paths(checksProblems([ce, { ...ce, labelEn: '' }]))).toEqual(['checks/1/code', 'checks/1/labelEn'])
    expect(paths(checksProblems([{ ...ce, code: 'ce mark', labelI18n: { english: 'x', ro: ' ' } }]))).toEqual(['checks/0/code', 'checks/0/labelI18n/english', 'checks/0/labelI18n/ro'])
  })
})

describe('sampling', () => {
  it('an AQL profile or a fixed number; a frequency with its number', () => {
    expect(samplingProblems({ samplingMethod: 'AQL_PROFILE' })).toEqual([])
    expect(samplingProblems({ samplingMethod: 'FIXED', fixedSampleSize: 5, frequency: 'EVERY_NTH_BUNDLE', frequencyValue: 10 })).toEqual([])
    expect(paths(samplingProblems({ samplingMethod: 'FIXED', aqlProfileId: UUID }))).toEqual(['sampling/fixedSampleSize', 'sampling/aqlProfileId'])
    expect(paths(samplingProblems({ samplingMethod: 'AQL_PROFILE', fixedSampleSize: 3, frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 101 }))).toEqual(['sampling/fixedSampleSize', 'sampling/frequencyValue'])
    expect(paths(samplingProblems({ samplingMethod: 'AQL_PROFILE', frequency: 'EVERY_LOT', frequencyValue: 2 }))).toEqual(['sampling/frequencyValue'])
    expect(paths(samplingProblems({ samplingMethod: 'AQL_PROFILE', frequencyValue: 2 }))).toEqual(['sampling/frequencyValue'])
  })

  it('in words, Italian and English', () => {
    expect(samplingWords({ samplingMethod: 'FIXED', fixedSampleSize: 5, frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: 10, stopAtReject: true }, 'it', null)).toEqual({ sample: 'Campione fisso: 5 pezzi', frequency: '10% delle operazioni', stop: 'Ci si ferma al numero di rifiuto' })
    expect(samplingWords({ samplingMethod: 'AQL_PROFILE' }, 'en', null)).toEqual({ sample: 'The AQL profile that applies (style, customer, company default)', frequency: null, stop: "As the company's quality setting says" })
    expect(samplingWords({ samplingMethod: 'AQL_PROFILE', aqlProfileId: UUID, stopAtReject: false }, 'en', { code: 'AQL-EXM', name: 'Brand P1' }).sample).toBe('AQL profile AQL-EXM (Brand P1)')
    expect(specWords(checkContentOf(chest), 'en')).toBe('58.000 ± 1.000 cm')
    expect(specWords(checkContentOf({ ...chest, nominal: null, tolerance: null, uom: null }), 'it')).toBe('Dalla tabella taglie del modello')
    expect(specWords(checkContentOf(ce), 'en')).toBeNull()
  })
})

describe('approval by a second person (QHS-016)', () => {
  const facts = { number: 4, status: 'DRAFT' as const, authorId: 'anna', editorIds: ['anna', 'bruno'], approverId: 'carla' }

  it('never the author, never someone who changed the draft, only a draft', () => {
    expect(approverRefusal(facts)).toBeNull()
    expect(approverRefusal({ ...facts, approverId: 'anna' })).toEqual({ code: 'AUTHOR', message: 'You wrote version 4: a second person approves it (QHS-016).' })
    expect(approverRefusal({ ...facts, approverId: 'bruno' })?.code).toBe('EDITOR')
    expect(approverRefusal({ ...facts, status: 'APPROVED' })).toEqual({ code: 'NOT_DRAFT', message: 'Version 4 is approved: only a draft is approved.' })
  })

  it('something to check: an instruction alone is nothing', () => {
    expect(contentProblems({ number: 4, checks: [read], sampling: { samplingMethod: 'AQL_PROFILE' } }).map((problem) => problem.message)).toEqual(['Version 4 has nothing to check: add at least one check that takes a result (an instruction takes none).'])
    expect(contentProblems({ number: 4, checks: [read, ce], sampling: { samplingMethod: 'AQL_PROFILE' } })).toEqual([])
    expect(paths(contentProblems({ number: 4, checks: [ce], sampling: { samplingMethod: 'FIXED' } }))).toEqual(['sampling/fixedSampleSize'])
  })

  it('signs the whole content: another check, another signature; the same content, the same one', () => {
    const statement = { planId: UUID, planCode: 'FIN-JACKET', stage: 'FINAL' as const, versionId: UUID, number: 4, approvedById: 'carla', approvedAt: '2026-11-03T10:00:00.000Z', sampling: { samplingMethod: 'AQL_PROFILE' as const }, checks: [checkContentOf(ce)] }
    expect(approvalSha256(statement)).toMatch(/^[0-9a-f]{64}$/)
    expect(approvalSha256({ ...statement })).toBe(approvalSha256(statement))
    expect(approvalSha256({ ...statement, checks: [checkContentOf({ ...ce, checkClass: 'MAJOR' })] })).not.toBe(approvalSha256(statement))
    expect(approvalText(statement)).toContain('"signs":"inspection plan version approval"')
  })
})

describe('comparing two versions (ChangeReview)', () => {
  it('by code: added, removed, changed field by field, moved, sampling', () => {
    const v3 = { number: 3, sampling: { samplingMethod: 'AQL_PROFILE' as const }, checks: [ce, chest, read].map(checkContentOf) }
    const v4 = { number: 4, sampling: { samplingMethod: 'FIXED' as const, fixedSampleSize: 5 }, checks: [{ ...chest, tolerance: '0.500' }, ce, { code: 'ZIPS', labelIt: 'Cerniere', labelEn: 'Zips', type: 'PASS_FAIL' as const, checkClass: 'MAJOR' as const }].map(checkContentOf) }
    const comparison = compareVersions(v3, v4)
    expect(comparison.added.map((check) => check.code)).toEqual(['ZIPS'])
    expect(comparison.removed.map((check) => check.code)).toEqual(['READ'])
    expect(comparison.changed).toEqual([{ code: 'CHEST', changes: [{ field: 'tolerance', before: '1.000', after: '0.500' }] }])
    expect(comparison.moved).toEqual(['CHEST', 'CE_MARK'])
    expect(comparison.sampling).toEqual([{ field: 'samplingMethod', before: 'AQL_PROFILE', after: 'FIXED' }, { field: 'fixedSampleSize', before: null, after: 5 }])
    expect(comparison.same).toBe(false)
    expect(compareVersions(v3, v3).same).toBe(true)
    // The first version: everything is added.
    expect(compareVersions(null, v3)).toMatchObject({ fromNumber: null, added: [{ code: 'CE_MARK' }, { code: 'CHEST' }, { code: 'READ' }], same: false })
  })
})

describe('where a plan applies', () => {
  const chips = [{ kind: 'CATEGORY' as const, value: 'JACKET' }, { kind: 'CUSTOMER' as const, value: 'p1' }, { kind: 'CUSTOMER' as const, value: 'p2' }]
  it('one chip of each kind named, every kind; no chip is everything', () => {
    expect(chipsMatch(chips, { CATEGORY: ['JACKET'], CUSTOMER: ['p2'] })).toEqual({ matches: true, because: [chips[0], chips[2]] })
    expect(chipsMatch(chips, { CATEGORY: ['TROUSERS'], CUSTOMER: ['p2'] }).matches).toBe(false)
    expect(chipsMatch([], { CATEGORY: ['TROUSERS'] })).toEqual({ matches: true, because: [] })
    // A kind the facts do not say: a rule does not apply (fail), a preview counts it in (pass).
    expect(chipsMatch(chips, { CATEGORY: ['JACKET'] }).matches).toBe(false)
    expect(chipsMatch(chips, { CATEGORY: ['JACKET'] }, 'pass').matches).toBe(true)
  })
})

describe('the leather-apparel starter set', () => {
  it('one plan per stage, each one approvable as it is', () => {
    expect(STARTER_PLANS.map((plan) => plan.stage)).toEqual([...PLAN_STAGES])
    for (const plan of STARTER_PLANS) expect(contentProblems({ number: 1, checks: plan.checks, sampling: plan.sampling }), plan.code).toEqual([])
    expect(missingStarterPlans(new Set(['FIN-JACKET', 'INC-LEATHER'])).map((plan) => plan.code)).toEqual(['CUT-PANELS', 'INL-FIRST', 'EOL-GARMENT', 'RET-GARMENT'])
  })

  it("the final plan carries W1's fixed checklist with the same codes, in its order (plans replace it)", () => {
    const final = STARTER_PLANS.find((plan) => plan.stage === 'FINAL')!
    expect(final.checks.slice(0, CHECKLIST_ITEMS.length).map((check) => check.code)).toEqual(CHECKLIST_ITEMS.map((item) => item.code))
    expect(final.checks.slice(0, CHECKLIST_ITEMS.length).map((check) => check.labelEn)).toEqual(CHECKLIST_ITEMS.map((item) => item.words))
  })
})

describe('the printable checklist', () => {
  const input = {
    plan: { code: 'FIN-JACKET', name: 'Final, jackets', stage: 'FINAL' as const },
    version: { number: 3, status: 'APPROVED' as const, approvedByName: 'Carla', approvedAt: '2026-11-03T10:00:00.000Z', changeNote: null },
    sampling: { samplingMethod: 'FIXED' as const, fixedSampleSize: 13 },
    profile: null,
    checks: [ce, chest, read, { code: 'SHADE', labelIt: 'Tono', labelEn: 'Shade', labelI18n: { ro: 'Nuanță' }, type: 'CHOICE' as const, choices: ['A', 'B'] }].map(checkContentOf),
  }

  it('in Italian: lines, rows in order, answers to tick, at most 10 sample columns', () => {
    const page = printableChecklist(input, 'it')
    expect(page.title).toBe('FIN-JACKET · Final, jackets')
    expect(page.notInForce).toBeNull()
    expect(page.lines.map((line) => line.label)).toEqual(['Fase', 'Versione', 'Approvata da', 'Campione', 'Al numero di rifiuto', 'Lotto / ordine', 'Quantità del lotto · campione'])
    expect(page.lines[2]!.value).toBe('Carla · 2026-11-03')
    expect(page.rows.map((row) => [row.n, row.label, row.critical, row.mandatory])).toEqual([[1, 'Marcatura CE', true, true], [2, 'Mezzo torace', false, true], [3, 'Leggere', false, false], [4, 'Tono', false, true]])
    expect(page.rows[0]!.answer).toBe('☐ Conforme   ☐ Non conforme   ☐ Non applicabile')
    expect(page.rows[1]!.spec).toBe('58.000 ± 1.000 cm')
    expect(page.rows[3]!.choices).toEqual(['☐ A', '☐ B'])
    expect(page.sampleColumns).toBe(10)
  })

  it('in a floor language: its words where a check has them, English flagged where not; a draft is said not in force', () => {
    const page = printableChecklist({ ...input, version: { ...input.version, status: 'DRAFT', approvedByName: null, approvedAt: null } }, 'ro')
    expect(page.rows.map((row) => [row.label, row.missing])).toEqual([['CE marking', true], ['Chest half', true], ['Read', true], ['Nuanță', false]])
    expect(page.notInForce).toBe('Draft version: not the one in force. Do not use it for an inspection.')
    expect(page.lines.map((line) => line.label)).not.toContain('Approved by')
  })
})
