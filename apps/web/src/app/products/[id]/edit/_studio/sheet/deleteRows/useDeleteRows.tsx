'use client'

/**
 * Delete rows (Owner, 2026-10-06) — the one "Delete…" verb for every view of the sheet, with what follows it: the sheet
 * reads again and a message offers Undo; when this page's own product went (the whole family, or the variation the page
 * is open on), Products opens (restore it from the Recycle bin).
 */
import { useMemo, useRef } from 'react'

import { useToast } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import type { GridAction } from '@/design-system/grid/actions/registry'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useRouter } from '@/lib/workspaces/navigation'

import { deleteRowsAction, PERM_DELETE_ROWS, type DeleteRowsTarget } from './deleteRows'

export interface UseDeleteRowsOptions<R> {
  productId: string
  target: (row: R) => DeleteRowsTarget
  /** Re-read the sheet (and the family) after a delete or its Undo. */
  onChanged: () => void
  /** The host's verb press already re-reads after a verb ran (`useActionPress(onDone)`): only the Undo calls `onChanged`. */
  hostReloads?: boolean
}

export function useDeleteRows<R>({ productId, target, onChanged, hostReloads = false }: UseDeleteRowsOptions<R>): GridAction<R> {
  const { has, status } = useAuth()
  const { toast } = useToast()
  const router = useRouter()
  const canDelete = has(PERM_DELETE_ROWS)
  const live = useRef({ target, onChanged })
  live.current = { target, onChanged }
  return useMemo(() => deleteRowsAction<R>({
    productId,
    target: (row) => live.current.target(row),
    can: () => canDelete,
    authStatus: status,
    onDeleted: (done) => {
      if (done.closesPage) {
        toast(`${done.summary} Restore from Products → Recycle bin.`, 'success', { duration: 10000 })
        router.push('/products')
        return
      }
      if (!hostReloads) live.current.onChanged()
      const undo = () => void done.undo().then((answer) => {
        toast(answer.message, answer.ok ? 'success' : 'danger')
        live.current.onChanged()
      })
      toast(<span>{done.summary}{' '}<Button size="xs" variant="secondary" onClick={undo}>Undo</Button></span>, 'success', { duration: 10000 })
    },
  }), [productId, canDelete, status, toast, router, hostReloads])
}
