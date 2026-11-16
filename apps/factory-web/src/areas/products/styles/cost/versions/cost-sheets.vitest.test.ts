import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COMPONENT_MISSING, COMPONENT_WARNINGS } from '@nexus/factory-domain/costing/sheet-components/rules'
import { LINE_SOURCES, SHEET_CATEGORIES } from '@nexus/factory-domain/costing/sheet-components/components'
import { GOAL_STATES } from '@nexus/factory-domain/costing/goal-seek/rules'
import { WEIGHT_SOURCES } from '@nexus/factory-domain/costing/size-weights/rules'
import { VERSION_REFUSALS } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { MASS_REFUSALS as DOMAIN_MASS_REFUSALS, SERIES_STATES } from '@nexus/factory-domain/costing/mass-update/rules'
import { CPM_REFUSALS as DOMAIN_CPM_REFUSALS } from '@nexus/factory-domain/costing/cost-per-minute/rules'
import { OVERHEAD_BASES } from '@nexus/factory-domain/costing/overhead-rules/rules'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { ApiError } from '../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen as bySizeScreen } from '../bysize/fixtures'
import { sizeRowsOf, surchargeHeld } from '../bysize/model'
import { designScreen as stepsScreen } from '../components/fixtures'
import { cartonPiecesOf, howWords, lineWords, sizeInView, stepsFor, W2B_STEPS } from '../components/model'
import { designScreen as goalScreen } from '../goalseek/fixtures'
import { goalAskOf, goalQueryOf, goalStateOf, keepBodyOf, keepChangesNothing } from '../goalseek/model'
import { designScreen as compareScreen } from './compare/fixtures'
import { DEMO_CAN, DEMO_GRAINS, demoBySize, demoComponents, demoRecord, demoRows, demoTask } from './demo/fixtures'
import { designScreen as versionsScreen } from './fixtures'
import { approveHeld, compareDefaults, CS_NS, KNOWN_REFUSALS, removeHeld, sendHeld, takeBackHeld, typedAmount, typedMargin, typedPieces, versionInView, versionState, writeProblem } from './model'
import { newVersionBody, newVersionDraft, newVersionProblems, reasonProblem } from './screen'
// B-W2b-GB02 (G054): lines typed on a draft (a commission), the style's size mix.
import { TYPED_CATEGORIES as DOMAIN_TYPED_CATEGORIES } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { modeOf, percentHeld, removeTypedHeld, TYPED_CATEGORIES, typedBody, typedDraft, typedHeld, typedHow, typedLinesOf, typedPreview, typedProblems } from '../typed/model'
import { mixBody, mixDraft, mixHeld, mixProblems, mixShares, refreshHeld, seasonChoices, typedWeight } from '../sizemix/model'
import { demoSizeWeights } from './demo/fixtures'

const conflict = (code: string) => new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: `refusal/${code}`, message: 'x' }])

