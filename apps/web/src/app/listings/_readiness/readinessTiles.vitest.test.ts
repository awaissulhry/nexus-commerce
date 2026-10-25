import { describe, expect, it } from 'vitest'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { READINESS_TILES, listingsInView, stateForTile, tileAccent, tileCount, tileHint, tileIsLit, tileLabel, visibleTiles } from './readinessTiles'

const stats = { blocked: 310, warn: 420, notComputed: 30, absent: 100, ready: 380, all: 1240 }

describe('the tiles ⇄ the state', () => {
  it('each state lights its own tile; an older link\'s notChecked lights both grey tiles', () => {
    expect(READINESS_TILES.filter((t) => tileIsLit('', t))).toEqual(['all'])
    expect(READINESS_TILES.filter((t) => tileIsLit('blocked', t))).toEqual(['blocked'])
    expect(READINESS_TILES.filter((t) => tileIsLit('warn', t))).toEqual(['warn'])
    expect(READINESS_TILES.filter((t) => tileIsLit('ready', t))).toEqual(['ready'])
    expect(READINESS_TILES.filter((t) => tileIsLit('absent', t))).toEqual(['absent'])
    expect(READINESS_TILES.filter((t) => tileIsLit('notComputed', t))).toEqual(['notComputed'])
    expect(READINESS_TILES.filter((t) => tileIsLit('notChecked', t))).toEqual(['absent', 'notComputed'])
  })
  it('a click turns a tile on, the lit tile off, and All always clears', () => {
    expect(stateForTile('', 'blocked')).toBe('blocked')
    expect(stateForTile('blocked', 'blocked')).toBe('')
    expect(stateForTile('blocked', 'warn')).toBe('warn')
    expect(stateForTile('warn', 'all')).toBe('')
    expect(stateForTile('', 'absent')).toBe('absent')
    expect(stateForTile('absent', 'absent')).toBe('')
    expect(stateForTile('notChecked', 'absent')).toBe('')
    expect(stateForTile('absent', 'notComputed')).toBe('notComputed')
  })
  it('the numbers are the API’s stats, one state per tile', () => {
    expect(READINESS_TILES.map((t) => tileCount(stats, t))).toEqual([1240, 310, 420, 380, 100, 30])
  })
  it('Not computed shows only while it counts something, or while it is the filter in use', () => {
    expect(visibleTiles(stats, '')).toEqual(['all', 'blocked', 'warn', 'ready', 'absent', 'notComputed'])
    expect(visibleTiles({ ...stats, notComputed: 0 }, '')).toEqual(['all', 'blocked', 'warn', 'ready', 'absent'])
    expect(visibleTiles({ ...stats, notComputed: 0 }, 'notComputed')).toContain('notComputed')
    expect(visibleTiles(null, '')).toEqual(['all', 'blocked', 'warn', 'ready', 'absent'])
  })
  it('the toolbar counts the listings under the current state', () => {
    expect(listingsInView(stats, '')).toBe(1240)
    expect(listingsInView(stats, 'warn')).toBe(420)
    expect(listingsInView(stats, 'notChecked')).toBe(130)
    expect(listingsInView(stats, 'absent')).toBe(100)
    expect(listingsInView(stats, 'notComputed')).toBe(30)
  })
})

describe('the tiles’ words are the design system’s', () => {
  it('every state tile uses readinessMeta: one state, one name, as on the chips', () => {
    for (const state of ['blocked', 'warn', 'ready', 'absent', 'notComputed'] as const) expect(tileLabel(state)).toBe(readinessMeta(state, 'scope').label)
    expect(tileLabel('all')).toBe('All')
    expect(tileLabel('absent')).toBe('Not set up')
    expect(tileLabel('notComputed')).toBe('Not computed')
  })
  it('the grey tiles say what they hold', () => {
    expect(tileHint('absent')).toBe('nothing set up yet')
    expect(tileHint('notComputed')).toBe('checked within minutes')
  })
  it('the dots follow the readiness tones', () => {
    expect(tileAccent('blocked')).toBe('var(--nds-danger)')
    expect(tileAccent('warn')).toBe('var(--nds-warning)')
    expect(tileAccent('ready')).toBe('var(--nds-success)')
    expect(tileAccent('all')).toBe('var(--nds-primary)')
  })
})
