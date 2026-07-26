/**
 * SCT.4 — the Amazon EU shared-quantity guard. This is the never-again test
 * for the 2026-07-26 storewide zero: 302 market-scoped Zero & Pins on DE/ES/FR
 * each pushed 0 into the ONE quantity Amazon keeps per SKU across the EU,
 * blanking IT — the primary market — for every affected product.
 */

import { describe, expect, it } from 'vitest'
import {
  AMAZON_EU_SHARED_MARKETS,
  detectEuIntentConflict,
  intentOf,
  projectActionAndDetect,
} from './amazon-eu-quantity-guard.js'

const follow = (mkt: string, over: object = {}) => ({
  marketplace: mkt, followMasterQuantity: true as boolean | null,
  quantityOverride: null as number | null, quantity: 5 as number | null, ...over,
})
const pinned = (mkt: string, v: number, over: object = {}) => ({
  marketplace: mkt, followMasterQuantity: false as boolean | null,
  quantityOverride: v as number | null, quantity: v as number | null, ...over,
})

describe('detectEuIntentConflict — the incident shape', () => {
  it('IT follow vs DE/ES/FR pinned@0 = CONFLICT (the 18:42 storewide zero)', () => {
    const v = detectEuIntentConflict([follow('IT'), pinned('DE', 0), pinned('ES', 0), pinned('FR', 0)])
    expect(v.conflict).toBe(true)
    expect(v.detail).toMatch(/IT follow the pool/)
    expect(v.detail).toMatch(/DE is pinned at 0/)
  })

  it('all FOLLOW = aligned (the restored state)', () => {
    expect(detectEuIntentConflict([follow('IT'), follow('DE'), follow('ES'), follow('FR')]).conflict).toBe(false)
  })

  it('all pinned at the SAME value = aligned (an explicit account-wide stop)', () => {
    expect(detectEuIntentConflict([pinned('IT', 0), pinned('DE', 0), pinned('ES', 0)]).conflict).toBe(false)
  })

  it('pins at DIFFERENT values = conflict', () => {
    const v = detectEuIntentConflict([pinned('IT', 5), pinned('DE', 0)])
    expect(v.conflict).toBe(true)
    expect(v.detail).toMatch(/different values/)
  })

  it('a single EU row can never conflict', () => {
    expect(detectEuIntentConflict([pinned('IT', 0)]).conflict).toBe(false)
  })

  it('FBA rows are Amazon-managed and never participate', () => {
    expect(detectEuIntentConflict([follow('IT'), pinned('DE', 0, { isFba: true })]).conflict).toBe(false)
  })

  it('PAUSED rows express no live intent', () => {
    expect(detectEuIntentConflict([follow('IT'), pinned('DE', 0, { syncPaused: true })]).conflict).toBe(false)
  })

  it('non-EU marketplaces are out of scope', () => {
    expect(intentOf({ marketplace: 'US', followMasterQuantity: false, quantityOverride: 0, quantity: 0 })).toBeNull()
    expect(AMAZON_EU_SHARED_MARKETS.has('IT')).toBe(true)
    expect(AMAZON_EU_SHARED_MARKETS.has('US')).toBe(false)
  })
})

describe('projectActionAndDetect — the pre-write projection', () => {
  const allFollow = [follow('IT'), follow('DE'), follow('ES'), follow('FR')]

  it('REFUSES the incident: ZERO_PIN on DE/ES/FR while IT stays follow', () => {
    const v = projectActionAndDetect(allFollow, new Set(['DE', 'ES', 'FR']), 'ZERO_PIN')
    expect(v.conflict).toBe(true)
  })

  it('allows ZERO_PIN on ALL EU markets (explicit account-wide stop)', () => {
    const v = projectActionAndDetect(allFollow, new Set(['IT', 'DE', 'ES', 'FR']), 'ZERO_PIN')
    expect(v.conflict).toBe(false)
  })

  it('REFUSES FOLLOW on IT alone while DE stays pinned@0 (the tug-of-war other direction)', () => {
    const rows = [follow('IT'), pinned('DE', 0)]
    const v = projectActionAndDetect(rows, new Set(['IT']), 'FOLLOW')
    expect(v.conflict).toBe(true)
  })

  it('allows FOLLOW across every EU market (the incident RESTORE itself)', () => {
    const rows = [follow('IT'), pinned('DE', 0), pinned('ES', 0), pinned('FR', 0)]
    const v = projectActionAndDetect(rows, new Set(['DE', 'ES', 'FR']), 'FOLLOW')
    expect(v.conflict).toBe(false)
  })

  it('single-market products stay freely controllable', () => {
    const v = projectActionAndDetect([follow('IT')], new Set(['IT']), 'ZERO_PIN')
    expect(v.conflict).toBe(false)
  })
})
