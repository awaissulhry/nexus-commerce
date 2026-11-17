import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { arrivalOf, DOCK_COLUMNS, DOCK_FROM, dockWidth, FRAME_KEYS, frameMode, isThreadKey, PHONE_BELOW, THIRD_BELOW, threadPixels } from './model'
import { RecordFrame } from './RecordFrame'
import { RecordNotices } from './RecordNotices'

/** B-TH-213 — RecordFrame: 40 % / one third / full by width, one thread per page, the old addresses (R-8), the keys (PR-14). */

describe('where the thread sits, and how wide', () => {
  it('docked from 1280 px; below, a full-width view behind the band’s button', () => {
    expect(DOCK_FROM).toBe(1280)
    expect(PHONE_BELOW).toBe(720)
    expect(frameMode(1920)).toBe('docked')
    expect(frameMode(1280)).toBe('docked')
    expect(frameMode(1279)).toBe('stacked')
    expect(frameMode(375)).toBe('stacked')
  })

  it('40 % by default; one third on a wide grid tab under 1600 px; a chosen width always wins', () => {
    expect(dockWidth({ chosen: 'forty', remembered: false, wideTab: false, viewport: 1440 })).toBe('forty')
    expect(dockWidth({ chosen: 'forty', remembered: false, wideTab: true, viewport: 1440 })).toBe('third')
    expect(dockWidth({ chosen: 'forty', remembered: false, wideTab: true, viewport: THIRD_BELOW })).toBe('forty')
    expect(dockWidth({ chosen: 'forty', remembered: true, wideTab: true, viewport: 1440 })).toBe('forty')
    expect(dockWidth({ chosen: 'half', remembered: true, wideTab: false, viewport: 1920 })).toBe('half')
  })

  it('the 3 : 2 grid gives the picture’s numbers: 519 px at 1440, 711 px at 1920 (design kit §2)', () => {
    expect(threadPixels(1314, 'forty')).toBe(519)
    expect(threadPixels(1794, 'forty')).toBe(711)
    expect(threadPixels(1314, 'third')).toBe(433)
    expect(threadPixels(1794, 'full')).toBe(1794)
    expect(DOCK_COLUMNS.forty).toBe('minmax(0, 3fr) minmax(0, 2fr)')
    expect(DOCK_COLUMNS.full).toBe('minmax(0, 1fr)')
  })
})

describe('every old address keeps working (R-8)', () => {
  it('?tab=activity opens the thread; panel=approvals also opens Ask a partner to approve', () => {
    expect(arrivalOf('?tab=activity')).toEqual({ openThread: true, door: null })
    expect(arrivalOf('?tab=activity&panel=approvals')).toEqual({ openThread: true, door: 'approve' })
    expect(arrivalOf(new URLSearchParams('panel=approvals'))).toEqual({ openThread: true, door: 'approve' })
    expect(arrivalOf('?tab=lines')).toEqual({ openThread: false, door: null })
    expect(arrivalOf(null)).toEqual({ openThread: false, door: null })
  })

  it('⌘J / Ctrl J toggles the thread, never with Alt or Shift', () => {
    const key = (more: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more })
    expect(isThreadKey(key({ metaKey: true }))).toBe(true)
    expect(isThreadKey(key({ ctrlKey: true, key: 'J' }))).toBe(true)
    expect(isThreadKey(key({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isThreadKey(key({}))).toBe(false)
  })
})

describe('the frame on the page', () => {
  const band = { back: createElement('a', { href: '/w/demo/sales/orders' }, 'Orders'), title: 'SO-2026-0101 · Brand Alpha', status: createElement('span', null, 'In production'), meta: createElement('span', null, 'From Q-2026-0101') }
  const page = (thread: unknown) =>
    render(createElement(RecordFrame, { recordType: 'SalesOrder', personId: 'u1', band, thread: thread as never, threadLabel: 'The order’s thread', children: createElement('p', null, 'The body') }))

  it('ONE thread, in a named region beside the body; the Thread button says ⌘J; the band draws itself without a shell slot', () => {
    const html = page(createElement('div', { className: 'stand-in-thread' }, 'messages'))
    expect(html.match(/<aside/g)?.length).toBe(1)
    expect(html).toContain('aria-label="The order’s thread"')
    expect(html).toContain('aria-keyshortcuts="Meta+J Control+J"')
    expect(html).toContain('class="fw-rcf-band"')
    expect(html).toContain('class="fw-rcf has-thread"')
    expect(textOf(html)).toContain('The body')
    expect(textOf(html)).toContain('Thread')
  })

  it('no thread for this person: no dock and no Thread button', () => {
    const html = page(null)
    expect(html).not.toContain('<aside')
    expect(html).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
  })

  it('the keys and the notices have words in both languages (no "?" overlay: the band menu’s Keyboard line, PR-14)', () => {
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['record-frame'] ?? {}
      for (const entry of FRAME_KEYS) expect(words[entry.words], `${locale} ${entry.words}`).toBeTruthy()
      for (const key of ['keys.line', 'keys.title', 'thread.button', 'thread.back', 'details.open', 'notices.more_other']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('one notice shows; the others wait behind "N more notices"', () => {
    const html = render(createElement(RecordNotices, null, createElement('div', { className: 'nds-banner' }, 'First'), createElement('div', { className: 'nds-banner' }, 'Second')))
    expect(html).toContain('class="fw-rcf-notices"')
    expect(html).toContain('class="fw-rcf-notices-list"')
    expect(textOf(html)).toContain('First')
  })
})