describe('cost sheet versions: state, version in view, held reasons (B-W2b-430)', () => {
  const rows = demoRows({ withV4: true })
  it('says each state; shows the approved version first, else the newest draft', () => {
    expect(rows.map(versionState)).toEqual(['superseded', 'approved', 'waiting', 'draft'])
    expect(versionInView(rows, null)?.sheetVersion).toBe(2)
    expect(versionInView(rows.filter((row) => row.state !== 'APPROVED'), null)?.sheetVersion).toBe(4)
    expect(versionInView(rows, rows[0]!.id)?.sheetVersion).toBe(1)
    expect(versionInView([], null)).toBeNull()
    expect(compareDefaults(rows)).toEqual({ a: rows[1]!.id, b: rows[3]!.id })
    expect(compareDefaults(rows.slice(0, 1))).toBeNull()
  })
  it('never lets the person who asked approve, and asks the decider right', () => {
    const waiting = rows[2]!
    expect(approveHeld(DEMO_CAN.owner, waiting, { status: 'ready', value: demoTask() }, false)).toBeNull()
    expect(approveHeld(DEMO_CAN.owner, waiting, { status: 'ready', value: demoTask({ mine: true }) }, false)?.key).toBe('verHeld.ownRequest')
    expect(approveHeld(DEMO_CAN.owner, waiting, { status: 'ready', value: demoTask({ allowed: false }) }, false)?.key).toBe('verHeld.notTheApprover')
    expect(approveHeld(DEMO_CAN.engineer, waiting, { status: 'ready', value: demoTask() }, false)?.key).toBe('verHeld.noDecide')
    expect(approveHeld(DEMO_CAN.owner, rows[3]!, null, false)?.key).toBe('verHeld.notWaiting')
  })
  it('holds send, take back and delete with why', () => {
    const draft = rows[3]!
    expect(sendHeld(DEMO_CAN.engineer, draft, demoRecord(draft), false)).toBeNull()
    expect(sendHeld(DEMO_CAN.engineer, rows[2]!, demoRecord(rows[2]!), false)?.key).toBe('verHeld.waiting')
    expect(sendHeld(DEMO_CAN.engineer, draft, demoRecord(draft, { leftOut: true }), false)?.key).toBe('verHeld.cannotSubmit')
    expect(sendHeld(DEMO_CAN.reader, draft, demoRecord(draft), false)?.key).toBe('verHeld.noManage')
    expect(takeBackHeld(DEMO_CAN.costingOwner, rows[1]!, false)).toBeNull()
    expect(takeBackHeld(DEMO_CAN.engineer, rows[1]!, false)?.key).toBe('verHeld.noApprove')
    expect(takeBackHeld(DEMO_CAN.costingOwner, draft, false)?.key).toBe('verHeld.notApproved')
    expect(removeHeld(DEMO_CAN.engineer, rows[1]!, null, false)?.key).toBe('verHeld.notDraft')
  })
  it('says a refusal from its code, never the API\'s words', () => {
    expect(writeProblem(conflict('LOCKED'))).toEqual({ key: 'verRefusal.LOCKED', reload: false })
    expect(writeProblem(conflict('DATABASE')).reload).toBe(true)
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }])).key).toBe('verProblem.write.moved')
    expect(writeProblem(new ApiError('step_up', 403, 'forbidden', 'x')).key).toBe('verProblem.write.stepUp')
    expect(KNOWN_REFUSALS.filter((code) => !(VERSION_REFUSALS as readonly string[]).includes(code))).toEqual(['NOT_DRAFT'])
  })
  it('reads typed figures the way a person types them', () => {
    expect([typedAmount('260,50'), typedAmount('0'), typedAmount('abc')]).toEqual(['260.50', null, null])
    expect([typedMargin('42'), typedMargin('-5,5'), typedMargin('100')]).toEqual(['42', '-5.5', null])
    expect([typedPieces('12'), typedPieces('0'), typedPieces('10001')]).toEqual([12, null, null])
    expect(reasonProblem('ok')).toBe('verBack.problem.short')
  })
  it('sends a new version\'s figures only with their grain', () => {
    const draft = newVersionDraft('COMPONENTS', null, '52', { targetPrice: '260', targetMarginPct: '42', piecesPerCarton: '12', seasonId: '' })
    expect(newVersionProblems(draft)).toEqual({})
    const input = { styleId: 's', revisionId: 'r', companyId: null, colourwayId: 'c', grains: DEMO_GRAINS.cost }
    expect(newVersionBody(draft, input)).toEqual({ styleId: 's', from: 'COMPONENTS', revisionId: 'r', seasonId: null, baseSize: '52', piecesPerCarton: 12, colourwayId: 'c' })
    expect(newVersionBody(draft, { ...input, grains: DEMO_GRAINS.all })).toMatchObject({ targetPrice: '260', targetMarginPct: '42' })
    expect(newVersionBody(newVersionDraft('COPY', 'v2', '52'), input)).toEqual({ styleId: 's', from: 'COPY', basedOnId: 'v2' })
  })
})

