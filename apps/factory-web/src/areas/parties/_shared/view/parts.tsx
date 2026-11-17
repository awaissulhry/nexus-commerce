'use client'

import type { ReactNode } from 'react'
import { Banner, Card, DetailPopover, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PartyRow, ViesCheck, ViesStanding } from '../api'
import { RESULT_TONE, STATUS_TONE, VIES_TONE, type LiveState, type Notice } from '../model'
import '../parties.css'

/**
 * The parts both sides draw (B-W1-07 part 2), from design-system parts only; everything fetches nothing. Where the
 * design names a DS part that does not exist yet, it is composed here from DS parts and named in the step notes
 * (LiveUpdates = a Button in the head, RecordNav and SaveStatus absent, the page band = the record's own DetailHeader).
 */

/** The parties text (`parties`), the record panels' (`records`) and the list frame's (`lists`), in the page's language. */
export function PartiesMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['parties', 'records', 'lists']}>{children}</WithMessages>
}

/** "—" for an unknown value (never 0, never empty). */
export const dash = (value: ReactNode | null | undefined): ReactNode => (value === null || value === undefined || value === '' ? '—' : value)

/** The freshness and the live state, in words ("Updated 10:42 · Live"). */
export function Freshness({ asOf, live }: { asOf: string | null; live: LiveState }) {
  const t = useT('parties')
  const locale = useLocale()
  return (
    <span className="fw-pty-asof" role="status">
      {asOf ? <time dateTime={asOf}>{t('list.updated', { time: formatTime(asOf, { locale }) })}</time> : t('list.notYet')}
      {' · '}
      {t(`live.${live}`)}
    </span>
  )
}

/**
 * The head of a list page under the shell's band (the band holds the title and the crumbs; the shell has no slot for
 * a page's status and actions yet — `usePageBand`, design 00 §6.3 — so they sit here): one plain sentence, the
 * freshness, and at most two actions with the primary last.
 */
export function PageHead({ intro, status, actions }: { intro?: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-pty-head">
      <div className="fw-pty-head-text">
        {intro && <p className="fw-pty-intro">{intro}</p>}
        {status}
      </div>
      {actions && <div className="fw-pty-actions">{actions}</div>}
    </div>
  )
}

/** One notice (a receipt or a refusal) with a way to put it away. */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT('parties')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** A read's states before its rows: loading (skeleton rows), failed (the problem in words + Try again), empty. */
export function ReadState({
  problem,
  loading,
  empty,
  onRetry,
  rows = 5,
  failedTitle,
}: {
  problem?: string | null
  loading: boolean
  empty?: { title: string; body?: string; action?: ReactNode; icon?: ReactNode } | null
  onRetry?: () => void
  rows?: number
  failedTitle?: string
}) {
  const t = useT('parties')
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={failedTitle ?? t('list.failedTitle')}
          description={t(problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  if (loading) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-pty-loading" role="status">
          <Spinner size={14} /> {t('list.loading')}
        </p>
        <div className="fw-pty-skeleton">
          {Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} height={20} />
          ))}
        </div>
      </Card>
    )
  }
  if (empty) {
    return (
      <Card padded>
        <EmptyState icon={empty.icon} title={empty.title} description={empty.body} action={empty.action} />
      </Card>
    )
  }
  return null
}

/** A page the person may not open: what they would need, and who has it, in words (never a locked box). */
export function NoAccess({ title, body }: { title: string; body: string }) {
  return (
    <div className="fw-pty">
      <Card padded>
        <EmptyState title={title} description={body} />
      </Card>
    </div>
  )
}

