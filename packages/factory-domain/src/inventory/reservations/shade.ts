/**
 * One shade lot per order (B-W2b-100; SCM-206, MES-052; Q18's default; design production.workorders "Materials & leather":
 * "W1 the cutter keeps one dye batch by hand; W2b one shade lot rule"), pure. The hides of one work order (or one order line)
 * come from one shade lot, so the garments of the order match. A shade lot is one lot (the tannery's dye batch) and, within
 * it, one shade group (Hide.shadeGroupId, sorted against the swatch; a W1 hide falls back to its shade text); an unsorted hide
 * is its lot's "unsorted" shade. A hide of an out-of-shade group goes in no order that asks one shade.
 *
 *   ORDER    (the default, Q18: one batch per order, not per garment) checked when hides are reserved for a work order or an
 *            order line and when a hide is issued to a work order: every hide it holds or has reserved is of one shade lot.
 *   GARMENT  one shade lot per garment: several lots may serve one order, so neither the reserve nor the pick checks it; the
 *            cutting table checks a garment's pieces (B-W2b-103).
 *   OFF      no check.
 *
 * The rule is a setting, and no table has its column yet (a schema need of this step): every site uses DEFAULT_SHADE_RULE
 * until one does. A refusal is let through only with a reason by a person holding inventory.shade.override.
 */

export const SHADE_RULES = ['ORDER', 'GARMENT', 'OFF'] as const
export type ShadeRule = (typeof SHADE_RULES)[number]

/** Q18 unanswered: the question's default, one batch per order (plan §12, the lead's default). */
export const DEFAULT_SHADE_RULE: ShadeRule = 'ORDER'

/** Does the rule ask one shade lot for the whole order (so the reserve and the pick check it)? */
export const asksOneShadePerOrder = (rule: ShadeRule): boolean => rule === 'ORDER'

/** What the rule reads of a hide: its lot and its shade (group or W1 text). */
export interface ShadeFacts {
  readonly hideId: string
  readonly hideCode: string
  readonly lotId: string
  readonly lotCode: string
  /** The shade group as a record, or null (a W1 hide or one not sorted). */
  readonly shadeGroupId: string | null
  /** The group's label, else the W1 shade text, else null (unsorted). */
  readonly shadeLabel: string | null
  /** The hide's group is the out-of-shade group. */
  readonly outOfShade: boolean
}

const norm = (text: string | null): string | null => {
  const value = text?.trim().toUpperCase() ?? ''
  return value === '' ? null : value
}

/** The shade lot of a hide: its lot and its group (or its W1 shade text), "-" when it is not sorted. */
export function shadeLotKey(facts: Pick<ShadeFacts, 'lotId' | 'shadeGroupId' | 'shadeLabel'>): string {
  const shade = facts.shadeGroupId ? `g:${facts.shadeGroupId}` : norm(facts.shadeLabel) ? `t:${norm(facts.shadeLabel)}` : '-'
  return `${facts.lotId}|${shade}`
}

export type ShadeLanguage = 'it' | 'en'

/** A shade lot in words: "lot LA-000001, shade 2" / "lotto LA-000001, tonalità 2"; unsorted: "lot LA-000001 (not sorted by shade)". */
export function shadeLotWords(facts: Pick<ShadeFacts, 'lotCode' | 'shadeLabel'>, language: ShadeLanguage = 'en'): string {
  const label = facts.shadeLabel?.trim() || null
  if (language === 'it') return label ? `lotto ${facts.lotCode}, tonalità ${label}` : `lotto ${facts.lotCode} (non diviso per tonalità)`
  return label ? `lot ${facts.lotCode}, shade ${label}` : `lot ${facts.lotCode} (not sorted by shade)`
}

export const SHADE_REFUSALS = ['SHADE_LOT', 'OUT_OF_SHADE'] as const
export type ShadeRefusalCode = (typeof SHADE_REFUSALS)[number]

export interface ShadeRefusal {
  readonly code: ShadeRefusalCode
  readonly message: string
}

/** The shade lots among these hides, each once, in the order first met. */
export function shadeLotsOf<Facts extends ShadeFacts>(hides: readonly Facts[]): { readonly key: string; readonly first: Facts; readonly hides: number }[] {
  const lots = new Map<string, { key: string; first: Facts; hides: number }>()
  for (const hide of hides) {
    const key = shadeLotKey(hide)
    const entry = lots.get(key)
    if (entry) entry.hides += 1
    else lots.set(key, { key, first: hide, hides: 1 })
  }
  return [...lots.values()]
}

/**
 * Whether one more hide may join what an order holds or has reserved (`held`: its hides, any lot), under the rule. Null: it
 * may. `demand` names the order in the sentence ("work order WO-0041").
 */
export function shadeRefusal(rule: ShadeRule, demand: string, held: readonly ShadeFacts[], hide: ShadeFacts): ShadeRefusal | null {
  if (!asksOneShadePerOrder(rule)) return null
  if (hide.outOfShade) {
    return { code: 'OUT_OF_SHADE', message: `Hide ${hide.hideCode} is out of shade (${shadeLotWords(hide)}): it goes in no order that asks one shade lot, as ${demand} does.` }
  }
  const lots = shadeLotsOf(held.filter((other) => other.hideId !== hide.hideId))
  if (lots.length === 0 || lots.some((lot) => lot.key === shadeLotKey(hide))) return null
  const theirs = lots.map((lot) => shadeLotWords(lot.first)).join('; ')
  return {
    code: 'SHADE_LOT',
    message: `${demand.charAt(0).toUpperCase()}${demand.slice(1)} is cut from ${theirs}; hide ${hide.hideCode} is ${shadeLotWords(hide)}. One shade lot per order: take a hide of the same shade lot, or a person allowed to override the shade rule lets it through with the reason.`,
  }
}

/** The override's reason, when one is given: at least 3 characters, at most 500. */
export function shadeReasonProblem(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null
  const text = reason.trim()
  return text.length < 3 || text.length > 500 ? 'Say why the shade rule is overridden (3 to 500 characters).' : null
}
