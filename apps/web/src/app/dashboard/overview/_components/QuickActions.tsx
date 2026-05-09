'use client'

import Link from 'next/link'
import {
  ExternalLink,
  PackagePlus,
  Sparkles,
  TableProperties,
  Wifi,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import type { T } from '../_lib/types'

/**
 * Quick actions launchpad. Today these are a fixed set of catalog /
 * channel tasks; W6 swaps the list for operationally-relevant
 * actions (Process pending shipments, Resolve listing errors,
 * Review pending returns, Approve drafts, etc.).
 */
export default function QuickActions({ t }: { t: T }) {
  const actions = [
    {
      label: t('overview.quickActions.addProduct'),
      href: '/products/new',
      icon: PackagePlus,
    },
    {
      label: t('overview.quickActions.bulk'),
      href: '/bulk-operations',
      icon: TableProperties,
    },
    {
      label: t('overview.quickActions.ai'),
      href: '/products',
      icon: Sparkles,
    },
    {
      label: t('overview.quickActions.channels'),
      href: '/settings/channels',
      icon: Wifi,
    },
  ]
  return (
    <Card title={t('overview.quickActions.heading')} noPadding>
      <div className="px-2 py-2">
        {actions.map((a) => {
          const Icon = a.icon
          return (
            <Link
              key={a.label}
              href={a.href}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-base text-slate-700 dark:text-slate-300"
            >
              <Icon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              <span className="flex-1">{a.label}</span>
              <ExternalLink className="w-3 h-3 text-slate-300 dark:text-slate-600" />
            </Link>
          )
        })}
      </div>
    </Card>
  )
}
