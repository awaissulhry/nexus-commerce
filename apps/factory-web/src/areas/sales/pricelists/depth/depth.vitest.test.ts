import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { KNOWN_IMPORTERS } from '../../../admin/import/model'
import { can, DETAIL, MINIMUMS, RULES, V1, V2, V2_DATED, V2_ENTRIES } from '../_demo/fixtures'
import { importHeldOf } from '../import/PriceListImport'
import { designScreen as importScreen } from '../import/fixtures'
import { designScreen as listScreen } from '../list/fixtures'
import { designScreen as printScreen } from '../print/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { exportHref } from './api'
import { breakCellRow, breakHeld, breakRowOf, daysHeld, daysRows, datedKeys, DEPTH_NS, emptyBreak, emptyMinimum, isPhrase, minimumBody, minimumHeld, movableMinimums, rulesHeld, sortedBreaks, splitRows, surchargeCellRow, surchargeGrid, surchargeHeld, surchargeRowsOf, surchargeSizes } from './model'

/**
 * B-W2b-343 — price lists in depth on screen: dated prices written through their own route, a price's days and their
 * overlap, a break or surcharge row as one write with both money fields, the surcharges as rows of sizes, the minimums'
 * checks, Import prices' rights, the export's link, and every design case (SCR-106, SCR-106-record, SCR-419, SCR-420)
 * in both languages with no key left on screen.
 */

const GLOVE_WINTER = V2_DATED.find((row) => row.validTo === '2027-02-28')!
const GLOVE_SPRING = V2_DATED.find((row) => row.validFrom === '2027-03-01')!

describe('dated prices (SAL-167)', () => {
  it('writes a style with a dated price through the dated prices, the others through W2a\'s cell write', () => {
    expect([...datedKeys(V2_DATED)]).toEqual([`${GLOVE_WINTER.styleId}:*`])
    const plainRow = V2_DATED[0]!
    const split = splitRows(V2_DATED, [
      { entry: plainRow, styleId: plainRow.styleId, colourwayId: plainRow.colourwayId, unitPrice: '440' },
      { entry: GLOVE_WINTER, styleId: GLOVE_WINTER.styleId, colourwayId: null, unitPrice: '71' },
      { entry: null, styleId: GLOVE_WINTER.styleId, colourwayId: null, unitPrice: '80', validFrom: '2027-09-01', validTo: null },
    ])
    expect(split.plain).toEqual([{ styleId: plainRow.styleId, colourwayId: plainRow.colourwayId, unitPrice: '440' }])
    expect(split.dated).toEqual([
      { styleId: GLOVE_WINTER.styleId, colourwayId: null, validFrom: '2026-11-21', validTo: '2027-02-28', unitPrice: '71' },
      { styleId: GLOVE_WINTER.styleId, colourwayId: null, validFrom: '2027-09-01', validTo: null, unitPrice: '80' },
    ])
  })

  it('holds days in the wrong order or meeting another price of the same style and colourway', () => {
    const target = { styleId: GLOVE_WINTER.styleId, colourwayId: null, exceptId: GLOVE_WINTER.id }
    expect(daysHeld(V2_DATED, { ...target, validFrom: '2026-12-01', validTo: '2027-02-28' })).toBeNull()
    expect(daysHeld(V2_DATED, { ...target, validFrom: '2027-02-01', validTo: '2027-01-01' })).toEqual({ key: 'days.held.order' })
    expect(daysHeld(V2_DATED, { ...target, validFrom: '2026-11-21', validTo: '2027-03-15' })).toEqual({ key: 'days.held.overlap', params: { from: '2027-03-01', to: '—' } })
    // An undated price holds every day: it meets any dated one.
    const undated = V2_ENTRIES[0]!
    expect(daysHeld(V2_ENTRIES, { styleId: undated.styleId, colourwayId: null, validFrom: '2027-01-01', validTo: '' })).toEqual({ key: 'days.held.undated' })
  })

  it('gives a price new days in ONE write: the same first day updates it, another one removes the old row and adds the new', () => {
    expect(daysRows(GLOVE_WINTER, '2026-11-21', '2027-01-31', '69.5')).toEqual([{ styleId: GLOVE_WINTER.styleId, colourwayId: null, validFrom: '2026-11-21', validTo: '2027-01-31', unitPrice: '69.5' }])
    expect(daysRows(GLOVE_WINTER, '2026-12-01', '', '69.5')).toEqual([
      { styleId: GLOVE_WINTER.styleId, colourwayId: null, validFrom: '2026-11-21', validTo: '2027-02-28', unitPrice: null },
      { styleId: GLOVE_WINTER.styleId, colourwayId: null, validFrom: '2026-12-01', validTo: null, unitPrice: '69.5' },
    ])
    expect(GLOVE_SPRING.validTo).toBeNull()
  })
})

