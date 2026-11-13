'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CalendarCheck, Clock, MessageSquareWarning, PencilLine, type LucideIcon } from 'lucide-react'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Banner, type TimelineStep } from '@nexus/ui/components'
import { Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import type { InboxKind, LineDayState } from '@nexus/factory-domain/production/labour/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Change, OffStandardCode } from '../api'
import { agePhrase, ageTone, changeLines, DAY_TONE, KIND_TONE, LABOUR_NAMESPACE, type LegalRow, type Phrase, type ValueWords } from '../model'
import { ChangeValue } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/** Small parts of Labour & corrections: views only, they fetch nothing. */

export type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

export const useLabourT = (): Words => useT(LABOUR_NAMESPACE)

export const say = (t: Words, words: Phrase | null | undefined): string => (words ? t(words.key, words.params) : '—')

const KIND_ICON: Readonly<Record<InboxKind, LucideIcon>> = { CORRECTION: PencilLine, DISPUTE: MessageSquareWarning, OFF_STANDARD: Clock, LINE_DAY: CalendarCheck }

/** A queue item's kind as icon + word (never colour alone). */
export function KindPill({ kind }: { kind: InboxKind }) {
  const t = useLabourT()
  const Icon = KIND_ICON[kind]
  return (
    <Pill tone={KIND_TONE[kind]}>
      <Icon size={12} aria-hidden /> {t(`kind.${kind}`)}
    </Pill>
  )
}

export function DayPill({ state }: { state: LineDayState }) {
  const t = useLabourT()
  return (
    <Pill tone={DAY_TONE[state]} dot>
      {t(`dayState.${state}`)}
    </Pill>
  )
}

/** "3 h": waiting a day or more is said louder, and always in words. */
export function AgeCell({ minutes }: { minutes: number }) {
  const t = useLabourT()
  const tone = ageTone(minutes)
  return tone === 'neutral' ? <span className="fw-lb-num">{say(t, agePhrase(minutes))}</span> : <Tag tone={tone}>{say(t, agePhrase(minutes))}</Tag>
}

const CLOCK_KINDS = ['IN', 'OUT', 'BREAK_OUT', 'BREAK_IN', 'VOID']

export function useValueWords(codes: readonly OffStandardCode[] | null, timeZone: string): ValueWords {
  const t = useLabourT()
  const locale = useLocale()
  return useMemo(
    () => ({
      instant: (iso) => formatDateTime(iso, { locale, timeZone }),
      code: (id) => codes?.find((entry) => entry.id === id)?.code ?? null,
      word: (key) => t(key),
      clock: (kind) => t(CLOCK_KINDS.includes(kind) ? `clock.${kind}` : 'clock.other'),
    }),
    [codes, locale, t, timeZone],
  )
}

/**
 * What changes, from → to (the DS ChangeValue). In a row: the first line and "+N" in our words (the part's own "+N more"
 * is English).
 */
export function ChangeList({ changes, words, compact = false }: { changes: readonly Change[]; words: ValueWords; compact?: boolean }) {
  const t = useLabourT()
  const lines = changeLines(changes, words)
  if (lines.length === 0) return null
  if (!compact) return <ChangeValue changes={lines} />
  return (
    <span className="fw-lb-inline">
      <ChangeValue changes={lines.slice(0, 1)} compact />
      {lines.length > 1 && <Tag tone="neutral">{t('change.more', { count: lines.length - 1 })}</Tag>}
    </span>
  )
}

/** The day of a queue row or a record, in the page's language. */
export const dayText = (day: string | null, locale: ReturnType<typeof useLocale>, timeZone: string): string => (day ? formatDate(`${day}T12:00:00.000Z`, { locale, timeZone }) : '—')

/** A timeline's step for someone's change (the DS Timeline's steps). */
export type Step = TimelineStep

/**
 * LegalBasisNote (design lb-basis; composed: the DS has no such part, and this is its third use after Floor rules and
 * Bundles): one DS PrivacyNote per site in scope, the law as a DS LawRef, the way to Floor rules & codes. It comes first on
 * the page and never folds: why this page may show a person's records, or why it does not.
 */
export function LegalBand({ rows, canSettings, prefix }: { rows: readonly LegalRow[] | null; canSettings: boolean; prefix: string }) {
  const t = useLabourT()
  const locale = useLocale()
  const ds = useDsWords()
  return (
    <section className="fw-lb-legal" aria-label={t('legal.label')}>
      {rows === null ? (
        <Skeleton height={36} />
      ) : (
        rows.map((row) => (
          <PrivacyNote
            key={row.siteId}
            level={row.state === 'BASIS' || row.state === 'ON' ? 'individual' : 'line'}
            variant="panel"
            text={legalText(t, row, rows.length > 1, locale)}
            whoMore={t(row.state === 'BASIS' || row.state === 'ON' ? (row.leads ? 'legal.whoLeads' : 'legal.who') : `legal.who${row.state}`)}
            law={<LawRef law={t('legal.law')} plain={t('legal.lawPlain')} labels={ds.lawRef} />}
            labels={ds.privacyNote}
            action={
              canSettings ? (
                <Link className="fw-lb-link" href={`${prefix}/production/settings?site=${encodeURIComponent(row.siteId)}`}>
                  {t('legal.rules')}
                </Link>
              ) : undefined
            }
          />
        ))
      )}
    </section>
  )
}

const BASIS_KINDS = ['UNION_AGREEMENT', 'INL_AUTHORISATION', 'NOT_REQUIRED']

function legalText(t: Words, row: LegalRow, named: boolean, locale: ReturnType<typeof useLocale>): string {
  const basis = row.basis
  const text =
    row.state === 'BASIS' && basis
      ? t(basis.recordedByName ? 'legal.BASIS' : 'legal.BASIS_noName', {
          basis: t(BASIS_KINDS.includes(basis.kind) ? `basis.${basis.kind}` : 'basis.other'),
          reference: basis.reference,
          when: formatDate(basis.recordedAt, { locale }),
          name: basis.recordedByName ?? '',
        })
      : t(`legal.${row.state}`)
  return named ? t('legal.atSite', { site: row.site, text }) : text
}

/** Who a record is about: named only where the API served the name; else that someone is on it, and why not who. */
export function WhoNote({ record }: { record: { worker: { name: string } | null; workerHidden: boolean } }) {
  const t = useLabourT()
  if (record.worker && !record.workerHidden) return <Banner tone="info" title={t('who.named', { name: record.worker.name })} />
  if (record.workerHidden) return <Banner tone="info" title={t('who.hidden')} />
  return null
}
