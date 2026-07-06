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

  async function exportCatalogWorkbook(opts?: { skuIn?: string[]; channels?: string[] }) {
    if (exporting) return
    setExporting(true)
    try {
      const skuIn   = (opts?.skuIn   ?? []).filter(Boolean)
      const channels = opts?.channels ?? ['AMAZON', 'EBAY', 'SHOPIFY']
      const jobName  = skuIn.length
        ? `Workbook (${skuIn.length} SKU${skuIn.length === 1 ? '' : 's'})`
        : 'Catalog workbook'
      const res = await fetch(`${getBackendUrl()}/api/export-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobName,
          format: 'workbook',
          targetEntity: 'catalog',
          columns: [],
          filters: { channels, ...(skuIn.length ? { skuIn } : {}) },
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

        // Download via a CREDENTIALED fetch. The install-fetch shim adds
        // credentials:'include' to API-origin fetches, so the partitioned
        // session cookie rides. A raw `window.location` navigation would hit the
        // cross-site API anonymously (the cookie doesn't cross the partition on a
        // top-level navigation) → 401, and the browser would just display the JSON
        // error. So fetch the bytes and save the blob client-side instead.
        const dlRes = await fetch(downloadUrl)
        const dlCt = dlRes.headers.get('content-type') ?? ''
        if (!dlRes.ok || dlCt.includes('application/json')) {
          // Artifact not available — typically a >1 MB export in an environment
          // without object storage (LOCAL/ephemeral). Surface it, don't crash.
          toast({
            title: 'Workbook exported but not downloadable',
            description:
              'Workbook exported but too large to download from this environment — set STORAGE_PROVIDER=S3/R2, or export a smaller SKU subset.',
            tone: 'warning',
            durationMs: 10000,
          })
          return
        }
        const blob = await dlRes.blob()
        const objectUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = `catalog-workbook-${job.id}.xlsx`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(objectUrl)
        toast.success('Catalog workbook downloaded')
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
