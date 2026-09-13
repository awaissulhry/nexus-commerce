import { normalizeLanguage } from '../../pim/content-language.js'
/**
 * PES.8 — how a draft addresses one sheet cell.
 *
 * A draft has to point at the SAME cell the sheet is showing and the same cell
 * `PATCH /api/products/bulk` will write. Those are two different vocabularies:
 * the sheet thinks in (scope, coordinate, column), the write thinks in
 * `changes[].field` plus a `marketplaceContexts` entry. `cellKey` is the join —
 * one comparable string per cell, built here and nowhere else.
 *
 *   master scope   "master:name"            "master:attr_material"
 *   channel scope  "AMAZON:IT:amazon_title" "EBAY:IT:#<aliasId>:ebay_title"
 *   with a locale  "AMAZON:IT:@de:amazon_title"
 *
 * Segments are positional and the optional ones are SIGILLED (`①…` alias,
 * `@xx` locale) so a two-segment tail is never ambiguous. `writeField` is last
 * because it is the only segment that may not contain a colon — which is why
 * the parser splits from the right.
 *
 * Why not a JSON blob column: the overlay filters and dedupes on this in SQL
 * (`@@unique([productId, cellKey, runId])`), and an index over a JSONB path is
 * a worse version of an index over a string.
 */

/** The scope a draft belongs to. `channel: null` is the master scope. */
export interface CellAddress {
  /** 'AMAZON' | 'EBAY' | 'SHOPIFY' — or null for the master scope. */
  channel: string | null
  /** 'IT' | 'DE' … — null iff `channel` is null. */
  marketplace: string | null
  /**
   * PES.5's listing alias, identified by its ID — never its label.
   * `ProductListingAlias.label` is not unique per coordinate (the DB unique is
   * on `position`) and an operator can rename it, so a label in a persisted key
   * can come to point at a different listing than the one that was drafted.
   */
  aliasId: string | null
  /** Content locale when the cell is a per-locale projection; else null. */
  locale: string | null
  /** Exactly what `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
}

/** Sigil for the alias-id segment. The sheet still DRAWS aliases as ①②③ from
 *  the alias row's `position`; that is display, and this is identity. */
const ALIAS_SIGIL = '#'
const LOCALE_SIGIL = '@'

export class CellKeyError extends Error {}

function assertSegment(name: string, value: string): void {
  if (value.includes(':')) {
    throw new CellKeyError(`${name} may not contain ':' (got ${JSON.stringify(value)})`)
  }
  if (value.trim() !== value || value === '') {
    throw new CellKeyError(`${name} must be non-empty and untrimmed-clean (got ${JSON.stringify(value)})`)
  }
}

/**
 * Build the key. Throws rather than emitting an ambiguous key: a cellKey that
 * silently points at the wrong cell would approve an AI value onto a field the
 * operator never reviewed, which is the one failure this whole lane exists to
 * make impossible.
 */
export function encodeCellKey(input: CellAddress): string {
  // Normalise absent-vs-null before any check. An optional field arriving as
  // `undefined` (an untyped caller, a JSON body that omitted the key) means
  // "no alias", not "an alias I cannot name" — refusing there would turn a
  // perfectly ordinary master-scope address into an error. A genuinely
  // contradictory address still throws below.
  const a: CellAddress = {
    channel: input.channel ?? null,
    marketplace: input.marketplace ?? null,
    aliasId: input.aliasId ?? null,
    locale: input.locale ? normalizeLanguage(input.locale) : null,
    writeField: input.writeField,
  }
  assertSegment('writeField', a.writeField)
  if (a.channel === null) {
    if (a.marketplace !== null) {
      throw new CellKeyError('master scope cannot carry a marketplace')
    }
    if (a.aliasId !== null) {
      throw new CellKeyError('master scope cannot carry an alias')
    }
    const head = a.locale === null ? [] : [LOCALE_SIGIL + a.locale]
    if (a.locale !== null) assertSegment('locale', a.locale)
    return ['master', ...head, a.writeField].join(':')
  }
  assertSegment('channel', a.channel)
  if (a.marketplace === null) {
    throw new CellKeyError('channel scope requires a marketplace')
  }
  assertSegment('marketplace', a.marketplace)
  const middle: string[] = []
  if (a.aliasId !== null) {
    assertSegment('aliasId', a.aliasId)
    middle.push(ALIAS_SIGIL + a.aliasId)
  }
  if (a.locale !== null) {
    assertSegment('locale', a.locale)
    middle.push(LOCALE_SIGIL + a.locale)
  }
  return [a.channel, a.marketplace, ...middle, a.writeField].join(':')
}

/** Inverse of `encodeCellKey`. Throws on anything it did not produce. */
export function decodeCellKey(key: string): CellAddress {
  const parts = key.split(':')
  if (parts.length < 2) throw new CellKeyError(`not a cell key: ${JSON.stringify(key)}`)
  const writeField = parts[parts.length - 1]
  if (!writeField) throw new CellKeyError(`cell key has no writeField: ${JSON.stringify(key)}`)

  const readOptionals = (segs: string[]): { aliasId: string | null; locale: string | null } => {
    let aliasId: string | null = null
    let locale: string | null = null
    for (const s of segs) {
      if (s.startsWith(ALIAS_SIGIL)) aliasId = s.slice(ALIAS_SIGIL.length)
      else if (s.startsWith(LOCALE_SIGIL)) locale = normalizeLanguage(s.slice(LOCALE_SIGIL.length))
      else throw new CellKeyError(`unrecognised segment ${JSON.stringify(s)} in ${JSON.stringify(key)}`)
    }
    return { aliasId, locale }
  }

  if (parts[0] === 'master') {
    const { aliasId, locale } = readOptionals(parts.slice(1, -1))
    if (aliasId !== null) throw new CellKeyError(`master scope cannot carry an alias: ${key}`)
    return { channel: null, marketplace: null, aliasId: null, locale, writeField }
  }
  if (parts.length < 3) throw new CellKeyError(`channel key needs a marketplace: ${JSON.stringify(key)}`)
  const { aliasId, locale } = readOptionals(parts.slice(2, -1))
  return { channel: parts[0], marketplace: parts[1], aliasId, locale, writeField }
}

/** True when `key` addresses the master scope. */
export function isMasterKey(key: string): boolean {
  return key.startsWith('master:')
}
