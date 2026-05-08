'use client'

/**
 * P.1m — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. F5 was the original feature.
 *
 * Drag-drop a folder of product photos. Each filename is matched to
 * its SKU.
 *
 * Phases: drop → preview → uploading → done
 *
 * Drop: dropzone accepts files OR a folder (webkitdirectory). On
 *   drop we call POST /api/products/images/resolve with the
 *   filenames only — no bytes — to get the per-file match preview
 *   cheap.
 * Preview: each file shows matched SKU + slot OR an "unmatched"
 *   row. The user can untick rows they don't want, or rename the
 *   SKU inline for an unmatched file.
 * Uploading: per-file POST /api/products/images/upload with
 *   concurrency 4. Progress bar + per-file status. One failure
 *   doesn't stop the batch.
 * Done: counts + emit product.updated invalidations so the grid
 *   and any open drawer refresh.
 *
 * No client-side image compression today — Cloudinary handles
 * resizing + format conversion at delivery time. Keeps the upload
 * code simple; a 10 MB DSLR JPEG goes through fine under the 50 MB
 * multipart limit.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface ResolutionPreview {
  filename: string
  ok: boolean
  sku?: string
  productId?: string
  type?: 'MAIN' | 'ALT' | 'LIFESTYLE'
  position?: number | null
  reason?: string
}

interface QueuedFile {
  file: File
  filename: string
  preview: ResolutionPreview
  /** User overrides — defaults from preview, editable inline. */
  selected: boolean
  overrideSku: string | null
  status: 'pending' | 'uploading' | 'success' | 'failed' | 'skipped'
  error?: string
  uploadedUrl?: string
}

const UPLOAD_CONCURRENCY = 4

interface BulkImageUploadModalProps {
  onClose: () => void
  onComplete: () => void
}

