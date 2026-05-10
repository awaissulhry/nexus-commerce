'use client'

// MC.14.6 — Marketing dashboard client.

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  Image as ImageIcon,
  Film,
  HardDrive,
  Layers,
  BookOpen,
  Palette,
  Zap,
  Send,
  BarChart3,
  ArrowRight,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Stats {
  assets: number
  videos: number
  storageBytes: number
  aplusCount: number
  brandStoryCount: number
  brandKitCount: number
  automationCount: number
}

interface Props {
  icon: ReactNode
  stats: Stats
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function MarketingDashboardClient({ stats }: Props) {
  const { t } = useTranslations()

  const surfaces = [
    {
      href: '/marketing/content',
      icon: ImageIcon,
      label: t('marketingHome.surface.content'),
      value: stats.assets.toString(),
      sub: t('marketingHome.surface.contentSub', {
        videos: stats.videos.toString(),
        storage: formatBytes(stats.storageBytes),
      }),
    },
    {
      href: '/marketing/aplus',
      icon: Layers,
      label: t('marketingHome.surface.aplus'),
      value: stats.aplusCount.toString(),
    },
    {
      href: '/marketing/brand-story',
      icon: BookOpen,
      label: t('marketingHome.surface.brandStory'),
      value: stats.brandStoryCount.toString(),
    },
    {
      href: '/marketing/brand-kit',
      icon: Palette,
      label: t('marketingHome.surface.brandKit'),
      value: stats.brandKitCount.toString(),
    },
    {
      href: '/marketing/automation',
      icon: Zap,
      label: t('marketingHome.surface.automation'),
      value: stats.automationCount.toString(),
    },
  ]

  const shortcuts = [
    {
      href: '/marketing/content/publish',
      icon: Send,
      label: t('marketingHome.shortcut.publish'),
    },
    {
      href: '/marketing/content/analytics',
      icon: BarChart3,
      label: t('marketingHome.shortcut.analytics'),
    },
    {
      href: '/marketing/automation/history',
      icon: Zap,
      label: t('marketingHome.shortcut.automationHistory'),
    },
    {
      href: '/marketing/templates',
      icon: Layers,
      label: t('marketingHome.shortcut.templates'),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('marketingHome.title')}
        description={t('marketingHome.description')}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {surfaces.map(({ href, icon: Icon, label, value, sub }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-md border border-slate-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </div>
            <p className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {value}
            </p>
            {sub && (
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {sub}
              </p>
            )}
            <ArrowRight className="mt-2 w-3.5 h-3.5 text-slate-300 transition-transform group-hover:translate-x-0.5 dark:text-slate-600" />
          </Link>
        ))}
      </div>

      <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t('marketingHome.shortcuts')}
        </h2>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {shortcuts.map(({ href, icon: Icon, label }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
            >
              <Icon className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              <span className="text-slate-900 dark:text-slate-100">
                {label}
              </span>
              <ArrowRight className="ml-auto w-3.5 h-3.5 text-slate-300 dark:text-slate-600" />
            </Link>
          ))}
        </div>
      </section>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t('marketingHome.tip')}{' '}
        <kbd className="rounded border border-slate-300 bg-slate-50 px-1 py-0.5 font-mono text-[10px] dark:border-slate-700 dark:bg-slate-800">
          ⌘K
        </kbd>
        {' · '}
        <Link
          href="/marketing/content"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          <Film className="inline w-3 h-3 align-text-bottom" /> {t('marketingHome.openHub')}
        </Link>
        {' · '}
        <span className="inline-flex items-center gap-1">
          <HardDrive className="w-3 h-3" />
          {formatBytes(stats.storageBytes)}
        </span>
      </p>
    </div>
  )
}
