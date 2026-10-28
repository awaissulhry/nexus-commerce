/**
 * The PDF viewer with pdf.js injected (a fake pdf.js here: the design system never imports `pdfjs-dist`) and without it
 * (the browser's own view, or the download). Node, no DOM: the open flow, the steps, the drawing into a canvas stand-in
 * and the markup of every state are checked here; a real PDF in a real browser is checked on the catalog page.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PdfJsProvider, PdfViewer, PdfViewerView, PDF_VIEWER_LABELS, type PdfViewerViewProps } from './PdfViewer'
import {
  canShowPdfInline,
  fitWidthScale,
  isRenderCancel,
  openPdf,
  PdfOpenCancelled,
  pdfFileName,
  pdfSource,
  pdfViewerReducer,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  renderPdfPage,
  stepZoom,
  type PdfDocumentLike,
  type PdfJsLike,
  type PdfPageLike,
  type PdfSource,
  type PdfViewerState,
} from './pdfViewerModel'

/** A fake pdf.js: an A4 page is 595 × 842 points at scale 1. Records what it was asked. */
function fakePdfJs(pageCount = 3, fail?: 'open' | 'render') {
  const calls = { sources: [] as PdfSource[], renders: [] as Array<{ scale: number; canvasWidth: number }>, destroyed: 0 }
  const page = (n: number): PdfPageLike => ({
    getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale }),
    render: ({ canvas, viewport }) => {
      calls.renders.push({ scale: viewport.width / 595, canvasWidth: canvas?.width ?? 0 })
      return { promise: fail === 'render' ? Promise.reject(new Error(`page ${n} broke`)) : Promise.resolve(), cancel: vi.fn() }
    },
  })
  const document: PdfDocumentLike = { numPages: pageCount, getPage: async (n) => page(n), destroy: () => void calls.destroyed++ }
  const pdfjs: PdfJsLike = {
    getDocument: (source) => {
      calls.sources.push(source)
      return { promise: fail === 'open' ? Promise.reject(new Error('InvalidPDFException')) : Promise.resolve(document), destroy: vi.fn() }
    },
  }
  return { pdfjs, document, calls, load: vi.fn(async () => pdfjs) }
}

/** A canvas stand-in: what `renderPdfPage` touches. */
function fakeCanvas() {
  return { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ({}) } as unknown as HTMLCanvasElement
}

describe('the injected pdf.js path (a fake pdf.js)', () => {
  it('loads pdf.js once, opens the address, and the reducer shows page 1 of N at fit width', async () => {
    const fake = fakePdfJs(5)
    const doc = await openPdf(fake.load, '/files/quote.pdf').promise
    expect(fake.load).toHaveBeenCalledTimes(1)
    expect(fake.calls.sources).toEqual([{ url: '/files/quote.pdf' }])
    const state = pdfViewerReducer({ status: 'loading' }, { type: 'loaded', pageCount: doc.numPages })
    expect(state).toEqual({ status: 'ready', pageCount: 5, page: 1, zoom: 'fit', pageError: false })
  })
  it('hands pdf.js a COPY of the bytes (its worker detaches the buffer it gets)', async () => {
    const fake = fakePdfJs()
    const bytes = new Uint8Array([37, 80, 68, 70])
    await openPdf(fake.load, bytes).promise
    const sent = (fake.calls.sources[0] as { data: Uint8Array }).data
    expect(Array.from(sent)).toEqual([37, 80, 68, 70])
    expect(sent).not.toBe(bytes)
    expect(sent.buffer).not.toBe(bytes.buffer)
  })
  it('a document pdf.js cannot open rejects (the viewer shows its error state)', async () => {
    const fake = fakePdfJs(1, 'open')
    await expect(openPdf(fake.load, '/broken.pdf').promise).rejects.toThrow('InvalidPDFException')
    expect(pdfViewerReducer({ status: 'loading' }, { type: 'failed' })).toEqual({ status: 'error' })
  })
  it('a loader that fails (pdf.js not reachable) rejects too', async () => {
    await expect(openPdf(() => Promise.reject(new Error('chunk failed')), '/a.pdf').promise).rejects.toThrow('chunk failed')
  })
  it('a cancelled open is not a failure, and the document that arrives late is destroyed', async () => {
    const fake = fakePdfJs()
    const open = openPdf(fake.load, '/a.pdf')
    open.cancel()
    await expect(open.promise).rejects.toBeInstanceOf(PdfOpenCancelled)
    const late = openPdf(fake.load, '/a.pdf')
    await late.promise
    late.cancel()
    expect(fake.calls.destroyed).toBe(1)
  })
  it('draws a page into the canvas at the screen’s pixel density, shown at CSS size', async () => {
    const fake = fakePdfJs()
    const canvas = fakeCanvas()
    const page = await fake.document.getPage(1)
    const drawn = renderPdfPage(page, canvas, 1.25, 2)
    await drawn.task.promise
    expect(fake.calls.renders).toEqual([{ scale: 2.5, canvasWidth: Math.floor(595 * 2.5) }])
    expect(canvas.style.width).toBe(`${Math.floor(595 * 1.25)}px`)
    expect(drawn.width).toBeCloseTo(595 * 1.25)
  })
  it('a page that fails to draw is reported; a cancelled draw is not', async () => {
    const fake = fakePdfJs(2, 'render')
    const page = await fake.document.getPage(2)
    await expect(renderPdfPage(page, fakeCanvas(), 1).task.promise).rejects.toThrow('page 2 broke')
    const ready: PdfViewerState = { status: 'ready', pageCount: 2, page: 2, zoom: 'fit', pageError: false }
    expect(pdfViewerReducer(ready, { type: 'pageError', failed: true })).toMatchObject({ pageError: true })
    expect(isRenderCancel({ name: 'RenderingCancelledException' })).toBe(true)
    expect(isRenderCancel(new Error('x'))).toBe(false)
  })
})

