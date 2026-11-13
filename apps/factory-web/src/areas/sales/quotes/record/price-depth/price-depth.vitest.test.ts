import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen as floorsScreen } from '../../../settings/floors/fixtures'
import { draftOf as floorDraftOf, floorsBody, floorsChanged, floorsHeld, lowers } from '../../../settings/floors/model'
import { quote } from '../fixtures'
import { LIST_PRICES, PRICING, REASONS, designScreen } from './fixtures'
import { breakOf, costBreakdown, discountOf, lineDiscount, lineFlag, lineHeld, manualOf, netBody, netProblems, optionsOf, PRICE_DEPTH_NS, pricesBySize, pricingRows, reasonLabel, sizeOrder, sizeSurchargesOf, startOf, stepWords } from './model'
import { priceProblem } from './problems'

/**
 * B-W2b-343 — prices on the quote record: what each stored step says (from its kind, reason and figures, never the API's
 * English), the body of a manual change that keeps how the price was reached, what is held and why, the cost of a line
 * from its cost sheet, a refused write in words, the margin floors per role, and every design case drawn in both
 * languages with no key left on screen.
 */

const BLK = PRICING.lines[0]!
const RED = PRICING.lines[1]!

describe('a stored waterfall, step by step', () => {
  it('reads the start, the break, the discount, the manual change, the options and the size surcharges', () => {
    expect(startOf(BLK.steps)?.kind).toBe('LIST')
    expect(breakOf(BLK.steps)?.delta).toBe('-10')
    expect(discountOf(BLK.steps)).toMatchObject({ pct: '2', reasonCode: 'VOLUME' })
    expect(manualOf(BLK.steps)).toMatchObject({ delta: '-0.8', reasonCode: 'COMPETITION' })
    expect(optionsOf(BLK.steps)).toBeNull()
    expect(optionsOf([{ kind: 'OPTION', delta: '12.5' }, { kind: 'OPTION', delta: '-2.25' }])).toBe('10.25')
    expect(sizeSurchargesOf(BLK.steps)).toEqual({ '54': '20' })
    expect(startOf(null)).toBeNull()
    // A typed start (MANUAL without a change) is the start, never the manual change.
    const typed = [{ kind: 'MANUAL' as const, unitPrice: '400', reasonCode: 'LOYALTY' }, { kind: 'NET' as const, unitPrice: '400' }]
    expect(startOf(typed)?.kind).toBe('MANUAL')
    expect(manualOf(typed)).toBeNull()
  })

  it('says each step in this screen\'s words: the list it came from, the break\'s pieces, the reason in the person\'s language', () => {
    const words = stepWords(BLK.steps!, LIST_PRICES.lines[0]!, (code) => reasonLabel(REASONS, code, 'it'))
    expect(words.map((entry) => [entry.kind, entry.name.key, entry.bar, entry.amount])).toEqual([
      ['LIST', 'step.LIST', 'start', 470],
      ['BREAK', 'step.BREAK_FROM', 'step', -10],
      ['DISCOUNT', 'step.DISCOUNT', 'step', -9.2],
      ['MANUAL', 'step.MANUAL', 'step', -0.8],
      ['SIZE_SURCHARGE', 'step.SIZE_SURCHARGE', null, null],
      ['NET', 'step.NET', 'total', 450],
    ])
    expect(words[0]!.note).toEqual({ key: 'step.listOf', params: { code: 'LIST-DEMO', revision: 2 } })
    expect(words[1]!.name.params).toEqual({ count: 10 })
    expect(words[1]!.note).toEqual({ key: 'step.breakPieces', params: { count: 14 } })
    expect(words[2]!.note).toEqual({ key: 'step.reason', params: { reason: 'Volume' } })
    expect(words[3]!.note).toEqual({ key: 'step.reasonNote', params: { reason: 'Concorrenza', note: 'Offerta concorrente a 450' } })
    // A break another list gave (its id differs): the generic name, its percent when it had one.
    const other = stepWords([{ kind: 'BREAK', delta: '-5', pct: '-3', source: { type: 'PriceBreak', id: 'x' } }], LIST_PRICES.lines[0]!, (code) => code)
    expect(other[0]!.name.key).toBe('step.BREAK')
    expect(other[0]!.note).toEqual({ key: 'step.pct', params: { pct: '3' } })
  })
})

