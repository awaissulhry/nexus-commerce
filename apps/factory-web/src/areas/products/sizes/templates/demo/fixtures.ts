import { at, COMPANY_ID, NOW, ROLE_PERMISSIONS, uid, type RoleCase } from '../../../library/demo'
import type { TemplateOption, TemplateRules, TemplateView } from '../api'
import { templateCan, type TemplateCan } from '../model'

/**
 * Design-only made-up data of the measurement templates (SCR-049-templates, SCR-049-template): an invented factory's garment
 * types with invented points and ranges, one template's rules. No real company, person or measure.
 */

export const canOf = (role: RoleCase): TemplateCan => templateCan(ROLE_PERMISSIONS[role])

const option = (n: number, fields: Partial<TemplateOption> & Pick<TemplateOption, 'code' | 'name' | 'productType'>): TemplateOption => ({ id: uid('4931', n), nameI18n: {}, companyId: null, status: 'ACTIVE', rulesOn: false, points: 0, ...fields })

export const TEMPLATE_ROWS: TemplateOption[] = [
  option(1, { code: 'RACE_SUIT', name: 'Race suit', nameI18n: { it: 'Tuta da gara', en: 'Race suit' }, productType: 'SUIT', points: 23 }),
  option(2, { code: 'JACKET', name: 'Jacket', nameI18n: { it: 'Giacca', en: 'Jacket' }, productType: 'JACKET', points: 9, rulesOn: true }),
  option(3, { code: 'TROUSERS', name: 'Trousers', nameI18n: { it: 'Pantaloni', en: 'Trousers' }, productType: 'TROUSERS', points: 7 }),
  option(4, { code: 'GLOVES', name: 'Gloves', productType: 'GLOVES', points: 4, companyId: COMPANY_ID }),
  option(5, { code: 'OLD_VEST', name: 'Old vest', productType: 'VEST', points: 3, status: 'ARCHIVED' }),
]

export const ROW_FACTS = {
  [TEMPLATE_ROWS[0]!.id]: { required: 20, styles: { measured: 3, madeToMeasure: 2 }, profiles: 14 },
  [TEMPLATE_ROWS[1]!.id]: { required: 9, styles: { measured: 5, madeToMeasure: 1 }, profiles: 6 },
  [TEMPLATE_ROWS[2]!.id]: { required: 6, styles: { measured: 2, madeToMeasure: 0 }, profiles: 0 },
  [TEMPLATE_ROWS[3]!.id]: 'failed' as const,
}

const point = (n: number, code: string, name: string, it: string, min: string | null, max: string | null, fields: Partial<TemplateView['points'][number]> = {}): TemplateView['points'][number] => ({
  id: uid('4932', n),
  code,
  name,
  nameI18n: { it, en: name },
  seq: n,
  uom: 'CM',
  minValue: min,
  maxValue: max,
  required: true,
  howTo: null,
  pointOfMeasureId: null,
  status: 'ACTIVE',
  rules: 0,
  ...fields,
})

export const SUIT: TemplateView = {
  id: TEMPLATE_ROWS[0]!.id,
  companyId: null,
  code: 'RACE_SUIT',
  name: 'Race suit',
  nameI18n: { it: 'Tuta da gara', en: 'Race suit' },
  productType: 'SUIT',
  instructions: null,
  status: 'ACTIVE',
  rulesOn: false,
  rulesSummary: '',
  version: 4,
  updatedAt: at(27, 15),
  points: [
    point(1, 'height', 'Height', 'Altezza', '140', '210', { howTo: 'Standing straight, barefoot, against a wall.' }),
    point(2, 'chest', 'Chest', 'Torace', '70', '150', { howTo: 'Around the fullest part of the chest, arms relaxed.', rules: 2 }),
    point(3, 'waist', 'Waist', 'Vita', '55', '140', { howTo: 'Around the natural waist.', rules: 1 }),
    point(4, 'hips', 'Hips', 'Fianchi', '70', '150'),
    point(5, 'sleeve', 'Sleeve', 'Manica', '50', '80', { howTo: 'Shoulder point to wrist, arm bent at 90°.' }),
    point(6, 'back_length', 'Back length', 'Lunghezza schiena', '35', '60'),
    point(7, 'inseam', 'Inseam', 'Cavallo interno', '60', '100', { rules: 1 }),
    point(8, 'outseam', 'Outseam', 'Esterno gamba', '80', '130', { rules: 1 }),
    point(9, 'knee', 'Knee', 'Ginocchio', '30', '55', { required: false }),
    point(10, 'wrist', 'Wrist', 'Polso', '120', '230', { uom: 'MM', required: false }),
    point(11, 'neck', 'Neck', 'Collo', '30', '50', { status: 'ARCHIVED' }),
  ],
  styles: { measured: 3, madeToMeasure: 2 },
  profiles: 14,
  editable: true,
  refusal: null,
}

