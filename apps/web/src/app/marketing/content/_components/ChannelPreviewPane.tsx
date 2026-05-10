'use client'

// MC.6.4 — Per-channel preview pane.
//
// Sits inside the AssetDetailDrawer next to ChannelVariantsList. The
// difference: this pane fetches a locale-aware preview from the API
// (so locale overlays from MC.6.3 get spliced in) and renders the
// rendered URLs in channel-specific frames — Amazon hero, eBay
// gallery, Shopify product card, OG card, IG square/story — instead
// of flat thumbnails.
//
// Locale switcher at the top lets the operator A/B between en-US,
// it-IT, etc., to verify the localized overlay reads correctly per
// market.

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { Eye } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

interface PreviewVariant {
  id: string
  channel: string
  label: string
  width: number
  height: number
  cropMode: 'fit' | 'fill' | 'pad'
  url: string | null
  notes: string | null
}

interface PreviewPayload {
  assetId: string
  locale: string
  profile: string | null
  activeOverlay: { id: string; locale: string; text: string } | null
  variants: PreviewVariant[]
}

interface Props {
  assetId: string
  apiBase: string
}

const PREVIEW_LOCALES = ['it-IT', 'en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE']

// Channels we render in the preview grid. Order picks the most
// operator-relevant frames first so the eye lands on Amazon hero +
// the OG card immediately.
const PREVIEW_CHANNELS = [
  'Amazon',
  'Shopify',
  'eBay',
  'Instagram',
  'Social',
] as const

export default function ChannelPreviewPane({ assetId, apiBase }: Props) {
  const { t } = useTranslations()
  const [locale, setLocale] = useState('it-IT')
  const [data, setData] = useState<PreviewPayload | null>(null)
  const [loading, setLoading] = useState(true)

  const supports = assetId.startsWith('da_')
  const cleanId = assetId.startsWith('da_') ? assetId.slice(3) : assetId

  useEffect(() => {
    if (!supports) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(
      `${apiBase}/api/assets/${cleanId}/preview?locale=${encodeURIComponent(locale)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PreviewPayload | null) => {
        if (!cancelled && d) setData(d)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [apiBase, cleanId, locale, supports])

  const grouped = useMemo(() => {
    if (!data) return new Map<string, PreviewVariant[]>()
    const map = new Map<string, PreviewVariant[]>()
    for (const v of data.variants) {
      const list = map.get(v.channel)
      if (list) list.push(v)
      else map.set(v.channel, [v])
    }
    return map
  }, [data])

  if (!supports) return null

  return (
    <section
      aria-label={t('marketingContent.preview.label')}
      className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800"
    >
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Eye className="w-3.5 h-3.5" />
          {t('marketingContent.preview.title')}
        </h3>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          aria-label={t('marketingContent.preview.localeLabel')}
          className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-mono dark:border-slate-700 dark:bg-slate-900"
        >
          {PREVIEW_LOCALES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </header>

      {data?.activeOverlay && (
        <p className="rounded bg-emerald-50 px-2 py-1 text-[11px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          {t('marketingContent.preview.activeOverlay', {
            text: data.activeOverlay.text,
            locale: data.activeOverlay.locale,
          })}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-slate-400">
          {t('marketingContent.preview.loading')}
        </p>
      ) : (
        <div className="space-y-3">
          {PREVIEW_CHANNELS.map((channel) => {
            const list = grouped.get(channel)
            if (!list?.length) return null
            // Show the first variant per channel as the preview frame.
            const primary = list[0]
            if (!primary) return null
            return (
              <ChannelFrame
                key={channel}
                channel={channel}
                variant={primary}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}

function ChannelFrame({
  channel,
  variant,
}: {
  channel: string
  variant: PreviewVariant
}) {
  if (!variant.url) {
    return (
      <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-400 dark:border-slate-700">
        {channel}: no preview
      </div>
    )
  }
  return (
    <figure className="overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-medium text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300">
        <span>{channel}</span>
        <span className="font-mono text-slate-400">
          {variant.width}×{variant.height}
        </span>
      </header>
      <div className="relative aspect-square w-full bg-slate-100 dark:bg-slate-800">
        <Image
          src={variant.url}
          alt={variant.label}
          fill
          sizes="(max-width: 768px) 100vw, 380px"
          className="object-contain"
          unoptimized
        />
      </div>
    </figure>
  )
}
