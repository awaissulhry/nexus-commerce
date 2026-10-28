import { describe, expect, it } from 'vitest'

import { createLayerStack, ownsKeys, returnFocusOrder } from './modalStack'

describe('modal stack', () => {
  it('puts the dialog opened last on top, and the one under it back on top when it closes', () => {
    const stack = createLayerStack<string>()
    stack.push('detail')
    expect(stack.top()).toBe('detail')
    stack.push('review')
    expect(stack.layers()).toEqual(['detail', 'review'])
    expect(stack.isTop('review')).toBe(true)
    expect(stack.isTop('detail')).toBe(false)
    stack.remove('review')
    expect(stack.top()).toBe('detail')
    stack.remove('detail')
    expect(stack.top()).toBeUndefined()
    expect(stack.isTop('detail')).toBe(false)
  })

  it('takes a lower dialog out from the middle without moving the top', () => {
    const stack = createLayerStack<string>()
    stack.push('a'); stack.push('b'); stack.push('c')
    stack.remove('b')
    expect(stack.layers()).toEqual(['a', 'c'])
    expect(stack.top()).toBe('c')
    stack.remove('missing')
    expect(stack.size()).toBe(2)
  })

  it('moves a dialog opened again to the top instead of listing it twice', () => {
    const stack = createLayerStack<string>()
    stack.push('a'); stack.push('b'); stack.push('a')
    expect(stack.layers()).toEqual(['b', 'a'])
    expect(stack.has('b')).toBe(true)
  })
})

describe('Esc goes to the top dialog only', () => {
  it('lets only the top dialog answer a key', () => {
    const stack = createLayerStack<string>()
    stack.push('detail'); stack.push('review')
    expect(ownsKeys(stack, 'review')).toBe(true)
    expect(ownsKeys(stack, 'detail')).toBe(false)
    stack.remove('review')
    expect(ownsKeys(stack, 'detail')).toBe(true)
  })

  it('stays out when a drawer or builder covers it, or the key was already handled', () => {
    const stack = createLayerStack<string>()
    stack.push('detail')
    expect(ownsKeys(stack, 'detail', { coveredByOther: true })).toBe(false)
    expect(ownsKeys(stack, 'detail', { handled: true })).toBe(false)
    expect(ownsKeys(stack, 'closed')).toBe(false)
  })
})

describe('where the focus goes on close', () => {
  it('tries the host\'s choice, then the opener, then the dialog now on top', () => {
    expect(returnFocusOrder({ override: 'cell', opener: 'button', below: 'detail' })).toEqual(['cell', 'button', 'detail'])
    expect(returnFocusOrder({ opener: 'button', below: 'detail' })).toEqual(['button', 'detail'])
  })

  it('reads a function at close time (a re-rendered grid cell)', () => {
    let cell = 'cell-old'
    const override = () => cell
    cell = 'cell-new'
    expect(returnFocusOrder({ override, opener: 'button' })).toEqual(['cell-new', 'button'])
    expect(returnFocusOrder<string>({ override: () => null, opener: 'button' })).toEqual(['button'])
  })

  it('drops blanks and repeats; with nothing to go to it is empty (the page keeps the focus)', () => {
    expect(returnFocusOrder({ override: null, opener: 'detail', below: 'detail' })).toEqual(['detail'])
    expect(returnFocusOrder({})).toEqual([])
  })
})
