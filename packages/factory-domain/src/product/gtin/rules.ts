import type { Issue } from '../../core/errors'
import { gtinCheckDigit, parseGtin } from '../styles/sku'

/**
 * GTINs of SKUs in depth (B-W2b-227; PRD-006), pure. A GTIN (the barcode, EAN-13 in Italy) is W1's Variant.gtin: GS1 check
 * digit, one canonical form (styles/sku parseGtin, exactly what the database accepts), unique in the tenant, and never
 * changed or cleared once garments of the SKU have shipped (B-W2b-206's Variant_gtin_guard). Two ways to give SKUs one:
 *
 *   typed or imported   a brand's own barcodes (a brand sells under its own name and barcodes): one SKU at a time (W1's
 *                       PATCH of the SKU) or a list of SKU + GTIN rows checked first (`importVerdicts`), then written all
 *                       together; works now;
 *   from a range        the company's own GS1 numbers (GtinRange: a GS1 company prefix and a block of item references):
 *                       the next free references, a preview first (`planAllocation`), then the confirm. A reference is
 *                       given once (nextReference never goes back) and one already on a SKU is skipped, never given twice.
 *
 * GATE-SPEND (Owner 11-09): a GS1 company prefix is a paid yearly membership. Ranges are a setting today; assigning from
 * one is refused in a staging or production environment until the Owner's word turns GTIN_RANGE_ALLOCATION_ALLOWED to
 * true (local and test runs assign from made-up ranges). Typing a brand's barcodes needs no membership.
 */

/** One line: true only on the Owner's yes (GATE-SPEND, a GS1 membership). */
export const GTIN_RANGE_ALLOCATION_ALLOWED = false

export type AllocationRefusal = 'GATE_SPEND'

/** Whether GTINs may be given from a range in this environment now (null: they may). */
export function allocationRefusal(environment: string): AllocationRefusal | null {
  if (GTIN_RANGE_ALLOCATION_ALLOWED) return null
  return environment === 'local' || environment === 'test' ? null : 'GATE_SPEND'
}

export const ALLOCATION_REFUSAL_WORDS: Readonly<Record<AllocationRefusal, string>> = Object.freeze({
  GATE_SPEND:
    "GTINs from our own GS1 range wait for the Owner's word: a GS1 company prefix is a paid yearly membership. Type or import the brand's own barcodes on its SKUs meanwhile.",
})

// ---- ranges --------------------------------------------------------------------------------------------------------------

export interface RangeLimits {
  readonly gs1Prefix: string
  readonly firstReference: number
  readonly lastReference: number
}

export interface RangeState extends RangeLimits {
  readonly nextReference: number
}

/** How many item references a prefix leaves: 10^(12 − its digits). */
export const referencesOf = (gs1Prefix: string): number => 10 ** (12 - gs1Prefix.length)

/** The GTIN-13 of an item reference: prefix + the reference in 12 − prefix digits + the check digit (canonical form). */
export function gtinOf(gs1Prefix: string, reference: number): string {
  const body = `${gs1Prefix}${String(reference).padStart(12 - gs1Prefix.length, '0')}`
  const parsed = parseGtin(`${body}${gtinCheckDigit(body)}`)
  if (!parsed.ok) throw new Error(`gtinOf: ${parsed.message}`)
  return parsed.gtin
}

/** References still to give: next to last (0: used up). */
export const rangeLeft = (range: Pick<RangeState, 'nextReference' | 'lastReference'>): number => Math.max(0, range.lastReference - range.nextReference + 1)
/** A reference was given already: the prefix and the limits are fixed (the database keeps them so). */
export const rangeUsed = (range: Pick<RangeState, 'nextReference' | 'firstReference'>): boolean => range.nextReference > range.firstReference

export interface RangeInput extends RangeLimits {
  readonly name: string
}

