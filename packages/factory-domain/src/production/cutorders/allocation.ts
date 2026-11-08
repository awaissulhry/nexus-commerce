import { isInStock, lengthText, type Language, type LengthUom, type RollState } from '../../inventory/rolls/rolls'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'
import { perPlyLength } from './rules'

/**
 * Rolls allocated to the lays of a fabric cut order (B-W2b-112; MES-037 "Roll allocation by shade, width and shrinkage";
 * design production.cutting › Cut › Lays "rolls by shade, width and shrinkage group; mixing shade groups in one lay is refused
 * with the reason"), pure. An allocation is a LayRoll row with the plies planned from the roll; spreading at the table (B-W2b-116)
 * confirms or corrects each row's plies, so a lay counted at both ends holds the plies its rolls gave.
 *
 *   in stock     a roll FULL, PARTIAL or END, of the cut order's material and colour, at its site
 *   width        a roll narrower than the marker's usable width cannot take it (refused); a width not measured is a warning
 *   shade        one lay is spread from ONE shade: the roll's shade group and shade words (the database's rule too); lays of
 *                another shade on the same cut order are a warning (keep a garment's parts in one ply: ply stickers)
 *   shrinkage    one lay from ONE shrinkage group (the marker is made for one shrinkage); a group not measured is a warning,
 *                another group on another lay of the cut order a warning
 *   length       a roll gives whole plies: (length left − what other lays not yet spread plan from it) ÷ (the marker + the
 *                allowance at the ends), rounded down; a roll that gives none is refused
 *   quality      a roll whose incoming 4-point result is REJECTED, of a lot on hold, rejected or blocked, is refused; a lot not
 *                yet released is a warning
 *
 * The proposal fills each lay that is still to spread with the rolls of one shade and shrinkage group: a group that covers the
 * lay first (of those, one the cut order already uses), else the group that gives the most plies; inside it, the ends and part
 * rolls first (they are used up), then full rolls, longest first. Lengths are Decimal strings in the roll's unit; no money, no person.
 */

export const ALLOCATION_REFUSALS = ['ROLL_NOT_IN_STOCK', 'ROLL_OTHER_MATERIAL', 'ROLL_TOO_NARROW', 'ROLL_REJECTED', 'LOT_HELD', 'LOT_NOT_USABLE', 'ROLL_SHORT', 'MIXED_SHADE', 'MIXED_SHRINKAGE', 'LAY_FULL', 'LAY_NOT_PLANNED', 'ROLL_TWICE'] as const
export type AllocationRefusalCode = (typeof ALLOCATION_REFUSALS)[number]
export const ALLOCATION_WARNINGS = ['WIDTH_UNKNOWN', 'SHRINKAGE_UNKNOWN', 'SHADE_UNKNOWN', 'LOT_NOT_RELEASED', 'SHADES_ACROSS_LAYS', 'SHRINKAGE_ACROSS_LAYS'] as const
export type AllocationWarningCode = (typeof ALLOCATION_WARNINGS)[number]

export interface AllocationRefusal {
  readonly code: AllocationRefusalCode
  readonly message: string
}
export interface AllocationWarning {
  readonly code: AllocationWarningCode
  readonly message: string
}

export interface AllocRoll {
  readonly id: string
  readonly code: string
  readonly state: RollState
  readonly uom: LengthUom
  readonly lengthLeft: Decimal
  readonly widthCm: Decimal | null
  readonly shadeGroupId: string | null
  /** The shade's words (a group's label, or words typed at receiving). */
  readonly shade: string | null
  readonly shrinkageGroup: string | null
  readonly lotCode: string
  /** The lot's quality status (QUARANTINE, RELEASED, REJECTED, BLOCKED). */
  readonly lotQuality: string
  readonly lotHeld: boolean
  /** Its latest decided incoming 4-point result is REJECTED. */
  readonly rejected: boolean
  /** What lays not yet spread (of any cut order but the lay asked) plan from it: their plies × their marker, in its unit. */
  readonly plannedElsewhere: Decimal
}

export interface AllocMarker {
  readonly length: string
  readonly uom: LengthUom
  readonly widthCm: Decimal | null
}

