import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PATTERN_GRAINS, PIECE_ISSUE_CODES } from '@nexus/factory-domain/product/pieces/rules'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { abilitiesOf, STYLE_TABS, tabsFor } from '../../model'
import { writeProblem } from '../../problems'
import { demoPieces, designScreen } from './fixtures'
import { bulkGradeHeld, cellPatch, draftOf, draftPatch, draftProblems, issueWords, movedOrder, nameProblem, piecesCount, piecesHeld, quantityOf, shownValue, sizesText, markKey } from './pieces-model'

/** B-W2b-95 (SCR-271): the Pattern pieces section's rules, words and design cases, with made-up data. */

const view = demoPieces()
const byName = (name: string) => view.pieces.find((piece) => piece.name === name)!
const RANGE = view.sizes.map((size) => size.code)

describe('the tab and who may change the list', () => {
  it('is the tab before Activity, read with the BOM', () => {
    // B-W2b-245: Versions & changes sits between Files & patterns and Activity (the design's order).
    expect(STYLE_TABS.slice(-3)).toEqual(['files', 'versions', 'activity'])
    expect(tabsFor(abilitiesOf(['product.styles.view', 'product.bom.view']))).toContain('files')
    expect(tabsFor(abilitiesOf(['product.styles.view']))).not.toContain('files')
  })

  it('holds the list without the right, on a frozen revision and on an archived style', () => {
    expect(piecesHeld(view, true)).toBeNull()
    expect(piecesHeld(view, false)).toBe('pieces.held.noManage')
    expect(piecesHeld({ ...view, revision: { ...view.revision, status: 'RELEASED' }, editable: false }, true)).toBe('pieces.held.frozen')
    expect(piecesHeld({ ...view, style: { ...view.style, status: 'ARCHIVED' }, editable: false }, true)).toBe('held.archived')
  })
})

describe('words', () => {
  it('reads sizes as people do: all, a run, a few', () => {
    expect(sizesText([], RANGE)).toEqual({ key: 'pieces.sizes.all' })
    expect(sizesText(['54', '56', '58'], RANGE)).toEqual({ key: 'pieces.sizes.run', params: { from: '54', to: '58' } })
    expect(sizesText(['50', '54'], RANGE)).toEqual({ key: 'pieces.sizes.some', params: { sizes: '50, 54' } })
    expect(sizesText(['52', '54'], RANGE)).toEqual({ key: 'pieces.sizes.some', params: { sizes: '52, 54' } })
    expect(sizesText(['56', '58', '60'], RANGE)).toEqual({ key: 'pieces.sizes.some', params: { sizes: '56, 58, 60' } })
  })

  it('counts pieces and pieces per garment', () => {
    expect(piecesCount(view)).toEqual({ pieces: 10, perGarment: 13 })
  })

  it("says the API's findings in our words", () => {
    const issues = demoPieces({ issues: true })
    expect(issues.issues.map((issue) => issueWords(issue, issues))).toEqual([
      { key: 'pieces.issue.SIZE_NOT_IN_RANGE', params: { piece: 'Toppa gomito', line: '', sizes: '60' } },
      { key: 'pieces.issue.GRADE_NOT_LEATHER', params: { piece: 'Fodera corpo', line: '20 · FOD-MESH' } },
      { key: 'pieces.issue.GRADE_RETIRED', params: { piece: 'Fodera corpo', line: '', grade: 'D' } },
    ])
  })

  it('says a BOM write refused for pieces in its own words', () => {
    const error = new ApiError('conflict', 409, 'conflict', '2 pattern piece(s) are cut from line 10', null, [{ path: 'pieces/abc/bomLineId', message: 'x' }])
    expect(writeProblem(error)).toMatchObject({ key: 'problem.write.piecesUse', reload: false })
  })
})