/** What is wrong with a range, in words at its field. */
export function rangeProblems(input: RangeInput): Issue[] {
  const issues: Issue[] = []
  const name = input.name.trim()
  if (name.length === 0 || name.length > 100 || /[\u0000-\u001F\u007F]/.test(input.name)) issues.push({ path: 'name', message: 'A name of 1 to 100 characters on one line ("GS1 Italy 2027").' })
  if (!/^[0-9]{4,12}$/.test(input.gs1Prefix)) {
    issues.push({ path: 'gs1Prefix', message: 'A GS1 company prefix is 4 to 12 digits, as GS1 gave it.' })
    return issues
  }
  if (input.gs1Prefix.startsWith('00000')) {
    issues.push({ path: 'gs1Prefix', message: 'A prefix starting 00000 gives GTIN-8 numbers, which GS1 hands out one by one: type them on the SKUs instead.' })
  }
  const room = referencesOf(input.gs1Prefix)
  if (!Number.isSafeInteger(input.firstReference) || input.firstReference < 0) issues.push({ path: 'firstReference', message: 'The first item reference is a whole number from 0.' })
  if (!Number.isSafeInteger(input.lastReference) || input.lastReference >= room) issues.push({ path: 'lastReference', message: `This prefix leaves item references 0 to ${room - 1}.` })
  else if (input.lastReference < input.firstReference) issues.push({ path: 'lastReference', message: 'The last item reference is not before the first.' })
  return issues
}

/** The changes a used range refuses (its prefix and limits), in words; null when none is asked. */
export function usedRangeRefusal(current: RangeState, next: Partial<RangeLimits>): string | null {
  if (!rangeUsed(current)) return null
  const changes = (['gs1Prefix', 'firstReference', 'lastReference'] as const).filter((field) => next[field] !== undefined && next[field] !== current[field])
  if (changes.length === 0) return null
  return `This range has given ${current.nextReference - current.firstReference} GTIN(s): its prefix and limits stay as they are (start a new range for more numbers).`
}

// ---- assigning from a range --------------------------------------------------------------------------------------------

export interface SkuToNumber {
  readonly skuId: string
  readonly sku: string
}

export interface AllocationPlan {
  /** Each SKU with the GTIN it gets, in the order given. */
  readonly assignments: readonly { readonly skuId: string; readonly sku: string; readonly reference: number; readonly gtin: string }[]
  /** References passed over: their GTIN is on a SKU already (typed, or from an overlapping range). Never given. */
  readonly skipped: readonly { readonly reference: number; readonly gtin: string }[]
  /** The range's next reference after the plan. */
  readonly nextReference: number
  /** SKUs the range has no number left for (0: all of them get one). */
  readonly short: number
}

/**
 * The next free references of a range for `skus`, in order: a reference whose GTIN `taken` holds is skipped. `taken`
 * answers for the GTINs of `candidates(range, n)` (the API reads them from the SKUs of the tenant first).
 */
export function planAllocation(range: RangeState, skus: readonly SkuToNumber[], taken: ReadonlySet<string>): AllocationPlan {
  const assignments: { skuId: string; sku: string; reference: number; gtin: string }[] = []
  const skipped: { reference: number; gtin: string }[] = []
  let reference = range.nextReference
  for (const sku of skus) {
    let given = false
    while (!given && reference <= range.lastReference) {
      const gtin = gtinOf(range.gs1Prefix, reference)
      if (taken.has(gtin)) skipped.push({ reference, gtin })
      else {
        assignments.push({ skuId: sku.skuId, sku: sku.sku, reference, gtin })
        given = true
      }
      reference += 1
    }
    if (!given) break
  }
  return { assignments, skipped, nextReference: reference, short: skus.length - assignments.length }
}

/** The GTINs of the next `count` references of a range from `from` (to read which are taken). */
export function candidates(range: RangeState, from: number, count: number): string[] {
  const out: string[] = []
  for (let reference = from; reference <= range.lastReference && out.length < count; reference++) out.push(gtinOf(range.gs1Prefix, reference))
  return out
}

// ---- typed or imported barcodes ----------------------------------------------------------------------------------------

