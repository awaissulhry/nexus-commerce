'use client'

/**
 * PdfViewer — a PDF's pages inside a dialog or a link page: page by page, zoom, fit to width, the page count and a
 * download, the same on a desktop and on Android Chrome (which has no inline PDF view of its own).
 *
 * pdf.js is INJECTED, never imported here: pass `loadPdfJs` (or wrap the app in `PdfJsProvider`) with a loader the app
 * owns, e.g. `() => import('pdfjs-dist').then((m) => { m.GlobalWorkerOptions.workerSrc = workerUrl; return m })`. The
 * loader runs when the first viewer opens, so the module and its worker are fetched only then, and only by an app that
 * depends on `pdfjs-dist`. Its shape is `PdfJsLike` (`pdfViewerModel.ts`), a slice of pdf.js 5's API.
 *
 * Without a loader the viewer does not pretend: it says the page preview is not available and shows the browser's own
 * PDF view where the browser has one (`navigator.pdfViewerEnabled`), else just the download.
 *
 * States: opening (a spinner that says so), the page (a canvas drawn at the screen's pixel density, named
 * "<title>, page 2 of 5"), a page that failed to draw (said over the page), a document that failed to open (said, with
 * Try again and Download). The page number is a polite live region. The toolbar's held buttons say why (first page,
 * smallest size) instead of going silent.
 *
 * Keyboard: the page area takes the focus (it scrolls when zoomed); PageUp / PageDown and Home / End change the page,
 * + and - zoom, 0 fits the width. Words come in through `labels` (English by default).
 */
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Download, MoveHorizontal, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { useHydrated } from '../useHydrated'
import {
  canShowPdfInline,
  effectiveScale,
  fitWidthScale,
  isRenderCancel,
  openPdf,
  pdfBlob,
  pdfFileName,
  PdfOpenCancelled,
  pdfViewerReducer,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  renderPdfPage,
  zoomPercent,
  type PdfDocumentLike,
  type PdfInput,
  type PdfJsLoader,
  type PdfRenderTaskLike,
  type PdfViewerState,
} from './pdfViewerModel'
import './pdf-viewer.css'

export interface PdfViewerLabels {
  loading: string
  error: string
  retry: string
  download: string
  previousPage: string
  nextPage: string
  firstPageHeld: string
  lastPageHeld: string
  zoomIn: string
  zoomOut: string
  zoomInHeld: string
  zoomOutHeld: string
  fitWidth: string
  /** `Page 2 of 5`. */
  page: (page: number, count: number) => string
  /** The canvas's name: `Quote Q-1042, page 2 of 5`. */
  pageImage: (title: string, page: number, count: number) => string
  pageError: string
  /** No pdf.js, and the browser has no PDF view of its own (Android Chrome). */
  previewUnavailable: string
  /** No pdf.js, so the browser's own PDF view shows the file. */
  nativeView: string
}

export const PDF_VIEWER_LABELS: PdfViewerLabels = {
  loading: 'Opening the document',
  error: 'This document could not be opened.',
  retry: 'Try again',
  download: 'Download',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  firstPageHeld: 'This is the first page',
  lastPageHeld: 'This is the last page',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomInHeld: 'This is the largest size',
  zoomOutHeld: 'This is the smallest size',
  fitWidth: 'Fit to width',
  page: (page, count) => `Page ${page} of ${count}`,
  pageImage: (title, page, count) => `${title}, page ${page} of ${count}`,
  pageError: 'This page could not be drawn.',
  previewUnavailable: 'The page preview is not available on this device. Download the document to read it.',
  nativeView: 'The page preview is not available here, so your browser shows the document with its own viewer.',
}

const PdfJsContext = createContext<PdfJsLoader | null>(null)

/** Gives every `PdfViewer` under it the app's pdf.js loader (a viewer's own `loadPdfJs` wins). */
export function PdfJsProvider({ load, children }: { load: PdfJsLoader; children?: ReactNode }) {
  return <PdfJsContext.Provider value={load}>{children}</PdfJsContext.Provider>
}

