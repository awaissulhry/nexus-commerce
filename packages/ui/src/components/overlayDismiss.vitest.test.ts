import { describe, expect, it } from 'vitest'

import { createBackdropPress, escapeBelongsToGrid, GRID_OWNED_ESCAPE, watchGridEscape } from './overlayDismiss'

describe('a backdrop closes its dialog only for a press that starts and ends on it', () => {
  it('closes for a plain click on the dimmed area', () => {
    const press = createBackdropPress()
    press.down(true); press.up(true)
    expect(press.clickCloses(true)).toBe(true)
  })

  it('stays open when a drag starts in the dialog and is let go over the dimmed area (column resize, text selection)', () => {
    const press = createBackdropPress()
    press.down(false); press.up(true)
    // The browser clicks the backdrop: it is the nearest element holding both the press and the release.
    expect(press.clickCloses(true)).toBe(false)
  })

  it('stays open when a press starts on the dimmed area and is let go inside the dialog', () => {
    const press = createBackdropPress()
    press.down(true); press.up(false)
    expect(press.clickCloses(true)).toBe(false)
  })

  it('stays open for a click inside the dialog', () => {
    const press = createBackdropPress()
    press.down(false); press.up(false)
    expect(press.clickCloses(false)).toBe(false)
  })

  it('uses a press up: a click with no press before it never closes', () => {
    const press = createBackdropPress()
    press.down(true); press.up(true)
    expect(press.clickCloses(true)).toBe(true)
    expect(press.clickCloses(true)).toBe(false)
  })

  it('forgets an old release when a new press starts', () => {
    const press = createBackdropPress()
    press.down(true); press.up(true)
    press.down(true)
    expect(press.clickCloses(true)).toBe(false)
  })
})

/** A stand-in element: `closest` answers for the selectors it sits inside. */
const inside = (...selectors: string[]) => ({
  closest: (selector: string) => (selector.split(',').map(part => part.trim()).some(part => selectors.includes(part)) ? {} : null),
})

describe('Esc that starts in a grid’s own popup or editor belongs to the grid', () => {
  it('names the grid’s popups and the cell being edited', () => {
    expect(GRID_OWNED_ESCAPE.split(',').map(part => part.trim())).toEqual(['.ag-popup', '.ag-popup-editor', '.ag-cell-inline-editing'])
  })

  it('is the grid’s in a column menu, a filter or a right-click menu', () => {
    expect(escapeBelongsToGrid(inside('.ag-popup') as unknown as EventTarget)).toBe(true)
  })

  it('is the grid’s in a cell being edited, inline or in a popup editor', () => {
    expect(escapeBelongsToGrid(inside('.ag-cell-inline-editing') as unknown as EventTarget)).toBe(true)
    expect(escapeBelongsToGrid(inside('.ag-popup-editor') as unknown as EventTarget)).toBe(true)
  })

  it('is the dialog’s anywhere else, also on a grid cell that is not being edited', () => {
    expect(escapeBelongsToGrid(inside('.ag-cell') as unknown as EventTarget)).toBe(false)
    expect(escapeBelongsToGrid(inside() as unknown as EventTarget)).toBe(false)
    expect(escapeBelongsToGrid(null)).toBe(false)
    expect(escapeBelongsToGrid({} as EventTarget)).toBe(false)
  })
})

describe('the capture-phase watch', () => {
  it('marks an Esc from a grid popup before any bubble listener reads it, and lets go when stopped', () => {
    const listeners: Array<{ fn: (event: KeyboardEvent) => void; capture: boolean }> = []
    const doc = {
      addEventListener: (_type: string, fn: (event: KeyboardEvent) => void, capture?: boolean) => { listeners.push({ fn, capture: !!capture }) },
      removeEventListener: (_type: string, fn: (event: KeyboardEvent) => void) => { listeners.splice(listeners.findIndex(l => l.fn === fn), 1) },
    } as unknown as Document
    const watch = watchGridEscape(doc)
    expect(listeners).toHaveLength(1)
    expect(listeners[0]!.capture).toBe(true)

    const fromMenu = { key: 'Escape', target: inside('.ag-popup') } as unknown as KeyboardEvent
    const fromCell = { key: 'Escape', target: inside('.ag-cell') } as unknown as KeyboardEvent
    const enterInMenu = { key: 'Enter', target: inside('.ag-popup') } as unknown as KeyboardEvent
    for (const event of [fromMenu, fromCell, enterInMenu]) listeners[0]!.fn(event)
    expect(watch.owns(fromMenu)).toBe(true)
    expect(watch.owns(fromCell)).toBe(false)
    expect(watch.owns(enterInMenu)).toBe(false)

    watch.stop()
    expect(listeners).toHaveLength(0)
  })
})
