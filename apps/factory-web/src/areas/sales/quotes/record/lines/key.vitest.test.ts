import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { gridShapeOf, gridValueOf, lineWrites } from '../../model'
import { designScreen, WITH_FEE } from '../fixtures'
import { colourRowsOf, gridLinesOf, lineOfColour } from './key'

/**
 * B-W2b-382 (follow-up XF7:05, B-W2b-340's note): SEED-Q-0003's FEE line shares its goods line's style and colourway; the W1
 * block keyed one colour row per LINE while the style was read, so React logged "two children with the same key", and the
 * fee's empty sizes blanked the goods line's numbers of that colourway.
 */
const BLACK = WITH_FEE[0]!.colourwayId
const fee = WITH_FEE[0]!
const goods = WITH_FEE.find((line) => line.kind === 'SIZE_GRID' && line.colourwayId === BLACK)!

describe('the style block: one row per colourway', () => {
  it('while the style is read, a fee line in a goods line’s colourway adds no second row', () => {
    const rows = colourRowsOf(WITH_FEE)
    expect(rows.map((row) => row.key)).toEqual([...new Set(WITH_FEE.map((line) => line.colourwayId))])
    expect(gridShapeOf(WITH_FEE, null).colours.map((row) => row.key)).toEqual(rows.map((row) => row.key))
    expect(rows.find((row) => row.key === BLACK)!.offered).toEqual(goods.sizes.map((entry) => entry.size))
  })
  it('the grid’s numbers are the size-grid lines’: the fee never blanks the black row', () => {
    expect(gridLinesOf(WITH_FEE)).not.toContain(fee)
    expect(gridValueOf(WITH_FEE)[BLACK]).toEqual(Object.fromEntries(goods.sizes.map((entry) => [entry.size, entry.quantity])))
  })
  it('a colour row’s price is its goods line’s; a typed grid edits the goods line, never the fee', () => {
    expect(lineOfColour(WITH_FEE, BLACK)).toBe(goods)
    const typed = { ...gridValueOf(WITH_FEE), [BLACK]: { ...gridValueOf(WITH_FEE)[BLACK], '56': 1 } }
    expect(lineWrites(WITH_FEE, typed)).toEqual([{ kind: 'edit', lineId: goods.id, colourwayId: BLACK, sizes: expect.arrayContaining([{ size: '56', quantity: 1 }]) }])
  })
})

describe('the quote record with a fee line draws with no duplicate key', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(['w2b-382-fee-unread', 'w2b-382-fee'])('%s', (id) => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')))
    const model = designScreen.cases.find((item) => item.id === id)!.model
    for (const locale of ['it', 'en'] as const) renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model })))
    expect(errors.filter((line) => /same key/i.test(line))).toEqual([])
  })
})
