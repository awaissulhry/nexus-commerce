import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { arrivalOf, DOCK_COLUMNS, DOCK_FROM, dockWidth, FRAME_KEYS, frameMode, isThreadKey, PHONE_BELOW, THIRD_BELOW, threadPixels } from './model'
// B-TH-229 / B-TH-230
import { threadButtonWords } from './model'
// B-TH-264 follow-up
import { askedFiles } from './model'
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

  // B-TH-230: a list's New messages cell opens the record with its thread (at "New since your last visit", B-TH-229).
  it('?thread=new (the New messages cell) opens the thread, nothing else', () => {
    expect(arrivalOf('?thread=new')).toEqual({ openThread: true, door: null })
    expect(arrivalOf('?thread=open')).toEqual({ openThread: false, door: null })
  })

  it('⌘J / Ctrl J toggles the thread, never with Alt or Shift', () => {
    const key = (more: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: 'j', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more })
    expect(isThreadKey(key({ metaKey: true }))).toBe(true)
    expect(isThreadKey(key({ ctrlKey: true, key: 'J' }))).toBe(true)
    expect(isThreadKey(key({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isThreadKey(key({}))).toBe(false)
  })
})

// ---- B-TH-229: the band's "Thread · 2 new" (the same number as the Head's "2 new") ----------------------------------------------
describe('B-TH-229 — the band says how many messages are new to the reader', () => {
  it('"Thread", "Thread · 2 new", "Thread · 99+ new"; the screen reader hears the count', () => {
    expect(threadButtonWords(0)).toEqual({ key: 'thread.button', label: null })
    expect(threadButtonWords(2)).toEqual({ key: 'thread.buttonNew', count: 2, label: { key: 'thread.buttonNewLabel', count: 2 } })
    expect(threadButtonWords(140)).toMatchObject({ key: 'thread.buttonMany', count: 99 })
    const en = CATALOGUE.en['record-frame']!
    const it = CATALOGUE.it['record-frame']!
    expect(en['thread.buttonNew_other']).toBe('Thread · {count} new')
    expect(en['thread.buttonNewLabel_other']).toBe('Thread, {count} new messages')
    expect(it['thread.buttonNew_other']).toBe('Conversazione · {count} nuovi')
  })
})
// ---- end B-TH-229

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

// ---- B-TH-269 (R-10) and the B-TH-264 follow-up (TH-6 part B): a person's record docks its thread closed; a body part's files open
// in the thread's ONE viewer ------------------------------------------------------------------------------------------------------
describe('B-TH-269 — a thread that docks closed (R-10: a colleague’s or a worker’s notes never open by themselves)', () => {
  const band = { back: createElement('a', { href: '/w/demo/admin/users' }, 'Users'), title: 'Anna Demo' }
  const page = (closed: boolean | undefined) =>
    render(createElement(RecordFrame, { recordType: 'User', personId: 'u1', band, thread: createElement('div', null, 'notes'), threadLabel: 'Notes about Anna Demo', closed, children: createElement('p', null, 'Profile') }))

  it('closed: the dock is there but hidden, the Thread button not pressed (the button, ⌘J or ?tab=activity shows it)', () => {
    const html = page(true)
    expect(html).toContain('class="fw-rcf has-thread is-hidden"')
    expect(html).toContain('aria-pressed="false"')
    expect(html.match(/<aside/g)?.length).toBe(1)
  })

  it('without `closed` every other record docks open as before', () => {
    const html = page(undefined)
    expect(html).toContain('class="fw-rcf has-thread"')
    expect(html).not.toContain('is-hidden')
    expect(html).toContain('aria-pressed="true"')
  })
})

describe('B-TH-264 follow-up — a body part’s files open in the docked thread’s ONE viewer', () => {
  const own = {
    id: 'f-own',
    recordType: 'Shipment',
    recordId: 's1',
    name: 'Packing list PL-7.pdf',
    contentType: 'application/pdf',
    kind: 'DOCUMENT' as const,
    sizeBytes: 2048,
    status: 'AVAILABLE' as const,
    quarantineReason: null,
    visibility: [],
    partyId: null,
    createdAt: '2026-11-17T09:00:00Z',
    previewUrl: null,
    versionNo: 2,
  }

  it('the files keep the body’s order; the one clicked shows first; a file the thread knows keeps its own facts', () => {
    const asked = askedFiles(
      { files: [{ id: 'f-doc', name: 'DoC DEMO-JKT-01.pdf', contentType: 'application/pdf', sizeBytes: 900 }, { id: 'f-own', name: 'Packing list PL-7' }], fileId: 'f-own' },
      [own],
      { type: 'Shipment', id: 's1' },
    )
    expect(asked.files.map((file) => file.id)).toEqual(['f-doc', 'f-own'])
    expect(asked.index).toBe(1)
    expect(asked.files[1]).toBe(own)
    expect(asked.files[0]).toMatchObject({ name: 'DoC DEMO-JKT-01.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', status: 'AVAILABLE', sizeBytes: 900, recordType: 'Shipment', recordId: 's1', previewUrl: null })
  })

  it('a photo is a photo; an unknown type a card; a file listed twice once; an unknown first file → the first', () => {
    const asked = askedFiles({ files: [{ id: 'a', name: 'tag.jpg', contentType: 'image/jpeg' }, { id: 'b', name: 'manual.docx' }, { id: 'a', name: 'tag.jpg' }], fileId: 'gone' }, [], { type: 'Shipment', id: 's1' })
    expect(asked.files.map((file) => [file.id, file.kind, file.contentType])).toEqual([
      ['a', 'PHOTO', 'image/jpeg'],
      ['b', 'DOCUMENT', 'application/octet-stream'],
    ])
    expect(asked.index).toBe(0)
  })

  it('the frame offers the door only where the page has a thread; the docked thread reads it once and opens its viewer', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('...(hasThread ? { openFiles, filesAsk, clearFiles } : {})')
    const docked = readFileSync(new URL('../record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toMatch(/const \{ files, index \} = askedFiles\(filesAsk, threadFiles, key\)\s*clearFilesAsk\?\.\(\)/)
    expect(docked).toContain('setViewer({ files, index, returnTo:')
  })

  it('showThread (B-TH-265, used by B-TH-268’s Send copy) — a body part shows the thread: docked un-hides it, narrower the full-width view', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toMatch(/const showThread = useCallback\(\(\) => \{\s*if \(mode === 'docked'\) sizes\.show\(\)\s*else if \(!viewOpen\) openView\(\)/)
    expect(frame.match(/readonly showThread\?: \(\) => void/g)?.length).toBe(1)
  })
})

describe('TH-6 part B — the record’s own keys join the band menu’s ONE Keyboard line (PR-14)', () => {
  it('RecordBand.keys are listed first in the frame’s Keyboard window, then the thread’s; the menu keeps one Keyboard line', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('readonly keys?: readonly { readonly keys: readonly string[]; readonly label: string }[]')
    expect(frame.indexOf('(band.keys ?? []).map((entry) =>')).toBeGreaterThan(-1)
    expect(frame.indexOf('(band.keys ?? []).map((entry) =>')).toBeLessThan(frame.indexOf('{FRAME_KEYS.map((entry) =>'))
    expect(frame.match(/id: 'keys', label: t\('keys\.line'\)/g)?.length).toBe(1)
  })
})
// ---- end B-TH-269 / B-TH-264 follow-up
