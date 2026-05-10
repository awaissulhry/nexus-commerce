'use client'

// MC.1.5 — asset detail drawer.
//
// Right-side slide-in panel triggered by selecting an asset in the
// library. Renders preview + structured metadata + usages. Quick
// actions (copy URL, open product, view raw file) are inline; deep
// edits (alt rewrite, AI process, replace file) land in MC.3 / MC.4.
//
// Drawer instead of modal so the operator can keep the library list
// in view while reviewing — picking through 500 assets one-at-a-time
// in a center modal would be miserable.

import { useEffect, useState } from 'react'
import Image from 'next/image'
import {
  X,
  Copy,
  ExternalLink,
  ImageIcon,
  Loader2,
  AlertTriangle,
  Calendar,
  HardDrive,
  Tag as TagIcon,
  Link2,
  Maximize2,
  Hash,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatBytes } from '../_lib/format'
import AssetTagPicker from './AssetTagPicker'
import ChannelVariantsList from './ChannelVariantsList'
import LocaleOverlayManager from './LocaleOverlayManager'
import ChannelPreviewPane from './ChannelPreviewPane'
import type {
  AssetDetail,
  AssetDetailResponse,
  AssetTagRef,
  LibraryItem,
} from '../_lib/types'

interface Props {
  selected: LibraryItem | null
  apiBase: string
  onClose: () => void
}

