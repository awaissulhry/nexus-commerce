'use client'

// IM.4 — Shared image picker modal.
// Shows master images + upload-new. Used by Amazon, eBay, Shopify panels.

import { useRef, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import type { ProductImage } from './types'

interface Props {
  productId: string
  masterImages: ProductImage[]
  onSelect: (url: string, sourceId?: string) => void
  onClose: () => void
}

export default function ImagePickerModal({ productId, masterImages, onSelect, onClose }: Props) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleUpload(files: File[]) {
    if (!files.length) return
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      fd.append('file', files[0])
      const res = await fetch(`/api/products/${productId}/images?type=ALT`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
      const created: ProductImage = await res.json()
      onSelect(created.url, created.id)
      onClose()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Select image</h2>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* Master image grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {masterImages.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              No master images yet — upload one below.
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-3">
              {masterImages.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => { onSelect(img.url, img.id); onClose() }}
                  className="group aspect-square rounded-xl border-2 border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500 overflow-hidden bg-slate-50 dark:bg-slate-800 transition-all focus:outline-none focus:ring-2 focus:ring-blue-400"
                  title={img.alt ?? img.type}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.alt ?? img.type}
                    className="w-full h-full object-contain group-hover:scale-105 transition-transform"
                  />
                </button>
              ))}
            </div>
          )}

          {uploadError && (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">{uploadError}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex-shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="gap-1.5"
          >
            {uploading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Upload className="w-3.5 h-3.5" />}
            Upload new image
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => handleUpload(Array.from(e.target.files ?? []))}
          />
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
