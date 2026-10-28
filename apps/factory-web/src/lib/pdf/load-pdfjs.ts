import type { PdfJsLike, PdfJsLoader } from '@nexus/ui/components/PdfViewer/index'

/**
 * pdf.js for the design system's PdfViewer (G18), loaded on demand: the first PDF a person opens fetches it (its own
 * chunk), never a page's first load. The worker is pdf.js's own file, bundled as an asset beside it. The DS never
 * imports `pdfjs-dist`; this app injects it (`PdfProvider`, or a viewer's `loadPdfJs`).
 */

let loading: Promise<PdfJsLike> | null = null

export const loadPdfJs: PdfJsLoader = () => {
  loading ??= import('pdfjs-dist')
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
      return pdfjs as unknown as PdfJsLike
    })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}
