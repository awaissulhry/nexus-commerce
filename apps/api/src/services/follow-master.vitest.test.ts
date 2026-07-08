/**
 * Phase 0 — the pure follow/pin write shape. This is the load-bearing logic
 * (what gets written to each listing); it must be exactly right.
 */
import { describe, it, expect } from 'vitest'
import { computeFollowMasterWrite, computeStockBufferWrite } from './follow-master.service.js'

describe('computeFollowMasterWrite — FOLLOW (rejoin pool)', () => {
  it('clears the override and publishes the pool-available quantity', () => {
    expect(computeFollowMasterWrite({ quantity: 3, quantityOverride: 0 }, true, 42)).toEqual({
      quantity: 42, quantityOverride: null, followMasterQuantity: true,
    })
  })
  it('clamps a negative pool to 0', () => {
    expect(computeFollowMasterWrite({ quantity: 5, quantityOverride: null }, true, -7)).toEqual({
      quantity: 0, quantityOverride: null, followMasterQuantity: true,
    })
  })
})

describe('computeFollowMasterWrite — PIN (snapshot, all three columns coherent)', () => {
  it('snapshots the current base quantity into quantity AND quantityOverride', () => {
    // Was following (override null), pool says 42, base quantity 42 → pin holds 42.
    expect(computeFollowMasterWrite({ quantity: 42, quantityOverride: null }, false, 42)).toEqual({
      quantity: 42, quantityOverride: 42, followMasterQuantity: false,
    })
  })
  it('prefers the base quantity (what the save just wrote) over a stale override', () => {
    // e.g. the flat-file save wrote base quantity=99; a stale override=5 must NOT win.
    expect(computeFollowMasterWrite({ quantity: 99, quantityOverride: 5 }, false, 42)).toEqual({
      quantity: 99, quantityOverride: 99, followMasterQuantity: false,
    })
  })
  it('falls back to override when base quantity is null', () => {
    expect(computeFollowMasterWrite({ quantity: null, quantityOverride: 7 }, false, 42)).toEqual({
      quantity: 7, quantityOverride: 7, followMasterQuantity: false,
    })
  })
  it('falls back to pool-available when both quantity and override are null', () => {
    expect(computeFollowMasterWrite({ quantity: null, quantityOverride: null }, false, 12)).toEqual({
      quantity: 12, quantityOverride: 12, followMasterQuantity: false,
    })
  })
  it('a pin of 0 stays 0 (does not fall through to pool) — override 0 is a real value', () => {
    expect(computeFollowMasterWrite({ quantity: 0, quantityOverride: 0 }, false, 42)).toEqual({
      quantity: 0, quantityOverride: 0, followMasterQuantity: false,
    })
  })
  it('clamps a negative snapshot to 0', () => {
    expect(computeFollowMasterWrite({ quantity: -3, quantityOverride: null }, false, 5)).toEqual({
      quantity: 0, quantityOverride: 0, followMasterQuantity: false,
    })
  })
})

describe('computeStockBufferWrite — Phase 4 (buffer only shapes FOLLOWING listings)', () => {
  it('a FOLLOWING listing republishes pool − buffer and pushes it', () => {
    // warehouse 10, buffer 2 → publish 8. Following ⇒ override cleared.
    expect(computeStockBufferWrite(
      { quantity: 10, quantityOverride: null, followMasterQuantity: true, stockBuffer: 0 }, 2, 10,
    )).toEqual({ stockBuffer: 2, quantity: 8, quantityOverride: null, followMasterQuantity: true, pushQuantity: 8 })
  })
  it('followMasterQuantity null is treated as following', () => {
    expect(computeStockBufferWrite(
      { quantity: 10, quantityOverride: null, followMasterQuantity: null, stockBuffer: 0 }, 3, 10,
    )).toEqual({ stockBuffer: 3, quantity: 7, quantityOverride: null, followMasterQuantity: true, pushQuantity: 7 })
  })
  it('a buffer larger than the pool clamps the published quantity to 0', () => {
    expect(computeStockBufferWrite(
      { quantity: 1, quantityOverride: null, followMasterQuantity: true, stockBuffer: 0 }, 5, 1,
    )).toEqual({ stockBuffer: 5, quantity: 0, quantityOverride: null, followMasterQuantity: true, pushQuantity: 0 })
  })
  it('a PINNED listing stores the buffer but leaves its fixed quantity + override untouched (no push)', () => {
    expect(computeStockBufferWrite(
      { quantity: 5, quantityOverride: 5, followMasterQuantity: false, stockBuffer: 0 }, 2, 10,
    )).toEqual({ stockBuffer: 2, quantity: 5, quantityOverride: 5, followMasterQuantity: false, pushQuantity: null })
  })
  it('clamps a negative buffer to 0', () => {
    expect(computeStockBufferWrite(
      { quantity: 10, quantityOverride: null, followMasterQuantity: true, stockBuffer: 3 }, -4, 10,
    )).toEqual({ stockBuffer: 0, quantity: 10, quantityOverride: null, followMasterQuantity: true, pushQuantity: 10 })
  })
})