describe('the cost sheet\'s W2b steps: lines in our words (B-W2b-418\'s labels read back)', () => {
  const kind = (code: string) => `kind:${code}`
  it('reads the composed labels into their names', () => {
    expect(lineWords({ category: 'SUBCONTRACT', label: 'OP-EMB-01 Ricamo at Laboratorio' }, kind)).toEqual({ key: 'stepLine.outside', params: { operation: 'OP-EMB-01 Ricamo', workshop: 'Laboratorio' } })
    expect(lineWords({ category: 'SUBCONTRACT', label: 'Transport to Laboratorio' }, kind).key).toBe('stepLine.transportOut')
    expect(lineWords({ category: 'SUBCONTRACT', label: 'Transport back from Laboratorio' }, kind).key).toBe('stepLine.transportBack')
    expect(lineWords({ category: 'FREIGHT', label: 'Insurance on the material' }, kind).key).toBe('stepLine.insuranceOnMaterial')
    expect(lineWords({ category: 'DUTY', label: 'Duty on protector materials' }, kind)).toEqual({ key: 'stepLine.dutyOnKind', params: { kind: 'kind:PROTECTOR' } })
    expect(lineWords({ category: 'PACKAGING', label: "Cartone: one garment's share" }, kind)).toEqual({ key: 'stepLine.cartonShare', params: { name: 'Cartone' } })
    expect(lineWords({ category: 'MATERIAL', label: 'DEMO-LIN-01 Fodera' }, kind)).toEqual({ key: 'stepLine.named', params: { label: 'DEMO-LIN-01 Fodera' } })
    expect(lineWords({ category: 'COMMISSION', label: null }, kind).key).toBe('stepLine.unnamed')
  })
  it('groups the steps for a size and says how a figure is made', () => {
    const view = demoComponents()
    const steps = stepsFor(view.lines, '52')
    expect(steps.map((step) => step.id)).toEqual(W2B_STEPS.map((step) => step.id))
    expect(steps.map((step) => [step.lines.length, step.amount])).toEqual([
      [3, '8.900000'],
      [3, '0.450000'],
      [2, '1.819200'],
      [0, '0'],
    ])
    const carton = view.lines.find((entry) => entry.label?.startsWith('Cartone'))!
    expect(cartonPiecesOf(carton)).toBe(12)
    const money = (value: string | null | undefined) => (value ? `€${value}` : null)
    expect(howWords(carton, money, String).key).toBe('stepHow.carton')
    expect(howWords(carton, () => null, String).key).toBe('stepHow.cartonNoGrain')
    expect(howWords(view.lines.find((entry) => entry.source === 'LANDED_COST')!, money, String).key).toBe('stepHow.landed')
    expect(sizeInView(view, '99')).toBe('52')
    expect(sizeInView(view, '56')).toBe('56')
  })
})

describe('target price and cost by size', () => {
  it('asks the API with a figure only with its grain, and keeps a target on a draft', () => {
    const sheet = demoRows()[2]!
    const ask = goalAskOf(sheet, 'it')
    expect(ask).toEqual({ targetPrice: '260', targetMarginPct: '42', basis: 'WEIGHTED', size: '52' })
    expect(goalQueryOf({ ...ask, targetPrice: '250,5' }, DEMO_GRAINS.all)).toEqual({ targetPrice: '250.5', targetMarginPct: '42' })
    expect(goalQueryOf({ ...ask, basis: 'SIZE', size: '56' }, DEMO_GRAINS.cost)).toEqual({ basis: 'SIZE', size: '56' })
    expect(keepChangesNothing(ask, sheet, DEMO_GRAINS.all)).toBe(true)
    expect(keepBodyOf({ ...ask, targetMarginPct: '' }, DEMO_GRAINS.all)).toEqual({ targetPrice: '260', targetMarginPct: null })
    expect(goalStateOf({ state: 'ABOVE' })).toEqual({ key: 'goalState.ABOVE', tone: 'warning' })
  })
  it('offers a surcharge for a big size, held with why', () => {
    const rows = sizeRowsOf(demoBySize({ current: true }))
    const big = rows.find((row) => row.size === '58')!
    expect(rows.find((row) => row.base)?.size).toBe('52')
    expect(surchargeHeld(big, DEMO_CAN.owner, DEMO_GRAINS.all, 'EUR', false)).toBeNull()
    expect(surchargeHeld(rows.find((row) => row.size === '56')!, DEMO_CAN.owner, DEMO_GRAINS.all, 'EUR', false)?.key).toBe('bysize.heldSame')
    expect(surchargeHeld(big, DEMO_CAN.engineer, DEMO_GRAINS.cost, 'EUR', false)?.key).toBe('bysize.heldRight')
    expect(surchargeHeld(sizeRowsOf(demoBySize({ target: false }))[6]!, DEMO_CAN.owner, DEMO_GRAINS.all, 'EUR', false)?.key).toBe('bysize.heldNoTarget')
  })
})

