import { at, COMPANY_ID, uid } from '../../../../library/demo'
import { demoRouting, demoStyle, REV, SIZES, STYLE_ID } from '../../../demo/fixtures'
import type { PlanRow, RoutingDepth, RoutingTimesView, StepDepth, StyleOptionsView } from '../api'
import { NO_DEPTH, type RoutingDepthModel } from '../model'

/**
 * B-W2b-235 design data for the Routing tab in depth (SCR-043 `w2b-235-*` cases) — made-up only, on DEMO-JKT-01's nine steps:
 * the leather cut from SMV version 2 of its library operation (governed) with 20 min set-up and a first-piece cutting
 * checkpoint; the sleeves typed at 18.5 against the library's approved 17 with set-up 10, wait 15 and +1 / +2 min in 56 / 58
 * and two machine settings; the lining built from its own allowances (20 min + 10 %); the lining cut only for 54–58; the
 * final check with 5 min move. Every figure is invented.
 */

const STEPS = demoRouting().steps
const words = (it: string, en: string) => ({ it, en })
const COLOURWAYS = demoStyle().colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name }))
const SIZE_REFS = SIZES.map((size) => ({ code: size, label: size }))

const SETTING = (n: number, fields: Partial<StepDepth['settings'][number]> & { line: { it: string; en: string } }): StepDepth['settings'][number] => ({
  id: uid('2355', n),
  seq: n,
  machineClass: null,
  stitchType: null,
  needle: null,
  thread: null,
  stitchesPerCm: null,
  tension: null,
  foot: null,
  notes: null,
  ...fields,
})

const SLEEVE_SETTINGS = [
  SETTING(1, {
    machineClass: { id: uid('2356', 1), code: 'DEMO-COL', label: words('Colonna', 'Post-bed'), active: true },
    stitchType: '301',
    needle: '134 LR Nm 110',
    thread: 'Tkt 40',
    stitchesPerCm: '3.5',
    foot: 'Piedino a rullo',
    line: words('Colonna · 301 · 134 LR Nm 110 · Tkt 40 · 3,5 per cm · Piedino a rullo', 'Post-bed · 301 · 134 LR Nm 110 · Tkt 40 · 3.5 per cm · Piedino a rullo'),
  }),
  SETTING(2, { stitchType: '301', needle: '134 Nm 90', thread: 'Tkt 60', stitchesPerCm: '4', notes: 'Impuntura a 6 mm', line: words('301 · 134 Nm 90 · Tkt 60 · 4 per cm', '301 · 134 Nm 90 · Tkt 60 · 4 per cm') }),
]

const CHECKPOINT_CUT: StepDepth['checkpoint'] = {
  plan: { id: uid('2357', 1), code: 'DEMO-INL-TAG', name: 'Primo pezzo taglio pelle', stage: 'CUTTING', companyId: COMPANY_ID },
  approvedVersion: { id: uid('2358', 1), number: 1, frequency: 'FIRST_PIECE', frequencyValue: null },
  kind: 'FIRST_PIECE',
  does: words('Apre un controllo primo pezzo al primo avanzamento di ogni mazzetto.', 'Opens a first-piece check at each bundle’s first report.'),
  warning: null,
}
const CHECKPOINT_SLEEVE: StepDepth['checkpoint'] = {
  plan: { id: uid('2357', 2), code: 'DEMO-EOL-MAN', name: 'Fine linea maniche', stage: 'END_OF_LINE', companyId: COMPANY_ID },
  approvedVersion: null,
  kind: null,
  does: words('Apre un controllo di fine linea.', 'Opens an end-of-line check.'),
  warning: words('Il piano non ha una versione approvata: per ora non apre nulla.', 'The plan has no approved version: it opens nothing yet.'),
}

