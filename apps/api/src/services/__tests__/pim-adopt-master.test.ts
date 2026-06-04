/**
 * B.6 — adopt-master update builder verifier (pure). prisma stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))

import { buildAdoptMasterUpdate } from '../pim/reconcile-divergence.service.js'

describe('buildAdoptMasterUpdate', () => {
  it('well-known field → follow flag + clears its overrideData key', () => {
    expect(buildAdoptMasterUpdate({ title: 'Pinned', color: 'Rosso' }, 'title')).toEqual({
      followMasterTitle: true,
      overrideData: { color: 'Rosso' },
    })
  })

  it('arbitrary attribute → only deletes the overrideData key', () => {
    expect(buildAdoptMasterUpdate({ material: 'Pelle', color: 'Rosso' }, 'material')).toEqual({
      overrideData: { color: 'Rosso' },
    })
  })

  it('well-known with no overrideData key (override was in the *Override column) → just the follow flag', () => {
    expect(buildAdoptMasterUpdate({ color: 'Rosso' }, 'description')).toEqual({
      followMasterDescription: true,
    })
  })

  it('nothing to clear → empty update', () => {
    expect(buildAdoptMasterUpdate({ color: 'Rosso' }, 'material')).toEqual({})
    expect(buildAdoptMasterUpdate(null, 'material')).toEqual({})
  })
})
