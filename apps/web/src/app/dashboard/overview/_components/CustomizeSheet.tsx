'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { T } from '../_lib/types'

/**
 * DO.32 — dashboard customise sheet.
 *
 * Displays a checkbox per toggleable widget. Unchecked = hidden.
 * Saves via PUT /api/dashboard/layout; on success the parent
 * re-fetches the dashboard payload so the layout updates without
 * a hard reload.
 *
 * KpiGrid + AlertsPanel are intentionally omitted from the toggle
 * list — they're the operator's two non-negotiable signals
 * (financial state + what needs attention right now). Hiding
 * either turns the Command Center into a hollow shell.
 */

export interface ToggleableWidget {
  id: string
  labelKey: string
}

export const TOGGLEABLE_WIDGETS: ToggleableWidget[] = [
  { id: 'sparkline', labelKey: 'overview.customize.widget.sparkline' },
  { id: 'channelTrend', labelKey: 'overview.customize.widget.channelTrend' },
  { id: 'channelGrid', labelKey: 'overview.customize.widget.channelGrid' },
  { id: 'marketplaceMatrix', labelKey: 'overview.customize.widget.marketplaceMatrix' },
  { id: 'financial', labelKey: 'overview.customize.widget.financial' },
  { id: 'predictive', labelKey: 'overview.customize.widget.predictive' },
  { id: 'topProducts', labelKey: 'overview.customize.widget.topProducts' },
  { id: 'goals', labelKey: 'overview.customize.widget.goals' },
  { id: 'customer', labelKey: 'overview.customize.widget.customer' },
  { id: 'catalog', labelKey: 'overview.customize.widget.catalog' },
  { id: 'activity', labelKey: 'overview.customize.widget.activity' },
  { id: 'quickActions', labelKey: 'overview.customize.widget.quickActions' },
]

export default function CustomizeSheet({
  t,
  open,
  onClose,
  hiddenWidgets,
  onSaved,
}: {
  t: T
  open: boolean
  onClose: () => void
  hiddenWidgets: string[]
  onSaved: (next: string[]) => void
}) {
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(hiddenWidgets),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed draft whenever the modal opens with a different baseline.
  // (The parent passes the latest hiddenWidgets each render; we
  // resync on open so cancelling a previous edit doesn't poison
  // the next session.)
  if (open && draft.size === 0 && hiddenWidgets.length > 0 && !saving) {
    setDraft(new Set(hiddenWidgets))
  }

  const toggle = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = Array.from(draft)
      const res = await fetch(`${getBackendUrl()}/api/dashboard/layout`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hiddenWidgets: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onSaved(next)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <Modal open={open} onClose={onClose} title={t('overview.customize.title')}>
      <div className="px-4 py-3 space-y-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('overview.customize.description')}
        </p>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-md">
          {TOGGLEABLE_WIDGETS.map((w) => {
            const checked = !draft.has(w.id)
            return (
              <li key={w.id}>
                <label
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 cursor-pointer text-base',
                    'hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(w.id)}
                    className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500/40"
                  />
                  <span className="text-slate-800 dark:text-slate-200">
                    {t(w.labelKey)}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        {error && (
          <div className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>
          {t('common.save')}
        </Button>
      </div>
    </Modal>
  )
}
