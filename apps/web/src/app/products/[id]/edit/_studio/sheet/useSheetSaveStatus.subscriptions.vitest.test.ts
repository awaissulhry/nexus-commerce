import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Node hook boundary: count only state/snapshot changes that would schedule the
// adapter. The real writer and tracker supply the save events.
const hooks = vi.hoisted(() => ({
  invalidations: 0,
  effects: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
}))
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useMemo: (make: () => unknown) => make(),
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) },
  useState: (initial: unknown) => {
    let current = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [current, (next: unknown) => {
      const value = typeof next === 'function' ? (next as (old: unknown) => unknown)(current) : next
      if (!Object.is(current, value)) hooks.invalidations++
      current = value
    }]
  },
  useSyncExternalStore: (subscribe: (fn: () => void) => () => void, snapshot: () => unknown) => {
    let current = snapshot()
    hooks.cleanups.push(subscribe(() => {
      const next = snapshot()
      if (!Object.is(current, next)) hooks.invalidations++
      current = next
    }))
    return current
  },
}))

import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { SheetWriter } from '@/design-system/grid/editors/sheetWriter'
import { useSheetSaveStatus } from './useSheetSaveStatus'

beforeEach(() => { hooks.invalidations = 0; hooks.effects = []; hooks.cleanups = [] })
afterEach(() => { for (const cleanup of hooks.cleanups) cleanup() })

describe('save events at the sheet adapter boundary', () => {
  it('keeps the adapter asleep during a pending, saving and confirmed write', async () => {
    const tracker = new CellSaveTracker()
    const row = { id: 'row-a', parentId: null, version: 1, values: {} }
    const writer = new SheetWriter<typeof row>({ tracker, getApi: () => null, commit: async () => ({ ok: true, version: 2 }) })
    writer.seed([{ id: row.id, version: row.version, row }])
    useSheetSaveStatus(writer, tracker, [row], [{ key: 'subtitle' }])
    for (const effect of hooks.effects) {
      const cleanup = effect()
      if (cleanup) hooks.cleanups.push(cleanup)
    }
    hooks.invalidations = 0
    try {
      writer.set(row.id, 'subtitle', 'A new subtitle')
      await writer.flush()
      expect(tracker.get(row.id, 'subtitle')?.state).toBe('saved')
      expect(hooks.invalidations).toBe(0)
    } finally { writer.destroy() }
  })
})
