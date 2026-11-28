import { openPdf } from '@nexus/ui/components/PdfViewer/index'
import { loadPdfJs } from '../../../../../lib/pdf/load-pdfjs'
import { pictureSize } from '../../../../../lib/pdf/pdf-page'
import { pageMmOfImage, PT_TO_MM, type PageMm } from './place/model'

/**
 * owb-ss4b — a design page drawn as a picture WITH its size in millimetres, so "Place the scan code" and the print sheet put the code at
 * the same place: a PDF page's own size (its points, 1 pt = 25.4 / 72 mm), an image file's by its shape (its longer side an A4's 297 mm:
 * an image has no size of its own). Browser only (a canvas). The size is what the place window sends as the page's sides.
 */
export interface DrawnPage extends PageMm {
  readonly src: string
  /** How many pages the file has (an image: 1). */
  readonly pages: number
}

/** A PDF page drawn about `width` px wide, its size in mm and the file's page count. */
export async function pdfPageDrawn(bytes: Uint8Array, page: number, width = 1600): Promise<DrawnPage> {
  const { promise } = openPdf(loadPdfJs, bytes.slice())
  const document = await promise
  try {
    const number = Math.min(Math.max(1, page), document.numPages)
    const pdfPage = await document.getPage(number)
    const base = pdfPage.getViewport({ scale: 1 })
    const viewport = pdfPage.getViewport({ scale: Math.min(3, width / Math.max(1, base.width)) })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no canvas')
    await pdfPage.render({ canvasContext: context, canvas, viewport }).promise
    return { src: canvas.toDataURL('image/png'), widthMm: base.width * PT_TO_MM, heightMm: base.height * PT_TO_MM, pages: document.numPages }
  } finally {
    void document.destroy?.()
  }
}

/** An image file as it is, its size in mm by its shape. */
export async function imageDrawn(src: string): Promise<DrawnPage> {
  const size = await pictureSize(src)
  return { src, ...pageMmOfImage(size.width, size.height), pages: 1 }
}
