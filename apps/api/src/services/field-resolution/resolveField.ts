// FL.1.2 — Field resolution core (pure).
//
// resolveFieldValue walks the precedence stack for a single coordinate
// (channel, marketplace, fieldKey, variantId?) and returns the winning
// value + its provenance source. It is intentionally PURE — it takes the
// already-loaded candidates as inputs so it is trivially unit-testable
// and has no DB / network dependency. The DB-backed loader that gathers
// these candidates lands in FL.2 and calls this.
//
// Precedence (highest first):
//   1. locked            identity field pinned to master (GTIN/SKU/brand)
//   2. manual override   a pinned value on THIS coordinate
//   3. linked group      the canonical value of a FieldLinkGroup the
//                        coordinate belongs to (may need translation)
//   4. product master    the language-neutral master value
//   5. schema default    channel/market schema fallback
//   6. (empty)

export type FieldSource =
  | 'locked'
  | 'manual'
  | 'linked'
  | 'master'
  | 'translations'
  | 'ai'
  | 'sibling'
  | 'default'

export type TranslatePolicy = 'TRANSLATE' | 'VERBATIM' | 'NONE'

export interface OverrideCandidate<T> {
  value: T
  /** Provenance of the pinned value — defaults to 'manual'. A value
   *  authored by AI / copied from a sibling keeps that source so the
   *  badge stays honest. */
  source?: Extract<FieldSource, 'manual' | 'ai' | 'sibling' | 'translations'>
}

export interface LinkedCandidate<T> {
  value: T
  translatePolicy?: TranslatePolicy
  /** Language the canonical value is authored in. */
  sourceLanguage?: string | null
}

export interface ResolveInputs<T> {
  /** Pinned override on THIS coordinate. */
  override?: OverrideCandidate<T> | null
  /** The link group's canonical value, if the coordinate is a member. */
  linked?: LinkedCandidate<T> | null
  /** Product master value. */
  master?: T | null
  /** Channel/market schema default. */
  schemaDefault?: T | null
  /** Identity field locked to master — ignores override + linked. */
  locked?: boolean
  /** Target market language — used to flag cross-language translate. */
  targetLanguage?: string | null
}

export interface Resolved<T> {
  value: T | null
  source: FieldSource
  /** True when a linked TRANSLATE value is authored in a different
   *  language than the target market and a translation hasn't been
   *  pinned yet — the propagation step (FL.4) should fill this. */
  needsTranslation: boolean
}

/** Empty = null/undefined, '' (after trim), or []. 0 and false are NOT
 *  empty (a real price/flag value). */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === 'string') return v.trim().length === 0
  if (Array.isArray(v)) return v.length === 0
  return false
}

export function resolveFieldValue<T>(inputs: ResolveInputs<T>): Resolved<T> {
  const { override, linked, master, schemaDefault, locked, targetLanguage } = inputs

  // 1. Locked identity → always master, no override/linked.
  if (locked) {
    return { value: master ?? null, source: 'locked', needsTranslation: false }
  }

  // 2. Manual / pinned override on this coordinate.
  if (override && !isEmptyValue(override.value)) {
    return { value: override.value, source: override.source ?? 'manual', needsTranslation: false }
  }

  // 3. Linked group canonical value.
  if (linked && !isEmptyValue(linked.value)) {
    const policy = linked.translatePolicy ?? 'TRANSLATE'
    const needsTranslation =
      policy === 'TRANSLATE' &&
      !!targetLanguage &&
      !!linked.sourceLanguage &&
      targetLanguage.toLowerCase() !== linked.sourceLanguage.toLowerCase()
    return { value: linked.value, source: 'linked', needsTranslation }
  }

  // 4. Product master.
  if (!isEmptyValue(master)) {
    return { value: master as T, source: 'master', needsTranslation: false }
  }

  // 5. Schema default.
  if (!isEmptyValue(schemaDefault)) {
    return { value: schemaDefault as T, source: 'default', needsTranslation: false }
  }

  // 6. Nothing set.
  return { value: null, source: 'default', needsTranslation: false }
}
