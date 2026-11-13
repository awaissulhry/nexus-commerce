'use client'

import { useCallback, type ReactNode } from 'react'
import type { AccidentOutcome, ReportStatus, SafetySource } from '@nexus/factory-domain/sales/safety-reports/rules'
import { Pill, Tag, type Tone } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { QualityMessages } from '../../../quality/_shared/parts'
import type { ReportRow } from './api'
import { garmentOf, isNotifiable, NS } from './model'
import './accidents.css'

/** The screens' catalogues: `safety-reports`, the shared `quality` (the record frame's words), `lists`, `records`, the DS words. */
export function SafetyMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={[NS, 'ds-words']}>{children}</QualityMessages>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** `t`, a business day and an instant in the page's language. */
export function useWords() {
  const t = useT(NS)
  const locale = useLocale()
  const day = useCallback((value: string | null | undefined) => (value ? formatDate(DATE.test(value) ? `${value}T12:00:00Z` : value, { locale, ...(DATE.test(value) ? { timeZone: 'UTC' } : {}) }) : '—'), [locale])
  const when = useCallback((value: string | null | undefined) => (value ? formatDateTime(value, { locale }) : '—'), [locale])
  return { t, locale, day, when }
}

const STATUS_TONE: Readonly<Record<ReportStatus, Tone>> = { NEW: 'info', ASSESSING: 'warning', CLOSED: 'neutral' }
export function StatusPill({ status }: { status: ReportStatus }) {
  const { t } = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

export function SourceTag({ source }: { source: SafetySource }) {
  const { t } = useWords()
  return <Tag tone="neutral">{t(`source.${source}`)}</Tag>
}

const OUTCOME_TONE: Readonly<Record<AccidentOutcome, Tone>> = { NO_HARM: 'success', MINOR_HARM: 'warning', SERIOUS_HARM: 'danger', DEATH: 'danger', NOT_KNOWN: 'neutral' }
export function OutcomeTag({ outcome }: { outcome: AccidentOutcome }) {
  const { t } = useWords()
  return <Tag tone={OUTCOME_TONE[outcome]}>{t(`outcome.${outcome}`)}</Tag>
}

/** The authority, in words: told on a day (with the reference), to be told (a death or serious harm), or not needed yet. */
export function AuthorityCell({ told, toldAt, reference, mustTell, outcome }: { told: boolean; toldAt?: string | null; reference?: string | null; mustTell: boolean; outcome: AccidentOutcome }) {
  const { t, day } = useWords()
  if (told) {
    return (
      <span className="fw-acc-cell">
        <Pill tone="success">{toldAt ? t('authority.toldOn', { date: day(toldAt) }) : t('authority.told')}</Pill>
        {reference && <span className="fw-acc-hint fw-acc-mono">{reference}</span>}
      </span>
    )
  }
  if (mustTell) return <Pill tone="danger">{t('authority.toTell')}</Pill>
  return <span className="fw-acc-hint">{isNotifiable(outcome) ? t('authority.toTell') : t('authority.notNeeded')}</span>
}

/** The garment in a cell: serial (ours or as typed) and the batch, the style's code. */
export function GarmentCell({ row }: { row: Pick<ReportRow, 'garmentSerial' | 'serial' | 'garmentBatch' | 'batchNumber' | 'style' | 'size'> }) {
  const { t } = useWords()
  const garment = garmentOf(row)
  if (!garment.serial && !garment.batch && !garment.style) return <span className="fw-acc-hint">{t('garment.none')}</span>
  return (
    <span className="fw-acc-cell">
      <span className="fw-acc-mono">{[garment.serial, garment.batch].filter(Boolean).join(' · ') || garment.style}</span>
      <span className="fw-acc-hint">{[garment.style && (garment.serial || garment.batch) ? garment.style : null, garment.ours ? t('garment.ours') : t('garment.typed')].filter(Boolean).join(' · ')}</span>
    </span>
  )
}
