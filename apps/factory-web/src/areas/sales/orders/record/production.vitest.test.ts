import { readFileSync } from 'node:fs'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { designScreen } from './fixtures'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { productionWordsFor } from '../../../../lib/production/words'
import { COUNTED_STEPS, madeForOf, ownProgress, productionProgress } from './production'
// F-SA-234b
import { forecastPart } from './production'
import { FAILED_STATE, LOADING_STATE, ready, WORK_READ } from './overview/fixtures'
import { LINE_BLK, LINE_RED } from '../_demo/fixtures'
// F-SA-235b
import { designScreen as workOrderScreen } from '../../../production/work-orders/record/fixtures'
// F-OP-115: the work-order row's rules (lib/production/work-order-acts)
import { actsCanOf, cancelHeld, planningHref, rowActsOf, type ActsRow } from '../../../../lib/production/work-order-acts/model'

// op-fx1: a source without its comments (block, JSX and line comments), for a pin about what the code does — never about its notes.
const codeOf = (source: string): string => source.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

/**
 * Lead fix (production-page lane): the order's Production tab wrote `sewn ?? 0` — "0 sewn" where the site does not scan sewing.
 * Now ONE figure (lib/production progressFigure: the bar shows what its words name) and, for a step the site does not count, "—"
 * with the reason in words.
 */

describe('the Production tab’s progress, honest where a step is not scanned', () => {
  const row = (progress: { cut: number | null; bundled: number | null; sewn: number | null; finished: number | null } | null, status = 'IN_PROGRESS') => ({ progress, pieces: 100, status }) as Parameters<typeof productionProgress>[0]

  it('a site that does not scan sewing: no "0 sewn", the step says it is not counted', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: null, sewn: null, finished: 40 }))
    expect(notCounted).toEqual(['sewn'])
    expect(figure.step).toBe('finished')
    expect(figure.percent).toBe(40)
    for (const locale of LOCALES) {
      const words = productionWordsFor(locale)(figure.words.key, figure.words.params)
      expect(words).toMatch(/40/)
      expect(words).not.toMatch(/\b0\b/)
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('production.notCounted.sewn')).not.toMatch(/production\.|\{/)
      for (const step of COUNTED_STEPS) expect(t(`production.step.${step}`)).not.toMatch(/production\./)
    }
  })

  it('the bar shows the figure its words name: sewn 80 of 100 is 80 %, never finished 0 %', () => {
    const { figure, notCounted } = productionProgress(row({ cut: 100, bundled: 90, sewn: 80, finished: 0 }))
    expect(figure).toMatchObject({ step: 'sewn', done: 80, percent: 80 })
    expect(notCounted).toEqual([])
  })

  it('every step counted: none is marked; a draft has no figure and no steps', () => {
    expect(productionProgress(row({ cut: 0, bundled: 0, sewn: 0, finished: 0 })).notCounted).toEqual([])
    const draft = productionProgress(row(null, 'DRAFT'))
    expect(draft.figure.percent).toBeNull()
    expect(draft.notCounted).toEqual([])
  })
})

// ---- F-SA-234: the order's OWN pieces on a work order, and what else it makes (no other customer named or counted) ------------
describe('F-SA-234: Production › Work orders — the order’s own pieces', () => {
  it('ONE figure of the own cells (checked = released by quality); a step not counted is listed, never 0; a draft has none', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: null }
    const { figure, notCounted } = ownProgress(own, 'IN_PROGRESS')
    expect(figure).toMatchObject({ step: 'sewn', done: 30, total: 40, percent: 75 })
    expect(notCounted).toEqual(['finished'])
    expect(ownProgress({ ...own, sewn: null }, 'IN_PROGRESS').notCounted).toEqual(['sewn', 'finished'])
    expect(ownProgress(own, 'DRAFT').figure.percent).toBeNull()
    expect(ownProgress(own, 'DRAFT').notCounted).toEqual([])
  })

  it('"Made for this order 40 of 100 · also makes SO-…": only this customer’s orders by number; another customer’s work in words only', () => {
    const own = { cells: 4, pieces: 40, cut: 40, sewn: 30, checked: 10 }
    expect(madeForOf(own, 100, { orders: [{ number: 'SO-2026-0151' }], more: 2 }, false, false)).toEqual([
      { key: 'production.own.of', params: { own: 40, total: 100 } },
      { key: 'production.own.alsoMakes', params: { number: 'SO-2026-0151' } },
      { key: 'production.own.alsoMore', params: { count: 2 } },
    ])
    const mixed = madeForOf(own, null, { orders: [], more: 0 }, true, true)
    expect(mixed.map((entry) => entry.key)).toEqual(['production.own.all', 'production.own.alsoOther', 'production.own.cutTogether'])
    expect(JSON.stringify(mixed)).not.toMatch(/SO-|Brand|Beta/)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const entry of [...madeForOf(own, 100, { orders: [{ number: 'SO-1' }], more: 2 }, true, true)]) expect(t(entry.key, entry.params), `${locale}: ${entry.key}`).not.toMatch(/production\.|\{/)
      for (const key of ['production.held', 'production.rush', 'production.progressHeld', 'production.col.own', 'production.col.materials', 'gate.money', 'dates.customerSees', 'dates.cutStart', 'dates.sewStart', 'dates.finish']) expect(t(key, { date: 'x' }), `${locale}: ${key}`).not.toBe(key)
      expect(t('production.mtmRow', { style: 'S', colour: 'C', units: 12, workOrders: 12 })).toMatch(/12/)
    }
  })
})
// ---- end F-SA-234

