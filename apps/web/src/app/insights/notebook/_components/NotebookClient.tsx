'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Bookmark,
  ChevronLeft,
  Plus,
  Tag,
  Trash2,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { DateField } from '@/design-system/components/DateField'
import { cn } from '@/lib/utils'

interface Annotation {
  id: string
  date: string
  title: string
  body: string
  tags: string[]
  createdAt: string
}

const STORAGE_KEY = 'insights.notebook.v1'

function loadAnnotations(): Annotation[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as Annotation[]
    return []
  } catch {
    return []
  }
}

function persistAnnotations(list: Annotation[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export default function NotebookClient() {
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [date, setDate] = useState(() => todayIso())
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [filterTag, setFilterTag] = useState<string | null>(null)

  useEffect(() => {
    setAnnotations(loadAnnotations())
  }, [])

  function addAnnotation() {
    if (!title.trim()) return
    const next: Annotation = {
      id: crypto.randomUUID(),
      date,
      title: title.trim(),
      body: body.trim(),
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      createdAt: new Date().toISOString(),
    }
    const updated = [next, ...annotations]
    setAnnotations(updated)
    persistAnnotations(updated)
    setTitle('')
    setBody('')
    setTags('')
  }

  function deleteAnnotation(id: string) {
    const updated = annotations.filter((a) => a.id !== id)
    setAnnotations(updated)
    persistAnnotations(updated)
  }

  const allTags = Array.from(
    new Set(annotations.flatMap((a) => a.tags)),
  ).sort()

  const filtered = filterTag
    ? annotations.filter((a) => a.tags.includes(filterTag))
    : annotations

  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>

      <div className="mb-5">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 mb-1">
          Notebook & annotations
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Drop a note against a date — promo launched, supplier issue, new 3PL,
          campaign change — so future-you remembers what drove a chart.
        </p>
      </div>

      <Card title="New entry" className="mb-3">
        <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr_180px] gap-2 mb-2">
          <DateField
            value={date}
            onChange={setDate}
            clearable={false}
            ariaLabel="Entry date"
          />
          <input
            type="text"
            placeholder="Title (e.g. 'Launched Black Friday promo')"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 px-2 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
          <input
            type="text"
            placeholder="Tags (comma-separated)"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="h-8 px-2 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
        </div>
        <textarea
          rows={3}
          placeholder="Details (optional)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="w-full px-2 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 resize-y"
        />
        <div className="flex items-center justify-end mt-2">
          <button
            type="button"
            onClick={addAnnotation}
            disabled={!title.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            Add entry
          </button>
        </div>
      </Card>

      {allTags.length > 0 && (
        <div className="mb-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 mr-1">
            Filter by tag
          </span>
          <button
            type="button"
            onClick={() => setFilterTag(null)}
            className={cn(
              'h-6 px-2 text-xs rounded-md border',
              filterTag === null
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                : 'border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
          >
            All
          </button>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setFilterTag(t === filterTag ? null : t)}
              className={cn(
                'inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border',
                filterTag === t
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                  : 'border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              <Tag className="w-3 h-3" />
              {t}
            </button>
          ))}
        </div>
      )}

      <Card
        title="Timeline"
        description={
          annotations.length === 0
            ? 'No entries yet — add the first one above'
            : `${annotations.length} entr${annotations.length === 1 ? 'y' : 'ies'}, sorted by date descending`
        }
      >
        {sorted.length === 0 ? (
          <div className="text-center py-10 text-slate-500">
            <Bookmark className="w-6 h-6 mx-auto opacity-40 mb-2" />
            <p className="text-sm">No entries match the current filter.</p>
          </div>
        ) : (
          <ol className="space-y-2">
            {sorted.map((a) => (
              <li
                key={a.id}
                className="rounded-md border border-default dark:border-slate-700 p-3 flex items-start gap-3"
              >
                <div className="shrink-0 w-20 tabular-nums text-xs text-slate-500 dark:text-slate-400">
                  {a.date}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {a.title}
                  </div>
                  {a.body && (
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 whitespace-pre-wrap">
                      {a.body}
                    </p>
                  )}
                  {a.tags.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {a.tags.map((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center gap-0.5 h-4 px-1.5 text-[10px] rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                        >
                          <Tag className="w-2.5 h-2.5" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => deleteAnnotation(a.id)}
                  className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-tertiary hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  aria-label="Delete entry"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}
