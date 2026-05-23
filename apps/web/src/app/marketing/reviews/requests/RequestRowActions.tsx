'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Clock, Loader2, RotateCcw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Props {
  requestId: string
  status: string
}

const SNOOZE_OPTIONS = [
  { hours: 4,   label: '4h' },
  { hours: 24,  label: '1d' },
  { hours: 72,  label: '3d' },
  { hours: 168, label: '1w' },
]

export function RequestRowActions({ requestId, status }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function snooze(hours: number) {
    setBusy(`snooze-${hours}`)
    try {
      await fetch(`${getBackendUrl()}/api/review-requests/${requestId}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours }),
      })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function unsuppress() {
    setBusy('unsuppress')
    try {
      await fetch(`${getBackendUrl()}/api/review-requests/${requestId}/unsuppress`, {
        method: 'POST',
      })
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  const canUnsuppress = status === 'SUPPRESSED' || status === 'FAILED' || status === 'SKIPPED'

  return (
    <div className="flex items-center gap-1">
      {/* Snooze dropdown — inline buttons keep the table dense */}
      <div className="inline-flex items-center gap-0.5 border border-slate-200 dark:border-slate-700 rounded text-[10px]" title="Defer the send by N hours">
        <Clock className="h-3 w-3 text-slate-400 ml-1" />
        {SNOOZE_OPTIONS.map((opt) => (
          <button
            key={opt.hours}
            onClick={() => snooze(opt.hours)}
            disabled={busy !== null}
            className="px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 last:rounded-r"
          >
            {busy === `snooze-${opt.hours}` ? <Loader2 className="h-2.5 w-2.5 animate-spin inline" /> : opt.label}
          </button>
        ))}
      </div>
      {canUnsuppress && (
        <button
          onClick={unsuppress}
          disabled={busy !== null}
          title="Move back to SCHEDULED + re-queue immediately (resets attempt counter)"
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40"
        >
          {busy === 'unsuppress' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RotateCcw className="h-2.5 w-2.5" />}
          Re-queue
        </button>
      )}
    </div>
  )
}
