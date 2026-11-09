'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { documentBytes, fetchDocument, type CustomerDocument, type DocumentFile } from './api'
import { isPdf, isPicture, mainFileOf, neighbourOf, openRefusal, previewRowOf, versionLines } from './model'
import type { DocumentPreviewModel } from './view/DocumentPreview'

/**
 * The document pop-up and the downloads of a page (lifted from Home's container by B-W2b-195; Home's New documents and the
 * Documents page use it alike): Preview reads the bytes once (POST …/download {mode: preview}: the API logs the open and it
 * clears NEW for this person) into the PdfViewer, a picture as it is, anything else "download it"; the versions come from
 * GET …/:id (an earlier one can be opened from there; a withdrawn one names the newer); J / K move through the page's list;
 * Download saves the bytes on the device (one more logged open). Nothing is sent while `held` says why.
 */

/** Saves bytes as a file on this device (a document the person chose to download). */
export function saveBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type Dialog = Omit<DocumentPreviewModel, 'position' | 'held'> & { ids: readonly string[] }

export interface DocumentPreviewHost {
  api: ApiClient
  locale: Locale
  /** Why nothing may be opened now (a preview of the portal, no connection), in words; null: it may. */
  held: string | null
  /** The documents of the page, by id (J / K and Download find them here). */
  find: (id: string) => CustomerDocument | undefined
  /** The pop-up closed: opened documents are no longer new (the page reads its list again). */
  onClosed?: () => void
}

export interface DocumentPreviewControl {
  /** The pop-up's model, or null while it is closed. */
  dialog: DocumentPreviewModel | null
  /** The documents opened in this visit (no longer NEW on the page). */
  opened: ReadonlySet<string>
  /** The row whose Download runs outside the pop-up. */
  busy: string | null
  /** A refused Download outside the pop-up: a key of `portal-documents` (with the newer version's words). */
  problem: { key: string; params?: Readonly<Record<string, string | number>> } | null
  /** Opens a document in the pop-up; `ids` is the list J / K move through. */
  open: (document: CustomerDocument, ids: readonly string[]) => void
  /** Opens a document the page knows only by its id (a conformity row's declaration): read first, then the pop-up. */
  openId: (id: string, ids: readonly string[]) => void
  /** Saves a document (or one of its files: an invoice's XML) on the device. */
  download: (document: CustomerDocument, fileId?: string) => Promise<boolean>
  /** Saves a file the page knows only by its id (any file of a document: a conformity row's, an invoice's PDF or XML). */
  downloadId: (fileId: string, rowId?: string) => Promise<boolean>
  /**
   * Opens a file in a new tab (design tab:pdf "Document PDF or XML"): the tab is opened at once (the click allows it), the
   * logged open is read, and the tab shows the bytes. A blocked tab saves the file instead.
   */
  openInTab: (file: Pick<DocumentFile, 'fileId' | 'contentType'>, rowId?: string) => void
  /** The refused open outside the pop-up is read: its line goes. */
  dismissProblem: () => void
  actions: {
    onClose: () => void
    onRetry: () => void
    onDownload: () => void
    onStep: (step: 1 | -1) => void
    onVersion: (id: string) => void
  }
}

