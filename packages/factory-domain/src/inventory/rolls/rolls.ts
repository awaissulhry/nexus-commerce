import type { Issue } from '../../core/errors'
import { fixedRatio, QUANTITY_SCALE, UNITS, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Fabric roll tracking (B-W2b-107; SCM-260; design production.cutting "rolls by shade, width and shrinkage group",
 * floor.fabriccut "Scan each roll label", warehouse.lots "rolls"), pure. A roll is a tagged part of a fabric lot (RL-…): the
 * ledger stays per lot (a move names no roll), and the roll keeps its tag, what it is (width, shade, shrinkage, defects) and
 * what of it is left IN STOCK (`lengthLeft`, in the roll's own length unit), changed in the same command as the lot's move:
 *
 *   tag       rolls of a lot's stock at a place: never more than the place holds of the lot that no roll claims yet
 *   issue     a length off a roll in stock to a work order (the lot's ISSUE): what is left stays; all of it → CONSUMED
 *   return    the end of a roll that went whole to a work order comes back (the lot's RETURN): END, at the return's place
 *   move      a roll in stock to another place of the site (the lot's TRANSFER of what is left)
 *   scrap     a roll in stock written off (the lot's SCRAP of what is left): SCRAPPED
 *   correct   a roll in stock measured again (the lot's ADJUSTMENT of the difference); the length received never changes
 *   end       a part roll set aside as an end of roll (PARTIAL ↔ END; no move)
 *
 * The state always says what is left (the database's FabricRoll guard): FULL all of it, PARTIAL and END some of it,
 * CONSUMED none; SCRAPPED and RETURNED left the stock with what they had. Lengths are Decimal(18,4) strings; never a float.
 */

export const ROLL_STATES = ['FULL', 'PARTIAL', 'END', 'CONSUMED', 'SCRAPPED', 'RETURNED'] as const
export type RollState = (typeof ROLL_STATES)[number]

/** The states of a roll that lies in the site's stock. */
export const IN_STOCK_STATES = ['FULL', 'PARTIAL', 'END'] as const satisfies readonly RollState[]
export const isInStock = (state: RollState): boolean => (IN_STOCK_STATES as readonly RollState[]).includes(state)

/** The units a roll's length is entered in (the database's FabricRoll check). */
export const LENGTH_UOMS = ['M', 'CM', 'MM'] as const satisfies readonly Uom[]
export type LengthUom = (typeof LENGTH_UOMS)[number]
export const isLengthUom = (uom: string): uom is LengthUom => (LENGTH_UOMS as readonly string[]).includes(uom)

export const ROLL_LIMITS = Object.freeze({
  /** Rolls tagged in one request. */
  perTag: 50,
  supplierRollRef: 60,
  shade: 40,
  shrinkageGroup: 20,
  defects: 500,
  note: 500,
  /** Above 0, at most this many centimetres (a roll wider than 10 m is a typo). */
  widthCm: '1000',
  /** At most this many metres on one roll. */
  lengthM: '100000',
})

/** A length in another length unit, at four decimals (HALF_UP). */
export function lengthIn(quantity: DecimalInput, from: LengthUom, to: LengthUom): Decimal {
  const ratio = fixedRatio(from, to)
  if (!ratio) throw new RangeError(`${from} does not convert to ${to}`)
  return new Dec(quantity.toString()).times(ratio.toString()).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
}

/** The state what is left says: FULL all of it, CONSUMED none, else PARTIAL, or END for a part roll kept as an end. */
export function stateOf(length: DecimalInput, lengthLeft: DecimalInput, end: boolean): 'FULL' | 'PARTIAL' | 'END' | 'CONSUMED' {
  const left = new Dec(lengthLeft.toString())
  if (left.isZero()) return 'CONSUMED'
  if (left.equals(new Dec(length.toString()))) return 'FULL'
  return end ? 'END' : 'PARTIAL'
}

const decimalOrNull = (value: unknown): Decimal | null => {
  if (typeof value !== 'string' || !/^-?\d{1,14}(\.\d{1,4})?$/.test(value.trim())) return null
  return new Dec(value.trim())
}
const text = (value: string | null | undefined): string => (value ?? '').trim()
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/

/** What a roll is: the parts the tag and the correction share. Every field optional. */
export interface RollDescription {
  readonly supplierRollRef?: string | null | undefined
  readonly widthCm?: string | null | undefined
  readonly shade?: string | null | undefined
  readonly shrinkageLengthPercent?: string | null | undefined
  readonly shrinkageWidthPercent?: string | null | undefined
  readonly shrinkageGroup?: string | null | undefined
  readonly defects?: string | null | undefined
  readonly note?: string | null | undefined
}

/** The description's problems, paths relative to it. */
export function descriptionProblems(draft: RollDescription): Issue[] {
  const problems: Issue[] = []
  if (text(draft.supplierRollRef).length > ROLL_LIMITS.supplierRollRef) problems.push({ path: 'supplierRollRef', message: `At most ${ROLL_LIMITS.supplierRollRef} characters.` })
  if (draft.widthCm !== undefined && draft.widthCm !== null) {
    const width = decimalOrNull(draft.widthCm)
    if (!width || !/^\d{1,8}(\.\d{1,2})?$/.test(draft.widthCm.trim()) || !width.greaterThan(0) || width.greaterThan(ROLL_LIMITS.widthCm)) {
      problems.push({ path: 'widthCm', message: `The usable width in centimetres, above 0 and at most ${ROLL_LIMITS.widthCm}, two decimals.` })
    }
  }
  if (text(draft.shade).length > ROLL_LIMITS.shade) problems.push({ path: 'shade', message: `At most ${ROLL_LIMITS.shade} characters.` })
  for (const field of ['shrinkageLengthPercent', 'shrinkageWidthPercent'] as const) {
    const value = draft[field]
    if (value === undefined || value === null) continue
    if (!PERCENT.test(value.trim()) || new Dec(value.trim()).greaterThan(100)) problems.push({ path: field, message: 'A percent from 0 to 100, two decimals.' })
  }
  const group = text(draft.shrinkageGroup)
  if (group.length > ROLL_LIMITS.shrinkageGroup || /\s/.test(group)) problems.push({ path: 'shrinkageGroup', message: `A short code without spaces ("S1"), at most ${ROLL_LIMITS.shrinkageGroup} characters.` })
  if (text(draft.defects).length > ROLL_LIMITS.defects) problems.push({ path: 'defects', message: `At most ${ROLL_LIMITS.defects} characters.` })
  if (text(draft.note).length > ROLL_LIMITS.note) problems.push({ path: 'note', message: `At most ${ROLL_LIMITS.note} characters.` })
  return problems
}

/** A length entered for a roll: above 0 (or 0 when `zero` allows it), four decimals, at most the limit in metres. */
export function lengthProblem(value: string | undefined, uom: LengthUom, path: string, zero = false): Issue | null {
  const length = decimalOrNull(value)
  if (!length || length.isNegative() || (!zero && length.isZero())) return { path, message: zero ? 'A length of 0 or more, four decimals.' : 'A length above 0, four decimals.' }
  if (lengthIn(length, uom, 'M').greaterThan(ROLL_LIMITS.lengthM)) return { path, message: `At most ${ROLL_LIMITS.lengthM} m on one roll.` }
  return null
}

export interface RollDraft extends RollDescription {
  readonly length: string
}

/** One roll to tag: its length and what it is. */
export function rollDraftProblems(draft: RollDraft, uom: LengthUom): Issue[] {
  const problems = descriptionProblems(draft)
  const length = lengthProblem(draft.length, uom, 'length')
  if (length) problems.unshift(length)
  return problems
}

// ---- refusals -------------------------------------------------------------------------------------------------------------

export const ROLL_REFUSALS = [
  'NOT_A_FABRIC_LOT',
  'NOTHING_TO_TAG',
  'TAGGED_BEYOND_STOCK',
  'ROLL_NOT_IN_STOCK',
  'ROLL_NOT_CONSUMED',
  'LENGTH_BEYOND_LEFT',
  'LENGTH_BEYOND_ROLL',
  'NOT_AT_WORK_ORDER',
  'SAME_PLACE',
  'NOT_A_PART_ROLL',
  'NOTHING_CHANGES',
  'ROLL_GONE',
] as const
export type RollRefusalCode = (typeof ROLL_REFUSALS)[number]

export interface RollRefusal {
  readonly code: RollRefusalCode
  readonly message: string
}

/** What a decision needs to know of a roll. Lengths in the roll's unit. */
export interface RollFacts {
  readonly code: string
  readonly state: RollState
  readonly length: string
  readonly lengthLeft: string
  readonly uom: LengthUom
  readonly locationId: string | null
}

/** A roll after a write: what is left, its state, where it lies (null: not in stock). */
export interface RollAfter {
  readonly lengthLeft: string
  readonly state: RollState
  readonly locationId: string | null
}

export type RollDecision = { readonly ok: true; readonly quantity: string; readonly after: RollAfter } | { readonly ok: false; readonly refusal: RollRefusal }

const refuse = (code: RollRefusalCode, message: string): RollDecision => ({ ok: false, refusal: { code, message } })
const q4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const symbolOf = (uom: LengthUom) => UNITS[uom].symbol

function notInStock(roll: RollFacts): RollRefusal | null {
  if (isInStock(roll.state) && roll.locationId !== null && new Dec(roll.lengthLeft).greaterThan(0)) return null
  const where = roll.state === 'CONSUMED' ? 'it went to a work order (nothing of it is in stock)' : roll.state === 'SCRAPPED' ? 'it was scrapped' : roll.state === 'RETURNED' ? 'it went back to the supplier' : 'it lies in no place'
  return { code: 'ROLL_NOT_IN_STOCK', message: `Roll ${roll.code} is not in stock: ${where}.` }
}

/**
 * A length off a roll in stock to a work order (default all that is left). What is left stays where it lies; all of it
 * leaves the stock (CONSUMED: the whole roll went to the work order, and its end may come back).
 */
export function issueDecision(roll: RollFacts, length?: string): RollDecision {
  const blocked = notInStock(roll)
  if (blocked) return { ok: false, refusal: blocked }
  const left = new Dec(roll.lengthLeft)
  const taken = length === undefined ? left : new Dec(length)
  if (!taken.greaterThan(0)) return refuse('LENGTH_BEYOND_LEFT', 'Take a length above 0 off the roll.')
  if (taken.greaterThan(left)) return refuse('LENGTH_BEYOND_LEFT', `Roll ${roll.code} has ${lengthText(left, roll.uom, 'en')} left: take at most that.`)
  const rest = left.minus(taken)
  return { ok: true, quantity: q4(taken), after: { lengthLeft: q4(rest), state: stateOf(roll.length, rest, roll.state === 'END'), locationId: rest.isZero() ? null : roll.locationId } }
}

/**
 * The end of a roll that went whole to a work order comes back to a place: what comes back is what is left (END; FULL when
 * all of it comes back unused). Only a CONSUMED roll takes an end back: a roll still in stock was cut, and a cut length
 * that comes back is the lot's (the pick list's return).
 */
export function returnDecision(roll: RollFacts, length: string, toLocationId: string): RollDecision {
  if (roll.state !== 'CONSUMED') {
    return refuse('ROLL_NOT_CONSUMED', `Roll ${roll.code} is ${roll.state}: only a roll that went whole to a work order takes its end back. A length cut off it comes back as the lot's (Pick & issue › Return).`)
  }
  const back = new Dec(length)
  if (!back.greaterThan(0)) return refuse('LENGTH_BEYOND_ROLL', 'Bring back a length above 0.')
  if (back.greaterThan(roll.length)) return refuse('LENGTH_BEYOND_ROLL', `Roll ${roll.code} was ${lengthText(roll.length, roll.uom, 'en')} long: more cannot come back on it.`)
  return { ok: true, quantity: q4(back), after: { lengthLeft: q4(back), state: stateOf(roll.length, back, true), locationId: toLocationId } }
}

/** A roll in stock to another place of the site: all that is left moves. */
export function moveDecision(roll: RollFacts, toLocationId: string): RollDecision {
  const blocked = notInStock(roll)
  if (blocked) return { ok: false, refusal: blocked }
  if (roll.locationId === toLocationId) return refuse('SAME_PLACE', `Roll ${roll.code} already lies there.`)
  return { ok: true, quantity: q4(new Dec(roll.lengthLeft)), after: { lengthLeft: q4(new Dec(roll.lengthLeft)), state: roll.state, locationId: toLocationId } }
}

/** A roll in stock written off: all that is left leaves the stock; the roll keeps what it had (SCRAPPED). */
export function scrapDecision(roll: RollFacts): RollDecision {
  const blocked = notInStock(roll)
  if (blocked) return { ok: false, refusal: blocked }
  return { ok: true, quantity: q4(new Dec(roll.lengthLeft)), after: { lengthLeft: q4(new Dec(roll.lengthLeft)), state: 'SCRAPPED', locationId: null } }
}

/**
 * A roll in stock measured again: the lot's stock moves by the difference (an adjustment), the roll says the new length
 * left. The length received is fixed: a measure above it is refused (a correction of the receipt is the receipt's).
 * `quantity` is the difference (always above 0); `direction` says which way.
 */
export function correctDecision(roll: RollFacts, measured: string): RollDecision & { readonly direction?: 'IN' | 'OUT' } {
  const blocked = notInStock(roll)
  if (blocked) return { ok: false, refusal: blocked }
  const now = new Dec(measured)
  if (now.isNegative()) return refuse('LENGTH_BEYOND_ROLL', 'A length of 0 or more.')
  if (now.greaterThan(roll.length)) return refuse('LENGTH_BEYOND_ROLL', `Roll ${roll.code} came in ${lengthText(roll.length, roll.uom, 'en')} long and the length received never changes: measure at most that.`)
  const left = new Dec(roll.lengthLeft)
  if (now.equals(left)) return refuse('NOTHING_CHANGES', `Roll ${roll.code} already says ${lengthText(left, roll.uom, 'en')} left.`)
  const difference = now.minus(left)
  return {
    ok: true,
    quantity: q4(difference.abs()),
    direction: difference.isNegative() ? 'OUT' : 'IN',
    after: { lengthLeft: q4(now), state: stateOf(roll.length, now, roll.state === 'END'), locationId: now.isZero() ? null : roll.locationId },
  }
}

/** A part roll set aside as an end of roll, or back to a part roll (no move: the stock is the same). */
export function endDecision(roll: RollFacts, end: boolean): RollDecision {
  const blocked = notInStock(roll)
  if (blocked) return { ok: false, refusal: blocked }
  if (roll.state === 'FULL') return refuse('NOT_A_PART_ROLL', `Roll ${roll.code} is untouched: only a roll that was cut from is an end of roll.`)
  if ((roll.state === 'END') === end) return refuse('NOTHING_CHANGES', end ? `Roll ${roll.code} is an end of roll already.` : `Roll ${roll.code} is not an end of roll.`)
  return { ok: true, quantity: q4(ZERO), after: { lengthLeft: q4(new Dec(roll.lengthLeft)), state: end ? 'END' : 'PARTIAL', locationId: roll.locationId } }
}

/** A roll that left for good (scrapped, back to the supplier) is history: its description stays as it was. */
export function describeRefusal(roll: Pick<RollFacts, 'code' | 'state'>): RollRefusal | null {
  if (roll.state === 'SCRAPPED' || roll.state === 'RETURNED') return { code: 'ROLL_GONE', message: `Roll ${roll.code} is ${roll.state}: it is history and stays as it was.` }
  return null
}

/** An end coming back is never more than the work order holds of the lot (the ledger's truth). Base unit. */
export function atWorkOrderRefusal(roll: Pick<RollFacts, 'code'>, workOrderNumber: string, lotCode: string, held: Decimal, back: Decimal, base: LengthUom): RollRefusal | null {
  if (back.lessThanOrEqualTo(held)) return null
  return {
    code: 'NOT_AT_WORK_ORDER',
    message: held.greaterThan(0)
      ? `Work order ${workOrderNumber} holds ${lengthText(held, base, 'en')} of lot ${lotCode}: at most that comes back on roll ${roll.code}.`
      : `Work order ${workOrderNumber} holds none of lot ${lotCode}: roll ${roll.code} did not go to it.`,
  }
}

/** A shade group a roll may be sorted into: active, of its article, its colour or any, its lot or any (factory_shade_group_fits). */
export function rollShadeProblem(
  group: { readonly id: string; readonly itemId: string; readonly itemColourId: string | null; readonly lotId: string | null; readonly label: string; readonly active: boolean },
  roll: { readonly code: string; readonly itemId: string; readonly lotId: string; readonly itemColourId: string | null; readonly shadeGroupId: string | null },
): string | null {
  if (group.id === roll.shadeGroupId) return null
  if (!group.active) return `Shade group ${group.label} is retired: no roll is sorted into it.`
  if (group.itemId !== roll.itemId) return `Shade group ${group.label} is of another article than roll ${roll.code}.`
  if (group.lotId !== null && group.lotId !== roll.lotId) return `Shade group ${group.label} is another lot's.`
  if (group.itemColourId !== null && group.itemColourId !== roll.itemColourId) return `Shade group ${group.label} is of another colour than roll ${roll.code}.`
  return null
}

// ---- tagging against the lot's stock -----------------------------------------------------------------------------------

/** One place of the site: what the ledger holds of the lot there, and what the rolls in stock there say (base unit). */
export interface PlaceCheck {
  readonly locationId: string
  readonly onHand: Decimal
  readonly tagged: Decimal
}

/** What is left to tag at a place (never below 0). */
export const untaggedAt = (place: PlaceCheck): Decimal => Dec.max(ZERO, place.onHand.minus(place.tagged))

/**
 * New rolls at a place, `lengths` in the base unit: refused when they claim more of the lot than the place holds without a
 * roll (the ledger is the truth; a roll never claims stock the ledger does not have).
 */
export function tagRefusal(lotCode: string, placeCode: string, place: PlaceCheck | undefined, lengths: readonly Decimal[], base: LengthUom): RollRefusal | null {
  const asked = lengths.reduce((sum, length) => sum.plus(length), ZERO)
  const free = place ? untaggedAt(place) : ZERO
  if (!free.greaterThan(0)) return { code: 'NOTHING_TO_TAG', message: `Lot ${lotCode} has nothing at ${placeCode} that no roll claims yet.` }
  if (asked.greaterThan(free)) {
    return {
      code: 'TAGGED_BEYOND_STOCK',
      message: `${lengths.length === 1 ? 'The roll says' : `The ${lengths.length} rolls say`} ${lengthText(asked, base, 'en')}, but lot ${lotCode} has ${lengthText(free, base, 'en')} at ${placeCode} that no roll claims yet.`,
    }
  }
  return null
}

/**
 * The lot's rolls against its ledger, per place: what the ledger holds, what the rolls in stock say, what no roll claims,
 * and what the rolls say beyond the ledger (a W1 lot move took stock no roll gave: a count or a correction mends it).
 */
export interface LotRollCheck {
  readonly onHand: Decimal
  readonly tagged: Decimal
  readonly untagged: Decimal
  readonly beyond: Decimal
  readonly places: readonly (PlaceCheck & { readonly untagged: Decimal; readonly beyond: Decimal })[]
}

export function lotRollCheck(onHandAt: ReadonlyMap<string, Decimal>, rolls: readonly { readonly locationId: string; readonly lengthLeftBase: Decimal }[]): LotRollCheck {
  const tagged = new Map<string, Decimal>()
  for (const roll of rolls) tagged.set(roll.locationId, (tagged.get(roll.locationId) ?? ZERO).plus(roll.lengthLeftBase))
  const ids = [...new Set([...onHandAt.keys(), ...tagged.keys()])].sort()
  const places = ids.map((locationId) => {
    const onHand = onHandAt.get(locationId) ?? ZERO
    const own = tagged.get(locationId) ?? ZERO
    return { locationId, onHand, tagged: own, untagged: Dec.max(ZERO, onHand.minus(own)), beyond: Dec.max(ZERO, own.minus(onHand)) }
  })
  const add = (pick: (place: (typeof places)[number]) => Decimal) => places.reduce((sum, place) => sum.plus(pick(place)), ZERO)
  return { onHand: add((place) => place.onHand), tagged: add((place) => place.tagged), untagged: add((place) => place.untagged), beyond: add((place) => place.beyond), places }
}

// ---- words ----------------------------------------------------------------------------------------------------------------

export type Language = 'it' | 'en'

const MARKS: Readonly<Record<Language, { readonly group: string; readonly point: string }>> = { it: { group: '.', point: ',' }, en: { group: ',', point: '.' } }
const ROLLS: Readonly<Record<Language, { readonly one: string; readonly many: string }>> = { it: { one: 'rotolo', many: 'rotoli' }, en: { one: 'roll', many: 'rolls' } }

/** A decimal written for people: up to two decimals (trailing zeros dropped), grouped by thousands, exact. */
export function numberText(value: DecimalInput, language: Language): string {
  const fixed = new Dec(value.toString()).toFixed(2, Dec.ROUND_HALF_UP)
  const negative = fixed.startsWith('-')
  const [whole, fraction] = (negative ? fixed.slice(1) : fixed).split('.')
  const trimmed = (fraction ?? '').replace(/0+$/, '')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, MARKS[language].group)
  return `${negative ? '-' : ''}${grouped}${trimmed ? `${MARKS[language].point}${trimmed}` : ''}`
}

/** "44.5 m" (it "44,5 m"). */
export const lengthText = (value: DecimalInput, uom: LengthUom, language: Language): string => `${numberText(value, language)} ${symbolOf(uom)}`

/** Rolls beside their length: "3 rolls · 164.5 m" (it "3 rotoli · 164,5 m"). */
export function rollsWords(count: number, length: DecimalInput, uom: LengthUom, language: Language): string {
  return `${count} ${count === 1 ? ROLLS[language].one : ROLLS[language].many} · ${lengthText(length, uom, language)}`
}

/** The lot check in words: "120 m in stock: 2 rolls · 104.5 m; 15.5 m on no roll" (+ "the rolls say 44.5 m more than the ledger"). */
export function lotCheckWords(check: LotRollCheck, rollCount: number, uom: LengthUom, language: Language): string {
  const en = language === 'en'
  const parts = [`${lengthText(check.onHand, uom, language)} ${en ? 'in stock' : 'a magazzino'}: ${rollsWords(rollCount, check.tagged, uom, language)}`]
  if (check.untagged.greaterThan(0)) parts.push(`${lengthText(check.untagged, uom, language)} ${en ? 'on no roll' : 'senza rotolo'}`)
  if (check.beyond.greaterThan(0)) parts.push(en ? `the rolls say ${lengthText(check.beyond, uom, language)} more than the ledger holds where they lie` : `i rotoli dicono ${lengthText(check.beyond, uom, language)} in più di quanto il registro ha dove si trovano`)
  return parts.join('; ')
}
