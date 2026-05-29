'use client'

/** AX3.8 — Rule Library: categorized starter templates (Pacvue-style). Each
 *  shows its When/If/Then; "Use template" opens the builder pre-filled. */

import Link from 'next/link'
import { ChevronLeft, ArrowRight } from 'lucide-react'
import { TEMPLATES, TRIGGERS, OPS, CONDITION_FIELDS, ACTION_TYPES } from '../../_shared/rule-catalog'

const CAT_CHIP: Record<string, string> = {
  Sales: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  Relevancy: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  Other: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
}
const fieldLabel = (f: string) => CONDITION_FIELDS.find((x) => x.field === f)?.label ?? f
const opLabel = (o: string) => OPS.find((x) => x.op === o)?.label ?? o
const actionLabel = (t: string) => ACTION_TYPES.find((x) => x.type === t)?.label ?? t
const triggerLabel = (t: string) => TRIGGERS.find((x) => x.key === t)?.label ?? t

export function RuleLibraryClient() {
  const cats = ['Sales', 'Relevancy', 'Other'] as const
  return (
    <div className="max-w-[1000px]">
      <Link href="/marketing/advertising/automation" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> Automation</Link>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">Rule library</h1>
      <p className="text-sm text-slate-500 mb-4">Proven automations you can launch in one click — each opens the builder pre-filled so you can tweak thresholds before going live (saves dry-run first).</p>

      {cats.map((cat) => {
        const items = TEMPLATES.filter((t) => t.category === cat)
        if (!items.length) return null
        return (
          <div key={cat} className="mb-6">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{cat}</div>
            <div className="grid md:grid-cols-2 gap-3">
              {items.map((t) => (
                <div key={t.key} className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{t.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${CAT_CHIP[t.category]}`}>{t.category}</span>
                  </div>
                  <p className="text-xs text-slate-500 mb-2">{t.description}</p>
                  <div className="text-[11px] text-slate-500 space-y-0.5 mb-3">
                    <div><span className="text-slate-400">When</span> {triggerLabel(t.trigger)}</div>
                    <div><span className="text-slate-400">If</span> {t.conditions.map((c, i) => <span key={i}>{i > 0 ? ' and ' : ''}{fieldLabel(c.field)} {opLabel(c.op)} {c.value}</span>)}</div>
                    <div><span className="text-slate-400">Then</span> {t.actions.map((a, i) => <span key={i}>{i > 0 ? ', ' : ''}{actionLabel((a as { type: string }).type)}</span>)}</div>
                  </div>
                  <Link href={`/marketing/advertising/automation/new?template=${t.key}`} className="mt-auto inline-flex items-center justify-center gap-1 px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">Use template <ArrowRight size={14} /></Link>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
