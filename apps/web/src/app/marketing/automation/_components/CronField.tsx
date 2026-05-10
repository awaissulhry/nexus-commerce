'use client'

// MC.11.6 — Cron expression input with validation + presets +
// next-firings preview.

import { useMemo, useState } from 'react'
import { Clock, Sparkles, AlertTriangle, ChevronDown } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { CRON_PRESETS, validateCron, nextFirings } from '../_lib/cron'

interface Props {
  value: string
  onChange: (v: string) => void
  label: string
  required?: boolean
}

export default function CronField({ value, onChange, label, required }: Props) {
  const { t } = useTranslations()
  const [presetsOpen, setPresetsOpen] = useState(false)

  const validation = useMemo(() => validateCron(value || '0 2 * * *'), [value])
  const upcoming = useMemo(
    () => (validation.ok ? nextFirings(value, 5) : []),
    [value, validation.ok],
  )

  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </span>
      </label>

      <div className="flex gap-1.5">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 2 * * *"
          className={`flex-1 rounded border bg-white px-2 py-1 font-mono text-xs dark:bg-slate-950 dark:text-slate-100 ${
            validation.ok || !value
              ? 'border-slate-300 dark:border-slate-700'
              : 'border-red-400 dark:border-red-700'
          }`}
        />
        <button
          type="button"
          onClick={() => setPresetsOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <Sparkles className="w-3 h-3" />
          {t('cron.presetsBtn')}
          <ChevronDown
            className={`w-3 h-3 transition-transform ${presetsOpen ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {presetsOpen && (
        <ul className="space-y-1 rounded-md border border-slate-200 bg-white p-1.5 dark:border-slate-700 dark:bg-slate-900">
          {CRON_PRESETS.map((preset) => (
            <li key={preset.expression}>
              <button
                type="button"
                onClick={() => {
                  onChange(preset.expression)
                  setPresetsOpen(false)
                }}
                className="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                  {preset.expression}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-900 dark:text-slate-100">
                    {preset.label}
                  </p>
                  <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                    {preset.description}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {value &&
        (validation.ok ? (
          <div className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-[11px] dark:border-emerald-900 dark:bg-emerald-950/30">
            <p className="font-medium text-emerald-900 dark:text-emerald-200">
              {validation.description}
            </p>
            {upcoming.length > 0 && (
              <div className="text-emerald-800 dark:text-emerald-300">
                <p className="text-[10px] font-semibold uppercase tracking-wide">
                  {t('cron.nextRunsLabel')}
                </p>
                <ul className="mt-0.5 space-y-0.5 font-mono text-[10px]">
                  {upcoming.map((iso) => (
                    <li key={iso}>{new Date(iso).toLocaleString()}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>{validation.error}</span>
          </div>
        ))}
    </div>
  )
}
