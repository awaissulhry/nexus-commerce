import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { inWindowThread, windowLayout } from './model'
import { ReviewWindow } from './ReviewWindow'

/**
 * B-TH-271 (threads plan PL6, picture 40): the thread inside a window — docked beside the content, folded to "Add a note" while an
 * office-only thread holds nothing, never folded with a party, absent without the right; the window's keys stay quiet inside it.
 */
describe('the window’s docked thread (PL6)', () => {
  it('folds only an office-only thread with nothing in it, until a person opens it; a party’s thread never folds', () => {
    expect(windowLayout({ hasThread: false, notesOnly: true, empty: true, opened: false })).toBe('alone')
    expect(windowLayout({ hasThread: true, notesOnly: true, empty: true, opened: false })).toBe('folded')
    expect(windowLayout({ hasThread: true, notesOnly: true, empty: true, opened: true })).toBe('docked')
    expect(windowLayout({ hasThread: true, notesOnly: true, empty: false, opened: false })).toBe('docked')
    expect(windowLayout({ hasThread: true, notesOnly: false, empty: true, opened: false })).toBe('docked')
  })

  it('draws the content first and the thread beside it; folded, "Add a note" with the thread kept mounted but hidden', () => {
    const thread = createElement('div', { className: 'fw-rt-column' }, 'notes')
    const docked = render(createElement(ReviewWindow, { thread, threadLabel: 'Notes of R-1', recordKey: 'r1', children: createElement('p', null, 'Content') }))
    expect(docked).toContain('class="fw-rw has-thread"')
    expect(docked.indexOf('Content')).toBeLessThan(docked.indexOf('class="fw-rw-thread"'))
    expect(docked).toContain('aria-label="Notes of R-1"')
    const folded = render(createElement(ReviewWindow, { thread, threadLabel: 'Notes of R-1', notesOnly: true, empty: true, recordKey: 'r1', children: createElement('p', null, 'Content') }))
    expect(folded).toContain('is-folded')
    expect(textOf(folded)).toContain('Add a note')
    expect(folded).toMatch(/class="fw-rw-thread-inner" hidden=""/)
    const alone = render(createElement(ReviewWindow, { thread: null, threadLabel: 'x', recordKey: 'r1', children: createElement('p', null, 'Content') }))
    expect(alone).toContain('class="fw-rw"')
    expect(alone).not.toContain('fw-rw-thread')
  })

  it('the window’s keys stay quiet inside its thread', () => {
    const inside = { closest: (selector: string) => (selector === '.fw-rw-thread' ? {} : null) } as unknown as EventTarget
    const outside = { closest: () => null } as unknown as EventTarget
    expect(inWindowThread(inside)).toBe(true)
    expect(inWindowThread(outside)).toBe(false)
    expect(inWindowThread(null)).toBe(false)
  })

  it('its words exist in it and en', () => {
    for (const locale of ['it', 'en'] as const) for (const key of ['addNote', 'foldedHint']) expect(CATALOGUE[locale]['review-window']![key], `${locale} ${key}`).toBeTruthy()
  })
})