const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(designScreen.view as ComponentType<{ model: unknown }>, designScreen.cases.find((item) => item.id === id)!.model, locale)

// ---- F-SA-235: Holds, quality & problems; Materials; Specs in force (the HealthCard moved to lib, one card) -------------------------
describe('F-SA-235: Production’s holds, quality & problems — each block held in words without its right', () => {
  it('a quality hold in plain words, the office note marked office only, a problem that needs an answer, the NCR, the final inspection', () => {
    const text = textOf(draw('production-quality'))
    for (const words of ['Holds, quality & problems', 'On hold since', 'Shade difference on the leather', 'Goes back to In progress when quality releases it.', 'WO-00022', 'Lotto pelle in verifica col fornitore.', 'Office only', 'Needs an answer: 1', 'Escalated 1×', 'NCR-2026-0041', 'FI-2026-0088', 'Specs in force']) expect(text, words).toContain(words)
    expect(text).not.toContain('No holds, problems or quality findings')
  })

  it('without the rights: each block says what it needs (never "none"); everything read and empty: one sentence', () => {
    const held = textOf(draw('production-no-right'))
    for (const words of ['Problems need the work orders right', 'Nonconformities need the quality right', 'Final inspections need the inspections right', 'Progress needs the work orders right']) expect(held, words).toContain(words)
    expect(held).not.toContain('No holds, problems or quality findings')
    expect(textOf(draw('production-progress'))).toContain('No holds, problems or quality findings')
  })

  it('the work order record’s HealthCard is the one card (moved to lib/production/health); Materials and the tech pack moved to Production', () => {
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("import { HealthCard } from '../../../../../lib/production/health/view/HealthCard'")
    expect(tab).toContain('<MaterialsCard order={order} model={model.depth}')
    expect(tab).toContain('<TechPackCard model={model.depth} actions={actions?.depth} />')
    const workOrder = readFileSync(new URL('../../../production/work-orders/record/view/OverviewTab.tsx', import.meta.url), 'utf8')
    expect(workOrder).toContain("from '../../../../../lib/production/health/view/HealthCard'")
    expect(readFileSync(new URL('./view/LinesTab.tsx', import.meta.url), 'utf8')).not.toContain('<MaterialsCard')
  })
})
// ---- end F-SA-235

// ---- F-SA-234b (sa-7's follow-up): the by-line finish forecast reads the order's own production read (`dates.forecast`) ----------
describe('F-SA-234b — the by-line finish forecast from the order’s own production read, not every site’s promise lines', () => {
  it('ready: per line its finish, what sets it, the days to spare or short; an unknown risk word is no risk', () => {
    const part = forecastPart(ready(WORK_READ))
    expect(part?.problem).toBeNull()
    expect(part?.value?.get(LINE_BLK)).toEqual({ finish: '2026-12-08', source: 'BOARD', slackDays: 7, risk: 'ON_TIME' })
    expect(part?.value?.get(LINE_RED)).toEqual({ finish: '2026-12-29', source: 'WORK_ORDER_DUE', slackDays: -7, risk: 'AT_RISK' })
    const odd = forecastPart(ready({ ...WORK_READ, dates: { ...WORK_READ.dates!, forecast: [{ ...WORK_READ.dates!.forecast![0]!, risk: 'SOMETHING_NEW' }] } }))
    expect(odd?.value?.get(LINE_BLK)?.risk).toBeNull()
  })

  it('withheld (no planning.promise.view) or not read: null — "—" per line, never "not planned"; reading and failed as the read is', () => {
    expect(forecastPart(ready({ ...WORK_READ, withheld: ['dates.forecast'], dates: { ...WORK_READ.dates!, forecast: null } }))).toBeNull()
    expect(forecastPart(null)).toBeNull()
    expect(forecastPart(undefined)).toBeNull()
    expect(forecastPart(LOADING_STATE)).toEqual({ value: null, problem: null })
    expect(forecastPart(FAILED_STATE)).toEqual({ value: null, problem: 'problem.read.unavailable' })
  })

  it('Production draws it by line: 7 days to spare (the planning board), 7 days short (a work order’s due day); withheld: no figure', () => {
    const text = textOf(draw('w2b-323-dates'))
    expect(text).toContain('7 days to spare')
    expect(text).toContain('7 days short')
    expect(text).toContain('The planning board')
    expect(text).toContain('A work order’s due day')
    const held = textOf(draw('w2b-323-dates-withheld'))
    expect(held).not.toContain('days to spare')
    expect(held).not.toContain('Not planned')
  })

  it('the order page makes no read of every site’s promise lines any more (the wide per-site read is gone)', () => {
    const depth = readFileSync(new URL('../depth/use-order-depth.ts', import.meta.url), 'utf8')
    expect(depth).not.toContain('listPromiseLines')
    expect(depth).not.toContain('forecasts')
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('const forecast = forecastPart(model.production)')
    expect(tab).toContain('<ForecastCell key="f" part={forecast} lineId={line.id} />')
    expect(tab).not.toContain('ForecastNote')
  })
})
// ---- end F-SA-234b

