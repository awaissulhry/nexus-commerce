/**
 * The PDF viewer's logic, kept out of React so it is tested in Node: the part of pdf.js the viewer calls (typed here —
 * `@nexus/ui` never imports `pdfjs-dist`), the viewer's state and its steps, zoom and fit-width, and how a source and a
 * download are handed over.
 *
 * pdf.js reaches the viewer through an INJECTED loader (`PdfJsLoader`, a prop or `PdfJsProvider`): the app that shows
 * PDFs depends on `pdfjs-dist` itself and passes `() => import('pdfjs-dist').then(...)`, setting the worker there. An app
 * that passes none — the Commerce web — never bundles pdf.js, and the viewer falls back to the browser's own PDF view.
 */

// ── the slice of pdf.js the viewer uses (structurally compatible with pdfjs-dist 5) ────────────────────────────────

export interface PdfViewportLike {
  width: number
  height: number
}

export interface PdfRenderTaskLike {
  promise: Promise<unknown>
  cancel?: () => void
}

/**
 * What the viewer passes to `render`: the canvas, its 2D context and the viewport `getViewport` returned. Typed as loosely
 * as pdf.js 5's own `RenderParameters` (`canvasContext` optional, `canvas` nullable), so the real `PDFPageProxy` fits.
 */
export interface PdfRenderParams {
  canvasContext?: CanvasRenderingContext2D
  canvas: HTMLCanvasElement | null
  viewport: PdfViewportLike
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike
  render(params: PdfRenderParams): PdfRenderTaskLike
  cleanup?: () => unknown
}

export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy?: () => unknown
}

export interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>
  destroy?: () => unknown
}

/** What a pdf.js module offers the viewer: `getDocument`. The loader sets `GlobalWorkerOptions.workerSrc` before it resolves. */
export interface PdfJsLike {
  getDocument(source: PdfSource): PdfLoadingTaskLike
}

/** Loads pdf.js on demand — `() => import('pdfjs-dist').then((m) => { m.GlobalWorkerOptions.workerSrc = …; return m })`. */
export type PdfJsLoader = () => Promise<PdfJsLike>

// ── sources ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A PDF by address, or its bytes. */
export type PdfInput = string | Uint8Array | ArrayBuffer

export type PdfSource = { url: string } | { data: Uint8Array }

/**
 * What `getDocument` gets. Bytes are COPIED: pdf.js hands its buffer to the worker, which detaches it, so the caller's
 * array would be empty afterwards (and a second open of the same bytes would fail).
 */
export function pdfSource(input: PdfInput): PdfSource {
  if (typeof input === 'string') return { url: input }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  return { data: bytes.slice() }
}

/** The bytes of an input as a Blob, for a download or the browser's own view (a string has none: it is fetched). */
export function pdfBlob(input: PdfInput): Blob | null {
  if (typeof input === 'string') return null
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  return new Blob([bytes.slice()], { type: 'application/pdf' })
}

/** The download's file name: the given one, else the title made safe, ending in `.pdf`. */
export function pdfFileName(title: string, fileName?: string): string {
  const base = (fileName ?? title).trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ') || 'document'
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

/**
 * Can this browser show a PDF inline (`<object type="application/pdf">`)? `navigator.pdfViewerEnabled` is the standard
 * answer: false on Android Chrome and wherever the built-in viewer is off. Unknown (an old browser) counts as no.
 */
export function canShowPdfInline(nav: { pdfViewerEnabled?: boolean } | undefined): boolean {
  return nav?.pdfViewerEnabled === true
}

/**
 * Open a document with an injected pdf.js: load the module, hand it the source (bytes copied), resolve the document.
 * `cancel()` stops a pending open and destroys what it opened; a document that arrives after a cancel is destroyed too.
 */
export function openPdf(load: PdfJsLoader, input: PdfInput): { promise: Promise<PdfDocumentLike>; cancel: () => void } {
  let cancelled = false
  let task: PdfLoadingTaskLike | null = null
  let opened: PdfDocumentLike | null = null
  const promise = load().then((pdfjs) => {
    if (cancelled) throw new PdfOpenCancelled()
    task = pdfjs.getDocument(pdfSource(input))
    return task.promise.then((document) => {
      if (cancelled) {
        void document.destroy?.()
        throw new PdfOpenCancelled()
      }
      opened = document
      return document
    })
  })
  return {
    promise,
    cancel: () => {
      cancelled = true
      void task?.destroy?.()
      void opened?.destroy?.()
    },
  }
}

/** The open was cancelled (the source changed, the viewer closed): not a failure to show. */
export class PdfOpenCancelled extends Error {
  constructor() {
    super('The PDF open was cancelled')
    this.name = 'PdfOpenCancelled'
  }
}

// ── zoom ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The zoom steps, as scales of the page's own size (1 = 100 %). */
export const PDF_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const
export const PDF_ZOOM_MIN = PDF_ZOOM_STEPS[0]
export const PDF_ZOOM_MAX = PDF_ZOOM_STEPS[PDF_ZOOM_STEPS.length - 1]

/** The scale that makes the page as wide as the stage's content box (less `gutter` each side), held to the zoom range. */
export function fitWidthScale(stageWidth: number, pageWidth: number, gutter = 0): number {
  if (!(stageWidth > 0) || !(pageWidth > 0)) return 1
  const scale = (stageWidth - 2 * gutter) / pageWidth
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, Math.round(scale * 1000) / 1000))
}