describe('quantity breaks (SAL-166)', () => {
  const entries = V2_ENTRIES
  it('holds Add a break before the click, as the API checks it', () => {
    const entry = entries[0]!
    expect(breakHeld({ ...emptyBreak(), minQuantity: '1', value: '5' }, RULES, entries)).toEqual({ key: 'breaks.held.quantity' })
    expect(breakHeld({ entryId: '', minQuantity: '20', kind: 'PRICE', value: '400' }, RULES, entries)).toEqual({ key: 'breaks.held.everyPct' })
    expect(breakHeld({ entryId: entry.id, minQuantity: '10', kind: 'PRICE', value: '420' }, RULES, entries)).toEqual({ key: 'breaks.held.twice', params: { count: 10 } })
    expect(breakHeld({ entryId: entry.id, minQuantity: '20', kind: 'PRICE', value: '440' }, RULES, entries)).toEqual({ key: 'breaks.held.lower', params: { price: '436.80' } })
    expect(breakHeld({ entryId: entry.id, minQuantity: '20', kind: 'PCT', value: '100' }, RULES, entries)).toEqual({ key: 'breaks.held.pct' })
    expect(breakHeld({ entryId: entry.id, minQuantity: '20', kind: 'PRICE', value: '420,50' }, RULES, entries)).toBeNull()
  })

  it('sends each row with both money fields (null for none; both null removes)', () => {
    expect(breakRowOf({ entryId: '', minQuantity: '200', kind: 'PCT', value: '5' })).toEqual({ entryId: null, minQuantity: 200, unitPrice: null, discountPct: '5' })
    const own = RULES.breaks[0]!
    expect(breakCellRow(own, 'unitPrice', '424')).toEqual({ entryId: own.entryId, minQuantity: 10, unitPrice: '424', discountPct: null })
    expect(breakCellRow(own, 'discountPct', '4,5')).toEqual({ entryId: own.entryId, minQuantity: 10, unitPrice: null, discountPct: '4.5' })
    expect(breakCellRow(own, 'unitPrice', '')).toEqual({ entryId: own.entryId, minQuantity: 10, unitPrice: null, discountPct: null })
    expect(isPhrase(breakCellRow(own, 'unitPrice', '500'))).toBe(true)
    expect(breakCellRow(RULES.breaks[3]!, 'unitPrice', '10')).toEqual({ key: 'breaks.held.everyPct' })
  })

  it('reads every price\'s discount first, then each price by style and quantity', () => {
    expect(sortedBreaks(RULES.breaks).map((row) => [row.entry?.style.code ?? '*', row.minQuantity])).toEqual([
      ['*', 100],
      ['JKT-DEMO-01', 10],
      ['JKT-DEMO-01', 50],
      ['JKT-DEMO-02', 20],
    ])
  })
})