export interface GtinRow {
  /** The row's place in the list (from 1), for the words. */
  readonly line: number
  readonly sku: string
  /** As typed; null or empty: remove the SKU's GTIN. */
  readonly gtin: string | null
}

/** What the API knows about a SKU of a row. */
export interface SkuFacts {
  readonly skuId: string
  readonly styleId: string
  readonly gtin: string | null
  /** Garments of its cell have shipped: its GTIN stays. */
  readonly shipped: boolean
  /** Why its style may not take a barcode now (archived, the edit rule, no right over its company), or null. */
  readonly refusal: string | null
}

export const ROW_OUTCOMES = ['SET', 'CLEARED', 'UNCHANGED', 'REFUSED'] as const
export type RowOutcome = (typeof ROW_OUTCOMES)[number]

export interface RowVerdict {
  readonly line: number
  readonly sku: string
  readonly skuId: string | null
  readonly styleId: string | null
  /** The GTIN in its stored form (null: removed, or not readable). */
  readonly gtin: string | null
  readonly before: string | null
  readonly outcome: RowOutcome
  readonly message: string | null
}

/**
 * Each row checked against the SKUs (`facts` by SKU code) and the GTINs held (`holders`: GTIN → the SKU code holding it):
 * a SKU of the tenant, once in the list; a GTIN well formed, once in the list, on no other SKU; a shipped SKU's GTIN kept.
 */
export function importVerdicts(rows: readonly GtinRow[], facts: ReadonlyMap<string, SkuFacts>, holders: ReadonlyMap<string, string>): RowVerdict[] {
  const skuCount = new Map<string, number>()
  for (const row of rows) skuCount.set(row.sku.trim().toUpperCase(), (skuCount.get(row.sku.trim().toUpperCase()) ?? 0) + 1)
  const parsed = rows.map((row) => (row.gtin === null || row.gtin.trim() === '' ? { ok: true as const, gtin: null } : parseGtin(row.gtin)))
  const gtinCount = new Map<string, number>()
  for (const outcome of parsed) if (outcome.ok && outcome.gtin !== null) gtinCount.set(outcome.gtin, (gtinCount.get(outcome.gtin) ?? 0) + 1)

  return rows.map((row, index) => {
    const code = row.sku.trim().toUpperCase()
    const fact = facts.get(code)
    const outcome = parsed[index]!
    const refused = (message: string, gtin: string | null = outcome.ok ? outcome.gtin : null): RowVerdict => ({
      line: row.line,
      sku: code,
      skuId: fact?.skuId ?? null,
      styleId: fact?.styleId ?? null,
      gtin,
      before: fact?.gtin ?? null,
      outcome: 'REFUSED',
      message,
    })
    if (!fact) return refused(`No SKU ${code.slice(0, 64)} among your styles.`)
    if ((skuCount.get(code) ?? 0) > 1) return refused(`SKU ${code} is in the list more than once: keep one row.`)
    if (!outcome.ok) return refused(outcome.message, null)
    const gtin = outcome.gtin
    if (gtin === fact.gtin) return { line: row.line, sku: code, skuId: fact.skuId, styleId: fact.styleId, gtin, before: fact.gtin, outcome: 'UNCHANGED', message: null }
    if (fact.refusal) return refused(fact.refusal)
    if (fact.shipped && fact.gtin !== null) return refused(`SKU ${code} keeps its GTIN ${fact.gtin}: garments with it have shipped, and a GTIN is never given to anything else.`)
    if (gtin !== null) {
      if ((gtinCount.get(gtin) ?? 0) > 1) return refused(`GTIN ${gtin} is in the list more than once: one GTIN is one SKU.`)
      const holder = holders.get(gtin)
      if (holder !== undefined && holder !== code) return refused(`GTIN ${gtin} is on SKU ${holder} already: one GTIN is one SKU (clear it there first).`)
    }
    return { line: row.line, sku: code, skuId: fact.skuId, styleId: fact.styleId, gtin, before: fact.gtin, outcome: gtin === null ? 'CLEARED' : 'SET', message: null }
  })
}
