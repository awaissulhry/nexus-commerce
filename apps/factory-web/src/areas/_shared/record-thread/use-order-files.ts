'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { FilesViewActions } from '../../../lib/record-thread/files-view/view/FilesView'
import { isOwnFile, type OrderFilesModel, type OrderFilesRead } from '../../../lib/record-thread/files-view/model'
import { listFiles } from '../../../record-panels/api'
import { storeUrl } from '../../../record-panels/store'
import { openOrderFile, readOrderFiles, shareWithParty } from './api'

/**
 * F-SA-237 (sales page plan N9, P14) — a sales order's files, the container part the order's Files tab AND the thread's Files window
 * on the order both use (one read, one way to open): reads `GET /sales/orders/:orderId/files` while shown; opens a file through
 * the read's own route (a picture or a PDF in a new tab, anything else downloads; body data is recorded there — never the generic
 * preview); Download N; Share N OWN files (the order's own, still office only) with the order's customer — each file at its version
 * as `GET /files` reads it now (B-TH-003 refuses any other party). Refusals are words of `record-thread-files-view`.
 */
export function useOrderFiles(api: ApiClient, input: { readonly orderId: string | null; readonly enabled: boolean; readonly partyId: string | null; readonly canShare: boolean; readonly onProblem?: (key: string) => void }) {
  const { orderId, enabled, partyId, canShare } = input
  const [read, setRead] = useState<OrderFilesRead | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const turn = useRef(0)
  const onProblem = useRef(input.onProblem)
  onProblem.current = input.onProblem

  const load = useCallback(() => {
    if (!orderId) return
    const mine = ++turn.current
    setProblem(null)
    readOrderFiles(api, orderId)
      .then((answer) => mine === turn.current && setRead(answer))
      .catch((error: unknown) => mine === turn.current && setProblem(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'read'))
  }, [api, orderId])

  useEffect(() => {
    if (enabled) load()
  }, [enabled, load])

  const open = useCallback(
    async (fileId: string, mode: 'preview' | 'download') => {
      if (!orderId) return
      try {
        const answer = await openOrderFile(api, orderId, fileId, mode)
        const url = storeUrl(answer.url)
        if (answer.mode === 'inline') window.open(url, '_blank', 'noopener')
        else {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.rel = 'noopener'
          anchor.download = read?.groups.flatMap((group) => group.files).find((file) => file.id === fileId)?.name ?? ''
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
        }
      } catch {
        onProblem.current?.('order.openFailed')
      }
    },
    [api, orderId, read],
  )

  const actions: FilesViewActions = {
    onRetry: load,
    onOrderSelect: setSelected,
    onOrderOpen: (fileId, mode) => void open(fileId, mode),
    onOrderBulk: (action, ids) => {
      if (action === 'download') {
        for (const fileId of ids) void open(fileId, 'download')
        return
      }
      if (!orderId || !partyId || !canShare || busy) return
      const own = (read?.groups.flatMap((group) => group.files) ?? []).filter((file) => ids.includes(file.id) && isOwnFile(file, orderId))
      setBusy(true)
      listFiles(api, { type: 'SalesOrder', id: orderId })
        .then(async ({ files }) => {
          for (const file of own) {
            const now = files.find((entry) => entry.id === file.id)
            if (now) await shareWithParty(api, now, partyId)
          }
          setSelected([])
        })
        .catch(() => onProblem.current?.('order.shareFailed'))
        .finally(() => {
          setBusy(false)
          load()
        })
    },
  }

  const model: OrderFilesModel = { read, problem, selected, canShare, busy }
  return { model, actions, reload: load }
}