// ---- F-SA-235b (sa-7's follow-up): the moved HealthCard draws the same on the sales order as on the work order — its look moved with
// it into lib/production/health (its own classes, the same declarations), so the production area's stylesheet is not needed ---------
describe('F-SA-235b — the Health card’s look lives with the card (lib/production/health), the same on both pages', () => {
  /** The final declarations of each single-class rule of a stylesheet (grouped selectors spread; a later rule wins). */
  const rulesOf = (css: string): Map<string, Map<string, string>> => {
    const out = new Map<string, Map<string, string>>()
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1]!.split(',').map((part) => part.trim())
      const declarations = match[2]!.split(';').map((part) => part.trim()).filter(Boolean).map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()] as const)
      for (const selector of selectors) {
        if (!/^\.[a-z0-9-]+$/.test(selector)) continue
        const known = out.get(selector) ?? new Map<string, string>()
        for (const [name, value] of declarations) known.set(name, value)
        out.set(selector, known)
      }
    }
    return out
  }
  const card = readFileSync(new URL('../../../../lib/production/health/view/HealthCard.tsx', import.meta.url), 'utf8')
  const own = rulesOf(readFileSync(new URL('../../../../lib/production/health/view/health-card.css', import.meta.url), 'utf8'))
  const area = rulesOf(readFileSync(new URL('../../../production/_shared/production.css', import.meta.url), 'utf8'))

  it('the card imports its own stylesheet and uses no class of the production area’s stylesheet', () => {
    expect(card).toContain("import './health-card.css'")
    expect(card).not.toMatch(/className="fw-pr-/)
  })

  it('each of its classes has exactly the declarations the production area’s rule had (the work order page looks as before)', () => {
    const pairs: [string, string][] = [
      ['.fw-phc-card', '.fw-pr-card'],
      ['.fw-phc-head', '.fw-pr-card-head'],
      ['.fw-phc-h2', '.fw-pr-h2'],
      ['.fw-phc-stack', '.fw-pr-stack'],
      ['.fw-phc-dialog', '.fw-pr-dialog'],
      ['.fw-phc-hint', '.fw-pr-hint'],
      ['.fw-phc-inline', '.fw-pr-inline'],
      ['.fw-phc-actions', '.fw-pr-actions'],
    ]
    for (const [mine, theirs] of pairs) {
      expect(own.get(mine), mine).toBeDefined()
      expect(Object.fromEntries(own.get(mine)!), mine).toEqual(Object.fromEntries(area.get(theirs)!))
    }
    // Semantic tokens only: no raw colour of its own.
    const css = readFileSync(new URL('../../../../lib/production/health/view/health-card.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
  })

  it('the work order’s Health card draws with its own classes (and the office note keeps the shared parts’ look)', () => {
    const html = renderView(workOrderScreen.view as ComponentType<{ model: unknown }>, workOrderScreen.cases.find((item) => item.id === 'health-raised')!.model, 'en')
    expect(html).toContain('fw-phc-card')
    expect(html).toContain('class="fw-phc-head"')
    expect(html).toContain('class="fw-prp-office-note"')
  })
})
// ---- end F-SA-235b

// ---- F-OP-112 (10-order-page §5.1): Make work orders… in place — the Production page's own hook, the order fixed ---------------
describe('F-OP-112: Make work orders… in place — the style step, the next style, held in words', () => {
  type Open = import('../../../production/_shared/api').OpenLines
  const line = (id: string, seq: number, style: { id: string; code: string }, open: number[], over: Partial<Open['lines'][number]> = {}): Open['lines'][number] => ({
    id,
    seq,
    kind: 'SIZE_GRID',
    styleId: style.id,
    styleCode: style.code,
    styleName: `${style.code} name`,
    colourwayId: `${id}-c`,
    colourwayCode: `C${seq}`,
    madeToMeasure: false,
    sizes: open.map((n, index) => ({ size: String(48 + index * 2), ordered: n + 1, onWorkOrders: 1, open: n })),
    ...over,
  })
  const JKT = { id: 's-jkt', code: 'DEMO-JKT-01' }
  const PNT = { id: 's-pnt', code: 'DEMO-PNT-02' }
  const GLV = { id: 's-glv', code: 'DEMO-GLV-03' }
  const lines: Open = {
    salesOrder: { id: 'so1', number: 'SO-2026-0088', status: 'CONFIRMED' },
    numberPreview: 'WO-0412',
    lines: [line('l1', 10, JKT, [2, 0, 3]), line('l2', 20, JKT, [0, 0, 0]), line('l3', 30, JKT, [1], { madeToMeasure: true }), line('l4', 40, PNT, [4, 4]), line('l5', 50, GLV, [0])],
  }

  it('the style step: the style asked while it has open pieces, else the first open one; its open lines picked with every open size', async () => {
    const { styleStepOf, pickOfStyle } = await import('../../../production/work-orders/new/use-new-work-order')
    expect(styleStepOf(lines, null)).toEqual({ styleId: JKT.id, picked: ['l1'], grid: { l1: { '48': 2, '52': 3 } } })
    expect(styleStepOf(lines, PNT.id)).toEqual({ styleId: PNT.id, picked: ['l4'], grid: { l4: { '48': 4, '50': 4 } } })
    // A style with nothing open (or another order's style) is never the step: the first open one is.
    expect(styleStepOf(lines, GLV.id).styleId).toBe(JKT.id)
    expect(styleStepOf(lines, 'not-a-style').styleId).toBe(JKT.id)
    expect(styleStepOf({ ...lines, lines: [line('l5', 50, GLV, [0])] }, null)).toEqual({ styleId: null, picked: [], grid: {} })
    // A made-to-measure unit is never ticked by the step (it is made alone, ticked by hand).
    expect(pickOfStyle(lines, JKT.id).picked).not.toContain('l3')
  })

  it('the next style after a draft: the next with open pieces in line order (then from the start); none left: null', async () => {
    const { nextStyleOf } = await import('../../../production/work-orders/new/use-new-work-order')
    expect(nextStyleOf(lines, JKT.id)).toEqual({ styleId: PNT.id, code: 'DEMO-PNT-02' })
    expect(nextStyleOf(lines, PNT.id)).toEqual({ styleId: JKT.id, code: 'DEMO-JKT-01' })
    expect(nextStyleOf({ ...lines, lines: lines.lines.filter((entry) => entry.styleId === JKT.id) }, JKT.id)).toBeNull()
    expect(nextStyleOf(null, JKT.id)).toBeNull()
  })

  it('held in words, never hidden: no right to make work orders, a confirmed order\'s deposit waiting or missing; in production only the right', async () => {
    const { makeHeldOf } = await import('./production')
    const { canOf, order, PAID } = await import('../_demo/fixtures')
    expect(makeHeldOf(order('CONFIRMED'), canOf('sales'))).toEqual({ key: 'held.noWorkOrders' })
    expect(makeHeldOf(order('CONFIRMED'), canOf('owner'))).toEqual({ key: 'held.deposit', params: { date: '2026-11-04' } })
    expect(makeHeldOf(order('CONFIRMED', { chain: { ...order().chain, depositRequests: [] } }), canOf('owner'))).toEqual({ key: 'held.depositMissing' })
    expect(makeHeldOf(order('CONFIRMED', { chain: { ...order().chain, depositRequests: [PAID] } }), canOf('manager'))).toBeNull()
    expect(makeHeldOf(order('IN_PRODUCTION'), canOf('manager'))).toBeNull()
    expect(makeHeldOf(order('IN_PRODUCTION'), canOf('sales'))).toEqual({ key: 'held.noWorkOrders' })
  })

  it('the order as the dialog\'s one choice: its number, customer, PO, state and pieces', async () => {
    const { orderOptionOf } = await import('./production')
    const { order } = await import('../_demo/fixtures')
    expect(orderOptionOf(order('CONFIRMED'))).toEqual({ id: order().id, number: 'SO-2026-0088', partyName: 'Moto Demo S.r.l.', customerRef: 'PO-ESEMPIO-88', status: 'CONFIRMED', units: 14 })
  })

  it('ONE hook: the Production page moved onto it (no copy), the order page mounts it in its production acts; Create stays on the order', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const page = read('../../../production/work-orders/WorkOrdersPage.tsx')
    expect(page).toContain("import { useNewWorkOrder } from './new/use-new-work-order'")
    expect(page).toContain('onMade: (created) => router.push(`${prefix}/production/work-orders/${created.id}`)')
    for (const gone of ['createWorkOrder(', 'getOpenLines(', 'findOrders(', 'setNewOrder(']) expect(page, gone).not.toContain(gone)
    expect(page).toContain("autoPick: newAsked ? (params?.get('order')?.trim() || null) : null,")
    const hook = read('../../../production/work-orders/new/use-new-work-order.ts')
    expect(hook).toContain('setModel({ ...NO_NEW_ORDER, fixed: true, query: start.order.number, orders: [start.order] })')
    expect(hook).toContain('if (model && !model.fixed && model.orders === null')
    const acts = read('./use-production-acts.ts')
    expect(acts).toContain('const make = useNewWorkOrder(api, {')
    expect(acts).toContain("setNotice({ tone: 'success', words: { key: 'wo.made', params: { number: made.number } } })")
    expect(acts).toContain('setNext(nextStyleOf(asked.lines, asked.styleId))')
    const tab = read('./view/ProductionTab.tsx')
    expect(tab).not.toContain('?new=1&order=')
    // F-OP-102: the dialog is mounted once for the page (the band's primary opens it from any tab).
    expect(tab).not.toContain('<NewWorkOrderDialog')
    expect(read('./view/OrderRecordView.tsx')).toContain('<NewWorkOrderDialog model={model.makeWorkOrders.dialog} can={model.makeWorkOrders.can} actions={actions?.makeWorkOrders?.dialog} />')
    expect(tab).toContain("t('wo.makeNext', { style: make.next.code })")
    expect(tab).not.toMatch(/from '[^']*use-new-work-order'/)
    const dialog = read('../../../production/work-orders/view/NewWorkOrderDialog.tsx')
    expect(dialog).toContain('{!model.fixed && (')
  })

  it('the words in it + en (catalogue words: "ordine di lavoro" is masculine)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('wo.makeNext', { style: 'DEMO-PNT-02' })).toContain('DEMO-PNT-02')
      expect(t('wo.made', { number: 'WO-0412' })).toContain('WO-0412')
    }
    const it_ = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it_('wo.made', { number: 'WO-0412' })).toBe('WO-0412 creato (bozza)')
    expect(it_('wo.makeNext', { style: 'DEMO-PNT-02' })).toBe('Crea il prossimo: DEMO-PNT-02')
  })
})
// ---- end F-OP-112

