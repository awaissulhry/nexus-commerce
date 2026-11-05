'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'

// The GHS pictograms, the signal word and the cabinet QR's bare mark live in src/lib (the Floor's cabinet reader draws them too).
export { CabinetQr, GhsMark, GhsMarks, SignalWord } from '../../../../lib/chemicals/marks'

/**
 * View parts every SCR-213 view shares (B-W2b-143): the catalogues (`plant-chemicals`, the list frame's `lists`, `shell`
 * for the site chip and the PDF viewer's words), the words hook, a day in words, a section's loading (its shape, "Still
 * loading…" after a second) and failed states (our words + Try again, never an empty list), the GHS pictograms, the cabinet
 * QR's bare mark, and the keys list behind `?`.
 */

export const CHEMICALS_NAMESPACES = ['plant-chemicals', 'lists', 'shell'] as const

/** The page's words (`plant-chemicals`). */
export function useWords(): Translate {
  const t = useT('plant-chemicals')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-ch-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-ch-slow" role="status">
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

/** No safety.view: the page says so and reads nothing. */
export function NoChemicalsAccess() {
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
    <div className="fw-ch-head">
      <span className="fw-ch-head-title">
        <h2 id={id} className="fw-ch-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-ch-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-ch-tools">{children}</span> : null}
    </div>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['J', 'K'], does: t('keys.moves') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-ch-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}