export function useDocumentPreview(host: DocumentPreviewHost): DocumentPreviewControl {
  const latest = useRef(host)
  latest.current = host
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<DocumentPreviewControl['problem']>(null)
  // Versions read in the pop-up: an earlier one opens from there even when the page does not list it.
  const versions = useRef(new Map<string, CustomerDocument>())
  const picture = useRef<string | null>(null)
  const dropPicture = () => {
    if (picture.current) URL.revokeObjectURL(picture.current)
    picture.current = null
  }
  useEffect(() => () => dropPicture(), [])

  const documentOf = (id: string): CustomerDocument | undefined => latest.current.find(id) ?? versions.current.get(id)
  const markOpened = (id: string) => setOpened((current) => (current.has(id) ? current : new Set(current).add(id)))

  const open = useCallback((document: CustomerDocument, ids: readonly string[]) => {
    const { api, locale, held } = latest.current
    const id = document.id
    const file = mainFileOf(document)
    const pdf = file ? isPdf(file.contentType) : false
    dropPicture()
    setDialog({ row: previewRowOf(document, locale), state: held ? 'held' : 'loading', src: null, pdf, versions: [], withdrawn: null, downloading: false, problem: null, ids })
    if (!held) {
      documentBytes(api, id, 'preview')
        .then(({ bytes }) => {
          let src: Uint8Array | string | null = pdf ? bytes : null
          if (!pdf && file && isPicture(file.contentType)) {
            src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType }))
            picture.current = src
          }
          markOpened(id)
          setDialog((current) => (current?.row.id === id ? { ...current, state: 'ready', src } : current))
        })
        .catch((error: unknown) => {
          const refusal = openRefusal(isApiError(error) ? error : null)
          setDialog((current) => (current?.row.id === id ? (refusal.withdrawn ? { ...current, state: 'withdrawn' } : { ...current, state: 'error', problem: { key: refusal.key } }) : current))
        })
    }
    fetchDocument(api, id)
      .then((one) => {
        for (const version of one.versions) versions.current.set(version.id, version)
        const newer = one.withdrawn?.replacedBy ?? null
        setDialog((current) =>
          current?.row.id === id
            ? { ...current, versions: one.versions.length > 1 ? versionLines(one.versions) : [], withdrawn: newer ? { id: newer.id, title: newer.title[latest.current.locale], version: newer.version } : one.withdrawn ? { id: null, title: one.withdrawn.title[latest.current.locale], version: one.withdrawn.version } : null }
            : current,
        )
      })
      .catch(() => undefined)
  }, [])

  const download = useCallback(async (document: CustomerDocument, fileId?: string): Promise<boolean> => {
    const { api, held } = latest.current
    if (held) return false
    const file = (fileId ? document.files.find((entry) => entry.fileId === fileId) : null) ?? mainFileOf(document)
    if (!file) return false
    const inDialog = dialog?.row.id === document.id
    setProblem(null)
    if (inDialog) setDialog((current) => (current ? { ...current, downloading: true, problem: null } : current))
    else setBusy(document.id)
    try {
      const { name, bytes } = await documentBytes(api, file.fileId, 'download')
      saveBytes(name, bytes, file.contentType || 'application/octet-stream')
      markOpened(document.id)
      return true
    } catch (error) {
      const refusal = openRefusal(isApiError(error) ? error : null)
      const words = { key: refusal.key === 'preview.problem.failed' ? 'preview.problem.openFailed' : refusal.key }
      if (inDialog) setDialog((current) => (current ? { ...current, problem: words } : current))
      else setProblem(words)
      return false
    } finally {
      if (inDialog) setDialog((current) => (current ? { ...current, downloading: false } : current))
      else setBusy(null)
    }
  }, [dialog?.row.id])

  const openId = useCallback(
    (id: string, ids: readonly string[]) => {
      const known = documentOf(id)
      if (known) return open(known, ids)
      setProblem(null)
      setBusy(id)
      fetchDocument(latest.current.api, id)
        .then((one) => {
          for (const version of one.versions) versions.current.set(version.id, version)
          if (one.document) open(one.document, ids)
          else setProblem({ key: 'preview.problem.withdrawn' })
        })
        .catch((error: unknown) => setProblem({ key: openRefusal(isApiError(error) ? error : null).key }))
        .finally(() => setBusy((current) => (current === id ? null : current)))
    },
    [open],
  )

  const downloadId = useCallback(async (fileId: string, rowId?: string): Promise<boolean> => {
    const { api, held } = latest.current
    if (held) return false
    setProblem(null)
    setBusy(rowId ?? fileId)
    try {
      const { name, bytes } = await documentBytes(api, fileId, 'download')
      saveBytes(name, bytes, 'application/octet-stream')
      markOpened(rowId ?? fileId)
      return true
    } catch (error) {
      const refusal = openRefusal(isApiError(error) ? error : null)
      setProblem({ key: refusal.key === 'preview.problem.failed' ? 'preview.problem.openFailed' : refusal.key })
      return false
    } finally {
      setBusy(null)
    }
  }, [])

  const openInTab = (file: Pick<DocumentFile, 'fileId' | 'contentType'>, rowId?: string) => {
    const { api, held } = latest.current
    if (held) return
    // Opened now, while the click allows a new tab; filled when the bytes are here.
    const tab = window.open('', '_blank')
    setProblem(null)
    setBusy(rowId ?? file.fileId)
    documentBytes(api, file.fileId, 'preview')
      .then(({ name, bytes }) => {
        markOpened(rowId ?? file.fileId)
        const type = file.contentType || 'application/octet-stream'
        if (!tab || tab.closed) return saveBytes(name, bytes, type)
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        tab.location.href = url
        // The tab has read it by then; the address is not kept.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      })
      .catch((error: unknown) => {
        tab?.close()
        const refusal = openRefusal(isApiError(error) ? error : null)
        setProblem({ key: refusal.key === 'preview.problem.failed' ? 'preview.problem.openFailed' : refusal.key })
      })
      .finally(() => setBusy(null))
  }

  const close = () => {
    dropPicture()
    setDialog(null)
    latest.current.onClosed?.()
  }

  const goTo = (id: string, ids: readonly string[]) => {
    const document = documentOf(id)
    if (document) open(document, ids)
  }

  const held = host.held
  return {
    dialog: dialog
      ? {
          ...dialog,
          held,
          position: dialog.ids.length > 1 && dialog.ids.includes(dialog.row.id) ? { index: dialog.ids.indexOf(dialog.row.id) + 1, count: dialog.ids.length } : null,
        }
      : null,
    opened,
    busy,
    problem,
    open,
    openId,
    download,
    downloadId,
    openInTab,
    dismissProblem: () => setProblem(null),
    actions: {
      onClose: close,
      onRetry: () => dialog && goTo(dialog.row.id, dialog.ids),
      onDownload: () => {
        const document = dialog ? documentOf(dialog.row.id) : undefined
        if (document) void download(document)
      },
      onStep: (step) => {
        if (!dialog) return
        const next = neighbourOf(dialog.ids, dialog.row.id, step)
        if (next) goTo(next, dialog.ids)
      },
      onVersion: (id) => dialog && id !== dialog.row.id && goTo(id, dialog.ids),
    },
  }
}