/** The key a lay's rolls share: the shade group and the shade words (both, as the database compares them). */
export const shadeKeyOf = (roll: Pick<AllocRoll, 'shadeGroupId' | 'shade'>): string => JSON.stringify([roll.shadeGroupId, roll.shade])
const shrinkageOf = (roll: Pick<AllocRoll, 'shrinkageGroup'>): string | null => roll.shrinkageGroup

/** The length a roll still gives a new allocation: what is left less what other lays not yet spread plan from it. */
export const freeLength = (roll: Pick<AllocRoll, 'lengthLeft' | 'plannedElsewhere'>): Decimal => Dec.max(ZERO, roll.lengthLeft.minus(roll.plannedElsewhere))

/** Whole plies the roll gives (its free length less `used`, in its unit). */
export function pliesFrom(roll: Pick<AllocRoll, 'lengthLeft' | 'plannedElsewhere' | 'uom'>, marker: AllocMarker, allowanceCm = 0, used: Decimal = ZERO): number {
  const per = perPlyLength(marker, roll.uom, allowanceCm)
  if (per.lessThanOrEqualTo(0)) return 0
  // Whole plies: an integer count, read from the decimal's integer text (never a float of a length).
  return Math.max(0, Number.parseInt(Dec.max(ZERO, freeLength(roll).minus(used)).dividedToIntegerBy(per).toFixed(0), 10))
}

/** Why the roll cannot be allocated at all (null: it can), and what to look at. */
export function rollCheck(roll: AllocRoll, marker: AllocMarker, allowanceCm = 0, language: Language = 'en'): { readonly refusal: AllocationRefusal | null; readonly warnings: AllocationWarning[] } {
  const warnings: AllocationWarning[] = []
  if (roll.widthCm === null) warnings.push({ code: 'WIDTH_UNKNOWN', message: `Roll ${roll.code} has no width measured: check it against the marker.` })
  if (roll.shrinkageGroup === null) warnings.push({ code: 'SHRINKAGE_UNKNOWN', message: `Roll ${roll.code} has no shrinkage group.` })
  if (roll.shadeGroupId === null && roll.shade === null) warnings.push({ code: 'SHADE_UNKNOWN', message: `Roll ${roll.code} has no shade sorted.` })
  if (roll.lotQuality === 'QUARANTINE') warnings.push({ code: 'LOT_NOT_RELEASED', message: `Lot ${roll.lotCode} of roll ${roll.code} is not released by quality yet.` })
  const refuse = (code: AllocationRefusalCode, message: string) => ({ refusal: { code, message }, warnings })
  if (!isInStock(roll.state)) return refuse('ROLL_NOT_IN_STOCK', `Roll ${roll.code} is ${roll.state.toLowerCase()}: only a roll in stock is allocated.`)
  if (roll.rejected) return refuse('ROLL_REJECTED', `Roll ${roll.code} failed its 4-point inspection (rejected): it is not cut.`)
  if (roll.lotHeld) return refuse('LOT_HELD', `Lot ${roll.lotCode} of roll ${roll.code} is on hold: it is not cut.`)
  if (roll.lotQuality === 'REJECTED' || roll.lotQuality === 'BLOCKED') return refuse('LOT_NOT_USABLE', `Lot ${roll.lotCode} of roll ${roll.code} is ${roll.lotQuality.toLowerCase()}: it is not cut.`)
  if (marker.widthCm !== null && roll.widthCm !== null && roll.widthCm.lessThan(marker.widthCm)) {
    return refuse('ROLL_TOO_NARROW', `Roll ${roll.code} is ${roll.widthCm.toString()} cm wide; the marker needs ${marker.widthCm.toString()} cm.`)
  }
  if (pliesFrom(roll, marker, allowanceCm) === 0) {
    return refuse('ROLL_SHORT', `Roll ${roll.code} has ${lengthText(freeLength(roll), roll.uom, language)} free: not one ply of ${lengthText(perPlyLength(marker, roll.uom, allowanceCm), roll.uom, language)}.`)
  }
  return { refusal: null, warnings }
}

