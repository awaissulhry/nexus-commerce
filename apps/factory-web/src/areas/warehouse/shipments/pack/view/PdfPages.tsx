'use client'

import { useEffect, useRef, useState } from 'react'
import { openPdf, PdfOpenCancelled } from '@nexus/ui/components/PdfViewer/index'
import { Spinner } from '@nexus/ui/primitives'
import { loadPdfJs } from '../../../../../lib/pdf/load-pdfjs'

/** The print scale: crisp on A4 paper (pdf.js draws a page at its own size × this). */
const PRINT_SCALE = 2

/**
 * Every page of one PDF drawn one under the other, for paper (the stand-in of a DS part: the DS PdfViewer shows ONE page
 * at a time with its own toolbar, so it cannot print a document whole). pdf.js is this app's, loaded on demand; each page
 * is a canvas the print stylesheet puts on a page of its own. It draws the bytes it is given and fetches nothing.
 */
export function PdfPages({ data, title, loading, failed, pageLabel }: { data: Uint8Array; title: string; loading: string; failed: string; pageLabel: (page: number, pages: number) => string }) {
  const host = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => {
    const target = host.current
    if (!target) return
    setState('loading')
    const opened = openPdf(loadPdfJs, data)
    let live = true
    opened.promise
      .then(async (document) => {
        const canvases: HTMLCanvasElement[] = []
        for (let number = 1; number <= document.numPages; number += 1) {
          const page = await document.getPage(number)
          if (!live) return
          const viewport = page.getViewport({ scale: PRINT_SCALE })
          const canvas = window.document.createElement('canvas')
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          canvas.className = 'fw-sh-pack-page'
          canvas.setAttribute('role', 'img')
          canvas.setAttribute('aria-label', pageLabel(number, document.numPages))
          const context = canvas.getContext('2d')
          if (!context) throw new Error('no 2D context')
          await page.render({ canvasContext: context, canvas, viewport }).promise
          canvases.push(canvas)
        }
        if (!live) return
        target.replaceChildren(...canvases)
        setState('ready')
      })
      .catch((error: unknown) => {
        if (error instanceof PdfOpenCancelled || !live) return
        setState('failed')
      })
    return () => {
      live = false
      opened.cancel()
    }
    // `pageLabel` is words of the same page: the bytes decide what is drawn.
  }, [data])
  return (
    <div className="fw-sh-pack-pdf" aria-label={title}>
      {state === 'loading' && (
        <p className="fw-sh-hint fw-sh-pack-screen" role="status">
          <Spinner size={14} /> {loading}
        </p>
      )}
      {state === 'failed' && <p className="fw-sh-hint">{failed}</p>}
      <div ref={host} className="fw-sh-pack-pages" />
    </div>
  )
}
