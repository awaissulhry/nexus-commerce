'use client'

import { Banner } from '@nexus/ui/components'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money } from '../../../../parties/_shared/model'
import { NS, type Notice, type Words } from '../model'

/** The page's translate, a `Words` said with it, and the page's dates and amounts. */
export function useSay() {
  const t = useT(NS)
  const locale = useLocale()
  const say = (words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')
  const day = (value: string) => formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale })
  const when = (value: string) => formatDateTime(value, { locale })
  const amount = (minor: number, currency: string) => money(minor, currency, locale) ?? ''
  return { t, say, day, when, amount, locale }
}

// F-CT-533 (ct-w2 W2.4): the cards' title row, read states and card went with their last cards (the hold and PO number cards).

/** A write's notice (done, or what went wrong), dismissible. */
export function NoticeLine({ notice, onDismiss }: { notice: Notice; onDismiss?: (() => void) | undefined }) {
  const { say } = useSay()
  if (!notice) return null
  return <Banner tone={notice.tone} title={say(notice.words)} onDismiss={onDismiss} />
}
