'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FILE_KINDS, type FileKind } from '../../../record-panels/model'
import { viewerShow, type ViewerFile } from '../popups/model'
import type { OrderFile } from './model'
import { readFromStore } from '../../../record-panels/store'

/**
 * F-OP-127 (order page plan N7 "files like Gmail"; 10-order-page §9.3) — the ONE viewer of the order's files, walked like a mail
 * client's: ← / → over every file the reader may open in display order (photos AND PDFs; "3 of 7"), each fetched through the order's
 * own open route only when it is shown (its bytes once, kept as a blob address while the viewer is open); a body-data file shows a lock
 * card and loads only when the person asks ("Open — this opening is recorded": the open route records it); Download is asked at the
 * click (mode download); a file no browser draws (Word, Excel, a ZIP …) shows its card with Download. Esc closes and the focus goes
 * back to the card that opened it. The container (use-order-files) gives it the files and the route; the body draws `viewer`.
 */

export interface OrderViewerModel {
  readonly files: readonly ViewerFile[]
  readonly index: number
  readonly returnTo: HTMLElement | null
}

/** The order's open route: a signed address of one file (inline for a picture or a PDF; the opening of body data is recorded there). */
export type OpenRoute = (fileId: string, mode: 'preview' | 'download') => Promise<{ readonly mode: 'inline' | 'download'; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly expiresAt: string }>

const KINDS: readonly string[] = FILE_KINDS
const kindOf = (file: Pick<OrderFile, 'kind'>): FileKind => (KINDS.includes(file.kind) ? (file.kind as FileKind) : 'ATTACHMENT')

/**
 * The walk as the viewer reads it: every listed file in display order (worksheets open by their own route, never in the walk); its
 * source once fetched; body data locked until opened here.
 */
export function viewerFilesOf(files: readonly OrderFile[], sources: ReadonlyMap<string, string | Uint8Array>, opened: ReadonlySet<string>): ViewerFile[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    kind: kindOf(file),
    sizeBytes: file.sizeBytes,
    status: 'AVAILABLE' as const,
    quarantineReason: null,
    src: sources.get(file.id) ?? null,
    downloadHref: null,
    mayOpen: true,
    messageId: file.inThread?.messageId ?? null,
    versionNo: file.versionNo,
    locked: file.bodyData && !opened.has(file.id),
  }))
}

/** Whether the viewer fetches a file when it is shown: a photo or a PDF it draws, not locked, not fetched yet. */
export const fetchesOf = (file: ViewerFile, sources: ReadonlyMap<string, unknown>): boolean => !file.locked && !sources.has(file.id) && (viewerShow(file) === 'photo' || viewerShow(file) === 'pdf')

export function useOrderFileViewer(input: { readonly files: readonly OrderFile[] | null; readonly open: OpenRoute | null; readonly onProblem?: (key: string) => void }) {
  const { files, open } = input
  const [at, setAt] = useState<{ index: number; returnTo: HTMLElement | null } | null>(null)
  const [sources, setSources] = useState<ReadonlyMap<string, string | Uint8Array>>(new Map())
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const asking = useRef(new Set<string>())
  const blobs = useRef<string[]>([])
  const onProblem = useRef(input.onProblem)
  onProblem.current = input.onProblem
  const list = viewerFilesOf(files ?? [], sources, opened)
  const current = at ? list[Math.max(0, Math.min(list.length - 1, at.index))] : undefined

  /** The file's bytes through the open route, once: a picture as a blob address, a PDF as its bytes. */
  const fetchOne = useCallback(
    async (file: ViewerFile) => {
      if (!open || asking.current.has(file.id)) return
      asking.current.add(file.id)
      try {
        const answer = await open(file.id, 'preview')
        const bytes = await readFromStore({ method: 'GET', url: answer.url, headers: { ...answer.headers }, expiresAt: answer.expiresAt })
        let source: string | Uint8Array = bytes
        if (viewerShow(file) === 'photo') {
          source = URL.createObjectURL(new Blob([bytes], { type: file.contentType }))
          blobs.current.push(source)
        }
        setSources((known) => new Map(known).set(file.id, source))
      } catch {
        onProblem.current?.('order.openFailed')
      } finally {
        asking.current.delete(file.id)
      }
    },
    [open],
  )

  // The file shown is fetched when it needs to be (never a locked one: that waits for its Open).
  useEffect(() => {
    if (current && fetchesOf(current, sources)) void fetchOne(current)
  }, [current, sources, fetchOne])

  // Closed: the blob addresses go, and a body-data file is locked again (it never loads by itself the next time).
  const close = useCallback(() => {
    setAt(null)
    for (const url of blobs.current) URL.revokeObjectURL(url)
    blobs.current = []
    setSources(new Map())
    setOpened(new Set())
  }, [])
  useEffect(() => close, [close])

  return {
    model: at && list.length > 0 ? ({ files: list, index: at.index, returnTo: at.returnTo } satisfies OrderViewerModel) : null,
    /** Open the viewer at this file (the card that opened it gets the focus back). */
    openAt: (fileId: string, returnTo: HTMLElement | null) => {
      const index = list.findIndex((file) => file.id === fileId)
      if (index >= 0) setAt({ index, returnTo })
    },
    onIndex: (index: number) => setAt((known) => (known ? { ...known, index } : known)),
    onClose: close,
    /** Body data: the person asks it — the open route records the opening — then it is shown. */
    onOpenLocked: (fileId: string) => {
      const file = list.find((entry) => entry.id === fileId)
      if (!file) return
      setOpened((known) => new Set(known).add(fileId))
      if (viewerShow(file) === 'photo' || viewerShow(file) === 'pdf') void fetchOne({ ...file, locked: false })
      else void open?.(fileId, 'preview').catch(() => onProblem.current?.('order.openFailed'))
    },
  }
}
