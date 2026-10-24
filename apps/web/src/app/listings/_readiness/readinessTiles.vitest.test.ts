import { describe, expect, it } from 'vitest'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'
import { READINESS_TILES, listingsInView, stateForTile, tileAccent, tileCount, tileHint, tileLabel, tileOfState } from './readinessTiles'

const stats = { blocked: 310, warn: 420, notComputed: 30, absent: 100, ready: 380, all: 1240 }

describe('the tiles ⇄ the state', () => {
  it('each state lights its tile; older states sit under Not checked', () => {
    expect(tileOfState('')).toBe('all')
    expect(tileOfState('blocked')).toBe('blocked')
    expect(tileOfState('warn')).toBe('warn')
    expect(tileOfState('ready')).toBe('ready')
    expect(tileOfState('notChecked')).toBe('notChecked')
    expect(tileOfState('absent')).toBe('notChecked')
    expect(tileOfState('notComputed')).toBe('notChecked')
  })
  it('a click turns a tile on, the lit tile off, and All always clears', () => {
    expect(stateForTile('', 'blocked')).toBe('blocked')
    expect(stateForTile('blocked', 'blocked')).toBe('')
    expect(stateForTile('blocked', 'warn')).toBe('warn')
    expect(stateForTile('warn', 'all')).toBe('')
    expect(stateForTile('', 'notChecked')).toBe('notChecked')
    expect(stateForTile('absent', 'notChecked')).toBe('')
  })
  it('the numbers are the API’s stats; Not checked is Not set up + Not computed', () => {
    expect(READINESS_TILES.map((t) => tileCount(stats, t))).toEqual([1240, 310, 420, 380, 130])
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
  it('Blocked, Warnings, Ready come from readinessMeta', () => {
    expect(tileLabel('blocked')).toBe(readinessMeta('blocked', 'scope').label)
    expect(tileLabel('warn')).toBe(readinessMeta('warn', 'scope').label)
    expect(tileLabel('ready')).toBe(readinessMeta('ready', 'scope').label)
    expect(tileLabel('all')).toBe('All')
    expect(tileLabel('notChecked')).toBe('Not checked')
  })
  it('Not checked says what it holds', () => {
    expect(tileHint('notChecked')).toBe('not set up or not computed')
  })
  it('the dots follow the readiness tones', () => {
    expect(tileAccent('blocked')).toBe('var(--nds-danger)')
    expect(tileAccent('warn')).toBe('var(--nds-warning)')
    expect(tileAccent('ready')).toBe('var(--nds-success)')
    expect(tileAccent('all')).toBe('var(--nds-primary)')
  })
})