describe('size surcharges (SAL-180)', () => {
  it('draws the surcharges as rows of sizes: every style (amount and percent), per style, each style\'s own', () => {
    expect(surchargeSizes(RULES)).toEqual(['54', '56', '58'])
    expect(surchargeSizes(RULES, ['60 '])).toEqual(['54', '56', '58', '60'])
    const grid = surchargeGrid(RULES)
    expect(grid.map((row) => [row.id, row.values])).toEqual([
      ['version:*:amount', { '56': '20', '58': '25' }],
      ['version:*:pct', { '56': null, '58': null }],
      [`version:${RULES.sizeSurcharges[2]!.styleId}:amount`, { '54': null }],
      [`version:${RULES.sizeSurcharges[2]!.styleId}:pct`, { '54': '5' }],
      [`style:${RULES.styleSurcharges[0]!.styleId}:amount`, { '54': '15' }],
    ])
  })

  it('writes a cell as ONE row with both fields (the other kind replaced), a cleared cell removes it', () => {
    expect(surchargeCellRow({ styleId: null, kind: 'amount' }, '56', '22.5')).toEqual({ styleId: null, size: '56', amount: '22.5', pct: null })
    expect(surchargeCellRow({ styleId: 's', kind: 'pct' }, '54', '6')).toEqual({ styleId: 's', size: '54', amount: null, pct: '6' })
    expect(surchargeCellRow({ styleId: null, kind: 'amount' }, '56', null)).toEqual({ styleId: null, size: '56', amount: null, pct: null })
    expect(surchargeCellRow({ styleId: null, kind: 'pct' }, '56', '120')).toEqual({ key: 'surcharges.held.pct' })
  })

  it('holds Add a surcharge before the click; sizes as stored (capitals, once each)', () => {
    expect(surchargeHeld({ styleId: '', sizes: ' ', kind: 'amount', value: '10' })).toEqual({ key: 'surcharges.held.sizes' })
    expect(surchargeHeld({ styleId: '', sizes: '60', kind: 'amount', value: '0' })).toEqual({ key: 'surcharges.held.amount' })
    expect(surchargeHeld({ styleId: '', sizes: '60', kind: 'pct', value: '101' })).toEqual({ key: 'surcharges.held.pct' })
    expect(surchargeRowsOf({ styleId: '', sizes: 'xl, 60 60;62', kind: 'amount', value: '30,5' })).toEqual([
      { styleId: null, size: 'XL', amount: '30.5', pct: null },
      { styleId: null, size: '60', amount: '30.5', pct: null },
      { styleId: null, size: '62', amount: '30.5', pct: null },
    ])
  })

  it('holds the rules of a version in force, without the right, the price grain or a version', () => {
    expect(rulesHeld(DETAIL, V2, can('sales'))).toBeNull()
    expect(rulesHeld(DETAIL, V1, can('sales'))).toEqual({ key: 'held.activeHasDraft', params: { revision: 1 } })
    expect(rulesHeld({ ...DETAIL, draftVersionId: null }, V1, can('sales'))).toEqual({ key: 'held.activeVersion', params: { revision: 1 } })
    expect(rulesHeld(DETAIL, V2, can('finance'))).toEqual({ key: 'held.noManage' })
    expect(rulesHeld(DETAIL, V2, can('readOnly'))).toEqual({ key: 'held.noPrice' })
    expect(rulesHeld({ ...DETAIL, status: 'ARCHIVED' }, V2, can('sales'))).toEqual({ key: 'held.archived' })
  })
})

describe('minimums (SAL-178)', () => {
  it('holds New minimum before the click, the active twin included', () => {
    expect(minimumHeld(emptyMinimum(), MINIMUMS)).toEqual({ key: 'minimums.held.style' })
    expect(minimumHeld({ ...emptyMinimum(), styleId: 'x', minQuantity: '1' }, MINIMUMS)).toEqual({ key: 'minimums.held.quantity' })
    expect(minimumHeld({ ...emptyMinimum(), styleId: MINIMUMS[0]!.styleId!, minQuantity: '8', per: 'LINE' }, MINIMUMS)).toEqual({ key: 'minimums.held.twin' })
    expect(minimumHeld({ ...emptyMinimum(), styleId: MINIMUMS[0]!.styleId!, minQuantity: '8', per: 'ORDER' }, MINIMUMS)).toBeNull()
    expect(minimumHeld({ ...emptyMinimum(), subject: 'PRODUCT_TYPE', productType: 'VEST', minQuantity: '10', action: 'SURCHARGE', surcharge: '' }, MINIMUMS)).toEqual({ key: 'minimums.held.amount' })
  })

  it('sends the list, its company, one subject and the surcharge only with SURCHARGE', () => {
    expect(minimumBody({ ...emptyMinimum(), subject: 'PRODUCT_TYPE', productType: 'VEST', minQuantity: '10', per: 'ORDER', action: 'SURCHARGE', surcharge: '8' }, DETAIL)).toEqual({
      companyId: DETAIL.companyId,
      priceListId: DETAIL.id,
      productType: 'VEST',
      minQuantity: 10,
      per: 'ORDER',
      action: 'SURCHARGE',
      surchargeAmount: '8',
      currency: 'EUR',
      surchargePct: null,
      note: null,
    })
    expect(minimumBody({ ...emptyMinimum(), styleId: 's', minQuantity: '5' }, DETAIL)).toMatchObject({ styleId: 's', action: 'WARN', surchargeAmount: null, currency: null, surchargePct: null })
    expect(movableMinimums(MINIMUMS, MINIMUMS.map((rule) => rule.id), 'reactivate').map((rule) => rule.status)).toEqual(['ARCHIVED'])
  })
})