describe('pages and zoom', () => {
  const ready: PdfViewerState = { status: 'ready', pageCount: 3, page: 1, zoom: 'fit', pageError: false }
  it('next / prev stay inside the document; Home / End jump', () => {
    let s = pdfViewerReducer(ready, { type: 'prev' })
    expect(s).toMatchObject({ page: 1 })
    s = pdfViewerReducer(pdfViewerReducer(pdfViewerReducer(s, { type: 'next' }), { type: 'next' }), { type: 'next' })
    expect(s).toMatchObject({ page: 3 })
    expect(pdfViewerReducer(s, { type: 'page', page: 1 })).toMatchObject({ page: 1 })
    expect(pdfViewerReducer(s, { type: 'page', page: 99 })).toMatchObject({ page: 3 })
  })
  it('zoom steps from fit width’s own scale, between the fixed steps; fit returns to fit', () => {
    const fit = fitWidthScale(700, 595) // 1.176…
    expect(fit).toBeCloseTo(1.176, 3)
    const zoomedIn = pdfViewerReducer(ready, { type: 'zoom', direction: 1, fitScale: fit })
    expect(zoomedIn).toMatchObject({ zoom: 1.25 })
    expect(pdfViewerReducer(ready, { type: 'zoom', direction: -1, fitScale: fit })).toMatchObject({ zoom: 1 })
    expect(pdfViewerReducer(zoomedIn, { type: 'fit' })).toMatchObject({ zoom: 'fit' })
    expect(stepZoom(PDF_ZOOM_MAX, 1)).toBe(PDF_ZOOM_MAX)
    expect(stepZoom(PDF_ZOOM_MIN, -1)).toBe(PDF_ZOOM_MIN)
  })
  it('fit width is held to the zoom range, and is 1 before anything is measured', () => {
    expect(fitWidthScale(0, 595)).toBe(1)
    expect(fitWidthScale(100, 595)).toBe(PDF_ZOOM_MIN)
    expect(fitWidthScale(5000, 595)).toBe(PDF_ZOOM_MAX)
  })
  it('a document with no pages is an error; steps do nothing outside the ready state', () => {
    expect(pdfViewerReducer({ status: 'loading' }, { type: 'loaded', pageCount: 0 })).toEqual({ status: 'error' })
    const loading: PdfViewerState = { status: 'loading' }
    expect(pdfViewerReducer(loading, { type: 'next' })).toBe(loading)
    expect(pdfViewerReducer(ready, { type: 'pageError', failed: false })).toBe(ready)
  })
})

describe('sources, download names and the browser’s own view', () => {
  it('an address is fetched by pdf.js; bytes are passed as data', () => {
    expect(pdfSource('https://x.example/a.pdf')).toEqual({ url: 'https://x.example/a.pdf' })
    expect('data' in pdfSource(new Uint8Array([1]).buffer)).toBe(true)
  })
  it('names the download after the title, safely, ending in .pdf', () => {
    expect(pdfFileName('Quote Q-1042')).toBe('Quote Q-1042.pdf')
    expect(pdfFileName('DoC: style 12/a')).toBe('DoC- style 12-a.pdf')
    expect(pdfFileName('ignored', 'invoice-77.PDF')).toBe('invoice-77.PDF')
  })
  it('the browser’s own view only where the browser says it has one (Android Chrome says no)', () => {
    expect(canShowPdfInline({ pdfViewerEnabled: true })).toBe(true)
    expect(canShowPdfInline({ pdfViewerEnabled: false })).toBe(false)
    expect(canShowPdfInline({})).toBe(false)
    expect(canShowPdfInline(undefined)).toBe(false)
  })
})

