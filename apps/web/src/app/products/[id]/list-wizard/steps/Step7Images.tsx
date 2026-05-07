'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Crown,
  ChevronUp,
  ChevronDown,
  ImageOff,
  ExternalLink,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'

interface ApiImage {
  id: string
  url: string
  alt: string | null
  type: string
}

interface ResolvedImage {
  id: string
  url: string
  filename: string | null
  position: number
  role: string
  source: string
  width: number | null
  height: number | null
  mimeType: string | null
}

interface ValidationIssue {
  severity: 'blocking' | 'warning'
  code: string
  message: string
  imageIndex?: number
}

interface ValidationResult {
  platform: string
  marketplace: string
  imageCount: number
  hasMain: boolean
  blocking: ValidationIssue[]
  warnings: ValidationIssue[]
  status: 'ok' | 'warned' | 'blocked'
}

interface ImagesResponse {
  images: ApiImage[]
  resolvedByChannel: Record<string, ResolvedImage[]>
  validationByChannel: Record<string, ValidationResult>
}

interface ImagesSlice {
  /** Lightweight quick-reorder state for the wizard step. The full
   *  multi-scope ListingImage management lives on the dedicated
   *  image-manager page (separate from the wizard). */
  orderedUrls?: string[]
}

const MAX_IMAGES = 9