describe('Import prices and the export', () => {
  it('holds Import without price list work, the price grain or the import rights', () => {
    expect(importHeldOf(['pricelists.manage', 'money.price', 'imports.run', 'files.upload'])).toBeNull()
    expect(importHeldOf(['pricelists.view'])).toBe('import.held.manage')
    expect(importHeldOf(['pricelists.manage', 'imports.run', 'files.upload'])).toBe('import.held.price')
    expect(importHeldOf(['pricelists.manage', 'money.price'])).toBe('import.held.run')
  })
  it('names the importer in the wizard\'s own words; the export is a link through the app\'s /api', () => {
    expect(KNOWN_IMPORTERS).toContain('sales.priceLists')
    for (const locale of LOCALES) expect(CATALOGUE[locale]['admin-import']?.['imp.importer.sales_priceLists.name'], locale).toBeTruthy()
    expect(exportHref('l 1', 'v/2', 'xlsx', 'it')).toBe('/api/sales/price-lists/l%201/versions/v%2F2/export?format=xlsx&numberFormat=it')
  })
})

// ---- words ---------------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const sources = (root: string): string[] =>
  readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !name.includes('.vitest.') ? [path] : []
  })
const MINE = /^(?:(?:breaks|days|discount|minimums|surcharges|import|print)\.|record\.(?:pdf|export|import)|tab\.breaks)/
const has = (dictionary: Readonly<Record<string, string>> | undefined, key: string) => !!dictionary && (dictionary[key] !== undefined || dictionary[`${key}_other`] !== undefined)

describe('words', () => {
  it('each literal key of the W2b parts is in this step\'s catalogue (or W2a\'s pricelists one)', () => {
    const missing: string[] = []
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/'((?:depth\.)?[a-z]+\.[A-Za-z0-9_.]+)'/g)) {
        const key = match[1]!.replace(/^depth\./, '')
        if (!MINE.test(key)) continue
        for (const locale of LOCALES) if (!has(CATALOGUE[locale][DEPTH_NS], key) && !has(CATALOGUE[locale].pricelists, key)) missing.push(`${locale} ${key} (${file.split('/').slice(-2).join('/')})`)
      }
    }
    expect(missing).toEqual([])
  })
})

// ---- the design cases ----------------------------------------------------------------------------------------------------

const LEFT_KEY = /\b(?:breaks|days|discount|minimums|surcharges|import|print|held|record|tab|prices|common|problem|cell)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [recordScreen, listScreen, importScreen, printScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '')
            .replace(/\b[\w-]+\.(?:xlsx|csv)\b/g, '')
            .replace(/\b(?:pricelists|imports|files|money|parties|product|threads)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('uses the step\'s screen ids: SCR-419 (Import prices) and SCR-420 (the price list PDF) new, the record\'s and the list\'s parts of SCR-106', () => {
    expect([recordScreen, listScreen, importScreen, printScreen].map((screen) => screen.screen)).toEqual(['SCR-106-record', 'SCR-106', 'SCR-419', 'SCR-420'])
    expect(recordScreen.cases.some((item) => item.id === 'breaks')).toBe(true)
  })
})
