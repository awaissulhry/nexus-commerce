import type { Locale } from '../../../../lib/i18n/locales'
import type { QuoteSpeed } from '../../reports/api'
import { elapsed, pctText, reportsHref, valueText, workingTime } from '../../reports/model'

/**
 * Quote speed (B-W2b-348; design sales.quotes sec quotes.speed: "How fast we answer and how often we win, this month" — median
 * time from new to sent, median time from sent to decision, win rate (accepted ÷ decided), value won (price); "Each tile opens
 * Sales reports filtered the same way"; amounts absent without money.price), the pure rules: who sees what, the tiles' words and
 * where they lead. Read with quotes.view (the Quotes page's permission); the tiles open Sales reports only with
 * sales.reports.view.
 */

export interface SpeedCan {
  /** quotes.view: the section is shown. */
  quotes: boolean
  /** sales.reports.view: a tile opens Sales reports. */
  reports: boolean
  /** money.price: the value won. */
  price: boolean
}

export function speedCan(permissions: readonly string[]): SpeedCan {
  const held = new Set(permissions)
  return { quotes: held.has('quotes.view'), reports: held.has('sales.reports.view'), price: held.has('money.price') }
}

export type SpeedTileKey = 'answer' | 'decision' | 'winRate' | 'won'

export interface SpeedTile {
  readonly key: SpeedTileKey
  /** The value's words: a message key and its params, or a ready text. */
  readonly value: { readonly key: string; readonly params?: Record<string, string> } | { readonly text: string }
  readonly hint: { readonly key: string; readonly params?: Record<string, string | number> }
}

/** The four tiles of an answer (the value won only with the price grain). */
export function speedTiles(answer: QuoteSpeed, can: Pick<SpeedCan, 'price'>, locale: Locale): SpeedTile[] {
  const answerTime = workingTime(answer.medianAnswerMinutes, locale)
  const decisionTime = elapsed(answer.medianDecisionHours, locale)
  const decided = answer.accepted + answer.declined
  const tiles: SpeedTile[] = [
    {
      key: 'answer',
      value: answerTime ? { key: `time.${answerTime.unit}`, params: { value: answerTime.value } } : { text: '—' },
      hint: answer.answered > 0 ? { key: 'speed.answerHint', params: { count: answer.answered } } : { key: 'speed.answerNone' },
    },
    {
      key: 'decision',
      value: decisionTime ? { key: `time.${decisionTime.unit}Elapsed`, params: { value: decisionTime.value } } : { text: '—' },
      hint: decided > 0 ? { key: 'speed.decisionHint', params: { count: decided } } : { key: 'speed.decisionNone' },
    },
    {
      key: 'winRate',
      value: { text: pctText(answer.winRatePct, locale) },
      hint: decided > 0 ? { key: 'speed.winHint', params: { accepted: answer.accepted, decided, expired: answer.expired } } : { key: 'speed.winNone' },
    },
  ]
  if (can.price && answer.sight.values) tiles.push({ key: 'won', value: { text: valueText(answer.won, locale) }, hint: { key: answer.won.mixedCurrencies ? 'speed.wonMixed' : 'speed.wonHint', params: { count: answer.accepted } } })
  return tiles
}

/** Where a tile leads: Sales reports for the same period (null without sales.reports.view). */
export const tileHref = (prefix: string, can: Pick<SpeedCan, 'reports'>, range: { from: string; to: string }): string | null => (can.reports ? reportsHref(prefix, range) : null)