export default function Step7Images({
  wizardState,
  updateWizardState,
  wizardId,
  channels,
  product,
  reportValidity,
  setJumpToBlocker,
}: StepProps) {
  const slice = (wizardState.images ?? {}) as ImagesSlice

  const [data, setData] = useState<ImagesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        const d = json as ImagesResponse
        setData(d)
        if (orderedUrls.length === 0 && d.images.length > 0) {
          const main = d.images.find((i) => i.type === 'MAIN')
          const rest = d.images.filter((i) => i.id !== main?.id)
          setOrderedUrls([
            ...(main ? [main.url] : []),
            ...rest.map((i) => i.url),
          ])
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardId])

  useEffect(() => {
    if (loading) return
    void updateWizardState({ images: { orderedUrls } as ImagesSlice })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedUrls, loading])

  const imagesByUrl = useMemo(() => {
    const map = new Map<string, ApiImage>()
    if (!data) return map
    for (const img of data.images) map.set(img.url, img)
    return map
  }, [data])

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
    if (!data) return
    const main = data.images.find((i) => i.type === 'MAIN')
    const rest = data.images.filter((i) => i.id !== main?.id)
    setOrderedUrls([
      ...(main ? [main.url] : []),
      ...rest.map((i) => i.url),
    ])
  }, [data])

  // Continue is blocked only when at least one selected channel has
  // hard requirement failures in the resolved set. Warnings don't
  // block — the user can ship and clean up later via the dedicated
  // image-manager page.
  const blockingChannels = useMemo(() => {
    if (!data) return [] as string[]
    return Object.entries(data.validationByChannel)
      .filter(([, v]) => v.status === 'blocked')
      .map(([k]) => k)
  }, [data])

  const onContinue = useCallback(async () => {
    if (blockingChannels.length > 0) return
    await updateWizardState(
      { images: { orderedUrls } as ImagesSlice },
      { advance: true },
    )
  }, [blockingChannels.length, orderedUrls, updateWizardState])

  // C.0 / A1 — register jump-to-blocker. Scrolls to the first
  // blocked-channel row and focuses it.
  useEffect(() => {
    setJumpToBlocker(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-blocker-row="true"]',
      )
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
    return () => setJumpToBlocker(null)
  }, [setJumpToBlocker])

  // C.0 — report validity from validationByChannel. Warnings don't
  // gate (matches the in-step Continue logic); only `blocked` channels
  // count as blockers. Total count = sum of blocking issues across
  // blocked channels so a channel with 3 problems weighs proportionally.
  useEffect(() => {
    if (loading) {
      reportValidity({
        valid: false,
        blockers: 1,
        reasons: ['Loading images…'],
      })
      return
    }
    if (error) {
      reportValidity({ valid: false, blockers: 1, reasons: [error] })
      return
    }
    if (!data) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    if (blockingChannels.length === 0) {
      reportValidity({ valid: true, blockers: 0 })
      return
    }
    let blockers = 0
    for (const ch of blockingChannels) {
      blockers += data.validationByChannel[ch]?.blocking.length ?? 0
    }
    const reasons = blockingChannels
      .slice(0, 3)
      .map((ch) => `${ch} image set incomplete`)
    reportValidity({
      valid: false,
      blockers: Math.max(blockers, blockingChannels.length),
      reasons,
    })
  }, [loading, error, data, blockingChannels, reportValidity])

  const removedAvailable = data
    ? data.images.filter((i) => !orderedUrls.includes(i.url))
    : []

  return (
    <div className="max-w-3xl mx-auto py-10 px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Images</h2>
          <p className="text-md text-slate-600 mt-1">
            Quick-reorder the master gallery for this listing. Per-channel
            and per-variation overrides live on the dedicated image-manager
            page — open it in another tab to edit those without leaving the
            wizard.
          </p>
        </div>
        <Link
          href={`/products/${product.id}/images`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-base text-blue-600 hover:underline flex-shrink-0"
        >
          Open image manager
          <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {loading && (
        <div
          className="border border-slate-200 rounded-lg bg-white px-6 py-6 space-y-3"
          aria-busy="true"
          aria-label="Loading images"
        >
          <Skeleton variant="text" lines={2} />
          <div className="grid grid-cols-3 gap-3">
            <Skeleton variant="thumbnail" />
            <Skeleton variant="thumbnail" />
            <Skeleton variant="thumbnail" />
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-md text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* Per-channel validation summary */}
          {channels.length > 0 && (
            <div className="border border-slate-200 rounded-lg bg-white mb-4">
              <div className="px-3 py-2 border-b border-slate-200 text-base font-medium text-slate-700">
                Per-channel resolved set
              </div>
              <div className="px-3 py-2 space-y-1.5">
                {channels.map((c) => {
                  const channelKey = `${c.platform}:${c.marketplace}`
                  const v = data.validationByChannel[channelKey]
                  const resolved = data.resolvedByChannel[channelKey] ?? []
                  const source = resolved[0]?.source ?? 'no_images'
                  // C.0 / A1 — first blocked channel gets a hook for
                  // setJumpToBlocker. scroll-mt keeps the sticky page
                  // chrome from covering it after the jump.
                  const isFirstBlocked =
                    blockingChannels.length > 0 &&
                    channelKey === blockingChannels[0]
                  return (
                    <div
                      key={channelKey}
                      data-blocker-row={isFirstBlocked ? 'true' : undefined}
                      className="scroll-mt-24"
                    >
                      <ChannelValidationRow
                        channelKey={channelKey}
                        validation={v}
                        imageCount={resolved.length}
                        source={source}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {data.images.length === 0 ? (
            <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-4">
                <ImageOff className="w-6 h-6" />
              </div>
              <p className="text-lg text-slate-700">
                No images on this product yet.
              </p>
              <p className="mt-1 text-base text-slate-500">
                Add images on the product edit page or open the image
                manager — then come back here.
              </p>
            </div>
          ) : (
            <>
              {/* Quick-reorder list */}
              <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between text-base text-slate-600">
                  <span>
                    <span className="font-medium">{orderedUrls.length}</span>{' '}
                    / {MAX_IMAGES} images included in master order
                  </span>
                  {orderedUrls.length !== data.images.length && (
                    <button
                      type="button"
                      onClick={restoreAll}
                      className="text-blue-600 hover:underline"
                    >
                      Restore all
                    </button>
                  )}
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
                      <span className="text-sm font-mono text-slate-400 w-5 tabular-nums">
                        {idx + 1}
                      </span>
                      <Thumb url={url} alt={img?.alt ?? ''} />
                      <div className="flex-1 min-w-0">
                        <div className="text-base text-slate-700 truncate">
                          {img?.alt ?? '(no alt text)'}
                        </div>
                        <div className="text-sm text-slate-400 truncate">
                          {url}
                        </div>
                      </div>
                      {idx === 0 ? (
                        <span className="text-xs font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                          <Crown className="w-3 h-3" /> Main
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setMain(idx)}
                          className="text-sm text-slate-500 hover:text-slate-900 hover:underline"
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
                        className="text-sm text-slate-500 hover:text-rose-700 hover:underline"
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
                  <div className="text-sm uppercase tracking-wide text-slate-500 mb-2">
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
                        className="flex items-center gap-2 px-2 py-1 text-sm text-slate-600 bg-white border border-slate-200 rounded hover:border-blue-300 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
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
            </>
          )}

          {/* Footer + Continue */}
          <div className="mt-6 flex items-center justify-between gap-3">
            <ContinueStatus
              blockingChannels={blockingChannels}
              channels={channels.map((c) => `${c.platform}:${c.marketplace}`)}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={onContinue}
              disabled={blockingChannels.length > 0}
            >
              Continue
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function ChannelValidationRow({
  channelKey,
  validation,
  imageCount,
  source,
}: {
  channelKey: string
  validation: ValidationResult | undefined
  imageCount: number
  source: string
}) {
  const status = validation?.status ?? 'ok'
  const tone =
    status === 'blocked'
      ? 'border-rose-200 bg-rose-50'
      : status === 'warned'
      ? 'border-amber-200 bg-amber-50'
      : 'border-slate-200'
  const Icon =
    status === 'blocked'
      ? AlertCircle
      : status === 'warned'
      ? AlertCircle
      : CheckCircle2
  const iconTone =
    status === 'blocked'
      ? 'text-rose-600'
      : status === 'warned'
      ? 'text-amber-600'
      : 'text-emerald-600'
  return (
    <div className={cn('border rounded px-2 py-1.5 text-sm', tone)}>
      <div className="flex items-center gap-2">
        <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', iconTone)} />
        <span className="font-mono text-slate-700 font-medium">
          {channelKey}
        </span>
        <span className="text-slate-500">
          · {imageCount} image{imageCount === 1 ? '' : 's'}
        </span>
        <span className="text-slate-400">· source: {humanSource(source)}</span>
      </div>
      {validation && (validation.blocking.length > 0 || validation.warnings.length > 0) && (
        <ul className="mt-1 ml-5 space-y-0.5">
          {validation.blocking.map((b, i) => (
            <li key={`b-${i}`} className="text-rose-700">
              {b.message}
            </li>
          ))}
          {validation.warnings.map((w, i) => (
            <li key={`w-${i}`} className="text-amber-700">
              {w.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function humanSource(source: string): string {
  switch (source) {
    case 'product_master':
      return 'master gallery'
    case 'global':
      return 'global override'
    case 'platform':
      return 'platform override'
    case 'marketplace':
      return 'marketplace override'
    case 'variation_global':
      return 'variation (global)'
    case 'variation_platform':
      return 'variation (platform)'
    case 'variation_marketplace':
      return 'variation (marketplace)'
    case 'no_images':
      return 'no images'
    default:
      return source
  }
}

function ContinueStatus({
  blockingChannels,
  channels,
}: {
  blockingChannels: string[]
  channels: string[]
}) {
  if (channels.length === 0) {
    return <span className="text-base text-slate-500">No channels</span>
  }
  if (blockingChannels.length > 0) {
    return (
      <span className="text-base text-rose-700 inline-flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5" />
        Blocked on {blockingChannels.length} channel
        {blockingChannels.length === 1 ? '' : 's'}:{' '}
        <span className="font-mono">{blockingChannels.join(', ')}</span>
      </span>
    )
  }
  return (
    <span className="text-base text-emerald-700 inline-flex items-center gap-1.5">
      <CheckCircle2 className="w-3.5 h-3.5" />
      Resolved set passes every channel's hard requirements.
    </span>
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
