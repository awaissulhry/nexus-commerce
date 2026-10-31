/**
 * FloorCard's rules (B-W2b-28, design part FloorCard; A2 G5 "floor result card"): the typed card of a scanned thing at
 * floor size — type icon, code, status, 4–8 big key facts, flags with icon + word, the as-of time when cached.
 *
 * - **At most 8 facts** (`FLOOR_CARD_MAX_FACTS`): a card read at arm's length on a tablet holds no more. Facts after
 *   the eighth are not drawn; `floorCardFacts` says how many were left out so a host can test for it. A fact without a
 *   value is left out too (no empty rows, no "undefined").
 * - **Flags** carry an icon AND a word, never colour alone; a flag without its own icon gets its tone's icon.
 * - **As of**: a card drawn from the tablet's cache says when the facts were read; a live card has no time.
 */
import type { FloorTone } from '../tone'

export const FLOOR_CARD_MAX_FACTS = 8

export interface FloorCardFact {
  id: string
  /** "Articolo", "Pezzi", "Fase". */
  label: string
  /** The value. `null` / `undefined` / '' leaves the fact out. */
  value: string | number | null | undefined
  /** A value that needs attention ("Manca 1"): its tone, drawn with a word in the value itself. */
  tone?: FloorTone
}

export interface FloorCardFlag {
  id: string
  /** The flag's word ("In attesa di controllo", "Priorità"). */
  label: string
  /** Default `warning`. */
  tone?: FloorTone
}

/** The facts to draw (at most 8, each with a value) and how many were left out. */
export function floorCardFacts(facts: readonly FloorCardFact[], max = FLOOR_CARD_MAX_FACTS): { shown: FloorCardFact[]; left: number } {
  const withValue = facts.filter((f) => f.value !== null && f.value !== undefined && String(f.value).trim() !== '')
  const shown = withValue.slice(0, Math.max(0, max))
  return { shown, left: facts.length - shown.length }
}

/** The icon kind a flag draws by its tone when it has none of its own. */
export function floorFlagIcon(tone: FloorTone = 'warning'): 'alert' | 'info' | 'check' | 'flag' {
  if (tone === 'danger' || tone === 'warning') return 'alert'
  if (tone === 'info') return 'info'
  if (tone === 'success') return 'check'
  return 'flag'
}
