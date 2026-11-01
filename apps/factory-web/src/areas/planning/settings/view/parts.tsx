'use client'

import type { ReactNode } from 'react'
import { RotateCcw, ShieldOff, WifiOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { SaveStatus } from '../model'

/**
 * The Planning settings page's own small parts, shared by its tabs (and by Admin › Company › Calendars): the save
 * status words of the band, the form's save bar, a failed read with Try again, the "no permission" state and a
 * loading card. Words are `planning-settings` keys (`ps.`).
 */

/** The band's save words (design SaveStatus), in one polite live region that is always mounted. */
export function SaveWords({ status, timeZone }: { status: SaveStatus | null; timeZone: string }) {
  const t = useT('planning-settings')
  const locale = useLocale()
  const text =
    status === null
      ? ''
      : status.kind === 'saved'
        ? t('ps.status.saved', { time: formatTime(status.at, { locale, timeZone }) })
        : status.kind === 'saving'
          ? t('ps.status.saving')
          : status.kind === 'unsaved'
            ? t('ps.status.unsaved', { count: status.count })
            : t('ps.status.failed', { count: status.count })
  return (
    <span className={status?.kind === 'failed' ? 'fw-ps-status failed' : 'fw-ps-status'} role="status" aria-live="polite">
      {status?.kind === 'saving' ? <Spinner size={12} /> : null}
      {text}
    </span>
  )
}

/**
 * The bar of a form with unsaved changes (design: EditModeBar ⌘S) = the DS EditModeBar (B-W2b-18; composed here while
 * its words were English only): how many, Discard, Save; ⌘S / Ctrl+S saves (not while held or busy); leaving the page
 * asks first while changes wait.
 */
export function SaveBar({ count, onDiscard, onSave, held, busy, saveLabel }: { count: number; onDiscard: () => void; onSave: () => void; held: string | null; busy: boolean; saveLabel?: string }) {
  const t = useT('planning-settings')
  return <EditModeBar count={count} onDiscard={onDiscard} onApply={onSave} applyLabel={saveLabel ?? t('ps.save.save')} busy={busy} applyHeldReason={held ?? (busy ? t('ps.held.busy') : null)} saveShortcut />
}

/** A failed read: what went wrong in words and Try again (never drawn as an empty section). */
export function ReadFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: () => void }) {
  const t = useT('planning-settings')
  const offline = problem === 'ps.problem.offline'
  return (
    <Card padded>
      <EmptyState
        icon={offline ? <WifiOff size={22} aria-hidden /> : <RotateCcw size={22} aria-hidden />}
        title={title}
        description={t(problem)}
        action={
          problem === 'ps.problem.forbidden' || problem === 'ps.problem.signedOut' ? undefined : (
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('ps.retry')}
            </Button>
          )
        }
      />
    </Card>
  )
}

/** The person may not see this part: said in words (never a locked box). */
export function NoAccess({ title, body }: { title: string; body: string }) {
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={title} description={body} />
    </Card>
  )
}

/** A section loading in its own shape, with the "Still loading…" note after about a second. */
export function Loading({ rows = 6, children }: { rows?: number; children?: ReactNode }) {
  const t = useT('planning-settings')
  return (
    <div className="fw-ps-loading" aria-busy="true">
      {children}
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? 34 : 28} />
      ))}
      <span className="fw-ps-slow">{t('ps.stillLoading')}</span>
    </div>
  )
}
