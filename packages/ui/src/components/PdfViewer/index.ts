/**
 * The PDF viewer — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel into
 * every page's first load). Import this folder (`@/design-system/components/PdfViewer` in the web,
 * `@nexus/ui/components/PdfViewer/index` by package path). pdf.js is injected (`loadPdfJs` / `PdfJsProvider`); this
 * package never imports `pdfjs-dist`.
 */
export { PdfViewer, PdfViewerView, PdfJsProvider, PDF_VIEWER_LABELS, type PdfViewerProps, type PdfViewerViewProps, type PdfViewerLabels } from './PdfViewer'
export {
  canShowPdfInline,
  fitWidthScale,
  openPdf,
  pdfFileName,
  PdfOpenCancelled,
  PDF_ZOOM_STEPS,
  type PdfDocumentLike,
  type PdfInput,
  type PdfJsLike,
  type PdfJsLoader,
  type PdfLoadingTaskLike,
  type PdfPageLike,
  type PdfRenderParams,
  type PdfRenderTaskLike,
  type PdfSource,
  type PdfViewerState,
  type PdfViewportLike,
} from './pdfViewerModel'