// ---- B-W2b-GB02 (G054; B-W2b-430 gaps 1 and 4) ---------------------------------------------------------------------------------------

describe('lines typed on a draft: a commission of the target price, a figure the components do not know (G054)', () => {
  const rows = demoRows({ v3: 'draft', withV4: true })
  it('types the same categories as the API, in percent only for a commission, and sends what the API takes', () => {
    expect([...TYPED_CATEGORIES].sort()).toEqual([...DOMAIN_TYPED_CATEGORIES].sort())
    const percent = typedDraft({ label: ' Agente Esempio ', pct: '5,5' })
    expect(typedProblems(percent)).toEqual({})
    expect(typedBody(percent, 3)).toEqual({ version: 3, category: 'COMMISSION', label: 'Agente Esempio', pct: '5.5' })
    expect(typedPreview(percent, '260.000000')).toBe('14.300000')
    // Another category is always an amount (its percent mode is ignored).
    const packaging = typedDraft({ category: 'PACKAGING', mode: 'percent', label: 'Scatola regalo', size: '58', quantity: '2', unitCost: '1,25' })
    expect(modeOf(packaging)).toBe('amount')
    expect(typedBody(packaging, 3)).toEqual({ version: 3, category: 'PACKAGING', label: 'Scatola regalo', size: '58', quantity: '2', unitCost: '1.25' })
    expect(typedPreview(packaging, null)).toBe('2.500000')
    expect(typedProblems(typedDraft({ label: '', pct: '120' }))).toEqual({ label: 'typed.problem.label', pct: 'typed.problem.pct' })
    expect(typedProblems(typedDraft({ mode: 'amount', label: 'x', quantity: '0', unitCost: 'abc' }))).toEqual({ quantity: 'typed.problem.quantity', unitCost: 'typed.problem.unitCost' })
  })
  it('holds typing and removing with why: a draft, the right, the cost grain; a percent needs the target price', () => {
    const draft = rows[2]!
    expect(typedHeld(DEMO_CAN.engineer, DEMO_GRAINS.cost, draft, false)).toBeNull()
    expect(typedHeld(DEMO_CAN.reader, DEMO_GRAINS.all, draft, false)?.key).toBe('verHeld.noManage')
    expect(typedHeld(DEMO_CAN.owner, DEMO_GRAINS.none, draft, false)?.key).toBe('typed.held.noCostGrain')
    expect(typedHeld(DEMO_CAN.owner, DEMO_GRAINS.all, rows[1]!, false)?.key).toBe('verHeld.locked')
    expect(percentHeld(draft, DEMO_GRAINS.all)).toBeNull()
    expect(percentHeld(rows[3]!, DEMO_GRAINS.all)?.key).toBe('typed.held.noTarget')
    expect(percentHeld(draft, DEMO_GRAINS.cost)?.key).toBe('typed.held.noPriceGrain')
    expect(removeTypedHeld(DEMO_CAN.owner, rows[1]!, false)?.key).toBe('verHeld.locked')
  })
  it('lists the typed lines of a version and says how each is made, figures only with the grain', () => {
    const record = demoRecord(rows[2]!, { typed: true })
    const typed = typedLinesOf(record)
    expect(typed.map((line) => [line.label, line.size, line.pct])).toEqual([
      ['Agente Esempio Nord', null, '5'],
      ['Commissione di pagamento', '58', null],
    ])
    const money = (value: string | null | undefined) => (value ? `€${Number(value).toFixed(2)}` : null)
    expect(typedHow(typed[0]!, money, String)).toEqual({ key: 'typed.how.percent', params: { pct: '5', amount: '€13.00' } })
    expect(typedHow(typed[0]!, () => null, String).key).toBe('typed.how.percentNoGrain')
    expect(typedHow(typed[1]!, money, String)).toEqual({ key: 'typed.how.amount', params: { quantity: '1', unit: '€1.50', amount: '€1.50' } })
    expect(typedLinesOf(demoRecord(rows[2]!))).toEqual([])
  })
})

