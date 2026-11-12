import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../../routes'
import type { Material } from './api'
import { designScreen } from './fixtures'
import { addLine, emptyDraft, lineOf, lineProblem, removeLine, sendHeld, suppliersMatching, unplannedBody, type Draft } from './model'
import { problemCodeOf } from './view/UnplannedView'

/** SCR-378 — goods without a PO on the goods-in tablet (B-W2b-300; SCM-122): the screen's rules and its cases. Made-up data. */

const lining: Material = { id: 'm1', code: 'DEMO-LIN', name: 'Lining', tracking: 'LOT', baseUom: 'M', purchaseUom: 'M', colours: [{ id: 'c1', code: 'GRY', name: 'Grey' }, { id: 'c2', code: 'BLK', name: 'Black' }] }
const leather: Material = { id: 'm2', code: 'DEMO-LEA', name: 'Leather', tracking: 'HIDE', baseUom: 'FT2', purchaseUom: 'FT2', colours: [{ id: 'c3', code: 'BLK', name: 'Black' }] }
const supplier = { id: 's1', code: 'SUP', name: 'Demo supplier' }

describe('the draft', () => {
  it('picks a material’s only colour, asks the colour when there are several, and a quantity above 0', () => {
    expect(lineOf(leather, 'k').colour).toEqual(leather.colours[0])
    expect(lineProblem(lineOf(lining, 'k'))).toBe('NO_COLOUR')
    expect(lineProblem({ ...lineOf(lining, 'k'), colour: lining.colours[0]! })).toBe('NO_QUANTITY')
    expect(lineProblem({ ...lineOf(lining, 'k'), colour: lining.colours[0]!, quantity: 12 })).toBeNull()
  })

  it('adds a line once it may, puts an edited one back in its place, removes one', () => {
    const one: Draft = { ...emptyDraft(), editing: { ...lineOf(lining, 'a'), colour: lining.colours[0]!, quantity: 10 } }
    const added = addLine(one)
    expect(added.lines.map((line) => line.key)).toEqual(['a'])
    expect(added.editing).toBeNull()
    expect(addLine({ ...added, editing: lineOf(lining, 'b') })).toEqual({ ...added, editing: lineOf(lining, 'b') })
    const edited = addLine({ ...added, editing: { ...added.lines[0]!, quantity: 11 } })
    expect(edited.lines).toHaveLength(1)
    expect(edited.lines[0]!.quantity).toBe(11)
    expect(removeLine(edited, 'a').lines).toEqual([])
  })

  it('holds the post with the reason: offline, no supplier, nothing yet, no place', () => {
    const holding = { id: 'loc' }
    const ready: Draft = { ...emptyDraft(), supplier, lines: [{ ...lineOf(leather, 'a'), quantity: 52.25, hideCount: 1 }] }
    expect(sendHeld(ready, { online: false, holding, busy: false })).toBe('OFFLINE')
    expect(sendHeld({ ...ready, supplier: null }, { online: true, holding, busy: false })).toBe('NO_SUPPLIER')
    expect(sendHeld({ ...ready, lines: [] }, { online: true, holding, busy: false })).toBe('NO_LINES')
    expect(sendHeld(ready, { online: true, holding: null, busy: false })).toBe('NO_PLACE')
    expect(sendHeld({ ...ready, placeCode: 'BIN-1' }, { online: true, holding: null, busy: false })).toBeNull()
    expect(sendHeld(ready, { online: true, holding, busy: true })).toBe('BUSY')
  })

  it('sends one body: the scanned place wins, quantities as text, hides only for leather', () => {
    const draft: Draft = { ...emptyDraft(), supplier, ddtNumber: '4512', ddtDate: '2026-11-12', lines: [{ ...lineOf(lining, 'a'), colour: lining.colours[1]!, quantity: 45.5 }, { ...lineOf(leather, 'b'), quantity: 152.123456, hideCount: 3 }] }
    expect(unplannedBody(draft, { id: 'loc' })).toEqual({
      supplierId: 's1',
      holdingLocationId: 'loc',
      supplierDdtNumber: '4512',
      supplierDdtDate: '2026-11-12',
      lines: [
        { itemId: 'm1', itemColourId: 'c2', quantity: '45.5' },
        { itemId: 'm2', itemColourId: 'c3', quantity: '152.1235', hideCount: 3 },
      ],
    })
    expect(unplannedBody({ ...draft, placeCode: 'BIN-A1-HOLD' }, { id: 'loc' })).toMatchObject({ placeCode: 'BIN-A1-HOLD' })
    expect(unplannedBody({ ...draft, placeCode: 'BIN-A1-HOLD' }, { id: 'loc' })).not.toHaveProperty('holdingLocationId')
  })

  it('filters suppliers by code or name and words a refusal by its field', () => {
    expect(suppliersMatching([supplier, { id: 's2', code: 'TEX', name: 'Tessiture' }], 'tess').map((row) => row.id)).toEqual(['s2'])
    expect(problemCodeOf({ kind: 'invalid', path: 'body/placeCode', message: null })).toBe('PLACE')
    expect(problemCodeOf({ kind: 'invalid', path: 'body/lines/0/itemColourId', message: null })).toBe('COLOUR')
    expect(problemCodeOf({ kind: 'unavailable' })).toBeNull()
  })
})

// ---- the words and the cases -------------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : entry.name.endsWith('.tsx') || (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) ? [join(dir, entry.name)] : []))
const keysOf = (tree: unknown, prefix = ''): string[] => (tree && typeof tree === 'object' ? Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) => keysOf(value, prefix ? `${prefix}.${key}` : key)) : [prefix])
const OWN = new Set(keysOf(CATALOGUE.en['warehouse-receiving-depth']).map((key) => key.replace(/_(one|other)$/, '')))

describe('SCR-378 speaks both languages, with no key left and no money', () => {
  it('has every literal key it names in the catalogue', () => {
    const used = filesUnder(HERE).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\bt\('(unplanned\.[A-Za-z0-9_.]+)'/g)].map((match) => match[1]!))
    expect(used.length).toBeGreaterThan(50)
    expect(used.filter((key) => !OWN.has(key))).toEqual([])
    for (const code of ['NONE', 'LOT', 'HIDE']) expect(OWN.has(`unplanned.tracking.${code}`)).toBe(true)
    for (const code of ['OFFLINE', 'NO_SUPPLIER', 'NO_LINES', 'NO_PLACE', 'BUSY']) expect(OWN.has(`unplanned.held.${code}`)).toBe(true)
    for (const code of ['PLACE', 'SUPPLIER', 'COLOUR', 'LINE']) expect(OWN.has(`unplanned.problem.${code}.title`)).toBe(true)
    expect(OWN.has('unplanned.entry')).toBe(true)
  })

  const TOP = [...new Set(FLOOR_NAMESPACES.flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {})))]
  const LEFT_KEY = new RegExp(`(?:^|[\\s>"])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
  for (const locale of LOCALES) {
    it(`draws its ${designScreen.cases.length} cases in ${locale}`, () => {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(300)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        const text = html.replace(/<[^>]+>/g, ' ')
        expect(text.match(/€|EUR\s?\d|\$\s?\d/)?.[0] ?? null, `${item.id}: money on the floor`).toBeNull()
      }
    })
  }
})