export interface PdfViewerProps {
  /** The PDF: its address, or its bytes. Keep it stable between renders (a new array opens the document again). */
  src: PdfInput
  /** The document's name: the region's name, the toolbar's heading and the download's default file name. */
  title: string
  /** Download through the app (a logged download, a signed address). Absent: the browser downloads `src`. */
  onDownload?: () => void
  /** The download's file name (default: the title, ending in `.pdf`). */
  fileName?: string
  /** Loads pdf.js. Absent: the one from `PdfJsProvider`; neither: the browser's own view, or the download. */
  loadPdfJs?: PdfJsLoader
  labels?: Partial<PdfViewerLabels>
  /** The page area's height (a CSS length or px). Default `min(70vh, 760px)`. */
  height?: number | string
  className?: string
}

/** The view of a state: everything that is drawn, with no effects — the viewer passes its live state in. */
export interface PdfViewerViewProps {
  state: PdfViewerState
  title: string
  words: PdfViewerLabels
  /** The scale the page is drawn at (ready). */
  scale: number
  /** The browser's own PDF view can be used (fallback). Undefined until known (before hydration). */
  inline?: boolean
  /** The address for `<object>` and for the download link; null when the app downloads (`onDownload`) or none is known yet. */
  url: string | null
  download: { onDownload?: () => void; fileName: string }
  canvasRef?: { current: HTMLCanvasElement | null }
  stageRef?: { current: HTMLDivElement | null }
  height?: number | string
  className?: string
  onRetry?: () => void
  onPrev?: () => void
  onNext?: () => void
  onZoom?: (direction: 1 | -1) => void
  onFit?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
}

function DownloadButton({ url, download, words, variant = 'secondary' }: Pick<PdfViewerViewProps, 'url' | 'download' | 'words'> & { variant?: 'secondary' | 'primary' }) {
  const content = (
    <>
      <Download size={15} aria-hidden="true" />
      {words.download}
    </>
  )
  if (download.onDownload) {
    return (
      <Button size="sm" variant={variant} onClick={download.onDownload}>
        {content}
      </Button>
    )
  }
  if (!url) return null
  return (
    <Button size="sm" variant={variant} asChild>
      <a href={url} download={download.fileName}>
        {content}
      </a>
    </Button>
  )
}