describe('a manual change keeps how the price was reached (SAL-175)', () => {
  it('keeps a list start and its discount, the net with its reason', () => {
    expect(netBody(BLK, '445', 'LOYALTY', null)).toEqual({ start: 'LIST', discount: { pct: '2', reasonCode: 'VOLUME' }, net: { unitPrice: '445', reasonCode: 'LOYALTY' } })
    expect(netBody(RED, '430', 'OTHER', 'Fiera')).toEqual({ start: 'LIST', net: { unitPrice: '430', reasonCode: 'OTHER', note: 'Fiera' } })
  })

  it('keeps a typed start with its own price and reason', () => {
    const typed = { steps: [{ kind: 'MANUAL' as const, unitPrice: '400', reasonCode: 'LOYALTY', note: 'Cliente storico' }, { kind: 'NET' as const, unitPrice: '400' }], fromList: null }
    expect(netBody(typed, '390', 'COMPETITION', null)).toEqual({ start: 'MANUAL', startPrice: '400', startReasonCode: 'LOYALTY', startNote: 'Cliente storico', net: { unitPrice: '390', reasonCode: 'COMPETITION' } })
  })

  it('starts a line priced without a waterfall from its list, else from the price typed with that reason', () => {
    expect(netBody({ steps: null, fromList: RED.fromList }, '430', 'VOLUME', null)).toEqual({ start: 'LIST', net: { unitPrice: '430', reasonCode: 'VOLUME' } })
    expect(netBody({ steps: null, fromList: null }, '430', 'VOLUME', null)).toEqual({ start: 'MANUAL', startPrice: '430', startReasonCode: 'VOLUME' })
  })

  it('holds Save before the click: a price, a changed one, a reason, its note when the reason asks one', () => {
    const draft = { lineId: RED.lineId, text: '', reasonCode: '', note: '' }
    expect(netProblems(draft, '440', REASONS).map((entry) => entry.key)).toEqual(['manual.problem.price', 'manual.problem.reason'])
    expect(netProblems({ ...draft, text: '440,00', reasonCode: 'VOLUME' }, '440', REASONS).map((entry) => entry.key)).toEqual(['manual.problem.same'])
    expect(netProblems({ ...draft, text: '430', reasonCode: 'OTHER' }, '440', REASONS).map((entry) => entry.key)).toEqual(['manual.problem.note'])
    expect(netProblems({ ...draft, text: '430', reasonCode: 'OTHER', note: 'Fiera' }, '440', REASONS)).toEqual([])
    expect(netProblems({ ...draft, text: '430', reasonCode: 'GONE' }, '440', REASONS).map((entry) => entry.key)).toEqual(['manual.problem.reason'])
  })

  it('holds a fee, a line no list prices, a line without a cost', () => {
    expect(lineHeld({ ...BLK, kind: 'FEE' }, 'NET')).toEqual({ key: 'held.fee' })
    expect(lineHeld({ ...BLK, fromList: null }, 'LIST')).toEqual({ key: 'held.noList' })
    expect(lineHeld({ ...BLK, suggested: { unitPrice: null, marginPct: null, basedOn: null, problem: 'x' } }, 'SUGGESTED')).toEqual({ key: 'held.noCostSheet' })
    expect(lineHeld({ ...BLK, suggested: { unitPrice: null, marginPct: null, basedOn: BLK.suggested!.basedOn, problem: 'x' } }, 'SUGGESTED')).toEqual({ key: 'held.noCost' })
    expect(lineHeld(BLK, 'LIST')).toBeNull()
  })

  it('says a refused write in its own words: a reason gone, a note asked, a moved quote read again', () => {
    expect(priceProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/net/reasonCode', message: 'x' }])).words).toEqual({ key: 'problem.reason' })
    expect(priceProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/net/note', message: 'x' }])).words).toEqual({ key: 'problem.note' })
    expect(priceProblem(new ApiError('conflict', 409, 'version_conflict', 'x'))).toEqual({ words: { ns: 'sales', key: 'problem.write.moved' }, reload: true })
    expect(priceProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ words: { key: 'problem.state' }, reload: true })
  })
})

describe('the record\'s lines and the cost', () => {
  const QUOTE = quote()
  it('orders the pricing by line with its quote line; flags a loss and a line under the floor', () => {
    expect(pricingRows(PRICING, QUOTE).map((row) => [row.pricing.seq, row.line?.colourway.code])).toEqual([
      [10, 'BLK'],
      [20, 'RED'],
    ])
    expect(lineFlag(RED)).toBe('belowFloor')
    expect(lineFlag({ marginPct: '-3', belowFloor: true })).toBe('negative')
    expect(lineFlag(BLK)).toBeNull()
  })

  it('a block\'s discount is the waterfall\'s, its prices by size the sizes that cost more, in scale order', () => {
    const line = QUOTE.lines[0]!
    expect(lineDiscount(line, BLK)).toBe('2')
    expect(lineDiscount({ discountPct: '5' }, null)).toBe('5')
    expect(pricesBySize({ unitPrice: '450', sizes: [{ size: '56', quantity: 1, unitPrice: '480', certificate: line.sizes[0]!.certificate }, { size: '54', quantity: 2, unitPrice: '470', certificate: line.sizes[0]!.certificate }, { size: '50', quantity: 2, unitPrice: '450', certificate: line.sizes[0]!.certificate }] })).toEqual([
      { size: '54', unitPrice: '470' },
      { size: '56', unitPrice: '480' },
    ])
    expect(sizeOrder(['XL', 'S', '52', '48', 'M', 'TU'])).toEqual(['48', '52', 'S', 'M', 'XL', 'TU'])
  })

  it('weighs the cost sheet\'s cells by the line\'s pieces per size and compares it with the cost the quote keeps', () => {
    const cell = (size: string, material: string, total: string | null) => ({ colourwayId: 'c1', size, complete: total !== null, missing: [], minutes: '90', material: { complete: true, amount: material, byCategory: [], lines: [] }, labour: { complete: true, amount: '60', lines: [] }, overhead: null, knownTotal: total ?? material, total, waterfall: [] })
    const line = { colourwayId: 'c1', quantity: 3, unitCost: '250', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }] } as Parameters<typeof costBreakdown>[1]
    expect(costBreakdown({ cells: [cell('50', '190', '250'), cell('52', '196', '256')] }, line)).toEqual({ material: 194, labour: 60, overhead: null, total: 254, complete: true, changed: 4 })
    expect(costBreakdown({ cells: [cell('50', '190', null), cell('52', '196', '256')] }, line)).toMatchObject({ complete: false, total: null, changed: null })
    expect(costBreakdown({ cells: [cell('50', '190', '250')] }, line)).toBeNull()
  })
})

