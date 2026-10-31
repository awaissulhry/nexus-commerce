import { OUTCOME_RULES, outcomeOptions, stockActionWords } from '@nexus/factory-domain/quality/defects/rules'
import { at, uid } from '../../_shared/fixtures'
import type { DefectCategory, DefectCode, Disposition, Dispositions, Library } from '../api'

/**
 * Made-up data for the SCR-079 design cases (DEMO-… codes; words invented for the review). Nothing here is a real
 * company's library or a real decision.
 */

let n = 0
const code = (over: Partial<DefectCode> & Pick<DefectCode, 'code' | 'labelIt' | 'labelEn'>): DefectCode => {
  n += 1
  return {
    id: uid('7901', n),
    parentId: null,
    labelI18n: {},
    icon: null,
    colour: null,
    pictureFileId: null,
    severity: null,
    zone: null,
    stages: [],
    needsDetail: false,
    sortOrder: n * 10,
    active: true,
    usedCount: 0,
    version: 1,
    createdAt: at(2),
    updatedAt: at(20),
    ...over,
  }
}

const category = (over: Partial<DefectCode> & Pick<DefectCode, 'code' | 'labelIt' | 'labelEn'>, defects: (parentId: string) => DefectCode[]): DefectCategory => {
  const head = code(over)
  return { ...head, defects: defects(head.id) }
}

export const PICTURE_ID = uid('7911', 1)
/** A made-up picture for the design cases (an inline SVG: no file is read). */
export const PICTURE_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="#8a6a4a"/><path d="M10 50 Q 40 30 80 52 T 150 48" stroke="#f2e6d8" stroke-width="3" fill="none" stroke-dasharray="6 5"/><circle cx="96" cy="52" r="14" fill="none" stroke="#ffd166" stroke-width="3"/></svg>')

export const SEAMS = category({ code: 'DEMO-SEAM', labelIt: 'Cuciture (demo)', labelEn: 'Seams (demo)', icon: 'shirt', colour: '#1f6fde', usedCount: 3, stages: ['IN_LINE', 'FINAL'] }, (parentId) => [
  code({ parentId, code: 'DEMO-SEAM-OPEN', labelIt: 'Cucitura aperta', labelEn: 'Open seam', severity: 'MAJOR', zone: 'SLEEVE_L', stages: ['IN_LINE', 'FINAL'], usedCount: 214, icon: 'flag', pictureFileId: PICTURE_ID }),
  code({ parentId, code: 'DEMO-STITCH-SKIP', labelIt: 'Punto saltato', labelEn: 'Skipped stitch', severity: 'MINOR', zone: 'CHEST', stages: ['IN_LINE'], usedCount: 37 }),
  code({ parentId, code: 'DEMO-PUCKER', labelIt: 'Arricciatura', labelEn: 'Puckering', severity: 'MINOR', zone: 'ZIP', usedCount: 0 }),
])

export const LEATHER = category({ code: 'DEMO-LEATHER', labelIt: 'Pelle (demo)', labelEn: 'Leather (demo)', icon: 'leaf', colour: '#8d6e63', usedCount: 2 }, (parentId) => [
  code({ parentId, code: 'DEMO-SCAR', labelIt: 'Cicatrice sulla pelle', labelEn: 'Scar on the hide', severity: 'MAJOR', zone: 'BACK', stages: ['INCOMING', 'CUTTING'], usedCount: 12, labelI18n: { ro: 'Cicatrice pe piele' } }),
  code({ parentId, code: 'DEMO-SHADE', labelIt: 'Differenza di tonalità', labelEn: 'Shade difference', severity: 'MINOR', stages: ['CUTTING', 'FINAL'], usedCount: 4, active: false }),
])

export const SAFETY = category({ code: 'DEMO-SAFETY', labelIt: 'Sicurezza (demo)', labelEn: 'Safety (demo)', icon: 'shield', colour: '#e5484d' }, (parentId) => [
  code({ parentId, code: 'DEMO-ARMOUR-MISSING', labelIt: 'Tasca protezione mancante', labelEn: 'Missing armour pocket', severity: 'CRITICAL', zone: 'ELBOW_R', stages: ['FINAL'], needsDetail: false }),
  code({ parentId, code: 'DEMO-LABEL-WRONG', labelIt: 'Etichetta sbagliata o mancante', labelEn: 'Wrong or missing label', severity: 'CRITICAL', zone: 'LABEL', stages: ['FINAL', 'PACKING'], usedCount: 1 }),
  code({ parentId, code: 'DEMO-OTHER', labelIt: 'Altro (descrivi)', labelEn: 'Other (describe)', severity: 'MINOR', needsDetail: true }),
])

