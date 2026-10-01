import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ i: 0, state: [false, null] as unknown[], effects: [] as Array<() => void>, changes: 0, saved: { current: false } }))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useRef: () => hooks.saved,
  useState: () => {
    const at = hooks.i++
    return [hooks.state[at], (value: unknown) => {
      if (!Object.is(hooks.state[at], value)) hooks.changes++
      hooks.state[at] = value
    }]
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect) },
}))

import { useSheetShortcutHint } from './SheetFooterNote'

beforeEach(() => { hooks.i = 0; hooks.state = [false, null]; hooks.effects = []; hooks.changes = 0; hooks.saved = { current: false } })

describe('the first confirmed save retires the shortcut hint', () => {
  it('draws the retired hint immediately, with no second state update after the save', () => {
    expect(useSheetShortcutHint('2026-09-30T10:00:00Z')).toMatchObject({ showHint: false, showHelp: true })
    for (const effect of hooks.effects) effect()
    expect(hooks.changes).toBe(0)
  })

  it.each(['pending', 'refused', 'unknown'])('keeps help when a %s write has no confirmed save time', () => {
    expect(useSheetShortcutHint(null)).toMatchObject({ showHint: true, showHelp: true })
  })

  it('keeps an explicit request to show the shortcuts after a save', () => {
    hooks.state = [false, true]
    expect(useSheetShortcutHint('2026-09-30T10:00:00Z')).toMatchObject({ showHint: true, showHelp: true })
  })

  it('stays retired when the footer changes to a scope that has not saved yet', () => {
    useSheetShortcutHint('2026-09-30T10:00:00Z')
    hooks.i = 0
    expect(useSheetShortcutHint(null)).toMatchObject({ showHint: false, showHelp: true })
  })
})