describe('margin floors per role (SAL-189)', () => {
  const floors = { tenant: null, company: { id: 'r', companyId: 'c', floors: { sales: '25', owner: '10' }, version: 2, updatedAt: '' }, inForce: { floors: { sales: '25', owner: '10' }, from: 'COMPANY' as const, companyFloorPct: '20' }, roles: [{ key: 'owner', name: 'Titolare' }, { key: 'sales', name: 'Vendite' }, { key: 'finance', name: 'Amministrazione' }] }
  it('drafts the scope\'s own row, holds a floor that is not a percent, sends null for none', () => {
    const draft = floorDraftOf(floors, 'company')
    expect(draft).toEqual({ owner: '10', sales: '25', finance: '' })
    expect(floorsChanged(draft, floors, 'company')).toBe(false)
    expect(floorsChanged({ ...draft, sales: '25,0' }, floors, 'company')).toBe(false)
    expect(floorsHeld({ ...draft, sales: '120' }, floors.roles)).toEqual({ key: 'floors.held.pct', params: { role: 'Vendite' } })
    expect(floorsBody({ owner: '', sales: '' })).toBeNull()
    expect(floorsBody({ ...draft, finance: '22,5' })).toEqual({ owner: '10', sales: '25', finance: '22.5' })
  })
  it('says a change that lets more quotes through (a floor lowered, removed, or added under the company floor)', () => {
    const draft = floorDraftOf(floors, 'company')
    expect(lowers({ ...draft, sales: '28' }, floors, 'company')).toBe(false)
    expect(lowers({ ...draft, sales: '22' }, floors, 'company')).toBe(true)
    expect(lowers({ ...draft, owner: '' }, floors, 'company')).toBe(true)
    expect(lowers({ ...draft, finance: '15' }, floors, 'company')).toBe(true)
    expect(lowers({ ...draft, finance: '30' }, floors, 'company')).toBe(false)
  })
})

