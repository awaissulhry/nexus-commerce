'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives/Button'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Modal } from '@/design-system/components/Modal'
import { PdfViewer, type PdfDocumentLike, type PdfJsLike, type PdfJsLoader } from '@/design-system/components/PdfViewer'
import { samplePdf } from './samplePdf'

/*
 * 2026-10-28 — G18, the PDF viewer. This web app does not depend on pdf.js, so the catalog injects a STUB loader that
 * draws a fake A4 page into the viewer's canvas: the toolbar, page steps, zoom, fit width and the states are the real
 * component. "No pdf.js" passes no loader: the viewer says the page preview is not available and shows a real PDF (built
 * by `samplePdf`) in the browser's own viewer where there is one (desktop Chrome), or only the download (Android Chrome).
 * Verify, light and dark, 390 and 1440 px: Tab reaches the steps, zoom and Download, held buttons say why; in the page
 * area PageDown / PageUp / Home / End change the page and + / - / 0 zoom; "Fails to open" says so with Try again.
 */

const A4 = { width: 595, height: 842 }

/** A stand-in for pdf.js: pages of grey lines under a heading, drawn with the canvas API. */
function stubDocument(pageCount: number): PdfDocumentLike {
  return {
    numPages: pageCount,
    getPage: async (n) => ({
      getViewport: ({ scale }) => ({ width: A4.width * scale, height: A4.height * scale }),
      render: ({ canvasContext: ctx, viewport }) => {
        if (!ctx) return { promise: Promise.reject(new Error('No canvas context')) }
        const k = viewport.width / A4.width
        // The canvas cannot read a CSS variable: take the DS sans family's resolved value from the page.
        const sans = getComputedStyle(document.documentElement).getPropertyValue('--nds-font-sans').trim()
        ctx.save()
        ctx.scale(k, k)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, A4.width, A4.height)
        ctx.fillStyle = '#1c2530'
        ctx.font = `600 22px ${sans}`
        ctx.fillText('Stub document', 64, 92)
        ctx.font = `12px ${sans}`
        ctx.fillText(`Drawn by the catalog's stub loader - page ${n} of ${pageCount}`, 64, 120)
        ctx.fillStyle = '#d8dde4'
        for (let row = 0; row < 22; row++) ctx.fillRect(64, 160 + row * 28, row % 4 === 3 ? 300 : 467, 10)
        ctx.restore()
        return { promise: Promise.resolve(), cancel: () => {} }
      },
    }),
  }
}

const stubPdfJs = (pageCount: number): PdfJsLike => ({ getDocument: () => ({ promise: Promise.resolve(stubDocument(pageCount)) }) })

const LOADERS: Record<string, PdfJsLoader | undefined> = {
  stub: async () => stubPdfJs(4),
  opening: () => new Promise<PdfJsLike>(() => {}),
  broken: async () => ({ getDocument: () => ({ promise: Promise.reject(new Error('Invalid PDF structure')) }) }),
  none: undefined,
}

const MODES = [
  { value: 'stub', label: 'Stub pdf.js' },
  { value: 'opening', label: 'Opening' },
  { value: 'broken', label: 'Fails to open' },
  { value: 'none', label: 'No pdf.js' },
]

export function PdfViewerExample() {
  const [mode, setMode] = useState('stub')
  const [dialog, setDialog] = useState(false)
  const bytes = useMemo(() => samplePdf('Declaration of conformity - sample'), [])
  return (
    <section id="pdf-viewer-example">
      <h3>PdfViewer · a document inside a dialog or a link page</h3>
      <p>
        Pages one at a time, zoom, fit to width, the page count and the download. pdf.js is injected by the app
        (<code>loadPdfJs</code> or <code>PdfJsProvider</code>) and loaded when the first viewer opens; the design system never
        imports it. Without it the viewer falls back to the browser&apos;s own view, or the download.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <SegmentedControl ariaLabel="Viewer state" size="sm" wrap options={MODES} value={mode} onChange={setMode} />
        <Button size="sm" onClick={() => setDialog(true)}>
          Open in a dialog
        </Button>
      </div>
      <PdfViewer key={mode} src={bytes} title="Declaration of conformity - sample" loadPdfJs={LOADERS[mode]} height={520} />
      <Modal open={dialog} onClose={() => setDialog(false)} title="Declaration of conformity - sample" size="xl">
        <PdfViewer src={bytes} title="Declaration of conformity - sample" loadPdfJs={LOADERS.stub} height="60vh" />
      </Modal>
    </section>
  )
}