// ---- F-OP-113 (10-order-page §5.2; review R-11, B6): the work-order rows — in place, the row ⋯, a shared row read-only ------------
describe('F-OP-113: the work-order rows act in place; a work order shared with other customers offers nothing but its link', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('a planner: rows by number, Due · Priority · Rush in place on each own work order, the row ⋯; the floor’s told time', () => {
    const html = draw('wo-acts-manager')
    const text = textOf(html)
    // Stable by number, whatever order the read gave (WO-00022 came first).
    expect(text.indexOf('WO-00019')).toBeLessThan(text.indexOf('WO-00021'))
    expect(text.indexOf('WO-00021')).toBeLessThan(text.indexOf('WO-00022'))
    for (const number of ['WO-00021', 'WO-00022']) {
      expect(html, number).toContain(`aria-label="Priority of ${number}"`)
      expect(html, number).toContain(`aria-label="Rush for ${number}"`)
      expect(html, number).toContain(`aria-label="Actions for ${number}"`)
    }
    expect(html).toMatch(/aria-label="Rush for WO-00022"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Rush for WO-00022"/)
    expect(text).toContain('Told the floor at 10:42')
    expect(text).not.toContain('Production does this')
  })

  it('a mixed work order is read-only: its link and the words, no field, no ⋯ (never changed from one customer’s order)', () => {
    const html = draw('wo-acts-manager')
    expect(textOf(html)).toContain('Shared with other customers: change it on its page.')
    expect(html).toContain('WO-00019')
    expect(html).not.toContain('aria-label="Priority of WO-00019"')
    expect(html).not.toContain('aria-label="Rush for WO-00019"')
    expect(html).not.toContain('aria-label="Due date of WO-00019"')
    expect(html).not.toContain('aria-label="Actions for WO-00019"')
    expect(textOf(draw('wo-acts-manager', 'it'))).toContain('Condiviso con altri clienti: cambialo dalla sua pagina.')
  })

  it('Sales: the rows as they are, every act held in words — "Production does this — …" (never hidden, never a dead field)', () => {
    const html = draw('wo-acts-sales')
    const text = textOf(html)
    expect(text).toContain('Production does this — a planner or the production manager.')
    expect(html).not.toContain('aria-label="Priority of WO-00021"')
    expect(html).not.toContain('aria-label="Rush for WO-00021"')
    // The ⋯ stays (its acts held with the same words inside): the reader learns who does it.
    expect(html).toContain('aria-label="Actions for WO-00021"')
    expect(textOf(draw('wo-acts-sales', 'it'))).toContain('lo fa la produzione — un pianificatore o il responsabile di produzione')
  })

  it('a saving cell is marked, a refused write is said on its row in words (never the API’s English)', () => {
    const html = draw('wo-acts-saving')
    expect(html).toContain('data-state="saving"')
    expect(textOf(html)).toContain('Someone changed this work order meanwhile')
  })

  it('without the acts (no work orders right, an older read): the card stays as today — no ⋯ column, no field', () => {
    const html = draw('production-progress')
    expect(html).not.toContain('aria-label="Actions for')
    expect(html).not.toContain('aria-label="Priority of')
  })

  it('N-5: the hook is mounted by the container; the view draws the lib’s dialogs and imports no fetching hook', () => {
    const acts = source('./use-production-acts.ts')
    expect(acts).toContain('useWorkOrderActs(api, permissions,')
    const tab = source('./view/ProductionTab.tsx')
    expect(tab).not.toMatch(/from '[^']*use-work-order-acts'/)
    expect(tab).toContain('<WorkOrderActsDialogs model={model.workOrderActs} actions={actions?.workOrderActs} />')
    expect(source('./OrderRecord.tsx')).toContain("rereadWork: () => production.again(['work', 'headline', 'changes'])")
    // Every write sends the version: the row's (B6) or the newer one a write answered.
    const hook = source('../../../../lib/production/work-order-acts/use-work-order-acts.ts')
    expect(hook).toContain('updateWorkOrder(api, row.id, { version: versionOf(row, known.current), ...body })')
    expect(hook).toContain('updateWorkOrder(api, workOrder.id, { version: workOrder.version, note:')
  })

  it('the words in it + en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['wo.col.priority', 'wo.col.acts', 'wo.priorityHint', 'wo.heldHold', 'wo.heldHint', 'wo.act.note', 'wo.note.title', 'wo.note.label', 'wo.note.hint', 'wo.note.save', 'wo.note.saved', 'wo.reading', 'wo.readingShort', 'wo.readFailed', 'wo.acts', 'wo.dueOf', 'wo.priorityOf', 'wo.rushOf'])
        expect(t(key, { number: 'WO-00021' }), `${locale} ${key}`).not.toMatch(/^wo\.|\{/)
    }
  })
})
// ---- end F-OP-113

