import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { priceAgainstCost } from './api'
import {
  COST_PARTS,
  costOfOne,
  costSizeOf,
  costTabOpen,
  flagOf,
  howOf,
  KEEP_REFUSALS,
  keepDoneOf,
  keepHeldOf,
  linesOfPart,
  marginBarOf,
  partOf,
  keepsAlone,
  priceAgainstCostOpen,
  refusalOf,
  topLineOf,
  type ComponentLine,
} from './model'
import { CostNowCard, type CostNowModel } from './view/CostNowCard'
import { PriceCard } from './view/PriceCard'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh) — the Cost tab: the 9 categories in 4 parts (MATERIAL + LEATHER → Materials, LABOUR → Work,
 * OVERHEAD → Overhead, the rest → Other costs), "known so far" honest, the top line, the price-against-cost flags and bar, Keep's rules
 * and answers, and no tab without the cost grain. Written, not run (Owner rule). Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['products-cost'] ?? {}
const has = (locale: (typeof LOCALES)[number], key: string) => key in words(locale) || (`${key}_one` in words(locale) && `${key}_other` in words(locale))
const euro = (amount: string) => `€${amount}`

const line = (over: Partial<ComponentLine>): ComponentLine => ({
  seq: null,
  category: 'MATERIAL',
  source: 'BOM_LINE',
  sourceRecordType: null,
  sourceRecordId: null,
  itemId: null,
  workCentreKind: null,
  label: 'Demo lining',
  size: null,
  quantity: '1',
  uom: 'M',
  unitCost: '1',
  cost: '1',
  pct: null,
  note: null,
  ...over,
})

const LINES: ComponentLine[] = [
  line({ category: 'LEATHER', label: 'Demo cowhide', quantity: '8.732', uom: 'FT2', unitCost: '3.2', cost: '27.94', sourceRecordId: 'l1' }),
  line({ category: 'MATERIAL', label: 'Demo lining', cost: '4.5', sourceRecordId: 'l2' }),
  line({ category: 'MATERIAL', label: 'Demo zip', cost: '2.75', sourceRecordId: 'l3' }),
  line({ category: 'MATERIAL', label: 'Demo label', cost: '0.18', sourceRecordId: 'l4' }),
  line({ category: 'MATERIAL', label: 'Demo protector size 58', size: '58', cost: '9', sourceRecordId: 'l5' }),
  line({ category: 'LABOUR', source: 'ROUTING', workCentreKind: 'SEWING', label: null, quantity: '64', uom: null, unitCost: '0.6875', cost: '44', sourceRecordId: 'r1' }),
  line({ category: 'LABOUR', source: 'ROUTING', workCentreKind: 'CUTTING', label: null, quantity: '12.5', uom: null, unitCost: '0.62', cost: '7.75', sourceRecordId: 'r2' }),
  line({ category: 'OVERHEAD', source: 'COSTING_SETTINGS', label: null, quantity: '1', uom: null, unitCost: '10.36', cost: '10.36', pct: '12', sourceRecordId: 'o1' }),
  line({ category: 'FREIGHT', source: 'UPLIFT', label: 'Freight on the material', uom: null, cost: '1.2', sourceRecordId: 'f1' }),
  line({ category: 'COMMISSION', source: 'TYPED', label: 'Agent', uom: null, cost: '3', sourceRecordId: 'c1' }),
]

const SPLIT = [
  {
    size: '52',
    categories: [
      { category: 'LEATHER' as const, amount: '27.94' },
      { category: 'MATERIAL' as const, amount: '7.43' },
      { category: 'LABOUR' as const, amount: '51.75' },
      { category: 'OVERHEAD' as const, amount: '10.36' },
      { category: 'FREIGHT' as const, amount: '1.2' },
      { category: 'COMMISSION' as const, amount: '3' },
    ],
    knownTotal: '101.68',
    total: '101.68',
    complete: true,
  },
  { size: '58', categories: [{ category: 'LEATHER' as const, amount: '30' }, { category: 'LABOUR' as const, amount: '51.75' }], knownTotal: '81.75', total: null, complete: false },
]

