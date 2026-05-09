'use client'

import { useEffect, useState } from 'react'
import { Mail, Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import type { T } from '../_lib/types'

/**
 * DO.40 — scheduled email digest config.
 *
 * Embedded inside CustomizeSheet so the operator manages digest
 * subscriptions in the same place they tweak the layout. Lists
 * existing rows + an inline "Add new" form. Each row has a
 * one-click "Test send" that fires the digest immediately to the
 * configured email (no persistence change, useful for QA before
 * relying on the cron).
 *
 * The shared email transport is dryRun by default
 * (NEXUS_ENABLE_OUTBOUND_EMAILS gate); the UI doesn't try to
 * detect that — sends always claim success when the API returns
 * ok=true, and the operator confirms real delivery on receipt.
 */

interface ScheduledReport {
  id: string
  email: string
  frequency: 'daily' | 'weekly' | 'monthly'
  hourLocal: number
  isActive: boolean
  lastSentAt: string | null
  createdAt: string
}

export default function ScheduledReportsSection({ t }: { t: T }) {
  const [reports, setReports] = useState<ScheduledReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Add-new form state
  const [newEmail, setNewEmail] = useState('')
  const [newFreq, setNewFreq] = useState<ScheduledReport['frequency']>('daily')
  const [newHour, setNewHour] = useState(8)
  const [adding, setAdding] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/reports`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { rows: ScheduledReport[] }
      setReports(json.rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const create = async () => {
    if (!newEmail.trim()) return
    setAdding(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          frequency: newFreq,
          hourLocal: newHour,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      setNewEmail('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await fetch(`${getBackendUrl()}/api/dashboard/reports/${id}`, {
        method: 'DELETE',
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleActive = async (id: string, isActive: boolean) => {
    try {
      await fetch(`${getBackendUrl()}/api/dashboard/reports/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const testSend = async (r: ScheduledReport) => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/digest/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: r.email, frequency: r.frequency }),
      })
      const j = await res.json().catch(() => ({ ok: false }))
      if (j?.ok) {
        setError(null)
      } else {
        setError(j?.error ?? 'send failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const inputClass = cn(
    'h-7 px-2 text-sm rounded-md border tabular-nums',
    'border-slate-200 dark:border-slate-700',
    'bg-white dark:bg-slate-900',
    'text-slate-700 dark:text-slate-300',
    'placeholder:text-slate-400 dark:placeholder:text-slate-500',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
  )

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold mb-1.5 inline-flex items-center gap-1">
        <Mail className="w-3 h-3" />
        {t('overview.reports.heading')}
      </div>
      {loading ? (
        <div className="text-sm text-slate-500 dark:text-slate-400 italic">
          {t('common.loading')}
        </div>
      ) : (
        <ul className="border border-slate-200 dark:border-slate-800 rounded-md divide-y divide-slate-100 dark:divide-slate-800">
          {reports.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 italic">
              {t('overview.reports.empty')}
            </li>
          )}
          {reports.map((r) => (
            <li
              key={r.id}
              className="px-3 py-2 flex items-center gap-2 flex-wrap"
            >
              <input
                type="checkbox"
                checked={r.isActive}
                onChange={(e) => void toggleActive(r.id, e.target.checked)}
                aria-label={t('overview.reports.activeAria')}
                className="w-4 h-4 rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-500/40"
              />
              <span className="text-sm text-slate-700 dark:text-slate-300 truncate flex-1 min-w-0">
                {r.email}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {t(`overview.reports.frequency.${r.frequency}`)} ·{' '}
                {String(r.hourLocal).padStart(2, '0')}:00
              </span>
              <button
                type="button"
                onClick={() => void testSend(r)}
                title={t('overview.reports.testSend')}
                aria-label={t('overview.reports.testSend')}
                className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <Send className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => void remove(r.id)}
                title={t('overview.reports.delete')}
                aria-label={t('overview.reports.delete')}
                className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-500 dark:text-slate-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 hover:text-rose-700 dark:hover:text-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={t('overview.reports.emailPlaceholder')}
          aria-label={t('overview.reports.emailLabel')}
          className={cn(inputClass, 'flex-1 min-w-0')}
        />
        <select
          value={newFreq}
          onChange={(e) => setNewFreq(e.target.value as ScheduledReport['frequency'])}
          aria-label={t('overview.reports.frequencyAria')}
          className={inputClass}
        >
          <option value="daily">{t('overview.reports.frequency.daily')}</option>
          <option value="weekly">{t('overview.reports.frequency.weekly')}</option>
          <option value="monthly">{t('overview.reports.frequency.monthly')}</option>
        </select>
        <input
          type="number"
          value={newHour}
          min={0}
          max={23}
          onChange={(e) => setNewHour(Number(e.target.value))}
          aria-label={t('overview.reports.hourAria')}
          className={cn(inputClass, 'w-14')}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={create}
          loading={adding}
          disabled={!newEmail.trim()}
        >
          {t('overview.reports.add')}
        </Button>
      </div>

      {error && (
        <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}
    </div>
  )
}