// ---- F-OP-115 (10-order-page §5.2; review R-16): the rest of the row — Split, Cancel, Close · Reopen; the links -------------------

describe('F-OP-115: Split…, Cancel…, Close… · Reopen…, Open in Planning › and Open the work order on a work-order row', () => {
  const planner = actsCanOf(['workorders.view', 'workorders.manage', 'workorders.release', 'workorders.hold', 'planning.view'])
  const manager = actsCanOf(['workorders.view', 'workorders.manage', 'workorders.reopen'])
  const rights = { manage: true, release: true, hold: true, why: null }
  const row = (over: Partial<ActsRow> = {}): ActsRow => ({ id: 'wo-1', number: 'WO-00021', status: 'RELEASED', held: false, rush: false, due: null, sharedWithOtherCustomers: false, version: 3, priority: 0, rights, ...over })
  const acts = (offer: ReturnType<typeof rowActsOf>) => offer.menu.map((entry) => entry.act)

  it('a draft splits and cancels; a released or started one cancels; a held one does not (lift it first); completed closes; closed reopens', () => {
    expect(acts(rowActsOf(row({ status: 'DRAFT' }), planner))).toEqual(['note', 'hold', 'release', 'split', 'cancel'])
    expect(acts(rowActsOf(row({ status: 'IN_PROGRESS' }), planner))).toEqual(['note', 'hold', 'cancel'])
    expect(acts(rowActsOf(row({ status: 'ON_HOLD', held: true }), planner))).toEqual(['note', 'lift'])
    expect(acts(rowActsOf(row({ status: 'COMPLETED' }), planner))).toEqual(['note', 'close'])
    expect(acts(rowActsOf(row({ status: 'CLOSED' }), manager))).toEqual(['note', 'reopen'])
    expect(rowActsOf(row({ status: 'CLOSED' }), manager).menu.find((entry) => entry.act === 'reopen')!.held).toBeNull()
    // Only the production manager reopens: a planner reads who does it.
    expect(rowActsOf(row({ status: 'CLOSED' }), planner).menu.find((entry) => entry.act === 'reopen')!.held).toEqual({ key: 'wo.heldReopen' })
  })

  it('the links: Open in Planning › (planning.view, an open work order) and Open the work order; a shared row has none; Dispatch never', () => {
    expect(rowActsOf(row(), planner).links).toEqual(['planning', 'open'])
    expect(rowActsOf(row(), manager).links).toEqual(['open'])
    expect(rowActsOf(row({ status: 'CLOSED' }), planner).links).toEqual(['open'])
    expect(rowActsOf(row({ sharedWithOtherCustomers: true, rights: { manage: false, release: false, hold: false, why: { en: 'x', it: 'x' } } }), planner).links ?? []).toEqual([])
    expect(planningHref('/w/demo', 'wo-1')).toBe('/w/demo/planning/board?wo=wo-1')
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).not.toMatch(/dispatch/i)
  })

  it('unit: with cut pieces Cancel… holds with the API’s own words (no picker); nothing cut asks the reason', () => {
    const refusal = { en: '8 pieces are cut: lower the work order to the cut instead', it: "8 pezzi sono già tagliati: riduci l'ordine di lavoro al tagliato" }
    expect(cancelHeld({ cancellable: false, refusal }, 'whatever', false, 'en')).toBe(refusal.en)
    expect(cancelHeld({ cancellable: false, refusal }, '', false, 'it')).toBe(refusal.it)
    expect(cancelHeld({ cancellable: false, refusal: null }, 'why', false, 'en')).toEqual({ key: 'wo.cancel.notNow' })
    expect(cancelHeld({ cancellable: true, refusal: null }, '  ', false, 'en')).toEqual({ key: 'production:cancel.reasonNeeded' })
    expect(cancelHeld({ cancellable: true, refusal: null }, 'Il cliente ha chiuso la stagione.', false, 'en')).toBeNull()
    expect(cancelHeld(null, 'why', false, 'en')).toEqual({ key: 'production:held.checking' })
    // The dialog draws no outcome to pick (R-16): the refusal is a Banner, the reason field only when nothing is cut.
    const dialogs = readFileSync(new URL('../../../../lib/production/work-order-acts/view/WorkOrderActsDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('check.refusal ? (')
    // op-fx1: the code, not its notes (they say "no outcome picker" in words).
    expect(codeOf(dialogs)).not.toMatch(/RadioCard|outcome/)
  })

  it('Split… and Close… · Reopen… are the production lane’s own (useSplit + SplitDialog, useClose + CloseParts — never a copy)', () => {
    const hook = readFileSync(new URL('../../../../lib/production/work-order-acts/use-work-order-acts.ts', import.meta.url), 'utf8')
    expect(hook).toContain("from '../../../areas/production/work-orders/every-shift/use-split'")
    expect(hook).toContain("from '../../../areas/production/work-orders/close/use-close'")
    expect(hook).toContain('cancelWorkOrder(api, workOrder.id, workOrder.version, reason.trim())')
    const dialogs = readFileSync(new URL('../../../../lib/production/work-order-acts/view/WorkOrderActsDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('<SplitDialog workOrder={dialog.workOrder.value} model={model.split} actions={actions?.split} />')
    expect(dialogs).toContain('<CloseParts workOrder={dialog.workOrder.value} model={model.close} actions={actions?.close} />')
  })

  it('the gate’s Money door is a tab link (F-OP-210: the dock’s scope kept), no plain ?tab= link', () => {
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(codeOf(tab)).not.toContain('?tab=money') // op-fx1: the code, not the note that says what it was
    expect(tab).toContain("<TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'money', search)}>{t('gate.money')}</TabLink>")
  })

  it('the words in it + en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['wo.act.split', 'wo.act.cancel', 'wo.act.close', 'wo.act.reopen', 'wo.act.hold', 'wo.act.lift', 'wo.act.release', 'wo.link.planning', 'wo.link.open', 'wo.heldReopen', 'wo.cancel.check', 'wo.cancel.notNow', 'wo.cancel.issued', 'wo.cancel.atWorkshop', 'wo.notice.cancelled', 'wo.notice.split', 'wo.notice.closed', 'wo.notice.reopened', 'wo.notice.held', 'wo.notice.lifted', 'wo.notice.released', 'wo.release.credit', 'wo.release.gate'])
        expect(t(key, { number: 'WO-00021', child: 'WO-00030', items: 'x', numbers: 'SC-1', count: 2 }), `${locale} ${key}`).not.toMatch(/^wo\.|\{/)
      expect(t('wo.checksOpen', { count: 2 })).toMatch(/2/)
      expect(t('wo.release.refused', { count: 1 })).toMatch(/1/)
    }
  })
})
// ---- end F-OP-115

// ---- F-OP-115 (A11's Overview doors, #1716): the Production tab answers every address the Overview links to ---------------------
describe('the Overview’s doors land on Production: #work-orders, #holds, #line-<lineId> (and #dates)', () => {
  it('each anchor is on the page, with room above it when it comes into view', () => {
    const html = draw('production-progress')
    for (const id of ['work-orders', 'holds', 'dates', `line-${LINE_BLK}`, `line-${LINE_RED}`]) expect(html, id).toMatch(new RegExp(`id="${id}"`))
    expect(html).toMatch(/class="[^"]*fw-so-anchor[^"]*" id="work-orders"|id="work-orders"[^>]*class="[^"]*fw-so-anchor/)
  })

  it('the sources: the Overview links to exactly these, and ProductionTab carries them', () => {
    const overview = readFileSync(new URL('./view/OverviewTab.tsx', import.meta.url), 'utf8')
    expect(overview).toContain('#work-orders`')
    expect(overview).toContain('#line-${row.lineIds[0] ?? row.id}')
    const doors = readFileSync(new URL('./overview/model.ts', import.meta.url), 'utf8')
    expect(doors).toContain("anchor: HOLD_KINDS.has(blocker.kind) ? 'holds' : null")
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('<Card padded id="work-orders" className="fw-so-anchor">')
    expect(tab).toContain('<Card padded id="holds" className="fw-so-anchor">')
    expect(tab).toContain('id={`line-${line.id}`}')
  })
})
// ---- end F-OP-115 (A11's anchors)

// ---- F-OP-116 (order page N1; 10-order-page §5.2, §5.3; review R-12, R-17): decide in place -------------------------------------
describe('F-OP-116: decide in place — a change waiting under its row, Still to do doors, the customer\'s pause lifted from the list', () => {
  const change = (over: Record<string, unknown> = {}) =>
    ({
      id: 'c1',
      status: 'PROPOSED',
      kind: 'LOWER_TO_ORDER',
      partyId: 'p1',
      salesOrder: { id: 'o1', number: 'SO-DEMO-0150' },
      workOrder: { id: 'wo-1', number: 'WO-DEMO-0311', status: 'RELEASED' },
      requestId: null,
      amendmentId: null,
      cells: [
        { salesOrderLineId: 'l1', lineSeq: 10, size: 'M', from: 30, to: 20, workOrderSizeId: 's1' },
        { salesOrderLineId: 'l1', lineSeq: 10, size: 'L', from: 10, to: 8, workOrderSizeId: 's2' },
      ],
      extra: [],
      extraOutcome: null,
      reason: 'x',
      lastError: null,
      proposedBy: null,
      proposedAt: '2026-11-18T09:30:00Z',
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      madeWorkOrder: null,
      version: 2,
      mayDecide: true,
      words: { title: { en: 'x', it: 'x' }, status: { en: 'x', it: 'x' }, cells: 'M 30 → 20' },
      ...over,
    }) as never

  it('a row\'s waiting changes: PROPOSED on that work order only, the oldest first; "Change waits: 40 → 28"; held for who may not decide', async () => {
    const { changeFiguresOf, changeHeldOf, waitingChangesOf } = await import('./changes/model')
    const list = [change({ id: 'c2', proposedAt: '2026-11-19T09:00:00Z' }), change(), change({ id: 'c3', status: 'APPLIED' }), change({ id: 'c4', workOrder: { id: 'wo-2', number: 'WO-2', status: 'RELEASED' } })]
    expect(waitingChangesOf(list, 'wo-1').map((entry: { id: string }) => entry.id)).toEqual(['c1', 'c2'])
    expect(waitingChangesOf(null, 'wo-1')).toEqual([])
    expect(changeFiguresOf(change())).toEqual({ before: 40, after: 28 })
    expect(changeHeldOf(change())).toBeNull()
    expect(changeHeldOf(change({ mayDecide: false }))).toEqual({ key: 'wo.waitsPlanner', params: { at: '2026-11-18T09:30:00Z' } })
  })

  it('Still to do doors in place: the change\'s window, the re-promise\'s Accept / Decline…, the task\'s Done by its own right (R-12), links else', async () => {
    const { stillDoorsOf, stillDoorOf } = await import('./changes/model')
    const place = { prefix: '/w/demo', record: '/w/demo/sales/orders/o1', address: (ref: { type: string; id: string }) => `/x/${ref.type}/${ref.id}`, search: 'tab=overview&thread=all' }
    const row = (kind: string, ref: { type: string; id: string; number: string | null; version?: number | null } | null, mayAct = true) => ({ kind, ref, mayAct })
    expect(stillDoorsOf(row('WORK_ORDER_CHANGE', { type: 'WorkOrderChange', id: 'c1', number: 'WO-1' }), place)).toEqual({ kind: 'change', changeId: 'c1', held: false })
    expect(stillDoorsOf(row('WORK_ORDER_CHANGE', { type: 'WorkOrderChange', id: 'c1', number: 'WO-1' }, false), place)).toEqual({ kind: 'change', changeId: 'c1', held: true })
    expect(stillDoorsOf(row('REPROMISE', { type: 'RePromise', id: 'rp1', number: null }), place)).toEqual({ kind: 'repromise', proposalId: 'rp1', held: false })
    expect(stillDoorsOf(row('WORK_IN_PROGRESS_TASK', { type: 'Task', id: 't1', number: 'WO-1', version: 3 }), place)).toEqual({ kind: 'task', taskId: 't1', version: 3, held: false })
    // R-12: Sales (orders.manage alone) reads it held — the task's own right decides, never the order's.
    expect(stillDoorsOf(row('WORK_IN_PROGRESS_TASK', { type: 'Task', id: 't1', number: 'WO-1', version: 3 }, false), place)).toMatchObject({ kind: 'task', held: true })
    expect(stillDoorsOf(row('EXTRA_PIECES', { type: 'WorkOrder', id: 'wo-1', number: 'WO-1' }), place)).toEqual({ kind: 'link', href: '/w/demo/x/WorkOrder/wo-1', label: 'scrap' })
    expect(stillDoorsOf(row('STYLE_CHANGE', { type: 'ChangeRequest', id: 'cr1', number: 'CR-1' }), place)).toMatchObject({ kind: 'link', label: 'products' })
    expect(stillDoorsOf(row('TELL_WORKSHOP', { type: 'SubcontractOrder', id: 'sc1', number: 'SC-1' }), place)).toMatchObject({ kind: 'link', label: 'subcontracting' })
    expect(stillDoorsOf(row('TELL_WORKSHOP', null), place)).toEqual({ kind: 'none' })
    // The order's own tabs keep the dock's scope (tabHref): no plain ?tab= link.
    expect(stillDoorsOf(row('EXTRA_PIECES', { type: 'SalesOrderAmendment', id: 'a1', number: '2' }, false), place)).toEqual({ kind: 'link', href: '/w/demo/sales/orders/o1?tab=changes&thread=all', label: 'open' })
    expect(stillDoorOf(row('REPROMISE', { type: 'RePromise', id: 'rp1', number: null }), { ...place, search: '' })).toBe('/w/demo/sales/orders/o1?tab=overview')
  })

  it('a refused Done says who does it ("Production does this"); the waiting list\'s pause opens the row\'s own Lift (one copy)', async () => {
    const { taskDoneProblemOf } = await import('./use-production-acts')
    const { ApiError } = await import('../../../../lib/api/errors')
    expect(taskDoneProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'refusal/PRODUCTION_DOES_THIS' }]))).toEqual({ key: 'wo.heldHold' })
    expect(taskDoneProblemOf(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toEqual({ key: 'problem.write.moved' })
    const section = readFileSync(new URL('./view/RequestsSection.tsx', import.meta.url), 'utf8')
    expect(section).toContain("rowActsOf(row, acts.can).menu.find((entry) => entry.act === 'lift')")
    expect(section).toContain("actions?.workOrderActs?.onAct?.(row, 'lift')")
    expect(section).toContain('actions?.orderChanges?.onOpen?.(door.changeId)')
    expect(section).toContain('actions?.links?.onAccept?.(door.proposalId)')
    expect(section).toContain('actions?.onTaskDone?.(door.taskId, door.version)')
  })

  it('the wiring: one read of the order\'s changes, the ONE decide window by the page\'s state (no address word), the dialogs once for the page', () => {
    const acts = readFileSync(new URL('./use-production-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain("listWorkOrderChanges(api, { salesOrderId: orderId, status: 'ALL', limit: 50 })")
    expect(acts).toContain('openId: openChange')
    expect(acts).not.toContain('router')
    const container = readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("if (parts.includes('changes')) productionActs.rereadChanges()")
    const view = readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<WorkOrderActsDialogs model={model.workOrderActs} actions={actions?.workOrderActs} />')
    expect(view).toContain('<WorkOrderChangeReview')
    const tab = readFileSync(new URL('./view/ProductionTab.tsx', import.meta.url), 'utf8')
    expect(tab).not.toContain('<WorkOrderActsDialogs')
    expect(tab).toContain("t('wo.changeWaits', { before: figures.before, after: figures.after })")
  })

  it('the words exist in both languages (office "tu")', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['wo.changeApply', 'wo.changeLeave', 'wo.waitsPlannerShort', 'wo.done', 'wo.taskDone', 'wo.repromiseHeld', 'wo.liftPause', 'wo.go.scrap', 'wo.go.products', 'wo.go.subcontracting', 'wo.go.open', 'links.rePromise.accept', 'links.rePromise.decline']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const [key, params] of [['wo.changeWaits', { before: 40, after: 28 }], ['wo.waitsPlanner', { time: '10:42' }], ['wo.changeApplied', { number: 'WO-1' }], ['wo.changeDeclined', { number: 'WO-1' }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-116
