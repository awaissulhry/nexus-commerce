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
// F-SA-263
import { defaultWidthAt, showsOnArrival } from './model'
import { RecordNotices } from './RecordNotices'
// B-TH-280: the print view of the custom fields
import { PrintModeProvider } from '../../../shell/print/print-mode'

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

  // F-SA-263: the `wide` boolean became the tab's own default (`grid` = today's wide-tab rule): every other page draws as before.
  it('40 % by default; one third on a wide grid tab under 1600 px; a chosen width always wins', () => {
    expect(dockWidth({ chosen: null, viewport: 1440 })).toBe('forty')
    expect(dockWidth({ chosen: null, defaultWidth: 'grid', viewport: 1440 })).toBe('third')
    expect(dockWidth({ chosen: null, defaultWidth: 'grid', viewport: THIRD_BELOW })).toBe('forty')
    expect(dockWidth({ chosen: 'forty', defaultWidth: 'grid', viewport: 1440 })).toBe('forty')
    expect(dockWidth({ chosen: 'half', viewport: 1920 })).toBe('half')
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
    // F-OP-206: the frame's keys come through frameKeysFor (All of <Customer>'s rows where the dock holds it).
    expect(frame.indexOf('(band.keys ?? []).map((entry) =>')).toBeLessThan(frame.indexOf('{frameKeysFor(pageRecord'))
    expect(frame.match(/id: 'keys', label: t\('keys\.line'\)/g)?.length).toBe(1)
  })
})
// ---- end B-TH-269 / B-TH-264 follow-up

// ---- B-TH-280: the record's custom fields (Admin › Fields & lists) left with the old record panels; the frame draws them again at the
// end of the body column, on the tab the page passes them (its first) — and in the print view after the body, before the thread.
describe('B-TH-280 — the custom fields at the end of the body column', () => {
  const band = { back: createElement('a', { href: '/w/demo/sales/orders' }, 'Orders'), title: 'SO-2026-0101 · Brand Alpha' }
  const page = (fields: unknown, printing = false) =>
    render(
      createElement(
        PrintModeProvider,
        { printing },
        createElement(RecordFrame, {
          recordType: 'SalesOrder',
          personId: 'u1',
          band,
          thread: createElement('div', { className: 'stand-in-thread' }, 'messages'),
          threadLabel: 'The order’s thread',
          printThread: createElement('p', { className: 'stand-in-print' }, 'Printed thread'),
          ...(fields === undefined ? {} : { fields: fields as never }),
          children: createElement('p', null, 'The body'),
        }),
      ),
    )

  it('drawn inside the body column, after the tab’s body and before the dock', () => {
    const html = page(createElement('section', { className: 'stand-in-fields' }, 'Custom fields'))
    const body = html.indexOf('class="fw-rcf-body"')
    const fields = html.indexOf('class="stand-in-fields"')
    expect(body).toBeGreaterThan(-1)
    expect(fields).toBeGreaterThan(html.indexOf('The body'))
    expect(fields).toBeLessThan(html.indexOf('<aside'))
    expect(html.match(/class="stand-in-fields"/g)?.length).toBe(1)
  })

  it('absent (another tab, or a record type without custom fields): nothing is drawn', () => {
    expect(page(undefined)).not.toContain('stand-in-fields')
    expect(page(null)).not.toContain('stand-in-fields')
  })

  it('the print view prints them after the body and before the thread’s print form; no dock', () => {
    const html = page(createElement('section', { className: 'stand-in-fields' }, 'Custom fields'), true)
    expect(html).toContain('class="fw-rcf-print"')
    expect(html).not.toContain('<aside')
    expect(html.indexOf('The body')).toBeLessThan(html.indexOf('class="stand-in-fields"'))
    expect(html.indexOf('class="stand-in-fields"')).toBeLessThan(html.indexOf('class="stand-in-print"'))
  })

  it('one optional slot in the frame’s props, marked with its step', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame.match(/readonly fields\?: ReactNode/g)?.length).toBe(1)
    expect(frame.match(/\{fields \/\* B-TH-280 \*\/\}/g)?.length).toBe(2)
  })
})
// ---- end B-TH-280

