'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedPhoto, PhotoMark } from '@nexus/ui/components/PhotoCapture/index'
import { openPdf } from '@nexus/ui/components/PdfViewer/index'
import type { ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { loadPdfJs } from '../../lib/pdf/load-pdfjs'
import { recordAddress } from '../../lib/records/record-links'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { completeUpload, type ApiFile, type RecordKey } from '../api'
import { putToStore, readFromStore, sha256Hex, storeUrl, StoreError } from '../store'
import type { FileDepthActions } from './actions'
import { createMarkup, previewLink, readDocuments, readHistory, readMarkups, restoreVersion, saveDocument, type ApiDocuments, type ApiHistoryVersion, type ApiMarkup } from './api'
import {
  isPicture,
  markTargetOf,
  pick,
  restoreHeld,
  tagBody,
  tagProblem,
  type DocumentInfo,
  type DocumentsState,
  type FileDepthModel,
  type MarkupDialog,
  type MarkupItem,
  type Read,
  type TagDialog,
  type VersionRow,
  type VersionsDialog,
} from './model'

/**
 * The files panel in depth, as a container hook RecordPanels.tsx mounts (B-W2b-177): reads the record's documents
 * (GET /files/documents) with every files read, and does what the parts ask — the Versions pop-up (GET …/history, side
 * by side of two pictures read once each, restore), what a file is and until when (PUT …/document at the row's version),
 * markup (a picture or a PDF page drawn on with the DS PhotoCapture: the picture's marked copy sent as the next version
 * through POST …/markups → the store → the usual confirm; a PDF page's marks kept as an overlay). Problems are message
 * keys of `record-files`; the bytes of a picture or a page live in this tab only (object addresses, revoked on close).
 */

const problemOf = (error: unknown): string => {
  if (error instanceof StoreError) return 'depth.problem.store'
  if (!isApiError(error)) return 'depth.problem.failed'
  switch (error.kind) {
    case 'conflict':
      return 'depth.problem.conflict'
    case 'forbidden':
      return 'depth.problem.forbidden'
    case 'not_found':
      return 'depth.problem.notFound'
    case 'invalid':
      return 'depth.problem.invalid'
    case 'unavailable':
      return 'depth.problem.unavailable'
    default:
      return 'depth.problem.failed'
  }
}

const documentOf = (doc: ApiDocuments['documents'][number]): DocumentInfo => ({ fileId: doc.fileId, name: doc.originalName, category: doc.category, expiresOn: doc.expiresOn, expiryState: doc.expiryState, daysLeft: doc.daysLeft, ofParty: doc.ofParty })

export function documentsStateOf(answer: ApiDocuments): DocumentsState {
  const own = answer.documents.filter((doc) => !doc.ofParty).map(documentOf)
  return {
    today: answer.today,
    recordStatus: answer.status,
    byFile: Object.fromEntries(own.map((doc) => [doc.fileId, doc])),
    partyDocuments: answer.documents.filter((doc) => doc.ofParty).map(documentOf),
    moves: answer.moves.map((move) => ({ toStatus: move.toStatus, requirements: move.requirements })),
    mayTag: answer.mayTag,
  }
}

export function versionRowsOf(versions: readonly ApiHistoryVersion[], canUpload: boolean, prefix: string): VersionRow[] {
  const uploading = versions.some((version) => version.status === 'PENDING_UPLOAD')
  return [...versions]
    .sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))
    .map((version) => ({
      id: version.id,
      versionNo: version.versionNo ?? 1,
      current: version.current,
      status: version.status,
      name: version.originalName,
      sizeBytes: version.sizeBytes,
      addedAt: version.availableAt ?? version.createdAt,
      addedBy: version.addedBy.name,
      fromPartner: version.addedBy.fromPartner,
      madeByMarkup: version.madeByMarkup ? { note: version.madeByMarkup.note, marks: version.madeByMarkup.marks } : null,
      usedBy: version.usedBy.map((use) => ({ label: use.label, typeKey: use.recordType, href: `${prefix}${recordAddress({ type: use.recordType, id: use.recordId, ...(use.label ? { label: use.label } : {}) }, OFFICE_PAGES)}` })),
      markups: version.markups,
      picture: isPicture(version.contentType),
      restoreHeld: restoreHeld({ current: version.current, status: version.status }, canUpload, uploading),
    }))
}