const rulePoint = (source: TemplateView['points'][number], limits: { tolerance?: string; minus?: string; plus?: string } = {}): TemplateRules['points'][number] => ({
  id: source.id,
  code: source.code,
  name: source.name,
  nameI18n: source.nameI18n,
  seq: source.seq,
  uom: source.uom,
  required: source.required,
  minValue: source.minValue,
  maxValue: source.maxValue,
  tolerance: limits.tolerance ?? null,
  alterationMinus: limits.minus ?? null,
  alterationPlus: limits.plus ?? null,
  status: source.status,
  pointOfMeasure: null,
})

export const SUIT_RULES: TemplateRules = {
  template: { id: SUIT.id, companyId: null, code: SUIT.code, name: SUIT.name, nameI18n: SUIT.nameI18n, productType: SUIT.productType, status: 'ACTIVE', rulesOn: false, baseSizeRule: { points: ['chest', 'height'], tie: 'LARGER' }, version: SUIT.version, updatedAt: SUIT.updatedAt },
  points: SUIT.points.map((entry) => rulePoint(entry, entry.code === 'chest' ? { tolerance: '1.5', minus: '4', plus: '6' } : entry.code === 'waist' ? { tolerance: '1.5', minus: '4', plus: '8' } : entry.code === 'sleeve' ? { minus: '2', plus: '3' } : {})),
  rules: [
    { id: uid('4933', 1), code: 'INSEAM_LE_OUTSEAM', kind: 'ORDER', pointCode: 'inseam', otherPointCode: 'outseam', minFactor: null, maxFactor: null, minValue: null, maxValue: null, severity: 'BLOCK', messageI18n: { it: 'Il cavallo interno non può superare l’esterno gamba.', en: 'The inseam cannot be longer than the outseam.' }, status: 'ACTIVE' },
    { id: uid('4933', 2), code: 'WAIST_TO_CHEST', kind: 'RATIO', pointCode: 'waist', otherPointCode: 'chest', minFactor: '0.60', maxFactor: '1.20', minValue: null, maxValue: null, severity: 'WARN', messageI18n: { it: 'Vita e torace non tornano: ricontrolla.', en: 'Waist and chest do not match: check them again.' }, status: 'ACTIVE' },
    { id: uid('4933', 3), code: 'CHEST_RANGE', kind: 'RANGE', pointCode: 'chest', otherPointCode: null, minFactor: null, maxFactor: null, minValue: '78', maxValue: '140', severity: 'BLOCK', messageI18n: { it: 'Torace fuori dalla gamma certificata.', en: 'Chest outside the certified range.' }, status: 'ACTIVE' },
    { id: uid('4933', 4), code: 'OLD_KNEE', kind: 'RANGE', pointCode: 'knee', otherPointCode: null, minFactor: null, maxFactor: null, minValue: '30', maxValue: null, severity: 'WARN', messageI18n: { it: 'Ginocchio troppo piccolo.', en: 'Knee too small.' }, status: 'ARCHIVED' },
  ],
  styles: { measured: 3, madeToMeasure: 2 },
  summary: '',
  editable: true,
  refusal: null,
  switchable: true,
}

export { NOW }
