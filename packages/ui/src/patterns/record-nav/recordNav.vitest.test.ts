import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecordNav } from './RecordNav'
import { recordNavKey, recordNavView } from './recordNavModel'

/** B-W2b-09 (D13) — Previous / Next record on a record page: the DetailModal rule with real links. */
const IDS = ['PO-1', 'PO-2', 'PO-3']
const key = (k: string, extra: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; defaultPrevented: boolean }> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...extra })
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('recordNavView', () => {
  it('counts the place and links the neighbours', () => {
    const view = recordNavView(IDS, 'PO-2', { noun: 'order' })
    expect(view.counter).toBe('2 of 3')
    expect(view.groupLabel).toBe('Move between orders')
    expect(view.prev).toMatchObject({ id: 'PO-1', label: 'Previous order', held: null, key: 'K' })
    expect(view.next).toMatchObject({ id: 'PO-3', label: 'Next order', held: null, key: 'J' })
  })
  it('holds at the ends with the reason, never wraps; a paged list says "on this page" and counts the whole list', () => {
    expect(recordNavView(IDS, 'PO-1', { noun: 'order' }).prev).toMatchObject({ id: null, held: 'This is the first order' })
    expect(recordNavView(IDS, 'PO-3', { noun: 'order' }).next).toMatchObject({ id: null, held: 'This is the last order' })
    const paged = recordNavView(IDS, 'PO-3', { noun: 'order', place: { offset: 50, total: 56 } })
    expect(paged.counter).toBe('53 of 56')
    expect(paged.next.held).toBe('This is the last order on this page')
  })
  it('holds both when the record is not in the list any more', () => {
    const view = recordNavView(IDS, 'PO-9', { noun: 'order' })
    expect(view.counter).toBeNull()
    expect(view.prev.held).toBe('This order is not in the table now')
    expect(view.next.held).toBe('This order is not in the table now')
  })
  it('speaks the DetailModal words it is given', () => {
    const view = recordNavView(IDS, 'PO-2', { noun: 'ordine', words: { noun: 'riga', previous: (n) => `${n} precedente`, next: (n) => `${n} successivo`, moveBetween: (n) => `Passa da un ${n} all’altro`, position: (a, b) => `${a} di ${b}`, notInTable: () => 'Non è più in tabella', first: () => 'È il primo', last: () => 'È l’ultimo' } })
    expect(view.counter).toBe('2 di 3')
    expect(view.prev.label).toBe('ordine precedente')
  })
})

describe('recordNavKey', () => {
  it('moves with J / K only when nothing else owns the key', () => {
    expect(recordNavKey(key('j'), 'other', false)).toBe('next')
    expect(recordNavKey(key('K'), 'other', false)).toBe('prev')
    expect(recordNavKey(key('j'), 'text', false)).toBeNull()
    expect(recordNavKey(key('j'), 'grid', false)).toBeNull()
    expect(recordNavKey(key('j', { metaKey: true }), 'other', false)).toBeNull()
    expect(recordNavKey(key('j'), 'other', true)).toBeNull()
    expect(recordNavKey(key('j', { defaultPrevented: true }), 'other', false)).toBeNull()
    expect(recordNavKey(key('x'), 'other', false)).toBeNull()
  })
})

describe('RecordNav', () => {
  it('draws real links to the neighbours and a held control at an end', () => {
    const html = render(h(RecordNav, { ids: IDS, current: 'PO-1', hrefOf: (id: string) => `/w/acme/purchasing/orders/${id}`, noun: 'order', linkAs: Link }))
    expect(html).toContain('href="/w/acme/purchasing/orders/PO-2"')
    expect(html).toContain('aria-keyshortcuts="J"')
    expect(html).not.toContain('PO-0')
    expect(html).toContain('aria-description="This is the first order"')
    expect(html).toContain('1 of 3')
    expect(html).toContain('<nav class="nds-recnav" aria-label="Move between orders">')
  })
})
