'use client'

// MC.12.5 — Per-channel publish dashboard.
//
// One asset → up to 4 channel destinations in one operator pass.
// Fills mostly act on a single asset URL; per-channel destination
// IDs (ASIN, eBay item ID, Shopify GID, Woo product ID) get their
// own input. Fire button POSTs to each enabled channel's endpoint
// in parallel + renders the result list.

import Link from 'next/link'
import { useState } from 'react'
import {
  ArrowLeft,
  Send,
  Loader2,
  CheckCircle2,
  AlertOctagon,
  Sparkles,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'

type Channel = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'

interface ChannelConfig {
  channel: Channel
  label: string
  destinationKey: string
  destinationLabel: string
  destinationPlaceholder: string
  endpoint: string
  bodyKey: string // the request-body key for the destination id
}

const CHANNELS: ChannelConfig[] = [
  {
    channel: 'AMAZON',
    label: 'Amazon',
    destinationKey: 'asin',
    destinationLabel: 'ASIN',
    destinationPlaceholder: 'B0XXXXXXX',
    endpoint: '/api/channel-publish/amazon',
    bodyKey: 'asin',
  },
  {
    channel: 'EBAY',
    label: 'eBay',
    destinationKey: 'itemId',
    destinationLabel: 'eBay item ID',
    destinationPlaceholder: '123456789012',
    endpoint: '/api/channel-publish/ebay',
    bodyKey: 'itemId',
  },
  {
    channel: 'SHOPIFY',
    label: 'Shopify',
    destinationKey: 'productGid',
    destinationLabel: 'Product GID',
    destinationPlaceholder: 'gid://shopify/Product/12345',
    endpoint: '/api/channel-publish/shopify',
    bodyKey: 'productGid',
  },
  {
    channel: 'WOOCOMMERCE',
    label: 'WooCommerce',
    destinationKey: 'wooProductId',
    destinationLabel: 'Woo product ID',
    destinationPlaceholder: '42',
    endpoint: '/api/channel-publish/woo',
    bodyKey: 'wooProductId',
  },
]

interface ResultRow {
  channel: Channel
  ok: boolean
  mode: 'sandbox' | 'live'
  channelImageId: string | null
  error: string | null
}

interface Props {
  modes: Record<Channel, 'sandbox' | 'live'>
  apiBase: string
}

export default function PublishDashboardClient({ modes, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [assetUrl, setAssetUrl] = useState('')
  const [destinations, setDestinations] = useState<Record<string, string>>(
    {},
  )
  const [enabled, setEnabled] = useState<Record<Channel, boolean>>({
    AMAZON: true,
    EBAY: true,
    SHOPIFY: true,
    WOOCOMMERCE: false,
  })
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ResultRow[]>([])

  const fire = async () => {
    if (!assetUrl.trim()) {
      toast.error(t('publishDashboard.assetRequired'))
      return
    }
    const enabledChannels = CHANNELS.filter((c) => enabled[c.channel])
    if (enabledChannels.length === 0) {
      toast.error(t('publishDashboard.pickAtLeastOne'))
      return
    }
    setBusy(true)
    setResults([])
    try {
      const responses = await Promise.all(
        enabledChannels.map(async (cfg) => {
          const dest = destinations[cfg.destinationKey]?.trim()
          if (!dest) {
            return {
              channel: cfg.channel,
              ok: false,
              mode: modes[cfg.channel],
              channelImageId: null,
              error: `${cfg.destinationLabel} required`,
            } as ResultRow
          }
          try {
            const res = await fetch(`${apiBase}${cfg.endpoint}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                assetUrl,
                [cfg.bodyKey]: dest,
              }),
            })
            const body = (await res.json()) as ResultRow
            return body
          } catch (err) {
            return {
              channel: cfg.channel,
              ok: false,
              mode: modes[cfg.channel],
              channelImageId: null,
              error:
                err instanceof Error ? err.message : 'Network error',
            } as ResultRow
          }
        }),
      )
      setResults(responses)
      const okCount = responses.filter((r) => r.ok).length
      const failCount = responses.length - okCount
      if (okCount > 0) {
        toast.success(
          t('publishDashboard.publishedCount', {
            n: okCount.toString(),
          }),
        )
      }
      if (failCount > 0) {
        toast.error(
          t('publishDashboard.failedCount', {
            n: failCount.toString(),
          }),
        )
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Link
        href="/marketing/content"
        className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        {t('publishDashboard.backToContent')}
      </Link>
      <PageHeader
        title={t('publishDashboard.title')}
        description={t('publishDashboard.description')}
      />

      {/* Sandbox notice */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/30">
        <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-500" />
        <div>
          <p className="font-medium text-blue-900 dark:text-blue-200">
            {t('publishDashboard.sandboxTitle')}
          </p>
          <p className="text-blue-800 dark:text-blue-300">
            {t('publishDashboard.sandboxBody')}
          </p>
        </div>
      </div>

      {/* Asset URL input */}
      <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <label className="block">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            {t('publishDashboard.assetLabel')}
          </span>
          <input
            type="url"
            value={assetUrl}
            onChange={(e) => setAssetUrl(e.target.value)}
            placeholder="https://res.cloudinary.com/…/asset.jpg"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </label>
      </div>

      {/* Per-channel destination + toggle */}
      <ul className="grid gap-2 sm:grid-cols-2">
        {CHANNELS.map((cfg) => {
          const result = results.find((r) => r.channel === cfg.channel)
          return (
            <li
              key={cfg.channel}
              className={`rounded-lg border p-3 ${
                enabled[cfg.channel]
                  ? 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
                  : 'border-slate-200 bg-slate-50 opacity-70 dark:border-slate-800 dark:bg-slate-900/60'
              }`}
            >
              <div className="mb-2 flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <input
                    type="checkbox"
                    checked={enabled[cfg.channel]}
                    onChange={(e) =>
                      setEnabled({
                        ...enabled,
                        [cfg.channel]: e.target.checked,
                      })
                    }
                    className="h-4 w-4"
                  />
                  {cfg.label}
                </label>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    modes[cfg.channel] === 'live'
                      ? 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300'
                      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                  }`}
                >
                  {modes[cfg.channel]}
                </span>
              </div>
              <input
                type="text"
                value={destinations[cfg.destinationKey] ?? ''}
                onChange={(e) =>
                  setDestinations({
                    ...destinations,
                    [cfg.destinationKey]: e.target.value,
                  })
                }
                placeholder={cfg.destinationPlaceholder}
                disabled={!enabled[cfg.channel]}
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {cfg.destinationLabel}
              </p>
              {result && (
                <div
                  className={`mt-2 flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${
                    result.ok
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
                      : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200'
                  }`}
                >
                  {result.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertOctagon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    {result.ok ? (
                      <>
                        <p className="font-semibold">
                          {t('publishDashboard.publishedAs', {
                            id: result.channelImageId ?? '—',
                          })}
                        </p>
                        <p className="text-[11px] opacity-80">
                          {t('publishDashboard.modeLabel', {
                            mode: result.mode,
                          })}
                        </p>
                      </>
                    ) : (
                      <p>{result.error ?? 'Failed'}</p>
                    )}
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="md"
          onClick={fire}
          disabled={busy || !assetUrl.trim()}
        >
          {busy ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Send className="w-4 h-4 mr-1" />
          )}
          {t('publishDashboard.fireCta')}
        </Button>
      </div>
    </div>
  )
}