export default function BulkImageUploadModal({
  onClose,
  onComplete,
}: BulkImageUploadModalProps) {
  const [phase, setPhase] = useState<
    'drop' | 'preview' | 'uploading' | 'done'
  >('drop')
  const [queue, setQueue] = useState<QueuedFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // U.22 — a11y. Esc dismisses (matching every other modal in the
  // app); active phase 'uploading' blocks the dismiss so a half-fired
  // batch isn't abandoned mid-flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'uploading') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const acceptedImages = (files: File[]) =>
    files.filter((f) => /\.(jpe?g|png|webp|gif|tiff?|avif)$/i.test(f.name))

  const handleFiles = async (raw: File[]) => {
    setError(null)
    const files = acceptedImages(raw)
    if (files.length === 0) {
      setError(
        'No image files in drop (.jpg, .png, .webp, .gif, .tiff, .avif)',
      )
      return
    }
    if (files.length > 1000) {
      setError(`Too many files (${files.length}); max 1000 per batch`)
      return
    }
    setResolving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/images/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: files.map((f) => f.name) }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { resolutions: ResolutionPreview[] }
      const previewByFilename = new Map<string, ResolutionPreview>()
      for (const r of json.resolutions) previewByFilename.set(r.filename, r)
      const next: QueuedFile[] = files.map((file) => {
        const preview = previewByFilename.get(file.name) ?? {
          filename: file.name,
          ok: false,
          reason: 'no resolver result',
        }
        return {
          file,
          filename: file.name,
          preview,
          selected: preview.ok,
          overrideSku: null,
          status: 'pending',
        }
      })
      setQueue(next)
      setPhase('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setResolving(false)
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // DataTransferItems is the only API that walks dropped folders;
    // .files is flat.
    const items = e.dataTransfer.items
    if (
      items &&
      items.length > 0 &&
      typeof items[0].webkitGetAsEntry === 'function'
    ) {
      const entries: FileSystemEntry[] = []
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry()
        if (entry) entries.push(entry)
      }
      const files = await readEntriesRecursive(entries)
      if (files.length > 0) {
        await handleFiles(files)
        return
      }
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFiles(Array.from(e.dataTransfer.files))
    }
  }

  const upload = async () => {
    const eligible = queue.filter(
      (q) => q.selected && (q.preview.ok || q.overrideSku),
    )
    if (eligible.length === 0) {
      setError('Select at least one matched file to upload.')
      return
    }
    setError(null)
    setPhase('uploading')
    // Mark non-eligible as skipped up-front so the done screen totals
    // line up with what the user saw.
    setQueue((prev) =>
      prev.map((q) =>
        eligible.includes(q) ? q : { ...q, status: 'skipped' },
      ),
    )

    // Worker pool — keep up to UPLOAD_CONCURRENCY POSTs in flight.
    let cursor = 0
    const total = eligible.length
    const succeeded: string[] = []
    const runOne = async () => {
      while (true) {
        const idx = cursor
        cursor += 1
        if (idx >= total) return
        const item = eligible[idx]
        setQueue((prev) =>
          prev.map((q) =>
            q.file === item.file ? { ...q, status: 'uploading' } : q,
          ),
        )
        try {
          const fd = new FormData()
          fd.append('file', item.file, item.filename)
          const sku = item.overrideSku ?? item.preview.sku
          const url = sku
            ? `${getBackendUrl()}/api/products/images/upload?sku=${encodeURIComponent(sku)}`
            : `${getBackendUrl()}/api/products/images/upload`
          const res = await fetch(url, { method: 'POST', body: fd })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error ?? `HTTP ${res.status}`)
          }
          const json = await res.json()
          if (json.productId) succeeded.push(json.productId)
          setQueue((prev) =>
            prev.map((q) =>
              q.file === item.file
                ? { ...q, status: 'success', uploadedUrl: json.url }
                : q,
            ),
          )
        } catch (e) {
          setQueue((prev) =>
            prev.map((q) =>
              q.file === item.file
                ? {
                    ...q,
                    status: 'failed',
                    error: e instanceof Error ? e.message : String(e),
                  }
                : q,
            ),
          )
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, () =>
        runOne(),
      ),
    )

    // Phase 10 — broadcast so /products grid + drawer refresh inline.
    if (succeeded.length > 0) {
      emitInvalidation({
        type: 'product.updated',
        meta: {
          productIds: Array.from(new Set(succeeded)),
          source: 'bulk-image-upload',
        },
      })
    }
    setPhase('done')
  }

  const counts = useMemo(() => {
    const matched = queue.filter((q) => q.preview.ok || q.overrideSku).length
    const unmatched = queue.length - matched
    const selected = queue.filter(
      (q) => q.selected && (q.preview.ok || q.overrideSku),
    ).length
    const succeeded = queue.filter((q) => q.status === 'success').length
    const failed = queue.filter((q) => q.status === 'failed').length
    const skipped = queue.filter((q) => q.status === 'skipped').length
    const inFlight = queue.filter((q) => q.status === 'uploading').length
    return { matched, unmatched, selected, succeeded, failed, skipped, inFlight }
  }, [queue])

  const setOverrideSku = (file: File, sku: string) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.file === file
          ? { ...q, overrideSku: sku || null, selected: true }
          : q,
      ),
    )
  }

  const toggleSelect = (file: File) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.file === file ? { ...q, selected: !q.selected } : q,
      ),
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-image-upload-title"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={() => {
        if (phase !== 'uploading') onClose()
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div>
            <div
              id="bulk-image-upload-title"
              className="text-lg font-semibold text-slate-900"
            >
              Upload product photos
            </div>
            <div className="text-sm text-slate-500">
              We match each file to its SKU by filename. Add{' '}
              <span className="font-mono">-1</span>,{' '}
              <span className="font-mono">-2</span>,{' '}
              <span className="font-mono">-MAIN</span>, or{' '}
              <span className="font-mono">-LIFESTYLE</span> for slot control.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === 'drop' && (
          <div className="p-5 space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onDrop={onDrop}
              className="border-2 border-dashed border-slate-300 rounded-lg p-10 text-center text-base text-slate-600 hover:border-purple-300 hover:bg-purple-50/40 transition-colors"
            >
              {resolving ? (
                <div className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                  Resolving SKUs…
                </div>
              ) : (
                <>
                  <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                  <div className="text-slate-700 font-medium mb-1">
                    Drop a folder or files here
                  </div>
                  <div className="text-sm text-slate-500">
                    or pick from disk
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-7 px-3 text-sm border border-slate-200 rounded hover:bg-white"
                    >
                      Choose files
                    </button>
                    <button
                      type="button"
                      onClick={() => folderInputRef.current?.click()}
                      className="h-7 px-3 text-sm border border-slate-200 rounded hover:bg-white"
                    >
                      Choose folder
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(e) =>
                      e.target.files &&
                      handleFiles(Array.from(e.target.files))
                    }
                  />
                  {/* webkitdirectory is non-standard but supported in
                      Chrome / Edge / Safari / Firefox modern. */}
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    /* eslint-disable @typescript-eslint/no-explicit-any */
                    {...({
                      webkitdirectory: '',
                      directory: '',
                    } as any)}
                    /* eslint-enable @typescript-eslint/no-explicit-any */
                    className="hidden"
                    onChange={(e) =>
                      e.target.files &&
                      handleFiles(Array.from(e.target.files))
                    }
                  />
                </>
              )}
            </div>
            {error && (
              <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="text-sm text-slate-500 pt-1 border-t border-slate-100">
              <div className="font-medium mb-1">Filename conventions</div>
              <ul className="space-y-0.5 list-disc pl-4">
                <li>
                  <span className="font-mono">XV-G-RACE-PRO-BLK-M.jpg</span>{' '}
                  → product&apos;s ALT image
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-1.jpg
                  </span>{' '}
                  → MAIN (first position)
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-MAIN.jpg
                  </span>{' '}
                  → MAIN
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-LIFESTYLE-2.jpg
                  </span>{' '}
                  → LIFESTYLE
                </li>
              </ul>
            </div>
          </div>
        )}

        {(phase === 'preview' || phase === 'uploading') && (
          <>
            <div className="px-5 py-2 border-b border-slate-100 flex items-center justify-between gap-3 flex-shrink-0 text-base text-slate-700">
              <div>
                {counts.matched} matched
                {counts.unmatched > 0 && (
                  <>
                    ,{' '}
                    <span className="text-rose-700">
                      {counts.unmatched} unmatched
                    </span>
                  </>
                )}
                {phase === 'uploading' && (
                  <>
                    {' · '}
                    <span className="text-purple-700">
                      {counts.succeeded}/{counts.selected} done
                    </span>
                    {counts.failed > 0 && (
                      <span className="text-rose-700">
                        , {counts.failed} failed
                      </span>
                    )}
                  </>
                )}
              </div>
              {phase === 'preview' && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((prev) =>
                        prev.map((q) => ({
                          ...q,
                          selected: q.preview.ok || !!q.overrideSku,
                        })),
                      )
                    }
                    className="h-7 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded-md"
                  >
                    Select matched
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((prev) =>
                        prev.map((q) => ({ ...q, selected: false })),
                      )
                    }
                    className="h-7 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded-md"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-1.5">
              {queue.map((q) => {
                const matched = q.preview.ok || !!q.overrideSku
                const sku = q.overrideSku ?? q.preview.sku
                return (
                  <div
                    key={q.filename}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-base border ${
                      q.status === 'success'
                        ? 'bg-emerald-50 border-emerald-200'
                        : q.status === 'failed'
                          ? 'bg-rose-50 border-rose-200'
                          : q.status === 'uploading'
                            ? 'bg-purple-50 border-purple-200'
                            : matched
                              ? 'bg-white border-slate-200'
                              : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    {phase === 'preview' && (
                      <input
                        type="checkbox"
                        checked={q.selected && matched}
                        disabled={!matched}
                        onChange={() => toggleSelect(q.file)}
                      />
                    )}
                    {phase === 'uploading' && (
                      <span className="w-4 h-4 inline-flex items-center justify-center">
                        {q.status === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        ) : q.status === 'failed' ? (
                          <XCircle className="w-4 h-4 text-rose-600" />
                        ) : q.status === 'uploading' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-600" />
                        ) : q.status === 'skipped' ? (
                          <span className="text-slate-400 text-xs">—</span>
                        ) : (
                          <span className="text-slate-300 text-xs">·</span>
                        )}
                      </span>
                    )}
                    <span className="font-mono text-sm text-slate-700 min-w-0 flex-1 truncate">
                      {q.filename}
                    </span>
                    {matched ? (
                      <>
                        <span className="text-slate-400 text-xs">→</span>
                        <span className="text-slate-900 font-medium">
                          {sku}
                        </span>
                        <span className="text-xs text-slate-500 uppercase tracking-wider">
                          {q.preview.type ?? 'ALT'}
                          {q.preview.position
                            ? ` · #${q.preview.position}`
                            : ''}
                        </span>
                      </>
                    ) : (
                      phase === 'preview' && (
                        <input
                          type="text"
                          placeholder="enter SKU"
                          value={q.overrideSku ?? ''}
                          onChange={(e) =>
                            setOverrideSku(q.file, e.target.value.trim())
                          }
                          className="h-6 px-1.5 text-sm border border-amber-300 rounded bg-white w-32 font-mono"
                        />
                      )
                    )}
                    {q.status === 'failed' && (
                      <span
                        className="text-xs text-rose-700 truncate max-w-[200px]"
                        title={q.error}
                      >
                        {q.error}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {error && (
              <div className="mx-5 mb-3 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2 flex-shrink-0">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {phase === 'preview' && (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setQueue([])
                    setError(null)
                    setPhase('drop')
                  }}
                  className="h-8 px-3 text-base text-slate-700 hover:bg-slate-100 rounded-md"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={upload}
                  disabled={counts.selected === 0}
                  className="h-8 px-3 text-base bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                >
                  <Upload className="w-3 h-3" />
                  Upload {counts.selected} photo
                  {counts.selected === 1 ? '' : 's'}
                </button>
              </div>
            )}

            {phase === 'uploading' && (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-shrink-0 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                <span className="flex-1 text-slate-700">
                  Uploading {counts.inFlight} in flight ·{' '}
                  {counts.succeeded + counts.failed}/{counts.selected} complete
                </span>
              </div>
            )}
          </>
        )}

        {phase === 'done' && (
          <div className="p-5 space-y-3">
            <div className="text-base text-slate-700">
              <span className="text-emerald-700 font-medium">
                {counts.succeeded} uploaded
              </span>
              {counts.failed > 0 && (
                <span className="text-rose-700">, {counts.failed} failed</span>
              )}
              {counts.skipped > 0 && (
                <span className="text-slate-500">
                  {' '}· {counts.skipped} skipped
                </span>
              )}
              .
            </div>
            {counts.failed > 0 && (
              <ul className="border border-rose-200 bg-rose-50 rounded-md p-2 max-h-48 overflow-y-auto text-sm text-rose-800 space-y-1">
                {queue
                  .filter((q) => q.status === 'failed')
                  .map((q) => (
                    <li key={q.filename}>
                      <span className="font-mono">{q.filename}</span> —{' '}
                      {q.error}
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setQueue([])
                  setError(null)
                  setPhase('drop')
                }}
                className="h-8 px-3 text-base text-slate-700 hover:bg-slate-100 rounded-md"
              >
                Upload more
              </button>
              <button
                type="button"
                onClick={onComplete}
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Walk a list of FileSystemEntry (the result of webkitGetAsEntry on
 * each DataTransferItem) and flatten into a File array. Subdirectories
 * are descended recursively.
 */
async function readEntriesRecursive(
  entries: FileSystemEntry[],
): Promise<File[]> {
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      out.push(file)
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries returns batches; loop until empty.
      while (true) {
        const batch: FileSystemEntry[] = await new Promise(
          (resolve, reject) => reader.readEntries(resolve, reject),
        )
        if (batch.length === 0) break
        for (const child of batch) await walk(child)
      }
    }
  }
  for (const entry of entries) await walk(entry)
  return out
}
