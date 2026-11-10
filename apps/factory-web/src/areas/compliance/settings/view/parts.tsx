'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { CellSaveMark, Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { Mark, Problem } from '../model'
import type { Writing } from '../view-model'

/**
 * View parts every SCR-262 view shares (B-W2b-265): the catalogues (`compliance-settings`, the list frame's `lists`, `quality` for
 * the step-up dialog's words), the words hook, a day in words, a language's name, a section's loading (its shape) and failed
 * states (our words + Try again, never an empty list), a cell's save mark, a write's problem (our words, never the API's), the
 * step-up dialog and the keys behind `?`.
 */

export const SETTINGS_NAMESPACES = ['compliance-settings', 'lists', 'quality'] as const
export const NAMESPACE = 'compliance-settings'

/** The page's words. */
export function useWords(): Translate {
  const t = useT(NAMESPACE)
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** A language's name in the page's language ("Tedesco", "German"), else its code. */
export function languageName(tag: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    return name && name !== tag ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : tag.toUpperCase()
  } catch {
    return tag.toUpperCase()
  }
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-rm-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-rm-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

/** A failed read: our words with Try again (a missing right says so and offers nothing). The rest of the page stays usable. */
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

/** No right to read the tab: said, with the right it needs. */
export function NoTabAccess({ title, body }: { title: string; body: string }) {
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={title} description={body} />
    </Card>
  )
}

/** A section's heading row: the title, a note, and its own controls. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-rm-head">
      <span className="fw-rm-head-title">
        <h2 id={id} className="fw-rm-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-rm-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-rm-tools">{children}</span> : null}
    </div>
  )
}

/** A cell's mark: saving / unknown (the DS CellSaveMark), refused ("!" with its reason in words); nothing once saved. */
export function SaveMark({ mark }: { mark: Mark | undefined }) {
  const t = useWords()
  if (!mark || mark.state === 'saved') return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'problem.failed')
    return (
      <span className="fw-rm-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}

/** A write's problem in a dialog: our words and the field it names. */
export function WriteProblem({ writing }: { writing: Writing }) {
  const t = useWords()
  if (!writing.problem) return null
  return <ProblemBanner problem={writing.problem} t={t} />
}

export function ProblemBanner({ problem, t }: { problem: Problem; t: Translate }) {
  const field = problem.field ? t(`field.${problem.field}`) : ''
  return <Banner tone="danger" title={t(problem.key, { field })} />
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['⌘', 'S'], does: t('keys.save') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-rm-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** The DS step-up dialog: what the code allows (a looser rule), the shared quality words for the rest. */
export function RulesStepUp({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined }) {
  const t = useWords()
  const q = useT('quality')
  if (!state.open) return null
  return (
    <StepUpModal
      open
      title={q('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('stepUp.confirm')}
    />
  )
}

/** A notice line with Close. */
export function NoticeBanner({ tone, title, onClose }: { tone: 'success' | 'info' | 'warning' | 'danger'; title: string; onClose?: (() => void) | undefined }) {
  const t = useWords()
  return (
    <Banner
      tone={tone}
      title={title}
      action={
        onClose ? (
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    />
  )
}
