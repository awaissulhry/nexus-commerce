import { describe, expect, it } from 'vitest'

import { readGridKey, type ReadKeyFacts } from './readGridKeys'

const base: ReadKeyFacts = {
  key: 'Tab', shift: false, modifier: false, composing: false, prevented: false, on: 'cell', selectionCell: false,
  ownKeys: false, controls: 0, index: -1, buttonLike: false, checkbox: false, formGrid: false, opensRows: false,
}
const f = (over: Partial<ReadKeyFacts>): ReadKeyFacts => ({ ...base, ...over })

describe('a reading grid is one stop on the page', () => {
  it('Tab and Shift+Tab leave from a cell, a header or anywhere else in the grid', () => {
    expect(readGridKey(f({ on: 'cell' }))).toEqual({ do: 'leave', back: false })
    expect(readGridKey(f({ on: 'header' }))).toEqual({ do: 'leave', back: false })
    expect(readGridKey(f({ on: 'other', shift: true }))).toEqual({ do: 'leave', back: true })
  })

  it('a form grid (fields in its cells) keeps the browser\'s Tab from field to field', () => {
    expect(readGridKey(f({ formGrid: true }))).toBeNull()
    expect(readGridKey(f({ formGrid: true, on: 'control', controls: 2, index: 0 }))).toBeNull()
  })

  it('never takes a key with Ctrl, ⌘ or Alt, while composing, or one a control already handled', () => {
    expect(readGridKey(f({ modifier: true }))).toBeNull()
    expect(readGridKey(f({ composing: true }))).toBeNull()
    expect(readGridKey(f({ prevented: true, key: 'Escape', on: 'control', controls: 1, index: 0 }))).toBeNull()
  })
})

describe('inside a cell with several controls', () => {
  it('Tab walks them, then leaves the grid; Shift+Tab walks back, then returns to the cell', () => {
    expect(readGridKey(f({ on: 'control', controls: 3, index: 0 }))).toEqual({ do: 'control', to: 1 })
    expect(readGridKey(f({ on: 'control', controls: 3, index: 2 }))).toEqual({ do: 'leave', back: false })
    expect(readGridKey(f({ on: 'control', controls: 3, index: 2, shift: true }))).toEqual({ do: 'control', to: 1 })
    expect(readGridKey(f({ on: 'control', controls: 3, index: 0, shift: true }))).toEqual({ do: 'cell' })
  })

  it('Esc returns to the cell; on the cell itself Esc is not the grid\'s (a dialog around it may close)', () => {
    expect(readGridKey(f({ key: 'Escape', on: 'control', controls: 2, index: 1 }))).toEqual({ do: 'cell' })
    expect(readGridKey(f({ key: 'Escape', on: 'cell', controls: 2 }))).toBeNull()
  })

  it('a focused element the cell does not list (AG\'s row checkbox) counts as the cell', () => {
    expect(readGridKey(f({ on: 'control', controls: 1, index: -1 }))).toEqual({ do: 'leave', back: false })
    expect(readGridKey(f({ key: 'Escape', on: 'control', controls: 1, index: -1 }))).toBeNull()
  })
})

describe('Enter and Space on a cell', () => {
  it('Enter presses the one control, moves into several, opens the row when there is none', () => {
    expect(readGridKey(f({ key: 'Enter', controls: 1 }))).toEqual({ do: 'press' })
    expect(readGridKey(f({ key: 'Enter', controls: 3 }))).toEqual({ do: 'control', to: 0 })
    expect(readGridKey(f({ key: 'Enter', controls: 0, opensRows: true }))).toEqual({ do: 'open' })
    expect(readGridKey(f({ key: 'Enter', controls: 0, opensRows: false }))).toBeNull()
  })

  it('a row\'s tick box: Space ticks it, Enter leaves it alone', () => {
    expect(readGridKey(f({ key: ' ', controls: 1, buttonLike: true, checkbox: true }))).toEqual({ do: 'press' })
    expect(readGridKey(f({ key: 'Enter', controls: 1, buttonLike: true, checkbox: true }))).toBeNull()
  })

  it('Space presses a cell\'s one button, never a link; otherwise Space stays AG\'s (it ticks the row)', () => {
    expect(readGridKey(f({ key: ' ', controls: 1, buttonLike: true }))).toEqual({ do: 'press' })
    expect(readGridKey(f({ key: ' ', controls: 1, buttonLike: false }))).toBeNull()
    expect(readGridKey(f({ key: ' ', controls: 2, buttonLike: true }))).toBeNull()
  })

  it('a column with keys of its own, AG\'s selection cell and a header keep their keys', () => {
    expect(readGridKey(f({ key: 'Enter', controls: 1, ownKeys: true }))).toBeNull()
    expect(readGridKey(f({ key: 'Enter', controls: 0, opensRows: true, selectionCell: true }))).toBeNull()
    expect(readGridKey(f({ key: 'Enter', on: 'header' }))).toBeNull()
  })

  it('Enter or Space on a control inside the cell is the control\'s own', () => {
    expect(readGridKey(f({ key: 'Enter', on: 'control', controls: 2, index: 1 }))).toBeNull()
    expect(readGridKey(f({ key: ' ', on: 'control', controls: 1, index: 0, buttonLike: true }))).toBeNull()
  })

  it('arrows are AG\'s', () => {
    expect(readGridKey(f({ key: 'ArrowDown' }))).toBeNull()
    expect(readGridKey(f({ key: 'ArrowRight', on: 'header' }))).toBeNull()
  })
})
