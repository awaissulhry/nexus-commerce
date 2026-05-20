'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ChevronLeft,
  Eye,
  Megaphone,
  Package,
  PiggyBank,
  Receipt,
  Sparkles,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  readFilterState,
  type InsightsFilterState,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface BriefAction {
  title: string
  rationale: string
  area:
    | 'pricing'
    | 'advertising'
    | 'inventory'
    | 'product'
    | 'customer'
    | 'fiscal'
    | 'other'
  urgency: 'today' | 'this_week' | 'this_month'
}

interface BriefSection {
  heading: string
  bullets: string[]
}

interface ExecutiveBrief {
  language: 'it' | 'en'
  generatedAt: string
  window: { from: string; to: string }
  tldr: string
  sections: BriefSection[]
  topActions: BriefAction[]
  watchlist: string[]
  modelUsed: string
  costUsd: number
}

const AREA_ICON: Record<BriefAction['area'], typeof Sparkles> = {
  pricing: PiggyBank,
  advertising: Megaphone,
  inventory: Package,
  product: Sparkles,
  customer: Users,
  fiscal: Receipt,
  other: Eye,
}

const URGENCY_TONE: Record<BriefAction['urgency'], string> = {
  today: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  this_week: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  this_month: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
}

const URGENCY_LABEL: Record<BriefAction['urgency'], { it: string; en: string }> = {
  today: { it: 'Oggi', en: 'Today' },
  this_week: { it: 'Questa settimana', en: 'This week' },
  this_month: { it: 'Questo mese', en: 'This month' },
}

function buildQuery(state: InsightsFilterState, language: 'it' | 'en'): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  p.set('language', language)
  return p
}

export default function BriefClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [brief, setBrief] = useState<ExecutiveBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [language, setLanguage] = useState<'it' | 'en'>('it')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (brief) setRefreshing(true)
      try {
        const qs = buildQuery(filterState, language).toString()
        const res = await fetch(`${getBackendUrl()}/api/insights/brief?${qs}`, {
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: ExecutiveBrief = await res.json()
        if (!cancelled) {
          setBrief(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    language,
    nonce,
  ])

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
      <InsightsHeader
        title="Executive brief"
        description={
          language === 'it'
            ? 'Brief AI-generato che riassume cosa è successo nella finestra selezionata, cosa monitorare, e le 3 prossime azioni.'
            : 'AI-generated narrative summarising the selected window, what to watch, and the next 3 actions.'
        }
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
        rightExtra={
          <div
            role="tablist"
            className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md p-0.5"
          >
            {(['it', 'en'] as const).map((code) => (
              <button
                key={code}
                type="button"
                role="tab"
                aria-selected={language === code}
                onClick={() => setLanguage(code)}
                className={cn(
                  'h-6 px-2.5 text-sm rounded font-semibold transition-colors',
                  language === code
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                {code.toUpperCase()}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading && !brief && (
        <Card title={language === 'it' ? 'Genero il brief…' : 'Generating brief…'}>
          <div className="py-10 text-center text-sm text-slate-500">
            <Sparkles className="w-6 h-6 mx-auto mb-2 opacity-40 animate-pulse" />
            <p>
              {language === 'it'
                ? 'Sto preparando il sommario — pochi secondi.'
                : 'Assembling the summary — a few seconds.'}
            </p>
          </div>
        </Card>
      )}

      {brief && (
        <>
          {brief.tldr && (
            <Card
              title="TL;DR"
              description={
                brief.modelUsed && brief.modelUsed !== 'unavailable'
                  ? `${brief.modelUsed} · ${language === 'it' ? 'generato' : 'generated'} ${new Date(brief.generatedAt).toLocaleString(language === 'it' ? 'it-IT' : 'en-US')}`
                  : undefined
              }
              className="mb-3"
            >
              <p className="text-sm leading-relaxed text-slate-900 dark:text-slate-100">
                {brief.tldr}
              </p>
            </Card>
          )}

          {brief.topActions.length > 0 && (
            <Card
              title={language === 'it' ? 'Le 3 prossime azioni' : 'Top 3 actions'}
              className="mb-3"
            >
              <ol className="space-y-2">
                {brief.topActions.map((action, i) => {
                  const Icon = AREA_ICON[action.area] ?? Sparkles
                  return (
                    <li
                      key={i}
                      className="flex items-start gap-3 rounded-md border border-slate-200 dark:border-slate-700 p-3"
                    >
                      <div className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {i + 1}. {action.title}
                          </span>
                          <span
                            className={cn(
                              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                              URGENCY_TONE[action.urgency],
                            )}
                          >
                            {URGENCY_LABEL[action.urgency][language]}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                            {action.area}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {action.rationale}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </Card>
          )}

          {brief.sections.map((section, i) => (
            <Card key={i} title={section.heading} className="mb-3">
              <ul className="space-y-1.5 list-disc list-inside marker:text-slate-400 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                {section.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </Card>
          ))}

          {brief.watchlist.length > 0 && (
            <Card
              title={language === 'it' ? 'Watchlist' : 'Watchlist'}
              description={
                language === 'it'
                  ? 'Metriche o eventi da tenere d\'occhio'
                  : 'Metrics or events worth keeping an eye on'
              }
              className="mb-3"
            >
              <ul className="space-y-1">
                {brief.watchlist.map((item, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200"
                  >
                    <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {brief.modelUsed === 'unavailable' && (
            <Card title={language === 'it' ? 'AI non disponibile' : 'AI unavailable'}>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {brief.tldr}
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