export function demoDepth(options: { released?: boolean; options?: boolean } = {}): RoutingDepth {
  const steps: StepDepth[] = STEPS.map((step, index) => {
    const lining = step.code === 'TAG-FOD'
    return {
      stepId: step.id,
      seq: step.seq,
      operationId: step.operation.id,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      scanRequired: step.scanRequired,
      variants: lining
        ? { sizes: ['54', '56', '58'].map((code) => ({ code, label: code })), colourways: [], optionValueIds: [], words: words('Solo per le taglie 54, 56, 58', 'Only for sizes 54, 56, 58') }
        : step.code === 'FIN-STI' && options.options
          ? { sizes: [], colourways: [], optionValueIds: [uid('2359', 2)], words: words('Solo per l\'opzione Cappuccio: staccabile', 'Only for option Hood: detachable') }
          : { sizes: [], colourways: [], optionValueIds: [], words: null },
      checkpoint: step.code === 'TAG-PEL' ? CHECKPOINT_CUT : step.code === 'CUC-MAN' ? CHECKPOINT_SLEEVE : null,
      settings: step.code === 'CUC-MAN' ? SLEEVE_SETTINGS : [],
      librarySettings: step.code === 'CUC-MAN' ? 2 : step.code === 'CUC-SPA' || step.code === 'CUC-FOD' ? 1 : 0,
      version: index + 2,
      updatedAt: at(27, 9),
    }
  })
  const released = !!options.released
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, status: 'ACTIVE' },
    revision: released
      ? { id: REV.r2, revision: 2, status: 'RELEASED', effectiveFrom: '2026-10-05', effectiveTo: null, fromSource: 'RELEASE' }
      : { id: REV.r3, revision: 3, status: 'DRAFT', effectiveFrom: null, effectiveTo: null, fromSource: null },
    sizes: SIZE_REFS,
    colourways: COLOURWAYS,
    steps,
    options: options.options
      ? { available: true, words: words('Opzioni offerte dall\'articolo: Cappuccio.', 'Options the style offers: Hood.') }
      : { available: false, words: words('L\'articolo non offre ancora opzioni: un passo vale per taglie e varianti colore.', 'The style offers no options yet: a step is for sizes and colourways.') },
    editable: !released,
  }
}

type StepTimes = RoutingTimesView['steps'][number]

const EXTRAS: Record<string, Array<{ size: string; extraMinutes: string }>> = {
  'TAG-PEL': [{ size: '58', extraMinutes: '1' }],
  'CUC-MAN': [
    { size: '56', extraMinutes: '1' },
    { size: '58', extraMinutes: '2' },
  ],
  'CUC-FOD': [{ size: '58', extraMinutes: '1.5' }],
}

export function demoTimes(options: { released?: boolean } = {}): RoutingTimesView {
  const steps: StepTimes[] = STEPS.map((step, index) => {
    const minutes = step.standardMinutes
    const extras = EXTRAS[step.code] ?? []
    const run: StepTimes['run'] =
      step.code === 'TAG-PEL'
        ? { from: 'VERSION', standardMinutes: minutes, basicMinutes: '8.5', personalPct: '5', fatiguePct: '4', delayPct: '2.7647', timeVersion: { id: uid('2360', 2), number: 2, status: 'APPROVED', effectiveFrom: '2026-10-01' } }
        : step.code === 'CUC-FOD'
          ? { from: 'ALLOWANCES', standardMinutes: minutes, basicMinutes: '20', personalPct: '4', fatiguePct: '3', delayPct: '3', timeVersion: null }
          : { from: 'TYPED', standardMinutes: minutes, basicMinutes: null, personalPct: null, fatiguePct: null, delayPct: null, timeVersion: null }
    const library: StepTimes['library'] =
      step.code === 'TAG-PEL'
        ? { standardMinutes: minutes, governed: true, inForceVersionId: uid('2360', 2), inForceNumber: 2, differs: false }
        : step.code === 'CUC-MAN'
          ? { standardMinutes: '17', governed: true, inForceVersionId: uid('2360', 5), inForceNumber: 1, differs: true }
          : { standardMinutes: minutes, governed: false, inForceVersionId: null, inForceNumber: null, differs: false }
    return {
      stepId: step.id,
      seq: step.seq,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      operationId: step.operation.id,
      run,
      library,
      setupMinutes: step.code === 'TAG-PEL' ? '20' : step.code === 'CUC-MAN' ? '10' : null,
      waitMinutes: step.code === 'CUC-MAN' ? '15' : null,
      moveMinutes: step.code === 'CQ-FIN' ? '5' : null,
      appliesToSizes: step.code === 'TAG-FOD' ? ['54', '56', '58'] : [],
      sizeTimes: extras.map((entry) => ({ ...entry, minutes: String(Number(minutes) + Number(entry.extraMinutes)) })),
      version: index + 2,
    }
  })
  const bySize = SIZES.map((size) => {
    const total = steps.reduce((sum, step) => {
      if (step.appliesToSizes.length > 0 && !step.appliesToSizes.includes(size)) return sum
      const extra = step.sizeTimes.find((entry) => entry.size === size)?.extraMinutes ?? '0'
      return sum + Number(step.run.standardMinutes) + Number(extra)
    }, 0)
    return { size, minutes: String(Math.round(total * 1000) / 1000) }
  })
  const released = !!options.released
  return {
    revision: released ? { id: REV.r2, revision: 2, status: 'RELEASED', version: 9 } : { id: REV.r3, revision: 3, status: 'DRAFT', version: 14 },
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, status: 'ACTIVE' },
    sizes: SIZE_REFS,
    steps,
    perGarment: '96.5',
    bySize,
    setup: '30',
    wait: '15',
    move: '5',
    lead: null,
    editable: !released,
  }
}

