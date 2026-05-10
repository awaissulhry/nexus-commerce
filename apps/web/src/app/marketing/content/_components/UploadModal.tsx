'use client'

// MC.3.1 — upload modal.
//
// Three input paths:
//   1. Drop zone — drag files in (filtered by image/* mime types).
//   2. File picker — same flow via <input type=file multiple>.
//   3. URL paste — paste a public URL; server fetches + uploads.
//
// All three feed the same per-file queue. Files post sequentially
// (not parallel) to keep the multipart server pressure predictable
// — Cloudinary recommends ≤4 concurrent uploads per credential and
// our queue is the simpler ceiling. MC.3.5 swaps in concurrent
// uploads with progress + retry.

import { useEffect, useRef, useState, type DragEvent } from 'react'
import {
  UploadCloud,
  Link as LinkIcon,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileImage,
  Paperclip,
  RefreshCw,
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import { xhrUpload } from '../_lib/xhr-upload'

// MC.3.5 — concurrent uploads. Cloudinary recommends ≤4 streams per
// credential; we go conservative at 3 so the operator's other API
// traffic isn't starved during a big batch.
const CONCURRENCY = 3
// MC.3.5 — auto-retry budget. Network blips on a single file
// shouldn't fail the whole batch — give each item up to two retries
// with exponential backoff before surfacing as a hard failure that
// needs operator attention.
const MAX_AUTO_RETRIES = 2

type QueueItemStatus = 'queued' | 'uploading' | 'done' | 'duplicate' | 'error'

interface QueueItem {
  id: string
  // MC.3.2 — 'zip' source posts the whole archive to /upload-zip;
  // server unpacks + creates folders + uploads each file.
  source: 'file' | 'url' | 'zip'
  filename: string
  size: number | null
  status: QueueItemStatus
  error?: string
  // MC.3.2 — populated for ZIP uploads; rendered as a per-archive
  // summary line under the row when the upload completes.
  zipSummary?: {
    total: number
    uploaded: number
    deduped: number
    skipped: number
    errors: number
  }
  // MC.3.3 — when status is 'duplicate', captures whether the
  // server also re-filed the existing asset into a new folder.
  refiled?: boolean
  // MC.3.5 — upload progress (0–100). Only populated for source=file
  // since URL imports are server-side fetch + upload, no client byte
  // stream to measure.
  progress?: number
  // MC.3.5 — auto-retry counter. Visible in the row so the operator
  // sees that the network was flaky, not their connection.
  retries?: number
  // For file uploads only
  file?: File
  // For URL uploads only
  url?: string
}

const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
])

// MC.3.2 — ZIP uploads go through their own endpoint. Some browsers
// report ZIPs as application/x-zip-compressed; the .zip extension is
// the canonical fallback.
function isZipFile(file: File): boolean {
  return (
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip')
  )
}

const MAX_BYTES = 25 * 1024 * 1024

interface Props {
  open: boolean
  onClose: () => void
  apiBase: string
  folderId?: string | null
  onComplete: () => void
}

