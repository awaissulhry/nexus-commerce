'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { WithMessages } from '../../record-panels/i18n'
import { askForNewLink, downloadLinkDocument, presignedBytes, readLinkDocuments } from './api'
import { documentRows, fileNameOf, msUntilExpiry, shownDocument, stateOfDocuments, stateOfReadError, type DocumentLinkViewModel } from './model'
import { DocumentLinkView } from './view/DocumentLinkView'

/**
 * A DOCUMENT_VIEW link of a Shipment, once it opened (the link landing did `POST /link/open`, which counts the open):
 * reads the shipment's shared documents (`GET /shipping/link/documents`, which uses nothing), reads the chosen one into
 * the page's PDF viewer through a logged download (`POST …/:fileId/download`, then the 60 s presigned GET), and asks for
 * a new link when this one died while open (`POST /shipping/link/renew`). The token stays in the client's
 * `x-factory-link` header; the presigned address and the bytes stay in memory for this visit only.
 *
 * Reading a document in the page IS its logged download: one Idempotency-Key per file per visit, so reading the same
 * file again in this visit is answered from the API's receipt (logged once). Download saves the bytes already read
 * (the viewer's own button and the page's primary alike); it reads them first when they are not here yet.
 */
export function DocumentLink({ api }: { api: ApiClient }) {
  return (
    <WithMessages namespaces={['document-link']}>
      <DocumentLinkContainer api={api} />
    </WithMessages>
  )
}

const SLOW_MS = 1_000

function saveBytes(data: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function DocumentLinkContainer({ api }: { api: ApiClient }) {
  const locale = useLocale()
  // The page's language picks the version a row opens first; switching it later never reads the link again.
  const localeRef = useRef(locale)
  localeRef.current = locale
  const [model, setModel] = useState<DocumentLinkViewModel>({ link: 'loading', documents: null, chosen: null, pdf: null, slow: false, ask: 'idle' })
  const current = useRef(model)
  current.current = model
  // This visit's keys and bytes per file (memory only; gone with the tab).
  const keys = useRef(new Map<string, string>())
  const bytes = useRef(new Map<string, Uint8Array>())
  const reading = useRef<string | null>(null)

  const keyOf = (fileId: string) => {
    const known = keys.current.get(fileId)
    if (known) return known
    const key = newIdempotencyKey()
    keys.current.set(fileId, key)
    return key
  }

  /** The file's bytes for this visit: kept, else a logged download (once per visit) and its presigned GET. */
  const bytesOf = useCallback(
    async (fileId: string): Promise<Uint8Array> => {
      const kept = bytes.current.get(fileId)
      if (kept) return kept
      const download = await downloadLinkDocument(api, fileId, keyOf(fileId))
      const data = await presignedBytes(download)
      bytes.current.set(fileId, data)
      return data
    },
    [api],
  )

  const deadOrFailed = useCallback((error: unknown, fileId: string) => {
    // The one 404: the link was used up or withdrawn while the page was open (or the file is no longer shared).
    if (isApiError(error) && error.kind === 'not_found') setModel((state) => ({ ...state, link: 'unavailable', pdf: null }))
    else setModel((state) => (state.pdf?.fileId === fileId ? { ...state, pdf: { fileId, state: 'failed', data: null } } : state))
  }, [])

  const readPdf = useCallback(
    (fileId: string) => {
      reading.current = fileId
      const kept = bytes.current.get(fileId)
      setModel((state) => ({ ...state, pdf: { fileId, state: kept ? 'ready' : 'loading', data: kept ?? null } }))
      if (kept) return
      bytesOf(fileId)
        .then((data) => {
          if (reading.current !== fileId) return
          setModel((state) => ({ ...state, pdf: { fileId, state: 'ready', data } }))
        })
        .catch((error: unknown) => {
          if (reading.current === fileId) deadOrFailed(error, fileId)
        })
    },
    [bytesOf, deadOrFailed],
  )

  const load = useCallback(async () => {
    setModel((state) => ({ ...state, link: 'loading', slow: false }))
    try {
      const documents = await readLinkDocuments(api)
      const link = stateOfDocuments(documents, new Date())
      const first = documentRows(documents.documents, localeRef.current)[0]?.document ?? null
      const prior = current.current.chosen
      const chosen = prior && documents.documents.some((document) => document.fileId === prior) ? prior : (first?.fileId ?? null)
      setModel((state) => ({ ...state, link, documents, chosen, expiredAt: link === 'expired' ? documents.link.expiresAt : null }))
      const shown = shownDocument(documents.documents, chosen)
      if (link === 'valid' && shown && shown.contentType === 'application/pdf') readPdf(shown.fileId)
    } catch (error) {
      setModel((state) => ({ ...state, link: stateOfReadError(error), documents: null }))
    }
  }, [api, readPdf])

  useEffect(() => {
    void load()
  }, [load])

  // "Still loading…" after about a second.
  useEffect(() => {
    if (model.link !== 'loading') return
    const timer = setTimeout(() => setModel((state) => (state.link === 'loading' ? { ...state, slow: true } : state)), SLOW_MS)
    return () => clearTimeout(timer)
  }, [model.link])

  // The expiry passing while the page is open turns it to "expired" at once (the device's clock against the link's).
  const expiresAt = model.documents?.link.expiresAt ?? null
  useEffect(() => {
    if (!expiresAt || model.link !== 'valid') return
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      const wait = msUntilExpiry({ expiresAt }, new Date())
      timer = setTimeout(() => {
        if (msUntilExpiry({ expiresAt }, new Date()) > 0) arm()
        else setModel((state) => ({ ...state, link: 'expired', expiredAt: expiresAt, pdf: null }))
      }, wait)
    }
    arm()
    return () => clearTimeout(timer)
  }, [expiresAt, model.link])

  const shown = model.documents ? shownDocument(model.documents.documents, model.chosen) : null

  return (
    <DocumentLinkView
      model={model}
      actions={{
        onChoose: (fileId) => {
          if (current.current.link !== 'valid') return
          setModel((state) => ({ ...state, chosen: fileId }))
          const next = current.current.documents?.documents.find((document) => document.fileId === fileId)
          if (next && next.contentType === 'application/pdf') readPdf(fileId)
          else setModel((state) => ({ ...state, pdf: null }))
        },
        onDownload: () => {
          if (!shown || current.current.link !== 'valid') return
          const target = shown
          bytesOf(target.fileId)
            .then((data) => {
              saveBytes(data, fileNameOf(target), target.contentType)
              if (target.contentType === 'application/pdf' && current.current.pdf?.fileId === target.fileId && current.current.pdf.state !== 'ready') {
                setModel((state) => ({ ...state, pdf: { fileId: target.fileId, state: 'ready', data } }))
              }
            })
            .catch((error: unknown) => deadOrFailed(error, target.fileId))
        },
        onRetry: () => void load(),
        onRetryPdf: () => {
          if (shown) readPdf(shown.fileId)
        },
        onAskNewLink: () => {
          if (current.current.ask === 'busy' || current.current.ask === 'done') return
          setModel((state) => ({ ...state, ask: 'busy' }))
          askForNewLink(api)
            .then(() => setModel((state) => ({ ...state, ask: 'done' })))
            .catch(() => setModel((state) => ({ ...state, ask: 'failed' })))
        },
      }}
    />
  )
}