/** The lay's rolls (already allocated or spread, and the new ones) mix shades or shrinkage groups: the first clash in words. */
export function layMixRefusal(rolls: readonly Pick<AllocRoll, 'code' | 'shadeGroupId' | 'shade' | 'shrinkageGroup'>[]): AllocationRefusal | null {
  const first = rolls[0]
  if (!first) return null
  const otherShade = rolls.find((roll) => shadeKeyOf(roll) !== shadeKeyOf(first))
  if (otherShade) {
    return { code: 'MIXED_SHADE', message: `Roll ${otherShade.code} (shade ${otherShade.shade ?? 'none'}) is of another shade than roll ${first.code} (shade ${first.shade ?? 'none'}): one lay is spread from one shade.` }
  }
  const groups = [...new Set(rolls.map(shrinkageOf).filter((group): group is string => group !== null))]
  if (groups.length > 1) {
    const clash = rolls.find((roll) => roll.shrinkageGroup !== null && roll.shrinkageGroup !== groups[0])!
    return { code: 'MIXED_SHRINKAGE', message: `Roll ${clash.code} is of shrinkage group ${clash.shrinkageGroup}, the lay's other rolls of ${groups[0]}: one lay takes one shrinkage group (the marker is made for one).` }
  }
  return null
}

/** The cut order's lays use more than one shade or shrinkage group: warnings (the lays themselves are each of one). */
export function acrossLaysWarnings(lays: readonly (readonly Pick<AllocRoll, 'shadeGroupId' | 'shade' | 'shrinkageGroup'>[])[]): AllocationWarning[] {
  const rolls = lays.flat()
  const shades = new Set(rolls.map(shadeKeyOf))
  const groups = new Set(rolls.map(shrinkageOf).filter((group): group is string => group !== null))
  const warnings: AllocationWarning[] = []
  if (shades.size > 1) warnings.push({ code: 'SHADES_ACROSS_LAYS', message: `The lays are spread from ${shades.size} shades: keep each garment's parts in one ply (ply stickers) and its bundles by shade.` })
  if (groups.size > 1) warnings.push({ code: 'SHRINKAGE_ACROSS_LAYS', message: `The lays take ${groups.size} shrinkage groups (${[...groups].join(', ')}) with one marker.` })
  return warnings
}

// ---- the proposal -----------------------------------------------------------------------------------------------------------------

export interface LayNeed {
  readonly id: string
  readonly seq: number
  /** The plies it plans. */
  readonly plies: number
  /** Its rolls so far (allocated or spread) with their plies. */
  readonly rolls: readonly (Pick<AllocRoll, 'code' | 'shadeGroupId' | 'shade' | 'shrinkageGroup'> & { readonly rollId: string; readonly plies: number })[]
  /** Only a PLANNED lay is proposed for; a lay at the table is the spreader's. */
  readonly proposable: boolean
}

export interface ProposedLay {
  readonly layId: string
  readonly seq: number
  readonly need: number
  readonly rolls: { rollId: string; code: string; plies: number }[]
  /** Plies no fitting roll covers. */
  readonly short: number
}

const STATE_ORDER: Readonly<Record<string, number>> = { END: 0, PARTIAL: 1, FULL: 2 }

