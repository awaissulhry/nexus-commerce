import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { ReadinessRow } from '../../../../production/work-orders/daily/api'
import { MATERIALS } from '../../depth/demo/fixtures'
import { boughtOf, customerGoodsOf, isThere, materialsAnswerOf } from './materials'

// F-PT-303 (order PRODUCTION tab, W3): Materials — the customer's goods (Arrived, still to come) and what we buy, missing first.

const material = (over: Partial<ReadinessRow['materials'][number]> = {}): ReadinessRow['materials'][number] => ({ itemId: 'i1', itemColourId: null, word: 'RECEIVED', date: null, label: 'Lining mesh 3D · Black', uom: 'm', needed: '120', short: null, neededOn: '2026-11-24', purchaseOrders: [], ...over })
const row = (workOrderId: string, materials: ReadinessRow['materials']): ReadinessRow => ({ workOrderId, word: 'RECEIVED', date: null, open: 0, materials, asOf: '2026-11-20T09:00:00Z' })
const numbers: Record<string, string> = { w1: 'WO-00021', w2: 'WO-00022' }
const numberOf = (id: string) => numbers[id] ?? null

describe('F-PT-303: the customer’s goods', () => {
  it('Arrived, used, left and still to come (never below 0); its lots by code; "more used than received" is gone (B40)', () => {
    const goods = customerGoodsOf(MATERIALS)!
    expect(goods.map((good) => [good.code, good.expected, good.arrived, good.toCome, good.lots])).toEqual([
      ['ETI-DEMO-01', 8, 10, 0, ['LOT-CLI-0012']],
      ['ZIP-DEMO-07', 6, 2, 4, ['LOT-CLI-0013']],
    ])
    expect(goods[1]!.colour).toBe('RED · Rosso')
    expect(Object.keys(goods[0]!)).not.toContain('short')
    expect(customerGoodsOf(null)).toBeNull()
  })
})

describe('F-PT-303: what we buy', () => {
  it('one row per material over the work orders: the worst word, the sums, the work orders by number, each PO once', () => {
    const po = { id: 'po1', number: 'PO-2026-0101', status: 'SENT', dueDate: '2026-11-25' }
    const bought = boughtOf(
      [
        row('w1', [material({ word: 'EXPECTED', date: '2026-11-25', short: '40', purchaseOrders: [po] }), material({ itemId: 'i2', label: 'Thread 40', word: 'RECEIVED' })]),
        row('w2', [material({ word: 'DELAYED', date: '2026-11-28', needed: '80', short: '80', purchaseOrders: [po] })]),
      ],
      numberOf,
    )!
    expect(bought.map((entry) => [entry.label, entry.word, entry.needed, entry.short, entry.workOrders, entry.purchaseOrders.map((p) => p.number)])).toEqual([
      ['Lining mesh 3D · Black', 'DELAYED', 200, 120, ['WO-00021', 'WO-00022'], ['PO-2026-0101']],
      ['Thread 40', 'RECEIVED', 120, null, ['WO-00021'], []],
    ])
    expect(bought[0]!.date).toBe('2026-11-28')
    // F-PT-304: each work order short of it, as Ask the buyers… asks (per work order); a ready material has none.
    expect(bought[0]!.shortages).toEqual([{ workOrderId: 'w2', number: 'WO-00022', word: 'DELAYED', short: '80', neededOn: '2026-11-24' }])
    expect(bought[1]!.shortages).toEqual([])
    expect(bought[0]).toMatchObject({ itemId: 'i1', itemColourId: null })
    expect(bought.map(isThere)).toEqual([false, true])
  })

  it('a shared work order sends no quantities and no POs (null): nothing is summed or named', () => {
    const bought = boughtOf([row('w1', [material({ needed: null, short: null })])], numberOf)!
    expect(bought[0]).toMatchObject({ needed: null, short: null, purchaseOrders: [] })
    expect(boughtOf(null, numberOf)).toBeNull()
  })
})