/** The next step above (`+1`) or below (`-1`) a scale — from fit-width's scale too, which sits between steps. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const eps = 1e-6
  if (direction > 0) return PDF_ZOOM_STEPS.find((s) => s > scale + eps) ?? PDF_ZOOM_MAX
  return [...PDF_ZOOM_STEPS].reverse().find((s) => s < scale - eps) ?? PDF_ZOOM_MIN
}

/** `125 %`. */
export const zoomPercent = (scale: number): string => `${Math.round(scale * 100)} %`

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PdfZoom = number | 'fit'

export type PdfViewerState =
  /** No pdf.js: the browser's own view (where it has one) and the download. */
  | { status: 'fallback' }
  | { status: 'loading' }
  /** The document could not be opened. */
  | { status: 'error' }
  | { status: 'ready'; pageCount: number; page: number; zoom: PdfZoom; pageError: boolean }

export type PdfViewerAction =
  | { type: 'fallback' }
  | { type: 'load' }
  | { type: 'loaded'; pageCount: number }
  | { type: 'failed' }
  | { type: 'page'; page: number }
  | { type: 'next' }
  | { type: 'prev' }
  /** `fitScale`: the scale fit-width has now, the base a step from fit-width starts at. */
  | { type: 'zoom'; direction: 1 | -1; fitScale: number }
  | { type: 'fit' }
  | { type: 'pageError'; failed: boolean }

const clampPage = (page: number, count: number): number => Math.min(count, Math.max(1, Math.round(page)))

export function pdfViewerReducer(state: PdfViewerState, action: PdfViewerAction): PdfViewerState {
  switch (action.type) {
    case 'fallback':
      return { status: 'fallback' }
    case 'load':
      return { status: 'loading' }
    case 'loaded':
      return action.pageCount > 0 ? { status: 'ready', pageCount: action.pageCount, page: 1, zoom: 'fit', pageError: false } : { status: 'error' }
    case 'failed':
      return { status: 'error' }
  }
  if (state.status !== 'ready') return state
  switch (action.type) {
    case 'page':
      return { ...state, page: clampPage(action.page, state.pageCount), pageError: false }
    case 'next':
      return { ...state, page: clampPage(state.page + 1, state.pageCount), pageError: false }
    case 'prev':
      return { ...state, page: clampPage(state.page - 1, state.pageCount), pageError: false }
    case 'zoom': {
      const from = state.zoom === 'fit' ? action.fitScale : state.zoom
      return { ...state, zoom: stepZoom(from, action.direction) }
    }
    case 'fit':
      return { ...state, zoom: 'fit' }
    case 'pageError':
      return state.pageError === action.failed ? state : { ...state, pageError: action.failed }
  }
  return state
}

/** The scale a ready state draws at. */
export const effectiveScale = (zoom: PdfZoom, fitScale: number): number => (zoom === 'fit' ? fitScale : zoom)

/**
 * Draw one page into a canvas, sharp on a high-density screen: the canvas holds `scale × devicePixelRatio` pixels and is
 * shown at `scale` CSS pixels. Returns the task (cancel it when the page or the zoom changes) and the CSS size.
 */
export function renderPdfPage(page: PdfPageLike, canvas: HTMLCanvasElement, scale: number, pixelRatio = 1): { task: PdfRenderTaskLike; width: number; height: number } {
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  const css = page.getViewport({ scale })
  const viewport = page.getViewport({ scale: scale * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(css.width)}px`
  canvas.style.height = `${Math.floor(css.height)}px`
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) throw new Error('No 2D canvas context')
  return { task: page.render({ canvasContext, canvas, viewport }), width: css.width, height: css.height }
}

/** pdf.js rejects a cancelled render with a `RenderingCancelledException`: that is not a failure. */
export const isRenderCancel = (error: unknown): boolean =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'RenderingCancelledException'
