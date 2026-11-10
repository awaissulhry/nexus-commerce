'use client'

import Link from 'next/link'
import { History } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Kbd, Pill } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { LiveState } from '../../../_shared/buying/hooks'
import type { ChangedBy, Loosening, RuleSource } from '../model'

/** "Updated 10:42 · Live" (or "Not read yet"), announced politely. */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const t = useT('products-settings')
  const locale = useLocale()
  return (
    <span className="fw-pst-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('live.updated', { time: formatTime(asOf, { locale }) })}</time> : t('live.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/**
 * "Changed by Anna Demo · 29/10 09:42" under a card's title (design 00 §2.4 History), linked to the audit log for a person
 * who reads it; "Changed 29/10 09:42" without the name; "Never changed here" when the scope keeps nothing of its own.
 */
export function ChangedLine({ changed, href }: { changed: ChangedBy | null; href: string | null }) {
  const t = useT('products-settings')
  const locale = useLocale()
  if (!changed) return <span className="fw-pst-changed">{t('card.neverChanged')}</span>
  const time = formatDateTime(changed.at, { locale })
  const words = changed.by ? t('card.changedBy', { name: changed.by, time }) : t('card.changedAt', { time })
  return (
    <span className="fw-pst-changed">
      <time dateTime={changed.at}>{words}</time>
      {href && (
        <Link className="fw-pst-history" href={href}>
          <History size={12} aria-hidden /> {t('card.history')}
        </Link>
      )}
    </span>
  )
}

/** A card's description with its "Changed by" line under it. */
export function CardDescription({ text, changed, href }: { text: string; changed: ChangedBy | null; href: string | null }) {
  return (
    <span className="fw-pst-description">
      <span>{text}</span>
      <ChangedLine changed={changed} href={href} />
    </span>
  )
}

/** "You can view, not change" in a card's header, with why (design: noPermission / readOnly). */
export function ViewOnly({ reason }: { reason: string }) {
  const t = useT('products-settings')
  return (
    <span className="fw-pst-viewonly" title={reason}>
      <Pill tone="neutral">{t('card.viewOnly')}</Pill>
    </span>
  )
}

/** Where a value in force comes from, in words. */
export function Source({ source }: { source: RuleSource }) {
  const t = useT('products-settings')
  return <span className="fw-pst-source">{t(`source.${source}`)}</span>
}

/** A card's read failed: its words and Try again; the rest of the page works. */
export function CardFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: () => void }) {
  const t = useT('products-settings')
  return (
    <Banner
      tone="danger"
      title={title}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    >
      {t(problem)}
    </Banner>
  )
}

/** The page the person may not open: which permission it needs and who grants it, in words. */
export function NoAccess() {
  const t = useT('products-settings')
  return (
    <div className="fw-pst">
      <Card padded>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    </div>
  )
}

/**
 * "Confirm a looser rule" (design 00 §2.4: a setting that widens what people may do asks first): each state that lets more
 * through from now on, and the reason, kept in the audit trail. Confirm is held until the reason is typed.
 */
export function LoosenDialog({ loosen, busy, onReason, onConfirm, onClose }: { loosen: { reason: string; loosenings: readonly Loosening[] } | null; busy: boolean; onReason: (reason: string) => void; onConfirm: () => void; onClose: () => void }) {
  const t = useT('products-settings')
  if (!loosen) return null
  const held = busy ? t('held.busy') : loosen.reason.trim() === '' ? t('loosen.reasonNeeded') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('loosen.title')}
      footer={
        <span className="fw-pst-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={onConfirm}>
            {t('loosen.confirm')}
          </Button>
        </span>
      }
    >
      <div className="fw-pst-stack">
        <p className="fw-pst-hint">{t('loosen.intro')}</p>
        <ul className="fw-pst-lines">
          {loosen.loosenings.map((line) => (
            <li key={line.state}>{t('loosen.line', { state: t(`state.${line.state}`), from: t(`rule.${line.from}`), to: t(`rule.${line.to}`) })}</li>
          ))}
        </ul>
        <Field label={t('loosen.reason')} hint={t('loosen.reasonHint')} required>
          <Textarea value={loosen.reason} rows={3} honourRows limit={500} onChange={(event) => onReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** The page's keys (⋯ › Keyboard shortcuts, and the list's footer info "All shortcuts"). */
export function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT('products-settings')
  if (!open) return null
  const keys: { keys: string[]; does: string }[] = [
    { keys: ['c'], does: t('keys.newType') },
    { keys: ['⌘', 'S'], does: t('keys.save') },
    { keys: ['⌘', '↵'], does: t('keys.saveType') },
    { keys: ['Esc'], does: t('keys.close') },
  ]
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-pst-keymap">
        {keys.map((entry) => (
          <div key={entry.does} className="fw-pst-keymap-row">
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
