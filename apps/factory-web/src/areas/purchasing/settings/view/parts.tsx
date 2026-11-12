'use client'

import Link from 'next/link'
import { History } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Kbd, Pill } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { LiveState } from '../../../_shared/buying/hooks'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { ChangedBy } from '../model'

export const NS = 'purchasing-settings'

/** "Updated 10:42 · Live" (or "Not read yet"), announced politely. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const t = useT(NS)
  const locale = useLocale()
  return (
    <span className="fw-pus-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('live.updated', { time: formatTime(asOf, { locale }) })}</time> : t('live.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/**
 * "Changed by Anna Demo · 12/11 09:42" under a card's title (design 00 §2.4 History), linked to the audit log for a person
 * who reads it; "Changed 12/11 09:42" without the name; "Never changed here" when the scope keeps nothing of its own.
 */
export function ChangedLine({ changed, href }: { changed: ChangedBy | null; href: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  if (!changed) return <span className="fw-pus-changed">{t('card.neverChanged')}</span>
  const time = formatDateTime(changed.at, { locale })
  return (
    <span className="fw-pus-changed">
      <time dateTime={changed.at}>{changed.by ? t('card.changedBy', { name: changed.by, time }) : t('card.changedAt', { time })}</time>
      {href && (
        <Link className="fw-pus-link" href={href}>
          <History size={12} aria-hidden /> {t('card.history')}
        </Link>
      )}
    </span>
  )
}

/** A card's description with its "Changed by" line under it (`undefined`: not known yet, or not readable: no line). */
export function CardDescription({ text, changed, href }: { text: string; changed: ChangedBy | null | undefined; href: string | null }) {
  return (
    <span className="fw-pus-description">
      <span>{text}</span>
      {changed !== undefined && <ChangedLine changed={changed} href={href} />}
    </span>
  )
}

/** "View only" in a card's header, with why (design: noPermission — shown read-only, the reason in words). */
export function ViewOnly({ reason }: { reason: string }) {
  const t = useT(NS)
  return (
    <span className="fw-pus-viewonly" title={reason}>
      <Pill tone="neutral">{t('card.viewOnly')}</Pill>
    </span>
  )
}

/** A card's read failed: its words and Try again; a failed read is never drawn as empty; the rest of the page works. */
export function CardFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: () => void }) {
  const t = useT(NS)
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** The page the person may not open: which permission it needs and who grants it, in words. */
export function NoAccess() {
  const t = useT(NS)
  return (
    <div className="fw-pus">
      <Card padded>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/** A notice band at the top of the page (done, refused) with Dismiss. */
export function NoticeBanner({ notice, onDismiss }: { notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Readonly<Record<string, string | number>> }; onDismiss?: () => void }) {
  const t = useT(NS)
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params as Record<string, string | number> | undefined)}
      action={
        <Button size="sm" variant="quiet" onClick={() => onDismiss?.()}>
          {t('common.dismiss')}
        </Button>
      }
    />
  )
}

/**
 * pop:stepup "Confirm it's you" (design purchasing.settings): switching the suppliers' reminders ON asks a fresh 6-digit code
 * (the API's step-up, StepUpModal); switching them off never asks. Esc closes and returns the focus to the opener (the DS).
 */
export function ReminderStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: (code: string) => void; onCancel?: () => void }) {
  const t = useT(NS)
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? t(state.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}

/** The page's keys (⋯ › Keyboard shortcuts, and the list's footer info "All shortcuts"). */
export function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(NS)
  if (!open) return null
  const keys: { keys: string[]; does: string }[] = [
    { keys: ['c'], does: t('keys.newException') },
    { keys: ['⌘', 'S'], does: t('keys.save') },
    { keys: ['⌘', '↵'], does: t('keys.saveDialog') },
    { keys: ['Esc'], does: t('keys.close') },
  ]
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-pus-keymap">
        {keys.map((entry) => (
          <div key={entry.does} className="fw-pus-keymap-row">
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
