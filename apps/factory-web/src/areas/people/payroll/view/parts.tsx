'use client'

import { useMemo, type ReactNode } from 'react'
import { Banner, Disclosure } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { Notice } from '../../_shared/parts'
import { TIME_ZONE } from '../../_shared/model'
import type { ExportRow, ExportStatus, Layout, PayrollMonth } from '../api'
import { layoutUnconfirmed, monthPill, monthWords, NAMESPACE, toConfirmKeys, type Words } from '../model'
import '../payroll.css'

/** The catalogues of the Payroll pages: their own, People's shared words (the keys list, the live line), the list frame's. */
export const PAYROLL_NAMESPACES = [NAMESPACE, 'people', 'lists'] as const

export function PayrollMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PAYROLL_NAMESPACES}>{children}</WithMessages>
}

export type PayrollWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function usePayrollWords(): PayrollWords {
  const t = useT(NAMESPACE)
  return useMemo<PayrollWords>(() => (key, params) => t(key, params), [t])
}

/** Words of the model in the page's language; a month in the params is written out. */
export function useSaid(): (words: Words | null | undefined) => string {
  const t = usePayrollWords()
  const locale = useLocale()
  return useMemo(() => (words) => (words ? t(words.key, withMonth(words.params, locale)) : ''), [t, locale])
}

function withMonth(params: Words['params'], locale: ReturnType<typeof useLocale>): Words['params'] {
  if (!params || typeof params.month !== 'string' || !/^\d{4}-\d{2}$/.test(params.month)) return params
  return { ...params, month: monthWords(params.month, locale) }
}

/** A business day in words. */
export const dayWords = (day: string, locale: ReturnType<typeof useLocale>): string => formatDate(`${day}T12:00:00.000Z`, { locale, timeZone: TIME_ZONE })

export const STATUS_TONE: Readonly<Record<ExportStatus, 'neutral' | 'success' | 'warning'>> = { DRAFT: 'warning', EXPORTED: 'success', CANCELLED: 'neutral' }

/** What this page shows, said before anything is read (plan §10): counts for everyone with the view, values by code with the right. */
export function PayrollNote() {
  const t = usePayrollWords()
  const ds = useDsWords()
  return <PrivacyNote level="individual" variant="pill" text={t('privacy.text')} whoMore={t('privacy.who')} law={<LawRef law={t('privacy.law')} plain={t('privacy.lawPlain')} labels={ds.lawRef} />} labels={ds.privacyNote} />
}

/** The band's pill: 'October 2026 · not exported' / 'Exported 3 Nov · v1' / correction pending. */
export function MonthPill({ month }: { month: PayrollMonth }) {
  const t = usePayrollWords()
  const locale = useLocale()
  const pill = monthPill(month)
  const at = month.latest?.exportedAt
  const correction = month.correction
  return (
    <Pill tone={pill.tone} dot>
      {t(pill.words, { month: monthWords(month.month, locale), day: at ? formatDate(at, { locale, timeZone: TIME_ZONE }) : '—', version: month.latest?.revision ?? 1, people: correction?.people ?? 0, values: correction?.values ?? 0 })}
    </Pill>
  )
}

/** A provider layout nobody confirmed: the same words on every screen that shows a layout (GATE-PAYROLL). */
export function LayoutWarning({ layout, children }: { layout: Pick<ExportRow['layout'], 'confirmed' | 'provider'> | null; children?: ReactNode }) {
  const t = usePayrollWords()
  if (!layout || !layoutUnconfirmed(layout)) return null
  return (
    <Banner tone="warning" title={t('layout.notConfirmed', { provider: layout.provider ?? '—' })}>
      {children ?? t('layout.notConfirmedBody')}
    </Banner>
  )
}

/** The tag a list or a card carries beside a layout's name. */
export function LayoutTag({ layout }: { layout: Pick<Layout, 'confirmed' | 'provider'> }) {
  const t = usePayrollWords()
  if (layout.provider === null) return <Tag tone="neutral">{t('layout.generic')}</Tag>
  return <Tag tone={layout.confirmed ? 'success' : 'warning'}>{t(layout.confirmed ? 'layout.confirmed' : 'layout.notConfirmedShort')}</Tag>
}

/** What the labour consultant must confirm (GATE-PAYROLL), folded: the twelve questions in our words. */
export function ToConfirm() {
  const t = usePayrollWords()
  const keys = toConfirmKeys()
  return (
    <Disclosure summary={t('confirm.list', { count: keys.length })}>
      <ol className="fw-pay-ordered">
        {keys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
    </Disclosure>
  )
}

/** Nexus does not run payroll: the sentence every step that makes a file carries. */
export function NotPayroll() {
  const t = usePayrollWords()
  return <p className="fw-pp-hint">{t('notPayroll')}</p>
}

/** A read of a section still running: its skeleton, and a note after about a second is the page's. */
export function SectionLoading({ words, rows = 4 }: { words: string; rows?: number }) {
  return (
    <div className="fw-pp-stack tight" aria-busy="true">
      <p className="fw-pp-hint" role="status">
        {words}
      </p>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={22} />
      ))}
    </div>
  )
}

/** The page's one notice, in this page's words. */
export function PayrollNotice({ notice, onDismiss }: { notice: Notice | null; onDismiss?: (() => void) | undefined }) {
  const t = usePayrollWords()
  const said = useSaid()
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={said(notice.words)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.close')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail ? said(notice.detail) : null}
    </Banner>
  )
}
