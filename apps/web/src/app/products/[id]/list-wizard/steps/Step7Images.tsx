'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Crown,
  Loader2,
  ChevronUp,
  ChevronDown,
  ImageOff,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface ApiImage {
  id: string
  url: string
  alt: string | null
  type: string
}

interface ImagesSlice {
  /** Ordered list of image URLs the user has approved for this listing.
   *  First entry is the main image; the rest are additional. */
  orderedUrls?: string[]
}

const MAX_IMAGES = 9 // Amazon's hard cap

export default function Step7Images({
  wizardState,
  updateWizardState,
  wizardId,
}: StepProps) {
  const slice = (wizardState.images ?? {}) as ImagesSlice

  const [images, setImages] = useState<ApiImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The user-controlled order. Seeded from wizardState if present,
  // otherwise from the master product (MAIN first, then everything
  // else by createdAt order returned by the API).
  const [orderedUrls, setOrderedUrls] = useState<string[]>(
    slice.orderedUrls ?? [],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/listing-wizard/${wizardId}/images`)
      .then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json() }))
      .then(({ ok, status, json }) => {
        if (cancelled) return
        if (!ok) {
          setError(json?.error ?? `HTTP ${status}`)
          return
        }
        const fetched = (json?.images ?? []) as ApiImage[]
        setImages(fetched)
        // Seed order on first load if the user hasn't picked yet.
        if (orderedUrls.length === 0 && fetched.length > 0) {
          const main = fetched.find((i) => i.type === 'MAIN')
          const rest = fetched.filter((i) => i.id !== main?.id)
          const seed = [
            ...(main ? [main.url] : []),
            ...rest.map((i) => i.url),
          ]
          setOrderedUrls(seed)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // images / orderedUrls aren't deps — we only seed on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId])

  // Persist ordering to wizardState whenever it changes.
  useEffect(() => {
    if (loading) return
    void updateWizardState({
      images: { orderedUrls } as ImagesSlice,
    })
    // updateWizardState is stable from the wizard shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedUrls, loading])

  const imagesByUrl = useMemo(() => {
    const map = new Map<string, ApiImage>()
    for (const img of images) map.set(img.url, img)
    return map
  }, [images])

  const move = useCallback((idx: number, dir: -1 | 1) => {
    setOrderedUrls((prev) => {
      const target = idx + dir
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const [item] = next.splice(idx, 1)
      next.splice(target, 0, item!)
      return next
    })
  }, [])

  const setMain = useCallback((idx: number) => {
    setOrderedUrls((prev) => {
      if (idx === 0) return prev
      const next = prev.slice()
      const [item] = next.splice(idx, 1)
      next.unshift(item!)
      return next
    })
  }, [])

  const remove = useCallback((idx: number) => {
    setOrderedUrls((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const restoreAll = useCallback(() => {
    if (images.length === 0) return
    const main = images.find((i) => i.type === 'MAIN')
    const rest = images.filter((i) => i.id !== main?.id)
    setOrderedUrls([
      ...(main ? [main.url] : []),
      ...rest.map((i) => i.url),
    ])
  }, [images])

  const issues = useMemo(() => validateImages(orderedUrls), [orderedUrls])

  const onContinue = useCallback(async () => {
    if (issues.blocking.length > 0) return
    await updateWizardState(
      { images: { orderedUrls } as ImagesSlice },
      { advance: true },
    )
  }, [issues.blocking.length, orderedUrls, updateWizardState])

  const removedAvailable = images.filter(
    (i) => !orderedUrls.includes(i.url),
  )

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">Images</h2>
          <p className="text-[13px] text-slate-600 mt-1">
            Order the images and pick the main shot. Amazon shows the first
            image as the gallery hero — most marketplaces hide listings
            without one.
          </p>
        </div>
        {images.length > 0 && orderedUrls.length !== images.length && (
          <button
            type="button"
            onClick={restoreAll}
            className="text-[12px] text-blue-600 hover:underline flex-shrink-0"
          >
            Restore all
          </button>
        )}
      </div>

      {loading && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-[13px] text-slate-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading images…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {!loading && !error && images.length === 0 && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-4">
            <ImageOff className="w-6 h-6" />
          </div>
          <p className="text-[14px] text-slate-700">
            No images on this product yet.
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Add images on the product edit page, then come back here.
          </p>
        </div>
      )}

      {!loading && !error && orderedUrls.length > 0 && (
        <>
          {/* Selected list */}
          <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between text-[12px] text-slate-600">
              <span>
                <span className="font-medium">{orderedUrls.length}</span> /{' '}
                {MAX_IMAGES} images included
              </span>
              <span className="text-slate-400">
                Drag-to-reorder lands later — use the arrows for now
              </span>
            </div>
            {orderedUrls.map((url, idx) => {
              const img = imagesByUrl.get(url)
              return (
                <div
                  key={url}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-b-0',
                    idx === 0 && 'bg-blue-50/40',
                  )}
                >
                  <span className="text-[11px] font-mono text-slate-400 w-5 tabular-nums">
                    {idx + 1}
                  </span>
                  <Thumb url={url} alt={img?.alt ?? ''} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-slate-700 truncate">
                      {img?.alt ?? '(no alt text)'}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {url}
                    </div>
                  </div>
                  {idx === 0 ? (
                    <span className="text-[10px] font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                      <Crown className="w-3 h-3" /> Main
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setMain(idx)}
                      className="text-[11px] text-slate-500 hover:text-slate-900 hover:underline"
                    >
                      Set as main
                    </button>
                  )}
                  <div className="flex items-center gap-0.5 border border-slate-200 rounded">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      title="Move up"
                      className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <div className="w-px h-4 bg-slate-200" />
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={idx === orderedUrls.length - 1}
                      title="Move down"
                      className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="text-[11px] text-slate-500 hover:text-rose-700 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              )
            })}
          </div>

          {/* Available-but-not-selected pool */}
          {removedAvailable.length > 0 && (
            <div className="mt-4 border border-dashed border-slate-200 rounded-lg bg-slate-50 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">
                Available but excluded
              </div>
              <div className="flex flex-wrap gap-2">
                {removedAvailable.map((img) => (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() =>
                      setOrderedUrls((prev) =>
                        prev.length >= MAX_IMAGES
                          ? prev
                          : [...prev, img.url],
                      )
                    }
                    disabled={orderedUrls.length >= MAX_IMAGES}
                    title="Add back to listing"
                    className="flex items-center gap-2 px-2 py-1 text-[11px] text-slate-600 bg-white border border-slate-200 rounded hover:border-blue-300 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Thumb url={img.url} alt={img.alt ?? ''} small />
                    <span className="truncate max-w-[140px]">
                      {img.alt ?? 'Untitled'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Validation summary + Continue */}
          <div className="mt-6">
            <ValidationPanel issues={issues} />
            <div className="mt-3 flex items-center justify-end">
              <button
                type="button"
                onClick={onContinue}
                disabled={issues.blocking.length > 0}
                className={cn(
                  'h-8 px-4 rounded-md text-[13px] font-medium',
                  issues.blocking.length > 0
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-blue-600 text-white hover:bg-blue-700',
                )}
              >
                Continue
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Thumb({
  url,
  alt,
  small = false,
}: {
  url: string
  alt: string
  small?: boolean
}) {
  // Native <img> intentionally — see TECH_DEBT note about avoiding
  // next/image's deploy-time domain allowlist for thumbnails.
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={url}
      alt={alt}
      className={cn(
        'rounded border border-slate-200 object-cover bg-slate-50 flex-shrink-0',
        small ? 'w-8 h-8' : 'w-12 h-12',
      )}
      onError={(e) => {
        ;(e.currentTarget as HTMLImageElement).style.opacity = '0.3'
      }}
    />
  )
}

interface ValidationIssues {
  blocking: string[]
  warnings: string[]
}

function validateImages(orderedUrls: string[]): ValidationIssues {
  const blocking: string[] = []
  const warnings: string[] = []
  if (orderedUrls.length === 0) {
    blocking.push('At least one image is required.')
  }
  if (orderedUrls.length > MAX_IMAGES) {
    blocking.push(`Amazon allows at most ${MAX_IMAGES} images per listing.`)
  }
  if (orderedUrls.length === 1) {
    warnings.push(
      'Only one image — most listings convert better with at least 3 (lifestyle + alts).',
    )
  }
  // Per-marketplace rules (resolution, white background, etc.) are
  // documented but require image-dimension fetching or vision-model
  // checks; v1 surfaces them as a generic reminder rather than
  // hard-validation.
  warnings.push(
    'Reminder: main image must have a pure white background and be at least 1000×1000 px for Amazon zoom.',
  )
  return { blocking, warnings }
}

function ValidationPanel({ issues }: { issues: ValidationIssues }) {
  if (issues.blocking.length === 0 && issues.warnings.length === 0) {
    return (
      <p className="text-[12px] text-emerald-700 inline-flex items-center gap-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Images look good.
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      {issues.blocking.map((msg, i) => (
        <div
          key={`b-${i}`}
          className="text-[12px] text-rose-700 inline-flex items-start gap-1.5"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}
      {issues.warnings.map((msg, i) => (
        <div
          key={`w-${i}`}
          className="text-[12px] text-amber-700 inline-flex items-start gap-1.5"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}
    </div>
  )
}
