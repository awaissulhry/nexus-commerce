import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { render, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { LINE_BLK, order } from '../_demo/fixtures'
import { designScreen, tabOf } from './fixtures'
import { leavingHrefOf, type LeaveClick } from './leave-guard'
import { EMPTY_HISTORY, setCell } from './lines-draft'
import { LeaveConfirm } from './view/lines/SaveBar'

// The DS Modal draws into a portal once hydrated, never on the server: here it draws in place.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OL-07 (Order LINES lane; 11-design-dialogs D-k, W2): leaving the order with changes not saved by an in-app link asks first —
 * "Leave with {n} changes not saved?" · Stay · Leave and discard; another tab of the same order keeps the draft and asks nothing.
 * Every name and number is made up.
 */

const HERE = { origin: 'https://factory.example.com', pathname: '/w/DEMO/sales/orders/o1' }
const PLAIN: LeaveClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false }
const link = (href: string, over: { target?: string; download?: boolean } = {}) => ({ href, target: over.target ?? '', download: over.download ?? false })

describe('F-OL-07: which click leaves the order page', () => {
  it('another page of the app (another order, a list, a style) leaves: its path, query and hash', () => {
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/sales/orders/o2?tab=lines'), HERE)).toBe('/w/DEMO/sales/orders/o2?tab=lines')
    expect(leavingHrefOf(PLAIN, link('https://factory.example.com/w/DEMO/sales/orders'), HERE)).toBe('/w/DEMO/sales/orders')
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/products/styles/s1#pieces'), HERE)).toBe('/w/DEMO/products/styles/s1#pieces')
  })

  it('a tab of this order, the dock\'s scope or an anchor stays on the page: nothing asked, the draft kept', () => {
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/sales/orders/o1?tab=production'), HERE)).toBeNull()
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/sales/orders/o1?tab=lines&thread=all'), HERE)).toBeNull()
    expect(leavingHrefOf(PLAIN, link('#still-to-do'), HERE)).toBeNull()
  })

  it('a new tab or window, a download, another site, a click already taken: the browser\'s (its own guard covers leaving the site)', () => {
    for (const keys of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(leavingHrefOf({ ...PLAIN, ...keys }, link('/w/DEMO/sales/orders/o2'), HERE), JSON.stringify(keys)).toBeNull()
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/sales/orders/o2', { target: '_blank' }), HERE)).toBeNull()
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/files/f1.pdf', { download: true }), HERE)).toBeNull()
    expect(leavingHrefOf(PLAIN, link('https://carrier.example.org/track/1'), HERE)).toBeNull()
    expect(leavingHrefOf({ ...PLAIN, defaultPrevented: true }, link('/w/DEMO/sales/orders/o2'), HERE)).toBeNull()
    expect(leavingHrefOf(PLAIN, null, HERE)).toBeNull()
    // _self is this page's own way.
    expect(leavingHrefOf(PLAIN, link('/w/DEMO/sales/orders/o2', { target: '_self' }), HERE)).toBe('/w/DEMO/sales/orders/o2')
  })
})

describe('F-OL-07: the question — Stay or Leave and discard, what is lost said', () => {
  const value = order('CONFIRMED')
  const draft = setCell(EMPTY_HISTORY, value, LINE_BLK, '50', 3).draft

  it('drawn only while a link waits (en, it): the title by the count, the line named, Stay first, Leave and discard', () => {
    expect(render(createElement(LeaveConfirm, { order: value, tab: tabOf({ draft }) }), 'en')).not.toContain('role="dialog"')
    const en = textOf(render(createElement(LeaveConfirm, { order: value, tab: tabOf({ draft, leaving: true }) }), 'en'))
    for (const words of ['Leave with 1 change not saved?', 'What you changed in the table is lost:', 'BLK', 'Stay', 'Leave and discard']) expect(en, words).toContain(words)
    const it = textOf(render(createElement(LeaveConfirm, { order: value, tab: tabOf({ draft, leaving: true }) }), 'it'))
    for (const words of ['Uscire con 1 modifica non salvata?', 'Resta', 'Esci e scarta']) expect(it, words).toContain(words)
  })

  it('the design case: on Overview with three changes, the question drawn once for the page', () => {
    for (const locale of LOCALES) {
      const screen = designScreen as DesignScreen<unknown>
      const item = screen.cases.find((entry) => entry.id === 'lines-leave')!
      const text = textOf(renderView(screen.view as ComponentType<{ model: unknown }>, item.model, locale))
      expect(text).toContain(locale === 'en' ? 'Leave with 3 changes not saved?' : 'Uscire con 3 modifiche non salvate?')
    }
  })

  it('the sources: the window\'s capture-phase click (before the link\'s own router) and the browser\'s guard while the draft holds a change; Leave goes by the router', () => {
    const hook = readFileSync(new URL('./use-lines-draft.ts', import.meta.url), 'utf8')
    expect(hook).toContain("window.addEventListener('click', onClick, true)")
    expect(hook).toContain("window.addEventListener('beforeunload', onUnload)")
    expect(hook).toContain('if (empty) return')
    expect(hook).toContain('if (href) go(href)')
    expect(readFileSync(new URL('./OrderRecord.tsx', import.meta.url), 'utf8')).toContain('go: (href) => router.push(href), // F-OL-07')
    expect(readFileSync(new URL('./view/OrderRecordView.tsx', import.meta.url), 'utf8')).toContain('<LeaveConfirm order={order} tab={model.linesTab} actions={actions?.linesTab} />')
  })
})