// ---- F-SA-263 (sales page plan N6, P11; 10-order-page §5, §6.3): each tab its own default width; a chosen width kept per tab, "hidden"
// kept per person + record type; every other record page keeps its behaviour (RecordFrame's defaults).
describe('F-SA-263 — the dock adapts per tab and remembers', () => {
  it('a tab’s default: a width is itself at every viewport; `grid` is a third under 1600 px and 40 % from 1600', () => {
    for (const viewport of [1280, 1440, 1599, 1600, 1920]) {
      expect(defaultWidthAt('forty', viewport)).toBe('forty')
      expect(defaultWidthAt('half', viewport)).toBe('half')
      expect(defaultWidthAt('third', viewport)).toBe('third')
    }
    expect(defaultWidthAt('grid', 1440)).toBe('third')
    expect(defaultWidthAt('grid', 1599)).toBe('third')
    expect(defaultWidthAt('grid', 1600)).toBe('forty')
    expect(defaultWidthAt('grid', 1920)).toBe('forty')
    // A chosen width wins over any tab's default; none chosen → the tab's (Changes half at 1440 and 1920).
    expect(dockWidth({ chosen: null, defaultWidth: 'half', viewport: 1440 })).toBe('half')
    expect(dockWidth({ chosen: 'third', defaultWidth: 'half', viewport: 1920 })).toBe('third')
  })

  it('the address shows a hidden dock again: ?tab=activity, panel=approvals, any ?thread= (new, open, a scope); nothing else does', () => {
    for (const search of ['?tab=activity', '?panel=approvals', '?thread=new', '?thread=open', '?thread=general', 'thread=wo:w1']) expect(showsOnArrival(search), search).toBe(true)
    for (const search of ['?tab=lines', '', '?message=m1']) expect(showsOnArrival(search), search).toBe(false)
    expect(showsOnArrival(null)).toBe(false)
    expect(showsOnArrival(new URLSearchParams('thread=all'))).toBe(true)
  })

  it('the frame keeps "hidden" only for a page that names its tab (`dockTab`), the width ONE per record type (F-OP-301); ⌘J and the band button toggle it, ?thread= shows it', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('startHidden: closed /* B-TH-269 (R-10) */, rememberHidden: dockTab !== undefined })')
    expect(frame).not.toContain('tab: dockTab') // F-OP-301 (walk #5): never a width per tab
    expect(frame).toContain('const width = dockWidth({ chosen: sizes.remembered ? sizes.width : null, defaultWidth, viewport: wideViewport ? 1600 : 1440 })')
    // The `wide` boolean is gone (no page passes it any more).
    expect(frame).not.toMatch(/readonly wide\?: boolean/)
    // ⌘J and the band's button go through the same toggle (the hook writes "hidden" for a page that keeps it).
    expect(frame).toMatch(/if \(isThreadKey\(event\)\) \{\s*event\.preventDefault\(\)\s*latest\.current\.toggle\(\)/)
    expect(frame).toMatch(/const toggle = useCallback\(\(\) => \{\s*if \(mode === 'docked'\) sizes\.toggle\(\)/)
    expect(frame).toContain('onClick={toggle}')
    // Arrival: any ?thread= shows a docked thread the person had hidden.
    expect(frame).toMatch(/showsOnArrival\(window\.location\.search\) && window\.matchMedia\(`\(min-width: \$\{DOCK_FROM\}px\)`\)\.matches\) sizes\.show\(\)/)
  })

  it('every other record page keeps its behaviour: no page passes `wide`; a page’s wide tabs pass `grid`; only the sales order names its tab', () => {
    const root = new URL('../../', import.meta.url)
    const pages = [
      'compliance/techfiles/record/view/TechFileRecordView.tsx',
      'production/work-orders/record/view/WorkOrderRecordView.tsx',
      'products/samples/record/view/SampleRecordView.tsx',
      'products/styles/record/view/StyleRecordView.tsx',
      'purchasing/orders/record/view/OrderRecordView.tsx',
      'purchasing/subcontracting/record/view/SubcontractRecordView.tsx',
      'sales/pricelists/record/view/PriceListRecordView.tsx',
      'sales/quotes/record/view/QuoteRecordView.tsx',
      'sales/returns/record/view/RmaRecordView.tsx',
      'warehouse/counts/record/view/CountRecordView.tsx',
      'warehouse/lots/record/view/LotRecordView.tsx',
      'warehouse/receipts/record/view/ReceiptRecordView.tsx',
      'warehouse/shipments/record/view/ShipmentRecordView.tsx',
    ]
    for (const page of pages) {
      const source = readFileSync(new URL(page, root), 'utf8')
      expect(source, page).not.toMatch(/\swide=\{/)
      expect(source, page).toMatch(/defaultWidth=\{.+ \? 'grid' : undefined \/\* F-SA-263 \*\/\}/)
      expect(source, page).not.toContain('dockTab=')
    }
    const order = readFileSync(new URL('sales/orders/record/view/OrderRecordView.tsx', root), 'utf8')
    expect(order).toContain('defaultWidth={DOCK_DEFAULTS[model.tab]}')
    expect(order).toContain('dockTab={model.tab}')
  })

  it('a page with no `defaultWidth` draws the 40 % columns (SSR: nothing chosen yet), with the dock open', () => {
    const band = { back: createElement('a', { href: '/w/demo/sales/quotes' }, 'Quotes'), title: 'QT-2026-0088 · Brand Alpha' }
    const html = render(createElement(RecordFrame, { recordType: 'Quote', personId: 'u1', band, thread: createElement('div', null, 'messages'), threadLabel: 'The quote’s thread', children: createElement('p', null, 'The body') }))
    expect(html).toContain('data-width="forty"')
    expect(html).toContain('class="fw-rcf has-thread"')
    const half = render(createElement(RecordFrame, { recordType: 'SalesOrder', personId: 'u1', band, thread: createElement('div', null, 'messages'), threadLabel: 'The order’s thread', defaultWidth: 'half', dockTab: 'changes', children: createElement('p', null, 'Changes') }))
    expect(half).toContain('data-width="half"')
    expect(half).not.toContain('is-hidden')
  })
})
// ---- end F-SA-263

// ---- F-SA-265 (sales page plan N2, N4, N6; picks P2, P9, R10; 10-order-page §6.4): Discuss, Show in thread, Followers…
describe('F-SA-265: the frame\'s doors into the conversation (Discuss, Show in thread, Followers…)', () => {
  it('the parts a message may be about are the API\'s list (B-SA-061), the composer\'s too', async () => {
    const { DISCUSS_KINDS } = await import('./model')
    const { ABOUT_KINDS } = await import('../../../lib/record-thread/composer/model')
    expect([...DISCUSS_KINDS]).toEqual([...ABOUT_KINDS])
    const api = readFileSync(new URL('../../../../../factory-api/src/platform/threads/about.ts', import.meta.url), 'utf8')
    for (const kind of DISCUSS_KINDS) expect(api).toContain(`'${kind}'`)
  })
  it('Show in thread finds the history step nearest the change (within 10 minutes), else none (said)', async () => {
    const { stepNearest } = await import('./model')
    const events = [
      { id: 'e1', at: '2026-11-18T10:00:00.000Z' },
      { id: 'e2', at: '2026-11-18T10:04:00.000Z' },
      { id: 'e3', at: '2026-11-18T12:00:00.000Z' },
    ]
    expect(stepNearest(events, '2026-11-18T10:03:00.000Z')).toBe('e2')
    expect(stepNearest(events, '2026-11-18T10:00:10.000Z')).toBe('e1')
    expect(stepNearest(events, '2026-11-18T11:00:00.000Z')).toBeNull()
    expect(stepNearest(events, 'not a date')).toBeNull()
    expect(stepNearest([], '2026-11-18T10:00:00.000Z')).toBeNull()
  })
  it('the frame offers them only where the page has a conversation; each shows it first (narrower: the full-width view)', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('...(hasThread ? { discuss, discussAsk, clearDiscuss, showInThread, showAsk, clearShow } : {})')
    const discuss = frame.slice(frame.indexOf('const discuss = useCallback'), frame.indexOf('const clearDiscuss'))
    expect(discuss.match(/showThread\(\)/g)?.length).toBe(2)
    expect(frame).toContain('readonly openDoor?: (door: FrameDoor, record?: FrameRecord) => void') // F-OP-212: with its record
  })
  it('the docked thread reads each ask once, only for its own record: the chip on Office note, the step in view, the followers', () => {
    const docked = readFileSync(new URL('../record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('if (!discussAsk || discussAsk.record.type !== key.type || discussAsk.record.id !== key.id) return')
    expect(docked).toContain('const next = withAbout(composer.draft, discussAsk.about, composer.context.people)')
    expect(docked).toContain("notify({ ns: 'record-frame', key: 'discuss.notInThread', tone: 'warning' })")
    expect(docked).toContain("const followersAsked = doorAsked === 'followers'") // F-OP-212: this thread's own door only
    const card = readFileSync(new URL('../../../lib/record-thread/card/view/MessageCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain('{!readOnly && message.about && actions?.onShowOnPage && (')
    const feed = readFileSync(new URL('../../../lib/record-thread/feed/view/Feed.tsx', import.meta.url), 'utf8')
    expect(feed).toContain('data-event-ids={row.events.map((event) => event.id).join(\' \')}')
  })
  it('the door words in both languages (Discuti, Mostra nella pagina, Chi segue…)', () => {
    // The catalogues are flat keys (`discuss.label`), as every translator reads them.
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['record-frame'] ?? {}
      for (const key of ['label', 'hint', 'of', 'showOnPage', 'showInThread', 'followers', 'notInThread']) expect(words[`discuss.${key}`], `${locale} ${key}`).toBeTruthy()
    }
    const it = CATALOGUE.it['record-frame']!
    expect(it['discuss.label']).toBe('Discuti')
    expect(it['discuss.showOnPage']).toBe('Mostra nella pagina')
    expect(it['discuss.followers']).toBe('Chi segue…')
  })
})
// ---- end F-SA-265

// ---- F-SA-244 (14-change-flow §3.1 "Order thread | the ask message's card Answer… | the same address (the dock asks the frame: a NEW
// door kind beside openDoor('approve'))"): the answer door — the conversation opens the page's ONE review window on a request.
describe('F-SA-244: the frame\'s answer door — the ask card opens the page\'s review window', () => {
  it('a page gives the door (open + its real address); the frame passes it on only where the page has a conversation', () => {
    const model = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    expect(model).toContain('export interface FrameAnswer {')
    expect(model).toContain('readonly open: (requestId: string) => void')
    expect(model).toContain('readonly href: (requestId: string) => string | null')
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain('readonly answer?: FrameAnswer')
    expect(frame).toContain('...(hasThread && answer ? { answer } : {})')
    // Beside openDoor('approve'): the approve door is untouched.
    expect(frame).toContain('readonly openDoor?: (door: FrameDoor, record?: FrameRecord) => void') // F-OP-212: with its record
  })
  it('the docked thread hands it to the cards; a door to the conversation of another record (a change request: its order\'s)', () => {
    const docked = readFileSync(new URL('../record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('...(frame?.answer ? { onAnswer: frame.answer.open, answerHref: frame.answer.href } : {})')
    expect(docked).toContain('withChangeSide(message, side)')
    expect(docked).toContain("place && (place.type !== key.type || place.id !== key.id)")
    expect(docked).toContain("tc('place.line')")
    const api = readFileSync(new URL('../record-thread/api.ts', import.meta.url), 'utf8')
    expect(api).toContain('place: z.object({ type: z.string(), id: z.string() }).optional()')
  })
  it('the order page gives its door: the window\'s `?open=` address, opened without a reload', () => {
    const view = readFileSync(new URL('../../sales/orders/record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{...(model.requestDoor?.open ? { answer: { open: model.requestDoor.open, href: model.requestDoor.hrefOf } } : {})}')
    const record = readFileSync(new URL('../../sales/orders/record/OrderRecord.tsx', import.meta.url), 'utf8')
    expect(record).toContain('open: (id: string) => door.open(id) /* F-SA-244 */')
  })
  it('the place reads where the API says the conversation is, and nothing else (every read says it again)', async () => {
    const { applyNewest, EMPTY_SERVER } = await import('../record-thread/state')
    const thread = { status: 'OPEN' as const, version: 1, partyId: 'p1' }
    expect(applyNewest(EMPTY_SERVER, { thread, messages: [], nextCursor: null, place: { type: 'SalesOrder', id: 'o1' } }).place).toEqual({ type: 'SalesOrder', id: 'o1' })
    expect(applyNewest(EMPTY_SERVER, { thread, messages: [], nextCursor: null }).place).toBeNull()
  })
})
// ---- end F-SA-244

// ---- F-OP-212 (order page plan N4; 11-dock §5; review N-1, D5): every frame ask names its record; only that record's thread takes it;
// the page's dock moves its pick there first, keeping the view as it is.
describe('F-OP-212 — frame asks carry a record', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const ORDER = { type: 'SalesOrder', id: 'o1' }
  const PARTY = { type: 'Party', id: 'p1' }
  const WO = { type: 'WorkOrder', id: 'w1' }

  it('only the matching thread takes an ask; an ask that names no record (a page without one): any thread, as before', async () => {
    const { takesAsk, askRecordOf, sameRecord } = await import('./model')
    expect(takesAsk(ORDER, ORDER)).toBe(true)
    expect(takesAsk(ORDER, PARTY)).toBe(false)
    expect(takesAsk(ORDER, { type: 'SalesOrder', id: 'o2' })).toBe(false)
    expect(takesAsk({ type: 'Quote', id: 'o1' }, ORDER)).toBe(false)
    for (const none of [null, undefined]) expect(takesAsk(none, WO)).toBe(true)
    // A missing record is the page's own; a page that names none leaves it open (its one thread).
    expect(askRecordOf(undefined, ORDER)).toEqual(ORDER)
    expect(askRecordOf(PARTY, ORDER)).toEqual(PARTY)
    expect(askRecordOf(null, null)).toBeNull()
    expect(sameRecord(ORDER, { ...ORDER })).toBe(true)
    expect(sameRecord(ORDER, null)).toBe(false)
  })

  it('the ask waiting now and its record (the host moves once per ask)', async () => {
    const { pendingAskOf } = await import('./model')
    const files = { files: [], fileId: 'f1', record: ORDER }
    expect(pendingAskOf(null)).toBeNull()
    expect(pendingAskOf({ door: null, filesAsk: null })).toBeNull()
    expect(pendingAskOf({ door: null, filesAsk: files })).toEqual({ ask: files, record: ORDER })
    const compose = { record: PARTY, messageId: 'm1', mode: 'note' as const }
    expect(pendingAskOf({ door: { door: 'owner', record: ORDER }, composeAsk: compose })?.record).toEqual(PARTY)
    expect(pendingAskOf({ door: { door: 'followers', record: ORDER } })?.record).toEqual(ORDER)
    // An ask on a page without a record of its own names none: no host moves.
    expect(pendingAskOf({ door: { door: 'approve', record: null } })).toBeNull()
  })

  it('the frame fills the page\'s own record into every ask that names none (files, a door, the arrival\'s door, compose)', () => {
    const frame = read('./RecordFrame.tsx')
    expect(frame).toContain('readonly record?: FrameRecord')
    expect(frame).toContain('setFilesAsk({ ...ask, record: askRecordOf(ask.record, pageRecord) })')
    expect(frame).toContain('setDoor({ door: asked, record: askRecordOf(about, pageRecord) })')
    expect(frame).toContain('if (asked.door) setDoor({ door: asked.door, record: pageRecordRef.current })')
    // The arrival's door is read by the frame that has the thread (a loading frame is another mount: its door would be lost).
    expect(frame).toContain('if (arrived.current || !hasThread) return')
    expect(frame).toContain('setComposeAsk({ ...ask, record: askRecordOf(ask.record, pageRecord) })')
    expect(frame).toContain('...(hasThread ? { compose, composeAsk, clearCompose } : {})')
    const compose = frame.slice(frame.indexOf('const compose = useCallback'), frame.indexOf('const clearCompose'))
    expect(compose).toContain('showThread()')
    // The three pages with a pick name their own record.
    expect(read('../../sales/orders/record/view/OrderRecordView.tsx')).toContain("record={{ type: 'SalesOrder', id: order.id }")
    expect(read('../../sales/customers/record/view/CustomerRecordView.tsx')).toContain("record={{ type: 'Party', id: party.id }")
    expect(read('../../production/work-orders/record/view/WorkOrderRecordView.tsx')).toContain("record={{ type: 'WorkOrder', id: workOrder.id }")
  })

  it('the docked thread takes files, doors and Answer only for its own record; Answer waits for its feed and opens at the message', () => {
    const docked = read('../record-thread/DockedOfficeThread.tsx')
    expect(docked).toContain('if (!filesAsk || !takesAsk(filesAsk.record, key)) return')
    expect(docked).toContain('const doorAsked = frame?.door && takesAsk(frame.door.record, key) ? frame.door.door : null')
    expect(docked).toContain("const askOnArrival = doorAsked === 'approve'")
    expect(docked).not.toMatch(/frame\?\.door === '/)
    expect(docked).toContain('if (!composeAsk || !feedReady || !takesAsk(composeAsk.record, key)) return')
    expect(docked).toContain("const reply = composeAsk.mode === 'reply' && messageId !== null && !!onReply")
    expect(docked).toContain("const switched = switchMode(composer.draft, 'note', composer.context.people)")
    expect(docked).toContain('const reached = jumpTo(messageId)')
    // F-OP-207: a message beyond the first page is read first, then answered.
    expect(docked).toContain('if (reply && messages.some((message) => message.id === messageId)) onReply?.(messageId)')
    expect(docked).toContain('else if (reply) void reached.then(() => requestAnimationFrame(() => latestCompose.current.onReply?.(messageId)))')
  })

  it('the owner door (who answers the customer, N-1) reaches This order: filled with the order, the order dock moves there, its thread opens the owner dialog', async () => {
    const { askRecordOf } = await import('./model')
    const { scopeOfRecord, ORDER_SCOPE } = await import('../../sales/orders/record/dock/model')
    const offer = { general: true, all: true, projects: ['pr1'], workOrders: ['w1'] }
    const page = { orderId: 'o1', partyId: 'p1' }
    expect(scopeOfRecord(askRecordOf(undefined, ORDER), page, offer)).toEqual(ORDER_SCOPE)
    const docked = read('../record-thread/DockedOfficeThread.tsx')
    const owner = docked.slice(docked.indexOf("const ownerAsked = doorAsked === 'owner'"), docked.indexOf('// Answer / Reply in the thread'))
    expect(owner).toContain('if (!ownerAsked || !headRead) return')
    expect(owner).toContain('setOwning({ busy: false, problem: null })')
    // Held in words where the person may not write here (never a dialog that cannot save).
    expect(owner).toContain("key: 'held.noRight', params: { right: rightRef('threads.post') }")
    const model = read('./model.ts')
    expect(model).toContain("export type FrameDoor = 'approve' | 'followers' | 'owner'")
  })

  it('the order dock: the record\'s scope (only what is offered), once per ask, the view kept (narrow + closed: no term)', async () => {
    const { scopeOfRecord, scopeValueOf, sameScope, ORDER_SCOPE } = await import('../../sales/orders/record/dock/model')
    const offer = { general: true, all: true, projects: ['pr1'], workOrders: ['w1'] }
    const page = { orderId: 'o1', partyId: 'p1' }
    expect(scopeOfRecord(PARTY, page, offer)).toEqual({ kind: 'general' })
    expect(scopeOfRecord({ type: 'Project', id: 'pr1' }, page, offer)).toEqual({ kind: 'project', id: 'pr1' })
    expect(scopeOfRecord(WO, page, offer)).toEqual({ kind: 'wo', id: 'w1' })
    // Not offered, another order, another customer, another kind: no move (never a hint).
    expect(scopeOfRecord({ type: 'WorkOrder', id: 'w9' }, page, offer)).toBeNull()
    expect(scopeOfRecord({ type: 'SalesOrder', id: 'o2' }, page, offer)).toBeNull()
    expect(scopeOfRecord({ type: 'Party', id: 'p2' }, page, offer)).toBeNull()
    expect(scopeOfRecord(PARTY, page, { ...offer, general: false })).toBeNull()
    expect(scopeOfRecord({ type: 'Shipment', id: 's1' }, page, offer)).toBeNull()
    // The view as it is: docked no term; narrow and open `open`; narrow and closed no term (a file never pops the view open).
    expect(scopeValueOf(ORDER_SCOPE, false, true)).toBeNull()
    expect(scopeValueOf(ORDER_SCOPE, true, false)).toBe('open')
    expect(scopeValueOf(ORDER_SCOPE, true, true)).toBeNull()
    expect(scopeValueOf({ kind: 'general' }, true, true)).toBe('general')
    expect(sameScope(ORDER_SCOPE, { kind: 'order' })).toBe(true)
    expect(sameScope({ kind: 'wo', id: 'w1' }, { kind: 'wo', id: 'w2' })).toBe(false)
    const dock = read('../../sales/orders/record/dock/OrderDock.tsx')
    expect(dock).toContain('const pending = pendingAskOf(frame)')
    expect(dock).toContain('now.frame?.setThread?.(scopeValueOf(target, now.narrow, now.closed))')
    expect(dock).toContain('}, [pending?.ask, targetValue])')
    expect(dock).not.toContain('const asking =')
  })

  it('the customer page (→ its general thread, or the record picked) and the work order (→ its notes, or an order of its pick) switch first', () => {
    const work = read('../../sales/customers/record/view/WorkTab.tsx')
    const dock = work.slice(work.indexOf('function Dock('))
    expect(dock).toContain('const pending = pendingAskOf(frame)')
    expect(dock).toContain("askFor.type === 'Party' ? (askFor.id === customer.id ? 'general' : null)")
    expect(dock).toContain('if (follow && latest.current.scope !== follow) latest.current.onScope(follow)')
    // The hooks before the page's "no threads.read: no dock" return.
    expect(dock.indexOf('const pending = pendingAskOf(frame)')).toBeLessThan(dock.indexOf('if (general === null || general === undefined) return null'))
    const wo = read('../../production/work-orders/record/WorkOrderRecord.tsx')
    expect(wo).toContain('<FollowFrameAsks workOrderId={value.id} choices={choices} pick={threadPick} onPick={orderFiles.setPick} /* F-OP-212 */ />')
    expect(wo).toContain("record.type === 'WorkOrder' ? (record.id === workOrderId ? 'workOrder' : null)")
  })
})
// ---- end F-OP-212

// ---- F-OP-206 (order page plan N4; 11-dock §3.3): the Keyboard window's rows of All of <Customer>'s list, only where the dock holds it
describe('F-OP-206 — the Keyboard window names All of <Customer>\'s keys on the order and customer pages only', () => {
  it('Enter answers the line, Space shows the whole message; never on a page whose dock has no All of', async () => {
    const { ALL_OF_KEYS, ALL_OF_PAGES, frameKeysFor } = await import('./model')
    expect(ALL_OF_KEYS.map((entry) => entry.words)).toEqual(['keys.allAnswer', 'keys.allExpand'])
    expect(ALL_OF_PAGES).toEqual(['SalesOrder', 'Party'])
    expect(frameKeysFor({ type: 'SalesOrder' })).toEqual([...FRAME_KEYS, ...ALL_OF_KEYS])
    expect(frameKeysFor({ type: 'Party' })).toEqual([...FRAME_KEYS, ...ALL_OF_KEYS])
    for (const other of [{ type: 'WorkOrder' }, { type: 'Invoice' }, null, undefined]) expect(frameKeysFor(other)).toBe(FRAME_KEYS)
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale]['record-frame'] ?? {}
      for (const entry of ALL_OF_KEYS) expect(words[entry.words], `${locale} ${entry.words}`).toBeTruthy()
    }
    expect(CATALOGUE.it['record-frame']?.['keys.allExpand']).toContain('mostra tutto il messaggio')
  })
})
// ---- end F-OP-206
