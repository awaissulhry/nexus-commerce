'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { FilesViewActions } from '../../../lib/record-thread/files-view/view/FilesView'
import { isOwnFile, type OrderFilesModel, type OrderFilesRead } from '../../../lib/record-thread/files-view/model'
// F-OP-126 (R-14): the cards' previews, only those in view, through the order's walled batch route.
import { orderFilesOf } from '../../../lib/record-thread/files-view/model'
import { useFilePreviews } from '../../../lib/record-thread/files-view/use-file-previews'
import { listFiles } from '../../../record-panels/api'
import { storeUrl } from '../../../record-panels/store'
import { openOrderFile, readOrderFiles, shareWithParty } from './api'
import { readOrderFilePreviews } from './api' // F-OP-126
import { openWorksheet } from '../../sales/mtm/api' // F-OP-125 (B5): a worksheet opens by the made-to-measure route (recorded there)

/**
 * F-SA-237 (sales page plan N9, P14) — a sales order's files, the container part the order's Files tab AND the thread's Files window
 * on the order both use (one read, one way to open): reads `GET /sales/orders/:orderId/files` while shown; opens a file through
 * the read's own route (a picture or a PDF in a new tab, anything else downloads; body data is recorded there — never the generic
 * preview); Download N; Share N OWN files (the order's own, still office only) with the order's customer — each file at its version
 * as `GET /files` reads it now (B-TH-003 refuses any other party). Refusals are words of `record-thread-files-view`.
 *
 * F-OP-125 (order page N-1): THE order-files container — the order page mounts it ONCE (OrderRecord.tsx) and gives the same model to
 * the Files tab and, later, to the dock (F-OP-215): one read, one count. The read is made the first time it is wanted and kept while
 * the page stays; news of the order's files (the live channel) reads it again when it is shown, or the next time it is wanted. A
 * made-to-measure worksheet (B5) opens through its own route, which records the opening on the profile.
 */
export function useOrderFiles(
  api: ApiClient,
  input: {
    readonly orderId: string | null
    readonly enabled: boolean
    readonly partyId: string | null
    readonly canShare: boolean
    readonly onProblem?: (key: string) => void
    /** F-OP-125: the page's own container keeps its read across tabs (true); a window that mounts its own reads again each time it opens. */
    readonly keep?: boolean
  },
) {
  const { orderId, enabled, partyId, canShare, keep = false } = input
  const [read, setRead] = useState<OrderFilesRead | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const turn = useRef(0)
  const onProblem = useRef(input.onProblem)
  onProblem.current = input.onProblem
  // F-OP-125: the read this page holds (null: never read, or no longer true — read again the next time it is wanted).
  const readFor = useRef<string | null>(null)
  const wanted = useRef(enabled)
  wanted.current = enabled

  const load = useCallback(() => {
    if (!orderId) return
    const mine = ++turn.current
    readFor.current = orderId
    setProblem(null)
    readOrderFiles(api, orderId)
      .then((answer) => mine === turn.current && setRead(answer))
      .catch((error: unknown) => {
        if (mine !== turn.current) return
        readFor.current = null
        setProblem(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'read')
      })
  }, [api, orderId])

  // Read once, when first wanted (and for another order); kept while the page stays (`keep`), else read again each time it is wanted.
  useEffect(() => {
    if (enabled && readFor.current !== orderId) load()
    if (!enabled && !keep) readFor.current = null
  }, [enabled, orderId, load, keep])
  /** News of the order's files: read again now when shown, else the next time they are wanted. */
  const again = useCallback(() => {
    if (wanted.current) load()
    else readFor.current = null
  }, [load])

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

  // ---- F-OP-126: the previews of the cards in view (the body reports them) ----
  const previews = useFilePreviews({ files: read ? orderFilesOf(read) : null, ask: orderId ? (fileIds) => readOrderFilePreviews(api, orderId, fileIds) : null })

  const actions: FilesViewActions = {
    onRetry: load,
    onOrderVisible: previews.visible, // F-OP-126
    onOrderSelect: setSelected,
    onOrderOpen: (fileId, mode) => void open(fileId, mode),
    // F-OP-125 (B5): a worksheet through the made-to-measure route (it records the opening on the profile), in a new tab.
    onOrderWorksheet: (sheet) => {
      void openWorksheet(api, sheet.profileId, sheet.documentId)
        .then((answer) => window.open(storeUrl(answer.download.url), '_blank', 'noopener'))
        .catch(() => onProblem.current?.('order.openFailed'))
    },
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

  const model: OrderFilesModel = { read, problem, selected, canShare, busy, previews: previews.previews /* F-OP-126 */ }
  return { model, actions, reload: again }
}