export default function AssetDetailDrawer({ selected, apiBase, onClose }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [detail, setDetail] = useState<AssetDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      setError(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `${apiBase}/api/assets/library/${encodeURIComponent(selected.id)}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`Detail API returned ${res.status}`)
        const data = (await res.json()) as AssetDetailResponse
        if (!cancelled) setDetail(data.detail)
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selected, apiBase])

  // Esc-to-close.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected, onClose])

  if (!selected) return null

  const copyUrl = async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.url)
      toast.success(t('marketingContent.detail.urlCopied'))
    } catch {
      toast.error(t('marketingContent.detail.urlCopyFailed'))
    }
  }

  return (
    <>
      {/* Click-out overlay. Uses bg-transparent so we don't dim the
          library — operator wants to keep both panels visually present.
          A subtle right-edge box-shadow on the drawer separates them. */}
      <button
        type="button"
        aria-label={t('marketingContent.detail.closeOverlay')}
        onClick={onClose}
        className="fixed inset-0 z-30 cursor-default bg-transparent"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-detail-title"
        className="fixed right-0 top-0 z-40 flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900 sm:max-w-lg"
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2
            id="asset-detail-title"
            className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100"
          >
            {detail?.label ?? selected.label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading && !detail && (
            <div className="flex items-center justify-center py-16 text-slate-500 dark:text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}

          {error && (
            <div className="m-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">
                  {t('marketingContent.detail.errorTitle')}
                </p>
                <p className="text-xs opacity-80">{error}</p>
              </div>
            </div>
          )}

          {detail && (
            <div className="flex flex-col gap-4 p-4">
              {/* Preview */}
              <div className="relative w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
                {detail.type === 'image' ? (
                  <div className="relative aspect-square w-full">
                    <Image
                      src={detail.url}
                      alt={detail.alt ?? detail.label}
                      fill
                      sizes="(min-width: 640px) 32rem, 100vw"
                      className="object-contain"
                      unoptimized
                    />
                  </div>
                ) : (
                  <div className="flex aspect-square items-center justify-center text-slate-400">
                    <ImageIcon className="w-12 h-12" />
                  </div>
                )}
              </div>

              {/* Quick actions */}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={copyUrl}>
                  <Copy className="w-4 h-4 mr-1" />
                  {t('marketingContent.detail.copyUrl')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    window.open(detail.url, '_blank', 'noopener,noreferrer')
                  }
                >
                  <ExternalLink className="w-4 h-4 mr-1" />
                  {t('marketingContent.detail.openOriginal')}
                </Button>
              </div>

              {/* Metadata */}
              <section
                aria-label={t('marketingContent.detail.metadataLabel')}
                className="space-y-2"
              >
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t('marketingContent.detail.metadata')}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <DetailRow
                    icon={Hash}
                    label={t('marketingContent.detail.type')}
                    value={`${detail.type}${detail.mimeType ? ` · ${detail.mimeType}` : ''}`}
                  />
                  {detail.code && (
                    <DetailRow
                      icon={Hash}
                      label={t('marketingContent.detail.code')}
                      value={detail.code}
                    />
                  )}
                  {(detail.width !== null || detail.height !== null) && (
                    <DetailRow
                      icon={Maximize2}
                      label={t('marketingContent.detail.dimensions')}
                      value={
                        detail.width && detail.height
                          ? `${detail.width} × ${detail.height}`
                          : '—'
                      }
                    />
                  )}
                  {detail.sizeBytes !== null && (
                    <DetailRow
                      icon={HardDrive}
                      label={t('marketingContent.detail.size')}
                      value={formatBytes(detail.sizeBytes)}
                    />
                  )}
                  <DetailRow
                    icon={Calendar}
                    label={t('marketingContent.detail.uploaded')}
                    value={new Date(detail.createdAt).toLocaleString()}
                  />
                  {detail.alt && (
                    <DetailRow
                      icon={TagIcon}
                      label={t('marketingContent.detail.alt')}
                      value={detail.alt}
                    />
                  )}
                  {detail.caption && (
                    <DetailRow
                      icon={TagIcon}
                      label={t('marketingContent.detail.caption')}
                      value={detail.caption}
                    />
                  )}
                </dl>
              </section>

              {/* MC.3.4 — quality warnings, if any. */}
              {detail.qualityWarnings.length > 0 && (
                <section
                  aria-label={t('marketingContent.detail.qualityLabel')}
                  className="space-y-2"
                >
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('marketingContent.detail.quality', {
                      n: detail.qualityWarnings.length.toString(),
                    })}
                  </h3>
                  <ul className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900 dark:bg-amber-950/30">
                    {detail.qualityWarnings.map((w, idx) => (
                      <li
                        key={`${w.code}-${idx}`}
                        className="flex items-start gap-1.5 text-amber-900 dark:text-amber-200"
                      >
                        {w.channel && (
                          <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-500/30 dark:text-amber-100">
                            {w.channel}
                          </span>
                        )}
                        <span>{w.message}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* MC.2.1 — interactive tag picker (DigitalAsset only). */}
              {detail.source === 'digital_asset' && (
                <section
                  aria-label={t('marketingContent.detail.tagsLabel')}
                  className="space-y-2"
                >
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {t('marketingContent.detail.tags')}
                  </h3>
                  <AssetTagPicker
                    assetId={detail.id}
                    rawAssetId={detail.id.startsWith('da_') ? detail.id.slice(3) : detail.id}
                    apiBase={apiBase}
                    current={detail.assetTags}
                    onChange={(next: AssetTagRef[]) =>
                      setDetail((prev) =>
                        prev ? { ...prev, assetTags: next } : prev,
                      )
                    }
                  />
                </section>
              )}

              {/* AI-suggested / freeform tags (read-only legacy field). */}
              {detail.tags.length > 0 && (
                <section
                  aria-label={t('marketingContent.detail.aiTagsLabel')}
                  className="space-y-2"
                >
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {t('marketingContent.detail.aiTags')}
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Usages */}
              <section
                aria-label={t('marketingContent.detail.usagesLabel')}
                className="space-y-2"
              >
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t('marketingContent.detail.usages')}{' '}
                  <span className="font-normal text-slate-400">
                    ({detail.usages.length})
                  </span>
                </h3>
                {detail.usages.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('marketingContent.detail.noUsages')}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.usages.map((u) => (
                      <li
                        key={u.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-slate-900 dark:text-slate-100">
                            {u.productName ?? u.productSku ?? '—'}
                          </p>
                          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                            {u.productSku && (
                              <span className="font-mono">{u.productSku}</span>
                            )}
                            <span className="ml-1 uppercase tracking-wide">
                              · {u.role}
                            </span>
                          </p>
                        </div>
                        {u.productId && (
                          <a
                            href={`/products/${encodeURIComponent(u.productId)}/edit`}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                            aria-label={t('marketingContent.detail.openProduct')}
                          >
                            <Link2 className="w-4 h-4" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* MC.6.1 — per-channel variants */}
              {detail.channelVariants.length > 0 && (
                <ChannelVariantsList variants={detail.channelVariants} />
              )}

              {/* MC.6.3 — locale overlays */}
              <LocaleOverlayManager
                assetId={detail.id}
                apiBase={apiBase}
              />

              {/* MC.6.4 — per-channel preview pane */}
              <ChannelPreviewPane
                assetId={detail.id}
                apiBase={apiBase}
              />

              {/* Storage */}
              <section
                aria-label={t('marketingContent.detail.storageLabel')}
                className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800"
              >
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {t('marketingContent.detail.storage')}
                </h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                  <DetailRow
                    icon={HardDrive}
                    label={t('marketingContent.detail.provider')}
                    value={detail.storageProvider}
                  />
                  {detail.storageId && (
                    <DetailRow
                      icon={Hash}
                      label={t('marketingContent.detail.storageId')}
                      value={detail.storageId}
                      mono
                    />
                  )}
                </dl>
              </section>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

interface DetailRowProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  mono?: boolean
}

function DetailRow({ icon: Icon, label, value, mono }: DetailRowProps) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Icon className="w-3 h-3" />
        {label}
      </dt>
      <dd
        className={`break-words text-slate-900 dark:text-slate-100 ${mono ? 'font-mono text-xs' : ''}`}
      >
        {value}
      </dd>
    </>
  )
}
