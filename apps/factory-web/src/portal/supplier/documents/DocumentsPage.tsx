'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { downloadLink } from '../../../record-panels/api'
import { WithMessages } from '../../../record-panels/i18n'
import { putToStore, readFromStore, sha256Hex, StoreError } from '../../../record-panels/store'
import { usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { isTypingTarget } from '../../shell/model'
import { NotInAccessHere, useOffline } from '../orders/parts'
import { announceDocument, completeDocument, fetchSupplierDocuments, type SupplierDocuments } from './api'
import { documentsBandOf } from './band'
import { askItems, docRows, draftTyped, emptyDraft, NS, sendRefusal, uploadBody, uploadHeld, uploadProblems, type AskItem, type DocRow, type PickedFile, type UploadTarget, type Words } from './model'
import { DocumentsView, heldText } from './view/DocumentsView'
import type { UploadDialogModel } from './view/UploadDialog'

/**
 * `/p/<party>/documents` for a supplier or a workshop (B-W2b-193, SCR-190; design portal.supplier.documents): reads GET
 * /portal/supplier-documents (B-W2b-189 / F13a) — "We ask for" and "Your documents" — and reads it again on its live
 * events (our check accepted or refused a document: the state moves and the request leaves "We ask for") and on a
 * reconnect. Uploads in three steps (announce with its Idempotency-Key → the bytes to the store → the confirm), from the
 * band's primary, a "We ask for" row (the request it answers or the record the rule names), Replace (a new version of an
 * accepted document) or Upload again (a refused one). Opens what we shared back in a new tab (tab:file), Download N saves
 * them. Every send is held with its reason: a preview, no connection, no right to upload.
 */
export function SupplierDocumentsRoute() {
  return (
    <WithMessages namespaces={[NS, 'portal', 'portal-account', 'lists', 'ds-words']}>
      <Gate />
    </WithMessages>
  )
}

function Gate() {
  const frame = usePortalFrame()
  const t = useT(NS)
  const opens = (frame.kinds.includes('SUPPLIER') || frame.kinds.includes('SUBCONTRACTOR')) && frame.me.permissions.includes('portal.supplierDocuments.view')
  if (!opens) return <Closed title={t('documents.title')} />
  return <DocumentsContainer />
}

function Closed({ title }: { title: string }) {
  usePortalBand({ title })
  return <NotInAccessHere />
}

type Read = { state: 'loading' | 'error' | 'ready' | 'forbidden'; value: SupplierDocuments | null; at: number | null }
type Dialog = Omit<UploadDialogModel, 'held' | 'today'>

/** Saves bytes as a file on this device (a document the person chose to download). */
function saveBytes(name: string, bytes: Uint8Array, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function DocumentsContainer() {
  const frame = usePortalFrame()
  const { api, me } = frame
  const t = useT(NS)
  const locale = useLocale()
  const offline = useOffline()
  const [read, setRead] = useState<Read>({ state: 'loading', value: null, at: null })
  const [slow, setSlow] = useState(false)
  const [now] = useState(() => Date.now())
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ tone: 'success' | 'warning'; words: Words } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const file = useRef<File | null>(null)
  const keys = useRef<{ announce: string; complete: string } | null>(null)
  const reading = useRef<AbortController | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      const value = await fetchSupplierDocuments(api, control.signal)
      if (control.signal.aborted) return
      setRead({ state: 'ready', value, at: Date.now() })
      setSelected((current) => current.filter((id) => value.documents.some((row) => row.fileId === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setRead((current) => (current.value ? current : { state: isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error', value: null, at: null }))
    }
  }, [api])

  useEffect(() => {
    void load()
    return () => reading.current?.abort()
  }, [load])

  // Our check accepted or refused a document, a request opened or closed: the page reads again (rows move in place).
  usePortalLive({ onChange: (change) => (read.value?.live.events.includes(change.type) ? void load() : undefined), onReconnect: () => void load() })

  const value = read.value
  const facts = { preview: me.preview, offline, mayUpload: value?.mayUpload ?? true }
  const held = uploadHeld(facts)
  const admins = useMemo(() => (frame.access?.admins ?? []).map((admin) => admin.displayName), [frame.access?.admins])
  const asks = useMemo(() => (value ? askItems(value, facts) : []), [value, facts.preview, facts.offline, facts.mayUpload])
  const rows = useMemo(() => (value ? docRows(value) : []), [value])
  const today = value?.today ?? new Date().toISOString().slice(0, 10)

  // ── the upload pop-up ──
  const openUpload = useCallback(
    (target: UploadTarget) => {
      if (held) return
      file.current = null
      keys.current = { announce: newIdempotencyKey(), complete: newIdempotencyKey() }
      const draft = emptyDraft(target.category)
      setProblem(null)
      setDialog({ target, draft, file: null, problems: uploadProblems(draft, null, today), showProblems: false, sending: false, failed: null })
    },
    [held, today],
  )
  const openFor = (item: AskItem | null) => openUpload(item ? item.target : { category: null, for: { key: 'documents.for.Party' } })

  const typed = dialog ? draftTyped(dialog.draft, dialog.file, dialog.target.category) : false
  usePortalUnsaved('supplier-documents-upload', { dirty: typed && !dialog?.sending, what: t('unsaved.upload') })

  const send = async () => {
    const current = dialogRef.current
    const picked = file.current
    if (!current || current.sending || held) return
    const meta: PickedFile | null = picked ? { name: picked.name, size: picked.size, type: picked.type } : null
    const problems = uploadProblems(current.draft, meta, today)
    if (Object.keys(problems).length > 0 || !picked || !meta) return setDialog({ ...current, problems, showProblems: true })
    keys.current ??= { announce: newIdempotencyKey(), complete: newIdempotencyKey() }
    setDialog({ ...current, sending: true, failed: null })
    try {
      const bytes = await picked.arrayBuffer()
      const announced = await announceDocument(api, uploadBody(current.draft, current.target, meta, await sha256Hex(bytes)), keys.current.announce)
      await putToStore(announced.upload, bytes)
      const done = await completeDocument(api, announced.file.id, keys.current.complete)
      keys.current = null
      file.current = null
      setDialog(null)
      setReceipt(done.state === 'HELD' ? { tone: 'warning', words: { key: 'receipt.held', params: { name: meta.name } } } : { tone: 'success', words: { key: 'receipt.sent', params: { name: meta.name } } })
      frame.refreshTasks()
      void load()
    } catch (error) {
      const failed = error instanceof StoreError ? sendRefusal('store') : sendRefusal(isApiError(error) ? error.kind : null, isApiError(error) ? error.issues.map(issuePath) : [])
      // A refusal of what was typed takes a new key; a lost connection keeps it (the retry is the same upload).
      if (isApiError(error) && error.kind !== 'rate_limited') keys.current = null
      setDialog((open) => (open ? { ...open, sending: false, failed } : open))
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found')) void load()
    }
  }

  // ── open and download what we shared back ──
  const openRow = (row: DocRow) => {
    if (!row.shared || busy) return
    if (offline) return setProblem('held.offline')
    // Opened now, while the click allows a new tab; filled when the bytes are here.
    const tab = window.open('', '_blank')
    setProblem(null)
    setBusy(row.id)
    downloadLink(api, row.id)
      .then(({ download }) => readFromStore(download))
      .then((bytes) => {
        const type = row.contentType || 'application/octet-stream'
        if (!tab || tab.closed) return saveBytes(row.name, bytes, type)
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        tab.location.href = url
        // The tab has read it by then; the address is not kept.
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      })
      .catch(() => {
        tab?.close()
        setProblem('documents.openFailed')
      })
      .finally(() => setBusy(null))
  }

  const download = async (picked: readonly DocRow[]) => {
    const shared = picked.filter((row) => row.shared)
    if (shared.length === 0 || busy) return
    if (offline) return setProblem('held.offline')
    setProblem(null)
    let failed = 0
    for (const row of shared) {
      setBusy(row.id)
      try {
        const { download: link } = await downloadLink(api, row.id)
        saveBytes(row.name, await readFromStore(link), row.contentType || 'application/octet-stream')
      } catch {
        failed += 1
      }
    }
    setBusy(null)
    if (failed > 0) setProblem('documents.downloadFailed')
    else if (shared.length > 1) setReceipt({ tone: 'success', words: { key: 'receipt.downloaded', params: { count: shared.length } } })
  }

  // `u` uploads (never while typing, nor with a pop-up open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'u' || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || dialogRef.current) return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      openUpload({ category: null, for: { key: 'documents.for.Party' } })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openUpload])

  const heldWords = heldText(t, held, admins)
  usePortalBand(read.state === 'forbidden' ? { title: t('documents.title') } : documentsBandOf({ t, locale, asOf: read.at, uploadHeld: read.value ? heldWords : t('held.loading'), onUpload: () => openFor(null) }))

  if (read.state === 'forbidden') return <NotInAccessHere />

  return (
    <DocumentsView
      model={{
        state: read.state === 'loading' ? 'loading' : read.state === 'error' ? 'error' : 'ready',
        slow,
        now,
        prefix: frame.prefix,
        kinds: frame.kinds,
        asks,
        rows,
        selected,
        busy,
        held,
        admins,
        receipt,
        problem,
        dialog: dialog ? { ...dialog, held, today } : null,
      }}
      actions={{
        onUpload: openFor,
        onReplace: (row) => row.replace && openUpload(row.replace),
        onAgain: (row) => row.again && openUpload(row.again),
        onOpen: openRow,
        onDownload: (picked) => void download(picked),
        onSelected: setSelected,
        onRetry: () => {
          setRead({ state: 'loading', value: null, at: null })
          void load()
        },
        onHideReceipt: () => setReceipt(null),
        onHideProblem: () => setProblem(null),
        dialog: {
          onField: (field, next) =>
            setDialog((open) => {
              if (!open) return open
              const draft = { ...open.draft, [field]: next }
              return { ...open, draft, problems: uploadProblems(draft, open.file, today), failed: null }
            }),
          onFile: (picked) => {
            file.current = picked
            keys.current = { announce: newIdempotencyKey(), complete: newIdempotencyKey() }
            setDialog((open) => {
              if (!open) return open
              const meta = picked ? { name: picked.name, size: picked.size, type: picked.type } : null
              return { ...open, file: meta, problems: uploadProblems(open.draft, meta, today), failed: null }
            })
          },
          onSend: () => void send(),
          onClose: () => setDialog((open) => (open?.sending ? open : null)),
        },
      }}
    />
  )
}