describe("the style's size mix on screen (G054)", () => {
  const view = demoSizeWeights()
  it('starts the dialog from the kept weights, checks each weight, shows the shares and sends the mix', () => {
    const every = mixDraft(view, '')
    expect(every.weights).toEqual({ '46': '', '48': '1', '50': '2', '52': '3', '54': '2.5', '56': '1.5', '58': '' })
    expect(mixProblems(every)).toEqual({ sizes: {}, empty: false })
    expect(mixShares(every).map((entry) => `${entry.size}:${entry.sharePct}`)).toEqual(['48:10.0', '50:20.0', '52:30.0', '54:25.0', '56:15.0'])
    expect(mixBody('st', { seasonId: '', weights: { ...every.weights, '58': '0,5' } })).toEqual({ styleId: 'st', seasonId: null, weights: { '48': '1', '50': '2', '52': '3', '54': '2.5', '56': '1.5', '58': '0.5' } })
    expect(mixProblems({ seasonId: '', weights: { '50': 'tre', '52': '0' } }).sizes).toEqual({ '50': 'mix.problem.weight', '52': 'mix.problem.weight' })
    expect(mixProblems({ seasonId: '', weights: { '50': '', '52': ' ' } }).empty).toBe(true)
    expect(mixBody('st', { seasonId: 'ai27', weights: { '50': '' } })).toEqual({ styleId: 'st', seasonId: 'ai27', weights: {} })
    expect([typedWeight('2,5'), typedWeight('0'), typedWeight('123456')]).toEqual(['2.5', null, null])
  })
  it('offers the seasons kept and the version in view, and holds an edit or a re-read with why', () => {
    const rows = demoRows({ v3: 'draft' })
    expect(seasonChoices(view, rows[2]!).map((choice) => choice.code)).toEqual(['AI27'])
    expect(mixHeld(DEMO_CAN.reader, false)?.key).toBe('verHeld.noManage')
    expect(mixHeld(DEMO_CAN.engineer, false)).toBeNull()
    expect(refreshHeld(DEMO_CAN.engineer, rows[2]!, false)).toBeNull()
    expect(refreshHeld(DEMO_CAN.engineer, rows[1]!, false)?.key).toBe('mix.held.notDraft')
  })
})
// ---- end B-W2b-GB02

// ---- every word in it and en; every design case draws with no key left -------------------------------------------------------------

