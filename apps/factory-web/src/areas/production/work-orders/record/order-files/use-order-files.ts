'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { readFromStore, storeUrl } from '../../../../../record-panels/store'
import { openWorksheet } from '../../../../sales/mtm/api'
import { readProblem } from '../../../_shared/model'
import { openOrderFile, readOrderFiles } from './api'
import { lookOf, ORDER_FILES_LOADING, type OrderFilesActions, type OrderFilesModel, type ShownFile, type ThreadPick } from './model'

/** Why an opening was refused, in the production catalogue's words ("File not found." is the words of any id not the reader's). */
const openProblem = (error: unknown): string => (isApiError(error) && error.kind === 'not_found' ? 'orderFiles.gone' : readProblem(error))

/**
 * B-TH-265 (agreement T9): the work order's order files and the dock's pick. Reads `GET …/order-files` once the work order is known
 * (again on Try again). F-PR-25: a PDF or a picture is shown BESIDE the list (`onShowFile` through `POST …/order-files/:fileId/open`
 * {mode: preview}, `onShowWorksheet` through the made-to-measure route — each opening of body data recorded by its route): the bytes
 * are read once through the 60-second address; Download saves a file (mode download) without another tab. The pick starts on the
 * work order's own notes.
 */
export function useOrderFiles(api: ApiClient, workOrderId: string | null) {
  const [model, setModel] = useState<OrderFilesModel>(ORDER_FILES_LOADING)
  const [pick, setPick] = useState<ThreadPick>('workOrder')
  const turn = useRef(0)
  // ---- F-PR-25: the file beside the list — its bytes read once through the 60-second address (a PDF for the viewer, a picture as an
  // object address freed when another file is shown or the window closes); only the newest asked file is shown.
  const showTurn = useRef(0)
  const picture = useRef<string | null>(null)
  const dropPicture = useCallback(() => {
    if (picture.current) URL.revokeObjectURL(picture.current)
    picture.current = null
  }, [])
  useEffect(() => dropPicture, [dropPicture])
  const show = useCallback(
    (id: string, name: string, contentType: string, address: () => Promise<{ url: string; headers: Record<string, string>; expiresAt: string }>) => {
      const mine = ++showTurn.current
      const look = lookOf(contentType)
      dropPicture()
      const set = (shown: ShownFile) => mine === showTurn.current && setModel((current) => ({ ...current, shown, problem: null }))
      set({ id, name, look, state: 'loading' })
      address()
        .then(async (presigned) => {
          // Anything that is no PDF or picture is not read here: the window says so and offers Download.
          if (look === 'other') return set({ id, name, look, state: 'ready', src: null })
          const bytes = await readFromStore({ method: 'GET', url: presigned.url, headers: presigned.headers, expiresAt: presigned.expiresAt })
          if (mine !== showTurn.current) return
          if (look === 'pdf') return set({ id, name, look, state: 'ready', src: bytes })
          const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }))
          picture.current = src
          set({ id, name, look, state: 'ready', src })
        })
        .catch((error: unknown) => set({ id, name, look, state: 'error', problem: openProblem(error) }))
    },
    [dropPicture],
  )
  /** Download: the file's download address (a file, never shown) followed at once; nothing opens in another tab. */
  const download = useCallback(async (id: string, name: string, address: () => Promise<string>) => {
    setModel((current) => ({ ...current, opening: id, problem: null }))
    try {
      const link = document.createElement('a')
      link.href = storeUrl(await address())
      link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setModel((current) => ({ ...current, opening: null }))
    } catch (error) {
      setModel((current) => ({ ...current, opening: null, problem: openProblem(error) }))
    }
  }, [])
  // ---- end F-PR-25

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

  const actions = useMemo<OrderFilesActions>(
    () => ({
      onOpen: () => setModel((current) => ({ ...current, open: true, problem: null })),
      onClose: () => {
        // F-PR-25: closing the window lets the shown file go.
        showTurn.current++
        dropPicture()
        setModel((current) => ({ ...current, open: false, problem: null, shown: null }))
      },
      onRetry: read,
      onThread: (next) => {
        setPick(next)
        setModel((current) => ({ ...current, open: false, problem: null }))
      },
      // ---- F-PR-25: shown beside the list (a body-data file's and a worksheet's opening is recorded by its route) ----
      onShowFile: (file) => {
        if (!workOrderId) return
        show(file.id, file.name, file.contentType, () => openOrderFile(api, workOrderId, file.id, 'preview').then((answer) => answer.open))
      },
      onShowWorksheet: (sheet, name) => show(sheet.documentId, name, 'application/pdf', () => openWorksheet(api, sheet.profileId, sheet.documentId).then((answer) => answer.download)),
      onDownload: (file) => {
        if (!workOrderId) return
        void download(file.id, file.name, () => openOrderFile(api, workOrderId, file.id, 'download').then((answer) => answer.open.url))
      },
      onBack: () => {
        showTurn.current++
        dropPicture()
        setModel((current) => ({ ...current, shown: null }))
      },
      // ---- end F-PR-25
    }),
    [api, workOrderId, read, show, download, dropPicture],
  )

  return { model, actions, pick, setPick }
}
