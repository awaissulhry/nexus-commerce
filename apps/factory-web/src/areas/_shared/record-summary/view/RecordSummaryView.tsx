'use client'

import Link from 'next/link'
import { Card, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { RecordSummary } from '../api'
import { linkWords, stateTone, SUMMARY_NS, wordsIn } from '../model'
import '../record-summary.css'

/**
 * B-TH-272 (O-REC-ANY.summary-F01; PL5) — the record's summary as the generic page's side column draws it: its type in words, its
 * number, its state in words (ONE pill: the API's own words, never a made-up state), the record it belongs to as a real link (only
 * when the API names it: the reader may open it too, X-G01) and, last, where the old inner tabs went (the thread's Files, View ›
 * Changes and ⋯). Draws one view model and fetches nothing; the band's row carries type, number, state and parent too (375 px:
 * type + number).
 */
export interface RecordSummaryModel {
  readonly summary: RecordSummary
  /** Where the parent opens (company-prefixed); null: no parent, or none the reader may open. */
  readonly parentHref: string | null
}

export function RecordSummaryView({ model }: { model: RecordSummaryModel }) {
  const t = useT(SUMMARY_NS)
  const locale = useLocale()
  const { summary, parentHref } = model
  const parent = summary.parent
  const items: KeyValueItem[] = [
    { label: t('summary.type'), value: wordsIn(summary.type, locale) },
    { label: t('summary.number'), value: summary.label ? <span className="fw-rsum-number">{summary.label}</span> : <span className="fw-rsum-muted">{t('summary.noNumber')}</span> },
    ...(summary.state ? [{ label: t('summary.state'), value: <Pill tone={stateTone(summary.state.code)}>{wordsIn(summary.state.words, locale)}</Pill> }] : []),
    ...(parent ? [{ label: t('summary.partOf'), value: parentHref ? <Link href={parentHref}>{linkWords(parent, locale)}</Link> : linkWords(parent, locale) }] : []),
    ...(summary.theirRef ? [{ label: t('summary.theirRef'), value: summary.theirRef }] : []),
  ]
  return (
    <Card padded className="fw-rsum">
      <h2 className="fw-rsum-h2">{t('summary.label')}</h2>
      <KeyValue items={items} labelCase="sentence" dense />
      <p className="fw-rsum-hint">{t('summary.hint')}</p>
    </Card>
  )
}