/** The allocation that fills each PLANNED lay from one shade and shrinkage group (see the head of this file). */
export function proposeAllocation(rolls: readonly AllocRoll[], lays: readonly LayNeed[], marker: AllocMarker, allowanceCm = 0): ProposedLay[] {
  const per = new Map<string, Decimal>(rolls.map((roll) => [roll.id, perPlyLength(marker, roll.uom, allowanceCm)]))
  const used = new Map<string, Decimal>()
  const fit = rolls.filter((roll) => rollCheck(roll, marker, allowanceCm).refusal === null)
  const available = (roll: AllocRoll): number => pliesFrom(roll, marker, allowanceCm, used.get(roll.id) ?? ZERO)
  const groupOf = (roll: Pick<AllocRoll, 'shadeGroupId' | 'shade' | 'shrinkageGroup'>): string => JSON.stringify([shadeKeyOf(roll), roll.shrinkageGroup])
  // The groups the cut order already uses, in lay order: a new lay prefers them.
  const preferred: string[] = []
  for (const lay of lays) for (const roll of lay.rolls) if (!preferred.includes(groupOf(roll))) preferred.push(groupOf(roll))

  return [...lays]
    .sort((left, right) => left.seq - right.seq)
    .filter((lay) => lay.proposable)
    .map((lay) => {
      const need = Math.max(0, lay.plies - lay.rolls.reduce((sum, roll) => sum + roll.plies, 0))
      if (need === 0) return { layId: lay.id, seq: lay.seq, need, rolls: [], short: 0 }
      // A lay with rolls keeps its shade and its shrinkage group (a roll of no group may join it; the check warns).
      const layShade = lay.rolls[0] ? shadeKeyOf(lay.rolls[0]) : null
      const layShrinkage = lay.rolls.map(shrinkageOf).find((group) => group !== null) ?? null
      const candidates = fit.filter((roll) => available(roll) > 0 && !lay.rolls.some((taken) => taken.rollId === roll.id))
      const groups = new Map<string, AllocRoll[]>()
      for (const roll of candidates) {
        if (layShade !== null && shadeKeyOf(roll) !== layShade) continue
        if (layShrinkage !== null && roll.shrinkageGroup !== null && roll.shrinkageGroup !== layShrinkage) continue
        const key = layShade !== null ? 'own' : groupOf(roll)
        groups.set(key, [...(groups.get(key) ?? []), roll])
      }
      const ordered = (list: readonly AllocRoll[]) =>
        [...list].sort((left, right) => (STATE_ORDER[left.state] ?? 3) - (STATE_ORDER[right.state] ?? 3) || (left.state === 'FULL' ? available(right) - available(left) : available(left) - available(right)) || left.code.localeCompare(right.code))
      const covered = (list: readonly AllocRoll[]) => list.reduce((sum, roll) => sum + available(roll), 0)
      // A group that covers the lay first; among those (and among those that do not) the groups in use first; then the most plies.
      const rank = [...groups].sort(([leftKey, left], [rightKey, right]) => {
        const leftCovers = covered(left) >= need
        const rightCovers = covered(right) >= need
        if (leftCovers !== rightCovers) return leftCovers ? -1 : 1
        const leftPreferred = preferred.indexOf(leftKey)
        const rightPreferred = preferred.indexOf(rightKey)
        if ((leftPreferred >= 0) !== (rightPreferred >= 0)) return leftPreferred >= 0 ? -1 : 1
        if (leftPreferred >= 0 && rightPreferred >= 0 && leftPreferred !== rightPreferred) return leftPreferred - rightPreferred
        return covered(right) - covered(left) || leftKey.localeCompare(rightKey)
      })
      const chosen = rank[0]
      const taken: { rollId: string; code: string; plies: number }[] = []
      let left = need
      if (chosen) {
        if (chosen[0] !== 'own' && !preferred.includes(chosen[0])) preferred.push(chosen[0])
        for (const roll of ordered(chosen[1])) {
          if (left === 0) break
          const plies = Math.min(left, available(roll))
          if (plies <= 0) continue
          taken.push({ rollId: roll.id, code: roll.code, plies })
          used.set(roll.id, (used.get(roll.id) ?? ZERO).plus(per.get(roll.id)!.times(plies)))
          left -= plies
        }
      }
      return { layId: lay.id, seq: lay.seq, need, rolls: taken, short: left }
    })
}

/** "Lay 1: RL-…-A 18 plies, RL-…-B 12 plies; lay 2: 6 plies short" (it "Materasso 1: …; materasso 2: mancano 6 strati"). */
export function proposalWords(proposal: readonly ProposedLay[], language: Language): string {
  const it = language === 'it'
  const plies = (n: number) => `${n} ${it ? (n === 1 ? 'strato' : 'strati') : n === 1 ? 'ply' : 'plies'}`
  if (proposal.length === 0) return it ? 'Nessun materasso da coprire.' : 'No lay to cover.'
  return proposal
    .map((lay, index) => {
      const head = `${index === 0 ? (it ? 'Materasso' : 'Lay') : it ? 'materasso' : 'lay'} ${lay.seq}`
      if (lay.need === 0) return `${head}: ${it ? 'coperto' : 'covered'}`
      const rolls = lay.rolls.map((roll) => `${roll.code} ${plies(roll.plies)}`)
      const short = lay.short > 0 ? [it ? `mancano ${plies(lay.short)}` : `${plies(lay.short)} short`] : []
      return `${head}: ${[...rolls, ...short].join(', ')}`
    })
    .join('; ')
}