describe('F-PT-303: the answer line', () => {
  it('missing first: the customer’s still to come and what we buy not there yet count together', () => {
    const goods = customerGoodsOf(MATERIALS)
    expect(materialsAnswerOf(goods, [{ key: 'k', itemId: 'i9', itemColourId: null, shortages: [], label: null, uom: null, word: 'NOT_ENOUGH', date: null, needed: null, short: null, workOrders: [], purchaseOrders: [] }], 2)).toEqual({ kind: 'missing', count: 2 })
    expect(materialsAnswerOf([], [], 2)).toEqual({ kind: 'allHere' })
    expect(materialsAnswerOf([], null, 0)).toEqual({ kind: 'noWork' })
    expect(materialsAnswerOf(null, null, 3)).toEqual({ kind: 'reading' })
  })

  it('the section re-reads on the live materials part, never shows a price, and its words exist in both languages', () => {
    const view = readFileSync(new URL('../view/production/MaterialsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<Section id="materials"')
    expect(view).not.toMatch(/price|cost|amount/i)
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("if (parts.includes('materials')) {")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['title', 'allHere', 'noWork', 'missingTitle', 'waitsCustomer', 'waitsSupplier', 'allArrived', 'customerTitle', 'buyTitle', 'col.material', 'col.arrived', 'col.used', 'col.left', 'col.state', 'nothingFromCustomer', 'askCustomer', 'howTitle', 'howBody', 'infoBody']) expect(t(`productionTab.materials.${key}`), `${locale} ${key}`).not.toBe(`productionTab.materials.${key}`)
      expect(t('productionTab.materials.stillToCome', { quantity: '8 m', arrived: '12', expected: '20 m' }), locale).toMatch(/8 m.*12.*20 m/)
      expect(t('productionTab.materials.missing', { count: 2 }), locale).toMatch(/2/)
    }
  })
})

// ---- fx5 (30-walk.md #3, #12, #14): one row per missing thing, unit words, never an empty heading ----------------------------------------
describe('fx5: Materials as the picture', () => {
  it('#3: one row each — what · how much · when | who it waits on | at most two doors at the right', () => {
    const view = readFileSync(new URL('../view/production/MaterialsSection.tsx', import.meta.url), 'utf8')
    for (const part of ['className="fw-pt-miss"', 'className="fw-pt-miss-what"', 'className="fw-pt-miss-who"', 'className="fw-pt-miss-do"']) expect(view, part).toContain(part)
    expect(view).not.toContain('className="fw-pt-moves"')
    expect(view).toContain('material.purchaseOrders.slice(0, 1)')
    const css = readFileSync(new URL('../view/production/production.css', import.meta.url), 'utf8')
    // fx9 N1: the list holds the columns, every row is its subgrid.
    expect(css).toMatch(/@container sec \(min-width: 640px\) \{[^}]*\.fw-pt-miss \{ display: grid; grid-template-columns:/)
  })

  it('#12, #14: units in the catalogue’s words; read and nothing to buy says so', () => {
    for (const locale of LOCALES) {
      const s = createTranslator(locale, messagesFor(locale, ['stock']).stock!)
      expect(s('uom.PCS'), locale).toBe(locale === 'en' ? 'pcs' : 'pz')
      expect(s('uom.FT2'), locale).toBe('ft²')
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['forWorkOrders', 'buyNothing']) expect(t(`productionTab.materials.${key}`, { numbers: 'N' }), `${locale} ${key}`).not.toMatch(/productionTab\.|\{/)
    }
    const kit = readFileSync(new URL('../../../../../lib/record-sections/Kit.tsx', import.meta.url), 'utf8') // owb-b5 (w5.1): the kit moved to lib
    expect(kit).toContain('export function useUnitWords()')
    const view = readFileSync(new URL('../view/production/MaterialsSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const unit = useUnitWords()')
    expect(view).toContain("t('productionTab.materials.buyNothing')")
  })
})
