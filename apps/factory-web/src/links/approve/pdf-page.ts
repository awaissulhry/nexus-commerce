import { openPdf } from '@nexus/ui/components/PdfViewer/index'
import { loadPdfJs } from '../../lib/pdf/load-pdfjs'

/**
 * One page of a PDF drawn as a picture (about 1600 px wide) with the page count, for "Mark the photo" on a document of the
 * request (the marks are an overlay on that page; nothing is burned into the PDF). Browser only (a canvas).
 */
export async function pdfPageImage(bytes: Uint8Array, page: number): Promise<{ src: string; width: number; height: number; pages: number }> {
  const { promise } = openPdf(loadPdfJs, bytes.slice())
  const document = await promise
  try {
    const number = Math.min(Math.max(1, page), document.numPages)
    const pdfPage = await document.getPage(number)
    const base = pdfPage.getViewport({ scale: 1 })
    const viewport = pdfPage.getViewport({ scale: Math.min(3, 1600 / Math.max(1, base.width)) })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no canvas')
    await pdfPage.render({ canvasContext: context, canvas, viewport }).promise
    return { src: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, pages: document.numPages }
  } finally {
    void document.destroy?.()
  }
}

/** A picture's natural size, read in the browser. */
export function pictureSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('unreadable picture'))
    image.src = src
  })
}
