'use client'

/**
 * FF-UI — Catalog workbook (v2) export hook.
 *
 * Fires POST /api/export-jobs with format:"workbook" / targetEntity:"catalog",
 * then triggers a browser download on COMPLETED. Surfaces graceful messages for
 * failed jobs and for the case where the artifact isn't available (large export
 * in an environment without object storage configured).
 *
 * Auth pattern mirrors ExportsClient.tsx (lines ~153-190): bare fetch with
 * Content-Type header, no explicit credential overrides — relies on the same
 * cookie/session that all other API calls in the app use.
 */

import { useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

export function useCatalogWorkbookExport() {
  const { toast } = useToast()
  const [exporting, setExporting] = useState(false)

  async function exportCatalogWorkbook() {
    if (exporting) return
    setExporting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/export-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobName: 'Catalog workbook',
          format: 'workbook',
          targetEntity: 'catalog',
          columns: [],
          filters: { channels: ['AMAZON', 'EBAY', 'SHOPIFY'] },
          runImmediately: true,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)

      // The server runs the export inline and returns the terminal status.
      const job: { id?: string; status?: string; error?: string } = j.job ?? j

      if (job?.status === 'FAILED') {
        toast.error(
          'Catalog workbook export failed: ' + (job.error ?? 'unknown error'),
        )
        return
      }

      if (job?.id && job?.status === 'COMPLETED') {
        const downloadUrl = `${getBackendUrl()}/api/export-jobs/${job.id}/download`

        // Probe the download endpoint before firing the browser redirect so we
        // can surface a clear message when the artifact isn't available (large
        // exports in environments without object storage).
        try {
          const headRes = await fetch(downloadUrl, { method: 'HEAD' })
          if (headRes.status === 404 || headRes.status === 503) {
            toast({
              title: 'Workbook exported but not downloadable',
              description:
                'Workbook exported but too large to download from this environment — set STORAGE_PROVIDER=S3/R2, or export a smaller SKU subset.',
              tone: 'warning',
              durationMs: 10000,
            })
            return
          }
          // Check for JSON error body (some adapters return 200 + JSON error)
          const ct = headRes.headers.get('content-type') ?? ''
          if (!headRes.ok && ct.includes('application/json')) {
            toast({
              title: 'Workbook exported but not downloadable',
              description:
                'Workbook exported but too large to download from this environment — set STORAGE_PROVIDER=S3/R2, or export a smaller SKU subset.',
              tone: 'warning',
              durationMs: 10000,
            })
            return
          }
        } catch {
          // HEAD probe failed (CORS, network). Fall through and let the browser
          // attempt the download — this mirrors the ExportsClient fallback.
        }

        toast.success('Catalog workbook downloading…')
        window.location.href = downloadUrl
      } else {
        // Job was created but isn't COMPLETED yet (queued / processing).
        toast({
          title: 'Export queued',
          description: `Job ${job?.id ?? ''} created — check the Exports page for the download link once it completes.`,
          tone: 'info',
          durationMs: 6000,
        })
      }
    } catch (err) {
      toast.error(
        'Catalog workbook export failed: ' +
          (err instanceof Error ? err.message : String(err)),
      )
    } finally {
      setExporting(false)
    }
  }

  return { exportCatalogWorkbook, exporting }
}
