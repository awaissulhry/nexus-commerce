'use client'

/**
 * MX.P — the verb RUN: preview → apply → a revert toast (design §3.8, AAA bar 6).
 *
 * The dialog owns the preview; this owns what happens after Apply: the operation lands through
 * `useMatrix.applyVerbRun` (the in-memory store in preview mode, `POST …/verbs` in live mode), and a
 * toast carries ONE verb — `Revert` — that calls `revertOperation` by value. "Reverted N cells" is the
 * receipt. Nothing here computes a number; the operation's own counts are what the toast prints.
 */
import { createElement, useCallback, useState } from 'react'

import { useToast } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import type { VerbOperation, VerbPreview } from '../contract'

export interface VerbRunApi {
  apply: (preview: VerbPreview) => Promise<VerbOperation | null>
  revert: (op: VerbOperation) => Promise<void>
  busy: boolean
}

export function useVerbRun(matrix: { applyVerbRun: (preview: VerbPreview) => Promise<VerbOperation>; revert: (op: VerbOperation) => Promise<void> }): VerbRunApi {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const revert = useCallback(async (op: VerbOperation) => {
    try {
      await matrix.revert(op)
      toast.toast(`Reverted ${op.before.length} ${op.before.length === 1 ? 'cell' : 'cells'}`, 'info')
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'danger')
    }
  }, [matrix, toast])

  const apply = useCallback(async (preview: VerbPreview): Promise<VerbOperation | null> => {
    setBusy(true)
    try {
      const op = await matrix.applyVerbRun(preview)
      const n = op.applied
      toast.toast(
        createElement(
          'span',
          { className: 'nds-matrix-toast' },
          `Applied ${n} ${n === 1 ? 'cell' : 'cells'}${op.refused ? ` · ${op.refused} refused` : ''}${preview.simulated ? ' · preview' : ''} `,
          createElement(Button, { size: 'sm', variant: 'link', onClick: () => void revert(op) }, 'Revert'),
        ),
        'success',
        { duration: 12000 },
      )
      return op
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'danger')
      return null
    } finally {
      setBusy(false)
    }
  }, [matrix, toast, revert])

  return { apply, revert, busy }
}
