import { describe, expect, it } from 'vitest'

import { applyElementProps, splitElementProps } from './rowDom'

describe('splitElementProps — what of a React props bag becomes attributes, classes, inline style', () => {
  it('strings and numbers are attributes, true is the empty attribute, handlers and false/null/undefined are not', () => {
    const s = splitElementProps({
      'data-item': 'c1', title: 'Campaign', 'aria-expanded': true, tabIndex: 0, hidden: false, role: null, id: undefined,
      onClick: () => undefined, onDragOver: () => undefined, children: 'x', key: 'k',
    })
    expect(s.attrs).toEqual({ 'data-item': 'c1', title: 'Campaign', 'aria-expanded': '', tabIndex: '0' })
    expect(s.classes).toEqual([])
    expect(s.style).toEqual({})
  })
  it('className splits into classes; style keeps string and finite number values', () => {
    const s = splitElementProps({ className: ' hl-pb-r  is-open ', style: { cursor: 'pointer', opacity: 0.5, height: NaN, weird: {} } })
    expect(s.classes).toEqual(['hl-pb-r', 'is-open'])
    expect(s.style).toEqual({ cursor: 'pointer', opacity: '0.5' })
  })
  it('nothing in, nothing out', () => {
    expect(splitElementProps(undefined)).toEqual({ attrs: {}, style: {}, classes: [] })
    expect(splitElementProps(null)).toEqual({ attrs: {}, style: {}, classes: [] })
  })
})

/** A minimal element: attributes, a style bag, a classList. */
function fakeElement() {
  const attrs = new Map<string, string>()
  const classes = new Set<string>()
  const style: Record<string, string> = {}
  return {
    attrs, classes, style,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => { attrs.set(k, v) },
    removeAttribute: (k: string) => { attrs.delete(k) },
    classList: { add: (c: string) => { classes.add(c) }, remove: (c: string) => { classes.delete(c) } },
  }
}

describe('applyElementProps — applies the diff and takes back only what it applied', () => {
  it('sets, updates, removes attributes / style / classes across three renders', () => {
    const el = fakeElement()
    const target = el as unknown as HTMLElement
    const s1 = applyElementProps(target, { attrs: { title: 'A', 'data-x': '1' }, style: { cursor: 'pointer' }, classes: ['sel', 'off'] }, undefined)
    expect([...el.attrs]).toEqual([['title', 'A'], ['data-x', '1']])
    expect(el.style).toEqual({ cursor: 'pointer' })
    expect([...el.classes]).toEqual(['sel', 'off'])
    const s2 = applyElementProps(target, { attrs: { title: 'B' }, style: {}, classes: ['off'] }, s1)
    expect([...el.attrs]).toEqual([['title', 'B']])
    expect(el.style).toEqual({ cursor: '' })
    expect([...el.classes]).toEqual(['off'])
    applyElementProps(target, { attrs: {}, style: {}, classes: [] }, s2)
    expect(el.attrs.size).toBe(0)
    expect(el.classes.size).toBe(0)
  })
  it('a class the adapter did not add is never removed', () => {
    const el = fakeElement()
    el.classes.add('ag-row')
    const s1 = applyElementProps(el as unknown as HTMLElement, { attrs: {}, style: {}, classes: ['sel'] }, undefined)
    applyElementProps(el as unknown as HTMLElement, { attrs: {}, style: {}, classes: [] }, s1)
    expect([...el.classes]).toEqual(['ag-row'])
  })
})
