import { describe, expect, it } from 'vitest'

import { isSizeNavKey, sizeCanPick, sizeKeyTarget, sizePress, sizeRemainingTotal, sizeState, sizeTabStop, type SizeButton } from './sizeButtonsModel'

const sizes: SizeButton[] = [
  { id: '48', label: '48', remaining: 4 },
  { id: '50', label: '50', remaining: 0 },
  { id: '52', label: '52', remaining: 6, heldReason: 'Non in questo ordine' },
  { id: '54', label: '54', remaining: 2 },
]

describe('size buttons selection (G6)', () => {
  it('a size is open, done at zero, or held with a reason', () => {
    expect(sizes.map(sizeState)).toEqual(['open', 'done', 'held', 'open'])
    expect(sizeState({ id: 'x', label: 'x' })).toBe('open')
    expect(sizeCanPick(sizes[1])).toBe(true)
    expect(sizeCanPick(sizes[2])).toBe(false)
  })

  it('a press picks the size; a held size keeps the current pick; a done size can still be picked', () => {
    expect(sizePress(sizes, null, '48')).toBe('48')
    expect(sizePress(sizes, '48', '52')).toBe('48')
    expect(sizePress(sizes, '48', '50')).toBe('50')
    expect(sizePress(sizes, '48', 'missing')).toBe('48')
  })

  it('one Tab stop: the picked size, else the first that can be picked', () => {
    expect(sizeTabStop(sizes, '54')).toBe('54')
    expect(sizeTabStop(sizes, null)).toBe('48')
    expect(sizeTabStop(sizes, 'gone')).toBe('48')
    expect(sizeTabStop([{ id: 'a', label: 'a', heldReason: 'no' }, { id: 'b', label: 'b' }], null)).toBe('b')
    expect(sizeTabStop([], null)).toBeNull()
  })

  it('arrows move with wrap, mirrored right to left; Home and End go to the ends', () => {
    expect(sizeKeyTarget(sizes, '48', 'ArrowRight')).toBe('50')
    expect(sizeKeyTarget(sizes, '54', 'ArrowRight')).toBe('48')
    expect(sizeKeyTarget(sizes, '48', 'ArrowLeft')).toBe('54')
    expect(sizeKeyTarget(sizes, '48', 'ArrowDown')).toBe('50')
    expect(sizeKeyTarget(sizes, '50', 'ArrowUp')).toBe('48')
    expect(sizeKeyTarget(sizes, '48', 'ArrowRight', 'rtl')).toBe('54')
    expect(sizeKeyTarget(sizes, '48', 'ArrowLeft', 'rtl')).toBe('50')
    expect(sizeKeyTarget(sizes, '52', 'Home')).toBe('48')
    expect(sizeKeyTarget(sizes, '48', 'End')).toBe('54')
    // Moving onto a held size focuses it; it is not picked (sizeCanPick false).
    expect(sizeKeyTarget(sizes, '50', 'ArrowRight')).toBe('52')
    expect(isSizeNavKey('Tab')).toBe(false)
  })

  it('totals what is left', () => {
    expect(sizeRemainingTotal(sizes)).toBe(12)
  })
})
