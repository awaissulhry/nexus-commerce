import { describe, expect, it } from 'vitest'

import { DELEGATED_EVENTS, delegationCount, registerDelegation, retarget } from './rowEvents'

/** A stand-in for a native event: a getter that must see the NATIVE receiver, a method that must too. */
class FakeEvent {
  type = 'dragover'
  defaultPrevented = false
  cancelBubble = false
  clientX = 12
  private readonly secret = 'link'
  get dataTransfer() {
    if (!(this instanceof FakeEvent)) throw new TypeError('Illegal invocation')
    return { types: ['x/rule'], dropEffect: this.secret }
  }
  preventDefault() {
    if (!(this instanceof FakeEvent)) throw new TypeError('Illegal invocation')
    this.defaultPrevented = true
  }
  stopPropagation() {
    this.cancelBubble = true
  }
}

describe('retarget — the native event with the legacy element as currentTarget', () => {
  it('currentTarget is the element handed in; everything else reads through to the native event', () => {
    const ev = new FakeEvent()
    const row = { classList: new Set(['ag-row']) } as unknown as Element
    const e = retarget(ev as unknown as Event, row) as unknown as FakeEvent & { nativeEvent: unknown; isDefaultPrevented: () => boolean; isPropagationStopped: () => boolean; persist: () => void; currentTarget: unknown }
    expect(e.currentTarget).toBe(row)
    expect(e.type).toBe('dragover')
    expect(e.clientX).toBe(12)
    expect(e.nativeEvent).toBe(ev)
  })
  it('getters and methods run with the native receiver (a proxied receiver would throw "Illegal invocation")', () => {
    const ev = new FakeEvent()
    const e = retarget(ev as unknown as Event, {} as Element) as unknown as FakeEvent & { isDefaultPrevented: () => boolean; isPropagationStopped: () => boolean }
    expect(e.dataTransfer.types).toEqual(['x/rule'])
    expect(e.dataTransfer.dropEffect).toBe('link')
    expect(e.isDefaultPrevented()).toBe(false)
    e.preventDefault()
    expect(ev.defaultPrevented).toBe(true)
    expect(e.isDefaultPrevented()).toBe(true)
    e.stopPropagation()
    expect(ev.cancelBubble).toBe(true)
    expect(e.isPropagationStopped()).toBe(true)
  })
  it('a write lands on the native event', () => {
    const ev = new FakeEvent()
    const e = retarget(ev as unknown as Event, {} as Element) as unknown as FakeEvent
    e.clientX = 99
    expect(ev.clientX).toBe(99)
  })
})

describe('the delegated event list', () => {
  it('maps every bubbling event the legacy <tr>/<td>/<th> props could carry to its React prop name', () => {
    const m = new Map(DELEGATED_EVENTS)
    expect(m.get('click')).toBe('onClick')
    expect(m.get('dragover')).toBe('onDragOver')
    expect(m.get('dragleave')).toBe('onDragLeave')
    expect(m.get('drop')).toBe('onDrop')
    expect(m.get('pointerdown')).toBe('onPointerDown')
    // non-bubbling events are not delegable and are deliberately absent
    expect(m.has('mouseenter')).toBe(false)
    expect(m.has('mouseleave')).toBe(false)
  })
  it('registration counts grids and is reversible; without a document (this test) nothing is installed', () => {
    const t = { root: {} as HTMLElement, rowHandlers: () => undefined, cellHandlers: () => undefined, headerHandlers: () => undefined }
    const off = registerDelegation(t)
    expect(delegationCount()).toBe(1)
    off()
    expect(delegationCount()).toBe(0)
  })
})
