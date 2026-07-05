'use client'

import { useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { CircleDot, Download, RefreshCw, Settings2 } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Listbox } from '@/design-system/components/Listbox'
import { DateField } from '@/design-system/components/DateField'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import RelativeTimestamp from './RelativeTimestamp'
import {
  COMPARES,
  WINDOWS,
  type CompareKey,
  type CustomRange,
  type T,
  type WindowKey,
} from '../_lib/types'

/**
 * Command Center page header. Title + subtitle on the left, window
 * selector + comparison-period dropdown + refresh + last-refreshed
 * timestamp on the right via PageHeader's `actions` slot.
 *
 * Window selector stays as a custom inline pill cluster — Button
 * carries chrome (border, focus ring, h-7) that would break the
 * tight 5-segment pill look. Refresh wears the standard Button to
 * pick up dark-mode + focus-ring + loading state for free.
 */
export default function Header({
  t,
  currentWindow,
  onWindowChange,
  currentCompare,
  onCompareChange,
  customRange,
  onCustomRangeChange,
  liveMode,
  onLiveModeChange,
  lastRefreshed,
  refreshing,
  onRefresh,
  onCustomize,
  views,
  activeViewId,
  onApplyView,
}: {
  t: T
  currentWindow: WindowKey
  onWindowChange: (w: WindowKey) => void
  currentCompare: CompareKey
  onCompareChange: (c: CompareKey) => void
  customRange: CustomRange
  onCustomRangeChange: (next: CustomRange) => void
  liveMode: boolean
  onLiveModeChange: (next: boolean) => void
  lastRefreshed: number
  refreshing: boolean
  onRefresh: () => void
  onCustomize: () => void
  views: Array<{ id: string; name: string; isDefault: boolean }>
  activeViewId: string | null
  onApplyView: (id: string | '__live__') => void
}) {
  return (
    <PageHeader
      title={t('overview.title')}
      description={t('overview.subtitle')}
      actions={
        <>
          <div
            role="tablist"
            aria-label={t('overview.title')}
            className="inline-flex items-center border border-default dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900"
          >
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={w.id === currentWindow}
                aria-current={w.id === currentWindow ? 'true' : undefined}
                onClick={() => onWindowChange(w.id)}
                className={cn(
                  'h-6 px-2.5 text-sm rounded transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                  w.id === currentWindow
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                {t(`overview.window.${w.id}`)}
              </button>
            ))}
          </div>
          {/* DO.25 — custom range pair. Renders only when "Custom"
              is the active window. DateField gives a zero-native-chrome
              calendar popover (Wave-1 conformance) without pulling in
              a date library. */}
          {currentWindow === 'custom' && (
            <div className="inline-flex items-center gap-1">
              <DateField
                ariaLabel={t('overview.customRange.from')}
                value={customRange.from}
                max={customRange.to}
                onChange={(v) =>
                  onCustomRangeChange({ ...customRange, from: v })
                }
                className="w-36 tabular-nums"
              />
              <span className="text-xs text-tertiary dark:text-slate-500">
                →
              </span>
              <DateField
                ariaLabel={t('overview.customRange.to')}
                value={customRange.to}
                min={customRange.from}
                onChange={(v) =>
                  onCustomRangeChange({ ...customRange, to: v })
                }
                className="w-36 tabular-nums"
              />
            </div>
          )}
          {/* DO.39 — saved-view picker. Renders only when the
              operator has at least one named view. "__live__"
              represents "no view active, layout is whatever the
              operator currently has set". */}
          {views.length > 0 && (
            <Listbox
              ariaLabel={t('overview.views.aria')}
              value={activeViewId ?? '__live__'}
              onChange={(v) => onApplyView(v as string | '__live__')}
              className="w-44"
              options={[
                { value: '__live__', label: t('overview.views.live') },
                ...views.map((v) => ({
                  value: v.id,
                  label: `${v.name}${v.isDefault ? ' ★' : ''}`,
                })),
              ]}
            />
          )}
          {/* DO.11 — comparison-period dropdown. Listbox is the
              DS-conformant primitive here (Wave-1): keyboard /
              screen-reader affordances, no native chrome, and the
              option set is small. */}
          <Listbox
            ariaLabel={t('overview.compare.aria')}
            value={currentCompare}
            onChange={(v) => onCompareChange(v as CompareKey)}
            className="w-44"
            options={COMPARES.map((c) => ({
              value: c.id,
              label: `${t('overview.compare.prefix')} ${t(`overview.compare.${c.id}`)}`,
            }))}
          />
          {/* DO.16 — live-mode toggle. Stripe-pattern emerald dot
              when on; dim slate when off. role="switch" gives the
              right keyboard / screen-reader semantics for a binary
              toggle (vs a button that suggests one-shot action). */}
          <button
            type="button"
            role="switch"
            aria-checked={liveMode}
            aria-label={t(liveMode ? 'overview.live.on' : 'overview.live.off')}
            onClick={() => onLiveModeChange(!liveMode)}
            title={t(liveMode ? 'overview.live.on' : 'overview.live.off')}
            className={cn(
              'inline-flex items-center gap-1.5 h-7 px-2.5 text-sm font-medium rounded-md border transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              liveMode
                ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
                : 'border-default dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
          >
            <CircleDot
              className={cn(
                'w-3 h-3',
                liveMode && 'animate-pulse',
              )}
            />
            {t(liveMode ? 'overview.live.on' : 'overview.live.off')}
          </button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onRefresh}
            loading={refreshing}
            icon={!refreshing ? <RefreshCw className="w-3 h-3" /> : undefined}
          >
            {t('overview.refresh')}
          </Button>
          {/* DO.41 / DO.48 — PDF download with frequency picker.
              Click the icon → menu opens with daily / weekly /
              monthly choices. Each option is an anchor with the
              `download` attribute so the browser saves directly. */}
          <PdfExportMenu t={t} />
          {/* DO.32 — customise (icon-only on narrow viewports). */}
          <button
            type="button"
            onClick={onCustomize}
            title={t('overview.customize.title')}
            aria-label={t('overview.customize.title')}
            className={cn(
              'inline-flex items-center justify-center h-7 w-7 rounded-md border',
              'border-default dark:border-slate-700',
              'bg-white dark:bg-slate-900',
              'text-slate-500 dark:text-slate-400',
              'hover:bg-slate-50 dark:hover:bg-slate-800',
              'hover:text-slate-700 dark:hover:text-slate-200',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
            )}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <RelativeTimestamp t={t} at={lastRefreshed} />
        </>
      }
    />
  )
}

