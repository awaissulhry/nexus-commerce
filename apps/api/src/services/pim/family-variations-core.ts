/**
 * VTR step 1a — the pure rules of the one variation model (docs/variation-theme/STEP1-PLAN.md, Owner D3 a).
 *
 * A family axis is a dictionary attribute (`CustomAttribute.code`, stable); a variant's value is the text of one of its options
 * (`AttributeOption`: code, default label, `metadata.labels` per language, synonyms — the attributes lane's model). These functions
 * decide nothing about the database: the writer and the backfill call them, and the backfill only REPORTS what they find.
 */
import { conceptByKey, conceptValueCode } from '@nexus/shared/attribute-concepts'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { variationCollisionGroups } from './variation-collisions.js'

export interface DictionaryOption {
  id: string
  code: string
  label: string
  metadata: unknown
  synonyms: string[]
  sortOrder: number
  archivedAt: Date | null
}

export interface DictionaryAttribute {
  id: string
  code: string
  label: string
  semanticKey: string | null
  archivedAt: Date | null
  options: DictionaryOption[]
}

export type AxisAttribute =
  | { attribute: DictionaryAttribute }
  | { attribute: null; reason: 'no-attribute' }
  | { attribute: null; reason: 'ambiguous'; candidates: string[] }

/**
 * The attribute an axis label names. Strongest first: the attribute's code, then its concept (`semanticKey`), then its label —
 * the same three names the attributes lane's axis guard reads (`axesNaming`). A tie at the strongest level is reported.
 */
export function attributeForAxis(axis: string, attributes: readonly DictionaryAttribute[]): AxisAttribute {
  const key = canonicalVariantAxis(axis)
  const live = attributes.filter(a => !a.archivedAt)
  for (const name of [(a: DictionaryAttribute) => a.code, (a: DictionaryAttribute) => a.semanticKey, (a: DictionaryAttribute) => a.label]) {
    const hits = live.filter(a => { const n = name(a); return !!n && canonicalVariantAxis(n) === key })
    if (hits.length === 1) return { attribute: hits[0] }
    if (hits.length > 1) return { attribute: null, reason: 'ambiguous', candidates: hits.map(a => a.code).sort() }
  }
  return { attribute: null, reason: 'no-attribute' }
}

const foldValue = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '')

function optionNames(option: DictionaryOption): string[] {
  const labels = option.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata)
    ? (option.metadata as Record<string, unknown>).labels : null
  const perLanguage = labels && typeof labels === 'object' && !Array.isArray(labels)
    ? Object.values(labels as Record<string, unknown>).filter((v): v is string => typeof v === 'string') : []
  return [option.code, option.label, ...perLanguage, ...option.synonyms]
}

/** The option a value text names — by code, default label, a per-language label or a synonym. Archived options still match. */
export function optionForValue(text: string, attribute: DictionaryAttribute): DictionaryOption | null {
  const key = foldValue(text)
  if (!key) return null
  return attribute.options.find(o => foldValue(o.code) === key)
    ?? attribute.options.find(o => optionNames(o).some(name => foldValue(name) === key))
    ?? null
}

/**
 * The option a value names AND how the dictionary spells that name — what the one writer saves (Owner D3 a). A code match saves
 * the default label; a label, per-language label or synonym match saves that name as the dictionary spells it, so "nero " becomes
 * "Nero" and a value never changes language (nothing a channel receives changes).
 */
export function matchValue(text: string, attribute: DictionaryAttribute): { option: string; spelled: string } | null {
  const key = foldValue(text)
  if (!key) return null
  // A text that IS one of an option's names keeps that name's spelling ("3XL" stays "3XL" even where the default label is
  // "XXXL"); only a bare code ("black") takes the default label. Measured on a private copy: code-first turned "3XL" into
  // "XXXL" and "XXL" into "2XL" on 37 variants — a change the channels would have received.
  for (const option of attribute.options) {
    const name = optionNames(option).slice(1).find(n => foldValue(n) === key)
    if (name) return { option: option.code, spelled: name }
  }
  const byCode = attribute.options.find(o => foldValue(o.code) === key)
  return byCode ? { option: byCode.code, spelled: byCode.label } : null
}

