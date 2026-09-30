/**
 * P1 of fix/product-sheet-editing (2026-09-30) — THE verdict on a value: the Owner's full-control rule, in one place
 * for every path (the editor, paste, fill and the bulk save; formulas; imports; publish).
 *
 * Edit time: a value the field can HOLD is stored, and each problem with it travels as a warning with its exact reason
 * (field, value, rule, the channel's list or limit). Only a value the field's TYPE cannot hold (text in a number, a
 * malformed measure, a list sent to one value) is refused, and only that cell.
 *
 * Publish time: a problem blocks only when the channel itself would reject the value, and it says the channel's rule.
 * Nexus's own rules (readiness, a requirement the channel does not make, review states) warn.
 */

export type FindingRule =
  /** The field's type cannot hold the value. The only rule that refuses at edit time. */
  | 'type'
  /** The channel requires a value and there is none. */
  | 'required'
  /** Not on the channel's list. */
  | 'offList'
  /** On the list, but the channel marks it deprecated. */
  | 'deprecated'
  /** Over the channel's character or byte limit. */
  | 'length'
  /** More values than the field takes (or fewer than it needs). */
  | 'count'
  /** The field's declared format: pattern, numeric range, distinct values, a record's fields, a unit code. */
  | 'format'
  /** The channel's own schema (Amazon's product-type JSON schema, a Shopify definition's validations). */
  | 'schema'
  /**
   * The check itself could not run, so nobody knows whether the channel accepts the value: category requirements
   * unavailable, conflicting categories or presentation rules, a mapping expression that failed or was skipped.
   * Stored while editing; BLOCKS at publish, with its sentence (the lead's P1 review ruling).
   */
  | 'unchecked'
  /** A rule of Nexus's own about the value (readiness, a requirement only a mapping rule claims, translations). */
  | 'nexus'

export interface ValueFinding {
  rule: FindingRule
  message: string
}

export const finding = (rule: FindingRule, message: string): ValueFinding => ({ rule, message })

/** Edit time: store the value (warning with the finding), or refuse this one cell. */
export function editVerdict(f: ValueFinding): 'store' | 'refuse' {
  return f.rule === 'type' ? 'refuse' : 'store'
}

/**
 * An off-list value blocks only where the channel refuses it. eBay does not: 171 ACTIVE eBay IT listings hold
 * "Tutte le stagioni" while eBay's own SELECTION_ONLY list says "Tutte le stagione" (measured 2026-09-29), so an eBay
 * off-list value warns and eBay's own answer at submit is shown as it comes.
 */
const OFF_LIST_REFUSED_BY = new Set(['AMAZON', 'SHOPIFY', 'ETSY'])

/** Publish time: `block` only when the channel itself would reject the value, or nobody could check it. */
export function publishVerdict(channel: string, f: ValueFinding): 'block' | 'warn' {
  if (f.rule === 'nexus' || f.rule === 'deprecated') return 'warn'
  if (f.rule === 'offList') return OFF_LIST_REFUSED_BY.has(channel.toUpperCase()) ? 'block' : 'warn'
  return 'block'
}

/**
 * The findings behind a resolved cell's `errors`, in order. An error with no finding (a later writer pushed only the
 * sentence) keeps the old meaning — it blocks at publish — so nothing that blocked before is quietly let through.
 */
export function cellFindings(cell: { errors: string[]; findings?: ValueFinding[] }): ValueFinding[] {
  const pool = [...(cell.findings ?? [])]
  return cell.errors.map(message => {
    const index = pool.findIndex(f => f.message === message)
    return index >= 0 ? pool.splice(index, 1)[0] : finding('schema', message)
  })
}
