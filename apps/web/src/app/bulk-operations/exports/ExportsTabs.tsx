'use client'

/**
 * W14.10 — Tab strip on the exports page splitting one-shot
 * exports (W9.3 ExportsClient) from recurring exports (W9.4
 * ScheduledExportsPanel). Mirrors the W14.9 ImportsTabs pattern.
 */

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { CalendarClock, Download } from 'lucide-react'
import ExportsClient from './ExportsClient'
import ScheduledExportsPanel from './ScheduledExportsPanel'

type Tab = 'recent' | 'scheduled'

export default function ExportsTabs() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const initial = params.get('tab') === 'scheduled' ? 'scheduled' : 'recent'
  const [tab, setTab] = useState<Tab>(initial)
  useEffect(() => {
    const next = new URLSearchParams(params.toString())
    if (tab === 'recent') next.delete('tab')
    else next.set('tab', tab)
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [tab, params, pathname, router])

  return (
    <div className="space-y-3">
      <div className="px-3 md:px-6 border-b border-slate-200 dark:border-slate-800">
        <div className="inline-flex items-center gap-1" role="tablist">
          <TabButton
            active={tab === 'recent'}
            onClick={() => setTab('recent')}
            icon={<Download className="w-3.5 h-3.5" aria-hidden="true" />}
            label="Recent exports"
          />
          <TabButton
            active={tab === 'scheduled'}
            onClick={() => setTab('scheduled')}
            icon={<CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />}
            label="Scheduled"
          />
        </div>
      </div>
      {tab === 'recent' ? <ExportsClient /> : <ScheduledExportsPanel />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-blue-600 dark:border-blue-400 text-blue-700 dark:text-blue-300'
          : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
