import { describe, expect, it } from 'vitest'
import { actionCellKeys, ownerCellKeys, placeCellKeys } from './ownerKeys'

/** A focused cell with (or without) the owner's link and the "+N" list. */
function cell(opts: { link?: boolean; more?: boolean; on?: 'link' | 'more' }) {
  const clicked: string[] = []
  const link = opts.link ? { click: () => clicked.push('link') } : null
  const more = opts.more ? { click: () => clicked.push('more') } : null
  const target = {
    closest: (sel: string) => (opts.on === 'link' && sel.includes('a[href]')) || (opts.on === 'more' && sel.includes('data-cell-detail-trigger')) ? {} : null,
    querySelector: (sel: string) => (sel.includes('a[href]') ? link : more),
  }
  return { target, clicked }
}
const key = (k: string, target: unknown, extra: { shiftKey?: boolean; type?: string } = {}) => ({ event: { key: k, target, type: 'keydown', preventDefault: () => {}, ...extra }, editing: false })

describe('the Who sets it cell\'s keys', () => {
  it('follows the owner\'s chip on Enter (its rule\'s link, or the Brain\'s Why)', () => {
    const c = cell({ link: true, more: true })
    expect(ownerCellKeys(key('Enter', c.target))).toBe(true)
    expect(c.clicked).toEqual(['link'])
  })

  it('opens the "+N" list on Space and Shift+Enter, and on Enter when the owner has no page', () => {
    const a = cell({ link: true, more: true })
    ownerCellKeys(key(' ', a.target))
    ownerCellKeys(key('Enter', a.target, { shiftKey: true }))
    expect(a.clicked).toEqual(['more', 'more'])
    const b = cell({ more: true })
    ownerCellKeys(key('Enter', b.target))
    expect(b.clicked).toEqual(['more'])
  })

  it('lets Enter through when the cell has neither (the panel opens), and leaves other keys to the grid', () => {
    const c = cell({})
    expect(ownerCellKeys(key('Enter', c.target))).toBe(false)
    expect(ownerCellKeys(key('ArrowRight', cell({ link: true }).target))).toBe(false)
  })

  it('keeps a focused link\'s or list\'s own keys, and acts once (keydown, not keypress)', () => {
    expect(ownerCellKeys(key('Enter', cell({ link: true, on: 'link' }).target))).toBe(true)
    expect(ownerCellKeys(key(' ', cell({ more: true, on: 'more' }).target))).toBe(true)
    const c = cell({ link: true })
    expect(ownerCellKeys(key('Enter', c.target, { type: 'keypress' }))).toBe(true)
    expect(c.clicked).toEqual([])
  })
})

describe('the Campaign · Ad group cell\'s keys', () => {
  const twoLinks = (on = false) => {
    const clicked: string[] = []
    const links = [{ click: () => clicked.push('campaign') }, { click: () => clicked.push('ad group') }]
    return { clicked, target: { closest: (sel: string) => (on && sel === 'a[href]' ? {} : null), querySelectorAll: () => links } }
  }

  it('follows the campaign on Enter and the ad group on Shift+Enter', () => {
    const c = twoLinks()
    expect(placeCellKeys(key('Enter', c.target))).toBe(true)
    expect(placeCellKeys(key('Enter', c.target, { shiftKey: true }))).toBe(true)
    expect(c.clicked).toEqual(['campaign', 'ad group'])
  })

  it('keeps a focused link\'s keys and leaves every other key to the grid', () => {
    expect(placeCellKeys(key('Enter', twoLinks(true).target))).toBe(true)
    const c = twoLinks()
    expect(placeCellKeys(key('ArrowDown', c.target))).toBe(false)
    expect(c.clicked).toEqual([])
  })
})

describe('the Suggested cell\'s keys', () => {
  it('presses Apply on Enter; a cell without Apply lets Enter through; a focused Apply keeps its own keys', () => {
    const clicked: string[] = []
    const withApply = { closest: () => null, querySelector: () => ({ click: () => clicked.push('apply') }) }
    expect(actionCellKeys(key('Enter', withApply))).toBe(true)
    expect(clicked).toEqual(['apply'])
    expect(actionCellKeys(key('Enter', { closest: () => null, querySelector: () => null }))).toBe(false)
    expect(actionCellKeys(key('Enter', { closest: () => ({}), querySelector: () => null }))).toBe(true)
  })
})
