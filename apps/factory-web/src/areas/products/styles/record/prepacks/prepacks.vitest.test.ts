import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLACEMENT_FINDINGS, PROTECTOR_POCKETS } from '@nexus/factory-domain/product/protectors/rules'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { abilitiesOf, STYLE_TABS, tabsFor } from '../../model'
import { demoPrepacks, designScreen } from './fixtures'
import { bulkHeld, cellEditable, cellLines, draftLines, draftOf, draftPatch, draftProblems, draftRows, draftTotals, piecesTyped, prepackCounts, prepackHeld, styleHeld, visibleRows, type PrepackDraft } from './prepacks-model'
import { prepackProblem } from './use-prepacks'

/** B-W2b-233 (SCR-287): the Prepacks section's rules, words and the design cases of the Sizes & measurements tab, with made-up data. */

const view = demoPrepacks()
const byCode = (code: string) => view.prepacks.find((prepack) => prepack.code === code)!

describe('the tab', () => {
  it('is the design’s tab after Colourways & sizes, opened with the style’s read', () => {
    expect(STYLE_TABS.slice(0, 3)).toEqual(['overview', 'variants', 'sizes'])
    expect(tabsFor(abilitiesOf(['product.styles.view']))).toContain('sizes')
    expect(tabsFor(abilitiesOf([]))).not.toContain('sizes')
  })
})

describe('who may change which pack (PRD-055)', () => {
  it('holds without the right, an archived pack, the style’s rule only for its own packs', () => {
    expect(styleHeld(view, false)).toBe('prepacks.held.noManage')
    expect(styleHeld(view, true)).toBeNull()
    expect(prepackHeld(byCode('PP-SPRING-6'), view, true)).toBe('prepacks.held.archived')
    const ruled = demoPrepacks({ rule: true })
    expect(prepackHeld(ruled.prepacks.find((prepack) => prepack.scope === 'STYLE')!, ruled, true)).toBe('prepacks.held.rule')
    expect(prepackHeld(ruled.prepacks.find((prepack) => prepack.scope === 'SCALE')!, ruled, true)).toBeNull()
    expect(styleHeld({ ...view, style: { ...view.style, status: 'ARCHIVED' } }, true)).toBe('prepacks.held.archivedStyle')
  })

  it('types into a size cell only of a pack without colourways that can change', () => {
    expect(cellEditable(byCode('PP-DEALER-10'), view, true)).toBe(true)
    expect(cellEditable(byCode('PP-COL-52'), view, true)).toBe(false)
    expect(cellEditable(byCode('PP-DEALER-10'), view, false)).toBe(false)
  })

  it('lists the archived packs only on request and counts what the style can sell', () => {
    expect(visibleRows(view, false).map((prepack) => prepack.code)).toEqual(['PP-DEALER-10', 'PP-COL-52', 'PP-EU-WIDE', 'PP-EU-CORE'])
    expect(visibleRows(view, true)).toHaveLength(5)
    expect(prepackCounts(view)).toEqual({ active: 4, usable: 3, archived: 1 })
  })

  it('holds Archive / Restore when nothing of the selection would move', () => {
    expect(bulkHeld(view, [byCode('PP-DEALER-10').id], 'ARCHIVED', true)).toBeNull()
    expect(bulkHeld(view, [byCode('PP-DEALER-10').id], 'ACTIVE', true)).toBe('prepacks.bulk.noneArchived')
    expect(bulkHeld(view, [byCode('PP-SPRING-6').id], 'ARCHIVED', true)).toBe('prepacks.bulk.noneActive')
    expect(bulkHeld(view, [byCode('PP-SPRING-6').id], 'ACTIVE', false)).toBe('prepacks.held.noManage')
  })
})

