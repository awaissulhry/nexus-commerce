'use client'

// MC.10.1 — Brand Kit list page.
//
// Two sections:
//   1. Kits   — every BrandKit row with a swatch preview + product count
//   2. Brands without a kit — catalogue brands that don't have a kit
//      yet (cliquéable to start one)

import Link from 'next/link'
import {
  Palette,
  Plus,
  AlertTriangle,
  Layers,
  Package,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { BrandKitRow, BrandMetaRow } from './_lib/types'

interface Props {
  kits: BrandKitRow[]
  brands: BrandMetaRow[]
  error: string | null
  apiBase: string
}

export default function BrandKitListClient({ kits, brands, error }: Props) {
  const { t } = useTranslations()
  const orphanBrands = brands.filter((b) => !b.hasKit)

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('brandKit.title')}
        description={t('brandKit.description')}
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">{t('brandKit.error.listTitle')}</p>
            <p className="text-xs opacity-80">{error}</p>
          </div>
        </div>
      )}

      {/* Existing kits */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t('brandKit.section.kits', { n: kits.length.toString() })}
        </h2>
        {kits.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-12 text-center dark:border-slate-700 dark:bg-slate-900">
            <Palette className="w-8 h-8 text-slate-400" />
            <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {t('brandKit.empty.title')}
            </p>
            <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
              {t('brandKit.empty.body')}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {kits.map((kit) => (
              <Link
                key={kit.id}
                href={`/marketing/brand-kit/${encodeURIComponent(kit.brand)}`}
                className="group rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {kit.displayName ?? kit.brand}
                    </p>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {kit.brand}
                    </p>
                  </div>
                  <Palette className="w-4 h-4 flex-shrink-0 text-slate-400" />
                </div>
                {kit.colors.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {kit.colors.slice(0, 8).map((c, idx) => (
                      <span
                        key={`${c.hex}-${idx}`}
                        className="inline-block h-5 w-5 rounded-full border border-slate-200 dark:border-slate-700"
                        style={{ backgroundColor: c.hex }}
                        title={`${c.name} · ${c.hex}`}
                      />
                    ))}
                    {kit.colors.length > 8 && (
                      <span className="inline-flex h-5 items-center rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        +{kit.colors.length - 8}
                      </span>
                    )}
                  </div>
                )}
                <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                  <Stat
                    icon={Palette}
                    label={t('brandKit.stat.colors')}
                    value={kit.colors.length}
                  />
                  <Stat
                    icon={Layers}
                    label={t('brandKit.stat.logos')}
                    value={kit.logos.length}
                  />
                  <Stat
                    icon={Package}
                    label={t('brandKit.stat.products')}
                    value={kit.productCount}
                  />
                </dl>
                {kit.tagline && (
                  <p className="mt-2 line-clamp-2 text-xs italic text-slate-500 dark:text-slate-400">
                    "{kit.tagline}"
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Orphan brands */}
      {orphanBrands.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('brandKit.section.orphans', {
              n: orphanBrands.length.toString(),
            })}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {orphanBrands.map((b) => (
              <Link
                key={b.brand}
                href={`/marketing/brand-kit/${encodeURIComponent(b.brand)}`}
                className="group flex items-center justify-between rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/20"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {b.brand}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('brandKit.stat.products')}: {b.productCount}
                  </p>
                </div>
                <Plus className="w-4 h-4 flex-shrink-0 text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" />
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {t('brandKit.section.orphansHint')}
          </p>
        </section>
      )}

      {kits.length === 0 && orphanBrands.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          <p>{t('brandKit.noBrandsHint')}</p>
        </div>
      )}
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Palette
  label: string
  value: number
}) {
  return (
    <div className="flex items-center gap-1 text-slate-600 dark:text-slate-400">
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">
        <span className="font-semibold text-slate-900 dark:text-slate-100">
          {value}
        </span>{' '}
        {label}
      </span>
    </div>
  )
}
