'use client'

/**
 * W14.9 — Tab strip on the imports page splitting one-shot CSV/XLSX
 * imports (W8.3 ImportsClient) from the recurring URL pulls
 * (W8.4 ScheduledImportsPanel). Picks tab from the ?tab=… URL
 * param so deep links survive a page refresh.
 */

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { CalendarClock, Upload } from 'lucide-react'
import ImportsClient from './ImportsClient'
import ScheduledImportsPanel from './ScheduledImportsPanel'

type Tab = 'recent' | 'scheduled'

export default function ImportsTabs() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const initial = params.get('tab') === 'scheduled' ? 'scheduled' : 'recent'
  const [tab, setTab] = useState<Tab>(initial)
  // Keep the URL in sync so reload/share lands on the same tab.
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
            icon={<Upload className="w-3.5 h-3.5" aria-hidden="true" />}
            label="Recent imports"
          />
          <TabButton
            active={tab === 'scheduled'}
            onClick={() => setTab('scheduled')}
            icon={<CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />}
            label="Scheduled"
          />
        </div>
      </div>
      {tab === 'recent' ? <ImportsClient /> : <ScheduledImportsPanel />}
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