function nextId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export default function UploadModal({
  open,
  onClose,
  apiBase,
  folderId,
  onComplete,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [busy, setBusy] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset on close so stale "done" rows don't linger when the modal
  // reopens for a fresh batch.
  useEffect(() => {
    if (!open) {
      setQueue([])
      setUrlInput('')
      setDragOver(false)
    }
  }, [open])

  // Paste-to-upload (Ctrl+V). Only active while the modal is open.
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const addFiles = (files: File[]) => {
    const additions: QueueItem[] = []
    for (const file of files) {
      // MC.3.2 — recognise ZIP archives and queue them as a single
      // 'zip' item. The whole archive posts to /upload-zip server-
      // side; we don't unpack on the client because JSZip-in-browser
      // would double the memory pressure and the server already
      // does it well.
      if (isZipFile(file)) {
        additions.push({
          id: nextId(),
          source: 'zip',
          filename: file.name,
          size: file.size,
          status: 'queued',
          file,
        })
        continue
      }
      if (!ACCEPTED_MIME.has(file.type)) {
        toast({
          title: t('marketingContent.upload.rejectedMime', {
            filename: file.name,
            mime: file.type || 'unknown',
          }),
          tone: 'warning',
        })
        continue
      }
      if (file.size > MAX_BYTES) {
        toast({
          title: t('marketingContent.upload.rejectedSize', {
            filename: file.name,
          }),
          tone: 'warning',
        })
        continue
      }
      additions.push({
        id: nextId(),
        source: 'file',
        filename: file.name,
        size: file.size,
        status: 'queued',
        file,
      })
    }
    if (additions.length) setQueue((prev) => [...prev, ...additions])
  }

  const addUrl = () => {
    const url = urlInput.trim()
    if (!url) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        toast.error(t('marketingContent.upload.urlInvalid'))
        return
      }
    } catch {
      toast.error(t('marketingContent.upload.urlInvalid'))
      return
    }
    const filename = url.split('/').pop() || 'remote-import'
    setQueue((prev) => [
      ...prev,
      {
        id: nextId(),
        source: 'url',
        filename,
        size: null,
        status: 'queued',
        url,
      },
    ])
    setUrlInput('')
  }

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const files = [...(e.dataTransfer.files ?? [])]
    if (files.length) addFiles(files)
  }

  // MC.3.5 — single-item upload via XHR (file) or fetch (URL).
  // Reports progress through the supplied setter. Resolves to the
  // updated QueueItem so the queue can be patched once at the end
  // of each attempt.
  const uploadOne = async (
    item: QueueItem,
    onProgress: (pct: number) => void,
  ): Promise<QueueItem> => {
    try {
      let body: { asset: unknown; dedup?: boolean; refiled?: boolean }
      if (item.source === 'file' && item.file) {
        const fd = new FormData()
        fd.append('file', item.file, item.filename)
        if (folderId) fd.append('folderId', folderId)
        const res = await xhrUpload({
          url: `${apiBase}/api/assets/upload`,
          body: fd,
          onProgress,
        })
        if (!res.ok) {
          const err = (res.body ?? {}) as { error?: string }
          throw new Error(err.error ?? `Upload failed (${res.status})`)
        }
        body = res.body as typeof body
      } else if (item.source === 'url' && item.url) {
        // URL imports run server-side; client progress is a 0→100
        // jump bracketing the request lifetime.
        onProgress(10)
        const res = await fetch(`${apiBase}/api/assets/upload-url`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: item.url, folderId }),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(err.error ?? `Import failed (${res.status})`)
        }
        body = (await res.json()) as typeof body
        onProgress(100)
      } else if (item.source === 'zip' && item.file) {
        // MC.3.2 — single archive POST, server unpacks. Returns a
        // summary instead of a single asset.
        const fd = new FormData()
        fd.append('file', item.file, item.filename)
        if (folderId) fd.append('rootFolderId', folderId)
        const res = await xhrUpload({
          url: `${apiBase}/api/assets/upload-zip`,
          body: fd,
          onProgress,
        })
        if (!res.ok) {
          const err = (res.body ?? {}) as { error?: string }
          throw new Error(err.error ?? `ZIP upload failed (${res.status})`)
        }
        const zipBody = res.body as {
          summary: {
            total: number
            uploaded: number
            deduped: number
            skipped: number
            errors: Array<{ path: string; error: string }>
          }
        }
        return {
          ...item,
          status: 'done',
          progress: 100,
          zipSummary: {
            total: zipBody.summary.total,
            uploaded: zipBody.summary.uploaded,
            deduped: zipBody.summary.deduped,
            skipped: zipBody.summary.skipped,
            errors: zipBody.summary.errors.length,
          },
        }
      } else {
        throw new Error('Invalid queue item')
      }
      return {
        ...item,
        status: body.dedup ? 'duplicate' : 'done',
        refiled: body.refiled,
        progress: 100,
      }
    } catch (err) {
      return {
        ...item,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }

  // MC.3.5 — single-attempt runner with auto-retry on transient
  // failures. The first MAX_AUTO_RETRIES attempts wait 500ms, 1500ms;
  // anything beyond that is operator-driven via the per-row Retry
  // button.
  const runWithRetry = async (
    initialItem: QueueItem,
    onProgress: (pct: number) => void,
  ): Promise<QueueItem> => {
    let attempt = 0
    let item = initialItem
    while (true) {
      const result = await uploadOne(item, onProgress)
      if (result.status !== 'error') return result
      // Retry only network/transient signals — skip 4xx-style
      // semantic failures that won't get better on retry.
      const transient =
        /network error|timed out|aborted|502|503|504/i.test(
          result.error ?? '',
        )
      if (!transient || attempt >= MAX_AUTO_RETRIES) return result
      attempt += 1
      const wait = 500 * Math.pow(3, attempt - 1)
      await new Promise((r) => setTimeout(r, wait))
      item = { ...item, retries: attempt, progress: 0 }
      // Mirror retry counter into the queue so the row shows it.
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? { ...q, retries: attempt, progress: 0, status: 'uploading' }
            : q,
        ),
      )
    }
  }

  // MC.3.5 — concurrent batch runner. Pulls items off `pending` in
  // parallel up to CONCURRENCY workers; each worker grabs the next
  // queued item, runs it (with auto-retry), records the result,
  // loops until empty.
  const startUpload = async () => {
    const pending = queue.filter((q) => q.status === 'queued')
    if (pending.length === 0) return
    setBusy(true)
    let successes = 0
    let duplicates = 0
    let failures = 0
    const cursor = { i: 0 }

    const worker = async () => {
      while (cursor.i < pending.length) {
        const item = pending[cursor.i++]!
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? { ...q, status: 'uploading', progress: 0 }
              : q,
          ),
        )
        const updated = await runWithRetry(item, (pct) =>
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id ? { ...q, progress: pct } : q,
            ),
          ),
        )
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? updated : q)),
        )
        if (updated.status === 'done') successes++
        else if (updated.status === 'duplicate') duplicates++
        else failures++
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker())
    await Promise.all(workers)

    setBusy(false)
    if (successes > 0) {
      toast.success(
        t('marketingContent.upload.successCount', {
          n: successes.toString(),
        }),
      )
    }
    if (duplicates > 0) {
      toast({
        title: t('marketingContent.upload.duplicateCount', {
          n: duplicates.toString(),
        }),
        description: t('marketingContent.upload.duplicateBody'),
        tone: 'info',
      })
    }
    if (successes + duplicates > 0) onComplete()
    if (failures > 0) {
      toast.error(
        t('marketingContent.upload.failureCount', {
          n: failures.toString(),
        }),
      )
    }
  }

  // MC.3.5 — operator-driven retry for a single failed row. Resets
  // status + retries counter and runs the same path as the batch.
  const retryOne = async (id: string) => {
    const item = queue.find((q) => q.id === id)
    if (!item || item.status !== 'error') return
    setBusy(true)
    setQueue((prev) =>
      prev.map((q) =>
        q.id === id
          ? {
              ...q,
              status: 'uploading',
              progress: 0,
              retries: 0,
              error: undefined,
            }
          : q,
      ),
    )
    const updated = await runWithRetry(
      { ...item, retries: 0, error: undefined },
      (pct) =>
        setQueue((prev) =>
          prev.map((q) => (q.id === id ? { ...q, progress: pct } : q)),
        ),
    )
    setQueue((prev) => prev.map((q) => (q.id === id ? updated : q)))
    setBusy(false)
    if (updated.status === 'done') {
      toast.success(
        t('marketingContent.upload.successCount', { n: '1' }),
      )
      onComplete()
    } else if (updated.status === 'duplicate') {
      toast({
        title: t('marketingContent.upload.duplicateCount', { n: '1' }),
        description: t('marketingContent.upload.duplicateBody'),
        tone: 'info',
      })
      onComplete()
    } else {
      toast.error(
        updated.error ?? t('marketingContent.upload.failureCount', { n: '1' }),
      )
    }
  }

  const queuedCount = queue.filter((q) => q.status === 'queued').length
  const inFlight = queue.some((q) => q.status === 'uploading')

  return (
    <Modal
      open={open}
      onClose={() => {
        if (inFlight) return
        onClose()
      }}
      title={t('marketingContent.upload.title')}
      size="2xl"
    >
      <ModalBody>
        <div className="space-y-3">
          {/* Drop zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 text-center transition-colors ${
              dragOver
                ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40'
                : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50'
            }`}
          >
            <UploadCloud className="w-8 h-8 text-slate-400" />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {t('marketingContent.upload.dropPrompt')}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
              {t('marketingContent.upload.dropSubtext')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="w-4 h-4 mr-1" />
              {t('marketingContent.upload.choose')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={[...ACCEPTED_MIME, 'application/zip', '.zip'].join(',')}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])]
                if (files.length) addFiles(files)
                e.target.value = '' // reset for re-pick
              }}
            />
          </div>

          {/* URL paste */}
          <div className="flex items-center gap-2">
            <LinkIcon className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addUrl()
                }
              }}
              placeholder={t('marketingContent.upload.urlPlaceholder')}
              className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={addUrl}
              disabled={!urlInput.trim()}
            >
              {t('marketingContent.upload.addUrl')}
            </Button>
          </div>

          {/* Queue */}
          {queue.length > 0 && (
            <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700">
              <ul className="max-h-72 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
                {queue.map((item) => (
                  <li
                    key={item.id}
                    className="px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {item.status === 'done' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      ) : item.status === 'duplicate' ? (
                        <CheckCircle2 className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      ) : item.status === 'error' ? (
                        <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      ) : item.status === 'uploading' ? (
                        <Loader2 className="w-4 h-4 animate-spin text-blue-500 flex-shrink-0" />
                      ) : (
                        <FileImage className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="truncate text-sm text-slate-900 dark:text-slate-100">
                          {item.filename}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {item.status === 'duplicate' ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              {item.refiled
                                ? t('marketingContent.upload.duplicateRefiled')
                                : t('marketingContent.upload.duplicateRow')}
                            </span>
                          ) : item.status === 'uploading' &&
                            typeof item.progress === 'number' ? (
                            <span>
                              {item.progress}%
                              {item.retries
                                ? ` · ${t('marketingContent.upload.retryAttempt', {
                                    n: item.retries.toString(),
                                  })}`
                                : ''}
                            </span>
                          ) : item.source === 'url' ? (
                            item.url
                          ) : null}
                          {item.error ? (
                            <span className="text-red-600 dark:text-red-400">
                              {item.error}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      {item.status === 'queued' && !busy && (
                        <button
                          type="button"
                          onClick={() => removeFromQueue(item.id)}
                          aria-label={t(
                            'marketingContent.upload.removeQueueItem',
                          )}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {item.status === 'error' && !busy && (
                        <button
                          type="button"
                          onClick={() => void retryOne(item.id)}
                          aria-label={t('marketingContent.upload.retry')}
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-blue-600 dark:hover:bg-slate-800 dark:hover:text-blue-400"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {item.status === 'uploading' && (
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className="h-full bg-blue-500 transition-[width] duration-150 ease-out"
                          style={{ width: `${item.progress ?? 0}%` }}
                        />
                      </div>
                    )}
                    {item.zipSummary && (
                      <p className="mt-1 ml-6 text-xs text-slate-600 dark:text-slate-400">
                        {t('marketingContent.upload.zipSummary', {
                          uploaded: item.zipSummary.uploaded.toString(),
                          deduped: item.zipSummary.deduped.toString(),
                          skipped: item.zipSummary.skipped.toString(),
                          errors: item.zipSummary.errors.toString(),
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={inFlight}
        >
          {busy ? t('common.close') : t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          onClick={startUpload}
          disabled={queuedCount === 0 || busy}
        >
          {busy ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-1" />
              {t('marketingContent.upload.uploading')}
            </>
          ) : (
            <>
              <UploadCloud className="w-4 h-4 mr-1" />
              {t('marketingContent.upload.start', {
                n: queuedCount.toString(),
              })}
            </>
          )}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
