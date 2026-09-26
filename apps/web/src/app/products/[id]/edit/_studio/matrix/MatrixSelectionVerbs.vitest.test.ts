/**
 * The Matrix verbs in the toolbar (2026-09-26): grouped into three menus by what they change, a hidden verb never
 * offered, a group with nothing offered not drawn, and a verb nobody grouped still reachable under "More".
 */
import { describe, expect, it } from 'vitest'
import { MATRIX_VERB_GROUPS, matrixVerbMenus } from './MatrixSelectionVerbs'

const verb = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, row: false, collect: null, ...extra }) as never

describe('matrixVerbMenus', () => {
  it('groups the eleven verbs into Prices, Stock and Sync, in declaration order', () => {
    const all = MATRIX_VERB_GROUPS.flatMap(g => g.verbs).map(id => verb(id))
    expect(all).toHaveLength(11)
    const menus = matrixVerbMenus(all)
    expect(menus.map(m => [m.label, m.verbs.map((v: { id: string }) => v.id)])).toEqual([
      ['Prices', ['set-price', 'adjust-prices', 'copy-prices']],
      ['Stock', ['pin-quantity', 'set-follow', 'set-buffer', 'set-fulfilment']],
      ['Sync', ['pause-sync', 'resume-sync', 'push-now', 'retry-sync']],
    ])
  })
  it('never offers a hidden verb, and draws no empty group', () => {
    const menus = matrixVerbMenus([verb('set-price', { hidden: true }), verb('adjust-prices', { hidden: true }), verb('copy-prices', { hidden: true }), verb('push-now')])
    expect(menus.map(m => m.label)).toEqual(['Sync'])
  })
  it('keeps a held verb (its reason is the menu line), and puts an ungrouped verb under More', () => {
    const menus = matrixVerbMenus([verb('pin-quantity', { unavailable: 'Nothing in this selection carries inventory.' }), verb('archive-listing')])
    expect(menus.map(m => m.label)).toEqual(['Stock', 'More'])
    expect(menus[0].verbs[0]).toMatchObject({ unavailable: 'Nothing in this selection carries inventory.' })
  })
})
