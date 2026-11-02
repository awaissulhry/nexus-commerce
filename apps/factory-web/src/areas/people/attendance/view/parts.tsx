'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Info, ShieldOff } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Notice } from '../../_shared/parts'
import type { DayRow, LimitTone } from '../api'
import { DAY_TONE, ruleWords, toneOf, type AttendanceCan, type DayStatus, type Words } from '../model'
import type { GateState } from '../view-model'
import '../../_shared/people.css'
import '../attendance.css'

/** The catalogues of the Attendance pages: their own, People's shared words (the keys list), the list frame's. */
export const ATTENDANCE_NAMESPACES = ['attendance', 'people', 'lists'] as const

export function AttendanceMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={ATTENDANCE_NAMESPACES}>{children}</WithMessages>
}

export type AttendanceWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function useAttendanceWords(): AttendanceWords {
  const t = useT('attendance')
  return useMemo<AttendanceWords>(() => (key, params) => t(key, params), [t])
}

export const said = (t: AttendanceWords, words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')

/** The page's one notice, in this page's words. */
export function AttendanceNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss?: (() => void) | undefined }) {
  const t = useAttendanceWords()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={said(t, notice.words)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail ? said(t, notice.detail) : null}
    </Banner>
  )
}

/**
 * What this page shows, said before anything about a person is read (plan §10): days as states, a name and the hours one
 * record at a time, and the site's gate in words. The DS PrivacyNote with the law as a LawRef; every word ours.
 */
export function AttendancePrivacyNote({ gate, can }: { gate: GateState; can: Pick<AttendanceCan, 'view'> }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const whoMore = t(gate === 'open' ? (can.view ? 'privacy.hr' : 'privacy.lead') : `privacy.gate.${gate}`)
  return <PrivacyNote level="individual" text={t('privacy.days')} whoMore={whoMore} law={<LawRef law={t('privacy.law')} plain={t('privacy.lawPlain')} labels={ds.lawRef} />} labels={ds.privacyNote} />
}

/** The gate is shut, or cannot be read, or no site is chosen: the reason in words and nothing of a person. */
export function GateHeld({ gate, prefix, can }: { gate: 'closed' | 'pickSite' | 'failed'; prefix: string; can: Pick<AttendanceCan, 'privacy'> }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  return (
    <Card padded>
      <EmptyState
        icon={<ShieldOff size={24} aria-hidden />}
        title={t(`gate.${gate}.title`)}
        description={t(`gate.${gate}.body`)}
        {...(gate === 'closed' && can.privacy
          ? {
              action: (
                <Button size="sm" asChild>
                  <Link href={`${prefix}/admin/privacy`}>{t('gate.closed.open')}</Link>
                </Button>
              ),
            }
          : {})}
      />
      {gate === 'closed' && (
        <p className="fw-at-gate-law">
          <LawRef law={t('gate.closed.law')} plain={t('gate.closed.lawPlain')} labels={ds.lawRef} />
        </p>
      )}
    </Card>
  )
}

export function DayPill({ status }: { status: DayStatus }) {
  const t = useAttendanceWords()
  return (
    <Pill tone={DAY_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** One tone per limit, in words: the row's checks, never a figure or a name. */
export function LimitPills({ checks }: { checks: readonly LimitTone[] }) {
  const t = useAttendanceWords()
  return (
    <span className="fw-at-tones">
      {checks.map((check) => (
        <Tag key={check.rule} tone={toneOf(check)} title={`${t(`limit.${check.rule}.name`)} · ${t(`limitState.${check.state}`)}`}>
          {t(`limit.${check.rule}.short`)} · {t(`limitState.${check.state}`)}
        </Tag>
      ))}
    </span>
  )
}

/** "How this anomaly is found": the rule and its setting, beside the anomaly (design pop:rule). */
export function RulePopover({ anomaly }: { anomaly: { kind: DayRow['anomalies']['kinds'][number]; ruleKey: string } }) {
  const t = useAttendanceWords()
  return (
    <DetailPopover trigger={<Info size={14} aria-hidden />} triggerLabel={t('rule.title')} triggerClassName="fw-at-rule" label={t('rule.title')}>
      <div className="fw-pp-stack tight">
        <b>{t('rule.title')}</b>
        <p className="fw-pp-hint">{said(t, ruleWords(anomaly))}</p>
      </div>
    </DetailPopover>
  )
}
