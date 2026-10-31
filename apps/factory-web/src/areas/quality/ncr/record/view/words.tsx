'use client'

import { useMemo, type ReactNode } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Translate } from '../../../../../lib/i18n/messages'
import { QualityMessages } from '../../../_shared/parts'
import type { Person } from '../../api'
import { quantityText, type Say } from '../../model'
import { sayWith, useNcrWords, type NcrNotice } from '../../parts'
import type { CellState } from '../view-model'

export const RECORD_NAMESPACE = 'ncr-record'

/** The record's catalogues: the NCR words (`ncr`), the record's own (`ncr-record`), the quality, list and panel words. */
export function NcrRecordMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['ncr', RECORD_NAMESPACE, 'boardview-kit']}>{children}</QualityMessages>
}

export interface RecordWords {
  /** `ncr` words. */
  readonly t: Translate
  /** `ncr-record` words. */
  readonly r: Translate
  /** `Say` in `ncr` words (quantities, units and stages in words). */
  readonly say: (words: Say | null | undefined) => string | null
  /** `Say` in the record's own words when it has the key, else in the `ncr` words. */
  readonly sayAny: (words: Say | null | undefined) => string | null
  readonly locale: string
  /** A quantity in the reader's number format with its unit in words ("40 pcs"). */
  readonly amount: (quantity: string | null | undefined, uom: string) => string
  /** An instant in the site's zone. */
  readonly when: (instant: string | null | undefined) => string
  /** An office person by name: "—" for none, "Someone else" for an id the people read does not name. */
  readonly person: (id: string | null | undefined) => string
}

export function useRecordWords(people: readonly Person[] | null, timeZone: string): RecordWords {
  const { t, say, locale } = useNcrWords()
  const r = useT(RECORD_NAMESPACE)
  const lang = useLocale()
  return useMemo(
    () => ({
      t,
      r,
      say,
      sayAny: (words) => {
        if (!words) return null
        const own = sayWith(r, locale, words)
        return own !== null && own !== words.key && !own.startsWith(`${words.key}_`) ? own : say(words)
      },
      locale,
      amount: (quantity, uom) => (quantity === null || quantity === undefined || quantity === '' ? '—' : `${quantityText(quantity, locale)} ${t(`uom.${uom}`)}`),
      when: (instant) => (instant ? formatDateTime(instant, { locale: lang, timeZone }) : '—'),
      person: (id) => {
        if (!id) return t('common.nobody')
        const found = people?.find((entry) => entry.id === id)
        return found ? (found.me ? t('common.me', { name: found.name }) : found.name) : t('common.unknownPerson')
      },
    }),
    [t, r, say, locale, lang, timeZone, people],
  )
}

/** A cell's save mark: saving, saved, or not saved (with its words for assistive technology). */
export function CellMark({ cell }: { cell: CellState | undefined }) {
  const r = useT(RECORD_NAMESPACE)
  if (!cell) return null
  if (cell.state === 'saving') return <Spinner size={12} />
  if (cell.state === 'saved') return <Check size={13} className="fw-ncr-r-ok" aria-label={r('cell.saved')} />
  return <AlertCircle size={13} className="fw-ncr-r-bad" aria-label={r('cell.failed')} />
}

/** A disposition code's name in the reader's language. */
export const codeLabel = (code: { labelIt: string; labelEn: string; code: string } | null | undefined, language: string): string => (code ? (language.startsWith('it') ? code.labelIt : code.labelEn) || code.code : '—')

/**
 * The record's notice above its work (a receipt or a refusal): its words are the record's own (`ncr-record`) or the NCR
 * screens' shared ones (`ncr`: refusals, stages, the close's receipts), the API's sentences under them as detail lines.
 */
export function RecordNotice({ notice, words, onDismiss }: { notice: NcrNotice | null | undefined; words: RecordWords; onDismiss?: () => void }) {
  const q = useT('quality')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={words.sayAny(notice.say) ?? ''}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {q('common.dismiss')}
          </Button>
        ) : undefined
      }
    >
      {notice.detail && notice.detail.length > 0 && (
        <ul className="fw-q-lines">
          {notice.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}