describe('a typed cell and the pack dialog', () => {
  it('reads whole pieces from 1 to 10 000; empty is none of the size', () => {
    expect(piecesTyped('3')).toBe(3)
    expect(piecesTyped(' ')).toBeNull()
    expect(piecesTyped('0')).toBeUndefined()
    expect(piecesTyped('2.5')).toBeUndefined()
    expect(piecesTyped('10001')).toBeUndefined()
  })

  it('sets, adds and clears a size; the last size is never cleared', () => {
    const pack = byCode('PP-DEALER-10')
    expect(cellLines(pack, '50', '4')).toEqual({ lines: [{ size: '48', colourwayId: null, quantity: 2 }, { size: '52', colourwayId: null, quantity: 3 }, { size: '54', colourwayId: null, quantity: 2 }, { size: '50', colourwayId: null, quantity: 4 }] })
    expect(cellLines(pack, '48', null)).toMatchObject({ lines: expect.not.arrayContaining([expect.objectContaining({ size: '48' })]) })
    expect(cellLines(pack, '50', 'x')).toEqual({ problem: 'prepacks.problem.quantity' })
    expect(cellLines({ ...pack, lines: [{ size: '52', colourwayId: null, colourway: null, quantity: 1 }] }, '52', null)).toEqual({ problem: 'prepacks.problem.lastSize' })
  })

  it('drafts a new pack per size or per colourway, with the API’s checks in our words', () => {
    const blank = draftOf(null)
    expect(draftProblems(blank, view, null)).toEqual({ code: 'prepacks.problem.codeMissing', name: 'prepacks.problem.nameMissing', cells: 'prepacks.problem.noLine' })
    const taken = { ...blank, code: 'PP-EU-CORE', name: 'Again', cells: { '': { '52': '2' } } }
    expect(draftProblems(taken, view, null)).toEqual({ code: 'prepacks.problem.codeTaken' })
    expect(draftProblems({ ...taken, code: 'PP 2' }, view, null)).toEqual({ code: 'prepacks.problem.codeShape' })
    expect(draftProblems({ ...taken, code: 'PP-NEW', cells: { '': { '52': '0' } } }, view, null)).toEqual({ cells: 'prepacks.problem.quantity' })
    const colour: PrepackDraft = { ...blank, code: 'PP-MIX', name: 'Mix', byColour: true, cells: { [view.colourways[0]!.id]: { '50': '1', '52': '2' }, [view.colourways[2]!.id]: { '52': '1' } } }
    expect(draftRows(colour, view).map((row) => row.code)).toEqual(['NERO', 'ANTR', 'ROSSO'])
    expect(draftLines(colour, view)).toEqual([
      { size: '50', colourwayId: view.colourways[0]!.id, quantity: 1 },
      { size: '52', colourwayId: view.colourways[0]!.id, quantity: 2 },
      { size: '52', colourwayId: view.colourways[2]!.id, quantity: 1 },
    ])
    expect(draftTotals(colour, view)).toEqual({ pieces: 4, ratio: '1-3' })
    expect(draftProblems(colour, view, null)).toEqual({})
    // A scale's pack takes the scale's sizes and no colourway.
    expect(draftLines({ ...blank, scope: 'SCALE', code: 'PP-S', name: 'S', cells: { '': { '44': '1', '60': '1' } } }, view)).toEqual([
      { size: '44', colourwayId: null, quantity: 1 },
      { size: '60', colourwayId: null, quantity: 1 },
    ])
  })

  it('sends only what changed of an open pack', () => {
    const pack = byCode('PP-DEALER-10')
    const draft = draftOf(pack)
    expect(draftPatch(draft, pack, view)).toEqual({})
    expect(draftPatch({ ...draft, name: 'Rivenditore 11', cells: { '': { ...draft.cells['']!, '56': '1' } } }, pack, view)).toEqual({
      name: 'Rivenditore 11',
      lines: [
        { size: '48', colourwayId: null, quantity: 2 },
        { size: '50', colourwayId: null, quantity: 3 },
        { size: '52', colourwayId: null, quantity: 3 },
        { size: '54', colourwayId: null, quantity: 2 },
        { size: '56', colourwayId: null, quantity: 1 },
      ],
    })
  })

  it('says a refused write in its own words', () => {
    expect(prepackProblem(new ApiError('conflict', 409, 'conflict', 'The prepack code X is taken in size scale Y: pick another.'))).toBe('prepacks.problem.codeTaken')
    expect(prepackProblem(new ApiError('forbidden', 403, 'forbidden', 'no'))).toBe('prepacks.held.noManage')
    expect(prepackProblem(new Error('boom'))).toBe('prepacks.problem.write')
  })
})

const SRC = fileURLToPath(new URL('..', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale]['products-prepacks'] ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every key of the two sections exists in it and en', () => {
  it('products-prepacks', () => {
    const literal = new Set<string>()
    for (const folder of ['prepacks', 'protectors']) {
      for (const file of sources(join(SRC, folder))) for (const match of readFileSync(file, 'utf8').matchAll(/['"`]((?:prepacks|protectors)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) literal.add(match[1]!)
    }
    const built = [
      ...PROTECTOR_POCKETS.flatMap((pocket) => [`protectors.pocket.${pocket}`, `protectors.pocketWord.${pocket}`]),
      ...PLACEMENT_FINDINGS.map((code) => `protectors.finding.${code}`),
    ]
    expect(literal.size).toBeGreaterThan(80)
    expect([...literal, ...built].filter((key) => !has(key))).toEqual([])
    expect(LOCALES.every((locale) => 'tab.sizes' in (CATALOGUE[locale].products ?? {}))).toBe(true)
  })
})

const LEFT_KEY = /\b(?:prepacks|protectors|held|problem|record|action|tab|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('every SCR-287 case draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-287 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(100)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-287/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
