'use client'

import Link from 'next/link'
import { History, Lock } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Kbd, Pill } from '@nexus/ui/primitives'
import { Modal, StepUpModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { LiveState } from '../../../_shared/buying/hooks'
import type { StepUpState } from '../../../quality/_shared/hooks'
import { MAX_REASON, reasonProblem, type ChangedBy, type InForce, type Notice, type Scope, type Source } from '../model'

export const NS = 'warehouse-settings'

/** "Updated 10:42 · Live" (or "Not read yet"), announced politely. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const t = useT(NS)
  const locale = useLocale()
  return (
    <span className="fw-whs-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('live.updated', { time: formatTime(asOf, { locale }) })}</time> : t('live.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/**
 * "Changed by Anna Demo · 12/11 09:42" under a card's title (design: "Changed by per card"), linked to the audit log for a
 * person who reads it; "Changed 12/11 09:42" without the name; "Never changed here" when the scope keeps nothing of its own.
 * `row`: the time is the rules row's last change (any card: the audit trail is not in the role).
 */
export function ChangedLine({ changed, href }: { changed: ChangedBy | null; href: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  if (!changed) return <span className="fw-whs-changed">{t('card.neverChanged')}</span>
  const time = formatDateTime(changed.at, { locale })
  const words = changed.by ? t(changed.row ? 'card.rowChangedBy' : 'card.changedBy', { name: changed.by, time }) : t(changed.row ? 'card.rowChangedAt' : 'card.changedAt', { time })
  return (
    <span className="fw-whs-changed">
      <time dateTime={changed.at}>{words}</time>
      {href && (
        <Link className="fw-whs-link" href={href}>
          <History size={12} aria-hidden /> {t('card.history')}
        </Link>
      )}
    </span>
  )
}

/** A card's description with its "Changed by" line under it (`undefined`: not known yet, or not readable: no line). */
export function CardDescription({ text, changed, href }: { text: string; changed: ChangedBy | null | undefined; href: string | null }) {
  return (
    <span className="fw-whs-description">
      <span>{text}</span>
      {changed !== undefined && <ChangedLine changed={changed} href={href} />}
    </span>
  )
}

/** "View only" in a card's header, with why (shown read-only, the reason in words). */
export function ViewOnly({ reason }: { reason: string }) {
  const t = useT(NS)
  return (
    <span className="fw-whs-viewonly" title={reason}>
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
    <div className="fw-whs">
      <Card padded>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/** A notice band at the top of the page (done, refused) with Dismiss. */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
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

/** The rule nobody switches off, with its lock. */
export function Locked({ text }: { text: string }) {
  return (
    <p className="fw-whs-locked">
      <Lock size={14} aria-hidden /> <span>{text}</span>
    </p>
  )
}

/** Where a value in force comes from: this company's own, every company's, the default. */
export function SourceWords({ source, scope }: { source: Source; scope: Scope }) {
  const t = useT(NS)
  return <span className="fw-whs-sub">{t(`source.${scope === 'all' && source === 'TENANT' ? 'ALL_OWN' : source}`)}</span>
}

/** "On · this company's own" — a switch in force, as a pill and its source. */
export function SwitchInForce({ inForce, scope }: { inForce: InForce<boolean> | null; scope: Scope }) {
  const t = useT(NS)
  if (!inForce) return <span className="fw-whs-sub">{t('common.notKnown')}</span>
  return (
    <span className="fw-whs-inforce">
      <Pill tone={inForce.value ? 'success' : 'warning'}>{t(inForce.value ? 'common.on' : 'common.off')}</Pill>
      <SourceWords source={inForce.source} scope={scope} />
    </span>
  )
}

/**
 * The reason a loosening change asks before Save (1 to 500 characters; the API asks it too). Shown once a change loosens a
 * rule, or once the API asked for it.
 */
export function ReasonField({ id, value, label, hint, shown, disabled, onChange }: { id: string; value: string; label: string; hint: string; shown: boolean; disabled: boolean; onChange?: (reason: string) => void }) {
  const t = useT(NS)
  const problem = reasonProblem(value)
  return (
    <Field label={label} hint={hint} required error={shown && problem ? t(problem) : undefined} htmlFor={id}>
      <Textarea id={id} value={value} rows={2} honourRows limit={MAX_REASON} disabled={disabled} onChange={(event) => onChange?.(event.target.value)} />
    </Field>
  )
}

/**
 * pop:ws-stepup "Confirm it is you" (design warehouse.settings): a change that widens what one person may do (a separation
 * rule off, more days back, a higher adjustment value, or none) asks a fresh 6-digit code (the API's step-up, StepUpModal).
 * Tightening never asks. Esc closes and returns the focus to the opener (the DS).
 */
export function RulesStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: (code: string) => void; onCancel?: () => void }) {
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

/** The page's keys (⋯ › Keyboard shortcuts, and the rules list's footer info "All shortcuts"). */
export function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT(NS)
  if (!open) return null
  const keys: { keys: string[]; does: string }[] = [
    { keys: ['⌘', 'S'], does: t('keys.save') },
    { keys: ['↵'], does: t('keys.openRule') },
    { keys: ['Esc'], does: t('keys.close') },
  ]
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-whs-keymap">
        {keys.map((entry) => (
          <div key={entry.does} className="fw-whs-keymap-row">
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
