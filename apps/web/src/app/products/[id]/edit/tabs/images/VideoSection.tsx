'use client'

// MM.3 — Videos section of the product media hub. Sibling to MasterPanel;
// renders the product's VIDEO media (poster + inline playback + duration),
// uploads via POST /products/:id/videos (MM.2), deletes via the shared image
// DELETE route. These endpoints persist immediately (like the master image
// endpoints), so local state is patched via onVideosChange (no page reload).

import { useRef, useState } from 'react'
import { Plus, Trash2, Play, Loader2, Film } from 'lucide-react'
import { beFetch } from './api'
import type { ProductImage } from './types'

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return ''
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideoSection({
  productId,
  videos,
  onVideosChange,
  onToast,
}: {
  productId: string
  videos: ProductImage[]
  onVideosChange: (next: ProductImage[]) => void
  onToast?: (msg: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      const added: ProductImage[] = []
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await beFetch(`/api/products/${productId}/videos`, { method: 'POST', body: fd })
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b?.error ?? `Upload failed: ${res.status}`)
        }
        added.push((await res.json()) as ProductImage)
      }
      if (added.length) {
        onVideosChange([...videos, ...added])
        onToast?.(`${added.length} video${added.length === 1 ? '' : 's'} uploaded`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      onVideosChange(videos.filter((v) => v.id !== id))
      if (playingId === id) setPlayingId(null)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Videos {videos.length > 0 && <span className="text-slate-400 font-normal">({videos.length})</span>}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Upload video
        </button>
        <input ref={inputRef} type="file" accept="video/*" multiple className="sr-only" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {error && <div className="mb-2 text-xs text-rose-600 dark:text-rose-400">{error}</div>}

      {videos.length === 0 ? (
        <div
          onClick={() => inputRef.current?.click()}
          className="rounded-xl border-2 border-dashed border-slate-200 dark:border-slate-700 py-8 flex flex-col items-center justify-center gap-1.5 text-slate-400 cursor-pointer hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
        >
          <Film className="w-6 h-6" />
          <span className="text-xs">No videos yet — upload a product video (MP4, MOV, WebM)</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {videos.map((v) => (
            <div key={v.id} className="group relative rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-50 dark:bg-slate-800/40">
              <div className="relative aspect-square">
                {playingId === v.id ? (
                  <video src={v.url} poster={v.posterUrl ?? undefined} controls autoPlay className="w-full h-full object-contain bg-black" />
                ) : (
                  <button type="button" onClick={() => setPlayingId(v.id)} className="w-full h-full flex items-center justify-center">
                    {v.posterUrl ? (
                      <img src={v.posterUrl} alt={v.alt ?? 'video'} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-400">
                        <Film className="w-8 h-8" />
                      </div>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="rounded-full bg-black/55 p-2.5 text-white">
                        <Play className="w-5 h-5" />
                      </span>
                    </span>
                  </button>
                )}
                {fmtDuration(v.durationSec) && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-mono text-white">
                    {fmtDuration(v.durationSec)}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                <span className="truncate text-[11px] text-slate-500 dark:text-slate-400" title={v.alt ?? ''}>
                  {v.alt ?? 'video'}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(v.id)}
                  disabled={deletingId === v.id}
                  title="Delete video"
                  className="flex-shrink-0 text-slate-400 hover:text-rose-600 disabled:opacity-50"
                >
                  {deletingId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