describe('the 9 categories in 4 parts', () => {
  it('MATERIAL + LEATHER → Materials · LABOUR → Work · OVERHEAD → Overhead · the rest → Other costs (a new one too)', () => {
    expect(['MATERIAL', 'LEATHER', 'LABOUR', 'OVERHEAD', 'SUBCONTRACT', 'FREIGHT', 'DUTY', 'PACKAGING', 'COMMISSION', 'LATER'].map(partOf)).toEqual(['materials', 'materials', 'work', 'overhead', 'other', 'other', 'other', 'other', 'other', 'other'])
    expect(partOf('toString')).toBe('other')
  })

  it('the cost of one piece: each part summed, its share of what is known, the total when complete', () => {
    const cost = costOfOne({ split: SPLIT }, '52')!
    expect(cost.parts.map((part) => [part.part, part.amount, part.share])).toEqual([
      ['materials', '35.37', 35],
      ['work', '51.75', 51],
      ['overhead', '10.36', 10],
      ['other', '4.20', 4],
    ])
    expect(cost).toMatchObject({ knownTotal: '101.68', total: '101.68', complete: true })
    expect(cost.parts.map((part) => part.part)).toEqual([...COST_PARTS])
  })

  it('"known so far" stays honest: a size missing an input has no total, only what is known', () => {
    expect(costOfOne({ split: SPLIT }, '58')).toMatchObject({ knownTotal: '81.75', total: null, complete: false })
    expect(costOfOne({ split: SPLIT }, '99')).toBeNull()
    // Without the cost grain the server drops the figures: nothing to draw.
    expect(costOfOne({ split: [{ ...SPLIT[0]!, knownTotal: undefined as unknown as string }] }, '52')).toBeNull()
  })

  it('the size shown: the asked one when costed, else the base size, else the first', () => {
    expect(costSizeOf({ sizes: ['52', '58'] }, '58', '52')).toBe('58')
    expect(costSizeOf({ sizes: ['52', '58'] }, '60', '52')).toBe('52')
    expect(costSizeOf({ sizes: ['52', '58'] }, null, null)).toBe('52')
    expect(costSizeOf({ sizes: [] }, null, null)).toBeNull()
  })

  it('a part\'s lines in a size, the biggest first; how each part is worked out', () => {
    expect(linesOfPart({ lines: LINES }, '52', 'materials').map((entry) => entry.label)).toEqual(['Demo cowhide', 'Demo lining', 'Demo zip', 'Demo label'])
    expect(linesOfPart({ lines: LINES }, '58', 'materials')).toHaveLength(5)
    expect(howOf({ lines: LINES }, '52', 'materials')).toEqual({ key: 'now.how.materials', params: { count: 4 } })
    expect(howOf({ lines: LINES }, '52', 'work')).toEqual({ key: 'now.how.work', params: { minutes: 76.5 } })
    expect(howOf({ lines: LINES }, '52', 'overhead')).toEqual({ key: 'now.how.overheadPct', params: { pct: 12 } })
    expect(howOf({ lines: LINES }, '52', 'other')).toEqual({ key: 'now.how.other', params: { count: 2 } })
    expect(howOf({ lines: [] }, '52', 'other')).toEqual({ key: 'now.how.otherNone' })
  })
})

