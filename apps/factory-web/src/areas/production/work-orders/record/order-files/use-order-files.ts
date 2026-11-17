'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { storeUrl } from '../../../../../record-panels/store'
import { openWorksheet } from '../../../../sales/mtm/api'
import { readProblem } from '../../../_shared/model'
import { openOrderFile, readOrderFiles } from './api'
import { ORDER_FILES_LOADING, type OrderFilesActions, type OrderFilesModel, type ThreadPick } from './model'

/** Why an opening was refused, in the production catalogue's words ("File not found." is the words of any id not the reader's). */
const openProblem = (error: unknown): string => (isApiError(error) && error.kind === 'not_found' ? 'orderFiles.gone' : readProblem(error))

/**
 * B-TH-265 (agreement T9): the work order's order files and the dock's pick. Reads `GET …/order-files` once the work order is known
 * (again on Try again); opens a file through `POST …/order-files/:fileId/open` and a worksheet through the made-to-measure route,
 * each in a tab opened at the click (a browser opens no window after an await) that then goes to the 60-second address. The pick
 * starts on the work order's own notes.
 */
export function useOrderFiles(api: ApiClient, workOrderId: string | null) {
  const [model, setModel] = useState<OrderFilesModel>(ORDER_FILES_LOADING)
  const [pick, setPick] = useState<ThreadPick>('workOrder')
  const turn = useRef(0)

  const read = useCallback(() => {
    if (!workOrderId) return
    const mine = ++turn.current
    setModel((current) => ({ ...current, files: current.files.state === 'ready' ? current.files : { state: 'loading' } }))
    readOrderFiles(api, workOrderId)
      .then((value) => mine === turn.current && setModel((current) => ({ ...current, files: { state: 'ready', read: value } })))
      .catch((error: unknown) => mine === turn.current && setModel((current) => ({ ...current, files: { state: 'error', problem: readProblem(error) } })))
  }, [api, workOrderId])

  useEffect(() => {
    read()
  }, [read])

  /** One opening: the tab at the click, then its address; a refusal closes the tab and says why in the dialog. */
  const opening = useCallback(async (id: string, address: () => Promise<string>) => {
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setModel((current) => ({ ...current, opening: id, problem: null }))
    try {
      const url = storeUrl(await address())
      if (tab) tab.location.href = url
      else window.location.assign(url)
      setModel((current) => ({ ...current, opening: null }))
    } catch (error) {
      tab?.close()
      setModel((current) => ({ ...current, opening: null, problem: openProblem(error) }))
    }
  }, [])

  const actions = useMemo<OrderFilesActions>(
    () => ({
      onOpen: () => setModel((current) => ({ ...current, open: true, problem: null })),
      onClose: () => setModel((current) => ({ ...current, open: false, problem: null })),
      onRetry: read,
      onOpenFile: (fileId, mode) => {
        if (!workOrderId) return
        void opening(fileId, () => openOrderFile(api, workOrderId, fileId, mode).then((answer) => answer.open.url))
      },
      onOpenWorksheet: (profileId, documentId) => void opening(documentId, () => openWorksheet(api, profileId, documentId).then((answer) => answer.download.url)),
      onThread: (next) => {
        setPick(next)
        setModel((current) => ({ ...current, open: false, problem: null }))
      },
    }),
    [api, workOrderId, read, opening],
  )

  return { model, actions, pick, setPick }
}