export function StatusPill({ status }: { status: PartyRow['status'] }) {
  const t = useT('parties')
  return (
    <Pill tone={STATUS_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

export function RoleTags({ roles }: { roles: PartyRow['roles'] }) {
  const t = useT('parties')
  return (
    <span className="fw-pty-tags">
      {roles.map((role) => (
        <Tag key={role}>{t(`role.${role}`)}</Tag>
      ))}
    </span>
  )
}

/** The VIES standing in a word, with its date when it was checked ("Valid 12/10/2026"). */
export function viesWords(t: (key: string, params?: Record<string, string | number>) => string, standing: ViesStanding, locale: 'it' | 'en'): string {
  const date = standing.checkedAt ? formatDate(standing.checkedAt, { locale }) : null
  return date && standing.state !== 'UNCHECKED' && standing.state !== 'NOT_APPLICABLE' ? t(`vies.stateOn.${standing.state}`, { date }) : t(`vies.state.${standing.state}`)
}

/**
 * The VIES cell of a list row and the VIES line of a record (design customers.viesResult: a DetailPopover with the
 * result, its date, the consultation number and the trader's name and address as VIES gave them, and Check again).
 * The list row knows only the standing; the record passes its last check.
 */
export function ViesMark({ standing, check, onCheck, checkHeld, busy }: { standing: ViesStanding; check?: ViesCheck | null; onCheck?: () => void; checkHeld?: string | null; busy?: boolean }) {
  const t = useT('parties')
  const locale = useLocale()
  if (standing.state === 'NOT_APPLICABLE') return <span className="fw-pty-hint">{t('vies.state.NOT_APPLICABLE')}</span>
  const words = viesWords(t, standing, locale)
  return (
    <DetailPopover
      trigger={<Tag tone={VIES_TONE[standing.state]}>{words}</Tag>}
      triggerLabel={t('vies.open', { state: words })}
      triggerClassName="fw-pty-vies-trigger"
      label={t('vies.popoverTitle')}
      hoverDelay={0}
    >
      {({ close }) => (
        <div className="fw-pty-pop">
          <p className="fw-pty-pop-title">{t('vies.popoverTitle')}</p>
          <p className="fw-pty-hint">{t(`vies.meaning.${standing.state}`, { days: standing.maxAgeDays })}</p>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('vies.resultLabel'), value: check ? <Tag tone={RESULT_TONE[check.result]}>{t(`vies.result.${check.result}`)}</Tag> : words },
              { label: t('vies.checkedAt'), value: dash(standing.checkedAt ? formatDateTime(standing.checkedAt, { locale }) : null) },
              ...(standing.validUntil ? [{ label: t('vies.validUntil'), value: formatDate(standing.validUntil, { locale }) }] : []),
              ...(check ? [{ label: t('vies.consultation'), value: <span className="fw-pty-code">{dash(check.consultationNumber)}</span> }] : []),
              ...(check ? [{ label: t('vies.traderName'), value: dash(check.traderName) }] : []),
              ...(check ? [{ label: t('vies.traderAddress'), value: dash(check.traderAddress) }] : []),
            ]}
          />
          {onCheck && (
            <span className="fw-pty-actions">
              <Button
                size="sm"
                heldReason={checkHeld ?? (busy ? t('vies.checking') : null)}
                onClick={() => {
                  close({ returnFocus: true })
                  onCheck()
                }}
              >
                {t('vies.checkAgain')}
              </Button>
            </span>
          )}
        </div>
      )}
    </DetailPopover>
  )
}

// B-TH-260: the parties' own record frame (band, tabs, the old dock) went: both sides are on the shared RecordFrame
// (areas/_shared/record-frame), the thread docked there.

/** A record page whose record is missing, whose read failed, or which the person may not open. */
export function RecordProblem({ problem, back, onRetry }: { problem: string; back: ReactNode; onRetry?: () => void }) {
  const t = useT('parties')
  const title = problem === 'problem.notFound' ? 'record.notFoundTitle' : problem === 'problem.forbidden' ? 'record.forbiddenTitle' : 'record.failedTitle'
  return (
    <div className="fw-pty">
      <Card padded>
        <EmptyState
          title={t(title)}
          description={t(problem === 'problem.notFound' ? 'record.notFoundBody' : problem)}
          action={
            <span className="fw-pty-actions">
              {back}
              {onRetry && problem !== 'problem.notFound' && problem !== 'problem.forbidden' && (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              )}
            </span>
          }
        />
      </Card>
    </div>
  )
}

/** The skeleton of a record: band, tabs and body in their places. */
export function RecordSkeleton() {
  const t = useT('parties')
  return (
    <div className="fw-pty" aria-busy="true">
      <p className="fw-pty-loading" role="status">
        <Spinner size={14} /> {t('record.loading')}
      </p>
      <Skeleton height={36} width="40%" />
      <Skeleton height={28} width="60%" />
      <div className="fw-pty-two">
        <Skeleton height={220} />
        <Skeleton height={220} />
      </div>
    </div>
  )
}
