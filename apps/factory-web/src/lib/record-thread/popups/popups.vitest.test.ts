import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { designScreen } from './fixtures'
import {
  cardWordKey,
  checkWords,
  hasUnsent,
  heldWordKey,
  ORIGINAL_SANDBOX,
  originalDocument,
  photoRun,
  remotePictures,
  SENDER_CHECKS,
  viewerList,
  viewerShow,
  walk,
  type ViewerFile,
} from './model'
import { CountPopover } from './view/CountPopover'

/**
 * B-TH-211 — the thread's shared pop-ups (T-POP): the viewer by kind and only what the reader may open (W25), the original
 * e-mail sandboxed with no script, no form, no remote picture until asked and its links as text (W20, W22), the leave
 * guard, the words of every key in it and en, and every design case drawn with no key on screen.
 */

const KEY_ON_SCREEN = /\b(viewer|original|leave|close|send|count|kind|design)\.[a-zA-Z]/

const file = (over: Partial<ViewerFile>): ViewerFile => ({
  id: 'f',
  name: 'x.pdf',
  contentType: 'application/pdf',
  kind: 'DOCUMENT',
  sizeBytes: 1,
  status: 'AVAILABLE',
  quarantineReason: null,
  src: 'blob:x',
  downloadHref: '#',
  mayOpen: true,
  ...over,
})

describe('the file viewer', () => {
  it('shows a file by its kind: a photo, PDF pages, a card, or held', () => {
    expect(viewerShow(file({ contentType: 'image/jpeg' }))).toBe('photo')
    expect(viewerShow(file({ contentType: 'image/png' }))).toBe('photo')
    expect(viewerShow(file({ contentType: 'application/pdf' }))).toBe('pdf')
    // A browser cannot draw HEIC: the card with Download.
    expect(viewerShow(file({ contentType: 'image/heic' }))).toBe('card')
    expect(viewerShow(file({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))).toBe('card')
    expect(viewerShow(file({ contentType: 'image/jpeg', status: 'QUARANTINED' }))).toBe('held')
    expect(cardWordKey(file({ contentType: 'image/heic', kind: 'PHOTO' }))).toBe('viewer.card.heic')
    expect(cardWordKey(file({ contentType: 'audio/webm', kind: 'AUDIO' }))).toBe('viewer.card.audio')
    expect(cardWordKey(file({ contentType: 'application/vnd.oasis.opendocument.text' }))).toBe('viewer.card.office')
    expect(heldWordKey('scan_pending')).toBe('viewer.held.scanPending')
    expect(heldWordKey('virus_found')).toBe('viewer.held.infected')
    expect(heldWordKey('size_mismatch')).toBe('viewer.held.checks')
  })

  it('opens only the files the reader may open: the others are counted, never listed (W25)', () => {
    const own = file({ id: 'b', name: BRAND_BETA.fileName })
    const other = file({ id: 'a', name: BRAND_ALPHA.fileName, mayOpen: false })
    const coming = file({ id: 'c', name: 'coming.pdf', status: 'PENDING_UPLOAD' })
    const { items, cannotOpen } = viewerList([own, other, coming])
    expect(items.map((item) => item.id)).toEqual(['b'])
    expect(cannotOpen).toBe(1)
    expect(scanText(JSON.stringify(items), BRAND_ALPHA)).toEqual([])
  })

  it('walks without wrapping and finds a photo among the photos', () => {
    expect(walk(0, 3, -1)).toBeNull()
    expect(walk(2, 3, 1)).toBeNull()
    expect(walk(1, 3, 1)).toBe(2)
    const items = [file({ id: 'p1', contentType: 'image/jpeg' }), file({ id: 'd' }), file({ id: 'p2', contentType: 'image/webp' })]
    expect(photoRun(items, 2)).toEqual({ photos: [items[0], items[2]], at: 1 })
  })
})

describe('the original e-mail', () => {
  const html = '<p>Hi <a href="https://x.example/track">track</a></p><img data-remote-src="https://x.example/p.png"><form action="https://x.example/f"></form>'

  it('runs nothing: the frame allows nothing, the page has no script and no remote picture until asked (W20, W22)', () => {
    expect(ORIGINAL_SANDBOX).toBe('')
    const page = originalDocument(html, { allowPictures: false })
    expect(page).toContain("default-src 'none'")
    expect(page).toContain('img-src data:;')
    expect(page).not.toContain(' src="https://x.example/p.png"')
    expect(page).toContain('data-remote-src=')
    expect(page).not.toMatch(/<script/i)
    expect(remotePictures(html)).toBe(1)
    const allowed = originalDocument(html, { allowPictures: true })
    expect(allowed).toContain('img-src https: data:')
    expect(allowed).toContain(' src="https://x.example/p.png"')
  })

  it('shows links and forms as text: nothing to follow', () => {
    const page = originalDocument(html, { allowPictures: true })
    expect(page).not.toContain('href=')
    expect(page).not.toContain('action=')
    expect(page).toContain('track</a>')
  })

  it('says each sender check in words', () => {
    expect(checkWords('spf', 'PASS')).toEqual({ key: 'original.check.spf.pass', tone: 'success' })
    expect(checkWords('dmarc', 'FAIL')).toEqual({ key: 'original.check.dmarc.fail', tone: 'danger' })
    expect(checkWords('dkim', 'GRAY').key).toBe('original.check.gray')
    expect(checkWords('dkim', 'DISABLED').key).toBe('original.check.notChecked')
  })
})

describe('leaving with unsent text', () => {
  it('asks only when words or files would be lost', () => {
    expect(hasUnsent({ text: '' })).toBe(false)
    expect(hasUnsent({ text: '  \n ' })).toBe(false)
    expect(hasUnsent({ text: 'Ciao' })).toBe(true)
    expect(hasUnsent({ text: '', files: 1 })).toBe(true)
  })
})

describe('the words', () => {
  it('has every key the pop-ups use, in it and en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-popups'])['record-thread-popups'] ?? {})
      const keys = [
        ...SENDER_CHECKS.flatMap((check) => [`original.check.${check}.pass`, `original.check.${check}.fail`]),
        'original.check.gray', 'original.check.notChecked',
        ...['scanPending', 'infected', 'scanFailed', 'checks'].map((key) => `viewer.held.${key}`),
        ...['heic', 'audio', 'office', 'other'].map((key) => `viewer.card.${key}`),
        ...['tasks', 'approvals', 'partners', 'followers'].flatMap((kind) => [`count.title.${kind}`, `count.none.${kind}`, `count.action.${kind}`]),
        ...['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE', 'FISCAL_ARCHIVE', 'AUDIO'].map((kind) => `kind.${kind}`),
        'close.conflict', 'leave.title', 'send.title',
      ]
      for (const key of keys) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('viewer.cannotOpen', { count: 1 })).not.toBe(t('viewer.cannotOpen', { count: 2 }))
    }
  })

  it('draws every case of SCR-006-popups with no key on screen', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
      }
    }
  })

  it('a count popover names its count for screen readers', () => {
    const html = renderToString(
      createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(CountPopover, { model: { kind: 'tasks', count: 2, lines: [] }, trigger: '2', triggerLabel: 'Tasks (2)' })),
    )
    expect(html).toContain('Tasks (2)')
  })
})