// ---- words ---------------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOTS = [HERE, join(HERE, '../../../settings/floors')]
const sources = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !name.includes('.vitest.') ? [path] : []
  })
const PREFIXES = /^(?:block|breaks|bulk|cell|col|cost|days|discount|done|drawer|fee|flag|floors|held|keys|manual|pricing|problem|scope|step|stepUp)\./
const has = (dictionary: Readonly<Record<string, string>> | undefined, key: string) => !!dictionary && (dictionary[key] !== undefined || dictionary[`${key}_other`] !== undefined)

describe('words', () => {
  it('has every key in both languages with the same placeholders', () => {
    const it_ = CATALOGUE.it[PRICE_DEPTH_NS]!
    const en = CATALOGUE.en[PRICE_DEPTH_NS]!
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
  })

  it('each literal key the code says is in this catalogue (or W1\'s sales one it reuses)', () => {
    const missing: string[] = []
    for (const file of ROOTS.flatMap(sources)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/'([a-z]+[A-Za-z]*\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1]!
        if (!PREFIXES.test(key)) continue
        for (const locale of LOCALES) if (!has(CATALOGUE[locale][PRICE_DEPTH_NS], key) && !has(CATALOGUE[locale].sales, key)) missing.push(`${locale} ${key} (${file.split('/').slice(-2).join('/')})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('names every kind, flag, fee and scope the screens say by code', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][PRICE_DEPTH_NS]!
      for (const key of ['step.LIST', 'step.SUGGESTED', 'step.MANUAL_START', 'step.MANUAL', 'step.BREAK', 'step.OPTION', 'step.DISCOUNT', 'step.SIZE_SURCHARGE', 'step.NET', 'flag.negative', 'flag.belowFloor', 'fee.DEVELOPMENT', 'fee.SAMPLE', 'fee.TOOLING', 'fee.OTHER', 'scope.VERSION_STYLE', 'scope.VERSION', 'scope.STYLE', 'cell.saving', 'cell.failed', 'manual.keptLIST', 'manual.keptSUGGESTED', 'done.LIST', 'done.SUGGESTED', 'done.NET'])
        expect(words[key], `${locale} ${key}`).toBeTruthy()
      for (const key of ['bulk.doneLIST', 'bulk.doneSUGGESTED', 'step.BREAK_FROM']) expect(has(words, key), `${locale} ${key}`).toBe(true)
    }
  })
})

// ---- the design cases ----------------------------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:block|breaks|bulk|cell|col|cost|days|discount|done|drawer|fee|flag|floors|held|keys|manual|pricing|problem|scope|step|stepUp)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, floorsScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b(?:sales|product|products|files|example|email|quotes|money|threads|planning|pricelists|costing|imports)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('uses the step\'s screen ids: parts of SCR-035 and SCR-235', () => {
    expect([designScreen, floorsScreen].map((screen) => screen.screen)).toEqual(['SCR-035-prices', 'SCR-235-floors'])
  })
})