const SRC = fileURLToPath(new URL('../../../../..', import.meta.url))
const ROOTS = ['csCommon', 'steps', 'stepSource', 'stepLine', 'stepHow', 'stepMissing', 'stepWarn', 'stepCat', 'ver', 'verState', 'verWords', 'verView', 'weightSource', 'verAct', 'verHeld', 'verProblem', 'verRefusal', 'verStepUp', 'verNew', 'verSend', 'verApprove', 'verBack', 'verRemove', 'verNotice', 'verCmp', 'goal', 'goalBasis', 'goalState', 'bysize', 'mass', 'massRefusal', 'massSeries', 'cpm', 'cpmRefusal', 'dept', 'ohr', 'ohrBasis', 'ohrPer', 'typed', 'mix', 'ohrEdit', 'ohrRefusal'] // B-W2b-GB02: + typed, mix, ohrEdit, ohrRefusal
const FOLDERS = ['areas/products/styles/cost/versions', 'areas/products/styles/cost/components', 'areas/products/styles/cost/goalseek', 'areas/products/styles/cost/bysize', 'areas/finance/costing/mass-update', 'areas/finance/settings/costing/calculator', 'areas/products/styles/cost/typed', 'areas/products/styles/cost/sizemix'] // B-W2b-GB02: + typed, sizemix
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale][CS_NS] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('cost-sheets: every key the screens name exists in it and en', () => {
  it('the literal keys of the owned folders, and the built ones', () => {
    const pattern = new RegExp(`['"\`]((?:${ROOTS.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
    const keys = new Set<string>()
    for (const dir of FOLDERS) for (const file of sources(join(SRC, dir))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    const built = [
      ...LINE_SOURCES.map((source) => `stepSource.${source}`),
      ...COMPONENT_MISSING.map((code) => `stepMissing.${code}`),
      ...COMPONENT_WARNINGS.map((code) => `stepWarn.${code}`),
      ...SHEET_CATEGORIES.map((category) => `stepCat.${category}`),
      ...W2B_STEPS.flatMap((step) => [`steps.step.${step.id}`, `steps.empty.${step.id}`]),
      ...['draft', 'waiting', 'approved', 'superseded', 'seasonClosed', 'withdrawn'].flatMap((state) => [`verState.${state}`, `verWords.${state}`]),
      ...[...WEIGHT_SOURCES, 'KEPT'].map((source) => `weightSource.${source}`),
      ...KNOWN_REFUSALS.map((code) => `verRefusal.${code}`),
      ...['DRAFT', 'APPROVED', 'FROZEN'].map((state) => `verCmp.state.${state}`),
      ...GOAL_STATES.map((state) => `goalState.${state}`),
      ...['WEIGHTED', 'BASE_SIZE', 'SIZE'].flatMap((basis) => [`goalBasis.${basis}`, `goalBasis.hint.${basis}`]),
      ...['ASKED', 'SHEET', 'NONE'].map((from) => `goal.from.${from}`),
      ...['wrong', 'locked', 'unavailable'].map((problem) => `verStepUp.problem.${problem}`),
      ...DOMAIN_MASS_REFUSALS.map((code) => `massRefusal.${code}`),
      ...SERIES_STATES.map((state) => `massSeries.${state}`),
      ...['prices', 'effect', 'done'].map((step) => `mass.step.${step}`),
      ...['DRAFT', 'APPROVED'].map((state) => `mass.sheetState.${state}`),
      ...DOMAIN_CPM_REFUSALS.map((code) => `cpmRefusal.${code}`),
      ...WORK_CENTRE_KINDS.map((kind) => `dept.${kind}`),
      ...OVERHEAD_BASES.map((basis) => `ohrBasis.${basis}`),
      ...['PER_MINUTE', 'PER_UNIT', 'PER_MACHINE_HOUR'].map((basis) => `ohrPer.${basis}`),
      ...['CAPACITY', 'STATIONS'].map((from) => `cpm.seatsFrom.${from}`),
      // B-W2b-GB02 (G054)
      ...['PER_MINUTE', 'PER_UNIT', 'PER_MACHINE_HOUR'].map((basis) => `ohrEdit.amount.${basis}`),
      ...['OVERLAPS', 'START_TAKEN', 'ARCHIVED', 'NOTHING_CHANGES', 'DATABASE'].map((code) => `ohrRefusal.${code}`),
    ]
    expect(keys.size).toBeGreaterThan(300)
    expect([...keys, ...built].filter((key) => !has(key))).toEqual([])
  })
})

const LEFT_KEY = new RegExp(`\\b(?:${ROOTS.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case of SCR-500 … SCR-504 draws in both languages with no key left on screen', () => {
  for (const screen of [versionsScreen, compareScreen, stepsScreen, goalScreen, bySizeScreen] as unknown as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/https?:\/\/[^"\s<]+/g, '').replace(/href="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
