import type { HideRow } from '../../../../_shared/stock/api'
import { at, PEOPLE, uid } from '../../../../_shared/stock/fixtures'
import { part } from '../../../lots/shared/model'
import type { GradeChoice, GradingView, MeasuresView, MeasureView, ShadeChoice } from './api'
import { draftOf, gradingCan, type GradingModel } from './grading-model'

/**
 * Made-up grading of a hide for the design cases of the hide record's Measurements & grade and Defects & photos tabs
 * (B-W2b-131): three grades of an invented nappa (A 88 % by the article's rule, B 74 % by the grade's default, C 58 % for
 * two panels), two shade groups and one out of shade, measures against an invented tannery's area (one short beyond the
 * tolerance, one within), changes made in the office and at an incoming inspection. Nothing here is a real company,
 * person or number. Design-only (it exports no design screen).
 */

const grade = (n: number, code: string, share: string, source: 'RULE' | 'GRADE', panels: string[] = [], active = true): GradeChoice => ({
  id: uid('5151', n),
  code,
  labelIt: code === 'A' ? 'Prima scelta' : code === 'B' ? 'Seconda scelta' : code === 'C' ? 'Terza scelta' : `Scelta ${code}`,
  labelEn: code === 'A' ? 'First choice' : code === 'B' ? 'Second choice' : code === 'C' ? 'Third choice' : `Choice ${code}`,
  active,
  share,
  source,
  panels,
})

export const GRADES: GradeChoice[] = [grade(1, 'A', '88.00', 'RULE'), grade(2, 'B', '74.00', 'GRADE'), grade(3, 'C', '58.00', 'RULE', ['Sottocollo', 'Fondo tasca'])]
const shade = (n: number, label: string, outOfShade = false): ShadeChoice => ({ id: uid('5252', n), label, outOfShade, swatchRef: null, lotId: null })
export const SHADES: ShadeChoice[] = [shade(1, 'Tonalità 1'), shade(2, 'Tonalità 2'), shade(3, 'Fuori tono', true)]

const usableOf = (area: number, share: string) => (Math.floor(area * Number(share)) / 100).toFixed(4)

const measure = (n: number, over: Partial<MeasureView> = {}): MeasureView => ({
  id: uid('5353', n),
  measuredAt: at(28, 10, n),
  declaredArea: '52.0000',
  declared: '52.0000',
  declaredFrom: 'TANNERY',
  measuredArea: '51.2000',
  areaUom: 'FT2',
  difference: '-0.8000',
  differencePercent: '-1.54',
  outcome: 'WITHIN',
  incomingInspectionId: null,
  by: { audience: 'OFFICE', id: uid('9191', 1), name: PEOPLE.anna, hidden: false },
  note: null,
  latest: false,
  ...over,
})

export const MEASURES: MeasureView[] = [
  measure(2, { measuredAt: at(29, 8, 30), measuredArea: '48.0000', difference: '-4.0000', differencePercent: '-7.69', outcome: 'SHORT', latest: true, note: 'Rimisurata col pantografo' }),
  measure(1, { by: { audience: 'FLOOR', id: null, name: null, hidden: true }, incomingInspectionId: uid('5454', 1) }),
]

/** The grading of a hide as the API answers it (made-up): grade B by record unless told otherwise, the estimates of its left. */
export function gradingOf(row: HideRow, over: Partial<GradingView> = {}): GradingView {
  const left = Number(row.left)
  const measured = Number(row.baseArea)
  const gradeB = GRADES[1]!
  const readOnly = row.state === 'CONSUMED' ? `Hide ${row.code} is used up.` : row.state === 'SCRAPPED' ? `Hide ${row.code} was scrapped.` : null
  return {
    hide: {
      id: row.id,
      code: row.code,
      state: row.state,
      version: 4,
      siteId: row.siteId,
      companyId: row.companyId,
      item: { id: row.item.id, code: row.item.code, name: row.item.name, baseUom: row.item.baseUom },
      colour: row.colour ? { id: row.colour.id, code: row.colour.code, name: row.colour.name } : null,
      lot: { id: row.lot.id, code: row.lot.code, dyeBatch: row.lot.dyeBatch },
      area: { uom: 'FT2', quantity: row.area, other: { uom: 'M2', quantity: (Number(row.area) * 0.092903).toFixed(4) } },
      baseArea: row.baseArea,
      onHand: row.onHand,
      supplierCode: row.supplierCode,
      thicknessMm: row.thicknessMm,
      defects: row.defects,
    },
    grade: { id: gradeB.id, code: gradeB.code, labelIt: gradeB.labelIt, labelEn: gradeB.labelEn, active: true, byText: false },
    gradeText: 'B',
    shade: SHADES[0]!,
    shadeText: SHADES[0]!.label,
    usable: { share: gradeB.share, source: gradeB.source, panels: [], measured: usableOf(measured, gradeB.share), left: usableOf(left, gradeB.share) },
    estimates: GRADES.map((choice) => ({ gradeId: choice.id, code: choice.code, share: choice.share, source: choice.source, usable: usableOf(left, choice.share), current: choice.code === 'B' })),
    choices: { grades: GRADES, shadeGroups: SHADES },
    lastMeasure: MEASURES[0]!,
    readOnly,
    reasonRequired: row.state === 'PARTLY_CUT' || row.state === 'REMNANT',
    canEdit: readOnly === null,
    changes: [
      { at: at(29, 9, 2), actorId: uid('9191', 1), audience: 'office', from: { grade: 'A', shade: null }, to: { grade: 'B', shade: 'Tonalità 1' }, reason: 'Vene sul fianco viste alla luce' },
      { at: at(28, 11, 45), actorId: uid('9191', 2), audience: 'office', from: { thicknessMm: '1.10' }, to: { thicknessMm: '1.20' }, reason: null },
    ],
    ...over,
  }
}

/** The measures of a hide (made-up): the order line's 5 % tolerance; only a whole hide may be measured again. */
export function measuresOf(row: HideRow, over: Partial<MeasuresView> = {}): MeasuresView {
  const view = gradingOf(row)
  const whole = row.state === 'FULL'
  return {
    hide: view.hide,
    tolerancePercent: '5.00',
    toleranceFrom: 'ORDER_LINE',
    measures: MEASURES,
    latest: MEASURES[0]!,
    measureRefusal: whole ? null : `Hide ${row.code} was cut already.`,
    canMeasure: whole,
    canCorrectStock: whole,
    ...over,
  }
}

/** The two tabs' model for a role (its permissions), a hide, and what differs in a case. */
export function gradingModel(permissions: readonly string[], row: HideRow, over: Partial<GradingModel> = {}, view: GradingView = gradingOf(row)): GradingModel {
  return {
    can: gradingCan(permissions),
    view: part(view),
    measures: part(measuresOf(row)),
    gradeDraft: draftOf(view, 'it'),
    defectsDraft: draftOf(view, 'it'),
    saving: null,
    problem: null,
    saved: null,
    changedMeanwhile: false,
    measure: null,
    ...over,
  }
}
