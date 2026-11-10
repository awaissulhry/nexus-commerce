import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { demoStyle, recordModel, REV, REVISIONS, SIZES, STYLE_ID } from '../../demo/fixtures'
import type { StyleRecordViewModel } from '../record-model'
import { StyleRecordView } from '../view/StyleRecordView'
import type { GradePreviewView, MeasurementSpecView, SpecPoint } from './api'
import { NO_SPEC, specMarkKey, type SpecModel } from './spec-model'

/**
 * SCR-344 — the style's Measurement spec (B-W2b-240) with Apply grade rule — made-up data only: an invented touring
 * jacket's garment measures in sizes 46–58, base 52, graded by a made-up rule (chest +2 a size, back length +1, sleeve
 * +0,5), one value typed by hand among graded ones, two still missing. Role cases: the Owner, the production manager
 * (makes and approves the BOM), a viewer (reads the BOM, changes nothing).
 */

const uid = (n: number) => `0190f0e2-6262-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()
const RULE = { id: uid(900), code: 'GR-DEMO-JKT', name: 'Giacche EU (demo)', format: 'RELATIVE', status: 'ACTIVE' }
const BASE = '52'
const SPEC_ID = uid(800)

type Cell = { nominal: string; minus?: string; plus?: string; typed?: boolean } | null
const value = (id: number, cell: Cell, size: string): SpecPoint['cells'][number] => ({
  size,
  value: cell
    ? {
        id: uid(1000 + id),
        nominal: cell.nominal,
        toleranceMinus: cell.minus ?? '1',
        tolerancePlus: cell.plus ?? '1',
        source: cell.typed || size === BASE ? 'TYPED' : 'GRADED',
        words: 'x',
      }
    : null,
})

const graded = (base: number, step: number, options: { typed?: Record<string, string>; missing?: string[]; minus?: string; plus?: string } = {}): Record<string, Cell> =>
  Object.fromEntries(
    SIZES.map((size, index) => {
      if (options.missing?.includes(size)) return [size, null]
      const typed = options.typed?.[size]
      const nominal = typed ?? String(Math.round((base + (index - SIZES.indexOf(BASE)) * step) * 100) / 100)
      return [size, { nominal, typed: typed !== undefined, minus: options.minus, plus: options.plus }]
    }),
  )

interface PointSeed {
  n: number
  code: string
  name: string
  it: string
  howTo: string | null
  picture?: boolean
  cells: Record<string, Cell>
}

const POINTS: PointSeed[] = [
  { n: 1, code: 'DEMO-CHEST_W', name: 'Chest width ½', it: 'Larghezza petto ½', howTo: 'Disteso, chiuso: da cucitura a cucitura 2 cm sotto il giro manica.', picture: true, cells: graded(58, 2) },
  { n: 2, code: 'DEMO-BACK_LEN', name: 'Back length', it: 'Lunghezza dietro', howTo: 'Dal collo al fondo, al centro dietro.', cells: graded(72, 1, { typed: { '56': '74.5' } }) },
  { n: 3, code: 'DEMO-SLEEVE_LEN', name: 'Sleeve length', it: 'Lunghezza manica', howTo: null, cells: graded(64, 0.5, { minus: '1', plus: '1.5', missing: ['46', '48'] }) },
  { n: 4, code: 'DEMO-WAIST_W', name: 'Waist width ½', it: 'Larghezza vita ½', howTo: 'Disteso, alla linea vita.', cells: graded(52, 2) },
]

const missingOf = (points: readonly PointSeed[]) => points.flatMap((point) => {
  const sizes = SIZES.filter((size) => point.cells[size] === null || point.cells[size] === undefined)
  return sizes.length ? [{ pointOfMeasureId: uid(point.n), code: point.code, sizes }] : []
})

export function demoSpec(options: { status?: 'DRAFT' | 'APPROVED' | 'ARCHIVED'; revision?: 'draft' | 'released'; none?: boolean; empty?: boolean; complete?: boolean; rule?: boolean; archived?: boolean } = {}): MeasurementSpecView {
  const revision = options.revision === 'released' ? REVISIONS[1]! : REVISIONS[0]!
  const seeds = options.empty ? [] : options.complete ? POINTS.map((point) => ({ ...point, cells: point.n === 3 ? graded(64, 0.5, { minus: '1', plus: '1.5' }) : point.cells })) : POINTS
  const status = options.status ?? (options.revision === 'released' ? 'APPROVED' : 'DRAFT')
  const editable = !options.none && revision.status === 'DRAFT' && status === 'DRAFT' && !options.rule
  return {
    revision: { id: revision.id, styleId: STYLE_ID, revision: revision.revision, status: revision.status, changeNote: revision.changeNote, plannedHideYieldPct: null, labelTemplateId: revision.labelTemplateId, releasedAt: revision.releasedAt, releasedById: revision.releasedById, version: revision.version, createdAt: revision.createdAt, updatedAt: revision.updatedAt },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: null, status: 'ACTIVE', baseSize: BASE, sizeScaleId: uid(950) },
    sizes: SIZES.map((code) => ({ code, label: code === '52' ? 'L' : code === '50' ? 'M' : null, fitCode: null })),
    spec: options.none
      ? null
      : { id: SPEC_ID, status, baseSize: BASE, gradeRule: RULE, approvedAt: status === 'APPROVED' ? at(12, 14) : null, approvedById: status === 'APPROVED' ? uid(700) : null, version: 6, createdAt: at(10, 9), updatedAt: at(28, 16) },
    points: seeds.map((point, index) => ({
      pointOfMeasureId: uid(point.n),
      code: point.code,
      name: point.name,
      nameI18n: { it: point.it, en: point.name },
      kind: 'GARMENT',
      bodyZone: point.n === 3 ? 'ARMS' : 'UPPER',
      uom: 'CM',
      howTo: point.howTo,
      hasPicture: point.picture ?? false,
      status: 'ACTIVE',
      seq: index + 1,
      cells: SIZES.map((size) => value(point.n * 10 + SIZES.indexOf(size), point.cells[size] ?? null, size)),
    })),
    missing: options.none ? [] : missingOf(seeds),
    archived: options.archived ? [{ id: uid(801), baseSize: '50', createdAt: at(3, 9), approvedAt: null }] : [],
    editable,
    refusal: editable ? null : 'x',
    words: 'x',
  }
}

const RULES: NonNullable<SpecModel['rules']> = [
  { id: RULE.id, code: RULE.code, name: RULE.name, baseSize: '52', format: 'RELATIVE' },
  { id: uid(901), code: 'GR-DEMO-SLIM', name: 'Giacche slim (demo)', baseSize: '50', format: 'ABSOLUTE' },
]
const LIBRARY: NonNullable<SpecModel['library']> = [
  { id: uid(5), code: 'DEMO-HEM_W', name: 'Larghezza fondo ½', uom: 'CM', defaultTolerance: '1' },
  { id: uid(6), code: 'DEMO-COLLAR_H', name: 'Altezza collo', uom: 'MM', defaultTolerance: '3' },
  { id: uid(7), code: 'DEMO-CUFF_W', name: 'Larghezza polso', uom: 'CM', defaultTolerance: null },
]

const PREVIEW: GradePreviewView = {
  rule: { id: RULE.id, code: RULE.code, name: RULE.name, format: 'RELATIVE', baseSize: '52' },
  baseSize: '52',
  keepOverrides: true,
  cells: [
    { pointOfMeasureId: uid(3), code: 'DEMO-SLEEVE_LEN', size: '46', action: 'ADD', before: null, after: { nominal: '62.5', toleranceMinus: '1', tolerancePlus: '1.5' }, words: 'x' },
    { pointOfMeasureId: uid(3), code: 'DEMO-SLEEVE_LEN', size: '48', action: 'ADD', before: null, after: { nominal: '63', toleranceMinus: '1', tolerancePlus: '1.5' }, words: 'x' },
    { pointOfMeasureId: uid(4), code: 'DEMO-WAIST_W', size: '58', action: 'CHANGE', before: { nominal: '57', toleranceMinus: '1', tolerancePlus: '1', source: 'GRADED' }, after: { nominal: '58', toleranceMinus: '1', tolerancePlus: '1' }, words: 'x' },
    { pointOfMeasureId: uid(2), code: 'DEMO-BACK_LEN', size: '56', action: 'KEEP_OVERRIDE', before: { nominal: '74.5', toleranceMinus: '1', tolerancePlus: '1', source: 'TYPED' }, after: { nominal: '74', toleranceMinus: '1', tolerancePlus: '1' }, words: 'x' },
    { pointOfMeasureId: uid(1), code: 'DEMO-CHEST_W', size: '58', action: 'NOT_REACHED', before: { nominal: '64', toleranceMinus: '1', tolerancePlus: '1', source: 'GRADED' }, after: null, words: 'x' },
  ],
  notInRule: [],
  noBase: [],
  counts: { ADD: 2, CHANGE: 1, OVERWRITE: 0, KEEP_OVERRIDE: 1, SAME: 22, NOT_REACHED: 1, OUT_OF_RANGE: 0 },
  words: 'x',
}

const OWNER_CAN = { manage: true, release: true, library: true }
const ready = (view: MeasurementSpecView, extra: Partial<SpecModel> = {}): SpecModel => ({ ...NO_SPEC, can: OWNER_CAN, part: { status: 'ready', value: view }, ...extra })
const sizes = (spec: SpecModel, overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'viewer' = 'owner') => recordModel(role === 'viewer' ? 'sales' : role, { tab: 'sizes', spec, ...(role === 'viewer' ? { can: { ...recordModel('sales').can, bomView: true } } : {}), ...overrides })
const released = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2 }
const PASTE = 'DEMO-CHEST_W\t50\t52\t54\t56\t58\t60\t62\nDEMO-WAIST_W\t44\t46\tabc\nDEMO-HEM_W\t40'

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-344',
  title: 'Style studio: Measurement spec and Apply grade rule',
  view: StyleRecordView,
  cases: [
    { id: 'graded', label: 'A graded spec (draft revision 3)', model: sizes(ready(demoSpec())), note: 'Base 52 marked; back length 56 typed by hand among graded values (a dot); sleeve 46 and 48 "missing"; the picture of chest width in its card.' },
    {
      id: 'saving',
      label: 'Cells saving, waiting and refused',
      model: sizes(ready(demoSpec(), { marks: { [specMarkKey(uid(1), '54')]: { state: 'saving', value: '62.5' }, [specMarkKey(uid(4), '46')]: { state: 'refused', problem: 'spec.problem.nominal' } } })),
      note: 'Chest 54 saving (↻); waist 46 refused with "!" (a value is above 0).',
    },
    { id: 'offline', label: 'Offline: a value waits', model: sizes(ready(demoSpec(), { offline: true, marks: { [specMarkKey(uid(2), '58')]: { state: 'waiting', value: '75' } } })) },
    { id: 'selected', label: 'Two points selected: Take out 2', model: sizes(ready(demoSpec(), { selected: [uid(3), uid(4)] })) },
    { id: 'none', label: 'No spec yet', model: sizes(ready(demoSpec({ none: true }))), note: '"No points of measure yet" with Start the spec.' },
    { id: 'start', label: 'Start the spec', model: sizes(ready(demoSpec({ none: true, archived: true }), { dialog: { kind: 'start' }, rules: RULES })), note: 'Base size 52 (the style\'s), a rule of the scale or none, or a copy of the archived spec of this revision.' },
    { id: 'empty', label: 'Started, no points yet', model: sizes(ready(demoSpec({ empty: true }))) },
    { id: 'add', label: 'Add points', model: sizes(ready(demoSpec(), { dialog: { kind: 'add' }, library: LIBRARY })), note: 'Garment points of the library not in the spec; each ticked one needs its value in size 52.' },
    { id: 'grade', label: 'Apply grade rule: the preview', model: sizes(ready(demoSpec(), { dialog: { kind: 'grade' }, rules: RULES, grade: { ruleId: RULE.id, keepOverrides: true, preview: { status: 'ready', value: PREVIEW } } })), note: '3 values change (2 added, 1 graded again); the typed back length 56 is kept; chest 58 is not reached (left as it is).' },
    { id: 'grade-overwrite', label: 'Apply grade rule: overwrite typed values', model: sizes(ready(demoSpec(), { dialog: { kind: 'grade' }, rules: RULES, grade: { ruleId: RULE.id, keepOverrides: false, preview: { status: 'ready', value: { ...PREVIEW, keepOverrides: false, cells: PREVIEW.cells.map((cell) => (cell.action === 'KEEP_OVERRIDE' ? { ...cell, action: 'OVERWRITE' as const } : cell)) } } } })) },
    { id: 'grade-reading', label: 'Apply grade rule: reading', model: sizes(ready(demoSpec(), { dialog: { kind: 'grade' }, rules: RULES, grade: { ruleId: RULE.id, keepOverrides: true, preview: { status: 'loading' } } })) },
    { id: 'grade-pick', label: 'Apply grade rule: no rule picked', model: sizes(ready(demoSpec(), { dialog: { kind: 'grade' }, rules: RULES, grade: { ruleId: '', keepOverrides: true, preview: { status: 'idle' } } })), note: 'Apply held: "Pick a rule first."' },
    { id: 'paste', label: 'Paste from a sheet', model: sizes(ready(demoSpec(), { dialog: { kind: 'paste' }, paste: PASTE })), note: 'Chest: 7 values; waist: "abc" said; DEMO-HEM_W is not a point of this spec.' },
    { id: 'fill', label: 'Fill a row from the base', model: sizes(ready(demoSpec(), { dialog: { kind: 'fill', pointId: uid(4) } })), note: 'The DS SizeFill: increment, keep typed values, the preview chips.' },
    { id: 'tolerance', label: 'Tolerance of a point', model: sizes(ready(demoSpec(), { dialog: { kind: 'tolerance', pointId: uid(3) } })) },
    { id: 'remove', label: 'Take a point out', model: sizes(ready(demoSpec(), { dialog: { kind: 'remove', ids: [uid(4)] } })) },
    { id: 'settings', label: 'Base size and grade rule', model: sizes(ready(demoSpec(), { dialog: { kind: 'settings' }, rules: RULES })) },
    { id: 'approve-held', label: 'Approve held: values missing', model: sizes(ready(demoSpec(), { dialog: { kind: 'approve' } })), note: 'Approve says "2 values are still missing."' },
    { id: 'approve', label: 'Approve a complete spec', model: sizes(ready(demoSpec({ complete: true }), { dialog: { kind: 'approve' } })) },
    { id: 'approved', label: 'Approved (read only, Reopen)', model: sizes(ready(demoSpec({ complete: true, status: 'APPROVED' }))), note: 'Cells drawn as text; the Banner says to reopen it.' },
    { id: 'reopen', label: 'Reopen (with the reason)', model: sizes(ready(demoSpec({ complete: true, status: 'APPROVED' }), { dialog: { kind: 'reopen' } })) },
    { id: 'archive', label: 'Archive the spec', model: sizes(ready(demoSpec(), { dialog: { kind: 'archive' } })) },
    { id: 'released', label: 'Released revision 2 (frozen)', model: sizes(ready(demoSpec({ revision: 'released', complete: true })), released), note: '"Revision 2 is released and frozen" with Go to revision 3 (draft); cells as text.' },
    { id: 'rule', label: "The style's edit rule holds it", model: sizes(ready(demoSpec({ rule: true }))), note: 'The Banner names Product settings.' },
    { id: 'production', label: 'Production manager', model: sizes(ready(demoSpec()), {}, 'production') },
    { id: 'viewer', label: 'A reader (no BOM changes)', model: sizes(ready(demoSpec(), { can: { manage: false, release: false, library: true } }), {}, 'viewer'), note: 'Cells as text; every action held with its reason.' },
    { id: 'refused', label: 'A refused write', model: sizes(ready(demoSpec(), { dialog: { kind: 'add' }, library: LIBRARY, refused: { key: 'problem.write.invalid', messages: ['Point DEMO-COLLAR_H is archived.'] } })) },
    { id: 'loading', label: 'Loading', model: sizes({ ...NO_SPEC, can: OWNER_CAN, part: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: sizes({ ...NO_SPEC, can: OWNER_CAN, part: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