export function PdfViewerView(props: PdfViewerViewProps) {
  const { state, title, words, scale, inline, url, download, canvasRef, stageRef, height, className } = props
  const ready = state.status === 'ready' ? state : null
  return (
    <section className={['nds-pdf', className ?? ''].filter(Boolean).join(' ')} aria-label={title} onKeyDown={props.onKeyDown}>
      <div className="nds-pdf-bar">
        <span className="nds-pdf-title">{title}</span>
        {ready && (
          <>
            <div className="nds-pdf-group">
              <Button size="sm" variant="quiet" aria-label={words.previousPage} heldReason={ready.page <= 1 ? words.firstPageHeld : null} onClick={props.onPrev}>
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
              <span className="nds-pdf-pos" aria-live="polite">
                {words.page(ready.page, ready.pageCount)}
              </span>
              <Button size="sm" variant="quiet" aria-label={words.nextPage} heldReason={ready.page >= ready.pageCount ? words.lastPageHeld : null} onClick={props.onNext}>
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </div>
            <div className="nds-pdf-group">
              <Button size="sm" variant="quiet" aria-label={words.zoomOut} heldReason={scale <= PDF_ZOOM_MIN ? words.zoomOutHeld : null} onClick={() => props.onZoom?.(-1)}>
                <ZoomOut size={16} aria-hidden="true" />
              </Button>
              <span className="nds-pdf-zoom">{zoomPercent(scale)}</span>
              <Button size="sm" variant="quiet" aria-label={words.zoomIn} heldReason={scale >= PDF_ZOOM_MAX ? words.zoomInHeld : null} onClick={() => props.onZoom?.(1)}>
                <ZoomIn size={16} aria-hidden="true" />
              </Button>
              {/* Not `quiet`: a quiet button drops the engaged fill and its white icon would vanish on white. */}
              <Button size="sm" active={ready.zoom === 'fit'} aria-pressed={ready.zoom === 'fit'} aria-label={words.fitWidth} onClick={props.onFit}>
                <MoveHorizontal size={16} aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
        <span className="nds-pdf-end">
          <DownloadButton url={url} download={download} words={words} />
        </span>
      </div>
      <div
        ref={stageRef}
        className={['nds-pdf-stage', state.status === 'fallback' && inline ? 'native' : ''].filter(Boolean).join(' ')}
        style={height !== undefined ? { height } : undefined}
        tabIndex={ready ? 0 : undefined}
        aria-busy={state.status === 'loading' || undefined}
      >
        {state.status === 'loading' && (
          <div className="nds-pdf-msg" role="status">
            <Spinner size={22} />
            <span>{words.loading}</span>
          </div>
        )}
        {state.status === 'error' && (
          <div className="nds-pdf-msg" role="alert">
            <span>{words.error}</span>
            <span className="nds-pdf-actions">
              {props.onRetry && (
                <Button size="sm" onClick={props.onRetry}>
                  <RotateCcw size={15} aria-hidden="true" />
                  {words.retry}
                </Button>
              )}
              <DownloadButton url={url} download={download} words={words} variant="primary" />
            </span>
          </div>
        )}
        {ready && (
          <>
            <canvas ref={canvasRef} className="nds-pdf-canvas" role="img" aria-label={words.pageImage(title, ready.page, ready.pageCount)} />
            {ready.pageError && (
              <div className="nds-pdf-msg over" role="alert">
                {words.pageError}
              </div>
            )}
          </>
        )}
        {state.status === 'fallback' &&
          (inline === undefined ? (
            <div className="nds-pdf-msg" role="status">
              <Spinner size={22} />
              <span>{words.loading}</span>
            </div>
          ) : inline && url ? (
            <>
              <p className="nds-pdf-note">{words.nativeView}</p>
              <object className="nds-pdf-native" data={url} type="application/pdf" aria-label={title}>
                <div className="nds-pdf-msg">
                  <span>{words.previewUnavailable}</span>
                  <DownloadButton url={url} download={download} words={words} variant="primary" />
                </div>
              </object>
            </>
          ) : (
            <div className="nds-pdf-msg">
              <span>{words.previewUnavailable}</span>
              <DownloadButton url={url} download={download} words={words} variant="primary" />
            </div>
          ))}
      </div>
    </section>
  )
}

/** The address of `src` for the browser: the string itself, or an object URL for bytes (revoked when it changes). */
function useSourceUrl(src: PdfInput, wanted: boolean): string | null {
  const hydrated = useHydrated()
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!wanted || typeof src === 'string') return
    const blob = pdfBlob(src)
    if (!blob) return
    const url = URL.createObjectURL(blob)
    setBlobUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setBlobUrl(null)
    }
  }, [src, wanted])
  if (typeof src === 'string') return src
  return hydrated ? blobUrl : null
}

