import { loadPdfJs } from '../../../lib/pdf/load-pdfjs'

/**
 * The PDF reader held ready while online (B-W2b-143): the DS PdfViewer loads pdf.js on demand (its chunk, then a worker from
 * its own file for each document), which a tablet cannot fetch once the network is gone. The cabinet reader loads pdf.js while
 * online and starts ONE worker that every later document of this tab uses (pdf.js `GlobalWorkerOptions.workerPort`, kept
 * across documents), so a sheet kept on the tablet opens offline too. Only the floor's tab; a second call does nothing.
 */
let warming: Promise<void> | null = null

export function warmPdfReader(): Promise<void> {
  warming ??= loadPdfJs()
    .then((pdfjs) => {
      const options = (pdfjs as unknown as { GlobalWorkerOptions?: { workerPort: Worker | null; workerSrc: string } }).GlobalWorkerOptions
      if (options && !options.workerPort && typeof Worker !== 'undefined' && options.workerSrc) options.workerPort = new Worker(options.workerSrc, { type: 'module' })
    })
    .catch(() => {
      warming = null
    })
  return warming
}
