import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../../../../lib/i18n/provider'
import { LOCALES } from '../../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../../lib/i18n/messages'
import { actsCanOf, rowActsOf } from '../../../../../../lib/production/work-order-acts/model'
import { abilitiesOf, recordTabs } from '../../../model'
import { ORDER_FLOW_NS } from '../../flow-words'
import { shownActsOf } from '../../production/work'
import { BasketRows, basketStateKeyOf, stepWordsOf } from './FlowProduction'

/**
 * owb-of6 step 1 — the Production tab re-faced (design plan § 5k): sales draws no Move and no hold door; the four parts other sessions
 * fill stay mounted once each in the design's order; the Baskets rows read S5's board ("Step k of n", late) and until then today's
 * work orders (L8); Rush, Print again…, Place the scan code…; the designer has the tab only with "Allow production". Written, not run.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, node))
const SALES = ['orders.view', 'orders.manage', 'workorders.view', 'production.print.start', 'shipping.plan']

describe('owb-of6 step 1: sales draws no Move and no hold door', () => {
  it('a work order row offers sales Hold… held for its right, and the section draws only the doors the reader may use', () => {
    const row = { id: 'wo-1', number: 'WO-0001', status: 'RELEASED', held: false, rush: false, due: null, sharedWithOtherCustomers: false, version: 1, rights: { manage: false, hold: false, release: false, why: null } }
    const offer = rowActsOf(row as unknown as Parameters<typeof rowActsOf>[0], actsCanOf(SALES))
    const shown = shownActsOf(offer)
    expect(shown.acts).not.toContain('hold')
    expect(shown.acts).not.toContain('lift')
    expect(shown.inline).toBe(false)
    expect(read('./WorkOrdersSection.tsx')).toContain('shownActsOf(')
  })
  it('the words are the design\'s: Put on hold… (the reason stays required, L1), Lift the hold…, the section is Baskets', () => {
    expect(CATALOGUE.en.orders?.['wo.act.hold']).toBe('Put on hold…')
    expect(CATALOGUE.en.orders?.['wo.act.lift']).toBe('Lift the hold…')
    expect(CATALOGUE.en.orders?.['productionTab.wo.title']).toBe('Baskets')
  })
})

describe('owb-of6 step 1: the four parts still mounted once each, in the design order', () => {
  it('From the floor after the baskets; Order structure · Team · Route of each line after Materials — once each', () => {
    const tab = read('../ProductionTab.tsx')
    for (const name of ['FromTheFloorPart', 'OrderStructurePart', 'OrderTeamPart', 'RouteOfEachLinePart']) expect(tab.match(new RegExp(`<${name} `, 'g'))?.length, name).toBe(1)
    expect(tab.indexOf('<FromTheFloorPart ')).toBeGreaterThan(tab.indexOf('<WorkOrdersSection '))
    expect(tab.indexOf('<OrderStructurePart ')).toBeGreaterThan(tab.indexOf('<MaterialsSection '))
  })
})

describe('owb-of6 step 1: the Baskets rows (S5\'s board read, L8)', () => {
  const dept = { no: 3, tone: 'pink' as const, icon: 'shirt', name: 'Stitching', shortName: 'Stitching', id: 'dept-3' }
  it('one row per basket: its code, where, its state, "Step k of n", late; the ready ones say Ready to ship', () => {
    const drawn = html(createElement(BasketRows, { baskets: [{ card: { bundleId: 'b-1', code: 'BN-0001', state: 'WORKING', progress: { done: 2, total: 6 }, late: { days: 2 }, worker: null }, dept }, { card: { bundleId: 'b-2', code: 'BN-0002', state: 'READY', progress: null, late: null }, dept: null }] }))
    expect(drawn).toContain('BN-0001')
    expect(drawn).toContain('Step 2 of 6')
    expect(drawn).toContain('Late · 2 days')
    expect(drawn).toContain('Working')
    expect(drawn).toContain('Ready to ship')
    expect(stepWordsOf({ done: 9, total: 6 })).toEqual({ done: 6, total: 6 })
    expect(stepWordsOf(null)).toBeNull()
    expect(basketStateKeyOf('paused')).toBe('baskets.state.PAUSED')
    expect(basketStateKeyOf('SOMETHING')).toBeNull()
  })
  it('the section switches to them only once the read answers; until then today\'s work-order rows', () => {
    const section = read('./WorkOrdersSection.tsx')
    expect(section).toContain('else if (model.flow?.baskets && model.flow.baskets.length > 0) body = <BasketRows baskets={model.flow.baskets} />')
    expect(section.indexOf('<BasketRows')).toBeLessThan(section.indexOf('body = <Rows order={order}'))
  })
})

describe('owb-of6 step 1: Rush, Print again…, Place the scan code…, Restrict; the designer\'s tab', () => {
  it('each door is drawn only for who may: Rush where Set priority… acts, Print again for production.print.start, the code for print.start or the designer', () => {
    expect(read('./NowSection.tsx')).toContain("priorityItem && !priorityItem.disabled && stateNow !== 'after' ? <RushButton")
    expect(read('./WorkOrdersSection.tsx')).toContain('const printAgain = model.can.printStart &&')
    expect(read('./MakeToSection.tsx')).toContain('const mayPlace = (!!model.can.printStart || !!model.can.viewOwn)')
    expect(read('./ProblemsSection.tsx')).toContain('<FloorFact restricted={model.flow.restrict.now}')
  })
  it('the designer (orders.view.own) has no Money and no Shipments tab, and Production only with "Allow production"', () => {
    const designer = abilitiesOf(['orders.view.own', 'files.read', 'threads.read'])
    expect(recordTabs(designer)).toEqual(['overview', 'lines', 'changes', 'files'])
    expect(recordTabs(abilitiesOf(['orders.view.own', 'workorders.view']))).toEqual(['overview', 'lines', 'production', 'changes', 'files'])
    expect(recordTabs(abilitiesOf(SALES))).toEqual(['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files'])
  })
  it('every new word in English and Italian', () => {
    const keys = ['production.rush', 'production.printAgain', 'production.placeCode', 'baskets.label', 'baskets.ready', 'baskets.step', 'baskets.late_one', 'baskets.late_other', 'baskets.byHand', 'baskets.state.WORKING', 'baskets.state.PAUSED', 'baskets.state.WAITING', 'baskets.state.READY']
    for (const locale of LOCALES) for (const key of keys) expect(CATALOGUE[locale][ORDER_FLOW_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
