import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { LeatherMaterial, WorkOrderLeather } from './api'

/**
 * The work order's Leather panel (B-W2b-130; design wo-leather; SCM-206), pure: each leather's shade lots and the one shade lot
 * rule as message keys of the `production-cutboard` catalogue (the view translates them). A colour never says it alone: the
 * verdict is a word.
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The rule in words: "One shade lot per order" (ORDER), per garment, or none. */
export const rulePhrase = (leather: WorkOrderLeather): Phrase => ({ key: `leather.rule.${leather.rule}` })

/** A leather's verdict in words, with its tone: one shade lot, none yet, mixed (allowed or breaking the rule), out of shade. */
export function verdictOf(material: LeatherMaterial): { readonly words: Phrase; readonly tone: 'success' | 'neutral' | 'warning' | 'danger' } {
  if (material.outOfShade && material.breaksRule) return { words: { key: 'leather.verdict.outOfShade' }, tone: 'danger' }
  if (material.verdict === 'NONE') return { words: { key: 'leather.verdict.NONE' }, tone: 'neutral' }
  if (material.verdict === 'ONE') return { words: { key: 'leather.verdict.ONE', params: { lot: material.lots[0]?.lot.code ?? '', shade: material.lots[0]?.shade ?? '—' } }, tone: 'success' }
  return material.breaksRule ? { words: { key: 'leather.verdict.MIXED', params: { count: material.lots.length } }, tone: 'danger' } : { words: { key: 'leather.verdict.mixedAllowed', params: { count: material.lots.length } }, tone: 'warning' }
}

/** The hides of a shade lot in words: "2 held · 1 reserved · 3 cut" (only what is there). */
export function hidesPhrases(counts: { readonly held: number; readonly reserved: number; readonly cut: number }): Phrase[] {
  const out: Phrase[] = []
  if (counts.held > 0) out.push({ key: 'leather.held', params: { count: counts.held } })
  if (counts.reserved > 0) out.push({ key: 'leather.reserved', params: { count: counts.reserved } })
  if (counts.cut > 0) out.push({ key: 'leather.cut', params: { count: counts.cut } })
  return out
}

/** A lot's record (Warehouse › Lots once built, else its panels). */
export const lotHref = (prefix: string, lot: { readonly id: string; readonly code: string }): string => `${prefix}${recordAddress({ type: 'Lot', id: lot.id, label: lot.code }, OFFICE_PAGES)}`
