import type { PdfViewerLabels } from '@nexus/ui/components/PdfViewer/index'
import type { Translate } from '../i18n/messages'

/** The PDF viewer's words in the page's language (`shell` catalogue, `pdf.*`). */
export function pdfViewerLabels(t: Translate): PdfViewerLabels {
  return {
    loading: t('pdf.loading'),
    error: t('pdf.error'),
    retry: t('pdf.retry'),
    download: t('pdf.download'),
    previousPage: t('pdf.previousPage'),
    nextPage: t('pdf.nextPage'),
    firstPageHeld: t('pdf.firstPageHeld'),
    lastPageHeld: t('pdf.lastPageHeld'),
    zoomIn: t('pdf.zoomIn'),
    zoomOut: t('pdf.zoomOut'),
    zoomInHeld: t('pdf.zoomInHeld'),
    zoomOutHeld: t('pdf.zoomOutHeld'),
    fitWidth: t('pdf.fitWidth'),
    page: (page, count) => t('pdf.page', { page, count }),
    pageImage: (title, page, count) => t('pdf.pageImage', { title, page, count }),
    pageError: t('pdf.pageError'),
    previewUnavailable: t('pdf.previewUnavailable'),
    nativeView: t('pdf.nativeView'),
  }
}
