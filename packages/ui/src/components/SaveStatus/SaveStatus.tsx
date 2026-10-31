'use client'

/**
 * SaveStatus — the band's save words with one stable live region (B-W2b-09, D6; design 00-page-anatomy §3.3, §5 #6).
 *
 *   <SaveStatus state={{ kind: 'saved', at: '2026-10-31T09:42:00Z' }} />           All changes saved · 10:42
 *   <SaveStatus state={{ kind: 'saving' }} />                                      Saving…
 *   <SaveStatus state={{ kind: 'failed', count: 1 }} onRetry={retry} />            1 change not saved — Retry
 *   <SaveStatus state={{ kind: 'unsaved' }} />                                     Unsaved changes (a form tab)
 *   <SaveStatus state={{ kind: 'offline', count: 2 }} />                           Offline — 2 changes wait to be sent
 *
 * - **Words, always visible**: the state is never only a colour or a tooltip — an icon, a tone AND the words.
 * - **Honest**: the app sets `saved` from the server's answer, never before. Unknown counts are not invented.
 * - **One live region**: a polite `role="status"` mounted from the first render (empty while idle) and kept, so the
 *   first change is announced too (the studio's `SaveIndicator` drew its region only in some states).
 * - **Retry**: the failed state draws Retry when the app passes `onRetry`; `retryHeld` holds it with its reason
 *   ("Offline: reconnect first") instead of hiding it.
 * - Times: `formatTime(iso)` — the app passes its writer for the site's zone and language; the default is the
 *   browser's zone in `locale`.
 * Its own entry point (`components/SaveStatus`), not in the components barrel. Every word comes from `labels`.
 */
import { AlertTriangle, Check, CloudOff, PencilLine } from 'lucide-react'

import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { mergeLabels } from '../../lib/labels'
import { SAVE_STATUS_LABELS, type SaveStatusLabels } from './SaveStatusLabels'
import { defaultSaveTime, saveStatusView, type SaveStatusState } from './saveStatusModel'
import './save-status.css'

export interface SaveStatusProps {
  state: SaveStatusState
  /** Failed: draws Retry. */
  onRetry?: () => void
  /** Why Retry cannot run now (it stays, held). */
  retryHeld?: string | null
  /** The time of a save in words ("10:42"): the app's writer for the site's zone. Default: `locale`, browser zone. */
  formatTime?: (iso: string) => string
  locale?: string
  /** `sm`: smaller words and icon (a grid card's header). */
  size?: 'md' | 'sm'
  labels?: Partial<SaveStatusLabels>
  className?: string
}

export function SaveStatus({ state, onRetry, retryHeld, formatTime, locale, size = 'md', labels, className }: SaveStatusProps) {
  const words = mergeLabels(SAVE_STATUS_LABELS, labels)
  const view = saveStatusView(state, { words, time: formatTime ?? ((iso) => defaultSaveTime(iso, locale)), canRetry: !!onRetry })
  const cls = ['nds-savestatus', `is-${state.kind}`, `tone-${view.tone}`, size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ')
  const icon = size === 'sm' ? 12 : 14
  return (
    <span className={cls} role="group" aria-label={words.region}>
      {view.text !== '' && (
        <span className="nds-savestatus-words" aria-hidden>
          <span className="nds-savestatus-icon">
            {state.kind === 'saved' ? <Check size={icon} aria-hidden />
              : state.kind === 'saving' ? <Spinner size={icon} />
              : state.kind === 'failed' ? <AlertTriangle size={icon} aria-hidden />
              : state.kind === 'offline' ? <CloudOff size={icon} aria-hidden />
              : <PencilLine size={icon} aria-hidden />}
          </span>
          <span className="nds-savestatus-text">{view.text}</span>
        </span>
      )}
      {/* The one live region: always mounted, so the first change is heard; the words above are its visible twin. */}
      <span className="nds-vh" role="status" aria-live="polite">{view.text}</span>
      {view.retry && (
        <Button size="sm" variant="quiet" onClick={onRetry} heldReason={retryHeld ?? null}>
          {words.retry}
        </Button>
      )}
    </span>
  )
}
