'use client'

// MC.10.2 — Brand Kit reference panel.
//
// Shared by A+ Content + Brand Story builders. Renders the kit's
// colors / logos / tagline / voice notes alongside the editor so
// the operator can pull values without flipping tabs. Read-only —
// click any value to copy. Renders nothing when the brand has no
// kit yet, with a subtle "create one" affordance.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Palette,
  Copy,
  ExternalLink,
  ChevronDown,
  Sparkles,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'

interface ColorEntry {
  name: string
  hex: string
  role: string
}
interface FontEntry {
  name: string
  family: string
  weight?: string
  role: string
}
interface LogoEntry {
  name: string
  assetId?: string
  url?: string
  role: string
}
interface BrandKit {
  brand: string
  displayName: string | null
  tagline: string | null
  voiceNotes: string | null
  colors: ColorEntry[]
  fonts: FontEntry[]
  logos: LogoEntry[]
}

interface Props {
  brand: string | null
  apiBase: string
}

export default function BrandKitReferencePanel({ brand, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [kit, setKit] = useState<BrandKit | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!brand) {
      setKit(null)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`${apiBase}/api/brand-kits/${encodeURIComponent(brand)}`, {
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { kit: BrandKit } | null) => {
        if (!cancelled) setKit(data?.kit ?? null)
      })
      .catch(() => {
        if (!cancelled) setKit(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [brand, apiBase])

  if (!brand) return null

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t('brandKitRef.copied', { label }))
    } catch {
      toast.error(t('brandKitRef.copyFailed'))
    }
  }

  // No-kit state — surface a small CTA without taking up much space.
  if (!loading && !kit) {
    return (
      <details className="rounded-md border border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
            <Palette className="w-3.5 h-3.5 text-slate-400" />
            {t('brandKitRef.noKitTitle', { brand })}
          </span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        </summary>
        <div className="px-3 pb-3 text-xs text-slate-600 dark:text-slate-400">
          <p>{t('brandKitRef.noKitBody')}</p>
          <Link
            href={`/marketing/brand-kit/${encodeURIComponent(brand)}`}
            className="mt-1 inline-flex items-center gap-1 text-blue-600 hover:underline dark:text-blue-400"
          >
            <ExternalLink className="w-3 h-3" />
            {t('brandKitRef.createCta')}
          </Link>
        </div>
      </details>
    )
  }

  if (!kit) return null

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
          <Palette className="w-4 h-4 text-slate-400" />
          {t('brandKitRef.title', { brand: kit.displayName ?? kit.brand })}
        </span>
        <span className="flex items-center gap-1.5">
          <Link
            href={`/marketing/brand-kit/${encodeURIComponent(kit.brand)}`}
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title={t('brandKitRef.openKit')}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
          <ChevronDown
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </span>
      </summary>
      <div className="space-y-3 p-3">
        {kit.tagline && (
          <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900 dark:bg-blue-950/30">
            <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-blue-500" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
                {t('brandKitRef.tagline')}
              </p>
              <p className="italic text-blue-900 dark:text-blue-200">
                "{kit.tagline}"
              </p>
            </div>
            <button
              type="button"
              onClick={() => copy(kit.tagline ?? '', 'tagline')}
              aria-label={t('brandKitRef.copyAria', { label: 'tagline' })}
              className="rounded p-0.5 text-blue-500 hover:bg-blue-100 dark:hover:bg-blue-900/50"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        )}

        {kit.colors.length > 0 && (
          <Group title={t('brandKitRef.colors', { n: kit.colors.length.toString() })}>
            <div className="flex flex-wrap gap-1.5">
              {kit.colors.map((color, idx) => (
                <button
                  key={`${color.hex}-${idx}`}
                  type="button"
                  onClick={() => copy(color.hex, color.name || color.hex)}
                  className="group/c flex items-center gap-1.5 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
                  title={`${color.name || color.role} · ${color.hex}`}
                >
                  <span
                    className="inline-block h-4 w-4 rounded-sm border border-slate-200 dark:border-slate-700"
                    style={{ backgroundColor: color.hex }}
                  />
                  <span className="font-mono text-slate-700 dark:text-slate-300">
                    {color.hex.toUpperCase()}
                  </span>
                  <Copy className="w-2.5 h-2.5 text-slate-400 opacity-0 group-hover/c:opacity-100" />
                </button>
              ))}
            </div>
          </Group>
        )}

        {kit.logos.length > 0 && (
          <Group title={t('brandKitRef.logos', { n: kit.logos.length.toString() })}>
            <div className="grid grid-cols-3 gap-1.5">
              {kit.logos.slice(0, 6).map((logo, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() =>
                    copy(logo.url ?? logo.assetId ?? '', logo.name || logo.role)
                  }
                  className="group/l flex items-center gap-1.5 rounded border border-slate-200 bg-white p-1 text-left text-[10px] hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
                  title={logo.name || logo.role}
                >
                  <div className="relative h-8 w-8 flex-shrink-0 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {logo.url ? (
                      <img
                        src={logo.url}
                        alt={logo.name}
                        className="h-full w-full object-contain"
                      />
                    ) : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-slate-700 dark:text-slate-300">
                      {logo.name || logo.role}
                    </p>
                    <p className="truncate uppercase tracking-wide text-slate-400">
                      {logo.role}
                    </p>
                  </div>
                  <Copy className="w-2.5 h-2.5 flex-shrink-0 text-slate-400 opacity-0 group-hover/l:opacity-100" />
                </button>
              ))}
            </div>
          </Group>
        )}

        {kit.fonts.length > 0 && (
          <Group title={t('brandKitRef.fonts', { n: kit.fonts.length.toString() })}>
            <ul className="space-y-1">
              {kit.fonts.map((font, idx) => (
                <li
                  key={idx}
                  className="flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
                >
                  <span
                    className="flex-1 truncate"
                    style={{ fontFamily: font.family || undefined }}
                  >
                    {font.family || font.name}
                    {font.weight ? (
                      <span className="ml-1 text-[10px] text-slate-400">
                        · {font.weight}
                      </span>
                    ) : null}
                  </span>
                  <span className="rounded bg-slate-100 px-1 py-0 text-[9px] uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {font.role}
                  </span>
                  <button
                    type="button"
                    onClick={() => copy(font.family, font.name || font.role)}
                    aria-label={t('brandKitRef.copyAria', { label: font.role })}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                  >
                    <Copy className="w-2.5 h-2.5" />
                  </button>
                </li>
              ))}
            </ul>
          </Group>
        )}

        {kit.voiceNotes && (
          <Group title={t('brandKitRef.voice')}>
            <p className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs italic text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              {kit.voiceNotes}
            </p>
          </Group>
        )}
      </div>
    </details>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </p>
      {children}
    </div>
  )
}