describe('no tab without the cost grain', () => {
  it('costing.view AND money.cost; either alone opens nothing', () => {
    expect(costTabOpen({ costView: true }, { cost: true })).toBe(true)
    expect(costTabOpen({ costView: true }, { cost: false })).toBe(false)
    expect(costTabOpen({ costView: false }, { cost: true })).toBe(false)
  })

  it('owb-pd8b: Keep keeps it alone only with the company\'s own switch AND the right to approve cost sheets', () => {
    expect(keepsAlone(true, (permission) => permission === 'costing.sheets.approve')).toBe(true)
    expect(keepsAlone(true, () => false)).toBe(false)
    expect(keepsAlone(false, () => true)).toBe(false)
    expect(readFileSync(join(HERE, '../page/CostPage.tsx'), 'utf8')).toContain('setAlone(keepsAlone(settingsInForce(settings).oneKeeper, can))')
  })

  it('owb-pd8b: price against cost only with the price, the cost AND the margin grain; without one the page does not ask and says why', () => {
    expect(priceAgainstCostOpen({ price: true, cost: true, margin: true })).toBe(true)
    expect(priceAgainstCostOpen({ price: true, cost: true, margin: false })).toBe(false)
    expect(priceAgainstCostOpen({ price: false, cost: true, margin: true })).toBe(false)
    const page = readFileSync(join(HERE, '../page/CostPage.tsx'), 'utf8')
    expect(page).toContain('const pricesOpen = priceAgainstCostOpen(model.grains)')
    expect(page).toContain("if (!revisionId || !pricesOpen) return")
    expect(page).toContain("const price: Read<PriceAgainstCost> = pricesOpen ? priceRead : { status: 'failed', problem: 'problem.forbidden' }")
    expect(page).toContain("!pricesOpen ? { key: 'keep.held.noGrains' }")
    expect(textOf(render(createElement(PriceCard, { model: { state: 'failed', problem: 'problem.forbidden', targetPct: '35', rows: [], lowest: null, money: (amount) => amount ?? '' }, onRetry: () => undefined })))).toContain('the margin right')
  })

  it('the tab mounts the new page only with the grain; the record\'s cost-sheets slot draws nothing then (read once)', () => {
    const tab = readFileSync(join(HERE, '../view/CostTab.tsx'), 'utf8')
    expect(tab).toContain('if (!costTabOpen(model.can, model.grains)) return sheet')
    expect(tab).toContain('<CostPage style={style} model={model} actions={actions} detail={sheet} fallback={sheet} />')
    expect(readFileSync(join(HERE, '../versions/CostSheets.tsx'), 'utf8')).toContain('if (costTabOpen(abilitiesOf(session.permissions), grainsOf(session.permissions))) return null')
  })
})

describe('the top line', () => {
  const rows = [{ flag: 'OK' as const }, { flag: 'UNDER_TARGET' as const }, { flag: 'UNDER_COST' as const }]
  it('standard cost · cost now and the difference · how many agreed prices are under the target', () => {
    expect(topLineOf({ kept: { amount: '190', version: 1, keptAt: '2026-11-01T09:00:00Z' }, costNow: '185.6', rows, targetPct: '35' }, euro)).toEqual([
      { key: 'top.kept', params: { amount: '€190', version: 1 } },
      { key: 'top.nowLower', params: { amount: '€185.6', diff: '€4.40' } },
      { key: 'top.under', params: { count: 2, total: 3, target: 35 } },
    ])
  })
  it('no kept version: the rough standard of its kind; every price keeps the target; nothing to compare', () => {
    expect(topLineOf({ kept: null, costNow: '185.6', rows: [{ flag: 'OK' }], targetPct: '35' }, euro)).toEqual([{ key: 'top.rough' }, { key: 'top.now', params: { amount: '€185.6' } }, { key: 'top.allKeep', params: { count: 1, target: 35 } }])
    expect(topLineOf({ kept: null, costNow: null, rows: [], targetPct: '35' }, euro).map((entry) => entry.key)).toEqual(['top.rough', 'top.nowUnknown', 'top.noPrices'])
  })
  it('what could not be read is left out, never guessed', () => {
    expect(topLineOf({ kept: undefined, costNow: '101.68', rows: null, targetPct: '0' }, euro)).toEqual([{ key: 'top.now', params: { amount: '€101.68' } }])
  })
})