function PdfExportMenu({ t }: { t: T }) {
  const [open, setOpen] = useState(false)
  const items = [
    { id: 'daily', labelKey: 'overview.exportPdf.daily' },
    { id: 'weekly', labelKey: 'overview.exportPdf.weekly' },
    { id: 'monthly', labelKey: 'overview.exportPdf.monthly' },
  ] as const
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => {
          // Close when focus leaves the menu container.
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
            setTimeout(() => setOpen(false), 100)
          }
        }}
        title={t('overview.exportPdf')}
        aria-label={t('overview.exportPdf')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center justify-center h-7 w-7 rounded-md border',
          'border-default dark:border-slate-700',
          'bg-white dark:bg-slate-900',
          'text-slate-500 dark:text-slate-400',
          'hover:bg-slate-50 dark:hover:bg-slate-800',
          'hover:text-slate-700 dark:hover:text-slate-200',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
      >
        <Download className="w-3.5 h-3.5" />
      </button>
      {open && (
        <ul
          role="menu"
          className={cn(
            'absolute right-0 top-full mt-1 z-30 min-w-[160px] py-1 rounded-md border shadow-lg',
            'border-default dark:border-slate-700',
            'bg-white dark:bg-slate-900',
          )}
        >
          {items.map((it) => (
            <li key={it.id} role="none">
              <a
                role="menuitem"
                href={`${getBackendUrl()}/api/dashboard/export/pdf?frequency=${it.id}`}
                download
                onClick={() => setOpen(false)}
                className={cn(
                  'block px-3 py-1.5 text-sm',
                  'text-slate-700 dark:text-slate-300',
                  'hover:bg-slate-50 dark:hover:bg-slate-800',
                  'focus:outline-none focus:bg-slate-50 dark:focus:bg-slate-800',
                )}
              >
                {t(it.labelKey)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
