'use client'

import { useCallback, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/design-system/components'
import { ImportDrawer } from './ImportDrawer'
import { verifyImportDiff, type ImportDiff, type ImportJob } from './contract'
import type { ImportTransport } from './transport'

export interface VariantTransferScope {
  productId: string; market: string; locale?: string; channel?: string; accountId?: string | null; aliasKey?: string | null
}

/** Variants use the existing upload → stored diff → apply/revert drawer with their own template. */
export function useVariantTransfer(scope: VariantTransferScope, onApplied: () => void) {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const scopeKey = JSON.stringify(scope)
  const params = useMemo(() => new URLSearchParams(Object.entries(JSON.parse(scopeKey) as Record<string, string>).filter(([, value]) => !!value)), [scopeKey])
  const base = `${getBackendUrl()}/api/products/${encodeURIComponent(scope.productId)}/studio/variants/import`
  const read = async (response: Response) => {
    const body = await response.json()
    if (!response.ok) throw new Error(body.message ?? body.error ?? 'The variant transfer could not be completed.')
    return body
  }
  const transport = useMemo<ImportTransport>(() => ({
    darkNote: null,
    async diff({ file, blankCells, signal }) {
      const form = new FormData()
      form.append('file', file); form.append('blankCells', blankCells)
      params.forEach((value, key) => form.append(key, value))
      const body = await read(await fetch(`${base}/diff`, { method: 'POST', body: form, credentials: 'include', signal }))
      const problems = verifyImportDiff(body)
      if (problems.length) throw new Error(problems.join('; '))
      return body as ImportDiff
    },
    async apply({ jobId, signal }) { return read(await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/apply`, { method: 'POST', credentials: 'include', signal })) as Promise<ImportJob> },
    async poll({ jobId, signal }) { return read(await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { credentials: 'include', signal })) as Promise<ImportJob> },
    async revert({ jobId, signal }) { return read(await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/revert`, { method: 'POST', credentials: 'include', signal })) as Promise<ImportJob> },
  }), [base, params])
  const download = useCallback(async () => {
    try {
      const response = await fetch(`${base}/template?${params}`, { credentials: 'include' })
      if (!response.ok) { await read(response); return }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'variants.csv'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { toast.toast(err instanceof Error ? err.message : String(err), 'danger') }
  }, [base, params, toast])
  const drawerScope = useMemo(() => ({ kind: scope.channel ? 'channel' as const : 'master' as const,
    channel: scope.channel ?? null, marketplace: scope.market, label: scope.channel ? `${scope.channel} · ${scope.market}` : 'Shared product' }), [scope.channel, scope.market])
  return { open: () => setOpen(true), download, element: open && <ImportDrawer open productId={scope.productId} scope={drawerScope}
    transport={transport} onClose={() => setOpen(false)} onApplied={onApplied} onDownloadTemplate={() => void download()}
    templateHint="A variants CSV with axis values and inclusion per account and market. Export downloads the template. Row 1 contains labels; row 2 contains keys." /> }
}
