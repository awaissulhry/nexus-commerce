import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, COMPANY_ID, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../library/demo'
import type { PomRow, PomView, RuleRow, RuleView } from './api'
import { depthCan, markKey, NO_DEPTH_FILTERS, stepRowsOf } from './model'
import type { PomsViewModel } from './view/PomsView'
import type { RulesViewModel } from './view/RulesView'
import { SizesDepthView, type SizesDepthViewModel } from './view/SizesDepthView'

/**
 * SCR-345 — Sizes & measurements › Points of measure and Grade rules (B-W2b-240) — made-up data only: an invented
 * factory's garment and body points (DEMO- codes) and two grade rules of its made-up scales, one of size and fit. Role
 * cases: the Owner, a product developer (keeps the libraries), quality (reads).
 */

const canOf = (role: RoleCase) => depthCan(ROLE_PERMISSIONS[role])
const pom = (n: number, fields: Partial<PomRow> & Pick<PomRow, 'code' | 'name'>): PomRow => ({
  id: uid('5240', n),
  companyId: null,
  nameI18n: null,
  description: null,
  howTo: null,
  howToI18n: null,
  kind: 'GARMENT',
  bodyZone: 'UPPER',
  uom: 'CM',
  defaultTolerance: '1',
  bodyPoint: null,
  hasPicture: false,
  status: 'ACTIVE',
  version: 2,
  updatedAt: at(20, 10),
  ...fields,
})

const BODY_CHEST = { id: uid('5240', 20), code: 'DEMO-BODY_CHEST', name: 'Circonferenza petto (corpo)' }
export const POMS: PomRow[] = [
  pom(1, { code: 'DEMO-CHEST_W', name: 'Larghezza petto ½', howTo: 'Disteso, chiuso: da cucitura a cucitura 2 cm sotto il giro manica.', hasPicture: true, bodyPoint: BODY_CHEST }),
  pom(2, { code: 'DEMO-BACK_LEN', name: 'Lunghezza dietro', howTo: 'Dal collo al fondo, al centro dietro.' }),
  pom(3, { code: 'DEMO-SLEEVE_LEN', name: 'Lunghezza manica', bodyZone: 'ARMS', defaultTolerance: '1.5', howTo: 'Dalla spalla al polso, manica distesa.' }),
  pom(4, { code: 'DEMO-WAIST_W', name: 'Larghezza vita ½', howTo: 'Disteso, alla linea vita.' }),
  pom(5, { code: 'DEMO-COLLAR_H', name: 'Altezza collo', uom: 'MM', defaultTolerance: '3' }),
  pom(6, { code: 'DEMO-INSEAM', name: 'Interno gamba', bodyZone: 'LEGS', defaultTolerance: null }),
  pom(20, { code: BODY_CHEST.code, name: BODY_CHEST.name, kind: 'BODY', defaultTolerance: null, howTo: 'Metro sotto le ascelle, ben orizzontale.' }),
  pom(21, { code: 'DEMO-OLD_HIP', name: 'Fianco (vecchio)', bodyZone: 'LEGS', status: 'ARCHIVED' }),
]
const ACTIVE_POMS = POMS.filter((row) => row.status === 'ACTIVE')

const POM_VIEW: PomView = {
  ...POMS[0]!,
  use: { specValues: 21, specs: 3, gradeSteps: 2, gradeRules: 2, templatePoints: 0, garmentPoints: [], words: 'x' },
  picture: { fileId: uid('5241', 1), status: 'AVAILABLE', originalName: 'petto.jpg' },
  createdAt: at(2),
  createdById: uid('4705', 1),
}
const FREE_VIEW: PomView = { ...POMS[5]!, use: { specValues: 0, specs: 0, gradeSteps: 0, gradeRules: 0, templatePoints: 0, garmentPoints: [], words: 'x' }, picture: null, createdAt: at(18), createdById: uid('4705', 1) }

// A made-up picture (a ruler on a plain ground), so the card shows something without a file store.
const PICTURE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e8ecf2"/><rect x="40" y="88" width="240" height="24" fill="#c9a227"/><g stroke="#333">' + Array.from({ length: 13 }, (_, i) => `<line x1="${40 + i * 20}" y1="88" x2="${40 + i * 20}" y2="${i % 2 ? 98 : 104}"/>`).join('') + '</g></svg>')}`

