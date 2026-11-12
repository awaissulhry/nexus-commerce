'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { STATUS_TONE } from '../../orders/model'
import { SOURCING_NAMESPACE } from '../model'

/**
 * View parts every SCR-222 view shares (B-W2b-347): the catalogues (`purchasing-sourcing`, the list frame's `lists`), the words
 * hook, a day in words, the section's loading (its shape, "Still loading…" after a second) and failed states (our words + Try
 * again, never an empty list), the order's status pill (the PO list's tones), and the keys list behind `?`.
 */

export const SOURCING_NAMESPACES = [SOURCING_NAMESPACE, 'lists'] as const

/** The page's words (`purchasing-sourcing`). */
export function useWords(): Translate {
  const t = useT(SOURCING_NAMESPACE)
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** The section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 5 }: { rows?: number }) {
  const t = useWords()
  return (
    <div className="fw-src-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? 34 : 30} />
      ))}
      <span className="fw-src-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

/** A failed read: said in our words with Try again (a missing right says so and offers nothing). */
export function SectionFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const forbidden = problem === 'problem.forbidden' || problem === 'problem.signedOut'
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        forbidden ? undefined : (
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  )
}

/** No purchasing.view: the page says so, names the right, and reads nothing. */
export function NoSourcingAccess() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A section's heading row: the title, a note, and its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-src-head">
      <span className="fw-src-head-title">
        <h2 id={id} className="fw-src-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-src-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-src-tools">{children}</span> : null}
    </div>
  )
}

/** An order's status as a pill with its word (never colour alone). */
export function StatusPill({ status }: { status: PurchaseOrderStatus }) {
  const t = useWords()
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-src-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
