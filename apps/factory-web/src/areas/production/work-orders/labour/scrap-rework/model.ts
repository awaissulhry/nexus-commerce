import type { Locale } from '../../../../../lib/i18n/locales'
import type { ScrapRework, ScrapReworkRow } from './api'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the scrap and rework cost on the work order's Labour & cost tab, the pure rules:
 * what the card shows (reading, failed, nothing scrapped or reworked, the reasons), a reason's words (the reason lists'
 * words in the reader's language; the reason a scrap had none; the code itself only when no list knows it any more) and
 * whether a rework cost is unknown (no cost per minute in force). Per work order and reason: never per person.
 */

/** The reason the API files a scrap or rework without one under (factory-domain costing/variances/scrap-rework NO_REASON). */
export const NO_REASON = 'NO_REASON'

/** A reason's words, as the reason lists hold them (code → it / en). */
export type ReasonWords = ReadonlyMap<string, { readonly it: string; readonly en: string }>

export interface ScrapReworkModel {
  readonly part: { readonly value: ScrapRework | null; readonly problem: string | null } | null
  /** The reason lists' words (SCRAP, REWORK, WRITE_OFF); empty while unread or unreadable. */
  readonly reasons: ReasonWords
}

export type ScrapReworkState = 'loading' | 'failed' | 'none' | 'rows'

export function scrapReworkState(model: ScrapReworkModel): ScrapReworkState {
  if (model.part?.problem) return 'failed'
  if (!model.part?.value) return 'loading'
  return model.part.value.rows.length === 0 ? 'none' : 'rows'
}

/** A reason in words: the list's words, "no reason given", else the code (a reason no list keeps any more). */
export function reasonWords(code: string, reasons: ReasonWords, locale: Locale, noReason: string): string {
  if (code === NO_REASON) return noReason
  const words = reasons.get(code)
  return words ? (locale === 'it' ? words.it : words.en) : code
}

/** The rework of a reason has minutes but no cost per minute in force: its cost (and the total) is not known. */
export const costUnknown = (row: Pick<ScrapReworkRow, 'reworkCost'>): boolean => row.reworkCost === null
