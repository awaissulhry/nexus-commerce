import type { Issue } from '../../core/errors'
import { UNITS, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { numberText, type Language } from './rolls'

/**
 * Consumables by pack (B-W2b-107; SCM-263: "thread, needles and glue by pack with a minimum and maximum per site; consumables
 * by pack come with reorder points"), pure. A consumable is counted in its base unit (metres of thread, pieces of needles)
 * and kept by the pack (a cone of 5,000 m, a box of 100): Item.packSize base units in one pack of Item.packUom. Its minimum
 * and maximum per site are the site's item parameters with method MIN_MAX (planning's ItemPlanning, B-W2a-16): when what
 * the site has and expects falls below the minimum, order up to the maximum, in whole packs.
 */

/** What a pack may be called: a unit whose size its item says, or a count. Never a length, area, mass or volume. */
export const PACK_UOMS = ['CONE', 'BOX', 'ROLL', 'SET', 'PCS', 'PAIR'] as const satisfies readonly Uom[]
export type PackUom = (typeof PACK_UOMS)[number]
export const isPackUom = (uom: string): uom is PackUom => (PACK_UOMS as readonly string[]).includes(uom)

/** Kinds that are consumables even before a pack is set (thread is always by the cone). */
export const CONSUMABLE_KINDS = ['THREAD'] as const

const PACK_SIZE = /^\d{1,14}(\.\d{1,4})?$/

/** A pack: both or neither; the size above 0, four decimals; the pack a pack unit, not the base unit itself. */
export function packProblems(input: { readonly packSize: string | null; readonly packUom: string | null }, baseUom: Uom): Issue[] {
  const problems: Issue[] = []
  if ((input.packSize === null) !== (input.packUom === null)) {
    problems.push({ path: input.packSize === null ? 'packSize' : 'packUom', message: 'A pack has a size and a unit, both or neither.' })
    return problems
  }
  if (input.packSize === null) return problems
  if (!PACK_SIZE.test(input.packSize.trim()) || !new Dec(input.packSize.trim()).greaterThan(0)) problems.push({ path: 'packSize', message: `How many ${UNITS[baseUom].symbol} one pack holds: above 0, four decimals.` })
  if (!isPackUom(input.packUom!)) problems.push({ path: 'packUom', message: `A pack is one of ${PACK_UOMS.join(', ')}.` })
  else if (input.packUom === baseUom) problems.push({ path: 'packUom', message: `The stock already counts in ${baseUom}: a pack is something that holds several.` })
  return problems
}

/** A quantity in whole packs and what is left loose (base unit). */
export function packsOf(baseQuantity: DecimalInput, packSize: DecimalInput): { readonly packs: Decimal; readonly loose: Decimal } {
  const quantity = new Dec(baseQuantity.toString())
  const size = new Dec(packSize.toString())
  if (!size.greaterThan(0) || !quantity.greaterThan(0)) return { packs: ZERO, loose: Dec.max(ZERO, quantity) }
  const packs = quantity.div(size).floor()
  return { packs, loose: quantity.minus(packs.times(size)) }
}

const PACK_WORDS: Readonly<Partial<Record<Uom, Readonly<Record<Language, readonly [string, string]>>>>> = {
  CONE: { it: ['cono', 'coni'], en: ['cone', 'cones'] },
  BOX: { it: ['scatola', 'scatole'], en: ['box', 'boxes'] },
  ROLL: { it: ['rotolo', 'rotoli'], en: ['roll', 'rolls'] },
  SET: { it: ['set', 'set'], en: ['set', 'sets'] },
  PCS: { it: ['pezzo', 'pezzi'], en: ['piece', 'pieces'] },
  PAIR: { it: ['paio', 'paia'], en: ['pair', 'pairs'] },
}

/** "12 cones · 60,000 m", "12 cones + 1,250 m · 61,250 m" (it "12 coni · 60.000 m"); without a pack just the quantity. */
export function packWords(baseQuantity: DecimalInput, baseUom: Uom, pack: { readonly packSize: string; readonly packUom: Uom } | null, language: Language): string {
  const quantity = `${numberText(baseQuantity, language)} ${UNITS[baseUom].symbol}`
  if (!pack) return quantity
  const { packs, loose } = packsOf(baseQuantity, pack.packSize)
  const [one, many] = PACK_WORDS[pack.packUom]?.[language] ?? [UNITS[pack.packUom].name[language], UNITS[pack.packUom].name[language]]
  const whole = `${numberText(packs, language)} ${packs.equals(1) ? one : many}`
  return `${whole}${loose.greaterThan(0) ? ` + ${numberText(loose, language)} ${UNITS[baseUom].symbol}` : ''} · ${quantity}`
}

export const LEVEL_STATES = ['BELOW_MIN', 'OK', 'ABOVE_MAX', 'NO_LEVELS'] as const
export type LevelState = (typeof LEVEL_STATES)[number]

export interface LevelFacts {
  /** On hand at the site (base unit). */
  readonly onHand: DecimalInput
  /** Still to come on open purchase order lines (base unit). */
  readonly onOrder: DecimalInput
  /** Held for work orders and order lines by ACTIVE reservations, not issued yet (base unit). */
  readonly reserved: DecimalInput
  /** The site's MIN_MAX levels (base unit), or null. */
  readonly minStock: string | null
  readonly maxStock: string | null
  readonly packSize: string | null
}

export interface LevelVerdict {
  readonly state: LevelState
  /** What the site has and expects: on hand + on order − reserved. */
  readonly position: Decimal
  /** To order now, up to the maximum, in whole packs (base unit); 0 when nothing is due. */
  readonly reorder: Decimal
  /** The same in packs (null without a pack). */
  readonly reorderPacks: Decimal | null
}

/**
 * The site's level of a consumable: below its minimum when what it has and expects (on hand + on order − reserved) is under
 * it, above its maximum when what it has on hand is over it. Below the minimum, order up to the maximum, rounded UP to whole
 * packs (a pack is never split at the supplier).
 */
export function levelOf(facts: LevelFacts): LevelVerdict {
  const onHand = new Dec(facts.onHand.toString())
  const position = onHand.plus(facts.onOrder.toString()).minus(facts.reserved.toString())
  if (facts.minStock === null || facts.maxStock === null) return { state: 'NO_LEVELS', position, reorder: ZERO, reorderPacks: facts.packSize ? ZERO : null }
  const min = new Dec(facts.minStock)
  const max = new Dec(facts.maxStock)
  if (position.lessThan(min)) {
    const wanted = max.minus(position)
    if (facts.packSize && new Dec(facts.packSize).greaterThan(0)) {
      const packs = wanted.div(facts.packSize).ceil()
      return { state: 'BELOW_MIN', position, reorder: packs.times(facts.packSize), reorderPacks: packs }
    }
    return { state: 'BELOW_MIN', position, reorder: wanted, reorderPacks: null }
  }
  return { state: onHand.greaterThan(max) ? 'ABOVE_MAX' : 'OK', position, reorder: ZERO, reorderPacks: facts.packSize ? ZERO : null }
}
