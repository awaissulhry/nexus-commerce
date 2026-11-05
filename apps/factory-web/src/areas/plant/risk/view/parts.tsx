'use client'

import { useMemo, type ReactNode } from 'react'
import { AlertCircle, Check, ShieldOff } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { CellSaveMark, Modal, StepUpModal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { StepUpState } from '../../_shared/parts'
import type { DvrVersion, Measure, VersionBrief } from '../api'
import { byRole, ROLE_ORDER, signedCount, STATUS_TONE, VERSION_TONE, versionNo, versionStateKey, type Problem, type Said, type SignerRole } from '../model'
import type { CellState } from '../view-model'

/**
 * View parts every SCR-209 view shares (B-W2b-144): the catalogues (`plant-risk`, the list frame's `lists`, `shell` for the
 * site chip and the PDF viewer's words), the words hooks, a day / an instant / a cost in the page's language, a section's
 * loading (its shape, "Still loading…" after a second) and failed states (our words + Try again, never an empty list), the
 * version and status pills, the signers in one line, the law chip, an inline cell's save mark, the keys list behind `?` and
 * the fresh code of a signing act. No colour says a meaning alone: each pill says its state.
 */

export const RISK_NAMESPACES = ['plant-risk', 'lists', 'shell'] as const

/** The page's words (`plant-risk`). */
export function useWords(): Translate {
  const t = useT('plant-risk')
  return useMemo<Translate>(() => (key, params) => t(key, params), [t])
}

/** A `Said` (a key with its values, or a text as it came) in words. */
export function useSay(): (said: Said) => string {
  const t = useWords()
  return useMemo(() => (said: Said) => ('text' in said ? said.text : t(said.key, said.params)), [t])
}

/** A day (`YYYY-MM-DD`) in the page's language. */
export function useDay(): (day: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (day) => (day ? formatDate(`${day.slice(0, 10)}T12:00:00Z`, { locale }) : '—'), [locale])
}

/** An instant in the site's zone (Europe/Rome), in the page's language. */
export function useWhen(): (at: string | null | undefined) => string {
  const locale = useLocale()
  return useMemo(() => (at) => (at ? formatDateTime(at, { locale }) : '—'), [locale])
}

/** A cost (minor units) in its currency; drawn only with the cost grain (the API sends no key without it). */
export function useCost(): (minor: number | null | undefined, currency: string) => string {
  const locale = useLocale()
  return useMemo(() => (minor, currency) => (minor === null || minor === undefined ? '—' : formatNumber(minor / 100, locale, { style: 'currency', currency: currency || 'EUR' })), [locale])
}

/** A problem in words: its key (a refusal, a failure). */
export const problemText = (t: Translate, problem: Problem | null | undefined): string | null => (problem ? t(problem.key) : null)

/** A section loading in its own shape; "Still loading…" shows by itself after about a second (CSS, no timer). */
export function SectionLoading({ rows = 4, height = 30 }: { rows?: number; height?: number }) {
  const t = useWords()
  return (
    <div className="fw-rk-loading" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={index === 0 ? height + 4 : height} />
      ))}
      <span className="fw-rk-slow" role="status">
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
export function NoRiskAccess() {
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
    <div className="fw-rk-head">
      <span className="fw-rk-head-title">
        <h2 id={id} className="fw-rk-h" tabIndex={-1}>
          {title}
        </h2>
        {note ? <span className="fw-rk-muted">{note}</span> : null}
      </span>
      {children ? <span className="fw-rk-tools">{children}</span> : null}
    </div>
  )
}

/** The law as the design names it, with its plain words (the DS LawRef). */
export function Law({ law, plain }: { law: string; plain: string }) {
  const ds = useDsWords()
  return <LawRef law={law} plain={plain} labels={ds.lawRef} />
}

/** "v4 · certain date 12/03/2026" — a version in force (the design's Pill per site); none signed yet says so. */
export function InForcePill({ version }: { version: Pick<VersionBrief, 'versionNo' | 'certainDateOn'> | null }) {
  const t = useWords()
  const day = useDay()
  if (!version) return <Pill tone="warning">{t('version.noneSigned')}</Pill>
  return <Pill tone="success">{t('version.inForcePill', { version: versionNo(version), date: day(version.certainDateOn) })}</Pill>
}

/** A version's state in words (in force, superseded, waiting for signatures, withdrawn). */
export function VersionStatePill({ version }: { version: Pick<DvrVersion, 'status' | 'inForce' | 'superseded'> }) {
  const t = useWords()
  const key = versionStateKey(version)
  return (
    <Pill tone={VERSION_TONE[key] ?? 'neutral'} dot>
      {t(key)}
    </Pill>
  )
}

/** "Employer ✓ · RSPP ✓ · RLS · Doctor ✓" — who signed a version, in the law's order; the screen reader hears each state. */
export function SignersLine({ signers }: { signers: readonly { role: SignerRole; signedOn: string | null }[] }) {
  const t = useWords()
  const day = useDay()
  if (signers.length === 0) return <span className="fw-rk-muted">—</span>
  const { signed, total } = signedCount(signers)
  return (
    <span className="fw-rk-signers" aria-label={t('signers.count', { signed, total })}>
      {byRole(signers).map((signer) => (
        <span key={signer.role} className={signer.signedOn ? 'fw-rk-signed' : 'fw-rk-unsigned'} title={signer.signedOn ? t('signers.signedOn', { role: t(`role.${signer.role}`), date: day(signer.signedOn) }) : t('signers.waiting', { role: t(`role.${signer.role}`) })}>
          {t(`roleShort.${signer.role}`)}
          {signer.signedOn ? <Check size={12} aria-label={t('signers.signedMark')} /> : <span aria-label={t('signers.waitingMark')}>·</span>}
        </span>
      ))}
    </span>
  )
}

export const roleRank = (role: SignerRole): number => ROLE_ORDER[role]

/** A measure's state in words. */
export function StatusPill({ status }: { status: Measure['status'] }) {
  const t = useWords()
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** An inline cell's save: the DS mark while saving, then saved or refused in words. */
export function CellMark({ cell }: { cell: CellState | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  if (!cell) return null
  if (cell.state === 'saving') return <CellSaveMark state="saving" labels={ds.cellSaveMark} />
  if (cell.state === 'saved') return <Check size={13} className="fw-rk-ok" aria-label={t('cell.saved')} />
  const words = cell.key ? t(cell.key) : t('cell.failed')
  return (
    <span className="fw-rk-refused" role="alert" title={words}>
      <AlertCircle size={13} aria-hidden /> <span className="fw-rk-vh">{words}</span>
    </span>
  )
}

/** The page's own keys, then the list frame's. */
export const PAGE_KEYS = (t: Translate): ListKey[] => [
  { keys: ['c'], does: t('keys.add') },
  { keys: ['J', 'K'], does: t('keys.moves') },
  { keys: ['⌘', 'S'], does: t('keys.save') },
  { keys: ['Esc'], does: t('keys.close') },
]

/** `?` and the footer's "All shortcuts": every key of the page. */
export function KeysModal({ onClose }: { onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-rk-list">
        {listKeys(PAGE_KEYS(t)).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

/**
 * The fresh authenticator code of a signing act (design 00 §3.8: asked at the moment of the act, after every other check
 * passed): the DS StepUpModal with this page's title, sentence, verb and refusal.
 */
export function StepUpDialog({ state, onSubmit, onCancel }: { state: StepUpState; onSubmit?: ((code: string) => void) | undefined; onCancel?: (() => void) | undefined }) {
  const t = useWords()
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
