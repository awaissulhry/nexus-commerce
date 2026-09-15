import { afterEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  cleanup: null as (() => void) | null,
  scopeGuard: null as (() => boolean) | null,
}))

vi.mock('react', () => ({
  useEffect: (effect: () => () => void) => { lifecycle.cleanup = effect() },
}))

vi.mock('../contracts', () => ({
  usePublicationSave: () => ({ registerPublicationBarrier: () => vi.fn() }),
  useStudioScope: () => ({
    registerScopeChangeGuard: (guard: () => boolean) => {
      lifecycle.scopeGuard = guard
      return vi.fn()
    },
  }),
}))

import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { useSheetPublicationGuard } from './useSheetPublicationGuard'

describe('sheet scope-change guard', () => {
  afterEach(() => {
    lifecycle.cleanup?.()
    lifecycle.cleanup = null
    lifecycle.scopeGuard = null
  })

  it.each(['saving', 'waiting', 'refused', 'unknown'] as const)(
    'keeps a %s cell on its current destination for review',
    (state) => {
      const tracker = new CellSaveTracker()
      tracker.set('row-1', 'title', state, state === 'refused' ? 'The server refused this value.' : undefined)

      useSheetPublicationGuard(
        { flush: async () => {}, pending: 0, unknownCount: 0 },
        tracker,
        () => ({ getEditingCells: () => [] }),
      )

      expect(lifecycle.scopeGuard?.()).toBe(false)
    },
  )

  it('permits a destination change after the only tracked cell is confirmed saved', () => {
    const tracker = new CellSaveTracker()
    tracker.set('row-1', 'title', 'saved')

    useSheetPublicationGuard(
      { flush: async () => {}, pending: 0, unknownCount: 0 },
      tracker,
      () => ({ getEditingCells: () => [] }),
    )

    expect(lifecycle.scopeGuard?.()).toBe(true)
  })
})