export const markupItemOf = (markup: ApiMarkup): MarkupItem => ({
  id: markup.id,
  page: markup.page,
  versionNo: markup.versionNo,
  note: markup.note,
  by: markup.createdByName,
  fromPartner: markup.fromPartner,
  at: markup.createdAt,
  marks: markup.shapes as PhotoMark[],
  madeVersion: markup.resultFileId !== null,
})

/** A picture's natural size, read in the browser. */
function sizeOf(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('unreadable picture'))
    image.src = src
  })
}

/** One page of a PDF drawn as a picture (about 1600 px wide), with the page count. */
async function pageImage(bytes: Uint8Array, page: number): Promise<{ src: string; width: number; height: number; pages: number }> {
  const { promise } = openPdf(loadPdfJs, bytes)
  const document = await promise
  try {
    const number = Math.min(Math.max(1, page), document.numPages)
    const pdfPage = await document.getPage(number)
    const base = pdfPage.getViewport({ scale: 1 })
    const viewport = pdfPage.getViewport({ scale: Math.min(3, 1600 / Math.max(1, base.width)) })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('no canvas')
    await pdfPage.render({ canvasContext: context, canvas, viewport }).promise
    return { src: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, pages: document.numPages }
  } finally {
    void document.destroy?.()
  }
}

export interface FileDepthOptions {
  readonly api: ApiClient
  readonly record: RecordKey
  /** The record's files as last read (null while reading or not readable). */
  readonly files: readonly ApiFile[] | null
  readonly canUpload: boolean
  readonly canRead: boolean
  /** `/w/<company>` for the links of "which records use it". */
  readonly prefix: string
  /** Read the record's files again (after a restore, a tag, a marked picture). */
  readonly reloadFiles: () => void
  /** Open a PDF in the panel's own viewer. */
  readonly openPdf: (fileId: string) => void
}

