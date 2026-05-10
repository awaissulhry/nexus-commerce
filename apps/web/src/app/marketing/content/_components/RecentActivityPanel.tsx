'use client'

// MC.14.4 — Recent activity feed for the Content Hub.
//
// Reads /api/assets/activity and renders the last N events with a
// per-action icon + relative time. Operators get a forensic trail at
// a glance: who uploaded what, which channel publishes succeeded,
// out-of-band Cloudinary deletions, A+ submissions, automation
// fires.

import { useEffect, useState } from 'react'
import {
  Activity,
  Upload,
  Trash2,
  Send,
  Sparkles,
  FileText,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ActivityEvent {
  id: string
  action: string
  entityType: string
  entityId: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

interface Props {
  apiBase: string
}

function iconFor(action: string): LucideIcon {
  if (action.startsWith('CHANNEL_PUBLISH_')) return Send
  if (action.startsWith('CLOUDINARY_WEBHOOK_DELETE')) return Trash2
  if (action.startsWith('CLOUDINARY_WEBHOOK_')) return Upload
  if (action.startsWith('APLUS_')) return FileText
  if (action.startsWith('BRAND_STORY_')) return FileText
  if (action.startsWith('AUTOMATION_')) return Sparkles
  return Upload
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const seconds = Math.round((now - then) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function describeAction(action: string): string {
  return action
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
}

export default function RecentActivityPanel({ apiBase }: Props) {
  const { t } = useTranslations()
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBase}/api/assets/activity?limit=15`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d: { events: ActivityEvent[] }) => {
        if (!cancelled) setEvents(d.events)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [apiBase])

  if (loading) return null
  if (events.length === 0) return null

  return (
    <section
      aria-label={t('marketingContent.activity.label')}
      className="rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
    >
      <header className="mb-2 flex items-center gap-1.5">
        <Activity className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t('marketingContent.activity.title')}
        </h3>
      </header>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {events.map((e) => {
          const Icon = iconFor(e.action)
          const channel = (e.metadata?.channel as string | undefined) ?? null
          return (
            <li key={e.id} className="flex items-center gap-2 py-1.5 text-xs">
              <Icon className="w-3.5 h-3.5 flex-shrink-0 text-slate-400" />
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {describeAction(e.action)}
              </span>
              {channel && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {channel}
                </span>
              )}
              <span className="ml-auto text-slate-400">
                {relativeTime(e.createdAt)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
