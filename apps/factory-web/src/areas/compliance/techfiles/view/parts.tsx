'use client'

import { useMemo, type ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { Tone } from '../../../quality/_shared/model'
import { NAMESPACE, NAMESPACES } from '../model'
import '../techfiles.css'

/**
 * View parts every SCR-120 view shares (B-W2b-269): the catalogues (`compliance-techfiles`, the list frame's `lists`, `quality`
 * for the record frame and the step-up words, `records` for the record panels), the words hook, a day and an instant in words,
 * a state pill (a word and its tone, never colour alone), a section's loading (its shape, "Still loading…" after a second) and
 * failed states (our words + Try again, never an empty list), a notice, the step-up dialog and the keys behind `?`.
 */

export function TechfilesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={NAMESPACES}>{children}</WithMessages>
}

/** The page's words. */
export function useWords(): Translate {
  const t = useT(NAMESPACE)
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A day (`YYYY-MM-DD` or an instant) in the page's language; "—" when there is none. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(day.length === 10 ? `${day}T12:00:00Z` : day, { locale }) : '—'), [locale])
}

/** An instant in the page's language (day and time). */
export function useWhen(): (instant: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (instant) => (instant ? formatDateTime(instant, { locale }) : '—'), [locale])
}

/** A language's name in the page's language ("Tedesco", "German"), else its code. */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(code)
    return name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : code
  } catch {
    return code
  }
}

/** A state as a pill: its word from the catalogue (`<group>.<STATE>`) and its tone. */
export function StatePill({ group, state, tone, dot = true }: { group: string; state: string; tone: Tone | 'neutral'; dot?: boolean }) {
  const t = useWords()
  return (
    <Pill tone={tone} dot={dot}>
      {t(`${group}.${state}`)}
    </Pill>
  )
}

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-tf-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-tf-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

/** A failed read: said in our words with Try again (a missing right says so and offers nothing); the rest of the page stays. */
export function SectionFailed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const forbidden = problem === 'problem.forbidden' || problem === 'problem.signedOut'
  return (
    <Card padded>
      <EmptyState
        title={title}
        description={t(problem)}
        action={
          forbidden || !onRetry ? undefined : (
            <Button size="sm" onClick={() => onRetry()}>
              {t('common.retry')}
            </Button>
          )
        }
      />
    </Card>
  )
}

/** No compliance.certificates.view: the page says which right it needs and who grants it, and reads nothing. */
export function NoTechfilesAccess() {
  const t = useWords()
  return (
    <Card padded>
      <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('access.title')} description={t('access.body')} />
    </Card>
  )
}

/** A receipt or a refusal of this page: our title, the API's sentences under it when it sent facts, Close. */
export interface Notice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly detail?: readonly string[]
}

export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: (() => void) | undefined }) {
  const t = useWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail && notice.detail.length > 0 ? (
        <ul className="fw-tf-list">
          {notice.detail.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  )
}

/** A section's heading row: the title, a note, and its own controls on the right. */
export function SectionHead({ id, title, note, children }: { id: string; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="fw-tf-head">
      <span className="fw-tf-head-title">
        <h2 id={id} className="fw-tf-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-tf-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-tf-tools">{children}</span> : null}
    </div>
  )
}

/** The list's own keys, then the list frame's. */
export const LIST_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['p'], does: t('keys.pack') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** The record's keys. */
export const RECORD_KEYS = (t: Translate): ListKey[] => [
  { keys: ['p'], does: t('keys.pack') },
  { keys: ['⌘', 'J'], does: t('keys.dock') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ keys, onClose }: { keys: readonly ListKey[]; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-tf-list">
        {listKeys([...keys]).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/** The DS step-up dialog: what the code allows (signing an assessment, sending a pack), the shared quality words for the rest. */
export function TechfilesStepUp({ state, confirm, onSubmit, onCancel }: { state: StepUpState; confirm: string; onSubmit?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined }) {
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
      confirmLabel={confirm}
    />
  )
}