/** Two texts name the same value when they match the same option, or fold to the same text when neither is in the dictionary. */
export function valueIdentity(text: string, attribute: DictionaryAttribute): string {
  return optionForValue(text, attribute)?.code ?? `text:${foldValue(text)}`
}

/** A new option code, by the attributes lane's rule: /^[a-z][a-z0-9_]{0,63}$/, unique per attribute, never renamed later. */
export function newOptionCode(text: string, taken: readonly string[]): string {
  let base = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'value'
  if (!/^[a-z]/.test(base)) base = `v_${base}`
  base = base.slice(0, 64)
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `_${n}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * The code a NEW option of this attribute gets — ONE code set with the attributes lane: the attribute's concept value code first
 * ("Verde" → `green`, converted by the starter rule in `attribute-concepts-rows.ts optionsFor`), else a code from the text.
 * Never a code the attribute already has.
 */
export function codeForNewOption(text: string, attribute: DictionaryAttribute): string {
  const taken = attribute.options.map(o => o.code)
  const concept = conceptByKey(attribute.semanticKey)
  const fromConcept = concept ? conceptValueCode(concept, text)?.toLowerCase().replace(/[^a-z0-9_]+/g, '_') : undefined
  if (fromConcept && !taken.includes(fromConcept)) return fromConcept
  return newOptionCode(fromConcept ?? text, taken)
}

// ------------------------------------------------------------------
// The backfill report
// ------------------------------------------------------------------

type Bag = Record<string, unknown>
const bag = (value: unknown): Bag => value && typeof value === 'object' && !Array.isArray(value) ? value as Bag : {}
const scalar = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''

export interface FamilyVariationsInput {
  familyId: string
  sku: string
  variationAxes: string[]
  variationTheme: string | null
  attributes: readonly DictionaryAttribute[]
  variants: Array<{ id: string; sku: string; included: boolean; categoryAttributes: unknown; variantAttributes: unknown }>
}

export interface PlannedValue {
  text: string
  option: string | null
  from: 'variations' | 'flat' | 'legacy' | null
  empty?: true
  conflict?: string[]
  newOption?: string
}

export type FamilyVariationIssue =
  | { kind: 'theme-without-axes'; theme: string }
  | { kind: 'axis-without-attribute'; axis: string; reason: 'no-attribute' | 'ambiguous'; candidates?: string[] }
  | { kind: 'empty'; axis: string; skus: string[] }
  | { kind: 'new-option'; axis: string; text: string; code: string; skus: string[] }
  | { kind: 'store-conflict'; axis: string; sku: string; values: string[] }
  | { kind: 'store-legacy-only'; axis: string; from: 'flat' | 'legacy'; skus: string[] }
  | { kind: 'duplicate'; skus: string[]; values: string[] }

export interface FamilyVariationsPlan {
  familyId: string
  sku: string
  axes: Array<{ label: string; attributeCode: string | null; reason?: 'no-attribute' | 'ambiguous' }>
  variants: Array<{ id: string; sku: string; values: Record<string, PlannedValue> }>
  issues: FamilyVariationIssue[]
}

/** Read the three value stores of every variant and REPORT what one model would hold. Nothing is chosen silently. */
export function planFamilyVariations(input: FamilyVariationsInput): FamilyVariationsPlan {
  const issues: FamilyVariationIssue[] = []
  if (!input.variationAxes.length && input.variationTheme?.trim()) issues.push({ kind: 'theme-without-axes', theme: input.variationTheme })
  const axes = input.variationAxes.map(label => {
    const found = attributeForAxis(label, input.attributes)
    if (!('reason' in found)) return { label, attribute: found.attribute }
    issues.push({ kind: 'axis-without-attribute', axis: label, reason: found.reason, ...(found.reason === 'ambiguous' ? { candidates: found.candidates } : {}) })
    return { label, attribute: null, reason: found.reason }
  })
  const newCodes = new Map<string, Map<string, string>>()      // attribute code → folded text → new option code
  const grouped = new Map<string, FamilyVariationIssue & { skus: string[] }>()
  const group = (key: string, make: () => FamilyVariationIssue & { skus: string[] }, sku: string) => {
    const issue = grouped.get(key) ?? make()
    if (!grouped.has(key)) { grouped.set(key, issue); issues.push(issue) }
    issue.skus.push(sku)
  }

  const variants = input.variants.map(v => {
    const stores = { variations: bag(bag(v.categoryAttributes).variations), flat: bag(v.categoryAttributes), legacy: bag(v.variantAttributes) }
    const values: Record<string, PlannedValue> = {}
    for (const axis of axes) {
      if (!axis.attribute) continue
      const names = new Set([canonicalVariantAxis(axis.label), canonicalVariantAxis(axis.attribute.code)])
      const found = (['variations', 'flat', 'legacy'] as const).flatMap(from =>
        Object.entries(stores[from]).filter(([key]) => key !== 'variations' && names.has(canonicalVariantAxis(key)))
          .map(([, value]) => ({ from, text: scalar(value) })).filter(entry => !!entry.text))
      const chosen = found[0]
      const code = axis.attribute.code
      if (!chosen) {
        values[code] = { text: '', option: null, from: null, empty: true }
        group(`empty:${code}`, () => ({ kind: 'empty', axis: code, skus: [] }), v.sku)
        continue
      }
      const identity = (text: string) => optionForValue(text, axis.attribute!)?.code ?? foldValue(text)
      const distinct = [...new Map(found.map(entry => [identity(entry.text), entry.text])).values()]
      const option = optionForValue(chosen.text, axis.attribute)
      const planned: PlannedValue = { text: chosen.text, option: option?.code ?? null, from: chosen.from }
      if (distinct.length > 1) {
        planned.conflict = [...distinct].sort()
        issues.push({ kind: 'store-conflict', axis: code, sku: v.sku, values: planned.conflict })
      }
      if (chosen.from !== 'variations') {
        group(`legacy:${code}:${chosen.from}`, () => ({ kind: 'store-legacy-only', axis: code, from: chosen.from as 'flat' | 'legacy', skus: [] }), v.sku)
      }
      if (!option) {
        const perAttribute = newCodes.get(code) ?? new Map<string, string>()
        newCodes.set(code, perAttribute)
        const folded = foldValue(chosen.text)
        const newCode = perAttribute.get(folded) ?? codeForNewOption(chosen.text, { ...axis.attribute, options: [...axis.attribute.options,
          ...[...perAttribute.values()].map(code => ({ id: code, code, label: code, metadata: null, synonyms: [], sortOrder: 0, archivedAt: null }))] })
        perAttribute.set(folded, newCode)
        planned.newOption = newCode
        group(`new:${code}:${newCode}`, () => ({ kind: 'new-option', axis: code, text: chosen.text, code: newCode, skus: [] }), v.sku)
      }
      values[code] = planned
    }
    return { id: v.id, sku: v.sku, values }
  })

  const resolved = axes.filter(a => a.attribute).map(a => a.attribute!.code)
  if (resolved.length) {
    const keyed = input.variants.map((v, i) => ({ included: v.included, sku: v.sku,
      axisValues: Object.fromEntries(resolved.map(code => { const p = variants[i].values[code]; return [code, p?.option ?? p?.newOption ?? ''] })) }))
    for (const g of variationCollisionGroups(resolved, keyed)) {
      issues.push({ kind: 'duplicate', skus: g.members.map(m => m.sku).sort(), values: g.key })
    }
  }
  return { familyId: input.familyId, sku: input.sku,
    axes: axes.map(a => a.attribute ? { label: a.label, attributeCode: a.attribute.code } : { label: a.label, attributeCode: null, reason: a.reason! }),
    variants, issues }
}
