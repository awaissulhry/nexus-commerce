'use client'

import type { ReactNode } from 'react'
import { PdfJsProvider } from '@nexus/ui/components/PdfViewer/index'
import { loadPdfJs } from './load-pdfjs'

/** Every PdfViewer under it opens PDFs with this app's lazily loaded pdf.js. */
export function PdfProvider({ children }: { children?: ReactNode }) {
  return <PdfJsProvider load={loadPdfJs}>{children}</PdfJsProvider>
}
