import { PROCESS_WORDS, type CauseProcess } from '@nexus/factory-domain/quality/defects/causes'
import { SAFETY_LAW, SAFETY_RULE, SEVERITY_CLASSES } from '@nexus/factory-domain/quality/defects/severity'
import type { Cause, Causes, Coverage, Grade, Grades, Severity } from '../api'

// Local made-up ids and times (the design-only `_shared/fixtures` may be imported by fixtures and tests alone).
const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

/**
 * B-W2b-118: made-up data for the SCR-079 cases of the W2b tabs (DEMO-… codes; words invented for the review). The severity
 * classes are factory-domain's own words.
 */

export const SEVERITY: Severity = {
  classes: SEVERITY_CLASSES.map((entry, index) => ({ class: entry.class, rank: entry.rank, words: entry.words, meaning: entry.meaning, acceptanceNumber: entry.acceptanceNumber, locked: entry.locked, law: entry.law, defects: [4, 11, 6][index] ?? 0 })),
  safetyRule: { it: SAFETY_RULE.it, en: SAFETY_RULE.en, law: SAFETY_LAW },
  editable: false,
}

let n = 0
const cause = (code: string, process: CauseProcess, labelIt: string, labelEn: string, over: Partial<Cause> = {}): Cause => {
  n += 1
  return { id: uid('7902', n), code, labelIt, labelEn, labelI18n: {}, process, processWords: PROCESS_WORDS[process], sortOrder: n * 10, active: true, usedCount: 0, missingLanguages: [], version: 1, createdAt: at(3), updatedAt: at(20), ...over }
}

const CAUSE_ROWS: Cause[] = [
  cause('DEMO-MAT', 'MATERIAL', 'Difetto del materiale (demo)', 'Material fault (demo)', { usedCount: 12, labelI18n: { ro: 'Defect de material (demo)' } }),
  cause('DEMO-SUP', 'SUPPLIER', 'Fornitore fuori specifica (demo)', 'Supplier out of specification (demo)', { usedCount: 3, missingLanguages: ['ro'] }),
  cause('DEMO-CUT', 'CUTTING', 'Errore di taglio (demo)', 'Cutting error (demo)', { usedCount: 7, labelI18n: { ro: 'Eroare de croire (demo)' } }),
  cause('DEMO-SEW', 'SEWING', 'Errore di cucitura (demo)', 'Sewing error (demo)', { usedCount: 21, labelI18n: { ro: 'Eroare de coasere (demo)' } }),
  cause('DEMO-FIN', 'FINISHING', 'Errore di finitura (demo)', 'Finishing error (demo)', { missingLanguages: ['ro'] }),
  cause('DEMO-OLD', 'HANDLING', 'Danno vecchio (demo)', 'Old damage code (demo)', { active: false, usedCount: 2, missingLanguages: ['ro'] }),
]

export const CAUSES: Causes = {
  causes: CAUSE_ROWS,
  processes: (Object.keys(PROCESS_WORDS) as CauseProcess[]).map((process) => ({ process, ...PROCESS_WORDS[process] })),
  languages: ['ro'],
  starterMissing: ['DESIGN', 'MEASURE'],
  canManage: true,
}
export const CAUSES_EMPTY: Causes = { ...CAUSES, causes: [], languages: [], starterMissing: ['MAT-FAULT', 'SUP-SPEC', 'CUT-ERROR', 'SEW-ERROR', 'FIN-ERROR', 'HANDLING', 'DESIGN', 'MEASURE'] }
export const CAUSES_FULL: Causes = { ...CAUSES, starterMissing: [] }

let g = 0
const grade = (code: string, labelIt: string, labelEn: string, usableShare: string, over: Partial<Grade> = {}): Grade => {
  g += 1
  return { id: uid('7903', g), code, labelIt, labelEn, labelI18n: {}, usableShare, sortOrder: g * 10, active: true, usedCount: 0, missingLanguages: [], version: 1, createdAt: at(3), updatedAt: at(20), ...over }
}

export const GRADES: Grades = {
  grades: [
    grade('A', 'Prima scelta (demo)', 'First choice (demo)', '85.00', { usedCount: 14, labelI18n: { ro: 'Prima calitate (demo)' } }),
    grade('B', 'Seconda scelta (demo)', 'Second choice (demo)', '72.00', { usedCount: 22, missingLanguages: ['ro'] }),
    grade('C', 'Terza scelta (demo)', 'Third choice (demo)', '60.00', { usedCount: 5, labelI18n: { ro: 'A treia calitate (demo)' } }),
    grade('D', 'Quarta scelta (demo)', 'Fourth choice (demo)', '45.00', { active: false, usedCount: 1, missingLanguages: ['ro'] }),
  ],
  hideCategory: { id: uid('7904', 1), code: 'LEATHER', labelIt: 'Pelle (demo)', labelEn: 'Leather (demo)', icon: 'leaf', colour: '#8d6e63', active: true },
  hideDefects: [
    { id: uid('7905', 1), code: 'DEMO-SCAR', labelIt: 'Cicatrice (demo)', labelEn: 'Scar (demo)', labelI18n: {}, icon: 'scissors', colour: '#8d6e63', pictureFileId: null, severity: 'MAJOR', stages: ['INCOMING', 'CUTTING'], active: true, missingLanguages: ['ro'], version: 1 },
    { id: uid('7905', 2), code: 'DEMO-SHADE', labelIt: 'Differenza di tono (demo)', labelEn: 'Shade difference (demo)', labelI18n: {}, icon: 'palette', colour: '#8d6e63', pictureFileId: null, severity: 'MINOR', stages: [], active: true, missingLanguages: ['ro'], version: 1 },
    { id: uid('7905', 3), code: 'DEMO-CRACK', labelIt: 'Grana screpolata (demo)', labelEn: 'Grain crack (demo)', labelI18n: {}, icon: 'leaf', colour: '#8d6e63', pictureFileId: null, severity: 'CRITICAL', stages: ['INCOMING'], active: true, missingLanguages: [], version: 1 },
  ],
  hideStages: ['INCOMING', 'CUTTING'],
  languages: ['ro'],
  starterMissing: [],
  canManage: true,
}
export const GRADES_EMPTY: Grades = { ...GRADES, grades: [], hideCategory: null, hideDefects: [], starterMissing: ['A', 'B', 'C', 'D'] }

export const COVERAGE: Coverage = { languages: [{ language: 'ro', sites: 1, missing: { DEFECTS: ['DEMO-SCAR', 'DEMO-SHADE'], CAUSES: ['DEMO-SUP', 'DEMO-FIN'], GRADES: ['B'] }, complete: false }] }