export function PdfViewer({ src, title, onDownload, fileName, loadPdfJs, labels, height, className }: PdfViewerProps) {
  const words = useMemo(() => ({ ...PDF_VIEWER_LABELS, ...labels }), [labels])
  const contextLoader = useContext(PdfJsContext)
  const loader = loadPdfJs ?? contextLoader
  // The loader is read through a ref: an inline arrow passed on every render must not reopen the document.
  const loaderRef = useRef(loader)
  useEffect(() => {
    loaderRef.current = loader
  }, [loader])
  const hasLoader = !!loader
  const hydrated = useHydrated()

  const [state, dispatch] = useReducer(pdfViewerReducer, hasLoader ? ({ status: 'loading' } as const) : ({ status: 'fallback' } as const))
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<PdfDocumentLike | null>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const [pageWidth, setPageWidth] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Open the document.
  useEffect(() => {
    const load = loaderRef.current
    if (!load) {
      dispatch({ type: 'fallback' })
      return
    }
    dispatch({ type: 'load' })
    setDoc(null)
    const open = openPdf(load, src)
    open.promise.then(
      (document) => {
        setDoc(document)
        dispatch({ type: 'loaded', pageCount: document.numPages })
      },
      (error: unknown) => {
        if (!(error instanceof PdfOpenCancelled)) dispatch({ type: 'failed' })
      },
    )
    return open.cancel
  }, [hasLoader, src, attempt])

  // The stage's content width, for fit-to-width.
  const ready = state.status === 'ready'
  useEffect(() => {
    const stage = stageRef.current
    if (!ready || !stage || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => setStageWidth(Math.floor(entries[0].contentRect.width)))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [ready])

  const fitScale = fitWidthScale(stageWidth, pageWidth)
  const scale = state.status === 'ready' ? effectiveScale(state.zoom, fitScale) : 1
  const page = state.status === 'ready' ? state.page : 0
  const zoom = state.status === 'ready' ? state.zoom : 'fit'

  // Draw the page.
  useEffect(() => {
    if (!doc || page < 1) return
    let live = true
    let task: PdfRenderTaskLike | null = null
    doc
      .getPage(page)
      .then((pdfPage) => {
        const canvas = canvasRef.current
        if (!live || !canvas) return
        const width = pdfPage.getViewport({ scale: 1 }).width
        setPageWidth(width)
        const drawn = renderPdfPage(pdfPage, canvas, zoom === 'fit' ? fitWidthScale(stageWidth, width) : zoom, window.devicePixelRatio || 1)
        task = drawn.task
        return drawn.task.promise
      })
      .then(() => {
        if (live) dispatch({ type: 'pageError', failed: false })
      })
      .catch((error: unknown) => {
        if (live && !isRenderCancel(error)) dispatch({ type: 'pageError', failed: true })
      })
    return () => {
      live = false
      task?.cancel?.()
    }
  }, [doc, page, zoom, zoom === 'fit' ? stageWidth : 0])

  const wantsUrl = !onDownload || state.status === 'fallback' || state.status === 'error'
  const url = useSourceUrl(src, wantsUrl)
  const inline = state.status === 'fallback' ? (hydrated ? canShowPdfInline(navigator as { pdfViewerEnabled?: boolean }) : undefined) : undefined

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (state.status !== 'ready' || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, select, textarea')) return
    const act: Record<string, () => void> = {
      PageDown: () => dispatch({ type: 'next' }),
      PageUp: () => dispatch({ type: 'prev' }),
      Home: () => dispatch({ type: 'page', page: 1 }),
      End: () => dispatch({ type: 'page', page: state.pageCount }),
      '+': () => dispatch({ type: 'zoom', direction: 1, fitScale }),
      '=': () => dispatch({ type: 'zoom', direction: 1, fitScale }),
      '-': () => dispatch({ type: 'zoom', direction: -1, fitScale }),
      '0': () => dispatch({ type: 'fit' }),
    }
    const run = act[event.key]
    if (!run) return
    event.preventDefault()
    run()
  }

  return (
    <PdfViewerView
      state={state}
      title={title}
      words={words}
      scale={scale}
      inline={inline}
      url={onDownload && state.status === 'ready' ? null : url}
      download={{ onDownload, fileName: pdfFileName(title, fileName) }}
      canvasRef={canvasRef}
      stageRef={stageRef}
      height={height}
      className={className}
      onRetry={hasLoader ? () => setAttempt((n) => n + 1) : undefined}
      onPrev={() => dispatch({ type: 'prev' })}
      onNext={() => dispatch({ type: 'next' })}
      onZoom={(direction) => dispatch({ type: 'zoom', direction, fitScale })}
      onFit={() => dispatch({ type: 'fit' })}
      onKeyDown={onKeyDown}
    />
  )
}
