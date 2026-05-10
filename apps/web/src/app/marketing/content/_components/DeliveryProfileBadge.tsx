'use client'

// MC.13.2 — workspace delivery-profile indicator.
//
// Tiny inline pill that reads /api/assets/_meta/delivery-profiles
// once on mount and surfaces the active CDN profile (eco / balanced /
// hd / lossless). Operators see at a glance which quality tier
// Cloudinary is rendering through. Clicking the pill opens a popover
// showing all four profiles + their descriptions; the env-driven
// default is still authoritative until the workspace settings UI
// lands in MC.13 follow-up.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Gauge } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Profile {
  id: 'eco' | 'balanced' | 'hd' | 'lossless'
  label: string
  description: string
}

interface MetaPayload {
  profiles: Profile[]
  active: Profile['id']
}

interface Props {
  apiBase: string
}

export default function DeliveryProfileBadge({ apiBase }: Props) {
  const { t } = useTranslations()
  const [meta, setMeta] = useState<MetaPayload | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetch(`${apiBase}/api/assets/_meta/delivery-profiles`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MetaPayload | null) => {
        if (d) setMeta(d)
      })
      .catch(() => {
        /* offline — badge silently hides */
      })
    return () => ctrl.abort()
  }, [apiBase])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!meta) return null
  const active = meta.profiles.find((p) => p.id === meta.active)
  if (!active) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
        aria-label={t('marketingContent.delivery.label', {
          profile: active.label,
        })}
      >
        <Gauge className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
        <span className="text-slate-500 dark:text-slate-400">
          {t('marketingContent.delivery.cdn')}
        </span>
        <span>{active.label}</span>
        <ChevronDown className="w-3 h-3 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <p className="border-b border-slate-100 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {t('marketingContent.delivery.popoverTitle')}
          </p>
          <ul className="space-y-0.5 pt-1">
            {meta.profiles.map((p) => {
              const isActive = p.id === meta.active
              return (
                <li key={p.id}>
                  <div
                    className={`flex items-start gap-2 rounded-sm px-2 py-1.5 text-xs ${
                      isActive
                        ? 'bg-slate-100 dark:bg-slate-800'
                        : ''
                    }`}
                  >
                    <Check
                      className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${
                        isActive
                          ? 'text-emerald-500'
                          : 'text-transparent'
                      }`}
                    />
                    <div>
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {p.label}
                      </p>
                      <p className="text-slate-500 dark:text-slate-400">
                        {p.description}
                      </p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="border-t border-slate-100 px-2 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {t('marketingContent.delivery.envHint')}
          </p>
        </div>
      )}
    </div>
  )
}
