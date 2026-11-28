'use client'

import { Check, MessageSquare } from 'lucide-react'
import { formatDate } from '../../i18n/format'
import type { Locale } from '../../i18n/locales'
import type { Translate } from '../../i18n/messages'
import type { OwnColumn, OwnValue } from '../schema'
import { useLinesWords } from '../words'
import { hasOwnValue } from './rules'
import '../order-lines.css'

/**
 * owb-po3.3 (design § 5zi C "Where the factory reads them"; prototype oplus.js `lcChip`, `lcChips`) — the customer's own columns of a
 * line, or of every line of an order, as chips: TWO at most, then "+ n" (the rest in its tip). A Yes / No reads the column's name; a
 * choice its value; a text the column's name with a message mark (the words in the tip); a number or a date "name: value". The same
 * fact on two lines is one chip. The orders sheet's Details column (po7), the office (S2) and the floor (S5) draw it. No price ever.
 */

export interface OwnChip {
  readonly key: string
  readonly words: string
  /** "Comment: Rider 19 wants the collar 1 cm lower." */
  readonly tip: string
  readonly kind: OwnColumn['kind']
}

const cut = (text: string, max = 22): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A value in words: Yes / No, a day, the number, the text. */
export function ownValueWords(column: Pick<OwnColumn, 'kind'>, value: OwnValue['value'], t: Translate, locale: Locale): string {
  if (value === null) return ''
  if (column.kind === 'YES_NO') return t(value === true ? 'own.yes' : 'own.no')
  if (column.kind === 'DATE' && typeof value === 'string') return formatDate(`${value}T12:00:00Z`, { locale, timeZone: 'UTC' })
  return String(value)
}

/** The chips of some lines (each line: column id → value) in the columns' order, each fact once; `max` shown, the rest in `more`. */
export function ownChipsOf(
  columns: readonly OwnColumn[],
  lines: readonly Readonly<Record<string, OwnValue['value']>>[],
  t: Translate,
  locale: Locale,
  max = 2,
): { readonly chips: readonly OwnChip[]; readonly more: { readonly count: number; readonly tip: string } | null } {
  const all: OwnChip[] = []
  for (const line of lines) {
    for (const column of columns) {
      const value = line[column.id]
      // A "No" was said, but a chip for every "No" would hide the facts: a Yes / No shows only its Yes.
      if (!hasOwnValue(value) || (column.kind === 'YES_NO' && value !== true)) continue
      const said = ownValueWords(column, value ?? null, t, locale)
      const words = column.kind === 'YES_NO' || column.kind === 'TEXT' ? column.name : column.kind === 'CHOICE' ? said : `${column.name}: ${said}`
      const key = `${column.id}|${column.kind === 'TEXT' ? '' : said}`
      if (all.some((chip) => chip.key === key)) continue
      all.push({ key, words: cut(words), tip: `${column.name}: ${said}`, kind: column.kind })
    }
  }
  const rest = all.slice(max)
  return { chips: all.slice(0, max), more: rest.length > 0 ? { count: rest.length, tip: rest.map((chip) => chip.tip).join(' · ') } : null }
}

export function OwnChips({ columns, lines, max = 2 }: { columns: readonly OwnColumn[]; lines: readonly Readonly<Record<string, OwnValue['value']>>[]; max?: number }) {
  const { t, locale } = useLinesWords()
  const { chips, more } = ownChipsOf(columns, lines, t, locale, max)
  if (chips.length === 0) return null
  return (
    <span className="fw-ol-chips">
      {chips.map((chip) => (
        <span key={chip.key} className="fw-ol-chip" title={chip.tip}>
          {chip.kind === 'TEXT' ? <MessageSquare size={12} aria-hidden /> : chip.kind === 'YES_NO' ? <Check size={12} aria-hidden /> : null}
          <span>{chip.words}</span>
          <span className="fw-ol-sr">{chip.kind === 'TEXT' ? `: ${chip.tip.slice(chip.tip.indexOf(':') + 1).trim()}` : ''}</span>
        </span>
      ))}
      {more ? (
        <span className="fw-ol-chip" title={more.tip} aria-label={t('chips.more', { count: more.count, rest: more.tip })}>
          +{more.count}
        </span>
      ) : null}
    </span>
  )
}