export function useFileDepth(options: FileDepthOptions): { readonly model: FileDepthModel; readonly actions: FileDepthActions } {
  const { api, record, files, canUpload, canRead, prefix, reloadFiles } = options
  const [documents, setDocuments] = useState<Read<DocumentsState>>({ status: 'loading' })
  const [versions, setVersions] = useState<VersionsDialog | null>(null)
  const [tag, setTag] = useState<TagDialog | null>(null)
  const [markup, setMarkup] = useState<MarkupDialog | null>(null)
  const [notice, setNotice] = useState<FileDepthModel['notice']>(null)
  const urls = useRef<string[]>([])
  const pdfBytes = useRef<Uint8Array | null>(null)
  const key = `${record.type}:${record.id}`
  const filesKey = files?.map((file) => `${file.id}:${file.version}`).join(',') ?? ''

  const objectUrl = (blob: Blob): string => {
    const url = URL.createObjectURL(blob)
    urls.current.push(url)
    return url
  }
  const revokeAll = () => {
    for (const url of urls.current) URL.revokeObjectURL(url)
    urls.current = []
  }
  useEffect(() => revokeAll, [])

  const loadDocuments = useCallback(async () => {
    if (!canRead) return
    try {
      setDocuments({ status: 'ready', value: documentsStateOf(await readDocuments(api, record)) })
    } catch (error) {
      setDocuments({ status: 'failed', problem: problemOf(error) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, canRead])

  // The documents are read again with every read of the files (a new file, a version, a reminder, a tag).
  useEffect(() => {
    if (files !== null) void loadDocuments()
  }, [filesKey, files, loadDocuments])

  const loadVersions = useCallback(
    async (fileId: string) => {
      try {
        const { versions: rows } = await readHistory(api, fileId)
        setVersions((current) => (current && current.fileId === fileId ? { ...current, read: { status: 'ready', value: versionRowsOf(rows, canUpload, prefix) } } : current))
      } catch (error) {
        setVersions((current) => (current && current.fileId === fileId ? { ...current, read: { status: 'failed', problem: problemOf(error) } } : current))
      }
    },
    [api, canUpload, prefix],
  )

  const fileOf = (fileId: string) => files?.find((file) => file.id === fileId) ?? null

  const readImage = async (fileId: string): Promise<{ src: string; width: number; height: number }> => {
    const { preview } = await previewLink(api, fileId)
    const bytes = await readFromStore({ method: 'GET', url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt })
    const src = objectUrl(new Blob([bytes.slice().buffer], { type: fileOf(fileId)?.contentType ?? 'image/jpeg' }))
    return { src, ...(await sizeOf(src)) }
  }

  const openMarkupPage = async (fileId: string, page: number) => {
    try {
      if (!pdfBytes.current) {
        const { preview } = await previewLink(api, fileId)
        pdfBytes.current = await readFromStore({ method: 'GET', url: preview.url, headers: preview.headers, expiresAt: preview.expiresAt })
      }
      const drawn = await pageImage(pdfBytes.current, page)
      setMarkup((current) => (current && current.fileId === fileId ? { ...current, page: Math.min(page, drawn.pages), pages: drawn.pages, image: { status: 'ready', value: { src: drawn.src, width: drawn.width, height: drawn.height } } } : current))
    } catch (error) {
      setMarkup((current) => (current && current.fileId === fileId ? { ...current, image: { status: 'failed', problem: problemOf(error) } } : current))
    }
  }

  const loadMarkups = async (fileId: string) => {
    try {
      const { markups } = await readMarkups(api, fileId)
      setMarkup((current) => (current && current.fileId === fileId ? { ...current, markups: { status: 'ready', value: markups.map(markupItemOf) } } : current))
    } catch (error) {
      setMarkup((current) => (current && current.fileId === fileId ? { ...current, markups: { status: 'failed', problem: problemOf(error) } } : current))
    }
  }

  const actions: FileDepthActions = {
    onRetryDocuments: () => {
      setDocuments({ status: 'loading' })
      void loadDocuments()
    },
    onDismissNotice: () => setNotice(null),
    onOpenVersions: (fileId) => {
      const file = fileOf(fileId)
      setVersions({ fileId, name: file?.originalName ?? '', read: { status: 'loading' }, picked: [], compare: null, busy: false, problem: null })
      void loadVersions(fileId)
    },
    onRetryVersions: () => {
      if (!versions) return
      setVersions({ ...versions, read: { status: 'loading' } })
      void loadVersions(versions.fileId)
    },
    onCloseVersions: () => {
      revokeAll()
      setVersions(null)
    },
    onPickVersion: (fileId, on) => setVersions((current) => (current ? { ...current, picked: pick(current.picked, fileId, on) } : current)),
    onCompare: () => {
      if (!versions || versions.read.status !== 'ready') return
      const chosen = versions.read.value.filter((row) => versions.picked.includes(row.id)).sort((a, b) => a.versionNo - b.versionNo)
      if (chosen.length !== 2) return
      setVersions({ ...versions, compare: { status: 'loading' } })
      void Promise.all(chosen.map((row) => readImage(row.id)))
        .then(([left, right]) => setVersions((current) => (current ? { ...current, compare: { status: 'ready', value: [{ versionNo: chosen[0]!.versionNo, src: left!.src }, { versionNo: chosen[1]!.versionNo, src: right!.src }] } } : current)))
        .catch((error: unknown) => setVersions((current) => (current ? { ...current, compare: { status: 'failed', problem: problemOf(error) } } : current)))
    },
    onCloseCompare: () => setVersions((current) => (current ? { ...current, compare: null } : current)),
    onPreviewVersion: (fileId) => {
      const row = versions?.read.status === 'ready' ? versions.read.value.find((item) => item.id === fileId) : undefined
      const file = fileOf(fileId)
      if ((file?.contentType ?? '').toLowerCase() === 'application/pdf' || (row && !row.picture && file === null)) {
        options.openPdf(fileId)
        return
      }
      void previewLink(api, fileId)
        .then(({ preview }) => window.open(storeUrl(preview.url), '_blank', 'noopener'))
        .catch((error: unknown) => setVersions((current) => (current ? { ...current, problem: problemOf(error) } : current)))
    },
    onRestore: (fileId) => {
      if (!versions) return
      setVersions({ ...versions, busy: true, problem: null })
      void restoreVersion(api, fileId)
        .then(async () => {
          setNotice({ key: 'depth.notice.restored', tone: 'success' })
          reloadFiles()
          await loadVersions(versions.fileId)
          setVersions((current) => (current ? { ...current, busy: false } : current))
        })
        .catch((error: unknown) => setVersions((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current)))
    },
    onOpenTag: (fileId) => {
      const file = fileOf(fileId)
      const info = documents.status === 'ready' ? documents.value.byFile[fileId] : undefined
      setTag({ fileId, name: file?.originalName ?? '', category: info?.category ?? null, expiresOn: info?.expiresOn ?? '', busy: false, problem: null })
    },
    onTagDraft: (change) => setTag((current) => (current ? { ...current, ...change, problem: null } : current)),
    onCloseTag: () => setTag(null),
    onSaveTag: () => {
      if (!tag || documents.status !== 'ready') return
      const problem = tagProblem(tag, documents.value.today)
      if (problem) return setTag({ ...tag, problem })
      const body = tagBody(tag, documents.value.byFile[tag.fileId])
      const version = fileOf(tag.fileId)?.version
      if (Object.keys(body).length === 0 || version === undefined) return setTag(null)
      setTag({ ...tag, busy: true, problem: null })
      void saveDocument(api, tag.fileId, { ...body, version })
        .then(() => {
          setTag(null)
          setNotice({ key: 'depth.notice.tagged', tone: 'success' })
          reloadFiles()
        })
        .catch((error: unknown) => {
          setTag((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
          if (isApiError(error) && error.kind === 'conflict') reloadFiles()
        })
    },
    onOpenMarkup: (fileId) => {
      const file = fileOf(fileId)
      const target = file ? markTargetOf(file.contentType) : null
      if (!file || !target) return
      pdfBytes.current = null
      setMarkup({ fileId, name: file.originalName, target, page: 1, pages: null, image: { status: 'loading' }, note: '', markups: { status: 'loading' }, busy: false, problem: null })
      void loadMarkups(fileId)
      if (target === 'pdf') void openMarkupPage(fileId, 1)
      else
        void readImage(fileId)
          .then((image) => setMarkup((current) => (current && current.fileId === fileId ? { ...current, image: { status: 'ready', value: image } } : current)))
          .catch((error: unknown) => setMarkup((current) => (current && current.fileId === fileId ? { ...current, image: { status: 'failed', problem: problemOf(error) } } : current)))
    },
    onMarkupPage: (page) => {
      if (!markup || markup.target !== 'pdf') return
      setMarkup({ ...markup, page, image: { status: 'loading' } })
      void openMarkupPage(markup.fileId, page)
    },
    onMarkupNote: (note) => setMarkup((current) => (current ? { ...current, note } : current)),
    onCloseMarkup: () => {
      revokeAll()
      pdfBytes.current = null
      setMarkup(null)
    },
    onSaveMarkup: async (photo: CapturedPhoto) => {
      if (!markup) return
      const note = markup.note.trim() === '' ? null : markup.note.trim()
      setMarkup({ ...markup, busy: true, problem: null })
      try {
        if (markup.target === 'pdf') {
          await createMarkup(api, markup.fileId, { page: markup.page, shapes: photo.marks, note, result: null })
          setNotice({ key: 'depth.notice.overlay', tone: 'success' })
          setMarkup((current) => (current ? { ...current, busy: false, note: '', markups: { status: 'loading' } } : current))
          await loadMarkups(markup.fileId)
          return
        }
        const marked = photo.marked
        if (!marked) throw new Error('no marks')
        const bytes = await marked.arrayBuffer()
        const made = await createMarkup(api, markup.fileId, { page: null, shapes: photo.marks, note, result: { contentType: marked.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) } })
        if (made.upload && made.file) {
          await putToStore(made.upload, bytes)
          await completeUpload(api, made.file.id)
        }
        revokeAll()
        setMarkup(null)
        setNotice({ key: 'depth.notice.marked', tone: 'success' })
        reloadFiles()
      } catch (error) {
        setMarkup((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
      }
    },
  }

  const model = useMemo<FileDepthModel>(() => ({ documents, canUpload, versions, tag, markup, notice }), [documents, canUpload, versions, tag, markup, notice])
  return { model, actions }
}