export const EMPTY_CATEGORY = category({ code: 'DEMO-FINISH', labelIt: 'Finitura (demo)', labelEn: 'Finishing (demo)' }, () => [])

export const LIBRARY: Library = {
  categories: [SEAMS, LEATHER, SAFETY, EMPTY_CATEGORY],
  zones: [],
  stages: ['INCOMING', 'STOCK', 'CUTTING', 'IN_LINE', 'FINAL', 'PACKING', 'CUSTOMER', 'AUDIT'],
  starterMissing: [],
  canManage: true,
}

export const LIBRARY_STARTER: Library = { ...LIBRARY, starterMissing: ['GRAIN-CRACK', 'LOOSE-GRAIN', 'RUB-OFF', 'ZIP-MISALIGNED', 'STAIN', 'NEEDLE-HOLES'] }
export const LIBRARY_EMPTY: Library = { ...LIBRARY, categories: [], starterMissing: Array.from({ length: 19 }, (_, index) => `DEMO-${index}`) }

let d = 0
const disposition = (outcome: Disposition['outcome'], over: Partial<Disposition> & Pick<Disposition, 'code' | 'labelIt' | 'labelEn'>): Disposition => {
  d += 1
  const rule = OUTCOME_RULES[outcome]
  const base = { outcome, stockMoveReason: rule.moves[0] ?? null, followUp: rule.followUps[0] ?? null, reinspection: rule.reinspection }
  const merged = { ...base, ...over }
  return {
    id: uid('7921', d),
    labelI18n: {},
    icon: null,
    colour: null,
    approvalSeverity: null,
    approvalAmount: null,
    sortOrder: d * 10,
    active: true,
    usedCount: 0,
    version: 1,
    createdAt: at(2),
    updatedAt: at(20),
    ...merged,
    stockAction: stockActionWords(merged),
  }
}

export const DISPOSITION_ROWS: Disposition[] = [
  disposition('USE_AS_IS', { code: 'DEMO_USE_AS_IS', labelIt: 'Usa così com\'è', labelEn: 'Use as is', usedCount: 18, icon: 'award' }),
  disposition('REWORK', { code: 'DEMO_REWORK', labelIt: 'Rilavora', labelEn: 'Rework', usedCount: 41, approvalSeverity: 'CRITICAL', icon: 'zap' }),
  disposition('REPAIR', { code: 'DEMO_REPAIR', labelIt: 'Ripara', labelEn: 'Repair', usedCount: 3 }),
  disposition('REGRADE', { code: 'DEMO_REGRADE', labelIt: 'Declassa a seconda scelta', labelEn: 'Regrade to second quality', approvalSeverity: 'MAJOR' }),
  disposition('RETURN_TO_SUPPLIER', { code: 'DEMO_RETURN', labelIt: 'Rendi al fornitore', labelEn: 'Return to the supplier', usedCount: 6, approvalAmount: 50_000 }),
  disposition('QUARANTINE', { code: 'DEMO_QUARANTINE', labelIt: 'Quarantena', labelEn: 'Quarantine', active: false }),
  disposition('SCRAP', { code: 'DEMO_SCRAP', labelIt: 'Scarta', labelEn: 'Scrap', usedCount: 9, approvalSeverity: 'MAJOR', approvalAmount: 120_050, icon: 'flame' }),
]

export const DISPOSITIONS: Dispositions = {
  dispositions: DISPOSITION_ROWS,
  outcomes: outcomeOptions(),
  standardMissing: [],
  canManage: true,
}

/** Without the cost grain the API leaves the amount out. */
export const DISPOSITIONS_NO_COST: Dispositions = {
  ...DISPOSITIONS,
  dispositions: DISPOSITION_ROWS.map(({ approvalAmount: _hidden, ...rest }) => rest),
}

export const DISPOSITIONS_EMPTY: Dispositions = { ...DISPOSITIONS, dispositions: [], standardMissing: ['USE_AS_IS', 'REWORK', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE', 'SCRAP'] }
export const DISPOSITIONS_STANDARD: Dispositions = { ...DISPOSITIONS, standardMissing: ['REPAIR', 'REGRADE'] }
