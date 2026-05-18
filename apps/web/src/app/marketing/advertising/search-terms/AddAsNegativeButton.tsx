'use client'

/**
 * Phase J.4 — "Add as negative" button for search-term rows.
 *
 * One-click action: POST /api/advertising/negative-keywords creates
 * a NEGATIVE_EXACT ad-group-level negative keyword in Amazon SP. The
 * backend is idempotent (local dedup against AdTarget) and gated by
 * the Phase 9 write gate.
 *
 * The button has three states:
 *   idle    → "+ Negative" small chip
 *   loading → spinner
 *   added   → "✓ Negative added" (greyed out)
 *   denied  → red "× Gate denied" with tooltip
 *   error   → red "× Failed" with tooltip showing Amazon's error
 */

import { useState } from 'react'
import { Check, Loader2, MinusCircle, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Props {
  externalCampaignId: string
  externalAdGroupId: string
  keywordText: string
  marketplace: string
}

export function AddAsNegativeButton({
  externalCampaignId, externalAdGroupId, keywordText, marketplace,
}: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'added' | 'denied' | 'error'>('idle')
  const [tooltip, setTooltip] = useState<string>('Add this query as a NEGATIVE_EXACT keyword at the ad-group scope.')

  async function handleClick() {
    if (state === 'loading' || state === 'added') return
    setState('loading')
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/negative-keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalCampaignId, externalAdGroupId,
          keywordText,
          matchType: 'NEGATIVE_EXACT',
          scope: 'AD_GROUP',
          marketplace,
        }),
      })
      const data = await res.json()
      if (res.status === 403 && data.error === 'write_gate_denied') {
        setState('denied')
        setTooltip(`Write gate denied: ${data.reason} (at ${data.deniedAt})`)
        return
      }
      if (!res.ok) {
        setState('error')
        setTooltip(`Failed: ${data.error ?? `HTTP ${res.status}`}`)
        return
      }
      setState('added')
      setTooltip(data.alreadyExisted
        ? 'Already exists locally — no Amazon call made.'
        : `Negative created · ID ${data.externalNegativeKeywordId ?? '(sandbox)'}`)
    } catch (e) {
      setState('error')
      setTooltip(String(e))
    }
  }

  const stateConfig = {
    idle: {
      label: '+ Negative',
      cls: 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 ring-amber-200 dark:ring-amber-800',
      icon: MinusCircle,
    },
    loading: {
      label: 'Adding…',
      cls: 'text-slate-500 bg-slate-100 dark:bg-slate-800 ring-slate-200 dark:ring-slate-700 cursor-wait',
      icon: Loader2,
    },
    added: {
      label: 'Added',
      cls: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 ring-emerald-200 dark:ring-emerald-800 cursor-default',
      icon: Check,
    },
    denied: {
      label: 'Denied',
      cls: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 ring-rose-200 dark:ring-rose-800',
      icon: X,
    },
    error: {
      label: 'Failed',
      cls: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 ring-rose-200 dark:ring-rose-800',
      icon: X,
    },
  }[state]

  const Icon = stateConfig.icon
  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading' || state === 'added'}
      title={tooltip}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-wider font-medium rounded ring-1 ring-inset transition-colors ${stateConfig.cls}`}
    >
      <Icon className={`h-3 w-3 ${state === 'loading' ? 'animate-spin' : ''}`} />
      {stateConfig.label}
    </button>
  )
}
