'use client'

// MC.6.1 — per-channel variants list for the asset detail drawer.
//
// Groups variants by channel (Amazon / eBay / Shopify / Instagram /
// Social) into collapsible sections. Each row shows label,
// dimensions, crop mode, and a copy-URL button. The thumbnail is
// the variant URL itself so the operator sees exactly what
// Cloudinary will serve to the channel.

import { useMemo, useState } from 'react'
import Image from 'next/image'
import { ChevronDown, Copy, ExternalLink, Layers } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import type { ChannelVariant } from '../_lib/types'

interface Props {
  variants: ChannelVariant[]
}

export default function ChannelVariantsList({ variants }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Group by channel preserving the spec order so siblings stay
  // adjacent (Amazon zoom / standard / thumb together).
  const grouped = useMemo(() => {
    const map = new Map<string, ChannelVariant[]>()
    for (const v of variants) {
      const list = map.get(v.channel)
      if (list) list.push(v)
      else map.set(v.channel, [v])
    }
    return [...map.entries()]
  }, [variants])

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('marketingContent.variants.copied'))
    } catch {
      toast.error(t('marketingContent.variants.copyFailed'))
    }
  }

  if (variants.length === 0) return null

  return (
    <section
      aria-label={t('marketingContent.variants.label')}
      className="space-y-2"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <Layers className="w-3.5 h-3.5" />
        {t('marketingContent.variants.title', {
          n: variants.length.toString(),
        })}
      </h3>
      <div className="space-y-1.5">
        {grouped.map(([channel, list]) => {
          const isOpen = expanded[channel] ?? false
          const available = list.filter((v) => v.url).length
          return (
            <details
              key={channel}
              open={isOpen}
              onToggle={(e) =>
                setExpanded((prev) => ({
                  ...prev,
                  [channel]: (e.target as HTMLDetailsElement).open,
                }))
              }
              className="rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                <span>
                  {channel}
                  <span className="ml-1.5 text-xs font-normal text-slate-500 dark:text-slate-400">
                    {available}/{list.length}
                  </span>
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
                    isOpen ? 'rotate-180' : ''
                  }`}
                />
              </summary>
              <ul className="border-t border-slate-200 dark:border-slate-800">
                {list.map((variant) => (
                  <li
                    key={variant.id}
                    className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-slate-800"
                  >
                    <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                      {variant.url ? (
                        <Image
                          src={variant.url}
                          alt={variant.label}
                          fill
                          sizes="40px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm text-slate-900 dark:text-slate-100">
                        {variant.label}
                      </p>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {variant.width}×{variant.height}
                        <span className="ml-1 uppercase tracking-wide text-[10px]">
                          · {variant.cropMode}
                        </span>
                        {variant.notes ? (
                          <span className="ml-1 italic">· {variant.notes}</span>
                        ) : null}
                      </p>
                    </div>
                    {variant.url ? (
                      <>
                        <button
                          type="button"
                          onClick={() => copyUrl(variant.url!)}
                          aria-label={t('marketingContent.variants.copyUrl', {
                            label: variant.label,
                          })}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <a
                          href={variant.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('marketingContent.variants.openUrl', {
                            label: variant.label,
                          })}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </>
                    ) : (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        {t('marketingContent.variants.notAvailable')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )
        })}
      </div>
    </section>
  )
}
