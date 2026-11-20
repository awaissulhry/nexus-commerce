import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { createTranslator, messagesFor } from '../i18n/messages'
import { PICTURE_ROUTES } from './api'
import { failedRecently, keepSmall, recordOf, resetPictureCache, smallOf, staleOf, drawn, want, type ReadPictures } from './cache'
import { BATCH_MAX, BATCH_WAIT_MS, batchesOf, faceOf, fallbackOf, moreOf, PICTURE_FIT, PICTURE_PX, RETRY_AFTER_MS, rowPictureOf, styleWords, untilOf, wantsSmall, type PictureAnswer } from './model'
import { RECORD_PICTURE_NS } from './view/RecordPicture'
// F-SA-283: the part drawn on the server (as the design index draws it).
import { createElement } from 'react'
import { render } from '../record-thread/parts/testing'
import { RecordPicture } from './view/RecordPicture'
import { tilePicture, tileWords, type StyleTile } from './styles' // F-CP-110

/**
 * F-SA-211 (sales page plan N8, picks P13, P18, R9; 12-lists-board §2) — the ONE picture part: its sizes and fit, the cache keyed
 * by FILE id with its expiry, the batch queue (one call per source within 30 ms, at most 200 ids), the placeholder states, a
 * failed batch asked again only after 30 s (no storm), and its one word set in both languages.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const NOW = Date.parse('2026-11-18T10:00:00.000Z')
const answer = (id: string, fileId: string | null, more: Partial<PictureAnswer> = {}): PictureAnswer => ({
  id,
  styleId: `style-${fileId ?? 'none'}`,
  styleCode: 'STY-01',
  styleName: 'Demo jacket',
  styleCount: 1,
  fileId,
  contentType: fileId ? 'image/jpeg' : null,
  small: fileId ? { url: `https://store.example.com/${fileId}?sig=1`, expiresAt: new Date(NOW + 60_000).toISOString() } : null,
  ...more,
})

beforeEach(() => {
  resetPictureCache()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  resetPictureCache()
})

describe('sizes and fit', () => {
  it('a cell 36 px, a board card 64 px (72 from 1680 px wide), a phone card 48 px, an order line 40 / 56 px', () => {
    expect(PICTURE_PX).toEqual({ cell: 36, board: 64, phone: 48, line: 40, lineLarge: 56 })
    const css = readFileSync(join(HERE, 'record-picture.css'), 'utf8')
    expect(css).toMatch(/@media \(min-width: 1680px\)\s*\{\s*\.fw-rpic-board\s*\{\s*--fw-rpic-size: 72px;/)
    for (const [size, px] of Object.entries(PICTURE_PX)) expect(css, size).toContain(`--fw-rpic-size: ${px}px;`)
  })
  it('a cell crops (today\'s look); a card, a phone card and a line fit (a garment photo is portrait)', () => {
    expect(PICTURE_FIT).toEqual({ cell: 'cover', board: 'contain', phone: 'contain', line: 'contain', lineLarge: 'contain' })
  })
  it('layout only, with design-system tokens: no raw colour', () => {
    const css = readFileSync(join(HERE, 'record-picture.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})

describe('the names and the placeholder states', () => {
  const picture = { styleId: 's1', styleCode: 'STY-01', styleName: 'Demo jacket', fileId: 'f1', small: true }
  it('"+N" is the other styles; the style in words', () => {
    expect(moreOf(3)).toBe(2)
    expect(moreOf(1)).toBe(0)
    expect(moreOf(0)).toBe(0)
    expect(moreOf(undefined)).toBe(0)
    expect(styleWords(picture)).toBe('STY-01 Demo jacket')
    expect(styleWords(null)).toBeNull()
  })
  it('a small preview is read only for a file this reader may open whose preview is made', () => {
    expect(wantsSmall(picture)).toBe(true)
    expect(wantsSmall({ ...picture, small: false })).toBe(false)
    expect(wantsSmall({ ...picture, fileId: null })).toBe(false)
    expect(wantsSmall(null)).toBe(false)
  })
  it('the face: the picture when a style is named, the file kinds (Incoming), the placeholder, or the wait while the batch names it', () => {
    expect(faceOf(picture, null)).toBe('picture')
    expect(faceOf({ ...picture, fileId: null, small: false }, null)).toBe('picture')
    expect(faceOf(null, { photos: 2, documents: 1 })).toBe('files')
    expect(faceOf(null, { photos: 0, documents: 0 })).toBe('none')
    expect(faceOf(null, null)).toBe('none')
    expect(faceOf(undefined, null)).toBe('reading')
    expect(fallbackOf({ photos: 1, documents: 1 })).toEqual({ kind: 'photos', count: 1 })
    expect(fallbackOf({ photos: 0, documents: 3 })).toEqual({ kind: 'documents', count: 3 })
  })
  it('the part never draws a disabled button: a placeholder is an image with words', () => {
    const source = readFileSync(join(HERE, 'view/RecordPicture.tsx'), 'utf8')
    expect(source).not.toMatch(/disabled=/)
    expect(source).toMatch(/role="img"/)
  })
})

describe('the one cache, keyed by file id', () => {
  it('an address is used until shortly before it expires; ten records of one file share it', () => {
    keepSmall('f1', { url: 'u1', expiresAt: new Date(NOW + 60_000).toISOString() })
    expect(smallOf('f1')).toBe('u1')
    expect(untilOf(new Date(NOW + 60_000).toISOString())).toBe(NOW + 55_000)
    vi.setSystemTime(NOW + 54_999)
    expect(smallOf('f1')).toBe('u1')
    vi.setSystemTime(NOW + 55_000)
    expect(smallOf('f1')).toBeNull()
  })
  it('stale-while-reading: the address last drawn stays known after it expired', () => {
    drawn('f1', 'old')
    expect(staleOf('f1')).toBe('old')
    expect(staleOf('f2')).toBeNull()
  })
  it('a new main picture is a new file id: the cache never shows the old photo', () => {
    keepSmall('f1', { url: 'u1', expiresAt: new Date(NOW + 60_000).toISOString() })
    expect(smallOf('f2')).toBeNull()
  })
})

describe('the batch queue', () => {
  it('asks of one source within 30 ms go out as ONE call; the answers fill the cache by file and by record', async () => {
    const read = vi.fn<ReadPictures>(async (_source, ids) => ids.map((id) => answer(id, id === 'o3' ? null : 'f1')))
    const asks = [want('order', 'o1', read), want('order', 'o2', read), want('order', 'o3', read), want('order', 'o1', read)]
    expect(read).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BATCH_WAIT_MS)
    const got = await Promise.all(asks)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('order', ['o1', 'o2', 'o3'])
    expect(got[0]).toEqual({ answer: expect.objectContaining({ id: 'o1', fileId: 'f1' }) })
    expect(got[3]).toBe(got[0])
    expect(smallOf('f1')).toBe('https://store.example.com/f1?sig=1')
    expect(recordOf('order', 'o3')).toMatchObject({ fileId: null, small: null })
  })
  it('each source its own call; a record the reader may not see is absent: null, no error', async () => {
    const read = vi.fn<ReadPictures>(async (source, ids) => (source === 'quote' ? [] : ids.map((id) => answer(id, 'f9'))))
    const asks = [want('order', 'a', read), want('quote', 'q', read)]
    await vi.advanceTimersByTimeAsync(BATCH_WAIT_MS)
    const [order, quote] = await Promise.all(asks)
    expect(read).toHaveBeenCalledTimes(2)
    expect(order).toEqual({ answer: expect.objectContaining({ id: 'a' }) })
    expect(quote).toEqual({ answer: null })
    expect(recordOf('quote', 'q')).toBeNull()
  })
  it('at most 200 ids a call: a full batch goes out at once, the rest in the next', async () => {
    const read = vi.fn<ReadPictures>(async (_source, ids) => ids.map((id) => answer(id, null)))
    const asks = Array.from({ length: BATCH_MAX + 5 }, (_, n) => want('request', `r${n}`, read))
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).toHaveLength(BATCH_MAX)
    await vi.advanceTimersByTimeAsync(BATCH_WAIT_MS)
    await Promise.all(asks)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]![1]).toHaveLength(5)
    expect(batchesOf(['a', 'b', 'a', 'c'], 2)).toEqual([['a', 'b'], ['c']])
  })
  it('a failed batch: the placeholder now, asked again only at a mount after 30 s (no retry storm)', async () => {
    const read = vi.fn<ReadPictures>(async () => {
      throw new Error('offline')
    })
    const first = want('order', 'o1', read)
    await vi.advanceTimersByTimeAsync(BATCH_WAIT_MS)
    expect(await first).toEqual({ failed: true })
    expect(failedRecently('order', 'o1')).toBe(true)
    // A re-mount inside the wait asks nothing.
    expect(await want('order', 'o1', read)).toEqual({ failed: true })
    expect(read).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + RETRY_AFTER_MS)
    read.mockImplementation(async (_source, ids) => ids.map((id) => answer(id, 'f1')))
    const again = want('order', 'o1', read)
    await vi.advanceTimersByTimeAsync(BATCH_WAIT_MS)
    expect(await again).toEqual({ answer: expect.objectContaining({ fileId: 'f1' }) })
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('a row picture from the answer (the week board names none of its own)', () => {
    expect(rowPictureOf(answer('o1', 'f1'))).toEqual({ styleId: 'style-f1', styleCode: 'STY-01', styleName: 'Demo jacket', fileId: 'f1', small: true })
    expect(rowPictureOf(answer('o2', null))).toMatchObject({ fileId: null, small: false })
  })
})

describe('the reads and the words', () => {
  it('one route per source, each with its own id list (the walled batch reads)', () => {
    expect(PICTURE_ROUTES).toEqual({
      order: { path: '/sales/orders/pictures', key: 'orderIds' },
      quote: { path: '/sales/quotes/pictures', key: 'quoteIds' },
      request: { path: '/sales/inquiries/pictures', key: 'inquiryIds' },
      // F-SA-283 (B-SA-074): Production › Work orders and the planning board.
      workorder: { path: '/production/work-orders/pictures', key: 'workOrderIds' },
    })
  })
  it('the local store\'s address through /api (#1649), a store\'s absolute address as it is', () => {
    const source = readFileSync(join(HERE, 'api.ts'), 'utf8')
    expect(source).toContain('browserAddress(picture.small.url)')
  })
  it('one word set, in both languages ("modello" for the style, as the catalogue says)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [RECORD_PICTURE_NS])[RECORD_PICTURE_NS]!)
      for (const key of ['open', 'noneOf', 'reading', 'alt', 'more', 'viewerOf', 'close', 'openRecord', 'openStyle', 'none', 'small', 'files.door']) expect(t(key, { number: 'SO-1', style: 'S', count: 2 }), `${locale} ${key}`).not.toBe(key)
      expect(t('moreStyles', { count: 1 }), locale).not.toBe('moreStyles')
      expect(t('files.photos', { count: 2 }), locale).not.toBe('files.photos')
    }
    const it = createTranslator('it', messagesFor('it', [RECORD_PICTURE_NS])[RECORD_PICTURE_NS]!)
    expect(it('openStyle')).toBe('Apri il modello')
    expect(it('open', { number: 'SO-1' })).toBe("Mostra in grande l'immagine di SO-1")
    const en = createTranslator('en', messagesFor('en', [RECORD_PICTURE_NS])[RECORD_PICTURE_NS]!)
    expect(en('moreStyles', { count: 2 })).toBe('+2 more styles: open its lines')
  })
})

// ── F-SA-283: the part on a page that reads no batch (a design case; a reader without the batch route's right) ─────────────────────
describe('F-SA-283 — a row that names no picture and has no read: the placeholder, never the wait', () => {
  it('draws the neutral placeholder at once ("WO-0012 has no picture yet"), no busy shirt, no button', () => {
    const html = render(createElement(RecordPicture, { source: 'workorder', recordId: 'wo-1', number: 'WO-0012', size: 'board' }))
    expect(html).toContain('aria-label="WO-0012 has no picture yet"')
    expect(html).not.toContain('aria-busy')
    expect(html).not.toContain('<button')
    // With a read the row's picture is named by the batch: the wait first (the read runs after the first draw).
    const reading = render(createElement(RecordPicture, { source: 'workorder', recordId: 'wo-2', number: 'WO-0013', size: 'board', read: async () => [] }))
    expect(reading).toContain('aria-label="Reading the picture of WO-0013"')
    const italian = render(createElement(RecordPicture, { source: 'workorder', recordId: 'wo-1', number: 'WO-0012', size: 'board' }), 'it')
    expect(italian).toContain("WO-0012 non ha ancora un&#x27;immagine")
  })
})
// ── end F-SA-283

// ---- F-CP-110 (customer page plan C2c): the viewer's styles strip — every line's picture, read once, never a price -----------------
describe('F-CP-110: the picture viewer shows every style of the record', () => {
  const tile: StyleTile = { key: 'l1', styleId: 's1', styleCode: 'STY-01', styleName: 'Giacca demo', colour: 'BLK Nero', fileId: 'f1', small: { url: 'https://files.example.com/s1.webp', expiresAt: '2026-11-18T10:01:00.000Z' } }

  it('a tile in words (style · colour) and as the one picture part takes it (its preview held: no batch read)', () => {
    expect(tileWords(tile)).toBe('STY-01 · BLK Nero')
    expect(tileWords({ styleCode: 'STY-02', colour: null })).toBe('STY-02')
    expect(tilePicture(tile)).toEqual({ styleId: 's1', styleCode: 'STY-01', styleName: 'Giacca demo', fileId: 'f1', small: true })
    expect(tilePicture({ ...tile, fileId: null, small: null }).small).toBe(false)
  })

  it('the strip only with "+N" and a host read; reading = skeleton tiles; failed = words, Try again and the lines door; a click shows it large', () => {
    const viewer = readFileSync(join(HERE, 'view/PictureViewer.tsx'), 'utf8')
    expect(viewer).toContain('const styles = useRecordStyles(readStyles, recordId, more > 0)')
    expect(viewer).toContain('<Skeleton width={40} height={40} />')
    expect(viewer).toContain("{t('stylesFailed')}")
    expect(viewer).toContain('onClick={styles.retry}')
    expect(viewer).toContain("(styles.state.status === 'off' || styles.state.status === 'failed')")
    expect(viewer).toContain('held={tile.small} onOpen={() => setShown(tile)}')
    // Open style follows the one shown (the footer reads `picture`, the shown tile's when one is picked).
    expect(viewer).toContain('const picture = shown ? tilePicture(shown) : first')
    const hook = readFileSync(join(HERE, 'styles.ts'), 'utf8')
    expect(hook).toContain('return () => controller.abort()')
  })

  it('no price in a tile: the strip holds the style, the colour and the picture only', () => {
    expect(Object.keys(tile).sort()).toEqual(['colour', 'fileId', 'key', 'small', 'styleCode', 'styleId', 'styleName'])
    const viewer = readFileSync(join(HERE, 'view/PictureViewer.tsx'), 'utf8')
    expect(viewer).not.toMatch(/unitPrice|netAmount|money\(/)
  })

  it('the words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [RECORD_PICTURE_NS])[RECORD_PICTURE_NS]!)
      expect(t('styles', { number: 'SO-2026-0142' }), locale).toContain('SO-2026-0142')
      for (const key of ['stylesFailed', 'retry']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-CP-110

// ---- F-CP-107 (cp-fx14; customer page walk L2): the picture part's class family is its own — `fw-rpic`, never Incoming's
// reading pane's `fw-rp` (inquiries/view/pane/pane.css). Both style sheets are loaded at once: one shared name made this part's
// `all: unset; flex: none; align-items / justify-content: center; background; border` land on the pane (SCR-105's pane over the list,
// the customer's draft window narrow and centred) and the pane's `height: 100%` / `.fw-rp-wait` on this part.
describe('F-CP-107 — the picture part has its own class family (fw-rpic); it shares no class with the reading pane', () => {
  const classesOf = (css: string): Set<string> => new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]!).filter((name) => !name.startsWith('is-')))
  const picture = classesOf(readFileSync(join(HERE, 'record-picture.css'), 'utf8'))
  const pane = classesOf(readFileSync(join(HERE, '../../areas/sales/inquiries/view/pane/pane.css'), 'utf8'))

  it('every class of the part is fw-rpic / fw-rpic-*; the reading pane keeps fw-rp; the two share none', () => {
    expect(picture.size).toBeGreaterThan(15)
    for (const name of picture) expect(name).toMatch(/^fw-rpic(-|$)/)
    expect(pane.has('fw-rp')).toBe(true)
    expect([...picture].filter((name) => pane.has(name))).toEqual([])
    expect([...pane].filter((name) => /^fw-rpic(-|$)/.test(name))).toEqual([])
  })

  it('the part and its viewer draw only fw-rpic classes (never fw-rp / fw-rp-*)', () => {
    for (const file of ['view/RecordPicture.tsx', 'view/PictureViewer.tsx']) expect(readFileSync(join(HERE, file), 'utf8'), file).not.toMatch(/fw-rp(?![a-zA-Z0-9])/)
    for (const size of ['cell', 'board', 'phone', 'line', 'lineLarge'] as const) {
      const html = render(createElement(RecordPicture, { source: 'workorder', recordId: 'wo-1', number: 'WO-0012', size }))
      expect(html, size).toContain(`class="fw-rpic fw-rpic-${size === 'lineLarge' ? 'line-large' : size} fw-rpic-none"`)
      expect(html, size).not.toMatch(/fw-rp(?![a-zA-Z0-9])/)
    }
  })
})
// ---- end F-CP-107