const pomsBase = (role: RoleCase = 'owner'): PomsViewModel => ({
  prefix: PREFIX,
  can: canOf(role),
  filters: NO_DEPTH_FILTERS,
  companies: [
    { id: COMPANY_ID, name: 'Officina Demo S.r.l.' },
    { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Pelletteria Esempio S.p.A.' },
  ],
  companyId: COMPANY_ID,
  locale: 'it',
  rows: { items: ACTIVE_POMS, more: false, count: ACTIVE_POMS.length, problem: null },
  asOf: NOW,
  updates: 0,
  notice: null,
  busy: false,
  marks: {},
  dialog: null,
  edit: null,
  bodyPoints: [BODY_CHEST],
  looks: {},
  offline: false,
})

// ---- grade rules ---------------------------------------------------------------------------------------------------------

const SCALE = { id: uid('4911', 1), code: 'DEMO-EU-UOMO', name: 'Uomo EU 44–64', dimensions: 1 }
const FIT_SCALE = { id: uid('4911', 7), code: 'DEMO-PANT-RL', name: 'Pantaloni regolari e lunghi', dimensions: 2 }
const rule = (n: number, fields: Partial<RuleRow> & Pick<RuleRow, 'code' | 'name'>): RuleRow => ({ id: uid('5242', n), companyId: null, scale: SCALE, baseSize: '52', format: 'RELATIVE', points: 3, steps: 4, specs: 2, status: 'ACTIVE', version: 3, updatedAt: at(22, 11), ...fields })
export const RULES: RuleRow[] = [
  rule(1, { code: 'GR-DEMO-JKT', name: 'Giacche EU (demo)' }),
  rule(2, { code: 'GR-DEMO-SLIM', name: 'Giacche slim (demo)', format: 'ABSOLUTE', baseSize: '50', points: 2, steps: 6, specs: 0 }),
  rule(3, { code: 'GR-DEMO-PANT', name: 'Pantaloni R/L (demo)', scale: FIT_SCALE, baseSize: '50R', points: 2, steps: 3, specs: 1 }),
  rule(4, { code: 'GR-DEMO-OLD', name: 'Vecchia regola', status: 'ARCHIVED', specs: 5 }),
]
const ACTIVE_RULES = RULES.filter((row) => row.status === 'ACTIVE')
const EU_SIZES = ['44', '46', '48', '50', '52', '54', '56', '58', '60', '62', '64'].map((code) => ({ code, label: code === '52' ? 'L' : null, fitCode: null, status: 'ACTIVE' }))
const RULE_VIEW: RuleView = {
  ...RULES[0]!,
  sizes: EU_SIZES,
  byPoint: [
    { pointOfMeasureId: POMS[0]!.id, code: 'DEMO-CHEST_W', name: 'Larghezza petto ½', uom: 'CM', status: 'ACTIVE', standard: '2', steps: [{ id: uid('5243', 1), fromSize: null, toSize: null, increment: '2' }, { id: uid('5243', 2), fromSize: '58', toSize: '60', increment: '2.5' }] },
    { pointOfMeasureId: POMS[1]!.id, code: 'DEMO-BACK_LEN', name: 'Lunghezza dietro', uom: 'CM', status: 'ACTIVE', standard: '1', steps: [{ id: uid('5243', 3), fromSize: null, toSize: null, increment: '1' }] },
    { pointOfMeasureId: POMS[2]!.id, code: 'DEMO-SLEEVE_LEN', name: 'Lunghezza manica', uom: 'CM', status: 'ACTIVE', standard: '0.5', steps: [{ id: uid('5243', 4), fromSize: null, toSize: null, increment: '0.5' }, { id: uid('5243', 5), fromSize: '44', toSize: '46', increment: '-0.5' }] },
  ],
  createdAt: at(4),
  createdById: uid('4705', 1),
}
const PANT_VIEW: RuleView = {
  ...RULES[2]!,
  sizes: ['48R', '50R', '52R', '54R', '48L', '50L', '52L', '54L'].map((code) => ({ code, label: null, fitCode: code.slice(-1), status: 'ACTIVE' })),
  byPoint: [
    { pointOfMeasureId: POMS[3]!.id, code: 'DEMO-WAIST_W', name: 'Larghezza vita ½', uom: 'CM', status: 'ACTIVE', standard: '2', steps: [{ id: uid('5243', 6), fromSize: null, toSize: null, increment: '2' }] },
    { pointOfMeasureId: POMS[5]!.id, code: 'DEMO-INSEAM', name: 'Interno gamba', uom: 'CM', status: 'ACTIVE', standard: '0', steps: [{ id: uid('5243', 7), fromSize: null, toSize: null, increment: '0' }, { id: uid('5243', 8), fromSize: '50R', toSize: '50L', increment: '4' }] },
  ],
  createdAt: at(6),
  createdById: uid('4705', 1),
}
const GARMENT_POINTS = ACTIVE_POMS.filter((row) => row.kind === 'GARMENT').map((row) => ({ id: row.id, code: row.code, name: row.name, uom: row.uom }))

const rulesBase = (role: RoleCase = 'owner'): RulesViewModel => ({
  prefix: PREFIX,
  can: canOf(role),
  filters: NO_DEPTH_FILTERS,
  companies: [{ id: COMPANY_ID, name: 'Officina Demo S.r.l.' }],
  companyId: COMPANY_ID,
  rows: { items: ACTIVE_RULES, more: false, count: ACTIVE_RULES.length, problem: null },
  scales: [
    { id: SCALE.id, code: SCALE.code, name: SCALE.name },
    { id: FIT_SCALE.id, code: FIT_SCALE.code, name: FIT_SCALE.name },
  ],
  asOf: NOW,
  updates: 0,
  notice: null,
  busy: false,
  dialog: null,
  newRule: null,
  open: null,
})
const opened = (view: RuleView, extra: Partial<NonNullable<RulesViewModel['open']>> = {}): RulesViewModel['open'] => ({ id: view.id, rule: { status: 'ready', value: view }, busy: false, refused: null, points: GARMENT_POINTS, ...extra })

const poms = (model: PomsViewModel): SizesDepthViewModel => ({ switch: { library: 'poms', importHeld: model.can.manage ? null : 'held.noManage' }, poms: model })
const rules = (model: RulesViewModel): SizesDepthViewModel => ({ switch: { library: 'rules', importHeld: model.can.manage ? null : 'held.noManage' }, rules: model })

export const designScreen = defineDesignScreen<SizesDepthViewModel>({
  screen: 'SCR-345',
  title: 'Sizes & measurements: Points of measure · Grade rules',
  view: SizesDepthView,
  cases: [
    { id: 'poms', label: 'Points of measure (Owner)', model: poms(pomsBase()), note: 'Name, how-to, unit and default tolerance typed in the list (saved by themselves); the chest width has a picture (its card).' },
    { id: 'poms-developer', label: 'Points of measure: product developer', model: poms(pomsBase('developer')) },
    { id: 'poms-quality', label: 'Points of measure: quality (reads)', model: poms(pomsBase('quality')), note: 'Cells as text; New point, Import and Archive held with the reason.' },
    {
      id: 'poms-marks',
      label: 'Cells saving and refused',
      model: poms({ ...pomsBase(), marks: { [markKey(POMS[1]!.id, 'defaultTolerance')]: { state: 'saving', value: '1,5' }, [markKey(POMS[0]!.id, 'uom')]: { state: 'refused', problem: 'poms.problem.inUse' } } }),
      note: 'Back length\'s tolerance saving; the chest width\'s unit refused: in use (the API says so).',
    },
    { id: 'poms-offline', label: 'Offline: a change waits', model: poms({ ...pomsBase(), offline: true, marks: { [markKey(POMS[3]!.id, 'name')]: { state: 'waiting', value: 'Larghezza vita ½ (chiusa)' } } }) },
    { id: 'poms-selected', label: 'Two selected: Export · Restore · Archive', model: poms({ ...pomsBase(), selected: [POMS[4]!.id, POMS[5]!.id] }) },
    { id: 'poms-archive', label: 'Archive 2', model: poms({ ...pomsBase(), selected: [POMS[4]!.id, POMS[5]!.id], dialog: { kind: 'status', to: 'ARCHIVED', ids: [POMS[4]!.id, POMS[5]!.id] } }) },
    { id: 'poms-archived', label: 'Archived view', model: poms({ ...pomsBase(), filters: { ...NO_DEPTH_FILTERS, status: 'archived' }, rows: { items: [POMS[7]!], more: false, count: 1, problem: null } }) },
    { id: 'poms-body', label: 'Body points only', model: poms({ ...pomsBase(), filters: { ...NO_DEPTH_FILTERS, kind: 'BODY' }, rows: { items: [POMS[6]!], more: false, count: 1, problem: null } }) },
    { id: 'poms-new', label: 'New point', model: poms({ ...pomsBase(), dialog: { kind: 'new' }, edit: { point: null, problem: null, busy: false, refused: null } }), note: '`c`; the code is the inspection\'s point code; a garment point names its body point.' },
    {
      id: 'poms-new-taken',
      label: 'New point: code taken',
      model: poms({ ...pomsBase(), dialog: { kind: 'new' }, edit: { point: null, problem: null, busy: false, refused: null }, draft: { companyId: null, code: 'demo-chest_w', name: 'Petto', kind: 'GARMENT', bodyZone: 'UPPER', uom: 'CM', defaultTolerance: '1', bodyPointId: null, howTo: '' } }),
      note: 'Held: the code is in the library whatever the letter case.',
    },
    { id: 'poms-edit', label: 'Edit point (in use, with its picture)', model: poms({ ...pomsBase(), dialog: { kind: 'edit', id: POMS[0]!.id }, edit: { point: POM_VIEW, problem: null, busy: false, refused: null }, looks: { [POMS[0]!.id]: { state: 'ready', url: PICTURE } } }), note: 'Kind and unit stay (in use, said); Replace or Remove the picture.' },
    { id: 'poms-edit-free', label: 'Edit point (unused, no picture)', model: poms({ ...pomsBase(), dialog: { kind: 'edit', id: POMS[5]!.id }, edit: { point: FREE_VIEW, problem: null, busy: false, refused: null } }) },
    { id: 'poms-edit-refused', label: 'Edit point: refused', model: poms({ ...pomsBase(), dialog: { kind: 'edit', id: POMS[0]!.id }, edit: { point: POM_VIEW, problem: null, busy: false, refused: { key: 'problem.write.inUse', paths: ['uom'], messages: ['Point of measure DEMO-CHEST_W is in use (21 measurement spec value(s), 2 grade rule step(s)): its unit stay as they are. Make a new point instead.'], reload: false } } }) },
    { id: 'poms-edit-loading', label: 'Edit point: reading', model: poms({ ...pomsBase(), dialog: { kind: 'edit', id: POMS[0]!.id }, edit: { point: null, problem: null, busy: false, refused: null } }) },
    { id: 'poms-saved', label: 'Saved', model: poms({ ...pomsBase(), notice: { key: 'poms.notice.created', tone: 'success', params: { code: 'DEMO-HEM_W' } } }) },
    { id: 'poms-updates', label: 'Live changes waiting', model: poms({ ...pomsBase(), updates: 2 }) },
    { id: 'poms-filtered-empty', label: 'Nothing matches', model: poms({ ...pomsBase(), filters: { ...NO_DEPTH_FILTERS, q: 'zzz' }, rows: { items: [], more: false, count: 0, problem: null } }) },
    { id: 'poms-empty', label: 'No points yet', model: poms({ ...pomsBase(), rows: { items: [], more: false, count: 0, problem: null } }) },
    { id: 'poms-loading', label: 'Loading', model: poms({ ...pomsBase(), rows: { items: null, more: false, count: null, problem: null }, asOf: null }) },
    { id: 'poms-error', label: 'Could not load', model: poms({ ...pomsBase(), rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' } }) },
    { id: 'poms-no-permission', label: 'No access', model: poms({ ...pomsBase('sales'), can: { ...canOf('sales'), view: false }, rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' } }) },
    { id: 'rules', label: 'Grade rules (Owner)', model: rules(rulesBase()), note: 'Rule, scale (one of size and fit), base size, points and steps, increments, the specs graded with it.' },
    { id: 'rules-quality', label: 'Grade rules: quality (reads)', model: rules(rulesBase('quality')) },
    { id: 'rules-selected', label: 'Two selected', model: rules({ ...rulesBase(), selected: [RULES[1]!.id, RULES[2]!.id] }) },
    { id: 'rules-scale', label: 'One scale\'s rules', model: rules({ ...rulesBase(), filters: { ...NO_DEPTH_FILTERS, scaleId: FIT_SCALE.id }, rows: { items: [RULES[2]!], more: false, count: 1, problem: null } }) },
    { id: 'rules-open', label: 'Grade rule pop-up (relative)', model: rules({ ...rulesBase(), open: opened(RULE_VIEW) }), note: 'Every step 2 for chest, 58 → 60 given 2,5; sleeve 44 → 46 −0,5; what it grades to below (base 52 marked).' },
    { id: 'rules-open-fit', label: 'Grade rule pop-up (size and fit)', model: rules({ ...rulesBase(), open: opened(PANT_VIEW) }), note: 'Steps along each fit (48R → 50R …, 48L → 50L …) plus the given 50R → 50L; 52L is not reached by inseam (said).' },
    {
      id: 'rules-open-changed',
      label: 'Grade rule pop-up: changed to absolute',
      model: rules({ ...rulesBase(), open: opened(RULE_VIEW, { preset: { fields: { name: RULE_VIEW.name, baseSize: '52', format: 'ABSOLUTE' }, rows: stepRowsOf(RULE_VIEW) } }) }),
      note: 'Absolute: columns from the base 52 to every size; the two steps not from 52 are said and left out on Save.',
    },
    { id: 'rules-open-refused', label: 'Grade rule pop-up: refused', model: rules({ ...rulesBase(), open: opened(RULE_VIEW, { refused: { key: 'problem.write.invalid', paths: ['steps/3/toSize'], messages: ['Not a size of the rule\'s scale: 66 (44, 46, …).'], reload: false } }) }) },
    { id: 'rules-open-quality', label: 'Grade rule pop-up: quality (reads)', model: rules({ ...rulesBase('quality'), open: opened(RULE_VIEW) }) },
    { id: 'rules-open-loading', label: 'Grade rule pop-up: reading', model: rules({ ...rulesBase(), open: { id: RULE_VIEW.id, rule: { status: 'loading' }, busy: false, refused: null, points: null } }) },
    { id: 'rules-open-error', label: 'Grade rule pop-up: could not read', model: rules({ ...rulesBase(), open: { id: RULE_VIEW.id, rule: { status: 'error', problem: 'problem.read.unavailable' }, busy: false, refused: null, points: null } }) },
    { id: 'rules-new', label: 'New grade rule', model: rules({ ...rulesBase(), dialog: { kind: 'new' }, newRule: { sizes: EU_SIZES, busy: false, refused: null, draft: { companyId: null, code: 'GR-DEMO-NEW', name: 'Nuova (demo)', scaleId: SCALE.id, baseSize: '52', format: 'RELATIVE' } } }) },
    { id: 'rules-archive', label: 'Archive 1', model: rules({ ...rulesBase(), selected: [RULES[1]!.id], dialog: { kind: 'status', to: 'ARCHIVED', ids: [RULES[1]!.id] } }) },
    { id: 'rules-empty', label: 'No rules yet', model: rules({ ...rulesBase(), rows: { items: [], more: false, count: 0, problem: null } }) },
    { id: 'rules-loading', label: 'Loading', model: rules({ ...rulesBase(), rows: { items: null, more: false, count: null, problem: null }, asOf: null }) },
    { id: 'rules-error', label: 'Could not load', model: rules({ ...rulesBase(), rows: { items: null, more: false, count: null, problem: 'problem.read.unavailable' } }) },
    { id: 'rules-no-permission', label: 'No access', model: rules({ ...rulesBase('sales'), can: { ...canOf('sales'), view: false }, rows: { items: null, more: false, count: null, problem: 'problem.read.forbidden' } }) },
  ],
})

export { POM_VIEW, RULE_VIEW, PANT_VIEW }