describe('price against cost', () => {
  it('the flags in words and tone; the bar\'s fill and the target mark', () => {
    expect(flagOf('UNDER_COST')).toEqual({ key: 'price.flag.UNDER_COST', tone: 'danger' })
    expect(flagOf('UNDER_TARGET').tone).toBe('warning')
    expect(flagOf(null).key).toBe('price.flag.none')
    expect(marginBarOf('41.5', '35')).toEqual({ fill: 41.5, mark: 35 })
    expect(marginBarOf('-12', '35').fill).toBe(0)
    expect(marginBarOf(null, '35').fill).toBe(0)
  })

  it('the pd3 answer is read with this web\'s zod; the card says the margin is a share of the PRICE', () => {
    const answer = priceAgainstCost.parse({
      currency: 'EUR',
      targetPct: '35',
      costNow: '185.60',
      kept: { amount: '190.00', version: 1, keptAt: '2026-11-01T09:00:00Z' },
      rows: [
        { customer: { id: 'p1', code: 'ALPHA', name: 'Brand Alpha' }, material: 'Cowhide', minQty: 50, price: '320.00', cost: '190.00', earned: '130.00', marginPct: '40.6', flag: 'OK' },
        { customer: { id: 'p2', code: 'BETA', name: 'Brand Beta' }, material: null, minQty: 1, price: '250.00', cost: '190.00', earned: '60.00', marginPct: '24.0', flag: 'UNDER_TARGET' },
      ],
      lowestPriceForTarget: '292.31',
      extra: 'a field this web does not know',
    })
    const html = render(createElement(PriceCard, { model: { state: 'ready', problem: null, targetPct: answer.targetPct, rows: answer.rows, lowest: answer.lowestPriceForTarget, money: euro }, onRetry: () => undefined }))
    const text = textOf(html)
    for (const part of ['Price against cost', 'Brand Alpha', 'from 50 pieces', 'keeps the target', 'under the target', 'The lowest price that keeps 35 %: €292.31.', 'The margin is a share of the PRICE']) expect(text, part).toContain(part)
    expect(html.match(/class="fw-ct-mbar"/g)?.length).toBe(2)
  })

  it('without the price or the cost grain the server refuses: the card says so plainly, no Try again', () => {
    const text = textOf(render(createElement(PriceCard, { model: { state: 'failed', problem: 'problem.forbidden', targetPct: '35', rows: [], lowest: null, money: euro }, onRetry: () => undefined })))
    expect(text).toContain('Prices against costs need the price, the cost and the margin right')
    expect(text).not.toContain('Try again')
  })
})

describe('Keep', () => {
  const kept = { amount: '190', version: 1, keptAt: '2026-11-01T09:00:00Z' }
  it('held: a write running, no cost now, the same as kept, no reason; else it keeps', () => {
    expect(keepHeldOf({ costNow: '185.6', kept, reason: 'leather went up', busy: true })).toEqual({ key: 'keep.held.busy' })
    expect(keepHeldOf({ costNow: null, kept, reason: 'x', busy: false })).toEqual({ key: 'keep.held.unknown' })
    expect(keepHeldOf({ costNow: '190.00', kept, reason: 'x', busy: false })).toEqual({ key: 'keep.held.same' })
    expect(keepHeldOf({ costNow: '185.6', kept, reason: '  ', busy: false })).toEqual({ key: 'keep.held.reason' })
    expect(keepHeldOf({ costNow: '185.6', kept: null, reason: 'first cost', busy: false })).toBeNull()
  })
  it('the answer: kept (version n) or sent for approval to Finance', () => {
    expect(keepDoneOf({ mode: 'KEPT', kept: { amount: '185.60', version: 2, keptAt: 'x' } }, euro)).toEqual({ key: 'keep.done.kept', params: { version: 2, amount: '€185.60' } })
    expect(keepDoneOf({ mode: 'SENT_FOR_APPROVAL', kept: null }, euro)).toEqual({ key: 'keep.done.sent' })
  })
  it('the refusals in words: the same cost, the cost moved, parts missing; else the kind of answer', () => {
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/SAME_AS_KEPT' }] })).toEqual({ key: 'refusal.SAME_AS_KEPT' })
    expect(refusalOf({ kind: 'conflict', code: 'TOTAL_MOVED' })).toEqual({ key: 'refusal.TOTAL_MOVED' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ code: 'MISSING_PARTS' }] })).toEqual({ key: 'refusal.MISSING_PARTS' })
    // owb-pd8b: pd3 as landed — a second Keep the same day; nobody to approve (four eyes).
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/KEPT_TODAY' }] })).toEqual({ key: 'refusal.KEPT_TODAY' })
    expect(refusalOf({ kind: 'conflict', code: 'conflict', issues: [{ path: 'refusal/NO_APPROVER' }] })).toEqual({ key: 'refusal.NO_APPROVER' })
    expect(refusalOf({ kind: 'forbidden' })).toEqual({ key: 'problem.forbidden' })
  })
})

