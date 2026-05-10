'use client'

// MC.8.3 — module palette (left rail).
//
// Lists every spec from MODULE_SPECS grouped by `group` and tier-
// labelled. Click a card to append it to the canvas.
//
// Premium tier modules are dimmed slightly so the operator sees they
// require Brand Registry — but they're still clickable; if the
// account isn't on premium, Amazon's submission API will reject it
// at /createContentDocument time (handled in MC.8.9). No need to
// gate creation here.

import { useMemo, useState } from 'react'
import { ChevronDown, Plus, Sparkles, BadgeCheck } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  MODULE_SPECS,
  type ModuleSpec,
  type ModuleTier,
} from '../_lib/modules'

interface Props {
  onAdd: (spec: ModuleSpec) => void
  disabled?: boolean
}

export default function ModulePalette({ onAdd, disabled }: Props) {
  const { t } = useTranslations()
  const [filter, setFilter] = useState('')

  const grouped = useMemo(() => {
    const filtered = MODULE_SPECS.filter((m) => {
      if (!filter.trim()) return true
      const q = filter.trim().toLowerCase()
      return (
        m.label.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.group.toLowerCase().includes(q)
      )
    })
    const map = new Map<string, ModuleSpec[]>()
    for (const m of filtered) {
      const list = map.get(m.group)
      if (list) list.push(m)
      else map.set(m.group, [m])
    }
    return [...map.entries()]
  }, [filter])

  return (
    <aside
      aria-label={t('aplus.builder.paletteLabel')}
      className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('aplus.builder.paletteTitle')}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t('aplus.builder.paletteHint')}
        </p>
      </header>
      <div className="border-b border-slate-200 p-2 dark:border-slate-800">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('aplus.builder.paletteSearch')}
          aria-label={t('aplus.builder.paletteSearch')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
        {grouped.length === 0 ? (
          <p className="px-3 py-4 text-xs text-slate-500 dark:text-slate-400">
            {t('aplus.builder.paletteEmpty')}
          </p>
        ) : (
          grouped.map(([group, specs]) => (
            <details
              key={group}
              open
              className="group border-b border-slate-100 last:border-b-0 dark:border-slate-800"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50">
                {group}
                <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
              </summary>
              <ul className="px-1.5 pb-1.5">
                {specs.map((spec) => (
                  <li key={spec.id}>
                    <button
                      type="button"
                      onClick={() => onAdd(spec)}
                      disabled={disabled}
                      className="group/item flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950/40"
                    >
                      <TierIcon tier={spec.tier} />
                      <div className="flex-1 min-w-0">
                        <p className="flex items-center gap-1 text-sm font-medium text-slate-900 dark:text-slate-100">
                          <span className="truncate">{spec.label}</span>
                          {!spec.rendererImplemented && (
                            <span className="rounded bg-slate-100 px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                              {t('aplus.builder.rendererSoon')}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {spec.description}
                        </p>
                      </div>
                      <Plus className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 opacity-0 group-hover/item:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))
        )}
      </div>
    </aside>
  )
}

function TierIcon({ tier }: { tier: ModuleTier }) {
  if (tier === 'premium')
    return (
      <Sparkles
        className="w-4 h-4 flex-shrink-0 text-amber-500"
        aria-label="Premium tier (Brand Registry)"
      />
    )
  return (
    <BadgeCheck
      className="w-4 h-4 flex-shrink-0 text-slate-400"
      aria-label="Standard tier"
    />
  )
}