const view = (over: Partial<PdfViewerViewProps>) =>
  renderToStaticMarkup(
    createElement(PdfViewerView, {
      state: { status: 'loading' },
      title: 'Quote Q-1042',
      words: PDF_VIEWER_LABELS,
      scale: 1,
      url: 'https://files.example.com/q-1042.pdf',
      download: { fileName: 'Quote Q-1042.pdf' },
      ...over,
    }),
  )

describe('the markup of each state', () => {
  it('loading: a named region, a busy page area and a status that says so', () => {
    const html = view({})
    expect(html).toContain('<section class="nds-pdf" aria-label="Quote Q-1042">')
    expect(html).toContain('aria-busy="true"')
    expect(html).toMatch(/role="status"[^>]*>.*Opening the document/)
  })
  it('error: said as an alert, with Try again and the download', () => {
    const html = view({ state: { status: 'error' }, onRetry: () => {} })
    expect(html).toMatch(/role="alert"><span>This document could not be opened\.<\/span>/)
    expect(html).toContain('Try again')
    expect(html).toContain('<a href="https://files.example.com/q-1042.pdf" download="Quote Q-1042.pdf" class="nds-btn primary sm">')
  })
  it('ready: the page is a named image, the position is a live region, held buttons say why', () => {
    const html = view({ state: { status: 'ready', pageCount: 5, page: 1, zoom: 'fit', pageError: false }, scale: 1.18 })
    expect(html).toContain('<canvas class="nds-pdf-canvas" role="img" aria-label="Quote Q-1042, page 1 of 5">')
    expect(html).toContain('<span class="nds-pdf-pos" aria-live="polite">Page 1 of 5</span>')
    expect(html).toContain('aria-description="This is the first page"')
    expect(html).not.toContain('aria-description="This is the last page"')
    expect(html).toContain('118 %')
    // Engaged, and not `quiet` (a quiet button drops the engaged fill: its white icon vanished on white in the browser).
    expect(html).toMatch(/class="nds-btn sm on" aria-pressed="true" aria-label="Fit to width"/)
    expect(html).toContain('tabindex="0"')
  })
  it('ready with a page that failed to draw: said over the page', () => {
    const html = view({ state: { status: 'ready', pageCount: 2, page: 2, zoom: 1, pageError: true } })
    expect(html).toMatch(/role="alert">This page could not be drawn\./)
  })
  it('an app download (onDownload) is a button, not a link', () => {
    const html = view({ state: { status: 'ready', pageCount: 1, page: 1, zoom: 1, pageError: false }, url: null, download: { fileName: 'x.pdf', onDownload: () => {} } })
    expect(html).not.toContain('download="')
    expect(html).toMatch(/<button type="button" class="nds-btn sm">.*Download<\/button>/)
  })
})

describe('without pdf.js', () => {
  it('where the browser has a PDF view: says the preview is not available here and shows the browser’s own view', () => {
    const html = view({ state: { status: 'fallback' }, inline: true })
    expect(html).toContain(PDF_VIEWER_LABELS.nativeView)
    expect(html).toContain('<object class="nds-pdf-native" data="https://files.example.com/q-1042.pdf" type="application/pdf" aria-label="Quote Q-1042">')
    expect(html).not.toContain('<canvas')
  })
  it('where it has none (Android Chrome): says so and offers the download, no embed', () => {
    const html = view({ state: { status: 'fallback' }, inline: false })
    expect(html).toContain(PDF_VIEWER_LABELS.previewUnavailable)
    expect(html).not.toContain('<object')
    expect(html).toMatch(/href="https:\/\/files\.example\.com\/q-1042\.pdf" download="Quote Q-1042\.pdf"/)
  })
  it('PdfViewer with no loader starts in the fallback (and never in loading); before hydration it waits to know the browser', () => {
    const html = renderToStaticMarkup(createElement(PdfViewer, { src: 'https://files.example.com/q-1042.pdf', title: 'Quote Q-1042' }))
    expect(html).not.toContain('aria-busy')
    expect(html).not.toContain('<canvas')
    expect(html).toContain('Opening the document')
  })
  it('PdfViewer under PdfJsProvider takes its loader (loading, not the fallback) and calls nothing on the server', () => {
    const fake = fakePdfJs()
    const html = renderToStaticMarkup(createElement(PdfJsProvider, { load: fake.load }, createElement(PdfViewer, { src: '/a.pdf', title: 'DoC' })))
    expect(html).toContain('aria-busy="true"')
    expect(fake.load).not.toHaveBeenCalled()
  })
  it('the labels come in as props', () => {
    const html = view({ state: { status: 'fallback' }, inline: false, words: { ...PDF_VIEWER_LABELS, previewUnavailable: 'Anteprima non disponibile.', download: 'Scarica' } })
    expect(html).toContain('Anteprima non disponibile.')
    expect(html).toContain('Scarica')
  })
})