describe('a cell before it saves', () => {
  it('checks the name and the pieces per garment in our words', () => {
    expect(nameProblem('  ', view.pieces, null)).toBe('pieces.problem.nameBlank')
    expect(nameProblem('manica', view.pieces, null)).toBe('pieces.problem.nameTaken')
    expect(nameProblem('Manica', view.pieces, byName('Manica').id)).toBeNull()
    expect(quantityOf('2')).toBe(2)
    expect(quantityOf('0')).toBeNull()
    expect(quantityOf('100')).toBeNull()
    expect(quantityOf('1.5')).toBeNull()
    expect(cellPatch(byName('Collo'), 'quantity', 'x', view)).toEqual({ problem: 'pieces.problem.quantity' })
  })

  it('takes the grade off when a graded piece moves to a line that is not leather, and says so', () => {
    const lining = view.lines.find((line) => !line.leather)!
    expect(cellPatch(byName('Collo'), 'bomLineId', lining.id, view)).toEqual({ patch: { bomLineId: lining.id, minGradeId: null }, cleared: true })
    expect(cellPatch(byName('Sottocollo'), 'bomLineId', lining.id, view)).toEqual({ patch: { bomLineId: lining.id }, cleared: false })
    expect(cellPatch(byName('Fodera corpo'), 'minGradeId', view.grades[0]!.id, view)).toEqual({ problem: 'pieces.problem.gradeNotLeather' })
    expect(cellPatch(byName('Collo'), 'note', '   ', view)).toEqual({ patch: { note: null }, cleared: false })
  })

  it('shows the value typed while it saves, the stored one once refused', () => {
    const piece = byName('Manica')
    expect(shownValue(piece, 'quantity', { [markKey(piece.id, 'quantity')]: { state: 'saving', value: '3' } })).toBe('3')
    expect(shownValue(piece, 'quantity', { [markKey(piece.id, 'quantity')]: { state: 'refused', value: '3', problem: 'x' } })).toBe(2)
  })
})

describe('the piece dialog, the selection and the order', () => {
  it('sends a new piece whole and a change only what differs', () => {
    const draft = { ...draftOf(null), name: ' Taschino ', quantity: '2', bomLineId: view.lines[0]!.id, minGradeId: view.grades[1]!.id, sizes: ['50', '52'] }
    expect(draftProblems(draft, view, null)).toEqual({})
    expect(draftPatch(draft, null)).toEqual({ name: 'Taschino', quantity: 2, bomLineId: view.lines[0]!.id, minGradeId: view.grades[1]!.id, grain: 'ANY', sizes: ['50', '52'], note: null })
    const collo = byName('Collo')
    expect(draftPatch({ ...draftOf(collo), grain: 'BIAS' }, collo)).toEqual({ grain: 'BIAS' })
    expect(draftProblems({ ...draftOf(null), name: 'Collo', quantity: '0' }, view, null)).toEqual({ name: 'pieces.problem.nameTaken', quantity: 'pieces.problem.quantity' })
  })

  it('holds a grade for a selection with a piece off leather, naming it', () => {
    expect(bulkGradeHeld(view, [byName('Collo').id, byName('Manica').id])).toBeNull()
    expect(bulkGradeHeld(view, [byName('Collo').id, byName('Fodera corpo').id])).toEqual({ key: 'pieces.held.bulkNotLeather', params: { pieces: 'Fodera corpo' } })
  })

  it('moves a piece up or down, never past the ends', () => {
    const ids = view.pieces.map((piece) => piece.id)
    expect(movedOrder(view.pieces, ids[1]!, -1)!.slice(0, 2)).toEqual([ids[1], ids[0]])
    expect(movedOrder(view.pieces, ids[0]!, -1)).toBeNull()
    expect(movedOrder(view.pieces, ids[9]!, 1)).toBeNull()
  })
})

// ---- every key in both languages, every design case drawn with no key left --------------------------------------------

const SRC = fileURLToPath(new URL('.', import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}
const has = (key: string) =>
  LOCALES.every((locale) => {
    const dictionary = CATALOGUE[locale].products ?? {}
    return key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary)
  })

describe('every key of the section exists in it and en', () => {
  it('products', () => {
    const literal = new Set<string>()
    for (const file of sources(SRC)) for (const match of readFileSync(file, 'utf8').matchAll(/['"`]((?:pieces|held|problem)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) literal.add(match[1]!)
    const built = [...PATTERN_GRAINS.map((grain) => `pieces.grain.${grain}`), ...PIECE_ISSUE_CODES.map((code) => `pieces.issue.${code}`), 'tab.files', 'problem.write.piecesUse']
    expect(literal.size).toBeGreaterThan(50)
    expect([...literal, ...built].filter((key) => !has(key))).toEqual([])
  })
})

const LEFT_KEY = /\b(?:pieces|held|problem|record|action|tab|common)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('every SCR-271 case draws in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`SCR-271 in ${locale}: ${designScreen.cases.length} cases`, () => {
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(100)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-271/${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
