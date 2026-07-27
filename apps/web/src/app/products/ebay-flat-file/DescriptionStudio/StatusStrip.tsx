'use client'

/**
 * DS-1 — the status strip docked under the preview: the Studio's truth
 * surface. Four sections, none of which ever hides a problem:
 *
 *  (a) render state — spinner / green "Rendered HH:MM:SS" / red
 *      "Render FAILED — {status}: {server error body}" with a Retry. (The
 *      preview pane keeps the last GOOD frame dimmed on failure; this strip
 *      is where the failure is spelled out.)
 *  (b) every `warnings[]` string from the render, VERBATIM, as amber rows —
 *      red-tinted when the string mentions an unknown token or a raw-body
 *      fallback (the two warnings that mean "the theme did not do its job").
 *  (c) truth echo — which theme actually rendered ("{name}" vN), RAW BODY in
 *      red when `themed: false`, an UNSAVED-draft notice while dirty (a push
 *      sends the saved version, never the editor's), and the inactive-theme
 *      fallback. The DS-0 empty-body warning arrives through (b) verbatim.
 *  (d) the staleness pill for the starred (previewing) product — including
 *      the gray "check failed" state.
 */

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/design-system/primitives/Button'
import { Spinner } from '@/design-system/primitives/Spinner'
import { StalenessPill } from './StalenessPill'
import type { StalenessEntry } from './types'

export interface RenderStatus {
  phase: 'idle' | 'rendering' | 'ok' | 'failed'
  /** Last GOOD html — survives failures so the frame dims instead of blanking. */
  html?: string
  /** HH:MM:SS of the last successful render. */
  renderedAt?: string
  themed?: boolean
  themeName?: string
  themeVersion?: number
  warnings: string[]
  errorStatus?: number
  errorBody?: string
}

/** Warnings that mean the theme did not do its job get the red tint. */
const isSevereWarning = (w: string) => {
  const s = w.toLowerCase()
  return s.includes('unknown token') || s.includes('raw body') || s.includes('raw-body')
}

export function StatusStrip({ render, onRetryRender, dirty, isNew, savedName, savedVersion, themeInactive, staleEntry, stalenessError, skuById }: {
  render: RenderStatus
  onRetryRender: () => void
  /** The editor holds unsaved edits — the preview shows the DRAFT html. */
  dirty: boolean
  /** No saved theme exists yet (new-theme draft). */
  isNew: boolean
  /** The SAVED theme a push would send while dirty. */
  savedName: string | null
  savedVersion: number | null
  /** The SAVED theme is inactive — a push renders the default instead. */
  themeInactive: boolean
  /** Staleness for the starred (previewing) product, if fetched. */
  staleEntry: StalenessEntry | null
  /** The staleness fetch failed — gray "unknown" pill, never green. */
  stalenessError: string | null
  skuById: Record<string, string>
}) {
  return (
    <div
      className="shrink-0 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2.5 py-2 flex flex-col gap-1.5"
      data-testid="description-status-strip"
    >
      {/* (a) render state */}
      <div className="flex items-center gap-2 min-h-[22px]">
        {render.phase === 'rendering' ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <Spinner size={12} /> Rendering exactly what a push would send…
          </span>
        ) : render.phase === 'failed' ? (
          <>
            <span className="inline-flex items-start gap-1 text-[11px] font-semibold text-red-600 dark:text-red-400 whitespace-pre-wrap min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              Render FAILED — {render.errorStatus ?? 'network'}: {render.errorBody ?? 'no error body'}
            </span>
            <Button size="sm" className="shrink-0 ml-auto" onClick={onRetryRender}>Retry</Button>
          </>
        ) : render.phase === 'ok' ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" aria-hidden />
            Rendered {render.renderedAt}
          </span>
        ) : (
          <span className="text-[11px] text-slate-400">No render yet — star a product chip and add theme HTML.</span>
        )}
      </div>

      {/* (b) every warning string, VERBATIM */}
      {render.warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {render.warnings.map((w, i) => (
            <p key={i} className={cn('text-[11px] whitespace-pre-wrap rounded border px-2 py-1',
              isSevereWarning(w)
                ? 'font-semibold bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300'
                : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300')}>
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {/* (c) truth echo */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {render.phase !== 'idle' && render.html !== undefined && (
          render.themed ? (
            <span className="text-[11px] text-slate-600 dark:text-slate-300"
              title="The theme that actually wrapped this frame, straight from the render response">
              theme "{render.themeName ?? 'themed'}"{typeof render.themeVersion === 'number' ? ` v${render.themeVersion}` : ' (unsaved draft html)'}
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-red-600 dark:text-red-400">
              RAW BODY — theme did not render
            </span>
          )
        )}
        {dirty && !isNew && (
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            previewing UNSAVED draft — push sends saved {savedName ? `"${savedName}" ` : ''}v{savedVersion ?? '?'}
          </span>
        )}
        {dirty && isNew && (
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            previewing UNSAVED NEW theme — nothing saved yet, push is blocked until the first save
          </span>
        )}
        {themeInactive && (
          <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
            theme is inactive — a push renders the DEFAULT theme instead
          </span>
        )}
      </div>

      {/* (d) staleness for the starred product */}
      <StalenessPill
        entries={staleEntry ? [staleEntry] : []}
        skuById={skuById}
        checkError={stalenessError}
      />
    </div>
  )
}
