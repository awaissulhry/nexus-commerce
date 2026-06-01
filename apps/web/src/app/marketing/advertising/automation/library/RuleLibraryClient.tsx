'use client'

/**
 * AU.7 — Rule Library: 35+ automation templates with search + filter.
 * Categories: Sales, Efficiency, Defense, Discovery, Relevancy, Other.
 */

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { ArrowRight, Search, Zap } from 'lucide-react'
import { TEMPLATES, TRIGGERS, ACTION_TYPES } from '../../_shared/rule-catalog'

const CAT_COLORS: Record<string, { chip: string; dot: string }> = {
  Sales:      { chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300', dot: 'bg-emerald-500' },
  Efficiency: { chip: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300', dot: 'bg-blue-500' },
  Defense:    { chip: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300', dot: 'bg-rose-500' },
  Discovery:  { chip: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300', dot: 'bg-violet-500' },
  Relevancy:  { chip: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300', dot: 'bg-amber-500' },
  Other:      { chip: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', dot: 'bg-slate-400' },
}
const ALL_CATS = ['All', 'Sales', 'Efficiency', 'Defense', 'Discovery', 'Relevancy', 'Other'] as const
type Cat = typeof ALL_CATS[number]

const triggerLabel = (t: string) => TRIGGERS.find((x) => x.key === t)?.label ?? t
const actionLabel = (t: string) => ACTION_TYPES.find((x) => x.type === t)?.label ?? t

export function RuleLibraryClient() {
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState<Cat>('All')

  const filtered = useMemo(() => TEMPLATES.filter((t) => {
    if (cat !== 'All' && t.category !== cat) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.trigger.toLowerCase().includes(q)
  }), [search, cat])

  const catCounts = useMemo(() => {
    const m: Record<string, number> = { All: TEMPLATES.length }
    for (const tmpl of TEMPLATES) m[tmpl.category] = (m[tmpl.category] ?? 0) + 1
    return m
  }, [])

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Rule library</h1>
          <p className="text-xs text-slate-500">{TEMPLATES.length} automations ready to launch — each starts dry-run so you review before going live.</p>
        </div>
        <Link href="/marketing/advertising/automation/new" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300">
          <Zap className="h-3.5 w-3.5" /> Custom rule
        </Link>
      </div>

      {/* Search + filter */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${TEMPLATES.length} templates…`} className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none" />
        </div>
        <div className="flex gap-1 flex-wrap">
          {ALL_CATS.map((c) => (
            <button key={c} onClick={() => setCat(c)} className={`px-2.5 py-1 text-xs rounded-md border transition ${cat === c ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              {c !== 'All' && <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${CAT_COLORS[c]?.dot ?? 'bg-slate-400'}`} />}{c}
              <span className="opacity-60 ml-1 text-[10px]">{catCounts[c] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-10 text-sm text-slate-400">No templates match &ldquo;{search}&rdquo; in {cat}.</div>
      )}

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map((t) => {
          const colors = CAT_COLORS[t.category] ?? CAT_COLORS.Other
          return (
            <div key={t.key} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 flex flex-col hover:shadow-sm transition-shadow">
              <div className="flex items-start justify-between mb-1 gap-2">
                <span className="font-medium text-sm text-slate-800 dark:text-slate-100 leading-snug">{t.name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${colors.chip}`}>{t.category}</span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 flex-1 line-clamp-3">{t.description}</p>
              <div className="text-[11px] text-slate-400 space-y-0.5 mb-3">
                <div><span>Trigger</span> <span className="text-slate-600 dark:text-slate-300">{triggerLabel(t.trigger)}</span></div>
                {t.conditions.length > 0 && <div><span>If</span> <span className="text-slate-500">{t.conditions.map((c, i) => `${i ? ' and ' : ''}${c.field} ${c.op} ${c.value}`).join('')}</span></div>}
                <div><span>Then</span> <span className="text-slate-600 dark:text-slate-300">{t.actions.slice(0, 2).map((a, i) => <span key={i}>{i > 0 ? ' + ' : ''}{actionLabel((a as {type:string}).type)}</span>)}{t.actions.length > 2 ? ` +${t.actions.length - 2}` : ''}</span></div>
              </div>
              <Link href={`/marketing/advertising/automation/new?template=${t.key}`} className="mt-auto inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium">
                Use template <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