/** Two plans a step may take (a cutting and an end-of-line one), and a final one the dialog leaves out. */
export const DEMO_PLANS: PlanRow[] = [
  { id: uid('2357', 1), companyId: COMPANY_ID, code: 'DEMO-INL-TAG', name: 'Primo pezzo taglio pelle', stage: 'CUTTING', appliesTo: [], approved: { id: uid('2358', 1), number: 1 }, draft: null, status: 'APPROVED', latestNumber: 1, owner: null, usedBy: 1, lastChangeAt: at(12, 9), version: 2 },
  { id: uid('2357', 2), companyId: COMPANY_ID, code: 'DEMO-EOL-MAN', name: 'Fine linea maniche', stage: 'END_OF_LINE', appliesTo: [], approved: null, draft: { id: uid('2358', 2), number: 1, submitted: false }, status: 'DRAFT', latestNumber: 1, owner: null, usedBy: 1, lastChangeAt: at(20, 9), version: 1 },
  { id: uid('2357', 3), companyId: COMPANY_ID, code: 'DEMO-INL-CUC', name: 'Controllo in linea cuciture', stage: 'IN_LINE', appliesTo: [], approved: { id: uid('2358', 3), number: 2 }, draft: null, status: 'APPROVED', latestNumber: 2, owner: null, usedBy: 0, lastChangeAt: at(21, 9), version: 3 },
  { id: uid('2357', 4), companyId: COMPANY_ID, code: 'DEMO-FIN-GIA', name: 'Finale giacche', stage: 'FINAL', appliesTo: [], approved: { id: uid('2358', 4), number: 1 }, draft: null, status: 'APPROVED', latestNumber: 1, owner: null, usedBy: 4, lastChangeAt: at(21, 9), version: 2 },
]

/** The style offers one option group, Hood (detachable or fixed). */
export const DEMO_OPTIONS: StyleOptionsView = {
  style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, status: 'ACTIVE' },
  offers: [
    {
      id: uid('2361', 1),
      group: { id: uid('2362', 1), code: 'DEMO-HOOD', name: 'Cappuccio', nameI18n: { it: 'Cappuccio', en: 'Hood' }, kind: 'SINGLE', minPicks: 0, maxPicks: 1, status: 'ACTIVE' },
      seq: 1,
      minPicks: null,
      maxPicks: null,
      effective: { minPicks: 0, maxPicks: 1 },
      picks: words('Al massimo una', 'At most one'),
      defaultValueId: null,
      values: [
        { id: uid('2359', 1), code: 'FIX', name: 'Fisso', nameI18n: { it: 'Fisso', en: 'fixed' }, seq: 1, freeText: false, outsideCertificate: false, status: 'ACTIVE' },
        { id: uid('2359', 2), code: 'STAC', name: 'Staccabile', nameI18n: { it: 'Staccabile', en: 'detachable' }, seq: 2, freeText: false, outsideCertificate: false, status: 'ACTIVE' },
      ],
      status: 'ACTIVE',
      version: 1,
      updatedAt: at(22, 9),
    },
  ],
  lines: [],
  steps: [],
  editable: true,
}

export function demoDepthModel(overrides: Partial<RoutingDepthModel> = {}, options: { released?: boolean; options?: boolean } = {}): RoutingDepthModel {
  return {
    ...NO_DEPTH,
    depth: { status: 'ready', value: demoDepth(options) },
    times: { status: 'ready', value: demoTimes(options) },
    canManage: true,
    companyId: COMPANY_ID,
    ...overrides,
  }
}

/** The step ids of the demo routing by code. */
export const STEP_ID = Object.fromEntries(STEPS.map((step) => [step.code, step.id])) as Record<string, string>
