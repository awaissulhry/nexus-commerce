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
} from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'

type QueueItemStatus = 'queued' | 'uploading' | 'done' | 'error'

interface QueueItem {
  id: string
  source: 'file' | 'url'
  filename: string
  size: number | null
  status: QueueItemStatus
  error?: string
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

  const uploadOne = async (item: QueueItem): Promise<QueueItem> => {
    try {
      if (item.source === 'file' && item.file) {
        const fd = new FormData()
        fd.append('file', item.file, item.filename)
        if (folderId) fd.append('folderId', folderId)
        const res = await fetch(`${apiBase}/api/assets/upload`, {
          method: 'POST',
          body: fd,
        })
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(errBody.error ?? `Upload failed (${res.status})`)
        }
      } else if (item.source === 'url' && item.url) {
        const res = await fetch(`${apiBase}/api/assets/upload-url`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: item.url, folderId }),
        })
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(errBody.error ?? `Import failed (${res.status})`)
        }
      } else {
        throw new Error('Invalid queue item')
      }
      return { ...item, status: 'done' }
    } catch (err) {
      return {
        ...item,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }

  const startUpload = async () => {
    const pending = queue.filter((q) => q.status === 'queued')
    if (pending.length === 0) return
    setBusy(true)
    let successes = 0
    let failures = 0
    for (const item of pending) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id ? { ...q, status: 'uploading' } : q,
        ),
      )
      const updated = await uploadOne(item)
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? updated : q)),
      )
      if (updated.status === 'done') successes++
      else failures++
    }
    setBusy(false)
    if (successes > 0) {
      toast.success(
        t('marketingContent.upload.successCount', {
          n: successes.toString(),
        }),
      )
      onComplete()
    }
    if (failures > 0) {
      toast.error(
        t('marketingContent.upload.failureCount', {
          n: failures.toString(),
        }),
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
              accept={[...ACCEPTED_MIME].join(',')}
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
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    {item.status === 'done' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
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
                        {item.source === 'url' ? item.url : null}
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
                        aria-label={t('marketingContent.upload.removeQueueItem')}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
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