describe('the card of the cost now draws its model', () => {
  const cost = costOfOne({ split: SPLIT }, '52')!
  const model: CostNowModel = {
    state: 'ready',
    problem: null,
    cost,
    rows: cost.parts.map((part) => ({ part: part.part, amount: part.amount, share: part.share, how: howOf({ lines: LINES }, '52', part.part), lines: [], more: 0 })),
    missing: 0,
    money: (amount) => (amount ? `€${amount}` : '—'),
    keepHeld: null,
  }
  it('ONE bar of the parts with their percent (in words too), the table, the total, Keep as the primary', () => {
    const html = render(createElement(CostNowCard, { model, onKeep: () => undefined, onRetry: () => undefined }))
    const text = textOf(html)
    for (const part of ['Cost of one piece, now', 'Materials', 'Work', 'Overhead', 'Other costs', '76.5 minutes of the route', 'Keep €101.68 as the standard cost…', '€101.68']) expect(text, part).toContain(part)
    expect(html).toContain('role="img" aria-label="The parts of the cost: Materials 35 %, Work 51 %, Overhead 10 %, Other costs 4 %"')
  })
  it('incomplete: "known so far" and how many inputs are missing, never 0', () => {
    const partial = costOfOne({ split: SPLIT }, '58')!
    const text = textOf(render(createElement(CostNowCard, { model: { ...model, cost: partial, missing: 2 }, onKeep: () => undefined, onRetry: () => undefined })))
    expect(text).toContain('known so far €81.75')
    expect(text).toContain('2 inputs missing')
  })
})

describe('words and looks', () => {
  it('products-cost has the same keys in it and en', () => {
    expect(Object.keys(words('it')).sort()).toEqual(Object.keys(words('en')).sort())
  })
  it('every key the Cost tab names exists in both languages', () => {
    const files = ['model.ts', 'view/CostNowCard.tsx', 'view/PriceCard.tsx', 'view/KeepWindow.tsx', '../page/CostPage.tsx', '../page/view/CostPageView.tsx', '../whatif/model.ts', '../whatif/view/WhatIfCard.tsx']
    const sources = files.map((file) => readFileSync(join(HERE, file), 'utf8')).join('\n')
    const keys = [...sources.matchAll(/['"`]((?:top|part|now|price|keep|whatif|more|common|refusal|problem)\.[A-Za-z_.]+[A-Za-z_])['"`]/g)].map((match) => match[1]!)
    const built = [...['materials', 'work', 'overhead', 'other'].map((part) => `part.${part}`), ...['KEEPS', 'UNDER_TARGET', 'UNDER_COST'].map((verdict) => `whatif.verdict.${verdict}`), ...KEEP_REFUSALS.map((code) => `refusal.${code}`)]
    const named = [...new Set([...keys, ...built])]
    expect(named.length).toBeGreaterThan(60)
    for (const locale of LOCALES) expect(named.filter((key) => !has(locale, key)), locale).toEqual([])
  })
  it('layout only, DS tokens only; the room decides (container queries, no media query)', () => {
    const css = readFileSync(join(HERE, 'cost.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).toContain('@container fw-ct (max-width: 560px)')
    expect(css).not.toContain('@media')
  })
})
