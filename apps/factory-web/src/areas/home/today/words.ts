import { CODE_WORDS } from '@nexus/factory-domain/insights/words'
import { formatDate, formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Params, Translate } from '../../../lib/i18n/messages'

/**
 * Today's rows in the person's language. The API sends each sentence, why and "what waits" as a PHRASE: a key and its
 * params (factory-domain insights/words); this file draws it with `today.w.<key>` of `home` (it, en). Params: `count`
 * picks the plural; `…Date` is a business date and `…Month` a month, written the person's way; an array named in the
 * domain's CODE_WORDS holds codes, each said with `today.w.code.<param>.<code>`; any other array is a list, joined (at
 * most five, then "and N more"). A phrase never holds an amount: the figure the sentence quotes is drawn beside it, from
 * the row's grain-filtered figures.
 */

export type PhraseValue = string | number | readonly string[]
export interface PhraseRef {
  readonly key: string
  readonly params: Readonly<Record<string, PhraseValue>>
}

export interface RowFigures {
  readonly currency: string
  readonly netAmount?: number
  readonly purchaseAmount?: number
  readonly marginPct?: string
  readonly marginAmount?: number
}

const LIST_MAX = 5

function listed(items: readonly string[], t: Translate): string {
  const shown = items.slice(0, LIST_MAX).join(', ')
  return items.length > LIST_MAX ? t('today.w.listMore', { shown, count: items.length - LIST_MAX }) : shown
}

const monthWords = (month: string, locale: Locale): string =>
  /^\d{4}-\d{2}$/.test(month) ? new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00.000Z`)) : month

/** One param as the person reads it. Numbers stay numbers (the plural reads `count`). */
export function paramText(name: string, value: PhraseValue, t: Translate, locale: Locale): string | number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    const codes = Object.hasOwn(CODE_WORDS, name)
    return listed(
      value.map((code) => {
        if (!codes) return code
        const key = `today.w.code.${name}.${code}`
        const words = t(key)
        return words === key ? code : words
      }),
      t,
    )
  }
  if (typeof value === 'number') return value
  if (name.endsWith('Date') && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value, { locale })
  if (name.endsWith('Month')) return monthWords(value, locale)
  return value
}

export function phraseText(ref: PhraseRef, t: Translate, locale: Locale): string {
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(ref.params)) params[name] = paramText(name, value, t, locale)
  return t(`today.w.${ref.key}`, params as Params)
}

/** A figure in words: an amount in its currency, or a margin. */
export function figureText(field: string, figures: RowFigures, t: Translate, locale: Locale): string | null {
  if (field === 'marginPct') return figures.marginPct === undefined ? null : t('today.w.marginFigure', { value: formatNumber(Number(figures.marginPct), locale, { maximumFractionDigits: 1 }) })
  const minor = (figures as unknown as Record<string, number | undefined>)[field]
  return minor === undefined ? null : formatNumber(minor / 100, locale, { style: 'currency', currency: figures.currency })
}

/** The row's sentence, with the figure it quotes when the person's grains reach it (the API sent it only then). */
export function sentenceText(row: { readonly words: { readonly sentence: PhraseRef }; readonly sentenceFigure: string | null; readonly figures: RowFigures | null }, t: Translate, locale: Locale): string {
  const text = phraseText(row.words.sentence, t, locale)
  const figure = row.sentenceFigure && row.figures ? figureText(row.sentenceFigure, row.figures, t, locale) : null
  return figure ? t('today.w.withFigure', { text: text.replace(/[.:]$/, ''), figure }) : text
}
